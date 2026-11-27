/**
 * fade_orchestrate: one OMP session, three basalt lanes: a planning lane plans, an advisor lane
 * answers the verdict acts, the code lane implements. (Wiring; the router client is
 * ./router.ts, the schema/validators/briefings are ./core.ts.)
 *
 * The loop is a phase contract, not tool sandboxing: the thinking lane answers with
 * `fade_phase`, and the tool validates, records the phase and ends the turn. `agent_end` is the
 * only load site, and the pin and the prompt go out WITH the load: `loadLane`, then
 * `setModel` + `setThinkingLevel` + the tool policy + the phase briefing, in one generation. What
 * waits is the COMPLETION, not the pin: `before_agent_start` — the last hook before the host
 * posts — holds the turn until the lane serves the pin, the way Basalt's router holds a client
 * through a swap. A superseded generation cancels its own pin and briefing and never touches the
 * router. The host defers model switches while streaming, and a load issued into a turn's queued
 * requests flips the lane back, which is why the act belongs at `agent_end`, the turn closed.
 *
 *   /orchestrate [--rounds N] <goal>   start a run (default 6 rounds, max 6)
 *   /orchestrate status                state, lane, round, tasks, phase log, path
 *   /orchestrate stop [--clear]        mark the run stopped (leave the resident lane)
 *   /orchestrate lanes reset           clear the flip ledger and land the owed lane (the THRASH BREAKER's release)
 *   /orchestrate runs                  the archived finished runs, newest first
 *   Alt+F                              the live panel: tasks, phases, engine metrics, swap cost
 *                                      (keys s/v/r/p/c/h act on the selected task; esc/q/Ctrl+C/the chord close)
 *   /lanes                             live router census: all three lane entries + health
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { gateLaneIdle, supervisorResident, IdleGateResult, CODE_LANE, ENV_NOTICES, FLIP_WINDOW_MS, LANE_POLL_MS, PROVIDER, ROUTER, START_PROOF_WAIT_MS, THINK_LANE, THINKING, VERIFY_LANE, flipBreaker, flipGuarded, flipState, isServedLane, isThinkingLane, laneServeHold, laneSyncTarget, listLanes, loadLane, msg, observeSwaps, resetFlipLedger, routerBusy, type RouterBusy, residentLane, switchPlan, moveLane, servedIdentity, verifyTrigger } from "./router.ts";
import { acquireLease, releaseLease, renewLease, leaseLine, getResidency, shouldRenew, packToModelId, RULE_LEASE_STALE_TOKEN, RULE_LEASE_NOT_HOLDER } from "./supervisor.ts";
import { THINK_MODEL, askLabel, askLane } from "./thinklane.ts";
import {
	DESK_DEADLINE_MS,
	DESK_SETTLE_MS,
	DESK_WAIT_MS,
	attachVerdicts,
	awaitVerdict,
	claimBatch,
	deskLine,
	enqueueRequest,
	noteTaskBatch,
	openRequests,
	parseDesk,
	readDesk,
	readyToAddress,
	sealBatch,
	setChurn,
	type VerifyDesk,
	mutateDesk,
	deskPath,
	type VerifyRequest,
	owedRequests,
} from "./desk.ts";
import { VERIFIER_AGENT, VERIFIER_MODEL, WORKER_AGENT, isRouterModel, routeFor, routeLine, taskBatchOf, verifierAgentMd, verifierAgentPath, verifierDirective, workerAgentMd, workerAgentPath, type RouteDecision } from "./subagent.ts";
import { probeLabel, probeVerifierLane } from "./lane.ts";
import { gateTriage, triageLine } from "./triage.ts";
import {
	ACTIVE_FILENAME,
	DEFAULT_ROUNDS,
	MAX_ROUNDS,
	MAX_TASKS,
	PLAN_ACT_NOTE,
	PHASE_FOR_STATE,
	STATE_FILENAME,
	STATE_KEY,
	SCHEMA_HINT, STALL_SYNTHESIZE_AT, acquireInstanceLock, adaptiveRounds, classifyTurnEnd, coalesceWrite, execGitAsync, instanceLockDir, normalizeRun, parseJson, pushRejection, readInstanceLock, readJsonAsync, refreshChecks, refreshRoot, releaseInstanceLock, roundsForTasks, runGate, sameTaskPlan, synthesizeCodingDone, tagCheckpoint,
	TERMINAL,
	briefings,
	validateChecks,
	validateTasks,
	writeJson,
	writeJsonAsync,
	type GateResult,
	type PhaseLog,
	type RunState,
	type Task,
	gitCaveat,
	isGitRepo,
} from "./core.ts";
import { roundWindow } from "./core.ts";
import { chordBytes, keyLabel, modelLabel, ORCH_STATUS_KEY, OVERLAY_WIDGET_KEY, statusLines, TOP_WIDGET_KEY, type FlipBadge, type SwapPill } from "./ui.ts";
import { actCode, actHalt, actPause, actReset, actSkip, actVerify } from "./keymap.ts";
import { appendTurn, readSwaps, summarizeSwaps, turnRecordOrNull } from "./history.ts";
import { coldHot, fetchMetrics, fetchTurnMetrics, laneBestRate, persistMetrics, startSwapWatch, type MetricsSnapshot } from "./livedata.ts";
import { handoverText } from "./core.ts";
import { engineProofInvalidate, laneMoe, moeBalanceRows } from "./moe.ts";
import { openPanel, type PanelAction } from "./panel.ts";
import { assembleScreen, collectScreen, formatElapsed, type ScreenData } from "./screendata.ts";
import { RUNS_DIRNAME, archiveRun, listRuns } from "./runs.ts";
import { classOf, classWarmth, versionLine } from "./taskmoe.ts";

// The panel key. The default is `alt+f`, not `ctrl+o`: the host binds `ctrl+o` to
// `app.tools.expand` and ACTS on its own bindings, so the screen cannot live there. The host's
// key table binds `alt+f` too (`getShortcutConflict("alt+f")` → `keybinding
// tui.editor.cursorWordRight`), so the SHORTCUT registration for it is refused — the chord is
// claimed at the RAW-INPUT layer, where this extension consumes `ESC f` (0x1b 0x66) and the host
// binding never runs. The registration is still attempted and its refusal tolerated: the byte is
// the delivery, and no host binding is moved.
// Which layer wins a chord the host's table binds is a terminal fact, not an assumption, so
// `test/pty_rig.mjs` drives the real `omp` binary and asserts `ESC f` opens the panel; if the
// host ever steals the byte, the rig names the steal and the fallback chord is what opens.
// `FADE_ORCHESTRATE_KEY` moves the chord (`ctrl+<a-z>`, `alt+<a-z>` and `alt+shift+<a-z>` have
// byte forms; `ctrl+shift+<a-z>` does not — shift is invisible inside a control code).
// The chords the host's action table leaves FREE in the single-alt family are
// `alt+c e j q s t u v w x z`; `FADE_ORCHESTRATE_FALLBACK_KEY` (default `alt+shift+i`, ESC +
// `I`) is the registered companion chord.

// The pre-unload health gate: `POST /v1/load` unloads the RESIDENT lane, and a request queued
// at that instant is answered by the router's own swap log line (`swap <a> -> <b> (1 waiting)`) —
// a full pack load paid into a lane that is serving. The gate reads the router's busy surface
// (`routerBusy`) and DEFERS the load: one poll every GATE_POLL_MS (default 3 s) for up to
// GATE_BUDGET_MS (default 60 s). Both are configuration so a rig can run a whole budget in
// milliseconds; the documented interval/budget is what a live box runs.
const GATE_POLL_MS = Number(process.env.FADE_ORCHESTRATE_GATE_POLL_MS ?? 3000);
const GATE_BUDGET_MS = Number(process.env.FADE_ORCHESTRATE_GATE_BUDGET_MS ?? 60_000);
const FADE_KEY = process.env.FADE_ORCHESTRATE_KEY ?? "alt+f";
// `--demo-redact`: the display switch starts OFF; `/orchestrate --demo-redact` flips it for
// the session, and `FADE_ORCHESTRATE_REDACT=1` sets the same switch from the environment.
// The fast-path threshold: the verifier swap is 13-25 s and 52-130 GiB, and the pre-swap gate
// has already run the plan's deterministic checks on the code lane. A single-file edit under
// this many changed lines, with the gate green on the FIRST try, completes on the code lane:
// the swap buys nothing the exit codes did not already prove.
const FASTPATH_LINES = Number(process.env.FADE_ORCHESTRATE_FASTPATH_LINES ?? 15);
const FASTPATH_FILES = Number(process.env.FADE_ORCHESTRATE_FASTPATH_FILES ?? 1);
// The status row's surface. `widget` (the default) docks it above the editor; `status` writes the
// same text to the host's status bar, which is the right choice only for a `statusLine` config that
// placed the `status` segment after the model — the host puts the text wherever the config says, and
// an extension cannot move a segment.
const SURFACE = process.env.FADE_ORCHESTRATE_SURFACE === "status" ? "status" : "widget";

// The WRITING tools, by NAME. The verifier sandbox is a denylist, not an allowlist, so a host
// tool this file has never seen cannot slip a write past it. Delegation is NOT on the list:
// `task` writes nothing itself, and the sessions it spawns are inert by `isDelegatedSession` —
// blocking it here only blocks the coding session that owns the run.
const MUTATING_TOOLS: Record<string, true> = { edit: true, write: true, apply_patch: true, multiedit: true, multi_edit: true, notebook_edit: true };

/**
 * Delegated (subagent) session detector. A subagent loads this extension in the SAME cwd, so an
 * unguarded `session_start` adopts the owner's run into the worker's session and drives the
 * router from a session that does not own it. `PI_SESSION_FILE` separates the two shapes with no
 * configuration: the owner's jsonl sits directly under the project dir; a delegated one is
 * nested inside a parent-session dir named by the timestamp stamp and filed by agent id.
 */
const MAIN_SESSION_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;
const isDelegatedSession = (): boolean => {
	const f = process.env.PI_SESSION_FILE ?? "";
	if (f === "") return false;
	const parent = basename(dirname(f));
	return MAIN_SESSION_DIR.test(parent) && !f.endsWith(`${parent}.jsonl`);
};

/**
 * The host's own subagent identity, read defensively: `ctx.agent` is
 * `{kind:"main"|"sub", id, name, depth, parentId}` in the running host and absent from the
 * published peer types, so the shape is narrowed, never asserted. `kind` is the authority and
 * `isDelegatedSession()` (the `PI_SESSION_FILE` path shape) is the fallback for a host that
 * answers nothing: a worker is a worker under either reading.
 */
const hostAgent = (ctx: unknown): { kind: string; name: string } | undefined => {
	const c = ctx !== null && typeof ctx === "object" && !Array.isArray(ctx) ? (ctx as Record<string, unknown>) : undefined;
	const a = c?.agent;
	const rec = a !== null && a !== undefined && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : undefined;
	if (!rec) return undefined;
	return { kind: typeof rec.kind === "string" ? rec.kind : "", name: typeof rec.name === "string" ? rec.name : "" };
};

/** True when this session is a delegated worker — the host's answer first, the path shape second. */
const isWorkerSession = (ctx: unknown): boolean => hostAgent(ctx)?.kind === "sub" || isDelegatedSession();

/** The worker's own name, as the desk records it. */
const workerName = (ctx: unknown): string => hostAgent(ctx)?.name || basename(process.env.PI_SESSION_FILE ?? "").replace(/\.jsonl$/, "") || "worker";

/** The desk's shelf for a session: the run dir lives in the run root, and a worker shares the cwd. */
const deskDirFor = (ctx: { cwd: string }): string => join(ctx.cwd, "var", "omp-orchestrate");

