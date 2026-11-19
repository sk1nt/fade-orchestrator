/**
 * The basalt ROUTER client. The coder endpoint is basalt's own router
 * (`POST /v1/load {"model": NAME}` blocks until the swap finishes). All three endpoints used
 * here answer on the router port; every failure names the stage, the HTTP status and the body.
 *
 * The host-specific parts are configuration, not constants:
 *   FADE_ORCHESTRATE_ROUTER   default http://127.0.0.1:18014
 *   FADE_ORCHESTRATE_PROVIDER default strata-flash
 *   FADE_ORCHESTRATE_THINK_LANE default deepseek   (plans + verifies)
 *   FADE_ORCHESTRATE_CODE_LANE  default flash-next (codes)
 *   FADE_ORCHESTRATE_RAM_MIN_FREE_MIB default 65536 (64 GiB) — the host-RAM floor a pack swap needs
 */
import { readFile } from "node:fs/promises";
export const ROUTER = process.env.FADE_ORCHESTRATE_ROUTER ?? "http://127.0.0.1:18014";
export const PROVIDER = process.env.FADE_ORCHESTRATE_PROVIDER ?? "strata-flash";
export const THINK_LANE = process.env.FADE_ORCHESTRATE_THINK_LANE ?? "deepseek";
export const CODE_LANE = process.env.FADE_ORCHESTRATE_CODE_LANE ?? "flash-next";
export type LaneRole = "think" | "code";
/** The thinking level a landing's ROLE gets. Keyed by role, not lane: with one lane running both
 *  roles the lane cannot name the role, and a `{ [THINK_LANE]: "high", [CODE_LANE]: "low" }`
 *  literal is a duplicate key whose value is "low". */
export const THINKING: Record<LaneRole, "high" | "low"> = { think: "high", code: "low" };

export const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type RouterLane = { id: string; status: string };

export async function listLanes(): Promise<{ health: string; models: RouterLane[]; error?: string }> {
	try {
		const h = await fetch(`${ROUTER}/health`, { signal: AbortSignal.timeout(4000) });
		const body = await h.json().catch(() => null);
		const health = h.ok ? String((body as { status?: string } | null)?.status ?? "ok") : `http ${h.status}`;
		const r = await fetch(`${ROUTER}/v1/models`, { signal: AbortSignal.timeout(4000) });
		const listing = (await r.json()) as { data?: Array<Record<string, any>> };
		const models = (listing?.data ?? []).map((m) => ({
			id: String(m.id ?? m.model ?? "?"),
			status: String(m.status?.value ?? m.status ?? m.state ?? "?"),
		}));
		return { health, models };
	} catch (e) {
		return { health: "unreachable", models: [], error: msg(e) };
	}
}

export type RouterHealth = { model?: string; loaded?: boolean | string; loading?: boolean; percent?: number | null; status?: string; state?: string; service?: string; max_context?: number; vram_free_mib?: number; free_vram_mib?: number; vram_total_mib?: number; vram?: { free_mib?: number; total_mib?: number }; swap?: { from?: string; to?: string; phase?: string; waiting?: number; elapsed_s?: number } };

/** The router's own health line: `loading` is true while a swap is in flight. */
export async function laneHealth(): Promise<RouterHealth | undefined> {
	try {
		const r = await fetch(`${ROUTER}/health`, { signal: AbortSignal.timeout(4000) });
		return (await r.json()) as RouterHealth;
	} catch {
		return undefined;
	}
}

