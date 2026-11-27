/**
 * The basalt ROUTER client. The coder endpoint is basalt's own router
 * (`POST /v1/load {"model": NAME}` blocks until the swap finishes). All three endpoints used
 * here answer on the router port; every failure names the stage, the HTTP status and the body.
 *
 * The host-specific parts are configuration, not constants:
 *   FADE_ORCHESTRATE_PROVIDER default basalt      (the provider that declares every lane alias)
 *   FADE_ORCHESTRATE_THINK_LANE default deepseek   (plans)
 *   FADE_ORCHESTRATE_VERIFY_LANE default hy4-flash (verifies; never the code lane)
 *   FADE_ORCHESTRATE_CODE_LANE  default flash-next (codes)
 *   FADE_ORCHESTRATE_SWAP_CMD default unset      (the host points it at the fleet gate)
 */
import { exec } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { acquireLease, getResidency, packToModelId, releaseLease as releaseSupervisorLease, swapLeased } from "./supervisor.ts";

const execC = promisify(exec);

export const ROUTER = process.env.FADE_ORCHESTRATE_ROUTER ?? "http://127.0.0.1:18014";
/** The provider that fronts the single :18014 basalt lane. The live `modelRoles` are all
 *  `basalt/*` (`default`/`smol`/`vision`/`advisor`/`web` = `basalt/flash-next`,
 *  `slow`/`plan` = `basalt/deepseek`), and `basalt` is the provider that declares every alias of
 *  the lane. `strata-flash` is the legacy block: it names only `flash-next`, so a thinking-lane
 *  `setModel` there cannot resolve and every lane move dies at the registry lookup. Measured
 *  the verdict-lane move was inert until this default was corrected. */
export const PROVIDER = process.env.FADE_ORCHESTRATE_PROVIDER ?? "basalt";
/** Every lane env the plugin refused, in the words the operator reads. Flushed once per session at
 *  `session_start`; empty when the env is honest. */
export const ENV_NOTICES: string[] = [];

/** A lane env is honored only when it does not collapse the loop. `FADE_ORCHESTRATE_THINK_LANE=
 *  flash-next` (the value `~/.config/inference-keys.env` still exports on this box) makes the think
 *  lane the code lane: `loadLane` short-circuits on the resident pack, no swap is issued, and
 *  planning runs on the coder's 52 GiB pack with `THINKING` collapsed to `low` — measured
 *  on run 20261126T063911Z-m5or, `planning_done` and `coding_done` both on flash-next. The refused
 *  value is named once, and the documented lane wins. */
const resolveLane = (name: string, label: string, fallback: string, forbidden: string[], forbiddenLabel: string): string => {
	const want = (process.env[name] ?? "").trim();
	if (want === "") return fallback;
	if (!forbidden.includes(want)) return want;
	const next = forbidden.includes(fallback) ? want : fallback;
	ENV_NOTICES.push(`${name}="${want}" is ignored: that is the ${forbiddenLabel} lane, and a ${label} lane equal to it swaps nothing — ${label} runs on ${next}.`);
	return next;
};

/** The coder's pack. Read first: the other two lanes are judged against it. Naming a documented
 *  thinking pack here is the box poison MIRRORED (`FADE_ORCHESTRATE_CODE_LANE=deepseek`): every
 *  lane collapses to one pack, `loadLane` short-circuits on the resident pack, and no swap is ever
 *  issued. The coder stays on its documented pack and the refusal is named. */
const CODE_WANT = (process.env.FADE_ORCHESTRATE_CODE_LANE ?? "").trim() || "flash-next";
export const CODE_LANE = (() => {
	if (CODE_WANT === "deepseek" || CODE_WANT === "hy4-flash") {
		ENV_NOTICES.push(`FADE_ORCHESTRATE_CODE_LANE="${CODE_WANT}" is ignored: that is a thinking pack, and naming it the code lane collapses every lane to one swap-free coder — code runs on flash-next.`);
		return "flash-next";
	}
	return CODE_WANT;
})();
/** The planning lane: deepseek, never the coder's pack. */
export const THINK_LANE = resolveLane("FADE_ORCHESTRATE_THINK_LANE", "planning", "deepseek", [CODE_LANE], CODE_LANE);
/** The advisor lane: hy4-flash, never the coder's pack. Equal to the PLANNING pack is honored:
 *  one thinking pack for plan-and-verify is a lane-economy choice (the box that runs DS4 for both
 *  pays one swap family, not two), not the one-pack collapse the coder rule refuses. */
export const VERIFY_LANE = resolveLane("FADE_ORCHESTRATE_VERIFY_LANE", "verification", "hy4-flash", [CODE_LANE], CODE_LANE);
/** The packs that verify, i.e. the read-only lanes. */
export const isThinkingLane = (lane: string): boolean => lane === THINK_LANE || lane === VERIFY_LANE;
export const THINKING: Record<string, "high" | "low"> = { [THINK_LANE]: "high", [VERIFY_LANE]: "high", [CODE_LANE]: "low" };

export const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The swap plane. `POST /v1/load` is no longer sent from here: every pack swap rides
 * `basalt-ctl.sh` — the fleet gate (VRAM floor, dwell window, circuit, breaker), the minted
 * approval nonce, and the service lease the census audits. The plugin's own pre-unload gate
 * stays as the first defense (a hostile `/health` spawns nothing), and the ctl gate is the
 * authoritative one. Rigs point this at a stub over their fake router, keeping the
 * "exactly ONE / ZERO POST /v1/load" proofs honest.
 */
