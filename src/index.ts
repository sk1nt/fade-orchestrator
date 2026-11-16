/**
 * fade_orchestrate: one OMP session, two basalt lanes. (Wiring; the router client is
 * ./router.ts, the schema/validators/briefings are ./core.ts.)
 *
 * The loop is a phase contract, not tool sandboxing: the thinking lane answers with
 * `fade_phase`, and the tool validates, records the phase and ends the turn. `agent_end` is the
 * only `setModel`/load site: the host defers model switches while streaming, and a load issued
 * into a turn's queued requests flips the lane back.
 *
 *   /orchestrate [--rounds N] <goal>   start a run (default 6 rounds, max 6)
 *   /orchestrate status                state, lane, round, tasks, phase log, path
 *   /orchestrate stop [--clear]        mark the run stopped (leave the resident lane)
 *   /orchestrate lanes reset           clear the flip ledger and land the owed lane (the THRASH BREAKER's release)
 *   /orchestrate runs                  the archived finished runs, newest first
 *   Alt+F                              the live panel: tasks, phases, engine metrics, swap cost
 *                                      (keys s/v/r/p/c/h act on the selected task; esc closes)
 *   /lanes                             live router census: both entries + health
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { CODE_LANE, FLIP_WINDOW_MS, PROVIDER, ROUTER, THINK_LANE, THINKING, flipBreaker, flipGuarded, flipState, listLanes, loadLane, observeSwaps, resetFlipLedger, routerBusy, type RouterBusy } from "./router.ts";
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
import { collectScreen, formatElapsed, type ScreenData } from "./screendata.ts";
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

export default function fadeOrchestrate(pi: ExtensionAPI): void {
	let run: RunState | undefined;
	let runDir: string | undefined;
	/** The router claim, taken at a run's start and released at its end. The router carries ONE
	 *  resident lane, ONE live-turn ledger and ONE flip guard, so a second orchestrator on the same
	 *  router is not a concurrency question but a correctness one: each one's pre-swap gate ends up
	 *  judging the other's working tree. */
	let lockDir: string | undefined;
	let pending: { lane: string; phase: string } | undefined;
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
		if (lane === THINK_LANE) {
			verifierTools = active;
			const readOnly = active.filter((t) => MUTATING_TOOLS[t] !== true);
			if (!readOnly.includes("fade_phase")) readOnly.push("fade_phase");
			if (readOnly.length !== active.length) await pi.setActiveTools(readOnly);
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
	 */
	const persist = (): Promise<void> => (run && runDir ? coalesceWrite(statePath(), run) : Promise.resolve());

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
	const gateRouterIdle = async (lane: string, ctx: ExtensionContext): Promise<{ waited_ms: number; polls: number; over_budget: boolean; last: RouterBusy }> => {
		const t0 = Date.now();
		const budget_s = Math.round(GATE_BUDGET_MS / 1000);
		const poll_s = Math.round(GATE_POLL_MS / 1000);
		let polls = 0;
		let last = await routerBusy();
		while (last.busy) {
			polls += 1;
			const waited = Date.now() - t0;
			if (waited >= GATE_BUDGET_MS) return { waited_ms: waited, polls, over_budget: true, last };
			if (polls === 1) ctx.ui.notify(`fade_orchestrate: the ${lane} load is DEFERRED — ${last.reason}; retrying every ${poll_s}s up to ${budget_s}s`, "warning");
			ctx.ui.setWorkingMessage(`fade_orchestrate: ${lane} load deferred ${Math.round(waited / 1000)}s/${budget_s}s — ${last.reason}`);
			await new Promise((r) => setTimeout(r, GATE_POLL_MS));
			last = await routerBusy();
		}
		return { waited_ms: Date.now() - t0, polls, over_budget: false, last };
	};

	// The lane switch as one callable unit: `agent_end` (the single load site) and the overlay's
	// v/c keys run the SAME sequence — the idle gate, the thrash breaker, setModel,
	// setThinkingLevel, the settle-then-load router call, persist, paint, briefing. No
	// queued-request window exists while a slash command runs, so calling it from a command is the
	// same boundary discipline.
	/**
	 * ONE switch at a time. `agent_end`, the panel's v/c keys and a pause-resume can each want a
	 * lane, and two switches running at once is exactly the ping-pong this file exists to stop:
	 * `setModel` + `POST /v1/load` issued twice, `pending` overwritten by the later request, the
	 * swap pill painted by a watch whose switch is already dead, and a briefing sent for a lane a
	 * newer switch has replaced. Every caller goes through `requestLane`: requests queue on
	 * `switchChain` in arrival order and carry a generation, and a link the chain reaches after a
	 * newer request arrived (`gen !== switchGen`) does NOTHING — it never touches the router.
	 */
	let switchGen = 0;
	let switchChain: Promise<void> = Promise.resolve();
	const requestLane = (lane: string, ctx: ExtensionContext): void => {
		const gen = ++switchGen;
		switchChain = switchChain.then(() => (gen === switchGen ? runSwitch(lane, ctx, gen) : undefined)).catch(() => undefined);
	};

	const runSwitch = async (lane: string, ctx: ExtensionContext, gen: number): Promise<void> => {
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
		const gate = await gateRouterIdle(lane, ctx);
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
			await persist();
			paint(ctx);
			ctx.ui.notify(`orchestrate: LANE THRASH — ${flip.flips} swaps in ${flip.window_s}s naming ${who}: the loop is HALTED and paid no load. /orchestrate lanes reset clears the ledger and lands ${lane}.`, "error");
			return;
		}
		const switched = await pi.setModel(model);
		if (gen !== switchGen) return; // a newer request owns the lane: this link is dead
		if (switched !== true && (switched as unknown as { switched?: boolean } | null)?.switched !== true) {
			fail(ctx, `setModel(${PROVIDER}/${lane}) did not switch: ${JSON.stringify(switched)}`);
			return;
		}
		pi.setThinkingLevel(THINKING[lane]);
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
		const watch = startSwapWatch(lane, moe, (percent) => {
			// A superseded switch's watch must never paint: its lane is not the one loading.
			if (gen !== switchGen || !swapPill) return;
			swapPill = { ...swapPill, percent };
			paint(ctx);
		});
		ctx.ui.setWorkingMessage(`fade_orchestrate: loading ${lane} on the router…`);
		const loaded = await loadLane(lane);
		if (gen !== switchGen) {
			// The pill, the row and the briefing belong to the switch that superseded this one; the
			// watch is the only thing here that outlives the call, so it is the thing cancelled.
			watch.cancel();
			return;
		}
		ctx.ui.setWorkingMessage();
		swapPill = undefined;
		if (!loaded.ok) {
			watch.cancel();
			fail(ctx, `loading lane ${lane} failed (${loaded.detail}); briefing not sent`);
			return;
		}
		if (from && runDir && from !== lane) {
			turnSwapMs += Math.round(loaded.elapsed_s * 1000);
			void watch.finish(from, lane, loaded.elapsed_s, runDir, run?.run_id, windowClass(run)).then(() => paint(ctx));
		}
		if (run) run.lane = lane;
		await persist();
		paint(ctx);
		await applyToolPolicy(lane);
		if (gen !== switchGen) return;
		setTimeout(async () => {
			if (gen !== switchGen) return; // the briefing is for the lane that LANDED, never one a newer switch replaced
			await ensurePhaseTool();
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
				// The panel names who holds the router. `readInstanceLock` is a 400-byte read of the
				// claim file, and `null` (absent/parsable-free) is a real answer, not a missing row.
				claim: readInstanceLock(instanceLockDir(ROUTER)) ?? null,
				...(process.env.FADE_ORCHESTRATE_BASALT_CONFIG ? { moeConfigPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG } : {}),
			});
		};
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
			await openPanel(ctx, provider, (a) => actOnPanel(ctx, a), process.env.FADE_ORCHESTRATE_HEADLESS === "1");
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
			return { next: THINK_LANE, nextState: "verifying" };
		}
		const accepted = String(payload.verdict) === "accepted";
		st.phases[st.phases.length - 1].accepted = accepted;
		if (accepted) {
			st.state = "complete";
			return { next: THINK_LANE, nextState: "complete" };
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
			return { next: THINK_LANE, nextState: "failed" };
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
				verification_done: new Set(["verdict", "checks", "notes", "tasks"]),
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
			// An accepted phase is the end of the protocol streak. `round`/`max_rounds` are
			// untouched here — a lane that reports never owes the round budget anything.
			classifyTurnEnd(run, true);
			// A terminal state releases the router claim in the same keystroke, so the next session
			// starts without a manual release. Owner-only: an adopted run holds no claim of its own.
			if (applied.nextState === "complete" || applied.nextState === "failed") releaseLock();
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
					pushRejection(run, "task", `pre-swap gate red: ${failing.map((f) => f.cmd).join(" | ")}`);
					run.state = "coding";
					await persist();
					paint(ctx);
					pending = { lane: CODE_LANE, phase: "gate" };
					settledNotified = false;
					ctx.abort();
					return {
						content: [{ type: "text", text: `pre-swap gate RED (${failing.length}/${gate.results.length} failing); the verifier swap was not paid; fix and re-report coding_done` }],
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
				content: [{ type: "text", text: `phase ${params.phase} recorded; state ${applied.nextState}${checkpointNote}${pending ? `, ${pending.lane} loads at the turn boundary` : "; run terminal, lane left resident"}` }],
				details: { phase: params.phase, state: applied.nextState, next_lane: pending?.lane ?? null, checkpoints: run.checkpoints ?? {} },
			};
		},
	});

	pi.registerCommand("lanes", {
		description: `Live basalt router census on ${ROUTER}: both entries' load state and /health`,
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

	pi.registerCommand("orchestrate", {
		description: `One session, two basalt lanes: ${THINK_LANE} plans/verifies, ${CODE_LANE} codes. /orchestrate [--rounds N] [--demo-redact] <goal> | status | overlay | runs | moe | skip [Tn] | verify | reset | lanes reset | pause [note] | code | halt | stop [--clear]`,
		handler: async (args, ctx) => {
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
				ctx.ui.notify(
					`orchestrate ${run.run_id}: ${run.state} · lane ${run.lane} · round ${run.round}/${run.max_rounds} · tasks ${done}/${run.tasks.length} · phases ${run.phases.length} · router claim ${lockDir ? `this run (pid ${process.pid})` : claim ? `pid ${claim.pid} · ${claim.run_id} · ${claim.repo} · ${claim.host}` : "free"}${held} · ${paid} · ${statePath()}`,
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
				pending = undefined;
				clearSurface(ctx);
				ctx.ui.notify(`orchestrate: stopped; resident lane left as ${run.lane}; state ${statePath()}`, "info");
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
			// in this run reads a pre-load engine state.
			engineProofInvalidate();
			const loaded = await loadLane(THINK_LANE);
			ctx.ui.setWorkingMessage();
			if (!loaded.ok) {
				// A start that never began releases its claim: a preflight failure must not strand
				// the router behind a run that does not exist.
				releaseLock();
				ctx.ui.notify(`orchestrate: preflight failed loading ${THINK_LANE} (${loaded.detail}); nothing written`, "error");
				return;
			}
			const census = await listLanes();
			const resident = census.models.find((m) => m.status === "loaded");
			if (!census.error && resident?.id !== THINK_LANE) {
				releaseLock();
				ctx.ui.notify(`orchestrate: preflight expected ${THINK_LANE} loaded, router reports ${resident ? resident.id : "none"}; nothing written`, "error");
				return;
			}
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
		},
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
		const line = [chordNote, runNote].filter((n): n is string => n !== undefined).join(" · ");
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

	pi.on("agent_end", async (_event, ctx) => {
		if (!run) return;
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
				return;
			}
			if (run.paused === true) {
				ctx.ui.notify(`orchestrate: paused at round ${run.round} — no nudge sent, no lane loaded; [p] resumes`, "info");
				void recordTurn("paused");
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
	pi.on("tool_call", async (event: { toolName?: string }) => {
		// The guard reads the ON-DISK run, not this session's copy: a session started before a
		// lane change would otherwise enforce a lane that no longer exists, with no way to
		// unblock the session. Enforcement is the VERIFIER'S TURN only — `state: verifying` is
		// the state the row names — and never inside a delegated session, which is inert by
		// `isDelegatedSession`. The read is `liveState`: this hook fires on EVERY tool call, and
		// its whole-file `readFileSync` + parse of `state.json` was a per-keystroke stall of the
		// host's loop; the mtime guard makes a steady run pay one `stat`.
		if (!run || isDelegatedSession()) return undefined;
		const live = await liveState();
		if (!live || live.state !== "verifying" || live.lane !== THINK_LANE) return undefined;
		const name = event.toolName ?? "";
		if (MUTATING_TOOLS[name] !== true) return undefined;
		pushRejection(run, "task", `verifier sandbox: ${name} refused on the thinking lane (read-only); the fix is delegated to the coder`);
		await persist();
		return { block: true, reason: `fade_orchestrate: the verifier lane is read-only — ${name} is refused. Report the finding with fade_phase; the coder lane applies it.` };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearSurface(ctx);
		stopMetricsTimer();
		if (inputUnsub) {
			inputUnsub();
			inputUnsub = undefined;
		}
	});
}