/**
 * The PRE-UNLOAD GATE. `POST /v1/load` is not additive — it unloads the resident context to
 * make room for the next pack — so the decision is judged on the router's own `/health` line, in
 * words, BEFORE the byte is sent. The classes are the ones `/health` can show, and an absent
 * reading is never reported as a zero:
 *  * `unreachable` — `/health` refused: a router that cannot answer is not a context a swap
 *    can land in (a CUDA launch that raced the lane, and any router that died with the lane,
 *    surface here);
 *  * `error state` — the line's `status`/`state` is not `ok`: a context that stopped saying `ok`
 *    cannot serve the next lane (the hung-context and half-dead-CUDA class surfaces here);
 *  * `no model` — `loaded: true` while `model` names nothing: a context that claims to be loaded
 *    and cannot say what it loaded is not serving;
 *  * `zero VRAM` / `below the floor` — reported free VRAM at or under zero, or under
 *    `FADE_ORCHESTRATE_VRAM_MIN_FREE_MIB` (default 8192): no pack lands there;
 *  * `swap in flight` — `loading: true` at the END of the settle window. The ping-pong this
 *    gate exists to stop (journal: `swap: flash-next ready in 16.4 s`, then `(1 waiting)`,
 *    `(3 waiting)`) is exactly a second load queued behind a running one.
 */
export interface ServeVerdict {
	serve: boolean;
	reason: string;
}

/** Reported free VRAM below this is not a context a pack can land in. */
export const VRAM_MIN_FREE_MIB = Number(process.env.FADE_ORCHESTRATE_VRAM_MIN_FREE_MIB ?? 8192);

/** Every state the health line reports (`status` and `state` can both ride): a hostile one is a
 *  hostile line, so a healthy `status` never masks a `state` of `cuda_fatal`. */
const healthStates = (h: RouterHealth): string[] =>
	(["status", "state"] as const)
		.map((k) => (typeof h[k] === "string" && h[k]!.length > 0 ? h[k]!.toLowerCase() : undefined))
		.filter((v): v is string => v !== undefined);

/** Free VRAM, from whichever spelling the router's build uses; an absent reading stays absent. */
const vramFreeMib = (h: RouterHealth): number | undefined => {
	const direct = finite(h.vram_free_mib) ?? finite(h.free_vram_mib);
	const nested = finite((h.vram as Record<string, any> | undefined)?.free_mib);
	return direct ?? nested;
};

/** The named pre-unload verdict, from the health line alone. Pure: the rig drives it hostile JSON. */
export function serveVerdict(h: RouterHealth | undefined): ServeVerdict {
	if (h === undefined) return { serve: false, reason: `router unreachable at ${ROUTER}: /health refused; a router that cannot answer is not a context a swap can land in` };
	const bad = healthStates(h).find((s) => s !== "ok" && s !== "ready" && s !== "healthy");
	if (bad !== undefined) {
		return { serve: false, reason: `router health reports "${bad}": a context that stopped saying ok cannot serve the next lane` };
	}
	if (h.loading === true) {
		const sw = h.swap;
		const pct = finite(h.percent);
		return { serve: false, reason: `swap in flight${sw?.from ? ` ${sw.from} -> ${sw.to ?? "?"}` : ""}${pct !== undefined ? ` at ${Math.round(pct)}%` : ""}: a second load is the queued ping-pong, not a faster lane` };
	}
	const free = vramFreeMib(h);
	if (free !== undefined && free <= 0) return { serve: false, reason: `zero free VRAM (${free} MiB): the CUDA context is dead — the recorded half-dead shape` };
	if (free !== undefined && free < VRAM_MIN_FREE_MIB) return { serve: false, reason: `free VRAM ${free} MiB is under the ${VRAM_MIN_FREE_MIB} MiB pack floor: no lane lands here` };
	const model = typeof h.model === "string" ? h.model.trim() : "";
	if (h.loaded === true || h.loaded === "true") {
		if (model === "") return { serve: false, reason: "health claims a loaded context that names no model: nothing is serving" };
	}
	return { serve: true, reason: `context can serve${model !== "" ? ` (${model}${h.loading === false ? ", idle" : ""})` : ""}${free !== undefined ? `, ${Math.round(free)} MiB free` : ", VRAM not reported"}` };
}

/**
 * The HOST-RAM floor a pack swap must fit in. A lane swap is a RAM event as much as a VRAM one:
 * the MoE tiers stream the pack through system RAM (flash-next 52.2 GiB, deepseek 120 GiB), and
 * the failure mode this guards is the box running out of it MID-swap — the worst place to find
 * it, because the swap is 13-25 s and 52-130 GiB and the OOM takes the run, the engine and
 * whatever else the box was doing. `MemAvailable` is the kernel's own estimate of what a new
 * allocation can get without swapping, so it is the number asked; an unreadable `/proc` is a
 * MISSING reading, never a zero. The floor is read at CALL time, not at module load: the operator
 * can raise it mid-incident without a restart, and a rig flips it per block. `0` disables it.
 */