/** The fleet gate a swap rides. NO DEFAULT SHIPS HERE: the literal this carried named the private
 *  repo and a host username inside a public package, which is exactly what the provenance sweep
 *  exists to stop. The host configures it in `FADE_ORCHESTRATE_SWAP_CMD`; an unset value is a named
 *  refusal at the call site, never a command line that quietly execs an empty string. */
export const SWAP_CMD = process.env.FADE_ORCHESTRATE_SWAP_CMD ?? "";

/** Which plane issues the lane swap. `supervisor` (the default) rides the
 *  fade-supervisor lane lease exclusively: a load with no token is REFUSED, never
 *  handed to the ctl fleet gate, because a ctl load takes no lease and is exactly
 *  the bypass that let a peer session evict the lane under a held lease
 *  (measured). `ctl` preserves the basalt-ctl.sh fleet gate (VRAM
 *  floor, circuit, minted nonce) verbatim, and is chosen, never fallen into. */
export const SWAP_VIA = process.env.FADE_ORCHESTRATE_SWAP_VIA === "ctl" ? "ctl" : "supervisor";

/** Run the swap command to completion (240 s bound, same as the old direct POST). A kill on
 * timeout is reported as rc 124, never thrown, so the caller's detail names the stage. */
async function runSwap(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execC(command, { timeout: 240_000, maxBuffer: 1 << 20 });
		return { code: 0, stdout, stderr };
	} catch (err: unknown) {
		const e = err as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
		const code = e?.code ?? (e?.killed ? 124 : 1);
		return { code, stdout: e?.stdout ?? "", stderr: e?.stderr ?? "" };
	}
}

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
 *  * `zero VRAM` — reported free VRAM at or under zero: the CUDA context is dead (the recorded
 *    half-dead shape) and no pack lands there. A *low* positive reading is never a refusal: the
 *    swap unloads the resident pack FIRST, so free VRAM with the old pack still mapped is not
 *    the room the next pack gets. There is no pre-unload VRAM floor.
 *  * `swap in flight` — `loading: true` at the END of the settle window. The ping-pong this
 *    gate exists to stop (journal: `swap: flash-next ready in 16.4 s`, then `(1 waiting)`,
 *    `(3 waiting)`) is exactly a second load queued behind a running one.
 */
export interface ServeVerdict {
	serve: boolean;
	reason: string;
}

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
	const model = typeof h.model === "string" ? h.model.trim() : "";
	if (h.loaded === true || h.loaded === "true") {
		if (model === "") return { serve: false, reason: "health claims a loaded context that names no model: nothing is serving" };
	}
	return { serve: true, reason: `context can serve${model !== "" ? ` (${model}${h.loading === false ? ", idle" : ""})` : ""}${free !== undefined ? `, ${Math.round(free)} MiB free` : ", VRAM not reported"}` };
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
 *    serve — unreachable, an error state, a loaded context naming no model, a dead zero-VRAM context,
 *    a swap still in flight — is REFUSED with the class named, and `/v1/load` is never sent.
 */
/**
 * What the supervisor says about the lane, in the shape the load path needs.
 * `resident` is the single question that decides whether a 13-25 s, 52 GiB load
 * is issued at all: the lane state is RESIDENT and the resident pack IS the
 * target. `undefined` (from `supervisorResident`) means NO ANSWER, and a missing
 * reading is never residency — the caller falls through to the router surface
 * that works with the daemon under restart.
 */
export interface SupervisorResident {
	resident: boolean;
	state: string;
	pack: string;
	pid: number;
	active_requests: number;
	telemetry_source: string;
	detail: string;
}

/** Read the supervisor once and answer the residency question. The comparison is the
 *  plugin lane id against the daemon `active_pack`: on this box both are the basalt
 *  model/pack id, so they are compared as given. A daemon that names its packs
 *  differently reports NOT resident, which costs a load and never costs a swap of the
 *  wrong pack — the fail-safe direction. One read per call, no caching: a cached
 *  residency is exactly the stale reading that reloads 52 GiB. */
export async function supervisorResident(lane: string, sessionId = "fade-orchestrator"): Promise<SupervisorResident | undefined> {
	const sup = await getResidency(sessionId);
	if (!sup) return undefined;
	return {
		resident: sup.state === "RESIDENT" && sup.pack === lane,
		state: sup.state,
		pack: sup.pack,
		pid: sup.pid,
		active_requests: sup.active_requests,
		telemetry_source: sup.telemetry_source,
		detail: `supervisor ${sup.version || "?"} lane ${sup.state} pack=${sup.pack || "none"} pid=${sup.pid} requests=${sup.active_requests} telemetry=${sup.telemetry_source}`,
	};
}

/** The gate injected effects. Nothing here reaches the UI or the router directly, which
 *  is what makes the gate DECISION testable: the suite passes counters and reads the
 *  result. */
export interface GateOpts {
	busy: () => Promise<RouterBusy>;
	residency?: () => Promise<SupervisorResident | undefined>;
	deferred?: (msg: string) => void;
	progress?: (msg: string) => void;
	budgetMs?: number;
	pollMs?: number;
}

/** The idle gate answer. `short` names the residency short-circuit when it fired, so a
 *  caller that records the gate (the run rejection_history) can tell a zero-cost
 *  residency answer from a zero-cost idle lane. */
export interface IdleGateResult {
	waited_ms: number;
	polls: number;
	over_budget: boolean;
	last: RouterBusy;
	short?: string;
}

