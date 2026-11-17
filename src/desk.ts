/**
 * The verification DESK: the batch point between delegated workers and the ONE verifier lane.
 *
 * The problem this file exists for. A `task` call spawns workers that share the run's cwd, and a
 * worker that finishes its slice wants its work verified. Verification is a lane swap: 13-25 s and
 * 52-130 GiB (router.ts). Addressed per arrival, three workers in one batch is three swaps inside
 * the flip guard's window, and the guard's own arithmetic (router.ts `flipState`) calls that
 * churn — the loop halts, the run stops, and every swap was paid. So a worker's verification
 * request does NOT trigger a swap: it lands on the desk, and the desk's answer is
 * `not ready — the batch is not closed`.
 *
 * The rule, exactly:
 * - one batch (an `epoch`) holds every request registered while it is open;
 * - the batch is ADDRESSABLE only when it has CLOSED — every worker of the launching `task` call
 *   has registered (`agents.length >= expected`), the call has SETTLED (`sealed_utc`), the hard
 *   deadline aged out, or the oldest request sat past the settle window with nothing new arriving;
 * - `claimBatch` moves the whole open epoch into ONE addressed batch and opens the NEXT epoch, so
 *   a request that arrives during verification waits for the NEXT verification — never a second
 *   swap for the same window;
 * - a claim is one-use: a claimed request never returns to the live set, so the SAME batch can
 *   never be addressed twice.
 *
 * Cross-session by construction: a delegated worker is its own session (often its own process,
 * which is what the `PI_SESSION_FILE` shape in index.ts proves), so the desk is a FILE, written
 * tmp → fdatasync → rename (core.ts `writeJsonAsync`) and re-read on every mutation. Every entry
 * point is a read-modify-write with a bounded retry, so two workers registering in the same
 * millisecond both land.
 *
 * The verdict fans back OUT through the same file: the verifier (the owner's lane, or a
 * verification SUBAGENT on a non-router model) posts one verdict per request id, and a worker
 * blocked in `fade_verify` sees its own verdict on the next poll and returns it. No IPC, no
 * in-process assumption, and nothing is asked of a worker that dies: an unanswered request simply
 * stays on the desk, named.
 */
import { join } from "node:path";
import { coalesceWrite, readJsonAsync, writeJsonAsync } from "./core.ts";

export const DESK_SCHEMA = "fade.orchestrate.verify_desk.v1";
export const DESK_DIRNAME = "verify";
export const DESK_FILENAME = "desk.json";

/** No new registration for this long, and the oldest request is this old: the batch is closed. */
export const DESK_SETTLE_MS = Number(process.env.FADE_ORCHESTRATE_DESK_SETTLE_MS ?? 8_000);
/** The batch never stays open longer than this, however few workers registered. */
export const DESK_DEADLINE_MS = Number(process.env.FADE_ORCHESTRATE_DESK_DEADLINE_MS ?? 120_000);
/** How long a worker's `fade_verify` blocks waiting for its batch to be answered. */
export const DESK_WAIT_MS = Number(process.env.FADE_ORCHESTRATE_DESK_WAIT_MS ?? 240_000);
/** The block's poll period. */
export const DESK_POLL_MS = Number(process.env.FADE_ORCHESTRATE_DESK_POLL_MS ?? 1_000);

/** One worker's verification request. `id` is desk-assigned: `V<epoch+1>.<n>`. */
export interface VerifyRequest {
	id: string;
	/** The epoch that was open when it registered — the batch that must address it. */
	batch: number;
	/** The delegating agent definition's name (`ctx.agent.name`), or `task` for the host's default. */
	agent: string;
	/** The worker's own session identity, for the census and for dedupe. */
	session: string;
	/** The run task this slice belongs to, when the worker was given one. */
	task_id?: string;
	objective: string;
	acceptance?: string;
	/** Commands the verifier must run, as the plan's checks are: `[cmd, expected]`. */
	checks: [string, string][];
	enqueued_utc: string;
	/** The epoch that addressed it. Set by `claimBatch`; a request with no claim is live work. */
	claimed_batch?: number;
	verdict?: { accepted: boolean; notes: string; at: string };
}

/** One epoch the desk addressed, newest last: the answer to "what did verification cost?". */
export interface AddressedBatch {
	batch: number;
	ids: string[];
	/** `swap` = the owner loaded the verifier lane; `subagent` = a worker on a non-router model. */
	routed: "swap" | "subagent";
	at: string;
}