export const ramFloorMib = (): number => Math.max(0, Math.trunc(Number(process.env.FADE_ORCHESTRATE_RAM_MIN_FREE_MIB ?? 65_536)) || 0);

/** `MemAvailable` from `/proc/meminfo`, in MiB; `undefined` when the box does not report it. */
export async function memAvailableMib(): Promise<number | undefined> {
	let txt: string;
	try {
		txt = await readFile("/proc/meminfo", "utf8");
	} catch {
		return undefined;
	}
	const kb = Number(/^MemAvailable:\s+(\d+)\s*kB$/m.exec(txt)?.[1] ?? NaN);
	return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : undefined;
}

/** The RAM answer for a pack swap, in the same shape as `serveVerdict`: the reason is the cause. */
export async function ramVerdict(): Promise<ServeVerdict> {
	const floor = ramFloorMib();
	const gib = (mib: number) => `${(mib / 1024).toFixed(0)} GiB`;
	if (floor === 0) return { serve: true, reason: "RAM floor disabled" };
	const avail = await memAvailableMib();
	if (avail === undefined) return { serve: false, reason: `/proc/meminfo reports no MemAvailable with the ${gib(floor)} RAM floor ON: a swap whose headroom cannot be measured is a swap to refuse, not to guess` };
	if (avail < floor) return { serve: false, reason: `MemAvailable ${gib(avail)} is under the ${gib(floor)} pack floor: a 52-130 GiB swap issued here is the recorded RAM exhaustion` };
	return { serve: true, reason: `MemAvailable ${gib(avail)}, over the ${gib(floor)} pack floor` };
}

/**
 * Settle an in-flight swap, then hand back the health line the window ENDED on: the pre-unload
 * gate reads the same reading, never a fresh guess.
 */
export async function settleInFlight(): Promise<RouterHealth | undefined> {
	let health = await laneHealth();
	for (let waited = 0; health?.loading === true && waited < SETTLE_MAX_MS; waited += SETTLE_POLL_MS) {
		const { promise: settle, resolve: settleDone } = Promise.withResolvers<void>();
		setTimeout(settleDone, SETTLE_POLL_MS);
		await settle;
		health = await laneHealth();
	}
	return health;
}

/** The settle window for an in-flight swap. Rigs shrink it so the hung-context class is proved in milliseconds. */
export const SETTLE_POLL_MS = Number(process.env.FADE_ORCHESTRATE_SETTLE_POLL_MS ?? 2000);
export const SETTLE_MAX_MS = Number(process.env.FADE_ORCHESTRATE_SETTLE_MAX_MS ?? 120_000);

/**
 * `POST /v1/load` is a pack swap — flash-next 52.2 GiB, deepseek 120 GiB, 13-25 s each
 * (journal `swap: <lane> ready in …`) — so it is issued exactly once per lane BOUNDARY:
 *  * an in-flight swap is settled first. Loading while `/health` reports `loading: true`
 *    queues behind it, and the router answers the queue by swapping to the entry the queued
 *    request names: a ping-pong (`swap: flash-next ready in 16.4 s`, then
 *    `swap flash-next -> deepseek (1 waiting)` in the SAME second, then `(3 waiting)` twice
 *    more) that flips the lane back and forth every 15-25 s.
 *  * the resident entry is never reloaded. The round loop asks for the code lane twice in a
 *    row (`verification_done needs_repair` → code, next round's `planning_done` → code), and
 *    a second load of a resident pack re-reads 52 GiB for nothing.
 *  * the router's own `/health` line is read FIRST (`serveVerdict`), and a context that cannot
 *    serve — unreachable, an error state, a loaded context naming no model, zero/low free VRAM,
 *    a swap still in flight — is REFUSED with the class named, and `/v1/load` is never sent.
 */