/**
 * The pre-unload idle gate, as a function of its inputs. It lives here, not in the
 * extension closure, because its decision is the part that must be tested: with a
 * supervisor answer of RESIDENT for the target pack the gate returns WITHOUT polling
 * the router and WITHOUT a DEFERRED notify. The DEFERRAL is the plugin-level symptom
 * the operator sees, and the claim that the lane is already where the run wants it is
 * a fact the daemon can state. The residency read is FAIL-OPEN by contract: no answer
 * falls into the busy loop below, the behavior that has always worked.
 */
export async function gateLaneIdle(lane: string, opts: GateOpts): Promise<IdleGateResult> {
	const budgetMs = opts.budgetMs ?? 60_000;
	const pollMs = opts.pollMs ?? 3_000;
	const sup = opts.residency ? await opts.residency() : undefined;
	if (sup?.resident) {
		return {
			waited_ms: 0,
			polls: 0,
			over_budget: false,
			last: { busy: false, reason: `supervisor: ${sup.detail}; the target is resident, the idle gate is not paid` },
			short: "supervisor-resident",
		};
	}
	return gateBusyLoop(lane, opts, budgetMs, pollMs);
}

/** The busy-wait half of the gate: poll the router busy reading on the interval until it
 *  goes idle (a paid gate, not over budget) or the budget runs out (over budget, and the
 *  caller pays the load anyway, because a loop that never lands its lane is a stalled
 *  run). The notify text, the working text and the poll cadence are the ones the operator
 *  reads today; this half only takes its effects as parameters, so the suite can count
 *  them. */
async function gateBusyLoop(lane: string, opts: GateOpts, budgetMs: number, pollMs: number): Promise<IdleGateResult> {
	const t0 = Date.now();
	const budget_s = Math.round(budgetMs / 1000);
	const poll_s = Math.round(pollMs / 1000);
	let polls = 0;
	let last = await opts.busy();
	while (last.busy) {
		polls += 1;
		const waited = Date.now() - t0;
		if (waited >= budgetMs) return { waited_ms: waited, polls, over_budget: true, last };
		if (polls === 1) opts.deferred?.(`fade_orchestrate: the ${lane} load is DEFERRED — ${last.reason}; retrying every ${poll_s}s up to ${budget_s}s`);
		opts.progress?.(`fade_orchestrate: ${lane} load deferred ${Math.round(waited / 1000)}s/${budget_s}s — ${last.reason}`);
		const { promise: tick, resolve: tickDone } = Promise.withResolvers<void>();
		setTimeout(tickDone, pollMs);
		await tick;
		last = await opts.busy();
	}
	return { waited_ms: Date.now() - t0, polls, over_budget: false, last };
}

/** The answer one lane load gives. `minted` is set when the load itself acquired
 *  the lane lease, and `leaseToken`/`leaseSession` are then the capability and the
 *  identity that hold it — the load does NOT return its own lease: the lease
 *  outlives the load by exactly the turn the caller is about to run, and the
 *  caller returns it at the hand-back. Releasing inside the load (the old
 *  `finally`) dropped the guard before the review turn had run a byte, and the
 *  very next peer session minted its own lease and swapped the lane back
 *  (measured). */
export type LaneLoad = { ok: boolean; detail: string; elapsed_s: number; guarded: boolean; flip: FlipState; leaseToken?: string; leaseSession?: string; minted?: boolean };