/** The desk file. One run, one desk, one open epoch. */
export interface VerifyDesk {
	schema: string;
	run_id: string;
	/** The open epoch: requests stamped with it are the batch being collected. */
	epoch: number;
	open_utc: string;
	/** The launching `task` call settled: every worker that is going to register has registered. */
	sealed_utc?: string;
	/** How many workers the launching `task` call carries (0 = unmeasured, e.g. a solo delegation). */
	expected: number;
	/** Worker names that registered in the open epoch. */
	agents: string[];
	/** Lane churn is in force: batches are addressed by a verification SUBAGENT, never by a swap. */
	churn: boolean;
	churn_utc?: string;
	requests: VerifyRequest[];
	addressed: AddressedBatch[];
	updated_utc: string;
}

/** A verdict row as the verifier posts it. */
export interface VerdictRow {
	id: string;
	accepted: boolean;
	notes: string;
}

export const deskPath = (dir: string): string => join(dir, DESK_DIRNAME, DESK_FILENAME);

/** The desk, for a run that has none. `epoch` starts at 0 and every claim opens the next. */
export function emptyDesk(runId: string, at = new Date().toISOString()): VerifyDesk {
	return {
		schema: DESK_SCHEMA,
		run_id: runId,
		epoch: 0,
		open_utc: at,
		expected: 0,
		agents: [],
		churn: false,
		requests: [],
		addressed: [],
		updated_utc: at,
	};
}

const asRecord = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const num = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);
const bool = (v: unknown): boolean => v === true;
const isoMs = (v: unknown, fallback: number): number => {
	const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
	return Number.isFinite(t) ? t : fallback;
};

/** `[cmd, expected]` rows, accepting the `{"cmd","expected"}` object form the model writes. */
function checkRows(v: unknown): [string, string][] {
	if (!Array.isArray(v)) return [];
	const rows: [string, string][] = [];
	for (const row of v) {
		if (Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "string") rows.push([row[0], row[1]]);
		else {
			const o = asRecord(row);
			if (o && typeof o.cmd === "string") rows.push([o.cmd, str(o.expected, "exit 0")]);
		}
	}
	return rows;
}

/** One request, narrowed field by field; an id-less record is not a request and is dropped. */
function readRequest(v: unknown, batch: number): VerifyRequest | undefined {
	const o = asRecord(v);
	if (!o) return undefined;
	const id = str(o.id);
	if (id === "") return undefined;
	const req: VerifyRequest = {
		id,
		batch: num(o.batch, batch),
		agent: str(o.agent, "task"),
		session: str(o.session),
		objective: str(o.objective),
		checks: checkRows(o.checks),
		enqueued_utc: str(o.enqueued_utc, new Date(0).toISOString()),
	};
	if (typeof o.task_id === "string" && o.task_id !== "") req.task_id = o.task_id;
	if (typeof o.acceptance === "string" && o.acceptance !== "") req.acceptance = o.acceptance;
	if (typeof o.claimed_batch === "number" && Number.isFinite(o.claimed_batch)) req.claimed_batch = o.claimed_batch;
	const verdict = asRecord(o.verdict);
	if (verdict) req.verdict = { accepted: bool(verdict.accepted), notes: str(verdict.notes), at: str(verdict.at) };
	return req;
}

/**
 * A desk record, normalized. A missing/foreign schema, a foreign `run_id` and a request with no
 * id are all named by refusal, never absorbed: the caller then starts a fresh epoch rather than
 * mutating a file it does not understand.
 */