export async function loadLane(lane: string): Promise<{ ok: boolean; detail: string; elapsed_s: number; guarded: boolean; flip: FlipState }> {
	const t0 = Date.now();
	// Settle any in-flight swap FIRST and keep the health line the window ended on — that
	// reading is the gate's evidence.
	const health = await settleInFlight();
	const resident = (await listLanes()).models.find((m) => m.status === "loaded")?.id;
	const flip = flipState(resident, FLIP_WINDOW_MS);
	const guarded = flipGuarded(flip);
	// The resident entry is never reloaded, and while the guard is firing the refusal says so with
	// the churn named: this is the call site where a flip would be paid, so it is where the
	// operator has to see it.
	if (resident === lane) return { ok: true, detail: `already resident; no swap issued${flipNote(flip)}`, elapsed_s: 0, guarded, flip };
	// A swap UNLOADS the resident context, so the router's health is read before the byte: the
	// refusal names the class, and the router is never poked with a load it cannot serve.
	const verdict = serveVerdict(health);
	if (verdict.serve === false) {
		return { ok: false, detail: `refused pre-unload: ${verdict.reason}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1000, guarded, flip };
	}
	try {
		const r = await fetch(`${ROUTER}/v1/load`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: lane }),
			signal: AbortSignal.timeout(240_000),
		});
		const text = await r.text();
		return { ok: r.ok, detail: `http ${r.status} ${text.length > 300 ? `${text.slice(0, 300)}...` : text}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1000, guarded, flip };
	} catch (e) {
		return { ok: false, detail: `${msg(e)}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1000, guarded, flip };
	}
}

/** The answer the pre-unload gate reads — is the resident lane SERVING right now? */
export interface RouterBusy {
	busy: boolean;
	/** Requests queued at the router — the number in its own `swap … (1 waiting)` line. */
	waiting?: number;
	/** Requests decoding in a slot right now. */
	running?: number;
	reason: string;
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One `/metrics` read. A router that will not answer yields `undefined`, never a zero-filled object. */
async function metricsSnapshot(): Promise<Record<string, any> | undefined> {
	try {
		const r = await fetch(`${ROUTER}/metrics`, { signal: AbortSignal.timeout(4000) });
		return r.ok ? ((await r.json()) as Record<string, any>) : undefined;
	} catch {
		return undefined;
	}
}

/** Prompt-processing tok/s of one request record: the engine's `pp`, else prompt tokens over the
 *  prefill window (`prompt_ms`, with TTFT as the bound) — the same derivation the overlay uses. */
function prefillRate(r: Record<string, any> | undefined): number | undefined {
	const pp = finite(r?.pp);
	if (pp !== undefined && pp > 0) return pp;
	const n = finite(r?.prompt_tokens) ?? finite(r?.prompt_n);
	if (n === undefined || n <= 0) return undefined;
	const ms = finite(r?.prompt_ms);
	const secs = ms !== undefined && ms > 0 ? ms / 1000 : finite(r?.ttft_s);
	return secs !== undefined && secs > 0 ? n / secs : undefined;
}

/**
 * The newest `/metrics` record the engine has NOT closed: no `finish`, no `duration_s`, no
 * `decode_tok_s`, no `ttft_s`, and a prompt rate — i.e. the prompt is being read right now.
 * The rows the engine has finished carry all four fields (`finish`, `duration_s`,
 * `decode_tok_s`, `ttft_s`), so a finished row is never mistaken for a service.
 */
function openRequestRow(metrics: Record<string, any> | undefined): Record<string, any> | undefined {
	const rows = Array.isArray(metrics?.requests) ? (metrics.requests as Record<string, any>[]) : [];
	for (let i = rows.length - 1; i >= 0; i--) {
		const r = rows[i];
		if (!r) continue;
		if (typeof r.finish === "string" || finite(r.duration_s) !== undefined) continue;
		if (finite(r.decode_tok_s) !== undefined || finite(r.ttft_s) !== undefined) continue;
		const pp = prefillRate(r);
		if (pp !== undefined && pp > 0) return r;
	}
	return undefined;
}

/**
 * Is the resident lane serving? `POST /v1/load` unloads it mid-request, and the router answers
 * a request queued at that instant by swapping to the entry the QUEUED request names —
 * `swap flash-next -> deepseek (1 waiting)` — 15-20 s and 52-130 GiB each flip. Three signals,
 * all read from the router's own surface, never inferred from a timer:
 *  * `/health` `loading: true` — a swap is already in flight (`swap.from/to`, `percent`);
 *  * `/metrics` `live` — `slots.active` requests decoding, `queued`/`slots.queue_depth` waiting;
 *  * `/metrics` `requests` — the newest record is a prompt in flight: a prompt rate with no
 *    `decode_tok_s` and no `ttft_s` reported yet.
 * An UNREACHABLE router is `busy: false` with a reason naming it. The caller gates on this to
 * DEFER a load; stalling a run on a router that cannot answer is worse than the swap it saves,
 * and a missing reading is never reported as a zero.
 */
export async function routerBusy(): Promise<RouterBusy> {
	const [health, metrics] = await Promise.all([laneHealth(), metricsSnapshot()]);
	const live = (metrics?.live ?? {}) as Record<string, any>;
	const slots = (live.slots ?? {}) as Record<string, any>;
	const running = finite(slots.active) ?? 0;
	const waiting = finite(live.queued) ?? finite(slots.queue_depth) ?? (Array.isArray(live.queue) ? live.queue.length : 0);
	const counters = `running=${running} waiting=${waiting}`;
	const phase = typeof live.phase === "string" ? ` (${live.phase})` : "";
	if (health === undefined && metrics === undefined) {
		return { busy: false, running: 0, waiting: 0, reason: `router unreachable at ${ROUTER}: /health and /metrics both refused; a router that cannot answer is never read as a serving lane, so the load is not held` };
	}
	if (health?.loading === true) {
		const sw = health.swap;
		const pct = finite(health.percent);
		return { busy: true, running, waiting, reason: `swap in flight${sw?.from ? ` ${sw.from} -> ${sw.to ?? "?"}` : ""}${pct !== undefined ? ` at ${Math.round(pct)}%` : ""}${phase}; ${counters}` };
	}
	if (running > 0 || waiting > 0) {
		return { busy: true, running, waiting, reason: `slot busy: ${typeof live.state === "string" ? live.state : "serving"}${phase}; ${counters}` };
	}
	const open = openRequestRow(metrics);
	if (open) {
		const pp = prefillRate(open);
		return { busy: true, running, waiting, reason: `request ${open.id ?? "?"} is prompting (pp=${pp === undefined ? "?" : Math.round(pp)} tok/s) with no decode_tok_s and no ttft_s yet${phase}; ${counters}` };
	}
	const resident = health?.model ?? (typeof health?.loaded === "string" ? health.loaded : undefined) ?? "?";
	return { busy: false, running, waiting, reason: `idle: ${resident} resident, no swap, no open request${metrics === undefined ? ", /metrics unread" : ""}; ${counters}` };
}

/**
 * The FLIP GUARD. A swap is 13-25 s of 52-130 GiB, so a churning lane is the most expensive
 * failure mode the router has. The churn does not come from the orchestrator: other clients on
 * the host (OMP's title generator, Mnemopi's memory completion) resolve through the shared
 * provider, and when their primary leg fails they fall back onto the orchestrator's code lane
 * (log lines `title-generator: start … provider=strata-flash id=flash-next` and
 * `Mnemopi: memory completion model failed; trying the next configured fallback`). The router
 * answers a queued request by swapping to the entry that request names, so the orchestrator
 * cannot prevent the swap — it can NAME it, refuse to pay a reload of its own, and surface the
 * churn before an operator reads it as a hung run. Each in-flight swap the router reports is
 * recorded once; a swap whose target is not the resident lane, inside the window, is a flip.
 * The window and the trigger count are configuration so a rig can run a whole window in
 * milliseconds.
 */
export const FLIP_WINDOW_MS = Number(process.env.FADE_ORCHESTRATE_FLIP_WINDOW_MS ?? 120_000);
export const FLIP_MIN_SWAPS = Number(process.env.FADE_ORCHESTRATE_FLIP_MIN_SWAPS ?? 2);
/**
 * The THRASH BREAKER's count. `FLIP_MIN_SWAPS` is the point where the churn is loud enough to
 * NAME on the row; this is the point where the loop STOPS PAYING for it. At this many swaps away
 * from the run's lane inside the window, the next `POST /v1/load` is not a lane change, it is one
 * flip of a flip-flop the router has already measured at 13-25 s and 52-130 GiB each, so the load
 * is refused and the loop halts with the evidence in front of the operator. One above the guard,
 * so a run is never halted by churn the badge alone already reports.
 */
export const FLIP_BREAKER_AT = Number(process.env.FADE_ORCHESTRATE_FLIP_BREAKER_AT ?? 4);

/** One swap the router reported, as observed by this process. */
export interface RouterSwapRow {
	from: string;
	to: string;
	at: number;
	/** The number in the router's own `swap <from> -> <to> (N waiting)` line, when it carries one. */
	waiting?: number;
}

export interface FlipState {
	/** Swaps inside the window that moved the router AWAY from `resident`. */
	flips: number;
	window_s: number;
	/** The entries the competing requests named, deduplicated. */
	competing: string[];
	rows: RouterSwapRow[];
}

const swapLog: RouterSwapRow[] = [];
let lastSwapSig = "";

/**
 * Forget THIS process's observation of the router's swap lines: the recorder, the badge and the
 * breaker start from a quiet window. It does not touch the router — a swap in flight there is
 * still in flight and the next `/health` read records it — it clears the loop's memory of the
 * churn it has watched, which is what the operator asks for once the competing client is gone.
 */
export function resetFlipLedger(): void {
	swapLog.length = 0;
	lastSwapSig = "";
}

/** The entry the router is holding right now, or `undefined` when it names none. */
export async function residentLane(): Promise<string | undefined> {
	return (await listLanes()).models.find((m) => m.status === "loaded")?.id;
}

/**
 * Read the router's health line and record any swap it is mid-way through — once per swap: the
 * signature is `from->to`, and a completed swap clears `swap`, which re-arms the recorder so the
 * same pair seen again after a settle counts as the second flip it is. Then answer the guard
 * question for the lane that is resident now.
 */
export async function observeSwaps(windowMs = FLIP_WINDOW_MS): Promise<FlipState> {
	const h = await laneHealth();
	const s = h?.swap;
	if (s && s.to) {
		const sig = `${s.from ?? "?"}->${s.to}`;
		if (sig !== lastSwapSig) swapLog.push({ from: s.from ?? "?", to: s.to, at: Date.now(), waiting: finite(s.waiting) });
		lastSwapSig = sig;
	} else {
		lastSwapSig = "";
	}
	return flipState(await residentLane(), windowMs);
}

/** The guard's answer for `resident` over `windowMs`, from the swaps already observed. */
export function flipState(resident: string | undefined, windowMs = FLIP_WINDOW_MS): FlipState {
	const horizon = Date.now() - windowMs;
	const rows = swapLog.filter((r) => r.at >= horizon);
	while (swapLog.length > 0 && swapLog[0]!.at < horizon) swapLog.shift();
	while (swapLog.length > 50) swapLog.shift();
	const away = rows.filter((r) => resident === undefined || r.to !== resident);
	return {
		flips: away.length,
		window_s: Math.round(windowMs / 1000),
		competing: [...new Set(away.map((r) => r.to))],
		rows,
	};
}

/** True once the window holds enough churn to call it a flip. */
export const flipGuarded = (f: FlipState): boolean => f.flips >= FLIP_MIN_SWAPS;

/** True once a flip is the plan: the next load is the thrash, so the loop refuses it and halts. */
export const flipBreaker = (f: FlipState): boolean => f.flips >= FLIP_BREAKER_AT;

/** The clause a load detail carries when the guard is active, so the cost is never silent. */
export const flipNote = (f: FlipState): string => (flipGuarded(f) ? ` — FLIP GUARD: ${f.flips} swaps in ${f.window_s}s, requests naming ${f.competing.join(", ") || "the other lane"}` : "");