// `lease: true` asks the router for the DURABLE load: the lane stays resident until
// `releaseLease`, and a request naming any other model is refused (409) instead of swapping
// the lane out — the run's advisory lane runs its full turn. The request rides the swap job
// and `basalt-ctl.sh` puts it in the load body, so the gate and the lease are taken together.
export async function loadLane(lane: string, opts: { lease?: boolean; leaseToken?: string; sessionId?: string; mintLease?: { ttlSec: number } } = {}): Promise<LaneLoad> {
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
	// The supervisor residency answer, read BEFORE the health gate: it is the only
	// reading that stops a 13-25 s, 52 GiB load the router census calls necessary (an
	// unreachable census, a models list naming no loaded entry, a context that reports
	// no model). A NO ANSWER falls through to the gate below, so a daemon under restart
	// costs a load and never a refusal.
	const sup = await supervisorResident(lane, opts.sessionId ?? "fade-orchestrator");
	if (sup?.resident) {
		return { ok: true, detail: `resident per supervisor; no swap issued (${sup.detail})${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1000, guarded, flip };
	}
	// A swap UNLOADS the resident context, so the router's health is read before the byte: the
	// refusal names the class, and the router is never poked with a load it cannot serve.
	const verdict = serveVerdict(health);
	if (verdict.serve === false) {
		return { ok: false, detail: `refused pre-unload: ${verdict.reason}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1000, guarded, flip };
	}

	// The supervisor lease is the single authority over the lane, and on the default
	// plane it is the ONLY swap path: FADE_ORCHESTRATE_SWAP_VIA=supervisor never
	// falls through to the ctl fleet gate. A load with no token and no mint request
	// is REFUSED — a ctl load takes no lease, so it would swap a lane another
	// caller's lease owns, which is the bypass that evicted a held deepseek lane
	// (measured: the peer minted 300 s and landed flash-next unconditionally).
	// A load that carries no run token MINTS under its own identity and KEEPS the
	// lease: the capability must outlive the load by the turn the caller is about to
	// run (`LaneLoad.minted`), or the next peer takes the lane before the turn starts.
	if (SWAP_VIA === "supervisor") {
		const sid = opts.sessionId ?? "fade-orchestrator";
		let token = opts.leaseToken;
		let minted = false;
		if (!token) {
			if (!opts.mintLease) {
				return {
					ok: false,
					detail: `swap via supervisor refused: no lease token held for ${lane} and no mint requested — the supervisor plane never falls through to the ctl fleet gate (a ctl load takes no lease)${flipNote(flip)}`,
					elapsed_s: (Date.now() - t0) / 1000,
					guarded,
					flip,
				};
			}
			// The review/escalation-turn case: this call carries no run token, so it mints
			// its own. The daemon floors apply unchanged - a dev build is refused the acquire
			// here (dev_build_no_evict), and a lane a peer pair owns is `lease_held` naming
			// the holder, which is the refusal a review turn must surface, never swap past.
			// Minting the lease IS the swap on the supervisor plane, so this swap is the loop's own.
			markOwnSwap(lane);
			const lease = await acquireLease(lane, opts.mintLease.ttlSec, sid);
			clearOwnSwap(lane); // the mint blocks through the swap; whatever the polls saw is already booked
			token = lease.ok ? lease.token : undefined;
			minted = !!token;
			if (!token) {
				return {
					ok: false,
					detail: `lease mint refused http ${lease.status} rule ${lease.rule || "?"}: ${lease.reason || "no reason"}${flipNote(flip)}`,
					elapsed_s: (Date.now() - t0) / 1000,
					guarded,
					flip,
				};
			}
		}
		const v = await swapLeased(lane, token, sid);
		const detail = v.ok
			? `swap via supervisor: ${lane}`
			: `swap supervisor refused http ${v.status} rule ${v.rule || "?"}: ${v.reason || "no reason"}`;
		if (!v.ok && minted) {
			// Nothing will run under a lease whose swap was refused: return it, or the
			// capability strands the lane for the whole TTL with no holder to release it.
			await releaseSupervisorLease(token, sid).catch(() => undefined);
			return { ok: false, detail: `${detail}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1000, guarded, flip };
		}
		return {
			ok: v.ok,
			detail: `${detail}${flipNote(flip)}`,
			elapsed_s: (Date.now() - t0) / 1000,
			guarded,
			flip,
			...(minted ? { leaseToken: token, leaseSession: sid, minted: true } : {}),
		};
	}
	// The ctl plane is reached only by FADE_ORCHESTRATE_SWAP_VIA=ctl — the operator's
	// explicit choice. It takes no supervisor lease, so it is never a fallback.
	if (!SWAP_CMD) {
		return { ok: false, detail: `swap plane unconfigured: FADE_ORCHESTRATE_SWAP_CMD is unset (the host points it at the fleet gate; no path ships in the plugin)${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1000, guarded, flip };
	}
	try {
		// One swap, one lease: the ctl script gates, mints, grants, burns, loads, and the minted
		// approval nonce rides the service lease the census audits.
		const dir = await mkdtemp(join(tmpdir(), "fade-swap-"));
		const jobPath = join(dir, "job.json");
		await writeFile(jobPath, JSON.stringify({ schema: "farol.job/1", engagement: "ENG-LOCAL-GPU", run: `omp-${Date.now()}`, task: "lane-swap", data_class: "internal", model: lane, swap: true, ...(opts.lease ? { lease: true } : {}) }));
		// The ctl byte is issued by this process, so the swap it causes is not churn.
		markOwnSwap(lane);
		const { code, stdout, stderr } = await runSwap(`${SWAP_CMD} '${jobPath}'`);
		clearOwnSwap(lane); // the ctl byte blocks through the swap; an unobserved swap leaves no mark
		const final = stdout.trim().split("\n").pop() ?? "";
		const text = `${stdout}${stderr}`.replace(/\s+/g, " ").trim();
		const ok = code === 0 && final === lane;
		return { ok, detail: ok ? `swap via ctl: ${lane}${flipNote(flip)}` : `swap ctl refused rc=${code}: ${text.length > 300 ? `${text.slice(0, 300)}...` : text}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1000, guarded, flip };
	} catch (e) {
		return { ok: false, detail: `${msg(e)}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1000, guarded, flip };
	}
}

/** End the durable load taken by `loadLane(lane, { lease: true })`. The router lands its default
 *  lane (flash-next) on release, so ending a run never leaves the box pinned to the run's lane.
 *  Releasing a lease that is not held is a no-op at the router. Best-effort by contract: the run's
 *  end must not die on a dead router. */
export async function releaseLease(lane: string): Promise<{ ok: boolean; detail: string }> {
	try {
		// The hand-back lands the default lane: the loop's own swap too, marked so the release is
		// never read as a client flipping the box.
		markOwnSwap(lane);
		const r = await fetch(`${ROUTER}/v1/load`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: lane, lease: false }),
			signal: AbortSignal.timeout(10_000),
		});
		clearOwnSwap(lane);
		const text = await r.text();
		return { ok: r.ok, detail: `http ${r.status} ${text.slice(0, 200)}` };
	} catch (e) {
		return { ok: false, detail: msg(e) };
	}
}

/** The `/lane` verb's budget. A load is tens of seconds and tens of gigabytes, so the command
 *  waits for the pack to be RESIDENT and proves it, and names the state when the budget ends —
 *  it never kills a load in flight. */
export const LANE_WAIT_MS = Number(process.env.FADE_ORCHESTRATE_LANE_WAIT_MS ?? 180_000);
export const LANE_POLL_MS = Number(process.env.FADE_ORCHESTRATE_LANE_POLL_MS ?? 2_000);
export const LANE_LEASE_TTL_SEC = Number(process.env.FADE_ORCHESTRATE_LANE_LEASE_TTL_SEC ?? 1_800);