export function parseDesk(v: unknown, runId?: string): VerifyDesk | undefined {
	const o = asRecord(v);
	if (!o || o.schema !== DESK_SCHEMA) return undefined;
	if (runId !== undefined && typeof o.run_id === "string" && o.run_id !== "" && o.run_id !== runId) return undefined;
	const epoch = num(o.epoch, 0);
	const desk: VerifyDesk = {
		schema: DESK_SCHEMA,
		run_id: str(o.run_id, runId ?? ""),
		epoch,
		open_utc: str(o.open_utc, new Date(0).toISOString()),
		expected: num(o.expected, 0),
		agents: Array.isArray(o.agents) ? o.agents.filter((a): a is string => typeof a === "string") : [],
		churn: bool(o.churn),
		requests: Array.isArray(o.requests) ? o.requests.map((r) => readRequest(r, epoch)).filter((r): r is VerifyRequest => r !== undefined) : [],
		addressed: [],
		updated_utc: str(o.updated_utc, new Date(0).toISOString()),
	};
	if (typeof o.sealed_utc === "string" && o.sealed_utc !== "") desk.sealed_utc = o.sealed_utc;
	if (typeof o.churn_utc === "string" && o.churn_utc !== "") desk.churn_utc = o.churn_utc;
	if (Array.isArray(o.addressed)) {
		for (const a of o.addressed) {
			const row = asRecord(a);
			if (!row) continue;
			desk.addressed.push({
				batch: num(row.batch, 0),
				ids: Array.isArray(row.ids) ? row.ids.filter((i): i is string => typeof i === "string") : [],
				routed: row.routed === "subagent" ? "subagent" : "swap",
				at: str(row.at),
			});
		}
	}
	return desk;
}

/** The open epoch's live work: registered, not claimed, not yet answered. */
export function openRequests(desk: VerifyDesk): VerifyRequest[] {
	return desk.requests.filter((r) => r.batch === desk.epoch && r.claimed_batch === undefined && r.verdict === undefined);
}

export interface BatchReadiness {
	ready: boolean;
	/** The named reason — `desk_empty` and `waiting` are NOT reasons to pay a swap. */
	reason: string;
	open: number;
	registered: number;
	expected: number;
	/** Age of the oldest live request in ms (`-1` when there is none). */
	oldest_ms: number;
	churn: boolean;
}

/**
 * Is the open batch CLOSED, i.e. addressable as ONE verification pass?
 *
 * The order is the rule's priority, and the `waiting` answer is the point of the whole file: while
 * the `expected` workers of a launching `task` call are not all registered, NOTHING is addressable
 * — one early registration never starts a swap, and the batch is answered once, for all of them.
 */
export function readyToAddress(desk: VerifyDesk, nowMs: number, opts: { settleMs?: number; deadlineMs?: number } = {}): BatchReadiness {
	const settleMs = opts.settleMs ?? DESK_SETTLE_MS;
	const deadlineMs = opts.deadlineMs ?? DESK_DEADLINE_MS;
	const live = openRequests(desk);
	// `registered` is the count of LIVE REQUESTS, never the census names in `desk.agents`: the
	// launching `task` call names its workers BEFORE any of them registers (that is what `expected`
	// is), and comparing the census against itself closes the batch at zero registrations — the
	// per-arrival swap, wearing the batching rule's clothes. Measured on the gate rig.
	const base = { open: live.length, registered: live.length, expected: desk.expected, churn: desk.churn };
	if (live.length === 0) return { ready: false, reason: "desk_empty", oldest_ms: -1, ...base };
	const oldestMs = nowMs - Math.min(...live.map((r) => isoMs(r.enqueued_utc, nowMs)));
	const oldest = { oldest_ms: oldestMs };
	if (desk.sealed_utc !== undefined) return { ready: true, reason: "sealed", ...oldest, ...base };
	if (desk.expected > 0 && live.length >= desk.expected) return { ready: true, reason: "all_registered", ...oldest, ...base };
	if (nowMs - isoMs(desk.open_utc, nowMs) >= deadlineMs) return { ready: true, reason: "deadline", ...oldest, ...base };
	if (oldestMs >= settleMs) return { ready: true, reason: "settled", ...oldest, ...base };
	return { ready: false, reason: `waiting for the batch to close: ${live.length}/${desk.expected > 0 ? desk.expected : "?"} workers registered`, ...oldest, ...base };
}

/**
 * Address the open epoch: stamp every live request with the claim, record the batch under `routed`,
 * and OPEN THE NEXT EPOCH. The epoch counter only moves forward and a claimed request never
 * returns to the live set, so the same batch is never addressed twice and a request that
 * registers during verification lands in the next batch.
 */
export function claimBatch(desk: VerifyDesk, routed: "swap" | "subagent", at = new Date().toISOString()): { desk: VerifyDesk; batch: number; ids: string[] } {
	const live = openRequests(desk);
	const batch = desk.epoch;
	for (const r of live) r.claimed_batch = batch;
	const ids = live.map((r) => r.id);
	const next: VerifyDesk = {
		...desk,
		epoch: batch + 1,
		open_utc: at,
		expected: 0,
		agents: [],
		addressed: [...desk.addressed, { batch, ids, routed, at }],
		updated_utc: at,
	};
	delete next.sealed_utc;
	return { desk: next, batch, ids };
}