export default function fadeOrchestrate(pi: ExtensionAPI): void {
	let run: RunState | undefined;
	let runDir: string | undefined;
	/** The router claim, taken at a run's start and released at its end. The router carries ONE
	 *  resident lane, ONE live-turn ledger and ONE flip guard, so a second orchestrator on the same
	 *  router is not a concurrency question but a correctness one: each one's pre-swap gate ends up
	 *  judging the other's working tree. */
	let lockDir: string | undefined;
	/** The supervisor lane lease held by THIS run: the token is the write capability
	 *  (in-process only, never rendered); the session id is the run id the daemon
	 *  attributes the lease to. LEASE_TTL_S is the ask; the daemon clamps to its max. */
	let leaseToken: string | undefined;
	let leaseSession = "";
	/** The capability a NON-RUN move minted (a verification/escalation turn, the panel). Held
	 *  across the turn it protects and returned at hand-back/shutdown — releasing inside the
	 *  load left the lane free before the review ran (measured 2026-11-25). */
	let verifyLeaseToken: string | undefined;
	let verifyLeaseSession = "";
	let verifyLeaseRemainingS = 0;
	/** The single-turn mint: a load that carries no run lease (the overlay keys, the
	 *  hand-back, a review/escalation turn) acquires for the length of ONE pack load plus
	 *  slack and releases it in the same call (`loadLane`'s `finally`). The daemon clamps
	 *  the ask to its ceiling; the release is the guarantee, the TTL is the backstop for a
	 *  caller that dies mid-swap. */
	const LEASE_MINT_TTL_S = Number(process.env.FADE_ORCHESTRATE_LEASE_MINT_TTL_S ?? 300);
	/** The lease identity of a turn that belongs to no run: the daemon names the holder
	 *  session on a refusal, and an empty string there is a lease nobody can trace. */
	const SELF_SESSION = `omp-pid-${process.pid}`;
	const LEASE_TTL_S = Number(process.env.FADE_ORCHESTRATE_LEASE_TTL_S ?? 1800);
	/** The lease's remaining seconds AS THE DAEMON PUBLISHED THEM (the grant/renew
	 *  answer's `remaining_sec`), decremented by the tick between renewals. It gates
	 *  the renew so a 30 s poll over a 1800 s TTL is not 60 round trips and 60
	 *  `decision=RENEWED` journal lines per hour. The daemon's own expiry stays the
	 *  authority: this number can only make the client renew SOONER than the lease
	 *  dies, never later. */
	let leaseRemainingS = 0;
	let pending: { lane: string; phase: string } | undefined;
	/** The desk batch this session CLAIMED and is answering. The claim is the one-use ticket: it is
	 *  what makes `fade_verdicts` legal for those ids, and what stops the same batch being answered
	 *  a second time. `undefined` when no batch is in flight. */
	let deskBatch: { batch: number; ids: string[]; routed: "swap" | "subagent" } | undefined;
	/** The epoch the queue was already announced with: one notify per batch, not one per tick. */
	let deskAnnounced = -1;
	/** Set by the desk dispatch when the batch's answer is a lane load: it is what makes the NEXT
	 *  landing on the thinking lane print the BATCH page instead of the round's own verify page. */
	let deskBriefing = false;
	let settledNotified = false;
	let metrics: MetricsSnapshot | undefined;
	let laneBest = 0;
	let metricsTimer: NodeJS.Timeout | undefined;
	/** The raw-input listener that owns the panel chord, its open flag, and the chord's disclosure. */
	let inputUnsub: (() => void) | undefined;
	let panelOpen = false;
	let conflictReported = false;
	/** The chord is settled only when a LIVE probe says so; `probeHasAnswered` distinguishes a real
	 *  "free" from the loading-phase probe that threw — the host dispatches `session_start` during
	 *  extension loading, where the probe throws. */
	let chordResolved = false;
	let probeHasAnswered = false;
	let turnSeq = 0;
	let turnPhase: string | undefined;
	let turnSwapMs = 0;
	/** The active-tool set captured when the verifier sandbox closed; restored when the code lane loads. */
	let verifierTools: string[] | undefined;
	/** The lane churn the flip guard observed, as the surfaces render it. `undefined` when the
	 *  window is quiet, so a healthy run never advertises a flip. */
	let flipBadge: FlipBadge | undefined;
	/** The lane the router is loading RIGHT NOW, as the status row renders it. Set by `runSwitch`
	 *  for the loop's own swap and refreshed from the swap watch's /health samples, so the row is
	 *  multicolored only while a pack is actually coming in; cleared the moment it lands. */
	let swapPill: SwapPill | undefined;

	const refreshMetrics = async (): Promise<void> => {
		// The lease outlives one turn; renew it on the tick (TTL 1800 s vs a 30 s
		// tick) so a planning/frontier run never loses the lane mid-phase.
		void renewLaneLease();
		const s = await fetchMetrics();
		if (!s) return;
		metrics = s;
		if (runDir) await persistMetrics(runDir, s);
		if (run) {
			const b = laneBestRate(s, run.lane);
			if (b && b > laneBest) laneBest = b;
		}
	};
	const stopMetricsTimer = (): void => {
		if (metricsTimer !== undefined) {
			clearInterval(metricsTimer);
			metricsTimer = undefined;
		}
	};
	// The metrics tick is also the flip watcher's poll, so its cadence is configuration: the host
	// default is 30 s; the rigs drive 2 s to watch a whole guard window in seconds.
	const METRICS_INTERVAL_MS = Math.max(250, Number(process.env.FADE_ORCHESTRATE_METRICS_INTERVAL_MS ?? 30_000));
	const startMetricsTimer = (): void => {
		stopMetricsTimer();
		metricsTimer = setInterval(() => {
			void refreshMetrics();
			void watchFlips();
		}, METRICS_INTERVAL_MS);
		// The tick is bookkeeping, not a reason to keep the process alive: the host keeps
		// the TUI open, and a test runner must not sit on an open handle to its cap.
		metricsTimer.unref?.();
		void refreshMetrics();
		void watchFlips();
	};
	/**
	 * Read the router's swap line, then answer the guard question for the lane THIS RUN
	 * holds — not the router's transient resident entry, which mid-swap names the lane being
	 * unloaded and would read the loop's own swap as a flip. The watch is read-only: the churn
	 * belongs to another client, so the loop pays nothing for it and only names it.
	 */
	const watchFlips = async (): Promise<void> => {
		await observeSwaps();
		const f = flipState(run?.lane, FLIP_WINDOW_MS);
		const next = flipGuarded(f) ? { flips: f.flips, window_s: f.window_s, competing: f.competing } : undefined;
		if ((next?.flips ?? 0) === (flipBadge?.flips ?? 0)) return;
		flipBadge = next;
	};
	// The ramp reads cold (a fresh pack decodes well under its steady rate), a loaded lane reads
	// hot; idle reads as nothing.
	const pillSuffix = (): string | undefined => {
		if (!metrics) return undefined;
		const ch = coldHot(metrics.tok_s, laneBest);
		if (ch.label === "idle" || ch.rate === undefined) return undefined;
		return `${ch.label} ${Math.round(ch.rate)}t/s`;
	};

	// One durable JSONL line per turn, built ONLY from numbers the router reported —
	// `turnRecordOrNull` returns undefined without a numeric pp AND tg, so a closed router appends
	// nothing and the ledger never carries a fabricated zero.
	const recordTurn = async (outcome: string): Promise<void> => {
		if (!run || !runDir) return;
		const m = await fetchTurnMetrics();
		const rec = turnRecordOrNull(m, {
			run_id: run.run_id,
			turn: ++turnSeq,
			round: run.round,
			swap_ms: turnSwapMs,
			round_outcome: outcome,
			...(turnPhase !== undefined ? { phase: turnPhase } : {}),
		});
		turnPhase = undefined;
		turnSwapMs = 0;
		if (rec) await appendTurn(runDir, rec);
	};

	// The thinking lane's tool set: setActiveTools removes the mutating tools on entry to the
	// verifier lane and restores the captured set when the code lane loads; the `tool_call` hook
	// is the enforcement layer for anything that still tries.
	const applyToolPolicy = async (lane: string): Promise<void> => {
		const active = pi.getActiveTools();
		if (isThinkingLane(lane)) {
			verifierTools = active;
			const readOnly = active.filter((t) => MUTATING_TOOLS[t] !== true && t !== "fade_phase");
			readOnly.push("fade_phase");
			// CONTENTS, not length: the verifier set removes the writers and adds `fade_phase`,
			// and at equal length a length test is a silent no-op — edit stays live and the
			// phase tool never lands, measured with [read, bash, edit, task].
			const was = new Set(active);
			if (readOnly.length !== was.size || readOnly.some((t) => !was.has(t))) await pi.setActiveTools(readOnly);
			return;
		}
		if (verifierTools && verifierTools.length > 0) {
			if (verifierTools.some((t) => !active.includes(t))) await pi.setActiveTools(verifierTools);
			verifierTools = undefined;
		}
	};

	/**
	 * registerTool() puts fade_phase in the registry (/tools lists it) but
	 * NOT in the active set the model is offered, so every phase briefing must activate it first.
	 *
	 * The action methods are GUARDED during extension loading — omp 18.20.2 throws
	 * "Extension runtime not initialized. Action methods cannot be called during extension
	 * loading." — and the host can dispatch `session_start` before it installs the runtime. That
	 * throw disables the WHOLE extension (every hook, command and tool behind
	 * failed behind `Warning: Failed to load extension …/fade_orchestrate.ts`). So this call is
	 * defensive and answers a boolean; `agent_start` runs it again, and by the first turn the
	 * runtime is live — the only moment the tool has to exist.
	 */
	const ensurePhaseTool = async (): Promise<boolean> => {
		try {
			const active = pi.getActiveTools();
			if (active.includes("fade_phase")) return true;
			await pi.setActiveTools([...active, "fade_phase"]);
			return true;
		} catch {
			return false;
		}
	};

	const statePath = (): string => (runDir ? join(runDir, STATE_FILENAME) : "<unset>");
	/**
	 * The state write, COALESCED (`coalesceWrite`): ONE write in flight per path, and a newer
	 * payload REPLACES the pending one — so a phase boundary that persists three times (the phase,
	 * the rejection, the lane) pays ONE write carrying the LAST state, not three. Every step of
	 * each write is `fs.promises` (tmp → fdatasync → rename → directory sync), which is what kills
	 * the freeze: the fsync pair used to run inside the panel's refresh tick and inside every phase
	 * transition, on the TUI's own loop, and the host stopped painting for the length of it.
	 *
	 * It also carries the OPERATOR SURFACE: `checks` and `repo` are the two fields the operator is
	 * documented to repair on disk (a run rooted at the wrong repo, a check that is not a command),
	 * and the loop must SEE that repair at its very next write — a repair the loop never adopts is
	 * erased by that write, which is how a re-rooted, repaired `state.json` came back red six
	 * rounds running.
	 */
	/** The mtime of the last record THIS loop published, microseconds. Adoption is judged against
	 *  it: a file NEWER than the loop's own publish was written by someone else and is adopted; a
	 *  file older is the loop's own last publish, or a file seeded BEFORE a phase declared its own
	 *  checks — and reverting to that erases the declaration. An unguarded sync does exactly that
	 *  to `planning_done`'s checks and to the plan act's, measured on the rig: the gate then runs
	 *  ZERO checks, pays no swap judgement, and the run reports green on a gate that never fired. */
	let publishedAtUs = 0;
	const syncFromDisk = async (): Promise<boolean> => {
		if (!run || !runDir) return false;
		let mtimeUs = 0;
		try {
			mtimeUs = Math.round((await stat(statePath())).mtimeMs * 1000);
		} catch {
			return false; // no file: nothing to adopt; the publish below creates it
		}
		if (publishedAtUs === 0 || mtimeUs <= publishedAtUs) return false;
		const live = await liveState();
		if (!live || live.run_id !== run.run_id) return false;
		const checks = refreshChecks(run, live);
		const root = await refreshRoot(run, live);
		if (!checks.changed && !root.changed) return false;
		// Journal it, never silent: the panel and the phase log are where the operator reads what
		// the loop decided, and a repair that changes the gate's rows changes every later verdict.
		(run.phases ??= []).push({
			phase: "disk_repair",
			lane: run.lane,
			accepted: true,
			round: run.round,
			at: new Date().toISOString(),
			notes: `adopted from disk: checks ${checks.to} rows${checks.added.length ? ` (+${checks.added.join(",")})` : ""}${checks.removed.length ? ` (-${checks.removed.length})` : ""}${checks.redrafted ? ` redrafted ${checks.redrafted}` : ""}${root.changed ? `; repo -> ${root.to}` : root.refused ? `; repo refused: ${root.refused}` : ""}`,
		});
		return true;
	};
	const persist = async (): Promise<void> => {
		if (!run || !runDir) return;
		await syncFromDisk();
		await coalesceWrite(statePath(), run);
		try {
			publishedAtUs = Math.round((await stat(statePath())).mtimeMs * 1000);
		} catch {
			publishedAtUs = 0; // unmeasurable: the next write re-reads, which is the safe direction
		}
	};

	/**
	 * A fire-and-forget durable write must never reach the host as an unhandled rejection. The state
	 * directory is the operator's: a janitor, an `rm -rf var/` or the gate rig's reset can remove it
	 * mid-run, and the write that lands after the wipe used to take the rig down. Say the class ONCE
	 * per process and drop the identical repeats; the in-memory run stays authoritative for the loop.
	 */
	let lastWriteWarn = "";
	const warnWrite = (ctx: ExtensionContext, what: string) => (e: unknown): void => {
		const msg = `${what}: ${e instanceof Error ? e.message : String(e)}`;
		if (msg === lastWriteWarn) return;
		lastWriteWarn = msg;
		ctx.ui.notify(`orchestrate: the state write failed — ${msg}`, "warning");
	};

	/** Release the router claim. `releaseInstanceLock` is owner-only, so a run adopted from disk (a
	 *  session that resumed a run its pid never started) has nothing to release and never deletes the
	 *  live owner's file. */
	const releaseLock = (): void => {
		if (!lockDir) return;
		releaseInstanceLock(lockDir);
		lockDir = undefined;
	};
	/** Return the verify capability: the hand-back landed, or the session is closing. A
	 *  failure is logged, never swallowed — an unreleased lease pins the lane for its TTL. */
	const returnVerifyLease = async (): Promise<void> => {
		const tok = verifyLeaseToken;
		const sid = verifyLeaseSession || SELF_SESSION;
		verifyLeaseToken = undefined;
		verifyLeaseRemainingS = 0;
		verifyLeaseSession = "";
		if (!tok) return;
		// The mint started the tick (see `requestLane`); the capability is gone, so the clock goes
		// with it -- a plain session that handed the lane back must not keep polling the router.
		if (!run && !leaseToken) stopMetricsTimer();
		try {
			const v = await releaseLease(tok, sid);
			if (!v.ok) process.stderr.write(`orchestrate: verify lease release refused (${v.rule || v.status}); it expires on its TTL
`);
		} catch (e) {
			process.stderr.write(`orchestrate: verify lease release failed: ${msg(e)}; it expires on its TTL
`);
		}
	};
	/** Return the supervisor lane lease ("return the coder"). Best-effort: a dead
	 *  daemon must never take a run's end down. Clears the in-process token either
	 *  way, so a resumed run never re-releases a stale one. */
	const releaseLaneLease = (): void => {
		const tok = leaseToken;
		const sid = leaseSession;
		leaseToken = undefined;
		leaseRemainingS = 0;
		// The session the lease was attributed to goes with the token: a mint by a turn that
		// belongs to no run must present its own identity, not a finished run's id.
		leaseSession = "";
		if (run) run.lease_state = "released";
		if (!tok) return;
		void releaseLease(tok, sid)
			.then((v) => {
				if (run) run.lease_hint = v.token_hint ?? run.lease_hint;
			})
			.catch(() => undefined);
	};
	/** Acquire the lane lease as the prod authority. Granted → the run may swap
	 *  under the minted token. Not granted (a peer holds it via 409 lease_not_holder,
	 *  a stale token, or the daemon is unreachable) → the run has no lane authority
	 *  and is refused at the start, so a second orchestration serializes behind the
	 *  holder. The token is the write capability: it lives in the closure and the
	 *  run state, never in any rendered line. */
	const acquireLaneLease = async (lane: string, runId: string, ctx: ExtensionContext): Promise<{ ok: boolean; line: string }> => {
		leaseSession = runId;
		try {
			const v = await acquireLease(lane, LEASE_TTL_S, runId);
			if (run) {
				run.lease_holder = v.holder;
				run.lease_hint = v.token_hint;
			}
			if (v.ok && v.token) {
				leaseToken = v.token;
				leaseRemainingS = v.remaining_s ?? v.granted_ttl_s ?? LEASE_TTL_S;
				if (run) {
					run.lease_state = "held";
					run.lease_token = v.token;
					run.lease_granted_ttl_s = v.granted_ttl_s;
				}
				return { ok: true, line: leaseLine(v) };
			}
			if (run) run.lease_state = v.rule === RULE_LEASE_STALE_TOKEN ? "refused" : "deferred";
			return { ok: false, line: leaseLine(v) };
		} catch (e) {
			if (run) run.lease_state = "refused";
			return { ok: false, line: `supervisor lease unreachable: ${msg(e)}` };
		}
	};
	/** Renew the held lease on the metrics tick so a long run never drops its
	 *  authority mid-flight. A stale/lost lease clears the token, so the run stops
	 *  swapping the lane it no longer owns. */
	const renewLaneLease = async (): Promise<void> => {
		// The verify capability gets the same gate on the same tick: a review turn can outlive a
		// short mint TTL, and a lease that expires mid-review hands the lane to the next peer.
		if (verifyLeaseToken && shouldRenew(verifyLeaseRemainingS, LEASE_MINT_TTL_S)) {
			try {
				const v = await renewLease(verifyLeaseToken, LEASE_MINT_TTL_S, verifyLeaseSession || SELF_SESSION);
				verifyLeaseRemainingS = v.remaining_s ?? v.granted_ttl_s ?? LEASE_MINT_TTL_S;
				if (v.rule === RULE_LEASE_STALE_TOKEN || v.rule === RULE_LEASE_NOT_HOLDER) verifyLeaseToken = undefined;
			} catch {
				/* keep it: the TTL is the backstop and the next tick retries */
			}
		} else if (verifyLeaseToken) {
			verifyLeaseRemainingS = Math.max(0, verifyLeaseRemainingS - METRICS_INTERVAL_MS / 1000);
		}
		if (!leaseToken) return;
		if (!shouldRenew(leaseRemainingS, LEASE_TTL_S)) {
			// The lease is running down, not running out: age the published countdown by
			// the tick and pay nothing. The metrics tick is the clock here, and it is the
			// same tick that reads the router, so the gate adds no timer.
			leaseRemainingS = Math.max(0, leaseRemainingS - METRICS_INTERVAL_MS / 1000);
			return;
		}
		try {
			const v = await renewLease(leaseToken, LEASE_TTL_S, leaseSession);
			if (run) run.lease_hint = v.token_hint ?? run.lease_hint;
			leaseRemainingS = v.remaining_s ?? v.granted_ttl_s ?? LEASE_TTL_S;
			if (v.rule === RULE_LEASE_STALE_TOKEN || v.rule === RULE_LEASE_NOT_HOLDER) leaseToken = undefined;
		} catch {
			// A daemon that drops mid-run: keep the token. The swap path names the
			// daemon being unreachable, and TTL expiry is the backstop for a run that
			// dies outright, so a transient blip never silently strands the lane.
		}
	};

	/**
	 * The ON-DISK run, for the verifier sandbox, which asks on EVERY tool call. `readFileSync` +
	 * `JSON.parse` there parsed the whole state per call, on the host's loop. The file's
	 * `(mtimeMs, ctimeMs, size)` stamp is the guard: unchanged, the last parse IS the live state,
	 * so a steady run pays one `stat` per tool call. The writer is this session's own coalescing
	 * persist, so the stamp moves exactly when the record changes.
	 */
	let liveCache: { key: string; state: RunState | undefined } | undefined;
	const liveState = async (): Promise<RunState | undefined> => {
		if (!runDir) return undefined;
		const path = join(runDir, STATE_FILENAME);
		try {
			const s = await stat(path);
			const key = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
			if (liveCache && liveCache.key === key) return liveCache.state;
			const state = parseJson<RunState>(await readFile(path, "utf8"));
			liveCache = { key, state };
			return state;
		} catch {
			liveCache = undefined;
			return undefined;
		}
	};

	/** The gate's checks AND its root are DATA: read the file, so an on-disk repair reaches the
	 *  run object. Without this the gate is unrepairable in a live session — `state.json` can
	 *  carry fixed commands, or a corrected `repo`, while the session re-judges the plan's
	 *  original rows at the original root, every round. Both refreshes are announced. */
	const gateChecks = async (ctx: ExtensionContext): Promise<void> => {
		if (!run) return;
		const live = await liveState();
		const r = refreshChecks(run, live);
		if (r.changed) ctx.ui.notify(`orchestrate: the pre-swap gate re-read the checks from ${statePath()} — ${r.removed.length} replaced, ${r.added.length} added, ${r.redrafted} re-declared, ${r.to} total`, "info");
		const root = await refreshRoot(run, live);
		if (root.changed) ctx.ui.notify(`orchestrate: the pre-swap gate re-rooted the run — ${root.to} (was ${root.from})`, "info");
		if (root.refused) ctx.ui.notify(`orchestrate: ${statePath()} asked to re-root the run — refused: ${root.refused}`, "warning");
		// A refresh that TOOK must become the loop's own record, in the same tick. Every other
		// persist writes the whole in-memory run — the panel's refresh tick, the briefing sends —
		// so a repaired `checks`/`repo` left unwritten here is overwritten by the next paint, and
		// the gate then judges the pre-repair rows at the pre-repair root. Measured live: a
		// re-root plus a re-declared row read back present 20 s before the gate, and the gate ran
		// the old rows at the old root; the file carried the loop's write, not the repair. The
		// write is safe in the original root because `runDir` is fixed at activation, so a
		// re-rooted run keeps ONE durable record where the loop reads it.
		if (r.changed || root.changed) await persist();
	};

	/**
	 * The gate, awaited off the event loop, with the row named AS IT STARTS. The synchronous form
	 * froze the whole host for the gate's duration — no paint, dead keystrokes, starved swap
	 * watch — so the operator saw a terminal that had stopped. Here the working message carries
	 * `gate 3/7: npm test`, the panel keeps refreshing, and the verdict's cost is said out loud.
	 */
	const runGateLogged = async (checks: [string, string][], repo: string, ctx: ExtensionContext): Promise<GateResult> => {
		const t0 = Date.now();
		const gate = await runGate(checks, repo, (row) => ctx.ui.setWorkingMessage(`fade_orchestrate: gate ${row.index}/${row.total}: ${row.cmd}`));
		ctx.ui.setWorkingMessage();
		const s = ((Date.now() - t0) / 1000).toFixed(1);
		const failing = gate.results.filter((r) => !r.ok);
		const unmeasured = gate.results.filter((r) => r.budget === true).length;
		ctx.ui.notify(
			`fade_orchestrate: gate ${gate.passed ? "GREEN" : `RED ${failing.length}/${gate.results.length}`} in ${s}s${failing.length > 0 ? ` — ${failing.map((f) => f.cmd).join(" | ")}` : ""}${unmeasured > 0 ? ` — ${unmeasured} row(s) NEVER RAN (gate total budget)` : ""}`,
			gate.passed ? "info" : "warning",
		);
		return gate;
	};

	/** The diff the fast path prices — changed paths and changed lines in the working tree vs
	 *  HEAD, with untracked files counted as paths. `files: -1` names a tree git cannot speak
	 *  for, which is never fast-path eligible. ASYNC, and the two calls run TOGETHER: the sync pair
	 *  sat on the `coding_done` return path and held the paint loop for both spawns. The bounds are
	 *  `execGitAsync`'s (5 s, 1 MiB), the same ones the sync form carried. */
	const fastPathDiff = async (repo: string): Promise<{ files: number; lines: number }> => {
		try {
			const [numstat, untracked] = await Promise.all([
				execGitAsync(repo, ["diff", "--numstat", "HEAD"]),
				execGitAsync(repo, ["ls-files", "--others", "--exclude-standard"]),
			]);
			let lines = 0;
			let files = 0;
			for (const row of numstat.split("\n")) {
				if (row.trim() === "") continue;
				const [add, del] = row.split("\t");
				files += 1;
				lines += (add === "-" ? 0 : Number(add) || 0) + (del === "-" ? 0 : Number(del) || 0);
			}
			files += untracked.split("\n").filter((s) => s.trim() !== "").length;
			return { files, lines };
		} catch {
			return { files: -1, lines: -1 };
		}
	};

	/** True once THIS process has written the status-bar row (the opt-in surface). The widget
	 *  surface never touches `setStatus` at all — proved by `test/rpc_rig.mjs`: the default
	 *  surface is the top widget, and a clear-only call there is an API touch the contract
	 *  forbids. */
	let statusWritten = false;
	/**
	 * Clear BOTH surfaces. A run not in use leaves nothing on screen, and the surface that is
	 * configured is not the only one that can hold a stale row — a run that ran with
	 * `FADE_ORCHESTRATE_SURFACE=status` earlier in this process must have its bar row removed.
	 */
	const clearSurface = (ctx: ExtensionContext): void => {
		ctx.ui.setWidget(TOP_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		if (statusWritten) {
			statusWritten = false;
			ctx.ui.setStatus(ORCH_STATUS_KEY, undefined);
		}
	};

	const paint = (ctx: ExtensionContext): void => {
		if (!run) {
			clearSurface(ctx);
			ctx.ui.setWidget(OVERLAY_WIDGET_KEY, undefined);
			return;
		}
		// ONE status row, and ONLY while a run is in use. `statusLines` answers `undefined` for no
		// run, for a terminal run (including a run adopted from disk at session_start) and for a
		// run this session does not own, and every one of those CLEARS the surface. The default
		// surface is the top widget: the host prints `setStatus` text in the `status` segment
		// wherever the USER's `statusLine` config placed it, and an extension cannot add or move
		// a status-line segment, so the row — not the bar — is what the loop can own.
		// `FADE_ORCHESTRATE_SURFACE=status` opts into the status bar for a config that placed the
		// `status` segment right after the model. The detail view stays the panel, and the row's
		// key hint is the configured chord's label, so the row never advertises a key it does not
		// honor.
		const lines = statusLines(run, { suffix: pillSuffix(), flip: flipBadge, owned: !isDelegatedSession(), swap: swapPill, key: keyLabel(DELIVERED_KEY) });
		if (!lines) {
			clearSurface(ctx);
			return;
		}
		if (SURFACE === "status") {
			statusWritten = true;
			ctx.ui.setStatus(ORCH_STATUS_KEY, lines.map((l) => l.trim()).join(" · "));
		} else ctx.ui.setWidget(TOP_WIDGET_KEY, lines, { placement: "aboveEditor" });
	};

	const fail = (ctx: ExtensionContext, reason: string): void => {
		if (run) {
			run.state = "failed";
			run.reason = reason;
			releaseLock();
			releaseLaneLease();
			void returnVerifyLease();
			void persist().catch(warnWrite(ctx, "fail"));
			paint(ctx);
		}
		ctx.ui.notify(`fade_orchestrate: ${reason}`, "error");
	};

	/**
	 * Hold the lane load while the router is SERVING, and say so out loud. `runSwitch` calls
	 * this BEFORE `setModel`/`loadLane`: a model switch issued into a lane that is still serving
	 * queues the request the router answers by swapping BACK. The gate is bounded
	 * (GATE_POLL_MS/GATE_BUDGET_MS) and visible — the first busy poll notifies, every poll
	 * refreshes the working message with the elapsed budget and the counters the router reported.
	 * It is a DEFERRAL, not a refusal: the caller keeps `pending` set, so the owed lane survives
	 * the whole wait. `over_budget` (busy for the full budget) pays the load anyway — a loop
	 * that never lands its lane is a stalled run — and the call site records that decision in
	 * `rejection_history`.
	 */
	// The gate is the router module question with the UI effects injected: the
	// residency answer can clear it at zero cost, and the suite counts the polls
	// and the DEFERRED notify.
	const gateRouterIdle = (lane: string, ctx: ExtensionContext): Promise<IdleGateResult> =>
		gateLaneIdle(lane, {
			busy: routerBusy,
			residency: () => supervisorResident(lane, leaseSession || SELF_SESSION),
			deferred: (m: string) => ctx.ui.notify(m, "warning"),
			progress: (m: string) => ctx.ui.setWorkingMessage(m),
			budgetMs: GATE_BUDGET_MS,
			pollMs: GATE_POLL_MS,
		});

	// The lane switch as one callable unit: `agent_end` (the single load site) and the overlay's
	// v/c keys run the SAME sequence — the idle gate, the thrash breaker, the settle-then-load
	// router call, then the pin + thinking + policy + briefing IN ONE ACT, persisted and painted.
	// queued-request window exists while a slash command runs, so calling it from a command is the
	// same boundary discipline.
	/**
	 * ONE switch at a time. `agent_end`, the panel's v/c keys and a pause-resume can each want a
	 * lane, and two switches running at once is exactly the ping-pong this file exists to stop:
	 * load + `setModel` issued twice, `pending` overwritten by the later request, the
	 * swap pill painted by a watch whose switch is already dead, and a briefing sent for a lane a
	 * newer switch has replaced. Every caller goes through `requestLane`: requests queue on
	 * `switchChain` in arrival order and carry a generation, and a link the chain reaches after a
	 * newer request arrived (`gen !== switchGen`) does NOTHING — it never touches the router.
	 */
	let switchGen = 0;
	let switchChain: Promise<void> = Promise.resolve();
	/** The lane an in-flight `runSwitch` is landing. Auto-sync reads this so a drain does not pin
	 *  the pack that is still resident while the owed pack is coming in. Cleared when that
	 *  generation finishes; a superseded switch leaves it for the generation that replaced it. */
	let switchingTo: string | undefined;
	const requestLane = (lane: string, ctx: ExtensionContext, quiet = false, handBack = false): void => {
		const gen = ++switchGen;
		// A switch that dies must SAY so: this catch used to be `() => undefined`, and a defect in
		// the tail of `runSwitch` (the briefing, the tool policy) therefore showed up as a lane that
		// pinned and went silent — no notify, no note, nothing in the record. The chain still
		// survives, because one dead switch must not stop the loop, but its cause is now on the wire.
		switchChain = switchChain
			.then(() => (gen === switchGen ? runSwitch(lane, ctx, gen, quiet, handBack) : undefined))
			.catch((e) => {
				ctx.ui.notify(`fade_orchestrate: the ${lane} switch failed: ${msg(e)} — the lane it was owed did NOT land`, "error");
			});
	};

	/**
	 * The desk dispatch, at the turn boundary: is there a CLOSED batch to answer?
	 *
	 * This is the batching rule in force. A batch that has not closed answers `not ready` and pays
	 * NOTHING — that is the clause that stops one arrival starting a lane load while the other two
	 * workers of the same `task` call are still unregistered. A closed batch is claimed once, and
	 * the claim decides the route:
	 *
	 * - `swap`: ONE verifier-lane load for the WHOLE batch. The round moves to `verifying`, the
	 *   lane's briefing is the batch page (every request, by id), and its `fade_verdicts` call
	 *   unblocks every worker at once.
	 * - `subagent`: churn is in force, so NO lane is loaded. The batch is handed to the
	 *   `fade-verifier` agent on a non-router model, which costs zero swaps, and the loop is told
	 *   the exact call to make — not offered a choice, because continuing to pay loads into a
	 *   churning window is the failure mode the operator named.
	 *
	 * Returns true when the batch was claimed, so the caller stops its own turn-end handling: the
	 * batch is the work the boundary owes, ahead of a protocol nudge.
	 */
	const dispatchDeskBatch = async (ctx: ExtensionContext): Promise<boolean> => {
		if (!run || !runDir || TERMINAL[run.state] === true) return false;
		const desk = await readDesk(runDir, run.run_id);
		if (!desk) return false;
		const live = openRequests(desk);
		if (live.length === 0) return false;
		const ready = readyToAddress(desk, Date.now(), { settleMs: DESK_SETTLE_MS, deadlineMs: DESK_DEADLINE_MS });
		if (!ready.ready) {
			if (deskAnnounced !== desk.epoch) {
				deskAnnounced = desk.epoch;
				ctx.ui.notify(`orchestrate: the verification desk holds ${ready.open} request(s) — ${ready.reason}; no lane is loaded until the batch closes`, "info");
			}
			return false;
		}
		await observeSwaps();
		let route: RouteDecision = routeFor(desk, flipState(run.lane, FLIP_WINDOW_MS));
		// THE CLAIM-TIME LANE GUARD. A claimed batch has NO reclaim path: `claimBatch` stamps every
		// live request (desk.ts:264), `openRequests` drops stamped requests from the live set
		// (desk.ts:214), and nothing clears the stamp. So handing a batch to a verifier lane that
		// cannot answer does not stall it — the batch becomes permanently OWED, every worker in it
		// exits `fade_verify` deferred at DESK_WAIT_MS, and a worker that re-registers its objective
		// adds a FRESH owed request (desk.ts:285 dedupes only UNCLAIMED ones). The zero-swap route is
		// therefore taken only on PROOF: one 1-token completion, through the lane's own auth path,
		// cached for PROBE_CACHE_MS. Refusing it buys the only recovery that exists — the swap route,
		// which the loop already knows how to pay for and retry.
		if (route.route === "subagent") {
			const probe = await probeVerifierLane();
			run.lane_probe = { ok: probe.ok, detail: probe.detail, at: new Date().toISOString(), ms: probe.ms, skipped: probe.skipped };
			if (!probe.ok && probe.skipped !== true) {
				route = { route: "swap", reason: `the ${VERIFIER_MODEL} verifier lane failed its claim-time probe: ${probe.detail}`, flips: route.flips };
				pushRejection(run, "task", `the zero-swap subagent verification route was REFUSED before the claim: ${probeLabel(probe)}. A claimed batch cannot be reclaimed (desk.ts:214), so an unproven lane leaves the batch owed for the whole run; paid the ${VERIFY_LANE} swap instead, the route with recovery`);
				ctx.ui.notify(`orchestrate: verifier lane UNPROVEN — ${probeLabel(probe)}; the batch goes to one ${VERIFY_LANE} swap, not the zero-swap subagent route`, "warning");
			}
		}
		const claimed = claimBatch(desk, route.route);
		const requests = desk.requests.filter((r) => claimed.ids.includes(r.id));
		deskBatch = { batch: claimed.batch, ids: claimed.ids, routed: route.route };
		run.verify_batch = { batch: claimed.batch, ids: claimed.ids, routed: route.route, at: new Date().toISOString() };
		pushRejection(run, "task", `verification batch ${claimed.batch + 1} (${claimed.ids.join(", ")}) addressed AT ONCE, routed ${route.route}: ${route.reason}`);
		if (route.route === "subagent") {
			await writeJsonAsync(deskPath(runDir), setChurn(claimed.desk, true));
			await persist();
			paint(ctx);
			ctx.ui.notify(`orchestrate: verification batch ${claimed.batch + 1} · ${claimed.ids.length} worker request(s) → ${routeLine(route)}`, "warning");
			await ensurePhaseTool();
			pi.sendUserMessage(verifierDirective(claimed.batch, claimed.ids, route.reason, requests));
			return true;
		}
		await writeJsonAsync(deskPath(runDir), claimed.desk);
		run.state = "verifying";
		pending = { lane: VERIFY_LANE, phase: "verification_batch" };
		deskBriefing = true;
		settledNotified = false;
		await persist();
		paint(ctx);
		ctx.ui.notify(`orchestrate: ${deskLine(desk)} — one ${VERIFY_LANE} load answers the whole batch`, "info");
		requestLane(VERIFY_LANE, ctx);
		return true;
	};

	/**
	 * The OWED audit, run the moment a run reaches `complete`. A request claimed by a verification
	 * pass that never answered is permanent (nothing re-opens a claimed batch), so a run that ends
	 * with owed requests is NOT green: the slices behind them were never verified. It is recorded in
	 * `rejection_history`, said out loud at error severity, and appended to the tool's own answer, so
	 * the lane cannot report success over it without reading the sentence.
	 */
	const auditOwedOnComplete = async (st: RunState, ctx: ExtensionContext): Promise<string> => {
		if (!runDir) return "";
		const d = await readDesk(runDir, st.run_id);
		if (!d) return "";
		const owed = owedRequests(d);
		if (owed.length === 0) return "";
		const ids = owed.map((r) => r.id).join(", ");
		pushRejection(st, "task", `the run completed with ${owed.length} verification request(s) CLAIMED and NEVER judged: ${ids} — a claimed batch has no reclaim path (desk.ts:214), so the slices behind them are unverified`);
		ctx.ui.notify(`orchestrate: run COMPLETE with ${owed.length} OWED verification request(s): ${ids} — treat those slices as unverified`, "error");
		return `; OWED ${owed.length} unjudged verification request(s): ${ids} — those slices are UNVERIFIED`;
	};

	const runSwitch = async (lane: string, ctx: ExtensionContext, gen: number, quiet = false, handBack = false): Promise<void> => {
		switchingTo = lane;
		try {
			await runSwitchBody(lane, ctx, gen, quiet, handBack);
		} finally {
			if (gen === switchGen) switchingTo = undefined;
		}
	};

	const runSwitchBody = async (lane: string, ctx: ExtensionContext, gen: number, quiet = false, handBack = false): Promise<void> => {
		const model = ctx.modelRegistry.find(PROVIDER, lane);
		if (!model) {
			fail(ctx, `model ${PROVIDER}/${lane} is not in the registry`);
			return;
		}
		// The pre-unload idle gate FIRST, before a byte is sent: a switch issued into a lane that
		// is still SERVING queues the request the router answers by swapping BACK. The gate is a
		// DEFERRAL — the caller keeps `pending`, so the owed lane survives the whole wait — and an
		// over-budget wait pays the load anyway, because a loop that never lands its lane is a
		// stalled run. That decision is written into `rejection_history`, not just notified.
		const plan = switchPlan(await residentLane(), lane);
		if (!plan.load) ctx.ui.notify(`fade_orchestrate: ${plan.reason}`, "info");
		const gate: { waited_ms: number; polls: number; over_budget: boolean; last: RouterBusy } = plan.gate
			? await gateRouterIdle(lane, ctx)
			: { waited_ms: 0, polls: 0, over_budget: false, last: { busy: false, reason: plan.reason } };
		if (gate.over_budget && run) {
			pushRejection(run, "task", `the ${lane} load was paid after the idle gate ran its full ${Math.round(GATE_BUDGET_MS / 1000)}s: ${gate.polls} polls, ${gate.last.reason}`);
			await persist();
		}
		// THE THRASH BREAKER. Refusing to reload the resident entry and printing a badge leave the
		// loop paying 13-25 s and 52-130 GiB every time a competing client names the other entry.
		// Past `FLIP_BREAKER_AT` swaps away from the run's lane the load IS the flip-flop, so
		// NOTHING is sent: no setModel, no `POST /v1/load`. The loop halts, the lane stays owed in
		// `pending`, and the notify names the one command that clears the ledger and lands it.
		await observeSwaps();
		const flip = flipState(run?.lane ?? lane, FLIP_WINDOW_MS);
		if (flipBreaker(flip)) {
			const who = flip.competing.join(", ") || "the other lane";
			if (run) {
				run.paused = true;
				run.operator_note = `lane thrash: ${flip.flips} swaps in ${flip.window_s}s naming ${who}; the loop is HALTED and paid no ${lane} load — /orchestrate lanes reset clears the ledger and lands it`;
				pushRejection(run, "task", `LANE THRASH: ${flip.flips} swaps in ${flip.window_s}s naming ${who}; ${lane} refused, loop halted, ZERO load paid`);
				pending = { lane, phase: turnPhase ?? "lane" };
			}
			// THE CHURN ROUTE, and the reason the halt is not the whole remedy: the workers whose
			// verification asked for this lane are still unanswered, and letting the run continue
			// paying loads into a churning window is precisely what the operator ruled out. So the
			// desk is marked in churn (every later batch routes off the router until the ledger is
			// reset), and the requests it holds RIGHT NOW are claimed and handed to the verification
			// SUBAGENT on a non-router model — the answer costs ZERO further swaps while the loop
			// stays halted.
			if (run && runDir) {
				const d = await readDesk(runDir, run.run_id);
				if (d) {
					const churned = setChurn(d, true);
					const live = openRequests(churned);
					if (live.length > 0) {
						const claimed = claimBatch(churned, "subagent");
						deskBatch = { batch: claimed.batch, ids: claimed.ids, routed: "subagent" };
						run.verify_batch = { batch: claimed.batch, ids: claimed.ids, routed: "subagent", at: new Date().toISOString() };
						await writeJsonAsync(deskPath(runDir), claimed.desk);
						pushRejection(run, "task", `LANE THRASH routed verification batch ${claimed.batch + 1} (${claimed.ids.join(", ")}) to the ${VERIFIER_AGENT} subagent on ${VERIFIER_MODEL}: zero lane loads paid`);
						await ensurePhaseTool();
						pi.sendUserMessage(verifierDirective(claimed.batch, claimed.ids, `lane thrash: ${flip.flips} swaps in ${flip.window_s}s naming ${who}; the loop is HALTED and pays no load, so this batch is answered off the router`, churned.requests.filter((r) => claimed.ids.includes(r.id))));
					} else {
						await writeJsonAsync(deskPath(runDir), churned);
					}
				}
			}
			await persist();
			paint(ctx);
			ctx.ui.notify(`orchestrate: LANE THRASH — ${flip.flips} swaps in ${flip.window_s}s naming ${who}: the loop is HALTED and paid no load. /orchestrate lanes reset clears the ledger and lands ${lane}.`, "error");
			return;
		}
		// Swap watch: samples /health (phase, percent) while the pack loads, reads the
		// first-completion and steady decode rates off /metrics, and appends a durable history
		// row per swap — the measurement record behind residency decisions.
		const from = run?.lane ?? "";
		// The status row names the switch, multicolored, while the pack is coming in: the model name
		// appears here exactly once (abbreviated), and the steady row names no model at all.
		swapPill = { from, to: modelLabel(model.name ?? lane) };
		paint(ctx);
		// Optimal MoE loading (moe.ts): the Flash-Next pack saves its learned
		// adaptive-tier placement and starts from it; the profile's existence + age BEFORE this
		// swap is what decides "warm start" vs the 91 tok/s cold ramp.
		// The lane load STARTS here, so the placement proof the swap records is a FRESH `/proc`
		// scan: a load changes which engine is running, and the panel's proof is cached (moe.ts
		// `PROOF_TTL_MS`). Reading the stale one would label a warm start off the pre-swap engine.
		engineProofInvalidate();
		const moe = laneMoe(lane, { configPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG });
		const watch = plan.load
			? startSwapWatch(lane, moe, (percent) => {
					// A superseded switch's watch must never paint: its lane is not the one loading.
			if (gen !== switchGen || !swapPill) return;
			swapPill = { ...swapPill, percent };
			paint(ctx);
				})
			: undefined;
		ctx.ui.setWorkingMessage(`fade_orchestrate: loading ${lane} on the router…`);
		// The lease this load presents, in priority order:
		//  1. the RUN's own token — the run lifecycle owns that lease, and a mid-run swap
		//     must never mint over it;
		//  2. the verify capability this session already holds. A lease is the LANE's write
		//     capability, not the pack's: one held token moves the lane anywhere this session
		//     needs it, so a second review move — and the hand-back — re-use the same holder
		//     instead of churning a new lease per load;
		//  3. a mint under this session's own identity, KEPT (never released here) for the turn
		//     the load protects. The old `finally` released it before the review ran a byte,
		//     which left `lease=free` and let the next peer session take the lane back
		//     (measured 2026-11-25). A minted lease is returned at the hand-back/shutdown.
		const presentToken = leaseToken ?? verifyLeaseToken;
		const loaded = await loadLane(lane, {
			...(presentToken ? { leaseToken: presentToken } : { mintLease: { ttlSec: LEASE_MINT_TTL_S } }),
			sessionId: leaseToken ? leaseSession || SELF_SESSION : verifyLeaseSession || SELF_SESSION,
		});
		if (loaded.minted && loaded.leaseToken) {
			verifyLeaseToken = loaded.leaseToken;
			verifyLeaseSession = loaded.leaseSession ?? SELF_SESSION;
			verifyLeaseRemainingS = LEASE_MINT_TTL_S;
			// The metrics tick IS this lease's clock: `refreshMetrics` -> `renewLaneLease` is the only
			// renewer, and the host starts that tick at run start and run adoption only. A plain
			// verification session -- the no-run path that lands the thinking pack for a review turn --
			// therefore renewed its mint exactly once, at the next `agent_start`: a review turn longer
			// than the mint TTL let the lease lapse MID-VERDICT and a peer minted the lane back, the same
			// loss class as the mid-turn release this file pins. Minting is the moment this session holds
			// authority, so minting is where its clock starts.
			if (!run) startMetricsTimer();
		}
		if (gen !== switchGen) {
			// The pill, the row and the briefing belong to the switch that superseded this one; the
			// watch is the only thing here that outlives the call, so it is the thing cancelled.
			watch?.cancel();
			return;
		}
		if (!loaded.ok) {
			watch?.cancel();
			ctx.ui.setWorkingMessage();
			swapPill = undefined;
			fail(ctx, `loading lane ${lane} failed (${loaded.detail}); briefing not sent`);
			return;
		}
		// ADMITTED IS THE MOMENT TO PIN. The pack switch and the session prompt are ONE act: the
		// load goes out and `setModel` + `setThinkingLevel` + the tool policy + the phase briefing
		// follow in the same generation, on the same turn boundary, with NO residency read in front
		// of them. Proving first — the shape this file carried on 2026-11-26 — is the halt's other
		// half: it left the pin and the briefing naming the PREVIOUS pack for the whole 13-25 s
		// load, so a review round opened naming `hy4-flash` while this session's pin was still
		// `flash-next`, and the completion answered `404 The model 'flash-next' does not exist`.
		// The completion is what waits now: `before_agent_start` holds the next turn until the lane
		// serves the pin — Basalt's hold, keep-alive every 10 s, no client timeout, no 404 for a
		// configured lane. A load that itself FAILED lands no pin and no briefing (the 503 class,
		// the `!loaded.ok` path above), and a superseded generation cancels its own pin below.
		const switched = await pi.setModel(model);
		if (gen !== switchGen) return;
		if (switched !== true && (switched as unknown as { switched?: boolean } | null)?.switched !== true) {
			fail(ctx, `setModel(${PROVIDER}/${lane}) did not switch: ${JSON.stringify(switched)}`);
			return;
		}
		pi.setThinkingLevel(THINKING[lane]);
		// THE TOOL POLICY RIDES THE SAME ACT AS THE PIN. The verifier lane has no writers: the
		// strip is part of what "the session is on the advisor pack" MEANS, so it goes out at
		// admit, with `setThinkingLevel`, before the serve-hold. Applied only after the pack
		// serves, the window between the pin and the strip is a verifier with `edit` and `write`
		// live — and the lane-switch rig asserts the strip while the swap is in flight, because
		// that is the window the operator's screen shows.
		await applyToolPolicy(lane);
		// THE SAME WRAPPER THE COMPLETION USES, RUN AT THE BOUNDARY THAT ASKED FOR THE LANE.
		// `before_agent_start` holds the host's completion with `laneServeHold`; running it here
		// gives the SWITCH its holding page for the whole 13-25 s — the working message and the
		// multicolored pill carrying the router's own percent — and it means the briefing and the
		// first completion are issued only once the lane serves the pack the pin names. Basalt's
		// shape, so the normal case costs ONE `/v1/models` read: a lane that already serves the pin
		// returns at once, says nothing, and the switch proceeds exactly as before.
		const hold = await laneServeHold(lane, {
			pollMs: LANE_POLL_MS,
			// The daemon's readiness window is the ceiling — the same fuse the start's proof uses,
			// never a client timeout.
			waitMs: START_PROOF_WAIT_MS,
			progress: (m, percent) => {
				// A superseded generation paints nothing: the row and the pill belong to the switch
				// that replaced it.
				if (gen !== switchGen) return;
				ctx.ui.setWorkingMessage(m);
				if (swapPill) swapPill = { ...swapPill, ...(percent !== undefined ? { percent } : {}) };
				paint(ctx);
			},
		});
		ctx.ui.setWorkingMessage();
		swapPill = undefined;
		if (from && runDir && from !== lane) {
			// The swap's cost is booked whichever way the serve check ends: the load was PAID, and a
			// pack that admitted and never came up is the most expensive case there is.
			turnSwapMs += Math.round(loaded.elapsed_s * 1000);
			void watch?.finish(from, lane, loaded.elapsed_s, runDir, run?.run_id, windowClass(run)).then(() => paint(ctx));
		}
		if (gen !== switchGen) {
			watch?.cancel();
			return;
		}
		if (!hold.ok) {
			// The 503 class, or the readiness window spent: the lane does not serve the pack the pin
			// names, so NO briefing on it and no `run.lane` claim. The lane stays owed in `pending`,
			// and the screen follows the lane that IS serving when that is one of the three.
			const fall = hold.served_id !== undefined && isServedLane(hold.served_id) ? hold.served_id : undefined;
			if (fall) {
				const fm = ctx.modelRegistry.find(PROVIDER, fall);
				if (fm) await pi.setModel(fm);
			}
			fail(ctx, `lane ${lane} was admitted and pinned, but does not serve: ${hold.reason}${fall ? ` — the screen follows ${fall}, and ${lane} stays owed` : " — no briefing sent"}`);
			return;
		}
		if (handBack && verifyLeaseToken && !leaseToken) await returnVerifyLease();
		if (run) run.lane = lane;
		await persist();
		paint(ctx);
		// The tool policy rode the ADMIT act above, with the pin and the thinking level: the
		// serve-hold is the wait, not a second act.
		if (gen !== switchGen) return;
		setTimeout(async () => {
			if (gen !== switchGen) return; // the briefing is for the lane that LANDED, never one a newer switch replaced
			// A QUIET switch carries no briefing: the hand-back lands a lane the operator did not ask
			// about, and a page sent for it would be a queued request naming the lane just left.
			if (quiet) return;
			// A PLAIN session (no run) has no round, no desk, no protocol debt: the lane move IS
			// the deliverable. The briefing below reads `run!` — measured 2026-11-25, a verdict act
			// in a session with no run reached this timer with `run === undefined` and threw inside
			// a host timer (unhandled rejection: `Cannot read properties of undefined (reading
			// 'state')`), which is the plain-session verification path dying on the host. So the
			// run-free landing takes the fixed page it can answer with, and NEVER touches `run!`:
			//  - a THINKING lane landed = the session's own verdict act came due. The model must be
			//    told it is answering from the advisor pack, or it reviews on a pack it cannot see;
			//  - a CODE lane landed (the operator's `/lane c`, a hand-back) needs no page: nothing
			//    in the session is waiting on it.
			if (!run) {
				if (isThinkingLane(lane)) {
					pi.sendUserMessage(
						`fade_orchestrate: the advisor lane (${lane}) is loaded and serving, and this session has no run. Answer the verification acts this session delegated — the reviewer rounds it started, the verdicts it owes — from this pack. End the turn when they are answered; the code lane returns at the next boundary.`,
					);
				}
				return;
			}
			await ensurePhaseTool();
			// A batch briefing is owed to exactly ONE landing: the switch the desk dispatch asked
			// for. The flag is consumed here, so a later switch to the same lane re-briefs the
			// round's own page and never repeats the batch.
			const owed = deskBriefing && isThinkingLane(lane) && run?.verify_batch;
			deskBriefing = false;
			if (owed && runDir && run) {
				const st = run;
				const ids = st.verify_batch?.ids ?? [];
				const d = await readDesk(runDir, st.run_id);
				if (d) {
					pi.sendUserMessage(
						briefings.verifyBatch(st, {
							batch: st.verify_batch?.batch ?? d.epoch,
							ids,
							routed: st.verify_batch?.routed ?? "swap",
							requests: d.requests.filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id, agent: r.agent, ...(r.task_id ? { task_id: r.task_id } : {}), objective: r.objective, ...(r.acceptance ? { acceptance: r.acceptance } : {}), checks: r.checks })),
						}),
					);
					return;
				}
			}
			const text = await (
				run!.state === "repair"
					? briefings.repair(run!)
					: lane === CODE_LANE && run!.gate_last && run!.gate_last.passed === false
						? briefings.gate(run!)
						: lane === CODE_LANE
							? briefings.code(run!)
							: briefings.verify(run!)
			);
			pi.sendUserMessage(text);
		}, 0);
	};

	/**
	 * The Alt+F screen: one provider call = one screen. It reads the run object, the run dir's
	 * ledgers, the router (the cached snapshot is refreshed and persisted here, so the engine rows
	 * on the panel MOVE while it is open) and the host's context meter. Every number a source did
	 * not answer is named by `collectScreen`, never printed as a zero.
	 */
	const panelProvider = (ctx: ExtensionContext): (() => Promise<ScreenData>) | undefined => {
		if (!run || !runDir) return undefined;
		const state = run;
		const dir = runDir;
		return async () => {
			const s = await fetchMetrics();
			if (s) {
				metrics = s;
				void persistMetrics(dir, s).catch(warnWrite(ctx, "metrics tick"));
			}
			return collectScreen({
				run: state,
				runDir: dir,
				lanes: { think: THINK_LANE, code: CODE_LANE },
				names: { [THINK_LANE]: ctx.modelRegistry.find(PROVIDER, THINK_LANE)?.name, [CODE_LANE]: ctx.modelRegistry.find(PROVIDER, CODE_LANE)?.name },
				context: ctx.getContextUsage(),
				metrics,
				flip: flipBadge,
				// The load in flight, so the screen paints its holding page: the chord pressed
				// mid-swap is the keystroke that needs a screen, and the panel is where the operator
				// reads what the 13-25 s load is doing.
				swap: swapPill,
				// The panel names who holds the router. `readInstanceLock` is a 400-byte read of the
				// claim file, and `null` (absent/parsable-free) is a real answer, not a missing row.
				claim: readInstanceLock(instanceLockDir(ROUTER)) ?? null,
				...(process.env.FADE_ORCHESTRATE_BASALT_CONFIG ? { moeConfigPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG } : {}),
			});
		};
	};

	/**
	 * The page the overlay mounts when the LIVE read is the thing that is slow — the case the panel
	 * exists for. A phase boundary's pack swap runs 13-25 s, and the panel's first read is the
	 * router (whose process is being replaced for that window) plus the two ledger parses. So the
	 * keystroke that matters most is the one that lands mid-swap, and it must answer with a screen,
	 * not a warning.
	 *
	 * This builder touches none of the slow path: the run's own in-memory state, the `metrics`
	 * snapshot the tick already paid for, the swap pill, and empty ledgers — which the screen names
	 * as `no swaps recorded` / `no turn telemetry`, never as a zero. No `claim` read either, so the
	 * claim row says `not measured` rather than inventing a free router.
	 */
	const panelHolding = (ctx: ExtensionContext): (() => ScreenData) | undefined => {
		if (!run || !runDir) return undefined;
		const state = run;
		const dir = runDir;
		return () =>
			assembleScreen({
				run: state,
				runDir: dir,
				lanes: { think: THINK_LANE, code: CODE_LANE },
				names: { [THINK_LANE]: ctx.modelRegistry.find(PROVIDER, THINK_LANE)?.name, [CODE_LANE]: ctx.modelRegistry.find(PROVIDER, CODE_LANE)?.name },
				context: ctx.getContextUsage(),
				metrics,
				swaps: [],
				turns: [],
				flip: flipBadge,
				swap: swapPill,
				...(process.env.FADE_ORCHESTRATE_BASALT_CONFIG ? { moeConfigPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG } : {}),
			});
	};

	/** The extension's own version, read when the verb asks. An installed extension file has no
	 *  package.json above it, and `versionLine` names that gap instead of printing a zero. */
	const packageVersion = async (): Promise<string | undefined> => {
		const here = dirname(fileURLToPath(import.meta.url));
		for (const p of [join(here, "..", "package.json"), join(here, "package.json")]) {
			try {
				const raw: unknown = JSON.parse(await readFile(p, "utf8"));
				if (raw && typeof raw === "object" && "version" in raw && typeof raw.version === "string" && raw.version !== "") return raw.version;
			} catch {
				// Not this layout: try the next candidate.
			}
		}
		return undefined;
	};

	/** The bundle's fingerprint: sha256 over the built `dist/index.js`, the file CI proves equals a
	 *  fresh build of `src/`. A tree that never built has none, and the version line says so. */
	const bundleHash = async (): Promise<string | undefined> => {
		const here = dirname(fileURLToPath(import.meta.url));
		for (const p of [join(here, "index.js"), join(here, "..", "dist", "index.js")]) {
			try {
				return createHash("sha256").update(await readFile(p)).digest("hex");
			} catch {
				// Not this layout.
			}
		}
		return undefined;
	};

	/** The class of the window a swap OPENS (taskmoe.ts): the first READY task's class — the work
	 *  the lane is loaded to start on — falling back to the first open task, then the plan's first.
	 *  A run with no tasks has no class, and the row is left unjudged rather than guessed. */
	const windowClass = (r: RunState | undefined): string | undefined => {
		if (!r) return undefined;
		const w = roundWindow(r);
		const t = w.readyNow[0] ?? w.open[0] ?? (r.tasks ?? [])[0];
		return t ? classOf(t) : undefined;
	};

	/** A panel key is a loop control: the same directives `/orchestrate` answers, on the SELECTED task. */
	const actOnPanel = (ctx: ExtensionContext, a: PanelAction): void => {
		if (!run) return;
		const dir =
			a.key === "s" ? actSkip(run, a.taskId) : a.key === "v" ? actVerify(run) : a.key === "r" ? actReset(run) : a.key === "p" ? actPause(run) : a.key === "c" ? actCode(run) : a.key === "h" ? actHalt(run) : undefined;
		if (!dir) return;
		void persist().catch(warnWrite(ctx, "panel key"));
		paint(ctx);
		ctx.ui.notify(`orchestrate: ${dir.note}`, "info");
		// [p]/[c] resumed a paused loop: pay the lane load that pausing deferred.
		if (!run.paused && pending) {
			const deferred = pending;
			pending = undefined;
			requestLane(deferred.lane, ctx);
		}
		if (dir.next) requestLane(dir.next, ctx);
	};

	const showPanel = async (ctx: ExtensionContext): Promise<void> => {
		const provider = panelProvider(ctx);
		if (!provider) {
			ctx.ui.notify("orchestrate: no run active", "info");
			return;
		}
		try {
			await openPanel(ctx, provider, (a) => actOnPanel(ctx, a), process.env.FADE_ORCHESTRATE_HEADLESS === "1", panelHolding(ctx));
		} catch (e) {
			// The panel renders from six sources and a bare message names the expression, not
			// the caller; two stack lines ride along so the failure is locatable.
			const where = e instanceof Error && typeof e.stack === "string" ? ` @ ${e.stack.split("\n").slice(1, 4).map((l) => l.trim()).join(" | ")}` : "";
			ctx.ui.notify(`orchestrate: panel failed: ${String(e instanceof Error ? e.message : e)}${where}`, "error");
		}
	};

	// The read is guarded, not just the call. omp 18.20.2's loading-phase proxy answers a
	// property `get` of a guarded action method with the SAME throw as the call, and a throw in
	// the factory body fails the LOAD: the extension dies behind `Warning: Failed to load
	// extension …/fade_orchestrate.ts: Extension runtime not initialized. Action methods cannot
	// be called during extension loading.` — which silently costs the status row, the panel,
	// `/orchestrate` AND the `fade_phase` tool, because `registerTool`/`registerCommand` below it
	// never run. One refused property read must never be able to take the surface down.
	let conflictProbe: unknown;
	try {
		conflictProbe = Reflect.get(pi, "getShortcutConflict");
	} catch {
		conflictProbe = undefined;
	}
	/**
	 * The host's answer about a chord, `undefined` when the chord is free: `kind` names the class
	 * (`reserved` / `keybinding`) and `owner`/`keybindings[0]` the host action that holds it. Swallowed
	 * for two reasons: the method is absent from the published types, and omp 18.20.2's
	 * loading-phase stub throws "Extension runtime not initialized. Action methods cannot be called
	 * during extension loading." for it. A throw here during loading disables the whole
	 * extension. `probeHasAnswered` separates a swallowed throw from a real "free".
	 */
	const hostConflict = (key: string): { kind: string; owner?: string; keybindings?: string[] } | undefined => {
		if (typeof conflictProbe !== "function") return undefined;
		try {
			const answer = (conflictProbe as (k: string) => { kind: string; owner?: string; keybindings?: string[] } | undefined).call(pi, key);
			probeHasAnswered = true;
			return answer;
		} catch {
			return undefined;
		}
	};


	// The chord, claimed at the raw-input layer. `registerShortcut` is refused for a chord the
	// host's table binds ("Extension shortcut conflicts with built-in shortcut" in getShortcuts
	// for ctrl+o, and the probe says the same for alt+f), and the refusal is tolerated; the RAW
	// byte is the delivery, so `ESC f` opens the panel and the host's `tui.editor.cursorWordRight`
	// never runs.
	// While the panel is open the byte is NOT consumed: the overlay keeps its own keys (esc closes).
	const CHORD = chordBytes(FADE_KEY);
	const FALLBACK_KEY = process.env.FADE_ORCHESTRATE_FALLBACK_KEY ?? "alt+shift+i";
	/** The listener's family is ESC + a byte: `alt+<letter>` and `alt+shift+<letter>` are the chords
	 *  whose keystroke the extension can claim ahead of the host — `onTerminalInput` sees the two
	 *  bytes and returns `consume`. A control code is NOT in that family: the host acts on the
	 *  raw byte before the listener sees it, so a configured control
	 *  chord stays the host's and the fallback chord is what opens. `DELIVERED_KEY` is the chord
	 *  the keystroke actually delivers, and it is what the row names: a row advertising a key
	 *  that opens nothing is a lie; the pty rig asserts the painted key is the delivering one.
	 */
	const RAW_DELIVERABLE = CHORD !== undefined && CHORD.startsWith("\x1b");
	const DELIVERED_KEY = RAW_DELIVERABLE ? FADE_KEY : FALLBACK_KEY;
	const openPanelGuarded = async (ctx: ExtensionContext): Promise<void> => {
		if (panelOpen) return;
		panelOpen = true;
		try {
			await showPanel(ctx);
		} finally {
			panelOpen = false;
		}
	};

	/**
	 * The host's chord table — the chords its own action table binds, read out of the 18.20.2
	 * binary and confirmed at runtime by the conflict probe where the probe answers: `alt+f`
	 * answers `keybinding tui.editor.cursorWordRight` (its shortcut registration is REFUSED; the
	 * raw listener delivers the byte), `alt+shift+i` answers FREE (which is why the fallback
	 * registers).
	 *
	 * The table exists because the probe is NOT callable when a hook can run:
	 * `getShortcutConflict` throws for the loading-phase proxy, `session_start` fires inside that
	 * window, and an idle TUI session has no `agent_start` to retry on. The probe decides the
	 * chord when it answers; the table decides when it cannot; the chord is always disclosed.
	 *
	 * A chord NOT in the table, behind a probe that never answers, is advertised as configured
	 * (`chordHeld` stays false): the table is the only knowledge in that state, and claiming a
	 * registered chord is held when nothing says so would be an invented conflict. The raw-input
	 * listener and `registerShortcut` both attempt the chord, so the disclosure matches what the
	 * keystroke will do.
	 */
	const HOST_HELD_CHORDS: Record<string, true> = {
		"ctrl+c": true, "ctrl+d": true, "ctrl+g": true, "ctrl+l": true, "ctrl+o": true, "ctrl+r": true,
		"ctrl+s": true, "ctrl+t": true, "ctrl+y": true, "ctrl+z": true, "ctrl+.": true,
		"alt+a": true, "alt+b": true, "alt+d": true, "alt+f": true, "alt+g": true, "alt+h": true,
		"alt+i": true, "alt+k": true, "alt+l": true, "alt+m": true, "alt+n": true, "alt+o": true,
		"alt+p": true, "alt+r": true, "alt+y": true,
		"alt+shift+c": true, "alt+shift+k": true, "alt+shift+l": true, "alt+shift+p": true, "alt+shift+v": true,
	};

	/**
	 * The ONE chord worth a line at login: the one that CANNOT open the screen. A delivered chord
	 * says nothing — the row above the editor names it every round, `docs/OVERLAY.md` carries the
	 * contract and `test/pty_rig.mjs` proves it, so a working keyboard is not re-explained at every
	 * session. A configured CONTROL chord is different: the host acts on the raw byte before any
	 * listener sees it, so the row would advertise a dead key. That line names the fallback and the
	 * variable, once per process.
	 *
	 * The probe decides when it answers; the chord table decides when it cannot (`session_start`
	 * fires inside the loading-phase window, where the probe throws). A control chord the table
	 * does not name stays unannounced: claiming a conflict nothing reported would be an invented
	 * one, and the listener and `registerShortcut` both attempt the chord either way.
	 */
	const resolveChord = (): string | undefined => {
		if (!CHORD || chordResolved || RAW_DELIVERABLE) return undefined;
		const conflict = hostConflict(FADE_KEY);
		const owner = (conflict?.keybindings?.[0] ?? conflict?.owner) as string | undefined;
		const held = conflict !== undefined || (!probeHasAnswered && HOST_HELD_CHORDS[FADE_KEY] === true);
		chordResolved = true;
		if (conflictReported) return undefined;
		conflictReported = true;
		if (!held) return undefined;
		const who = conflict ? `${conflict.kind}${owner ? ` ${owner}` : ""}` : "its key table";
		return `the host binds ${keyLabel(FADE_KEY)} (${who}): the screen opens on ${keyLabel(FALLBACK_KEY)} (FADE_ORCHESTRATE_KEY picks a chord the probe reports FREE)`;
	};

	/** Apply one validated phase; returns the lane to load and the resulting state. */
	const applyPhase = (phase: string, payload: Record<string, unknown>): { next: string; nextState: string } => {
		if (!run) throw new Error("unreachable: no run");
		// `run` is a mutable `let`; the closures below lose the guard's narrowing, so the state is
		// captured for the whole phase application — which is the atomicity the phase contract
		// wants anyway: one validated phase, one consistent snapshot.
		const st: RunState = run;
		st.phases.push({ phase, lane: st.lane, accepted: true, round: st.round, at: new Date().toISOString(), notes: typeof payload.notes === "string" ? payload.notes : undefined });
		if (phase === "planning_done") {
			if (st.state === "coding") {
				// Plan act (the gate proved a check is not a command): checks only. Tasks, statuses,
				// results, round and budget are untouched, the state stays `coding`, and the lane
				// stays CODE — the coder is already resident, so the act pays NO swap.
				st.checks = payload.checks as [string, string][];
				st.phases[st.phases.length - 1].notes = PLAN_ACT_NOTE;
				return { next: CODE_LANE, nextState: "coding" };
			}
			st.tasks = (payload.tasks as Task[]).map((t) => ({ ...t, round: st.round }));
			st.checks = payload.checks as [string, string][];
			st.tier = st.tasks.length <= 2 ? "S" : st.tasks.length <= 4 ? "M" : "L";
			// The cap is the PLAN's, not a constant. A task that declares `complexity` sets the
			// tier (trivial 2 / standard 4 / deep 6, the max over the plan); a plan declaring none
			// falls back to the task-count curve (2 tasks reserve 3 rounds, 6 reserve 5).
			// Swaps are the unit of cost (13-25 s per pack load), and the `--rounds` budget is
			// the ceiling in both cases.
			st.max_rounds = roundsForTasks(st.tasks, st.max_rounds);
			st.repair_tasks = [];
			st.state = "coding";
			return { next: CODE_LANE, nextState: "coding" };
		}
		if (phase === "coding_done") {
			for (const d of payload.done as Array<{ id: string; status: string; result?: string }>) {
				const task = st.tasks.find((t) => t.id === d.id) ?? st.repair_tasks.find((t) => t.id === d.id);
				if (task) {
					task.status = d.status;
					task.result = d.result;
				}
			}
			st.state = "verifying";
			return { next: VERIFY_LANE, nextState: "verifying" };
		}
		const accepted = String(payload.verdict) === "accepted";
		st.phases[st.phases.length - 1].accepted = accepted;
		if (accepted) {
			st.state = "complete";
			return { next: VERIFY_LANE, nextState: "complete" };
		}
		pushRejection(
			st,
			"verification",
			typeof payload.notes === "string" ? payload.notes : "needs_repair",
			Array.isArray(payload.tasks) ? (payload.tasks as Array<{ id: string }>).map((t) => t.id).join(",") : undefined,
		);
		if (st.round + 1 > st.max_rounds) {
			st.state = "failed";
			st.reason = `round budget exhausted (${st.max_rounds}) with verdict needs_repair`;
			return { next: VERIFY_LANE, nextState: "failed" };
		}
		st.round += 1;
		st.repair_tasks = (payload.tasks as Task[]).map((t) => ({ ...t, round: st.round, status: undefined, result: undefined }));
		st.state = "repair";
		return { next: CODE_LANE, nextState: "repair" };
	};

	pi.registerTool({
		name: "fade_phase",
		label: "fade phase",
		description:
			'Report one completed orchestration phase and end the turn so the orchestrator can switch lanes. ' +
			'phase=planning_done payload={"tasks":[{"id","objective","files","acceptance","dependencies"}],"checks":[["cmd","expected"]]}; ' +
			'phase=coding_done payload={"done":[{"id","status","result"}]}; ' +
			'phase=verification_done payload={"verdict":"accepted"|"needs_repair","checks":[["cmd","observed"]],"notes":"...","tasks":[...]}. ' +
			"payload is that JSON object serialized to a string. Invalid phase, payload or ordering is refused with the rule named.",
		parameters: Type.Object({
			phase: Type.String({ description: "planning_done | coding_done | verification_done" }),
			payload: Type.String({ description: "the phase JSON object, as a string" }),
		}),
		// `essential` ships the schema in the request catalog; `discoverable` (the default) is
		// mounted behind xd:// and the phase contract cannot be answered that way.
		// omp 18.20's registerTool takes `loadMode`; the 0.73.1 peer types predate it.
		// @ts-expect-error loadMode is accepted at runtime (essential = shipped in the catalog).
		loadMode: "essential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Schema auto-repair: every refusal is recorded; from the second refusal the exact
			// payload schemas ride back in the error text, so the model self-corrects instead of
			// probing blind. The rejection history is the durable record of what was refused.
			let payload: Record<string, unknown>;
			try {
			if (!run) throw new Error("fade_phase: no orchestrated run is active (start one with /orchestrate <goal>)");
			if (TERMINAL[run.state] === true) throw new Error(`fade_phase: run ${run.run_id} is already ${run.state}`);
			if (run.round > run.max_rounds) throw new Error(`fade_phase: round ${run.round} exceeds max_rounds ${run.max_rounds}`);
			const allowed = PHASE_FOR_STATE[run.state];
			if (!allowed) throw new Error(`fade_phase: state ${run.state} takes no phase`);
			// ONE exception, and only when the gate PROVED it: a check bash refuses to PARSE is a
			// defect in the plan, and no tree state can move its exit code. Refusing the plan act
			// from `coding` livelocks the run: identical refusals, zero lane loads. The exception
			// re-declares CHECKS only, and the tasks must be the plan's own (validated below), so
			// it cannot rewrite the plan to dodge a red gate.
			const gatePlanDefect = (run.gate_last?.results ?? []).some((r) => r.invalid);
			if (params.phase !== allowed) {
				if (!(params.phase === "planning_done" && run.state === "coding" && gatePlanDefect)) {
					throw new Error(
						`fade_phase: state ${run.state} takes phase ${allowed}, not ${params.phase}` +
							(gatePlanDefect
								? " — the gate recorded a check that is not a command, so a planning_done that keeps every task and re-declares the checks IS accepted from this state"
								: ""),
					);
				}
			}
			try {
				payload = JSON.parse(params.payload) as Record<string, unknown>;
			} catch {
				throw new Error("fade_phase: payload is not valid JSON");
			}
			if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("fade_phase: payload must be a JSON object");
			const allowedKeys: Record<string, Set<string>> = {
				planning_done: new Set(["tasks", "checks"]),
				coding_done: new Set(["done"]),
				verification_done: new Set(["verdict", "checks", "notes", "tasks", "verdicts"]),
			};
			for (const key of Object.keys(payload)) {
				if (!allowedKeys[params.phase].has(key)) throw new Error(`fade_phase: ${params.phase} does not take key "${key}"`);
			}
			if (params.phase === "planning_done") {
				const tasks = validateTasks(payload.tasks);
				if (tasks.error) throw new Error(`fade_phase: ${tasks.error}`);
				const checks = validateChecks(payload.checks);
				if (checks.error) throw new Error(`fade_phase: ${checks.error}`);
				if (run.state === "coding") {
					// A plan act: the checks only. The tasks are frozen for the round, and the act
					// is allowed ONCE per round — an unlimited re-declaration is a gate bypass.
					const st = run;
					if (!sameTaskPlan(st.tasks, payload.tasks as unknown[])) {
						throw new Error("fade_phase: a plan act from `coding` must carry the plan's tasks UNCHANGED (same ids, objectives, files, acceptance, dependencies) — only the checks may be re-declared");
					}
					const acts = st.phases.filter((p) => p.phase === "planning_done" && p.round === st.round && p.notes === PLAN_ACT_NOTE).length;
					if (acts >= 1) {
						throw new Error(`fade_phase: this round already spent its one plan act (round ${st.round}) — the checks are now the plan; make the tree satisfy them, halt, or let the verifier judge them`);
					}
				}
			}
			if (params.phase === "coding_done") {
				if (!Array.isArray(payload.done) || payload.done.length === 0) throw new Error("fade_phase: coding_done needs a non-empty done[]");
				const ids = new Set(run.tasks.concat(run.repair_tasks).map((t) => t.id));
				for (const entry of payload.done as Array<Record<string, unknown>>) {
					if (typeof entry.id !== "string" || !ids.has(entry.id)) throw new Error(`fade_phase: done entry ${JSON.stringify(entry.id)} is not a task of this run`);
					if (!["passed", "failed", "blocked"].includes(String(entry.status))) throw new Error(`fade_phase: ${entry.id} status must be passed|failed|blocked`);
				}
			}
			if (params.phase === "verification_done") {
				if (!["accepted", "needs_repair"].includes(String(payload.verdict))) throw new Error("fade_phase: verdict must be accepted or needs_repair");
				// `verdicts` is the desk's fan-out, and it is legal ONLY while the desk has a batch
				// claimed for this run: verdicts for an unclaimed batch are the double pass the desk
				// batches away, so the key is refused with the state named. Every id of the claimed
				// batch must carry a row — a request with no verdict leaves its worker parked.
				if (payload.verdicts !== undefined) {
					const open = run.verify_batch;
					if (!open) throw new Error('fade_phase: "verdicts" is the verification DESK\'s fan-out, and no batch is claimed for this run (the desk names its ids in your briefing) — drop the key');
					if (!Array.isArray(payload.verdicts) || payload.verdicts.length === 0) throw new Error("fade_phase: verdicts must be a non-empty array of {id, accepted, notes} — one row per id of the claimed batch");
					const ids = new Set(open.ids);
					const rows = payload.verdicts as Array<Record<string, unknown>>;
					for (const row of rows) {
						if (typeof row.id !== "string" || !ids.has(row.id)) throw new Error(`fade_phase: verdicts row ${JSON.stringify(row.id)} is not an id of claimed batch ${open.batch + 1} (${open.ids.join(", ")})`);
						if (typeof row.accepted !== "boolean") throw new Error(`fade_phase: verdicts row ${row.id} needs a boolean "accepted"`);
						if (typeof row.notes !== "string" || row.notes.trim() === "") throw new Error(`fade_phase: verdicts row ${row.id} needs "notes" naming the command run and what it printed, or the cause to fix`);
					}
					const silent = open.ids.filter((id) => !rows.some((row) => row.id === id));
					if (silent.length > 0) throw new Error(`fade_phase: claimed batch ${open.batch + 1} is answered by EVERY id — ${silent.join(", ")} has no verdict row, and a request with no verdict leaves its worker parked in fade_verify`);
				}
				if (payload.checks !== undefined) {
					const checks = validateChecks(payload.checks);
					if (checks.error) throw new Error(`fade_phase: ${checks.error}`);
				}
				if (String(payload.verdict) === "needs_repair") {
					if (!Array.isArray(payload.tasks) || payload.tasks.length === 0) throw new Error("fade_phase: needs_repair requires a non-empty tasks[]");
					const tasks = validateTasks(payload.tasks);
					if (tasks.error) throw new Error(`fade_phase: ${tasks.error}`);
				}
			}
			} catch (e) {
				const text = e instanceof Error ? e.message : String(e);
				if (run) {
					run.schema_retries += 1;
					pushRejection(run, "schema", text);
					await persist();
					throw new Error(run.schema_retries >= 2 ? `${text}\n${SCHEMA_HINT}` : text);
				}
				throw new Error(text);
			}
			// The lane is `applyPhase`'s decision, so the state machine and the load can never
			// disagree — and the swap is NOT issued here: the router swaps to the entry the
			// QUEUED requests name, and this turn is about to abort with its chat requests still
			// queued. `agent_end` is the single load site, after the turn is closed.
			const applied = applyPhase(params.phase, payload);
			turnPhase = params.phase;
			// The desk fan-out. The batch's verdicts land on each request BY ID — that write is the
			// only thing that unblocks a worker parked in `fade_verify` — and the claimed batch is
			// then closed in the run state, so no later `verification_done` can answer the same ids
			// a second time. A verifier that reported the aggregate verdict without per-id rows gets
			// the aggregate fanned to every id, with its own notes, rather than leaving workers
			// parked: the aggregate IS the batch's answer in that shape.
			let verdictNote = "";
			const claimed = run.verify_batch;
			if (params.phase === "verification_done" && claimed && runDir) {
				const st3: RunState = run;
				const rows = Array.isArray(payload.verdicts) ? (payload.verdicts as Array<Record<string, unknown>>) : [];
				const aggregate = String(payload.verdict) === "accepted";
				const fan = rows.length > 0
					? rows.map((r) => ({ id: String(r.id), accepted: r.accepted === true, notes: String(r.notes) }))
					: claimed.ids.map((id) => ({ id, accepted: aggregate, notes: typeof payload.notes === "string" ? payload.notes : `round verdict: ${String(payload.verdict)}` }));
				await mutateDesk(runDir, st3.run_id, (d) => attachVerdicts(d, fan).desk);
				st3.verify_batch = undefined;
				deskBatch = undefined;
				verdictNote = `; desk batch ${claimed.batch + 1} answered for ${fan.length} worker request(s) (${fan.filter((f) => f.accepted).length} accepted)`;
			}
			// An accepted phase is the end of the protocol streak. `round`/`max_rounds` are
			// untouched here — a lane that reports never owes the round budget anything.
			classifyTurnEnd(run, true);
			// A terminal state releases the router claim in the same keystroke, so the next session
			// starts without a manual release. Owner-only: an adopted run holds no claim of its own.
			if (applied.nextState === "complete" || applied.nextState === "failed") {
				releaseLock();
				releaseLaneLease();
			}
			let checkpointNote = "";
			if (params.phase === "verification_done" && applied.nextState === "complete") {
				// Tag the tree at the moment each task was accepted, namespaced per run.
				// `run` is a mutable `let`, so the closure below loses the guard's narrowing.
				const st: RunState = run;
				const tags = await Promise.all(st.tasks.filter((t) => t.status === "passed").map((t) => tagCheckpoint(st.repo, st, t.id)));
				const ok = tags.filter((t) => t.ok).map((t) => t.tag);
				if (ok.length > 0) checkpointNote = `; checkpoints ${ok.join(", ")}`;
				const refused = tags.filter((t) => !t.ok);
				if (refused.length > 0) checkpointNote += `; checkpoint FAILED ${refused.map((t) => `${t.tag}: ${t.error}`).join(", ")}`;
				checkpointNote += await auditOwedOnComplete(st, ctx);
			}
			// The pre-swap gate: on coding_done, before paying the verifier swap (13-25 s pack
			// load), run the plan's own checks on the code lane. Red keeps the coding lane
			// resident (loadLane on the resident entry costs 0 s), records the rejection, and
			// sends the gate briefing with the observed tails — self-repair without a swap.
			if (params.phase === "coding_done" && applied.nextState === "verifying" && run.checks.length > 0) {
				await gateChecks(ctx);
				const gate = await runGateLogged(run.checks, run.repo, ctx);
				run.gate_last = gate;
				if (!gate.passed) {
					const failing = gate.results.filter((r) => !r.ok);
					// Red-gate TRIAGE: one bounded, tool-less advisory call naming the probable cause,
					// so the coding lane starts its repair with a hypothesis. It has ZERO authority: the
					// verdict is the exit codes, `coding_done` re-runs the checks, and a failure (no
					// binary, timeout, no answer) returns an empty note, leaving the briefing exactly as
					// it was before this existed.
					const triage = await gateTriage(failing, run.repo);
					const triageNote = triageLine(triage);
					if (triage.note !== "") run.gate_last = { ...gate, triage: triage.note };
					if (triage.note === "" && triage.skipped !== true) ctx.ui.notify(`orchestrate: gate triage produced nothing (${triage.why})`, "info");
					pushRejection(run, "task", `pre-swap gate red: ${failing.map((f) => f.cmd).join(" | ")}`);
					run.state = "coding";
					await persist();
					paint(ctx);
					pending = { lane: CODE_LANE, phase: "gate" };
					settledNotified = false;
					ctx.abort();
					return {
						content: [{ type: "text", text: `pre-swap gate RED (${failing.length}/${gate.results.length} failing); the verifier swap was not paid; fix and re-report coding_done${triageNote !== "" ? `; ${triageNote}` : ""}` }],
						details: { gate: "red", failing: failing.map((f) => f.cmd) },
					};
				}
			}
			// The fast-path single-model bypass. The gate is green, every task in the window is
			// passed, the diff is under the threshold, and this round has taken no task/verification
			// rejection — the first try. The verifier's evidence IS the exit codes the gate just
			// collected, so the 13-25 s / 52-130 GiB swap buys nothing: the run completes on the
			// code lane and pays ZERO lane loads. The accepted phase is recorded by name so the
			// phase rail and the ledger show what happened, and the checkpoints land exactly as an
			// accepted verification would.
			if (params.phase === "coding_done" && applied.nextState === "verifying" && run.gate_last?.passed === true) {
				const st2: RunState = run;
				const firstTry = !(st2.rejection_history ?? []).some((r) => r.round === st2.round && (r.kind === "task" || r.kind === "verification"));
				const allPassed = st2.tasks.length > 0 && st2.tasks.every((t) => t.status === "passed");
				const diff = firstTry && allPassed ? await fastPathDiff(st2.repo) : undefined;
				if (diff && diff.files >= 1 && diff.files <= FASTPATH_FILES && diff.lines < FASTPATH_LINES) {
					st2.phases.push({ phase: "verification_done", lane: st2.lane, accepted: true, round: st2.round, at: new Date().toISOString(), notes: `fast path: ${diff.files} file(s), ${diff.lines} changed lines < ${FASTPATH_LINES}, gate green on the first try — the verifier swap was not paid` });
					st2.state = "complete";
					const tags2 = await Promise.all(st2.tasks.filter((t) => t.status === "passed").map((t) => tagCheckpoint(st2.repo, st2, t.id)));
					const ok2 = tags2.filter((t) => t.ok).map((t) => t.tag);
					const refused2 = tags2.filter((t) => !t.ok);
					checkpointNote = ok2.length > 0 ? `; checkpoints ${ok2.join(", ")}` : "";
					if (refused2.length > 0) checkpointNote += `; checkpoint FAILED ${refused2.map((t) => `${t.tag}: ${t.error}`).join(", ")}`;
					checkpointNote += await auditOwedOnComplete(st2, ctx);
					turnPhase = "verification_done";
					await persist();
					paint(ctx);
					pending = undefined;
					settledNotified = false;
					ctx.abort();
					return {
						content: [{ type: "text", text: `fast path: gate green on the first try, ${diff.lines} changed lines in ${diff.files} file(s) under the ${FASTPATH_LINES}-line threshold; the run is complete on the ${st2.lane} lane and the verifier swap was not paid${checkpointNote}` }],
						details: { phase: "coding_done", state: "complete", fast_path: true, files: diff.files, lines: diff.lines, threshold_lines: FASTPATH_LINES, threshold_files: FASTPATH_FILES, next_lane: null, checkpoints: st2.checkpoints ?? {} },
					};
				}
			}
			await persist();
			paint(ctx);
			pending = applied.nextState === "failed" || applied.nextState === "complete" ? undefined : { lane: applied.next, phase: params.phase };
			settledNotified = false;
			ctx.abort();
			return {
					content: [{ type: "text", text: `phase ${params.phase} recorded; state ${applied.nextState}${checkpointNote}${verdictNote}${pending ? `, ${pending.lane} loads at the turn boundary` : "; run terminal, lane left resident"}` }],
				details: { phase: params.phase, state: applied.nextState, next_lane: pending?.lane ?? null, checkpoints: run.checkpoints ?? {} },
			};
		},
	});

	/**
	 * The desk's front door, for a delegated worker.
	 *
	 * A worker that finishes its slice wants its work verified, and the naive shape of that —
	 * verify on arrival — is one lane load per worker: three workers, three 13-25 s swaps inside
	 * the flip guard's window, and the guard calls the result churn and halts the run. So this tool
	 * does not verify anything. It registers the request and, for a worker, BLOCKS on the answer:
	 * the batch is collected until it has closed (every verification-carrying worker of the
	 * launching `task` call registered, the call settled, the settle window aged out, or the hard
	 * deadline), and then ONE verification pass answers the whole batch and the verdict lands on
	 * each request by id, unblocking every worker parked here at the same instant.
	 *
	 * The owner session is deliberately NOT blocked: it is the thing that dispatches the batch, and
	 * a blocked owner verifies nothing forever. It gets the queue position and moves on.
	 */
	pi.registerTool({
		name: "fade_verify",
		label: "fade verify",
		description:
			"Register THIS session's verification request with the run's verification desk, then wait for the batched verdict. " +
			"The orchestrator answers every request of one batch in a SINGLE verification pass and never loads a lane per arrival, so a worker that finishes early waits for its peers by design. " +
			"Call it ONCE per slice: a second call for the same objective returns the same request. " +
			"params: objective (what must be judged), acceptance (the command that proves it and what it must print), checks [[cmd, expected]], task_id.",
		parameters: Type.Object({
			objective: Type.String({ description: "what must be judged, in one sentence" }),
			acceptance: Type.Optional(Type.String({ description: "one command and what it must print" })),
			checks: Type.Optional(Type.Array(Type.Any(), { description: '[["cmd","expected"]] rows the verifier must run; {"cmd","expected"} objects are accepted too' })),
			task_id: Type.Optional(Type.String({ description: "the run task this slice belongs to, when one was named" })),
		}),
		// @ts-expect-error loadMode is accepted at runtime (essential = shipped in the catalog).
		loadMode: "essential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const objective = String(params.objective ?? "").trim();
			if (objective === "") throw new Error('fade_verify: "objective" is the thing to judge — name it in one sentence');
			const dir = deskDirFor(ctx);
			const state = await readJsonAsync<RunState>(join(dir, STATE_FILENAME));
			const active = await readJsonAsync<{ run_id?: string }>(join(dir, ACTIVE_FILENAME));
			const runId = typeof state?.run_id === "string" ? state.run_id : typeof active?.run_id === "string" ? active.run_id : undefined;
			if (!runId) throw new Error(`fade_verify: ${dir} carries no orchestrated run (no state.json), so there is no desk to register against — nothing was written`);
			const rows: unknown[] = Array.isArray(params.checks) ? params.checks : [];
			const agent = isWorkerSession(ctx) ? workerName(ctx) : "owner";
			let captured: { request: VerifyRequest; deduped: boolean } | undefined;
			const after = await mutateDesk(dir, runId, (d) => {
				const enq = enqueueRequest(d, {
					agent,
					session: process.env.PI_SESSION_FILE ?? "",
					...(typeof params.task_id === "string" && params.task_id.trim() !== "" ? { task_id: params.task_id.trim() } : {}),
					objective,
					...(typeof params.acceptance === "string" && params.acceptance.trim() !== "" ? { acceptance: params.acceptance.trim() } : {}),
					checks: rows as [string, string][],
				});
				captured = { request: enq.request, deduped: enq.deduped };
				return enq.desk;
			});
			const request = captured?.request;
			if (!request) throw new Error(`fade_verify: the desk at ${dir} did not accept the registration (concurrent writers exhausted the retry budget); nothing was queued`);
			const ready = readyToAddress(after, Date.now());
			const queue = `request ${request.id} of batch ${after.epoch + 1} · ${ready.open} registered, ${ready.expected > 0 ? `${ready.registered}/${ready.expected} of the launching task call` : "the launching task call named no count"}`;
			if (agent === "owner") {
				// The owner is the dispatcher: blocking it would park the only session that can pay
				// the pass. It gets its queue position and the rule that closes the batch.
				return {
					content: [{ type: "text", text: `${queue}. Registered; NOT blocked here — this session dispatches the batch, so blocking it would stall the pass. The batch is answered at the turn boundary when it closes (${ready.reason}). Do not call fade_verify twice for this slice.` }],
					details: { desk: { run_id: runId, id: request.id, batch: after.epoch + 1, deduped: captured?.deduped === true, ready: ready.ready, reason: ready.reason, owner: true } },
				};
			}
			const wait = await awaitVerdict(dir, runId, request.id, { timeoutMs: DESK_WAIT_MS, signal });
			if (wait.state === "answered") {
				const v = wait.request?.verdict;
				return {
					content: [{ type: "text", text: `${request.id} ${v?.accepted === true ? "ACCEPTED" : "NEEDS REPAIR"} after ${Math.round(wait.waited_ms / 1000)}s in the batched pass: ${v?.notes ?? "no notes posted"}` }],
					details: { desk: { run_id: runId, id: request.id, batch: after.epoch + 1, state: "answered", accepted: v?.accepted === true, notes: v?.notes, polls: wait.polls, waited_ms: wait.waited_ms } },
				};
			}
			throw new Error(`${queue} · ${wait.state}: ${wait.note}`);
		},
	});

	/**
	 * The batch's answer, posted BY ID. This write is the only thing that unblocks a worker parked
	 * in `fade_verify`: a verdict written into prose leaves every worker in the batch waiting for
	 * its own request, and the run looks idle while nothing is answered.
	 *
	 * The batch number is a gate, not decoration: a payload naming a batch the desk never claimed
	 * (an epoch still open, or an invented number) is refused with the claimed batches named. That
	 * is what stops a second pass answering an open batch — the double verification the desk
	 * batches away.
	 */
	pi.registerTool({
		name: "fade_verdicts",
		label: "fade verdicts",
		description:
			"Post the verdicts of ONE claimed verification batch, by id. Call ONCE per batch — the write unblocks every worker parked in fade_verify. " +
			'batch is the batch number the briefing names; verdicts is [{"id","accepted","notes"}] with one row per id of that batch, and `notes` naming the command run and what it printed (or the cause to fix).',
		parameters: Type.Object({
			batch: Type.Number({ description: "the batch number from the briefing (the number after `batch`)" }),
			verdicts: Type.Array(Type.Object({ id: Type.String({ description: "the request id, e.g. V2.1" }), accepted: Type.Boolean(), notes: Type.String({ description: "the command run and what it printed, or the cause to fix" }) })),
		}),
		// @ts-expect-error loadMode is accepted at runtime (essential = shipped in the catalog).
		loadMode: "essential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = deskDirFor(ctx);
			const state = await readJsonAsync<RunState>(join(dir, STATE_FILENAME));
			const active = await readJsonAsync<{ run_id?: string }>(join(dir, ACTIVE_FILENAME));
			const runId = typeof state?.run_id === "string" ? state.run_id : typeof active?.run_id === "string" ? active.run_id : undefined;
			if (!runId) throw new Error(`fade_verdicts: ${dir} carries no orchestrated run, so there is no desk to answer`);
			// The public batch number is the LABEL the briefing and the desk print (1-based); the
			// desk's internal epoch is 0-based. One conversion at the boundary, so no reader ever
			// meets two numbering systems for the same batch.
			const label = Number(params.batch);
			const epoch = label - 1;
			const rows = Array.isArray(params.verdicts) ? (params.verdicts as Array<Record<string, unknown>>) : [];
			if (rows.length === 0) throw new Error("fade_verdicts: verdicts[] is empty — a batch is answered by one row per id, never by silence");
			const desk = await readDesk(dir, runId);
			if (!desk) throw new Error(`fade_verdicts: no desk file at ${dir} yet — nothing has been claimed, so nothing can be answered`);
			const claim = desk.addressed.find((a) => a.batch === epoch);
			if (!claim) {
				throw new Error(
					`fade_verdicts: batch ${label} was never claimed by the desk${desk.addressed.length > 0 ? ` (claimed: ${desk.addressed.map((a) => `batch ${a.batch + 1} [${a.ids.join(",")}]`).join(" · ")})` : " (nothing has been claimed)"}; batch ${desk.epoch + 1} is the OPEN one, still being COLLECTED, and answering it early is the double pass this gate exists to stop`,
				);
			}
			const want = new Set(claim.ids);
			const strays = rows.map((r) => String(r.id)).filter((id) => !want.has(id));
			if (strays.length > 0) throw new Error(`fade_verdicts: ${strays.join(", ")} ${strays.length === 1 ? "is" : "are"} not part of batch ${label} (its ids: ${claim.ids.join(", ")}) — judge only your batch`);
			const missing = claim.ids.filter((id) => !rows.some((r) => String(r.id) === id));
			const verdicts = rows.map((r) => ({ id: String(r.id), accepted: r.accepted === true, notes: typeof r.notes === "string" ? r.notes : "no notes" }));
			const res = await mutateDesk(dir, runId, (d) => attachVerdicts(d, verdicts).desk);
			const accepted = verdicts.filter((v) => v.accepted).length;
			return {
				content: [{ type: "text", text: `batch ${label} answered: ${accepted} accepted, ${verdicts.length - accepted} needs_repair; ${verdicts.length} worker${verdicts.length === 1 ? "" : "s"} unblocked${missing.length > 0 ? `; STILL UNANSWERED in this batch: ${missing.join(", ")} — an id you did not judge is a defect, not a pass` : ""}` }],
				details: { desk: { run_id: runId, batch: label, attached: res.requests.filter((r) => verdicts.some((v) => v.id === r.id)).length, missing, routed: claim.routed, churn: desk.churn } },
			};
		},
	});

	pi.registerCommand("lanes", {
		description: `Live basalt router census on ${ROUTER}: every lane entry's load state and /health`,
		handler: async (_args, ctx) => {
			const st = await listLanes();
			if (st.error) {
				ctx.ui.notify(`lanes: router unreachable at ${ROUTER}: ${st.error}`, "error");
				ctx.ui.setWidget("lanes", [`router: ${ROUTER} unreachable`, st.error]);
				return;
			}
			const rows = st.models.map((m) => `${m.id} ${m.status}`);
			ctx.ui.setWidget("lanes", [`router: ${ROUTER} · health ${st.health}`, ...rows]);
			ctx.ui.notify(`lanes: ${st.health} · ${rows.join(" · ")}`, "info");
		},
	});

	// The human lane verb. `/orchestrate` moves the lane at phase boundaries; this is the same
	// machinery for one named pack, for the moments between runs: the churn ledger first (zero
	// bytes at the breaker), the residency short-circuit, a lease minted and released in the same
	// call, and the identity proof from the router's own `/v1/models` — `RESIDENT` alone is only a
	// claim that some model answered the readiness probe.
	pi.registerCommand("lane", {
		description: `Move the :18014 pack: /lane (who is resident) · /lane <model-id> (swap, wait to RESIDENT, prove the served id)`,
		handler: async (args, ctx) => {
			const target = args.trim().split(/\s+/)[0] ?? "";
			if (!target) {
				const sup = await getResidency("fade-orchestrator");
				const st = await listLanes();
				const idn = await servedIdentity();
				const line = sup
					? `daemon lane ${sup.state} pack=${sup.pack || "none"} pid=${sup.pid} requests=${sup.active_requests} · router id ${idn?.id ?? "none"}${idn?.n_ctx ? ` n_ctx ${idn.n_ctx}` : ""}`
					: `no daemon answer · router ${st.health}`;
				ctx.ui.setWidget("lanes", [`router: ${ROUTER}`, ...st.models.map((m) => `${m.id} ${m.status}`)]);
				ctx.ui.notify(`lane: ${line}`, "info");
				return;
			}
			ctx.ui.notify(`lane: moving :18014 to ${target} (teardown, spawn, readiness) …`, "info");
			// The verb is the operator taking the lane: a capability THIS session still holds
			// would be the daemon's own `lease_held` against this very process. Hand it back
			// first, then let the verb mint (and return) its own.
			await returnVerifyLease();
			const mv = await moveLane(target, { sessionId: `omp-pid-${process.pid}` });
			ctx.ui.setWidget("lanes", [`lane ${target}: ${mv.ok ? "resident, id proven" : "NOT proven resident"}`, mv.detail]);
			ctx.ui.notify(`lane ${target}: ${mv.detail}`, mv.ok ? "info" : "warning");
		},
	});

	// The panel's chord is registered as a shortcut, so the HOST parses the chord string: that
	// is the robust delivery for an `alt+…` chord, whose two bytes (ESC + letter) a pty can
	// split across reads. The host is the authority on who owns a chord — `getShortcuts()` logs
	// "Extension shortcut conflicts with built-in shortcut" and skips a chord its table holds
	// (it does so for `ctrl+o`) — and the raw-input listener bound at `session_start` stays as
	// the byte-level path. Both routes go through `openPanelGuarded`, so a keystroke opens one
	// panel.
	//
	// Registration runs in the factory body, i.e. at LOAD: a load-time throw costs the status
	// row, the panel, `/orchestrate` and the `fade_phase` tool at once, so a refused chord SKIPS
	// and never propagates. The fallback chord and `/orchestrate overlay` are the paths that
	// survive a refused chord.
	const registerChord = (key: string, description: string): void => {
		try {
			pi.registerShortcut(key as Parameters<typeof pi.registerShortcut>[0], {
				description,
				handler: async (ctx: ExtensionContext) => {
					await openPanelGuarded(ctx);
				},
			});
		} catch {
			/* the host holds this chord: the listener, the fallback chord and the command path remain */
		}
	};
	registerChord(FADE_KEY, `fade orchestrator panel: tasks, phases, engine metrics, swap history (s/v/r/p/c/h) [${keyLabel(FADE_KEY)}]`);

	// The fallback chord is registered the same way: it is the key that opens the screen when the
	// configured chord collides with a host binding.
	if (!hostConflict(FALLBACK_KEY)) {
		registerChord(FALLBACK_KEY, "fade orchestrator panel: tasks, phases, engine metrics, swap history (s/v/r/p/c/h)");
	}

	// ONE handler, TWO commands. `/plan <goal>` is the PLANNING entry point: it starts the run,
	// whose first act loads THINK_LANE (DS4), and DS4 stays resident through the whole planning
	// turn — the loop issues lane loads ONLY at turn boundaries, and in `planning` state the only
	// authorized hand-back is the `planning_done` phase act, which lands the code lane. No
	// setModel, no `POST /v1/load`, no side-channel flip is issued before the plan lands.
	const orchestrateCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
			// `--demo-redact`: a DISPLAY-only switch, stripped from the args before the verb is
			// read. `/orchestrate --demo-redact <goal>` starts a screenshot-safe run, the bare
			// form flips the switch, and `--demo-redact=off` (or `=0`) turns it back. The durable
			// record — state.json, metrics.jsonl, swap_history.json — is never touched.
			let raw = args.trim();
			const demo = /(?:^|\s)--demo-redact(?:=(on|off|1|0))?(?=\s|$)/.exec(raw);
			if (demo) {
				const off = demo[1] === "off" || demo[1] === "0";
				if (off) delete process.env.FADE_ORCHESTRATE_REDACT;
				else process.env.FADE_ORCHESTRATE_REDACT = "1";
				raw = raw.replace(demo[0], " ").replace(/\s+/g, " ").trim();
				paint(ctx);
				ctx.ui.notify(`orchestrate: demo redaction ${off ? "OFF" : "ON"} — the row, pill and panel mask the account, host, home and repo path (display only)`, "info");
				if (raw === "") return;
			}
			const first = raw.split(/\s+/)[0] ?? "";
			if (first === "status") {
				if (!run) {
					ctx.ui.notify("orchestrate: no run active", "info");
					return;
				}
				const done = run.tasks.filter((t) => t.status === "passed").length;
				const claim = readInstanceLock(instanceLockDir(ROUTER));
				// The claim's age answers the operator's next question: a claim taken seconds ago is a
				// run in flight; one from six hours ago is a session that never ended. An unparseable
				// `started` prints no age rather than a guessed one.
				const started = claim && Number.isFinite(Date.parse(claim.started)) ? Date.parse(claim.started) : NaN;
				const held = Number.isFinite(started) ? ` · held ${formatElapsed(Math.max(0, (Date.now() - started) / 1000))}` : "";
				// The swap cost THIS run paid, from the ledger rows stamped with its run_id. A run
				// that paid no swap says so; it never prints a bare `0s`, which would read as a
				// measured zero for a thing that never happened.
				const cost = runDir ? summarizeSwaps(await readSwaps(runDir), run.run_id) : { count: 0, total_elapsed_s: 0 };
				const paid = cost.count > 0 ? `swaps ${cost.count} · ${cost.total_elapsed_s.toFixed(1)}s paid` : "0 swaps";
				// The verification desk, when the run has one: the batch being collected and the route
				// it will take. A run with no desk file prints nothing here — a bare `0` would read as
				// a measured zero for workers that never delegated.
				const d = runDir ? await readDesk(runDir, run.run_id) : undefined;
				const deskPart = d ? ` · ${deskLine(d)}` : "";
				// The last IN-PROCESS lane call, when one happened: the model and endpoint it named
				// and how it ended. An in-process call never issues `POST /v1/load` and never calls
				// `setModel`, so this line's cost is the elapsed reading alone — a run that made none
				// says so in words, never a bare zero.
				const call = run.lane_call ? ` · in-process ${run.lane_call.model} ${run.lane_call.ok ? `answered ${run.lane_call.chars} chars` : `refused ${run.lane_call.cls}`} · ${(run.lane_call.ms / 1000).toFixed(1)}s` : " · no in-process call";
				ctx.ui.notify(
					`orchestrate ${run.run_id}: ${run.state} · lane ${run.lane} · round ${run.round}/${run.max_rounds} · tasks ${done}/${run.tasks.length} · phases ${run.phases.length} · router claim ${lockDir ? `this run (pid ${process.pid})` : claim ? `pid ${claim.pid} · ${claim.run_id} · ${claim.repo} · ${claim.host}` : "free"}${held} · lease ${run.lease_state ?? "none"}${run.lease_holder && run.lease_state !== "held" ? `(${run.lease_holder})` : run.lease_granted_ttl_s ? `(${run.lease_granted_ttl_s}s)` : ""}${paid}${deskPart}${call} · ${statePath()}`,
					"info",
				);
				paint(ctx);
				return;
			}
			if (first === "runs") {
				// The shelf the start writes. `state.json` is ONE slot, so a finished run is only
				// answerable afterwards from `<dir>/runs/<run_id>.json`: this verb is how the
				// operator reads it. Newest first, five lines: the last runs, not the whole shelf.
				const dir = runDir ?? join(ctx.cwd, "var", "omp-orchestrate");
				const archived = await listRuns(dir);
				if (archived.length === 0) {
					ctx.ui.notify(`orchestrate: no archived runs in ${join(dir, RUNS_DIRNAME)}`, "info");
					return;
				}
				for (const r of archived.slice(0, 5)) {
					ctx.ui.notify(`run ${r.run_id}: ${r.state} · ${r.rounds} rounds · ${r.tasks_passed}/${r.tasks_total} tasks · ${r.goal.replace(/\s+/g, " ").slice(0, 60)}`, "info");
				}
				if (archived.length > 5) ctx.ui.notify(`orchestrate: ${archived.length - 5} more archived runs in ${join(dir, RUNS_DIRNAME)}`, "info");
				return;
			}
			if (first === "moe") {
				// The per-class MoE record (taskmoe.ts): which class of work the swaps were paid
				// for, how often that lane came in WARM from the placement the engine saved, which
				// cards carry the expert tier, and what build this is. Read-only — no lane load, no
				// state write, and every missing measurement is named in its own words.
				const dir = runDir ?? join(ctx.cwd, "var", "omp-orchestrate");
				for (const c of classWarmth(await readSwaps(dir))) {
					ctx.ui.notify(`orchestrate: ${c.cls}: ${c.swaps} swaps · ${c.warm}/${c.swaps} warm · profile ${c.profile ?? "none named"}`, "info");
				}
				const snap = (await fetchMetrics()) ?? metrics;
				if (snap) metrics = snap;
				for (const r of moeBalanceRows([THINK_LANE, CODE_LANE], {
					...(process.env.FADE_ORCHESTRATE_BASALT_CONFIG ? { configPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG } : {}),
					healthByLane: snap?.loaded ? { [snap.loaded]: { spill_experts: snap.spill_experts, spill_total: snap.spill_total, spill_bytes_gb: snap.spill_bytes_gb, slots: snap.slots } } : {},
				})) {
					ctx.ui.notify(`orchestrate: ${r.label} · ${r.value}`, "info");
				}
				ctx.ui.notify(`orchestrate: ${versionLine(snap?.engine_version, await packageVersion(), await bundleHash())}`, "info");
				return;
			}
			if (first === "desk") {
				// The verification desk: the batch being COLLECTED, the ones claimed, and the route
				// each took. This is the operator's answer to "why has no lane loaded for the
				// workers?" — the readiness rule prints its own reason, so a batch waiting for its
				// peers is visibly waiting, not silently idle.
				const dir = runDir ?? join(ctx.cwd, "var", "omp-orchestrate");
				const st = run ?? (await readJsonAsync<RunState>(join(dir, STATE_FILENAME)));
				if (!st) {
					ctx.ui.notify(`orchestrate: no run in ${dir}, so there is no desk`, "info");
					return;
				}
				const d = await readDesk(dir, st.run_id);
				if (!d) {
					ctx.ui.notify(`orchestrate: no desk file at ${deskPath(dir)} — no worker has registered a verification request for ${st.run_id}`, "info");
					return;
				}
				const ready = readyToAddress(d, Date.now(), { settleMs: DESK_SETTLE_MS, deadlineMs: DESK_DEADLINE_MS });
				ctx.ui.notify(`orchestrate: ${deskLine(d)} · batch ${d.epoch + 1} open since ${d.open_utc}${d.sealed_utc ? ` · sealed ${d.sealed_utc}` : " · NOT sealed"} · ${ready.reason}`, "info");
				const owed = owedRequests(d);
				if (owed.length > 0) ctx.ui.notify(`orchestrate: ${owed.length} request(s) CLAIMED with NO verdict — owed: ${owed.map((r) => r.id).join(", ")}. Nothing re-opens a claimed batch (desk.ts:214), so the run completes over them and the slices behind them are UNVERIFIED; answer them with fade_verdicts`, "error");
				for (const r of d.requests.slice(-8)) {
					ctx.ui.notify(`  ${r.id} [batch ${r.batch + 1}] ${r.agent}${r.task_id ? `/${r.task_id}` : ""}: ${r.objective.slice(0, 70)} → ${r.verdict ? (r.verdict.accepted ? "ACCEPTED" : "needs_repair") : r.claimed_batch !== undefined ? "claimed, verdict owed" : "collecting"}`, "info");
				}
				for (const a of d.addressed.slice(-4)) ctx.ui.notify(`  batch ${a.batch + 1} addressed ${a.at} routed ${a.routed}: ${a.ids.join(", ")}`, "info");
				if (d.churn) ctx.ui.notify(`orchestrate: CHURN ROUTE in force${d.churn_utc ? ` since ${d.churn_utc}` : ""} — batches go to the ${VERIFIER_AGENT} subagent on ${VERIFIER_MODEL}; /orchestrate lanes reset hands them back to the lane`, "warning");
				return;
			}
			if (first === "think") {
				// ONE IN-PROCESS COMPLETION. The plugin sends the request itself and returns the
				// text: no `setModel`, no `POST /v1/load`, no lane change, in any branch. The
				// residency rule lives in the client (thinklane.ts) — a call naming a model the
				// router does not hold is refused with ZERO bytes sent, because the router answers
				// such a request by swapping the lane, and that 13-25 s is the cost this path exists
				// to avoid. `think <prompt>` uses FADE_ORCHESTRATE_THINK_MODEL;
				// `think <provider/model> <prompt>` names the lane for this one call.
				const parts = raw.split(/\s+/);
				const named = parts[1]?.includes("/") === true;
				const target = named ? parts[1]! : THINK_MODEL;
				const prompt = (named ? parts.slice(2) : parts.slice(1)).join(" ").trim();
				if (!prompt) {
					ctx.ui.notify(`orchestrate: usage /orchestrate think [provider/model] <prompt> — one completion, in process, on the resident lane (default ${THINK_MODEL}); no load, no swap, no lane change`, "info");
					return;
				}
				ctx.ui.setWorkingMessage(`fade_orchestrate: one in-process completion from ${target}…`);
				const called = await askLane(target, prompt, { role: "role:advisor" });
				ctx.ui.setWorkingMessage();
				if (run) {
					run.lane_call = { ok: called.ok, cls: called.cls, model: called.model, endpoint: called.endpoint, ms: called.ms, at: new Date().toISOString(), chars: called.text.length, detail: called.detail };
					await persist();
				}
				if (!called.ok) {
					ctx.ui.notify(`orchestrate: in-process ${called.cls} — ${called.detail}`, "error");
					paint(ctx);
					return;
				}
				const shown = called.text.split(/\r?\n/);
				for (const line of shown.slice(0, 12)) ctx.ui.notify(`  ${line}`, "info");
				if (shown.length > 12) ctx.ui.notify(`  … ${shown.length - 12} more line(s) of the answer elided`, "info");
				ctx.ui.notify(`orchestrate: ${askLabel(called)}`, "info");
				paint(ctx);
				return;
			}
			if (first === "verifier") {
				// The verification agent: the definition that makes a churn-free verification possible,
				// because the host pins a `task` agent's model from its front matter. `install` writes
				// the file into this repo's agent plane with the model resolved HERE, so a model change
				// is an env var plus a re-install, not an edit of a checked-in file.
				const sub = (raw.split(/\s+/)[1] ?? "show").toLowerCase();
				const abs = join(ctx.cwd, verifierAgentPath(ctx.cwd));
				const absWorker = join(ctx.cwd, workerAgentPath(ctx.cwd));
				if (sub === "install") {
					// THE ADVISOR PIN. An advisor on a ROUTER entry pays the 13-25 s pack swap and can
					// load the THINKING lane — the exact churn the subagent route exists to make
					// impossible. Install REFUSES it, and the claim-time probe (`probeVerifierLane`,
					// lane.ts) refuses the route the same way, so an advisor can never reach the
					// router from this plugin; verification swaps stay with the authorized loop.
					if (isRouterModel(VERIFIER_MODEL)) {
						ctx.ui.notify(`orchestrate: verifier install REFUSED: ${VERIFIER_MODEL} is a basalt ROUTER entry — the advisor is pinned OFF the router. Point FADE_ORCHESTRATE_VERIFIER_MODEL at a non-router model (e.g. ninfer-local/coder-gpu1) and re-run.`, "error");
						return;
					}
					// TWO definitions, one act: the verifier (pinned off the router) and the WORKER
					// (whose `tools:` line carries fade_verify, which is what lets it register at all).
					try {
						mkdirSync(join(ctx.cwd, ".omp", "agents"), { recursive: true });
						writeFileSync(abs, verifierAgentMd());
						writeFileSync(absWorker, workerAgentMd());
					} catch (e) {
						ctx.ui.notify(`orchestrate: verifier install FAILED at ${abs}: ${e instanceof Error ? e.message : String(e)}`, "error");
						return;
					}
					ctx.ui.notify(`orchestrate: wrote ${verifierAgentPath(ctx.cwd)} (model ${VERIFIER_MODEL}, pinned off the router) and ${workerAgentPath(ctx.cwd)} (inherits the code lane; its tools carry fade_verify) — the host discovers agent definitions per session, so a live session needs /new to see it`, "info");
					return;
				}
				const installed = existsSync(abs);
				const installedWorker = existsSync(absWorker);
				ctx.ui.notify(`orchestrate: verifier agent ${VERIFIER_AGENT} · model ${VERIFIER_MODEL} · ${abs} ${installed ? "installed" : "NOT installed (/orchestrate verifier install)"}`, installed ? "info" : "warning");
				ctx.ui.notify(`orchestrate: worker agent ${WORKER_AGENT} · inherits the code lane · ${absWorker} ${installedWorker ? "installed" : "NOT installed (/orchestrate verifier install)"} — a worker on an agent whose tools lack fade_verify CANNOT register, so the census waits for a worker that can never arrive`, installedWorker ? "info" : "warning");
				if (installed) ctx.ui.notify(`orchestrate: ${readFileSync(abs, "utf8").split("\n").slice(0, 6).join("\n")}`, "info");
				const probe = await probeVerifierLane();
				ctx.ui.notify(`orchestrate: verifier lane ${VERIFIER_MODEL} claim-time probe: ${probeLabel(probe)}`, probe.ok ? "info" : "error");
				return;
			}
			if (first === "overlay") {
				await openPanelGuarded(ctx);
				return;
			}
			if (first === "handover") {
				if (!run) {
					ctx.ui.notify("orchestrate: no run active", "info");
					return;
				}
				// Condensed, STABLE-FIRST handover (core.handover): the new lane or a resumed
				// session gets goal + phase contract + task definitions as an invariant prefix
				// (high conversation-cache hit) and statuses/rejections/diff as the volatile tail.
				pi.sendUserMessage(await handoverText(run));
				ctx.ui.notify("orchestrate: condensed handover sent", "info");
				return;
			}

			// `/orchestrate lanes reset` — the THRASH BREAKER's release, the verb the halt names.
			// `reset` alone is the run reset, so the lane verb carries its noun (`lane reset` is
			// accepted too). It clears THIS process's flip ledger — the recorder, the badge and the
			// breaker all start from a quiet window — unpauses the loop and lands the lane that was
			// owed when the churn stopped the loop, which is the point: the operator has just dealt
			// with the competing client, and the loop resumes on the lane it was refused.
			if (first === "lanes" || first === "lane") {
				if ((raw.split(/\s+/)[1] ?? "") !== "reset") {
					ctx.ui.notify("orchestrate: `/orchestrate lanes reset` clears the flip ledger and lands the owed lane", "warning");
					return;
				}
				if (!run) {
					ctx.ui.notify("orchestrate: no run active", "info");
					return;
				}
				const owed = pending;
				pending = undefined;
				resetFlipLedger();
				flipBadge = undefined;
				// The churn route is released WITH the ledger: the operator has dealt with the
				// competing client, so batches go back to being answered by the verifier lane.
				if (run?.run_id && runDir) {
					const d = await readDesk(runDir, run.run_id);
					if (d?.churn) {
						await writeJsonAsync(deskPath(runDir), setChurn(d, false));
						ctx.ui.notify(`orchestrate: churn route cleared — verification batches answer on the ${VERIFY_LANE} lane again`, "info");
					}
				}
				run.paused = false;
				run.operator_note = undefined;
				const wanted = owed?.lane ?? run.lane;
				ctx.ui.notify(`orchestrate: flip ledger cleared; landing ${wanted}`, "info");
				await persist();
				paint(ctx);
				void requestLane(wanted, ctx);
				return;
			}
			if (first === "skip" || first === "verify" || first === "reset" || first === "pause" || first === "halt" || first === "code") {
				if (!run) {
					ctx.ui.notify("orchestrate: no run active", "info");
					return;
				}
				const dir =
					first === "skip"
						? actSkip(run, raw.split(/\s+/)[1])
						: first === "verify"
							? actVerify(run)
							: first === "reset"
								? actReset(run)
								: first === "pause"
									? actPause(run, raw.split(/\s+/).slice(1).join(" ") || undefined)
									: first === "halt"
										? actHalt(run)
										: actCode(run);
				await persist();
				paint(ctx);
				ctx.ui.notify(`orchestrate: ${dir.note}`, "info");
				if (!run.paused && pending) {
					const deferred = pending;
					pending = undefined;
					requestLane(deferred.lane, ctx);
				}
				if (dir.next) requestLane(dir.next, ctx);
				return;
			}
			if (first === "stop") {
				if (!run) {
					ctx.ui.notify("orchestrate: no run active", "info");
					return;
				}
				if (TERMINAL[run.state] !== true) {
					run.state = "stopped";
					// The SYNC write, kept on purpose for this ONE site: `stop` is the run's shutdown
					// path and the session can close in the same keystroke, so the terminal state is
					// durable before this command returns, with no write left in flight.
					if (runDir) writeJson(statePath(), run);
				}
				releaseLock();
				releaseLaneLease();
				pending = undefined;
				// The hand-back: a stop is the end of the run's role, so neither advisor lane is left
				// resident. Quiet — no briefing for a lane nobody asked for.
				const handBack = run.lane !== CODE_LANE;
				if (handBack) requestLane(CODE_LANE, ctx, true, true);
				ctx.ui.notify(`orchestrate: stopped; ${handBack ? `handing the lane back to ${CODE_LANE}` : `resident lane left as ${run.lane}`}; state ${statePath()}`, "info");
				if (raw.includes("--clear")) {
					try {
						unlinkSync(join(runDir!, ACTIVE_FILENAME));
					} catch {}
					run = undefined;
				}
				return;
			}
			if (isDelegatedSession()) {
				// A worker session never STARTS a run: the run belongs to the session that started it.
				ctx.ui.notify("orchestrate: this is a delegated (subagent) session — the run belongs to the session that started it, so /orchestrate <goal> is refused here", "warning");
				return;
			}
			if (run && TERMINAL[run.state] !== true) {
				ctx.ui.notify(`orchestrate: run ${run.run_id} is still ${run.state}; /orchestrate stop first`, "warning");
				return;
			}
			let rounds = DEFAULT_ROUNDS;
			let goal = raw;
			const roundsMatch = /^--rounds\s+(\S+)\s*/.exec(raw);
			if (roundsMatch) {
				rounds = Number(roundsMatch[1]);
				if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) {
					ctx.ui.notify(`orchestrate: --rounds takes a whole number 1..${MAX_ROUNDS}`, "warning");
					return;
				}
				goal = raw.slice(roundsMatch[0].length).trim();
			}
			if (goal === "" || goal.startsWith("--")) {
				ctx.ui.notify("orchestrate: usage /orchestrate [--rounds N] <goal>", "warning");
				return;
			}
			// The router is claimed BEFORE the lane load and before a byte of state is written: a
			// refused start pays no 13-25 s pack load and leaves no half-run. The claim is per ROUTER,
			// so two sessions driving one router from two checkouts meet at one file — one resident
			// lane, one live-turn ledger, one flip guard.
			const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z").replace("T", "T")}-${Math.random().toString(36).slice(2, 6)}`;
			const repo = ctx.cwd;
			const claimDir = instanceLockDir(ROUTER);
			const claim = acquireInstanceLock(claimDir, { run_id: runId, repo });
			if (!claim.ok) {
				ctx.ui.notify(
					`orchestrate: the router ${ROUTER} is claimed by pid ${claim.holder.pid} — run ${claim.holder.run_id} in ${claim.holder.repo} on ${claim.holder.host}${claim.stale ? "; its owner died in the same instant as the reclaim, so that instance holds the router" : ""}. End that run (\`/orchestrate stop\` there) or point this session at another router (FADE_ORCHESTRATE_ROUTER / FADE_ORCHESTRATE_LOCK_DIR). Nothing was written.`,
					"error",
				);
				return;
			}
			lockDir = claimDir;
			// A non-git run root is knowable at this keystroke and changes what the loop can prove; say it
			// now, not two rounds later as a wall of red `blocked` rows: in a non-git root the phase
			// synthesizer has no git evidence at all, so every task lands `blocked`.
			if (!(await isGitRepo(repo))) ctx.ui.notify(`orchestrate: ${await gitCaveat(repo)}`, "warning");
			ctx.ui.setWorkingMessage(`fade_orchestrate: loading ${THINK_LANE} on the router…`);
			// A lane load starts here: drop the cached `/proc` placement proof (moe.ts) so nothing
			// The :18014 lane is a single-authority lease. Acquire it as the prod
			// authority BEFORE the first pack load: a peer orchestration that holds
			// it (409 lease_not_holder) is refused here, so two sessions serialize on
			// the lane instead of one swapping out the other's planning pack.
			// One process can hold at most ONE lease on the lane: the verify capability (a review
			// turn's) is a DIFFERENT (caller, session) pair, and `AdmitLease` refuses a cross-pair
			// claim as `lease_held` — against this very session. Return it, then claim as the run.
			await returnVerifyLease();
			const lease = await acquireLaneLease(THINK_LANE, runId, ctx);
			if (!lease.ok) {
				releaseLock();
				ctx.ui.notify(`orchestrate: the :18014 lane lease is held — ${lease.line}. End the holding run there, then start here. Nothing was written.`, "error");
				return;
			}
			// in this run reads a pre-load engine state.
			const loaded = await loadLane(THINK_LANE, { leaseToken, sessionId: runId });
			if (!loaded.ok) {
				// A start that never began releases its claim: a preflight failure must not strand
				// the router behind a run that does not exist.
				releaseLock();
				releaseLaneLease();
				ctx.ui.notify(`orchestrate: preflight failed loading ${THINK_LANE} (${loaded.detail}); nothing written`, "error");
				return;
			}
			// The lease is held from the acquire through the preflight: a refusal, a throw, an
			// early return — the burst releases it, so the lane is never pinned by a run that
			// never started. `burstLive` flips only when the run is created.
			// The pin and the planning briefing go out WITH the load, in one act: the proof is not a
			// gate in front of them. The planning briefing IS the completion that waits —
			// `before_agent_start` holds the run's first turn until the lane serves
			// `${PROVIDER}/${THINK_LANE}`, refreshing the working message on the keep-alive clock.
			// Proving first left a started run sitting on the previous pack for the whole load.
			let burstLive = false;
			// `state.json` is ONE slot: this keystroke overwrites the run it adopted, and the finished
			// one is then unanswerable. Archive a TERMINAL previous run into ITS repo's `runs/` dir
			// first, so the record stays with the tree it was paid on. A run that is not terminal is
			// left alone — a run live in another session is not this keystroke's to rewrite.
			const previous = run;
			runDir = join(repo, "var", "omp-orchestrate");
			if (previous && TERMINAL[previous.state] === true) {
				const archived = await archiveRun(join(previous.repo || repo, "var", "omp-orchestrate"), previous);
				if (archived) ctx.ui.notify(`orchestrate: the finished run ${previous.run_id} is archived at ${archived}`, "info");
			}
			run = {
				key: STATE_KEY,
				run_id: runId,
				goal,
				repo,
				max_rounds: rounds,
				round: 1,
				state: "planning",
				lane: THINK_LANE,
				checks: [],
				tasks: [],
				phases: [],
				repair_tasks: [],
				rejection_history: [],
				schema_retries: 0,
				started_utc: new Date().toISOString(),
			};
			burstLive = true;
			settledNotified = false;
			await writeJsonAsync(join(runDir, ACTIVE_FILENAME), { run_id: runId, repo, goal, started_utc: run.started_utc, max_rounds: rounds });
			await persist();
			const model = ctx.modelRegistry.find(PROVIDER, THINK_LANE);
			if (!model) {
				fail(ctx, `model ${PROVIDER}/${THINK_LANE} is not in the registry; run written but not started`);
				return;
			}
			const switched = await pi.setModel(model);
			if (switched !== true && (switched as unknown as { switched?: boolean } | null)?.switched !== true) {
				fail(ctx, `setModel(${PROVIDER}/${THINK_LANE}) did not switch: ${JSON.stringify(switched)}`);
				return;
			}
			pi.setThinkingLevel(THINKING[THINK_LANE]);
			paint(ctx);
			startMetricsTimer();
			await ensurePhaseTool();
			pi.sendUserMessage(await briefings.plan(run));
	};
	pi.registerCommand("orchestrate", {
		description: `One session, three basalt lanes: ${THINK_LANE} plans, ${VERIFY_LANE} verifies, ${CODE_LANE} codes. /orchestrate [--rounds N] [--demo-redact] <goal> | status | overlay | runs | moe | desk | think [model] <prompt> | verifier [install] | skip [Tn] | verify | reset | lanes reset | pause [note] | code | halt | stop [--clear]`,
		handler: orchestrateCommand,
	});
	pi.registerCommand("plan", {
		description: `/plan [--rounds N] <goal> — load ${THINK_LANE} (DS4) and plan: DS4 stays resident for the whole planning turn; the only hand-back is the \`planning_done\` phase act`,
		handler: orchestrateCommand,
	});

	pi.on("session_start", async (_event, ctx) => {
		// A delegated session NEVER adopts the run: the loop, its nudges, its lane loads and its
		// ledger belong to the session that owns the run. Adoption drives the router from a
		// session that does not own it — double lane loads with zero tokens served.
		if (isDelegatedSession()) return;
		await ensurePhaseTool();
		// Bind the chord for this session. A delegated worker never binds it: the keystroke is global
		// to the terminal, and the panel belongs to the session that owns the run.
		if (RAW_DELIVERABLE && !inputUnsub) {
			inputUnsub = ctx.ui.onTerminalInput((data) => {
				if (data !== CHORD || panelOpen) return undefined;
				void openPanelGuarded(ctx);
				return { consume: true };
			});
		}
		// AT MOST one line per login, and NOTHING on a free chord with no run: the operator knows
		// the commands. A delivered chord is never explained; only an undeliverable configured
		// control chord earns a clause, riding on the adopted run's own line. Detail is
		// `/orchestrate status`, the panel, and `docs/OVERLAY.md`.
		const chordNote = resolveChord();
		const repo = ctx.cwd;
		const active = await readJsonAsync<{ run_id?: string }>(join(repo, "var", "omp-orchestrate", ACTIVE_FILENAME));
		const state = await readJsonAsync<RunState>(join(repo, "var", "omp-orchestrate", STATE_FILENAME));
		let runNote: string | undefined;
		if (active && state) {
			runDir = join(repo, "var", "omp-orchestrate");
			run = normalizeRun(state);
			settledNotified = false;
			paint(ctx);
			startMetricsTimer();
			if (TERMINAL[state.state] === true) {
				runNote = `run ${state.run_id} is ${state.state} (${statePath()})`;
			} else if (process.env.FADE_ORCHESTRATE_AUTO_RESUME === "1") {
				// The auto-resume ACT stays; only its second notify is gone — the fact rides on the
				// same line as everything else the login says.
				setTimeout(async () => {
					const idle = typeof ctx.hasPendingMessages === "function" ? !ctx.hasPendingMessages() : true;
					if (idle && ctx.isIdle()) pi.sendUserMessage(await handoverText(state));
				}, 250);
				runNote = `run ${state.run_id} is ${state.state} — condensed handover sent (FADE_ORCHESTRATE_AUTO_RESUME=1)`;
			} else {
				runNote = `run ${state.run_id} is ${state.state} — /orchestrate handover sends the condensed state`;
			}
		}
		const line = [chordNote, ...ENV_NOTICES.map((n) => `lanes: ${n}`), runNote].filter((n): n is string => n !== undefined).join(" · ");
		if (line !== "") {
			// The FIRST notify of a session is swallowed by the host's TUI attach (measured in the
			// pty rig: the disclosure fired at `session_start` never reached the scrollback, while a
			// notify ~20 lines later in the same hook rendered every time). Deferring past the attach
			// is the remedy; the flags above are set synchronously, so it can never double-print.
			const at = setTimeout(() => ctx.ui.notify(`orchestrate: ${line}`, "info"), 500);
			at.unref?.();
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		// The runtime is live by the first turn, so this is the safe retry point for the phase tool.
		if (!(await ensurePhaseTool())) setTimeout(() => void ensurePhaseTool(), 500);
		paint(ctx);
		void refreshMetrics().then(() => paint(ctx));
	});

	// AUTO-SYNC: every screen follows the RESIDENT pack. The daemon's residency — not
	// this screen's model line — is the authority on what :18014 answers. A human-cli
	// swap (the operator outranks every lease) or a peer's leased swap changes the
	// served pack under every open session, and a turn that names the old pack is a
	// `404 The model '<old-pack>' does not exist`. One bounded residency read per turn:
	// a match costs nothing; a mismatch lands the resident pack in-memory before the
	// turn's first request. A screen that OWNS the lease lands its own model at the
	// boundary, so the sync reads the same pack — it never hijacks a lane this process
	// did not move, and it never touches a screen whose model is not a basalt pack.
	// Delegated sessions never touch it: their parent's run owns the lane.
	const syncLanePin = async (ctx: ExtensionContext): Promise<void> => {
		if (isDelegatedSession()) return;
		const res = await getResidency(leaseSession || verifyLeaseSession || SELF_SESSION);
		if (!res || res.state !== "RESIDENT" || !res.pack) return;
		// The daemon speaks PACK KEYS; the registry and the status bar speak MODEL IDS, and
		// `laneSyncTarget` maps through the one helper so no call site renames by hand. The pin
		// follows the resident pack ONLY when that pack is the lane this screen's work is owed:
		// a swap drains for tens of seconds, and pinning the pack that is still resident in that
		// window is the measured defect — the run asks for `deepseek`, the sync lands
		// `flash-next`, and the first completion never names the guest. `pendingVerifyLane` is
		// declared below with `let`; this hook only fires after the factory body has run, so the
		// reference is safe.
		const owed = run ? (pending?.lane ?? switchingTo ?? run.lane) : (switchingTo ?? pendingVerifyLane);
		const target = laneSyncTarget(res.pack, owed);
		if (target === undefined) {
			ctx.ui.notify(`lane sync: ${res.pack} is resident while this work owes ${owed} — the pin stays (the swap is draining)`, "info");
			return;
		}
		if (ctx.model?.provider !== PROVIDER || ctx.model.id === target) return;
		const model = ctx.modelRegistry.find(PROVIDER, target);
		if (!model) return;
		const switched = (await pi.setModel(model)) as unknown as boolean | { switched?: boolean } | undefined;
		if (switched === true || (typeof switched === "object" && switched !== null && switched.switched === true))
			ctx.ui.notify(`lane sync: ${PROVIDER}/${target} (${res.pack}) is resident — this screen follows`, "info");
	};

	/**
	 * The Basalt-shaped hold on the completion, the last thing before the host posts.
	 */
	const holdForServedPin = async (ctx: ExtensionContext): Promise<void> => {
		if (isDelegatedSession()) return;
		// THE COMPLETION WAITS, THE WAY BASEALT'S ROUTER WAITS. The pin went out with the load at
		// the boundary that asked for the lane; a swap on this box REPLACES the `:18014` process, so
		// posting here would name an id that server does not carry and answer
		// `404 The model '<id>' does not exist` — the measured halt. Basalt's rule, copied: the
		// loaded model runs at once; a client waits through a swap and is never refused for it; a
		// name the server does not carry is a 404; a failed load answers with a 503 naming the
		// model. So: ONE read, and a match posts at once. A mismatch HOLDS, refreshing the working
		// message on the 10 s keep-alive with the router's own percent, to the end of the daemon's
		// readiness window — never a client timeout, and never a 404 for a configured lane.
		if (ctx.model?.provider !== PROVIDER) return;
		const pinned = ctx.model.id;
		if (!isServedLane(pinned)) return; // Basalt's "any other name": the host's 404, not ours to hold
		const served = await servedIdentity();
		if (served?.id === pinned) return; // the loaded model runs at once: one read, no waiting
		ctx.ui.setWorkingMessage(`fade_orchestrate: ${pinned} is not serving yet (the lane answers ${served?.id ?? "nothing"}) — this request waits, it does not time out`);
		const hold = await laneServeHold(pinned, { pollMs: LANE_POLL_MS, progress: (m) => ctx.ui.setWorkingMessage(m) });
		ctx.ui.setWorkingMessage();
		if (hold.ok) return;
		// Not serving at the end of the window, or a load the router declares FAILED (the 503
		// class): name the model, and never post a completion that 404s on a pack that never came
		// up. The session follows what the lane DOES serve when that is a configured lane; the owed
		// pack stays owed in `pending`/`switchingTo`, so the next boundary pays it again.
		const fall = hold.served_id !== undefined && isServedLane(hold.served_id) ? hold.served_id : undefined;
		ctx.ui.notify(`orchestrate: ${pinned} is not serving — ${hold.reason}; the lane answers ${hold.served_id ?? "nothing"}${fall ? ` — this turn runs on ${fall}, the owed pack stays owed` : " — nothing was posted"}`, hold.failed ? "error" : "warning");
		if (fall) {
			const fm = ctx.modelRegistry.find(PROVIDER, fall);
			if (fm) await pi.setModel(fm);
		}
	};

	// AUTO-SYNC, then THE HOLD. The sync may land the resident pack; the hold then judges the pin
	// the screen is left with. The sync's early returns are the helper's, so the draining swap —
	// the case that answers 404 — reaches the hold instead of returning past it.
	pi.on("before_agent_start", async (_event, ctx) => {
		await syncLanePin(ctx);
		await holdForServedPin(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		// A delegated (subagent) session NEVER drives the loop: no protocol ladder, no nudges,
		// no lane moves, no counters. The run in this closure belongs to the session that adopted
		// it; a worker's turn ending is that session's business, not the worker's (gate_rig 15).
		if (isDelegatedSession()) return;
		if (!run) {
			// THE NON-RUN VERIFICATION MOVE. The verdict act recorded during the turn is paid
			// here: one `setModel` + load through `requestLane`, so the pin and the lane move
			// together. The hand-back rule below is deliberately skipped for THIS boundary — the
			// task's own turns must run on the thinking pack — and the next boundary, where the
			// session is on the thinking lane, hands the code lane back. A `dev` build claim is
			// refused the lease by the daemon (dev_build_no_evict), so a session that never claimed
			// authority pays nothing here beyond a residency read.
			if (!isDelegatedSession() && pendingVerifyLane) {
				const want = pendingVerifyLane;
				pendingVerifyLane = undefined;
				traceTrigger("paid", want, undefined, ctx);
				ctx.ui.notify(`lane on verification: ${want} — the verdict act lands at the turn boundary`, "info");
				// The quiet flag means "no run briefing", and a plain session has no run — which
				// is why this call carried `quiet: true` while the plain landing was silent. It is
				// not silent now: the plain verify landing has its page, and this move IS its
				// briefing. The discriminator is the pack the SESSION sits on:
				//  - on a CODE pack, the session delegated the verdict and must ANSWER it on the
				//    advisor pack → the page is owed;
				//  - already on a THINKING pack, the host resolved the verdict role itself and the
				//    move is bookkeeping → quiet, as the superseded-pair contract keeps it.
				const briefs = ctx.model?.provider === PROVIDER && !isThinkingLane(ctx.model.id);
				requestLane(want, ctx, !briefs);
				return;
			}
			// THE NON-RUN HAND-BACK. A session whose turn ran on the planning or advisor lane hands
			// the lane back at the boundary: one `setModel` + load, no briefing, no run state. The
			// forward direction is the host resolving the verdict role onto the advisor lane; the
			// reverse is here. Delegated
			// sessions never touch the lane — their parent's run owns it.
			if (!isDelegatedSession() && ctx.model?.provider === PROVIDER && isThinkingLane(ctx.model.id)) requestLane(CODE_LANE, ctx, true, true);
			return;
		}
		const next = pending;
		pending = undefined;
		if (!next) {
			paint(ctx);
			if (TERMINAL[run.state] === true) {
				if (!settledNotified) {
					settledNotified = true;
					ctx.ui.notify(briefings.final(run), "info");
				}
				void recordTurn(run.state);
				// The verdict is spent: hand the lane back instead of leaving an advisor pack resident.
				if (run.lane !== CODE_LANE) requestLane(CODE_LANE, ctx, true, true);
				return;
			}
			if (run.paused === true) {
				ctx.ui.notify(`orchestrate: paused at round ${run.round} — no nudge sent, no lane loaded; [p] resumes`, "info");
				void recordTurn("paused");
				return;
			}
			// The desk dispatch comes BEFORE the protocol ladder: a closed verification batch is real
			// work this boundary owes, and nudging a lane about a missing `fade_phase` while workers
			// sit answered-but-unclaimed is the loop arguing with itself.
			if (await dispatchDeskBatch(ctx)) {
				void recordTurn("verification_batch");
				return;
			}
			// Tier-1 protocol gate. A turn that ends with no accepted fade_phase is PROTOCOL
			// debt: `round`/`max_rounds` never move, and while the offending lane is the resident
			// one a nudge costs nothing (no swap). Three tiers, counted in `stall_count`.
			const tier = classifyTurnEnd(run, false);
			if (tier === "nudge") {
				pushRejection(run, "protocol", `turn ended in state ${run.state} with no fade_phase call (nudge ${run.stall_count}/${STALL_SYNTHESIZE_AT})`);
				await persist();
				paint(ctx);
				ctx.ui.notify(`orchestrate: protocol nudge ${run.stall_count}/${STALL_SYNTHESIZE_AT} — round ${run.round} unspent, no swap paid`, "warning");
				await ensurePhaseTool();
				pi.sendUserMessage(briefings.nudge(run));
				void recordTurn("nudge");
				return;
			}
			if (tier === "synthesize" && (run.state === "coding" || run.state === "repair")) {
				// Tier-2: the result is built from what the machine can prove — the plan's own
				// checks (exit codes) and git. A RED gate keeps the coder lane resident, exactly
				// like the tool's pre-swap gate: the swap is paid only for a green tree.
				await gateChecks(ctx);
				const gate = run.checks.length > 0 ? await runGateLogged(run.checks, run.repo, ctx) : undefined;
				if (gate) run.gate_last = gate;
				if (gate && !gate.passed) {
					const failing = gate.results.filter((r) => !r.ok);
					pushRejection(run, "task", `synthesized round refused: pre-swap gate red: ${failing.map((f) => f.cmd).join(" | ")}`);
					await persist();
					paint(ctx);
					pending = { lane: CODE_LANE, phase: "gate" };
					settledNotified = false;
					await ensurePhaseTool();
					pi.sendUserMessage(briefings.gate(run));
					void recordTurn("gate_red");
					return;
				}
				const syn = await synthesizeCodingDone(run, run.repo);
				pushRejection(run, "protocol", `coding_done SYNTHESIZED from git status/diff + gate exit codes after ${run.stall_count} phase-less turns`);
				const applied = applyPhase("coding_done", { done: syn.done });
				await persist();
				paint(ctx);
				ctx.ui.notify(`orchestrate: coding_done synthesized from git + gate (round ${run.round}); the verifier swap is paid once`, "warning");
				void recordTurn("synthesized");
				settledNotified = false;
				requestLane(applied.next, ctx);
				return;
			}
			if (tier === "stall") {
				// Tier-3 circuit breaker: halt cleanly, ZERO lane loads, state + diagnostic durable.
				const stalledFrom = run.state;
				run.state = "stalled_protocol_error";
				run.paused = true;
				run.reason = `${run.protocol_retries ?? 0} turn(s) ended with no fade_phase call from state ${stalledFrom}`;
				pushRejection(run, "protocol", `circuit breaker: ${run.reason}`);
				await persist();
				paint(ctx);
				ctx.ui.notify(await briefings.stalled(run), "error");
				void recordTurn("stalled_protocol_error");
				return;
			}
			// A phase-less turn in a state git cannot speak for (planning, verifying): nudge harder,
			// with the schemas attached, and never spend a round.
			pushRejection(run, "protocol", `turn ended in state ${run.state} with no fade_phase call (tier ${tier})`);
			await persist();
			paint(ctx);
			await ensurePhaseTool();
			pi.sendUserMessage(`${briefings.nudge(run)}\n${SCHEMA_HINT}`);
			void recordTurn("nudge");
			return;
		}
		if (run.paused === true) {
			// [p] between rounds: the lane load is DEFERRED, not dropped — resuming pays it.
			pending = next;
			paint(ctx);
			ctx.ui.notify(`orchestrate: paused — the ${next.lane} load is deferred until [p]/[c] resumes`, "info");
			void recordTurn("paused");
			return;
		}
		classifyTurnEnd(run, true);
		void recordTurn(turnPhase ?? next.phase);
		// THE SINGLE LOAD SITE, at the turn boundary: the previous turn is closed, so nothing is
		// queued at the router naming the lane we are leaving — that queue is what flips the lane
		// back seconds after a swap. `requestLane` puts the switch on the serial chain (ONE switch at
		// a time), where the idle gate can defer it and the thrash breaker can refuse it outright;
		// `loadLane` settles an in-flight swap and refuses to reload the resident entry, so a round
		// that wants the lane already resident pays 0 s.
		requestLane(next.lane, ctx);
	});

	// Enforcement: the verifier lane is read-only. An edit/write/apply_patch attempted while the
	// thinking lane holds the run is refused with the rule named, so the fix is DELEGATED back
	// to the coder instead of silently applied by the verifier. The sandbox is the denylist
	// (`MUTATING_TOOLS`), not an allowlist: a host tool this file has never seen cannot slip a
	// write past it. `task` is NOT refused — it writes nothing itself, its spawned sessions are
	// inert by `isDelegatedSession`, and refusing it would only block the coding session that
	// owns the run.
	// One move per target per session: the trigger is idempotent, and `moveLane` re-reads
	// residency every call, so a lane that is already there costs one read and zero bytes.
	// The verdict act seen in this turn, paid at the next boundary; cleared when paid.
	let pendingVerifyLane: string | undefined;

	// The trigger's two seams, written to the plugin's existing state root. Print mode shows no
	// `ctx.ui.notify`, so the file is the only honest way to tell "the act was recorded" from
	// "the boundary paid it" — and to separate a code defect from a harness limitation.
	const traceTrigger = (phase: string, lane: string | undefined, tool: string | undefined, context: ExtensionContext): void => {
		const dir = join(process.env.HOME ?? "/tmp", "var", "fade-orchestrate");
		void writeJsonAsync(join(dir, "lane-trigger.json"), {
			at: new Date().toISOString(),
			phase,
			lane,
			tool,
			pid: process.pid,
			model: context.model ? `${context.model.provider}/${context.model.id}` : undefined,
		}).catch(() => undefined);
	};

	pi.on("tool_call", async (event: { toolName?: string; input?: Record<string, unknown> }, ctx: ExtensionContext) => {
		// The move goes through `requestLane`: the plugin's ONE proven sequence — idle gate, churn
		// breaker, `pi.setModel`, `setThinkingLevel`, the lease-minting load. Calling the supervisor
		// module's `moveLane` directly moves the LANE and leaves the session's model pin on the pack
		// that is gone: measured live at 15:56, the swap landed on deepseek and the very next turn of
		// the session that asked for it died with `404 The model 'flash-next' does not exist`. The pin
		// and the lane move together, or the feature is an outage. `lastVerifyLane` keeps it one move
		// per target per session, and the daemon's floors stay the authority: a `dev` build claim is
		// refused the lease (dev_build_no_evict), so a session that never claimed authority cannot
		// move the lane from here either.
		if (!isDelegatedSession()) {
			// Record the verdict act; the lane is paid at the boundary below. Moving mid-turn is
			// what broke at 15:56: the swap landed on deepseek while the session was still
			// streaming, and its next request named the pack that was gone —
			// `404 The model 'flash-next' does not exist`. A model switch and a load belong at a
			// turn boundary, which is where `agent_end` already does the hand-back.
			const trig = verifyTrigger(event.toolName, event.input);
			const trigLane = "lane" in trig ? trig.lane : undefined;
			if (trigLane) pendingVerifyLane = trigLane;
			traceTrigger("recorded", trigLane, event.toolName, ctx);
		}
		// The delegation census, recorded on the desk BEFORE the worker starts: how many workers this
		// `task` call carries, and how many of them carry VERIFICATION work. That count is what the
		// open batch waits for (`expected`), and it is the whole batching rule: a worker that
		// registers early is told `not ready`, because its peers are named by this call and have not
		// registered yet. A call that carries no verification work is not counted at all — nothing
		// will register for it, and an `expected` it set would keep a batch open to the deadline.
		if (!run || !runDir || isDelegatedSession()) return undefined;
		// The desk is claimed at ANY owner tool call, not only at a turn boundary. Measured live: the
		// owner delegated two verifying workers, they blocked in `fade_verify` waiting for the verdict
		// the owner must answer, the owner blocked in `wait` on them, and `agent_end` therefore NEVER
		// arrived — the batch sat `registered == expected` with an empty `addressed`: the loop's own
		// verification deadlocked. `dispatchDeskBatch` is its own throttle: no run, no desk, no LIVE
		// request (a claimed batch is not live) or an OPEN batch all return with zero lane load, so a
		// check per tool call is one small file read. No closure flag: a flag set by a batch that is
		// never answered (halted, paused) would mute this for the rest of the session.
		if (await dispatchDeskBatch(ctx)) return undefined;
		if (event.toolName === "task") {
			const batch = taskBatchOf(event.input);
			if (batch.carriesVerification) {
				await mutateDesk(runDir, run.run_id, (d) => noteTaskBatch(d, { count: batch.verifyAgents.length, agents: batch.verifyAgents }));
				// Measured in a live run: a `scout` worker registered, a read-only `reviewer` ran the
				// checks and NEVER registered, so the batch waited on a worker that could not arrive. The
				// census says so at the launch, naming the agent that carries the tool by definition.
				const notWorker = batch.verifyAgents.filter((a) => a !== WORKER_AGENT);
				ctx.ui.notify(
					`orchestrate: task call carries ${batch.count} worker(s), ${batch.verifyAgents.length} with verification work — the desk batch closes at ${batch.verifyAgents.length} registration(s)${notWorker.length > 0 ? `; ${notWorker.join(", ")} ${notWorker.length > 1 ? "do" : "does"} not carry \`fade_verify\` by definition, so ${notWorker.length > 1 ? "they may" : "it may"} run the checks and never register — launch verification workers as "${WORKER_AGENT}" (/orchestrate verifier install)` : ""}`,
					notWorker.length > 0 ? "warning" : "info",
				);
			}
			return undefined;
		}
		// The guard reads the ON-DISK run, not this session's copy: a session started before a
		// lane change would otherwise enforce a lane that no longer exists, with no way to
		// unblock the session. Enforcement is the VERIFIER'S TURN only — `state: verifying` is
		// the state the row names — and never inside a delegated session, which is inert by
		// `isDelegatedSession`. The read is `liveState`: this hook fires on EVERY tool call, and
		// its whole-file `readFileSync` + parse of `state.json` was a per-keystroke stall of the
		// host's loop; the mtime guard makes a steady run pay one `stat`.
		const live = await liveState();
		if (!live || live.state !== "verifying" || !isThinkingLane(live.lane)) return undefined;
		const name = event.toolName ?? "";
		if (MUTATING_TOOLS[name] !== true) return undefined;
		pushRejection(run, "task", `verifier sandbox: ${name} refused on the thinking lane (read-only); the fix is delegated to the coder`);
		await persist();
		return { block: true, reason: `fade_orchestrate: the verifier lane is read-only — ${name} is refused. Report the finding with fade_phase; the coder lane applies it.` };
	});

	// The `task` call SETTLED: every worker it carried has run, so every registration it was ever
	// going to produce is on the desk. That is the seal — the batch is closed by the launching
	// call's own lifetime, which is the strongest available proof that no peer is still to come.
	// The seal makes the batch addressable at the next turn boundary; it never dispatches a lane
	// load from inside a tool result, because a load issued mid-turn is the queued-request pattern
	// the router answers by swapping BACK.
	pi.on("tool_result", async (event: { toolName?: string; isError?: boolean }, ctx: ExtensionContext) => {
		if (event.toolName !== "task" || !run || !runDir || isDelegatedSession()) return undefined;
		const desk = await readDesk(runDir, run.run_id);
		if (!desk || openRequests(desk).length === 0) return undefined;
		const sealed = sealBatch(desk);
		await writeJsonAsync(deskPath(runDir), sealed);
		const ready = readyToAddress(sealed, Date.now(), { settleMs: DESK_SETTLE_MS, deadlineMs: DESK_DEADLINE_MS });
		ctx.ui.notify(`orchestrate: task call settled — desk batch ${sealed.epoch + 1} sealed with ${openRequests(sealed).length} request(s): ${ready.reason}`, "info");
		return undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearSurface(ctx);
		stopMetricsTimer();
		await returnVerifyLease();
		if (inputUnsub) {
			inputUnsub();
			inputUnsub = undefined;
		}
	});
}