/** The start preflight's budget: a cold `deepseek` load measures 13-25 s and the daemon's own
 *  readiness window is far longer, so the proof waits and names the state — it never kills a load. */
export const START_PROOF_WAIT_MS = Number(process.env.FADE_ORCHESTRATE_START_PROOF_WAIT_MS ?? 240_000);

/** Basalt's keep-alive cadence for a client that waits through a swap
 *  (`basalt/docs/running.md`, `docs/changelog/0.3.0.md`: "Clients wait through a swap; they do
 *  not get a 503 for it. A streamed response sends keep-alive comments every 10 s while it
 *  waits."). The hold below refreshes the working message on this clock, so the operator sees
 *  the swap moving and the host client never times out. */
export const LANE_KEEPALIVE_MS = Number(process.env.FADE_ORCHESTRATE_KEEPALIVE_MS ?? 10_000);

/** The wait ceiling is the daemon's own readiness window (900 s), never a client timeout: a pack
 *  load is tens of seconds and tens of gigabytes, and Basalt's router holds a request for the
 *  loaded model for that whole window. Rigs override it. */
export const SERVE_WAIT_MS = Number(process.env.FADE_ORCHESTRATE_SERVE_WAIT_MS ?? 900_000);

export interface LaneProof {
	ok: boolean;
	/** The daemon's `lane_state` at the end of the window; `unknown` when it never answered. */
	state: string;
	pack?: string;
	/** The id the ROUTER serves, from `/v1/models`; `undefined` when it answers nothing. */
	served_id?: string;
	n_ctx?: number;
	waited_s: number;
}

/** Admitted is not loaded, and `RESIDENT` proves only that SOME model answered the readiness probe.
 *  The proof is BOTH, polled together until they agree: the daemon names `target` as the resident
 *  pack AND the router serves `target` as an id. Breaking on the daemon half and one-shotting the
 *  router was the 404: `swap` ADMITTED, supervisor already `RESIDENT pack=flash-next`, `:18014`
 *  still listing `hy4-flash`, and the next turn named the pack that was not serving —
 *  `404 The model 'flash-next' does not exist`. A daemon that never answers, and a router that
 *  still serves another id at the end of the window, are failures that name their class. */
export async function proveResident(target: string, opts: { sessionId?: string; waitMs?: number; pollMs?: number } = {}): Promise<LaneProof> {
	const sid = opts.sessionId ?? "fade-orchestrator";
	const waitMs = opts.waitMs ?? LANE_WAIT_MS;
	const pollMs = opts.pollMs ?? LANE_POLL_MS;
	const t0 = Date.now();
	let state = "unknown";
	let pack: string | undefined;
	let idn: { id?: string; n_ctx?: number } | undefined;
	for (;;) {
		const now = await supervisorResident(target, sid);
		state = now?.state ?? state;
		pack = now?.pack ?? pack;
		idn = await servedIdentity();
		if (now?.resident && idn?.id === target) break;
		if (Date.now() - t0 >= waitMs) break;
		const { promise: tick, resolve: tickDone } = Promise.withResolvers<void>();
		setTimeout(tickDone, pollMs);
		await tick;
	}
	const waited_s = (Date.now() - t0) / 1000;
	return { ok: state === "RESIDENT" && pack === target && idn?.id === target, state, pack, served_id: idn?.id, n_ctx: idn?.n_ctx, waited_s };
}


export interface ServeHold {
	ok: boolean;
	/** The id the router served at the end of the wait; `undefined` when it answers nothing. */
	served_id?: string;
	/** `/v1/models` reads taken. A pin that already matches the served id is ONE. */
	polls: number;
	/** Working-message refreshes, each on the keep-alive clock. */
	refreshes: number;
	waited_s: number;
	/** A load the router itself declares failed: Basalt's 503 class, not a slow swap. */
	failed: boolean;
	reason: string;
}

/**
 * Hold the completion the way Basalt's router holds it, for a box whose `:18014` process is
 * REPLACED by a supervisor swap and therefore serves exactly one id.
 *
 * Basalt's contract, copied from `configuration/models.md` and `running.md`: a request for the
 * loaded model runs at once; a request for a name the server does not carry is a 404; a client
 * waits through a swap and is never 503'd for it. On this box the swap is a process replacement,
 * so "the model is not in that server's `models` list" is the 404
 * `The model 'flash-next' does not exist` the loop died on — the pin named the pack the swap was
 * bringing in, and the completion posted before it served.
 *
 * So this is the wait: one read, and if the served id already is `wanted`, it returns at once
 * (zero extra polls — the loaded model runs at once). Otherwise it holds, refreshing the working
 * message on the keep-alive clock with the router's own percent, and returns only when the lane
 * serves `wanted`, when the router declares the load FAILED (the 503 class), or when the
 * daemon's readiness window is spent. It never posts, and it never answers for the host.
 */