/**
 * Register one worker's request. One registration per worker name per objective per epoch: a
 * worker that calls twice for the same slice gets the SAME request back (`deduped`), because two
 * requests from one worker widen the batch and price the swap the desk exists to avoid.
 */
export function enqueueRequest(desk: VerifyDesk, req: { agent: string; session: string; task_id?: string; objective: string; acceptance?: string; checks?: [string, string][] }, at = new Date().toISOString()): { desk: VerifyDesk; request: VerifyRequest; deduped: boolean } {
	const existing = desk.requests.find((r) => r.batch === desk.epoch && r.agent === req.agent && r.claimed_batch === undefined && r.objective === req.objective);
	if (existing) return { desk, request: existing, deduped: true };
	const n = desk.requests.filter((r) => r.batch === desk.epoch).length + 1;
	const request: VerifyRequest = {
		id: `V${desk.epoch + 1}.${n}`,
		batch: desk.epoch,
		agent: req.agent,
		session: req.session,
		objective: req.objective,
		checks: checkRows(req.checks),
		enqueued_utc: at,
	};
	if (req.task_id) request.task_id = req.task_id;
	if (req.acceptance) request.acceptance = req.acceptance;
	return {
		desk: { ...desk, requests: [...desk.requests, request], agents: desk.agents.includes(req.agent) ? desk.agents : [...desk.agents, req.agent], updated_utc: at },
		request,
		deduped: false,
	};
}

/**
 * The launching `task` call's census, recorded on the open epoch: how many workers exist, and what
 * they are named. `expected` is the number the batch WAITS for, and it only grows — a run that
 * delegates in two waves keeps the ceiling of the largest wave, and a shrinking `expected` closes
 * the batch early, which is the per-arrival churn this file exists to stop. The names are the
 * census (`/orchestrate desk`), NOT the readiness test: a name is not a registration, and
 * readiness counts live requests (see `readyToAddress`).
 */
export function noteTaskBatch(desk: VerifyDesk, batch: { count: number; agents: string[] }, at = new Date().toISOString()): VerifyDesk {
	const agents = [...desk.agents];
	for (const a of batch.agents) if (!agents.includes(a)) agents.push(a);
	return { ...desk, expected: Math.max(desk.expected, Math.max(0, batch.count)), agents, updated_utc: at };
}

/** The launching `task` call settled: every worker that will register has registered. */
export function sealBatch(desk: VerifyDesk, at = new Date().toISOString()): VerifyDesk {
	if (desk.sealed_utc !== undefined) return desk;
	return { ...desk, sealed_utc: at, updated_utc: at };
}

/** Churn in force = this run's batches are addressed by a verification subagent, never by a swap. */
export function setChurn(desk: VerifyDesk, on: boolean, at = new Date().toISOString()): VerifyDesk {
	if (desk.churn === on) return desk;
	if (on) return { ...desk, churn: true, churn_utc: at, updated_utc: at };
	delete desk.churn_utc;
	return { ...desk, churn: false, updated_utc: at };
}

/**
 * Fan the verifier's verdicts back onto the requests, by id. An id the desk does not hold is
 * reported, never silently dropped: a verifier that invents ids is a defect the operator sees.
 */
export function attachVerdicts(desk: VerifyDesk, verdicts: VerdictRow[], at = new Date().toISOString()): { desk: VerifyDesk; attached: string[]; unknown: string[] } {
	const attached: string[] = [];
	const unknown: string[] = [];
	for (const v of verdicts) {
		const hit = desk.requests.find((r) => r.id === v.id);
		if (!hit) {
			unknown.push(v.id);
			continue;
		}
		hit.verdict = { accepted: v.accepted === true, notes: v.notes, at };
		attached.push(v.id);
	}
	return { desk: { ...desk, requests: desk.requests, updated_utc: at }, attached, unknown };
}

export const requestById = (desk: VerifyDesk, id: string): VerifyRequest | undefined => desk.requests.find((r) => r.id === id);

/** The desk's one-line census: what is open, owed, answered, and how it was routed. */
export function deskCensus(desk: VerifyDesk): { open: number; owed: number; answered: number; batches: number; churn: boolean } {
	return {
		open: openRequests(desk).length,
		owed: desk.requests.filter((r) => r.claimed_batch !== undefined && r.verdict === undefined).length,
		answered: desk.requests.filter((r) => r.verdict !== undefined).length,
		batches: desk.addressed.length,
		churn: desk.churn,
	};
}