export async function laneServeHold(
	wanted: string,
	opts: {
		waitMs?: number;
		pollMs?: number;
		keepAliveMs?: number;
		served?: () => Promise<{ id?: string; n_ctx?: number } | undefined>;
		health?: () => Promise<RouterHealth | undefined>;
		/** The keep-alive page: one line per refresh. `percent` rides so a caller with a painted
		 *  surface (the status pill, the Alt+F header) can move it with the load; the working
		 *  message already carries the percent in its own words. */
		progress?: (message: string, percent?: number) => void;
	} = {},
): Promise<ServeHold> {
	const served = opts.served ?? servedIdentity;
	const health = opts.health ?? laneHealth;
	const pollMs = opts.pollMs ?? LANE_POLL_MS;
	const waitMs = opts.waitMs ?? SERVE_WAIT_MS;
	const keepAliveMs = opts.keepAliveMs ?? LANE_KEEPALIVE_MS;
	const t0 = Date.now();
	let polls = 0;
	let refreshes = 0;
	let nextRefreshAt = t0;
	for (;;) {
		const idn = await served();
		polls += 1;
		if (idn?.id === wanted) {
			return { ok: true, served_id: idn.id, polls, refreshes, failed: false, waited_s: (Date.now() - t0) / 1000, reason: `${wanted} is the id the lane serves` };
		}
		if (Date.now() - t0 >= waitMs) {
			return {
				ok: false,
				...(idn?.id !== undefined ? { served_id: idn.id } : {}),
				polls,
				refreshes,
				failed: false,
				waited_s: (Date.now() - t0) / 1000,
				reason: `the lane serves ${idn?.id ?? "nothing"}, not ${wanted}, after ${((Date.now() - t0) / 1000).toFixed(1)}s`,
			};
		}
		if (Date.now() >= nextRefreshAt) {
			const h = await health();
			refreshes += 1;
			nextRefreshAt = Date.now() + keepAliveMs;
			// Basalt's failed load "answers its batch with a 503 naming the model". The router's own
			// pre-unload verdict names the same class: an error state, a dead zero-VRAM context, a
			// loaded context that names no model. A swap still in flight — `loading: true`, or
			// `/health` refusing while the process is being replaced — is NOT a failure: that is
			// precisely the wait Basalt holds a client through, so it keeps waiting.
			const verdict = serveVerdict(h);
			if (!verdict.serve && h !== undefined && h.loading !== true) {
				return {
					ok: false,
					...(idn?.id !== undefined ? { served_id: idn.id } : {}),
					polls,
					refreshes,
					failed: true,
					waited_s: (Date.now() - t0) / 1000,
					reason: `${wanted} did not come up: ${verdict.reason} — the 503 class, not a slow swap`,
				};
			}
			const pct = typeof h?.percent === "number" ? Math.round(h.percent) : undefined;
			opts.progress?.(`fade_orchestrate: ${wanted} is not serving yet (the lane answers ${idn?.id ?? "nothing"})${pct !== undefined ? ` ${pct}%` : ""} — this request waits, it does not time out`, pct);
		}
		const { promise: tick, resolve: tickDone } = Promise.withResolvers<void>();
		setTimeout(tickDone, pollMs);
		await tick;
	}
}

/** The screen's model pin, or `undefined` = leave the screen alone. `residentPack` is the daemon's
 *  `active_pack`; `owed` is the lane this session's work is owed — `pending?.lane ?? run.lane` for a
 *  live run, the recorded verify lane for a plain session. A swap drains for tens of seconds, and
 *  pinning the pack that is still resident in that window is the measured defect: the run asks for
 *  `deepseek`, the sync lands `flash-next`, and the first completion never names the guest. */
export function laneSyncTarget(residentPack: string | undefined, owed: string | undefined): string | undefined {
	if (residentPack === undefined) return undefined;
	const target = packToModelId(residentPack);
	if (owed !== undefined && packToModelId(owed) !== target) return undefined;
	return target;
}

/** The names this box's router is meant to serve: the three lanes. Basalt's rule is that a
 *  request for a name the server does not carry is a 404 — "any other name" — so a pin outside
 *  this set is the HOST's 404 to answer, and the hold stays out of it. */
export function isServedLane(id: string): boolean {
	return id === CODE_LANE || id === THINK_LANE || id === VERIFY_LANE;
}

const statusOf = (m: Record<string, unknown>): string => {
	const s = m.status;
	return typeof s === "object" && s !== null ? String((s as { value?: string }).value ?? "") : String(s ?? "");
};

/** The entry the ROUTER is serving, with the window the engine itself advertises. Read from
 *  `/v1/models`, never from the daemon: `RESIDENT` proves only that SOME model answered the
 *  readiness probe (`HTTPProbe(..., want="")`), and `packs[].alias` has no consumer. */
export async function servedIdentity(timeoutMs = 4_000): Promise<{ id?: string; n_ctx?: number } | undefined> {
	try {
		const r = await fetch(`${ROUTER}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!r.ok) return undefined;
		const listing = (await r.json()) as { data?: Array<Record<string, unknown>> };
		const rows = listing?.data ?? [];
		const hit = rows.find((m) => statusOf(m) === "loaded") ?? rows[0];
		if (!hit) return undefined;
		const meta = hit.meta as { n_ctx?: number } | undefined;
		return { id: String(hit.id ?? hit.model ?? "?"), n_ctx: typeof meta?.n_ctx === "number" ? meta.n_ctx : undefined };
	} catch {
		return undefined;
	}
}

export interface LaneMove {
	ok: boolean;
	detail: string;
	resident?: string;
	served_id?: string;
	n_ctx?: number;
	waited_s: number;
	flip: FlipState;
	/** Present when the move minted its own lease and could not hand it back. */
	lease_returned?: boolean;
}

/**
 * Move the single :18014 pack to `target` and PROVE it, for a human `/lane` call. Three rules,
 * each measured on this box:
 *  - the churn ledger is read FIRST, and at the breaker the command issues ZERO bytes: a refusal
 *    that moves nothing is the only way the task can still finish on the resident pack;
 *  - the move itself is `loadLane`, so the residency short-circuit, the pre-unload verdict, the
 *    minted lease and its `finally` release are the run path's — never a second implementation;
 *  - success is the ROUTER naming `target` loaded. `RESIDENT pack=X` is a claim about a spawn,
 *    not about an id, and the roles 404 on an id the lane does not serve.
 */
export async function moveLane(target: string, opts: { sessionId?: string; waitMs?: number; pollMs?: number } = {}): Promise<LaneMove> {
	const sid = opts.sessionId ?? "fade-orchestrator";
	const waitMs = opts.waitMs ?? LANE_WAIT_MS;
	const pollMs = opts.pollMs ?? LANE_POLL_MS;

	const flip = await observeSwaps();
	if (flipBreaker(flip)) {
		return {
			ok: false,
			detail: `refused at the churn guard: ${flip.flips} swaps in ${flip.window_s}s, requests naming ${flip.competing.join(", ") || "the other lane"} — no lease, no swap byte issued; move the lane by hand if that is the plan`,
			waited_s: 0,
			flip,
		};
	}

	const t0 = Date.now();
	const sup = await supervisorResident(target, sid);
	if (sup?.resident) {
		const idn = await servedIdentity();
		const ok = idn?.id === target;
		return {
			ok,
			detail: ok
				? `${target} resident (${sup.detail}); router id ${idn.id}${idn.n_ctx ? ` n_ctx ${idn.n_ctx}` : ""}`
				: `daemon says RESIDENT pack=${target} but the router serves ${idn?.id ?? "nothing"} — the pack did not answer on the lane port`,
			resident: sup.pack, served_id: idn?.id, n_ctx: idn?.n_ctx,
			waited_s: (Date.now() - t0) / 1000,
			flip,
		};
	}

	const r = await loadLane(target, { mintLease: { ttlSec: LANE_LEASE_TTL_SEC }, sessionId: sid });
	if (!r.ok) return { ok: false, detail: r.detail, waited_s: (Date.now() - t0) / 1000, flip: r.flip };
	// A HUMAN move returns the lane: this verb loads a pack for the operator and,
	// unlike a turn that runs under the lease, has no review to protect with it. The
	// lease is held across the readiness proof below, so a peer cannot swap the pack
	// out mid-proof, and returned before the verb answers.
	const handBack = async (): Promise<boolean> => {
		if (!r.minted || !r.leaseToken) return false;
		try {
			const rel = await releaseSupervisorLease(r.leaseToken, r.leaseSession ?? sid);
			return rel.ok;
		} catch {
			return false;
		}
	};

	// Admitted is not loaded: the job tears the old pack down, spawns, and the daemon's own
	// readiness window is 900 s. `proveResident` polls the daemon, then proves the id from the
	// router — one proof implementation, shared with the start preflight.
	const proof = await proveResident(target, { sessionId: sid, waitMs, pollMs });
	const returned = await handBack();
	if (proof.ok) {
		return {
			ok: true,
			detail: `${target} resident in ${proof.waited_s.toFixed(1)}s; router id ${proof.served_id}${proof.n_ctx ? ` n_ctx ${proof.n_ctx}` : ""} — requests naming any other id answer 404 until the roles move${flipNote(flip)}`,
			resident: proof.pack, served_id: proof.served_id, n_ctx: proof.n_ctx, waited_s: proof.waited_s, flip,
			...(r.minted ? { lease_returned: returned } : {}),
		};
	}
	return {
		ok: false,
		detail: `${target} not proven resident after ${proof.waited_s.toFixed(1)}s: daemon state ${proof.state} pack ${proof.pack ?? "none"}, router id ${proof.served_id ?? "nothing"} — hand the lane back with \`/lane flash-next\`${flipNote(flip)}`,
		resident: proof.pack, served_id: proof.served_id, n_ctx: proof.n_ctx, waited_s: proof.waited_s, flip,
		...(r.minted ? { lease_returned: returned } : {}),
	};
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

export interface SwitchPlan {
	/** True when the pre-unload idle gate has to run at all. */
	gate: boolean;
	/** True when a load/swap byte is on the table. */
	load: boolean;
	/** The reason, in the words the operator reads. */
	reason: string;
}

/**
 * The lane-switch decision, as a pure function of what the router holds.
 *
 * A target the router ALREADY holds needs no idle gate and no load: `loadLane` refuses it with
 * `already resident; no swap issued` after one lane-listing read. Gating before that check — which
 * is what this file used to do — polled the slot census for up to `GATE_BUDGET_MS` and raised the
 * `load is DEFERRED — slot busy` warning for a lane that was never going to move, while the request
 * occupying the slot was the session asking for it. Any other target keeps the full sequence
 * untouched: idle gate, then the lease/ctl swap path.
 */
export function switchPlan(resident: string | undefined, lane: string): SwitchPlan {
	if (resident === lane) return { gate: false, load: false, reason: `already resident: ${lane}; no load to gate` };
	return { gate: true, load: true, reason: `${lane} is not resident${resident ? ` (resident: ${resident})` : " (the router names no loaded entry)"}: gate, then swap` };
}
/** The lanes THIS process asked the router to load, through `loadLane`/`releaseLease`, each
 *  consumed once by the recorder and cleared when the issuing call returns. The churn the guard
 *  counts is the churn the router does for OTHER clients (block 19 of the gate rig names the class:
 *  the host's title generator, a memory completion, resolved onto another lane). The loop's own
 *  swaps are not that churn, and counting them let the guard refuse the loop's own next load: on a
 *  2-core runner a verification boundary's four swaps reach the shipped `FLIP_MIN_SWAPS = 2` inside
 *  the window, and the act paying them came back `no swap issued — FLIP GUARD: 4 swaps in 60s` with
 *  zero pins and zero pages (CI runs 45957020140, 45958633125). The mark keys the TARGET lane, not
 *  the `from->to` pair: the recorder's `from` is what the router publishes mid-swap, and a pair mark
 *  missed when the loop's own resident read landed inside the swap window — `?->lane` against
 *  `flash-next->lane` — which is what kept the CI runner red after the pair mark shipped. Marks
 *  expire with the window and die with the issuing call, so a swap the polls never saw leaves no
 *  residue: an external flip onto the same lane is recorded the moment the loop is not the one
 *  making it. */
const ownSwapTo = new Map<string, number>();
function markOwnSwap(to: string): void {
	ownSwapTo.set(to, Date.now());
}
function clearOwnSwap(to: string): void {
	ownSwapTo.delete(to);
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
	const now = Date.now();
	for (const [k, v] of ownSwapTo) if (v < now - windowMs) ownSwapTo.delete(k);
	if (s && s.to) {
		const sig = `${s.from ?? "?"}->${s.to}`;
		if (sig !== lastSwapSig) {
			if (ownSwapTo.delete(s.to)) {
				// the swap this process asked for, landing: paid, and never churn
			} else swapLog.push({ from: s.from ?? "?", to: s.to, at: Date.now(), waiting: finite(s.waiting) });
		}
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

/** The verification trigger for NORMAL sessions. `/orchestrate` moves the lane at phase
 *  boundaries; a plain session has no phase contract, so the trigger is the act of asking for a
 *  verdict. The op names are the loop's own: `report` settles a task on its test log and `review`
 *  opens a reviewer round, and both are answered by the advisor lane (`VERIFY_LANE`); `intake` is
 *  coding work starting, and `abort` ends the task. `off` disables the whole mechanism by env. */
export const LANE_ON_VERIFY = process.env.FADE_ORCHESTRATE_LANE_ON_VERIFY !== "off";
export const VERIFY_IN_OPS = (process.env.FADE_ORCHESTRATE_VERIFY_IN_OPS ?? "report,review").split(",").map((s) => s.trim()).filter(Boolean);
export const VERIFY_OUT_OPS = (process.env.FADE_ORCHESTRATE_VERIFY_OUT_OPS ?? "intake,abort").split(",").map((s) => s.trim()).filter(Boolean);
export const VERIFY_AGENTS = (process.env.FADE_ORCHESTRATE_VERIFY_AGENTS ?? "reviewer,frontier-reviewer").split(",").map((s) => s.trim()).filter(Boolean);

export type VerifyTrigger = { lane: string; reason: string } | { none: string };

/**
 * Pure decision: does THIS tool call mean verification has started (move to the advisor lane)
 * or that coding resumed (hand the code lane back)? No I/O, no lane touched — the caller acts.
 *
 * `task` is read for the agent kind on every shape the host sends: a top-level `agent: "reviewer"`,
 * a flat `items: [{ agent }]`, and the phased form `list: [{ phase, items: [{ agent }] }]` — a
 * delegated batch names the kind per item, one phase deep.
 */
export function verifyTrigger(toolName: string | undefined, input: Record<string, unknown> | undefined, verify = VERIFY_LANE, code = CODE_LANE): VerifyTrigger {
	if (!LANE_ON_VERIFY) return { none: "FADE_ORCHESTRATE_LANE_ON_VERIFY=off" };
	const name = toolName ?? "";
	const op = typeof input?.op === "string" ? input.op : "";
	if (name === "frontier") {
		if (VERIFY_IN_OPS.includes(op)) return { lane: verify, reason: `frontier op=${op} asks for the verdict — the advisor lane answers it` };
		if (VERIFY_OUT_OPS.includes(op)) return { lane: code, reason: `frontier op=${op} is coding work resuming` };
		return { none: `frontier op=${op || "?"} is not a verdict act` };
	}
	if (name === "task") {
		const kinds = new Set<string>();
		const direct = typeof input?.agent === "string" ? input.agent.split(":")[0] : "";
		if (direct) kinds.add(direct);
		for (const key of ["items", "list"]) {
			const rows = input?.[key];
			if (!Array.isArray(rows)) continue;
			for (const r of rows) {
				if (!r || typeof r !== "object") continue;
				const rec = r as Record<string, unknown>;
				const scan: Array<Record<string, unknown>> = [rec];
				if (Array.isArray(rec.items)) {
					for (const it of rec.items as unknown[]) {
						if (it && typeof it === "object") scan.push(it as Record<string, unknown>);
					}
				}
				for (const row of scan) {
					for (const k of ["agent", "kind", "role"]) {
						const v = row[k];
						if (typeof v === "string") kinds.add(v.split(":")[0]);
					}
				}
			}
		}
		const hit = [...kinds].filter((k) => VERIFY_AGENTS.includes(k));
		if (hit.length) return { lane: verify, reason: `task carries ${hit.join(", ")} — verification runs on the advisor lane` };
		return { none: `task names ${[...kinds].join(", ") || "no agent kind"}: not a verification agent` };
	}
	return { none: `${name || "tool"} is not a verdict surface` };
}