/** The desk as one line, for the status row and the `desk` verb. */
export function deskLine(desk: VerifyDesk): string {
	const c = deskCensus(desk);
	return `desk batch ${desk.epoch + 1}: ${c.open} open, ${c.owed} awaiting verdict, ${c.answered} answered, ${c.batches} addressed${desk.churn ? " · CHURN ROUTE (subagent verification)" : ""}`;
}

/* ------------------------------------------------------------------ the file plane */

export async function readDesk(dir: string, runId?: string): Promise<VerifyDesk | undefined> {
	return parseDesk(await readJsonAsync<unknown>(deskPath(dir)), runId);
}


/** The coalesced write for the owner's hot path: a burst inside one tick pays one write. */
export function coalesceDesk(dir: string, desk: VerifyDesk): Promise<void> {
	return coalesceWrite(deskPath(dir), desk);
}

export interface VerdictWait {
	state: "answered" | "deferred" | "cancelled";
	request?: VerifyRequest;
	/** The named reason for a non-answer, in the words the worker reads. */
	note: string;
	polls: number;
	waited_ms: number;
}

/**
 * Read-modify-write, bounded. The desk is written by the owner session and by every worker
 * session, and a worker is routinely its own process, so each attempt re-reads the file: a write
 * lost to a concurrent writer is retried, not absorbed.
 *
 * The read-back's identity check is the CONTENT, not the clock: two workers writing in the same
 * millisecond produce records whose `updated_utc` AND request counts agree while their requests
 * differ, and a check on those fields lets a lost write report itself as landed. The parsed
 * record's field order is canonical on both sides, so the compare is stable.
 */
export async function mutateDesk(dir: string, runId: string, fn: (desk: VerifyDesk) => VerifyDesk, tries = 4): Promise<VerifyDesk> {
	let last: VerifyDesk | undefined;
	for (let attempt = 0; attempt < tries; attempt += 1) {
		const current = (await readDesk(dir, runId)) ?? emptyDesk(runId);
		const next = fn(current);
		next.updated_utc = new Date().toISOString();
		await writeJsonAsync(deskPath(dir), next);
		const back = await readDesk(dir, runId);
		if (back && JSON.stringify(back) === JSON.stringify(next)) return next;
		last = back ?? next;
	}
	return last ?? emptyDesk(runId);
}

/** The poll's sleep: `Promise.withResolvers` so the timer's resolve is the only settle path. */
const sleep = (ms: number): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
};

/**
 * The worker's block: poll the desk until this request carries a verdict.
 *
 * Bounded and named, never open-ended: past `timeoutMs` the request stays on the desk (the batch
 * is still owed its verification) and the worker is told `deferred`, so a run whose verifier never
 * lands does not park a worker forever. `cancelled` is the abort path — the worker's tool call was
 * interrupted and the request stays exactly as it was.
 */
export async function awaitVerdict(dir: string, runId: string, id: string, opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}): Promise<VerdictWait> {
	const timeoutMs = opts.timeoutMs ?? DESK_WAIT_MS;
	const pollMs = opts.pollMs ?? DESK_POLL_MS;
	const t0 = Date.now();
	let polls = 0;
	for (;;) {
		polls += 1;
		if (opts.signal?.aborted === true) {
			return { state: "cancelled", note: `${id}: the wait was cancelled; the request stays on the desk and the next verification pass answers it`, polls, waited_ms: Date.now() - t0 };
		}
		const desk = await readDesk(dir, runId);
		const req = desk ? requestById(desk, id) : undefined;
		if (req?.verdict) return { state: "answered", request: req, note: `${id} ${req.verdict.accepted ? "ACCEPTED" : "needs_repair"}: ${req.verdict.notes}`, polls, waited_ms: Date.now() - t0 };
		if (Date.now() - t0 >= timeoutMs) {
			return {
				state: "deferred",
				request: req,
				note: `${id} is queued in batch ${(desk?.epoch ?? 0) + 1} with no verdict after ${Math.round((Date.now() - t0) / 1000)}s (${polls} polls): the batch is owed its verification pass — report your result and end, do not re-register`,
				polls,
				waited_ms: Date.now() - t0,
			};
		}
		await sleep(pollMs);
	}
}
