/**
 * fade_orchestrate: one OMP session, two basalt lanes. (Wiring; the router client is
 * ./router.ts, the schema/validators/briefings are ./core.ts. The 2026-11-15 split from the
 * 601-line monolith is behavior-freeze: every string, rule and ordering is carried over.)
 *
 * The loop is a phase contract, not tool sandboxing: the thinking lane answers with
 * `fade_phase`, and the tool validates, records the phase and ends the turn. `agent_end` is the
 * only `setModel`/load site (the host defers model switches while streaming, and a load issued
 * into a turn's queued requests flips the lane back — the 2026-11-14 ping-pong).
 *
 *   /orchestrate [--rounds N] <goal>   start a run (default 6 rounds, max 6)
 *   /orchestrate status                state, lane, round, tasks, phase log, path
 *   /orchestrate stop [--clear]        mark the run stopped (leave the resident lane)
 *   Alt+F                              the live panel: tasks, phases, engine metrics, swap cost
 *                                      (keys s/v/r/p/c/h act on the selected task; esc closes)
 *   /lanes                             live router census: both entries + health
 */
import { unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { CODE_LANE, FLIP_WINDOW_MS, PROVIDER, ROUTER, THINK_LANE, THINKING, flipGuarded, flipState, listLanes, loadLane, observeSwaps, routerBusy, type RouterBusy } from "./router.ts";
import {
	ACTIVE_FILENAME,
	DEFAULT_ROUNDS,
	MAX_ROUNDS,
	MAX_TASKS,
	PLAN_ACT_NOTE,
	PHASE_FOR_STATE,
	STATE_FILENAME,
	STATE_KEY,
	SCHEMA_HINT, STALL_SYNTHESIZE_AT, adaptiveRounds, classifyTurnEnd, normalizeRun, pushRejection, refreshChecks, runGate, sameTaskPlan, synthesizeCodingDone, tagCheckpoint,
	TERMINAL,
	briefings,
	readJson,
	validateChecks,
	validateTasks,
	writeJson,
	type PhaseLog,
	type RunState,
	type Task,
} from "./core.ts";
import { chordBytes, keyLabel, modelLabel, ORCH_STATUS_KEY, OVERLAY_WIDGET_KEY, statusLines, TOP_WIDGET_KEY, type FlipBadge, type SwapPill } from "./ui.ts";
import { actCode, actHalt, actPause, actReset, actSkip, actVerify } from "./keymap.ts";
import { appendTurn, turnRecordOrNull } from "./history.ts";
import { coldHot, fetchMetrics, fetchTurnMetrics, laneBestRate, persistMetrics, startSwapWatch, type MetricsSnapshot } from "./livedata.ts";
import { handoverText } from "./core.ts";
import { laneMoe } from "./moe.ts";
import { openPanel, type PanelAction } from "./panel.ts";
import { collectScreen, type ScreenData } from "./screendata.ts";

// The panel key, chosen by measurement, not by table-guessing. The operator asked for Ctrl+O first;
// the host binds `ctrl+o` to `app.tools.expand` and ACTS on its own bindings, so the screen cannot
// live there. `alt+f` (the operator's second choice) looked free in the strings-extracted default
// table and is NOT: the host's runtime answers `keybinding tui.editor.cursorWordRight` for it
// (measured via `getShortcutConflict`, 2026-11-15), and the pty rig watched ESC f move the cursor
// word instead of opening a panel. `alt+shift+f` (ESC + `F`) answers FREE and is byte-distinct, so
// that is the key. `FADE_ORCHESTRATE_KEY` moves it (`ctrl+<a-z>`, `alt+<a-z>` and
// `alt+shift+<a-z>` have byte forms; `ctrl+shift+<a-z>` does not — shift is invisible inside a
// control code, measured). `FADE_ORCHESTRATE_FALLBACK_KEY` (default `alt+shift+i`, measured FREE,
// ESC + `I`) is the registered companion chord.

// Y10 pre-unload health gate: `POST /v1/load` unloads the RESIDENT lane, and a request queued at
// that instant is answered by the router's own log line `swap flash-next -> deepseek (1 waiting)` —
// 15-20 s and 52-130 GiB paid into a lane that is serving. The gate reads the router's busy surface
// (`routerBusy`) and DEFERS the load: one poll every GATE_POLL_MS (default 3 s) for up to
// GATE_BUDGET_MS (default 60 s) — 20 polls. Both are configuration so a rig can run a whole budget
// in milliseconds; the documented interval/budget is what the box runs.
const GATE_POLL_MS = Number(process.env.FADE_ORCHESTRATE_GATE_POLL_MS ?? 3000);
const GATE_BUDGET_MS = Number(process.env.FADE_ORCHESTRATE_GATE_BUDGET_MS ?? 60_000);
const FADE_KEY = process.env.FADE_ORCHESTRATE_KEY ?? "alt+shift+f";
// The status row's surface. `widget` (the default) docks it above the editor; `status` writes the
// same text to the host's status bar, which is the right choice only for a `statusLine` config that
// placed the `status` segment after the model — the host puts the text wherever the config says, and
// an extension cannot move a segment (measured on this box: `status` sits on the right).
const SURFACE = process.env.FADE_ORCHESTRATE_SURFACE === "status" ? "status" : "widget";

// Y15: the WRITING tools, by NAME. The verifier sandbox is a denylist, not an allowlist, so a host
// tool this file has never seen cannot slip a write past it. Delegation is NOT on the list: `task`
// writes nothing itself, and the sessions it spawns are inert by `isDelegatedSession` — blocking it
// here only ever blocked the operator's own coding session (measured: a `task` call from the
// operator returned "the verifier lane is read-only — task is refused" while the on-disk run sat on
// the thinking lane).
const MUTATING_TOOLS: Record<string, true> = { edit: true, write: true, apply_patch: true, multiedit: true, multi_edit: true, notebook_edit: true };

/**
 * Delegated (subagent) session detector. A subagent loads this extension in the SAME cwd, so an
 * unguarded `session_start` adopts the operator's run into the worker's session and drives the
 * router from a session that does not own it. `PI_SESSION_FILE` separates the two shapes with no
 * configuration: the operator's jsonl sits directly under the project dir; a delegated one is
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
	let pending: { lane: string; phase: string } | undefined;
	/** Y10: the lane switch currently open. A pre-unload deferral keeps it open for the whole gate
	 *  budget, and two overlapping `POST /v1/load` calls are exactly the measured ping-pong. */
	let switching: string | undefined;
	let settledNotified = false;
	let metrics: MetricsSnapshot | undefined;
	let laneBest = 0;
	let metricsTimer: NodeJS.Timeout | undefined;
	/** The raw-input listener that owns the panel chord, its open flag, and the chord's disclosure. */
	let inputUnsub: (() => void) | undefined;
	let panelOpen = false;
	let conflictReported = false;
	/** The chord is settled only when a LIVE probe says so; `probeHasAnswered` distinguishes a real
	 *  "free" from the loading-phase probe that threw (measured: the host dispatches `session_start`
	 *  during extension loading, where the probe throws). */
	let chordResolved = false;
	let probeHasAnswered = false;
	/** True once the disclosure's probe says the configured chord is HELD. The row's key hint reads
	 *  this: a row that advertises `[Ctrl+O]` while ctrl+o runs the host's action is a row that
	 *  advertises a dead key (verifier review 2026-11-15 — the HELD rig state captured exactly that
	 *  on screen while its own assertion read "ctrl+o opens nothing"). The row must name the chord
	 *  that opens the screen, which in the held state is the fallback. */
	let chordHeld = false;
	let turnSeq = 0;
	let turnPhase: string | undefined;
	let turnSwapMs = 0;
	/** The active-tool set captured when the verifier sandbox closed; restored when the code lane loads. */
	let verifierTools: string[] | undefined;
	/** Y21: the lane churn the flip guard observed, as the surfaces render it. `undefined` when
	 *  the window is quiet, so a healthy run never advertises a flip. */
	let flipBadge: FlipBadge | undefined;
	/** The lane the router is loading RIGHT NOW, as the status row renders it. Set by `switchLane`
	 *  for the loop's own swap and refreshed from the swap watch's /health samples, so the row is
	 *  multicolored only while a pack is actually coming in; cleared the moment it lands. */
	let swapPill: SwapPill | undefined;

	const refreshMetrics = async (): Promise<void> => {
		const s = await fetchMetrics();
		if (!s) return;
		metrics = s;
		if (runDir) persistMetrics(runDir, s);
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
	// default is 30 s, the rigs drive 2 s to watch a whole guard window in seconds.
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
	 * Y21: read the router's swap line, then answer the guard question for the lane THIS RUN
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
	// Pill suffix: the measured ramp reads cold (deepseek ~91 against a ~130 steady = 0.70), a
	// loaded lane reads hot; idle reads as nothing.
	const pillSuffix = (): string | undefined => {
		if (!metrics) return undefined;
		const ch = coldHot(metrics.tok_s, laneBest);
		if (ch.label === "idle" || ch.rate === undefined) return undefined;
		return `${ch.label} ${Math.round(ch.rate)}t/s`;
	};

	// Y18: one durable JSONL line per turn, built ONLY from numbers the router reported —
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
		if (rec) appendTurn(runDir, rec);
	};

	// Y15: the thinking lane plans, inspects and runs; it never edits. setActiveTools removes the
	// mutating tools on entry to the verifier lane and restores the captured set when the code lane
	// loads; `tool_call` below is the enforcement layer for anything that still tries.
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
	 * Measured on this host: registerTool() puts fade_phase in the registry (/tools lists it) but
	 * NOT in the active set the model is offered, so every phase briefing must activate it first.
	 *
	 * The action methods are GUARDED during extension loading — omp 18.20.2 throws
	 * "Extension runtime not initialized. Action methods cannot be called during extension
	 * loading." — and the host can dispatch `session_start` before it installs the runtime. That
	 * throw disabled the WHOLE extension (measured 2026-11-15 in both live rigs: every assertion
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
	const persist = (): void => {
		if (run && runDir) writeJson(statePath(), run);
	};

	/** The gate's checks are DATA: read the file, so an on-disk repair reaches the run object.
	 *  Without this the gate is unrepairable in a live session — `state.json` can carry fixed
	 *  commands while the session re-judges the plan's original broken pair (run
	 *  20261115T091232Z-rqtj, two checks, every round). The refresh is announced, never silent. */
	const gateChecks = (ctx: ExtensionContext): void => {
		if (!run) return;
		const live = runDir ? readJson<RunState>(join(runDir, STATE_FILENAME)) : undefined;
		const r = refreshChecks(run, live);
		if (r.changed) ctx.ui.notify(`orchestrate: the pre-swap gate re-read the checks from ${statePath()} — ${r.removed.length} replaced, ${r.added.length} added, ${r.to} total`, "info");
	};

	/** True once THIS process has written the status-bar row (the opt-in surface). The widget
	 *  surface never touches `setStatus` at all — proved by `test/rpc_rig.mjs`: the default surface
	 *  is the top widget, and a clear-only call there is an API touch the contract forbids. */
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
		// ONE status row, and ONLY while a run is in use (operator order 2026-11-15: the status must
		// "exist at the top … only when in use … no footer for now", then "use a nerdfont … and just
		// say Orchestrator: plan R1/6 T0/0"). `statusLines` answers `undefined` for no run, for a
		// terminal run (including a run adopted from disk at session_start) and for a run this
		// session does not own, and every one of those CLEARS the surface. The default surface is the
		// top widget: the host prints `setStatus` text in the `status` segment wherever the USER's
		// `statusLine` config placed it, and an extension cannot add or move a status-line segment,
		// so the row — not the bar — is what the loop can own (ui.ts: "Placement").
		// `FADE_ORCHESTRATE_SURFACE=status` opts into the status bar for a config that placed the
		// `status` segment right after the model. The detail view stays the panel, and the row's key
		// hint is the configured chord's label, so the row never advertises a key it does not honor.
		const lines = statusLines(run, { suffix: pillSuffix(), flip: flipBadge, owned: !isDelegatedSession(), swap: swapPill, key: keyLabel(chordHeld ? FALLBACK_KEY : FADE_KEY) });
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
			persist();
			paint(ctx);
		}
		ctx.ui.notify(`fade_orchestrate: ${reason}`, "error");
	};

	/**
	 * Y10: hold the lane load while the router is SERVING, and say so out loud. `laneSwap` calls this
	 * BEFORE `setModel`/`loadLane`: a model switch issued into a lane that is still serving queues the
	 * request the router answers by swapping BACK. The gate is bounded (GATE_POLL_MS/GATE_BUDGET_MS)
	 * and visible — the first busy poll notifies, every poll refreshes the working message with the
	 * elapsed budget and the counters the router reported. It is a DEFERRAL, not a refusal: the caller
	 * keeps `pending` set, so the owed lane survives the whole wait. `over_budget` (busy for the full
	 * budget) pays the load anyway — a loop that never lands its lane is a stalled run — and the
	 * call site records that decision in `rejection_history`.
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

	// The lane switch as one callable unit: `agent_end` (the phase contract's single load site)
	// and the overlay's v/c keys run the SAME sequence — setModel, setThinkingLevel, the
	// settle-then-load router call, persist, paint, briefing. No queued-request window exists
	// while a slash command runs, so calling it from a command is the same boundary discipline.
	const switchLane = async (lane: string, ctx: ExtensionContext): Promise<void> => {
		const model = ctx.modelRegistry.find(PROVIDER, lane);
		if (!model) {
			fail(ctx, `model ${PROVIDER}/${lane} is not in the registry`);
			return;
		}
		const switched = await pi.setModel(model);
		if (switched !== true && (switched as unknown as { switched?: boolean } | null)?.switched !== true) {
			fail(ctx, `setModel(${PROVIDER}/${lane}) did not switch: ${JSON.stringify(switched)}`);
			return;
		}
		pi.setThinkingLevel(THINKING[lane]);
		// Swap watch: samples /health (phase, percent) while the pack loads, then reads the
		// first-completion and steady decode rates off /metrics and appends a history row —
		// the durable measurement behind batch-verification-into-one-residency decisions.
		const from = run?.lane ?? "";
		// The status row names the switch, multicolored, while the pack is coming in: the model name
		// appears here exactly once (abbreviated), and the steady row names no model at all.
		swapPill = { from, to: modelLabel(model.name ?? lane) };
		paint(ctx);
		// Optimal MoE loading, measured per swap (moe.ts): the Flash-Next pack saves its learned
		// adaptive-tier placement and starts from it; the profile's existence + age BEFORE this
		// swap is what decides "warm start" vs the 91 tok/s cold ramp.
		const moe = laneMoe(lane, { configPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG });
		const watch = startSwapWatch(lane, moe, (percent) => {
			if (!swapPill) return;
			swapPill = { ...swapPill, percent };
			paint(ctx);
		});
		ctx.ui.setWorkingMessage(`fade_orchestrate: loading ${lane} on the router…`);
		const loaded = await loadLane(lane);
		ctx.ui.setWorkingMessage();
		swapPill = undefined;
		if (!loaded.ok) {
			watch.cancel();
			fail(ctx, `loading lane ${lane} failed (${loaded.detail}); briefing not sent`);
			return;
		}
		if (from && runDir && from !== lane) {
			turnSwapMs += Math.round(loaded.elapsed_s * 1000);
			void watch.finish(from, lane, loaded.elapsed_s, runDir).then(() => paint(ctx));
		}
		if (run) run.lane = lane;
		persist();
		paint(ctx);
		await applyToolPolicy(lane);
		setTimeout(async () => {
			await ensurePhaseTool();
			const text =
				run!.state === "repair"
					? briefings.repair(run!)
					: lane === CODE_LANE && run!.gate_last && run!.gate_last.passed === false
						? briefings.gate(run!)
						: lane === CODE_LANE
							? briefings.code(run!)
							: briefings.verify(run!);
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
				persistMetrics(dir, s);
			}
			return collectScreen({
				run: state,
				runDir: dir,
				lanes: { think: THINK_LANE, code: CODE_LANE },
				names: { [THINK_LANE]: ctx.modelRegistry.find(PROVIDER, THINK_LANE)?.name, [CODE_LANE]: ctx.modelRegistry.find(PROVIDER, CODE_LANE)?.name },
				context: ctx.getContextUsage(),
				metrics,
				flip: flipBadge,
				...(process.env.FADE_ORCHESTRATE_BASALT_CONFIG ? { moeConfigPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG } : {}),
			});
		};
	};

	/** A panel key is a loop control: the same directives `/orchestrate` answers, on the SELECTED task. */
	const actOnPanel = (ctx: ExtensionContext, a: PanelAction): void => {
		if (!run) return;
		const dir =
			a.key === "s" ? actSkip(run, a.taskId) : a.key === "v" ? actVerify(run) : a.key === "r" ? actReset(run) : a.key === "p" ? actPause(run) : a.key === "c" ? actCode(run) : a.key === "h" ? actHalt(run) : undefined;
		if (!dir) return;
		persist();
		paint(ctx);
		ctx.ui.notify(`orchestrate: ${dir.note}`, "info");
		// [p]/[c] resumed a paused loop: pay the lane load that pausing deferred.
		if (!run.paused && pending) {
			const deferred = pending;
			pending = undefined;
			void switchLane(deferred.lane, ctx);
		}
		if (dir.next) void switchLane(dir.next, ctx);
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
			// The message alone sent me hunting twice: the panel renders from six sources, and the
			// message names the expression, not the caller. Two stack lines ride along.
			const where = e instanceof Error && typeof e.stack === "string" ? ` @ ${e.stack.split("\n").slice(1, 4).map((l) => l.trim()).join(" | ")}` : "";
			ctx.ui.notify(`orchestrate: panel failed: ${String(e instanceof Error ? e.message : e)}${where}`, "error");
		}
	};

	// The read is guarded, not just the call. omp 18.20.2's loading-phase proxy answers a property
	// `get` of a guarded action method with the SAME throw as the call, and a throw in the factory body
	// fails the LOAD: measured 2026-11-15 in a live operator session, the extension died behind
	// `Warning: Failed to load extension …/fade_orchestrate.ts: Extension runtime not initialized.
	// Action methods cannot be called during extension loading.` — which silently costs the status row,
	// the panel, `/orchestrate` AND the `fade_phase` tool, because `registerTool`/`registerCommand`
	// below it never run. One refused property read must never be able to take the surface down.
	let conflictProbe: unknown;
	try {
		conflictProbe = Reflect.get(pi, "getShortcutConflict");
	} catch {
		conflictProbe = undefined;
	}
	/**
	 * The host's answer about a chord, `undefined` when the chord is free: `kind` names the class
	 * (`reserved` / `keybinding`) and `owner`/`keybindings[0]` the host action that holds it. Swallowed
	 * for two measured reasons: the method is absent from the published types, and omp 18.20.2's
	 * loading-phase stub throws "Extension runtime not initialized. Action methods cannot be called
	 * during extension loading." for it, which disabled the whole extension (measured 2026-11-15 in the
	 * rpc and pty rigs, where every assertion failed behind `Warning: Failed to load extension
	 * …/fade_orchestrate.ts`). `probeHasAnswered` separates a swallowed throw from a real "free".
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


	// The chord, taken at the raw-input layer. That layer is the proven path: `registerShortcut` is
	// refused for a chord the host's table holds ("Extension shortcut conflicts with built-in
	// shortcut" in getShortcuts, measured for ctrl+o), and a raw listener sees the bytes whatever
	// owns the action. While the panel is open the byte is NOT consumed: the overlay keeps its own
	// keys (esc closes).
	const CHORD = chordBytes(FADE_KEY);
	const FALLBACK_KEY = process.env.FADE_ORCHESTRATE_FALLBACK_KEY ?? "alt+shift+i";
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
	 * The host's chord table — the chords its own action table binds, read out of the 18.20.2 binary and
	 * confirmed at runtime by the conflict probe where the probe answers (measured 2026-11-15: `alt+f`
	 * answers `keybinding tui.editor.cursorWordRight`; `alt+shift+f` and `alt+shift+i` answer FREE, which
	 * is why the extension's chord is `alt+shift+f`).
	 *
	 * The table exists because the probe is **not callable when a hook can run**: `getShortcutConflict`
	 * throws for the loading-phase proxy, `session_start` fires inside that window, and an idle TUI
	 * session — the pty rig, and an operator reading the wall — has no `agent_start` to retry on. Measured
	 * in every rig state: with the disclosure tied to the probe alone it never reached the screen. So the
	 * probe decides when it answers and the table decides when it does not; the chord is always disclosed.
	 *
	 * The table's boundary is the disclosed truth: a chord NOT in it, behind a probe that never answers,
	 * is advertised as configured (`chordHeld` stays false) — the table is the only knowledge in that
	 * state, and claiming a chord this extension registers is held, when nothing says it is, would be a
	 * invented conflict. The raw-input listener and `registerShortcut` both attempt it, so the disclosure
	 * matches what the keystroke will do (verifier review 2026-11-15, residual named and accepted).
	 */
	const HOST_HELD_CHORDS: Record<string, true> = {
		"ctrl+c": true, "ctrl+d": true, "ctrl+g": true, "ctrl+l": true, "ctrl+o": true, "ctrl+r": true,
		"ctrl+s": true, "ctrl+t": true, "ctrl+y": true, "ctrl+z": true, "ctrl+.": true,
		"alt+a": true, "alt+b": true, "alt+d": true, "alt+f": true, "alt+g": true, "alt+h": true,
		"alt+i": true, "alt+k": true, "alt+l": true, "alt+m": true, "alt+n": true, "alt+o": true,
		"alt+p": true, "alt+r": true, "alt+y": true,
		"alt+shift+c": true, "alt+shift+k": true, "alt+shift+l": true, "alt+shift+p": true, "alt+shift+v": true,
	};

	/** One disclosure, at `session_start`: which key opens the screen, and whether the host holds it. */
	const resolveChord = (ctx: ExtensionContext): void => {
		if (!CHORD || chordResolved) return;
		const conflict = hostConflict(FADE_KEY);
		const owner = (conflict?.keybindings?.[0] ?? conflict?.owner) as string | undefined;
		const held = conflict !== undefined || (!probeHasAnswered && HOST_HELD_CHORDS[FADE_KEY] === true);
		chordResolved = true;
		chordHeld = held;
		if (conflictReported) return;
		conflictReported = true;
		const text = held
			? `orchestrate: ${keyLabel(FADE_KEY)} is held by the host (${conflict ? `${conflict.kind}${owner ? ` ${owner}` : ""}` : "the host's key table binds it"}) — the screen opens on ${keyLabel(FALLBACK_KEY)}. Point FADE_ORCHESTRATE_KEY at a chord the host's conflict probe reports FREE; the host holds alt+a/b/d/f/g/h/i/k/l/m/n/o/p/r/y, alt+shift+c/k/l/p/v and ctrl+c/d/g/l/o/r/s/t/y/z`
			: `orchestrate: ${keyLabel(FADE_KEY)} opens the orchestration screen; ${keyLabel(FALLBACK_KEY)} is the registered fallback and /orchestrate overlay is the command path`;
		// The FIRST notify of a session is swallowed by the host's TUI attach: measured in the pty rig
		// (2026-11-15), the disclosure fired at `session_start` never reached the scrollback while the
		// notify ~20 lines later in the same hook rendered every time. Deferring past the attach is the
		// remedy; the one-shot flags above are set synchronously, so the deferral can never double-print.
		const at = setTimeout(() => ctx.ui.notify(text, "info"), 500);
		at.unref?.();
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
			// Adaptive budget: a 2-task plan reserves 3 rounds, a 6-task plan 5 — swaps are the
			// unit of cost here (13-25 s per pack load), so the budget tracks the plan size.
			st.max_rounds = adaptiveRounds(st.tasks.length, st.max_rounds);
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
			// from `coding` is what livelocked run 20261115T091232Z-rqtj — seven coding_done
			// reports, seven identical refusals, zero lane loads. The exception re-declares CHECKS
			// only, and the tasks must be the plan's own (validated below), so it cannot rewrite
			// the plan to dodge a red gate.
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
					persist();
					throw new Error(run.schema_retries >= 2 ? `${text}\n${SCHEMA_HINT}` : text);
				}
				throw new Error(text);
			}
			// The lane is `applyPhase`'s decision, so the state machine and the load can never
			// disagree — and the swap is NOT issued here. This turn is about to abort with its
			// chat requests still queued at the router, and a load issued into that queue makes
			// the router swap to the entry the QUEUED requests name (the 21:55-21:58 ping-pong).
			// `agent_end` is the single load site, after the turn is closed.
			const applied = applyPhase(params.phase, payload);
			turnPhase = params.phase;
			// Y1: an accepted phase is the end of the protocol streak. `round`/`max_rounds` are
			// untouched here — a lane that reports never owes the round budget anything.
			classifyTurnEnd(run, true);
			let checkpointNote = "";
			if (params.phase === "verification_done" && applied.nextState === "complete") {
				// Y16: tag the tree at the moment each task was accepted, namespaced per run.
				// `run` is a mutable `let`, so the closure below loses the guard's narrowing.
				const st: RunState = run;
				const tags = st.tasks.filter((t) => t.status === "passed").map((t) => tagCheckpoint(st.repo, st, t.id));
				const ok = tags.filter((t) => t.ok).map((t) => t.tag);
				if (ok.length > 0) checkpointNote = `; checkpoints ${ok.join(", ")}`;
				const refused = tags.filter((t) => !t.ok);
				if (refused.length > 0) checkpointNote += `; checkpoint FAILED ${refused.map((t) => `${t.tag}: ${t.error}`).join(", ")}`;
			}
			// T4 pre-swap gate: on coding_done, before paying the verifier swap (13-25 s pack
			// load), run the plan's own checks on the code lane. Red keeps the coding lane
			// resident (loadLane on the resident entry costs 0 s), records the rejection, and
			// sends the gate briefing with the observed tails — self-repair without a swap.
			if (params.phase === "coding_done" && applied.nextState === "verifying" && run.checks.length > 0) {
				gateChecks(ctx);
				const gate = runGate(run.checks, run.repo);
				run.gate_last = gate;
				if (!gate.passed) {
					const failing = gate.results.filter((r) => !r.ok);
					pushRejection(run, "task", `pre-swap gate red: ${failing.map((f) => f.cmd).join(" | ")}`);
					run.state = "coding";
					persist();
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
			persist();
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

	// The panel's chord is registered as a shortcut, so the HOST parses the chord string: that is the
	// robust delivery for an `alt+…` chord, whose two bytes (ESC + letter) a pty can split across
	// reads. The host is the authority on who owns a chord — `getShortcuts()` logs
	// "Extension shortcut conflicts with built-in shortcut" and skips a chord its table holds
	// (measured for `ctrl+o`) — and the raw-input listener bound at `session_start` stays as the
	// byte-level path. Both routes go through `openPanelGuarded`, so a keystroke opens one panel.
	//
	// Registration runs in the factory body, i.e. at LOAD. The same rule as the probe read above: a
	// refused chord SKIPS and never propagates, because a load-time throw costs the status row, the
	// panel, `/orchestrate` and the `fade_phase` tool at once. The fallback chord and
	// `/orchestrate overlay` are the paths that survive a refused chord.
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
		description: `One session, two basalt lanes: ${THINK_LANE} plans/verifies, ${CODE_LANE} codes. /orchestrate [--rounds N] <goal> | status | overlay | skip [Tn] | verify | reset | pause [note] | code | halt | stop [--clear]`,
		handler: async (args, ctx) => {
			const raw = args.trim();
			const first = raw.split(/\s+/)[0] ?? "";
			if (first === "status") {
				if (!run) {
					ctx.ui.notify("orchestrate: no run active", "info");
					return;
				}
				const done = run.tasks.filter((t) => t.status === "passed").length;
				ctx.ui.notify(
					`orchestrate ${run.run_id}: ${run.state} · lane ${run.lane} · round ${run.round}/${run.max_rounds} · tasks ${done}/${run.tasks.length} · phases ${run.phases.length} · ${statePath()}`,
					"info",
				);
				paint(ctx);
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
				pi.sendUserMessage(handoverText(run));
				ctx.ui.notify("orchestrate: condensed handover sent", "info");
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
				persist();
				paint(ctx);
				ctx.ui.notify(`orchestrate: ${dir.note}`, "info");
				if (!run.paused && pending) {
					const deferred = pending;
					pending = undefined;
					await switchLane(deferred.lane, ctx);
				}
				if (dir.next) await switchLane(dir.next, ctx);
				return;
			}
			if (first === "stop") {
				if (!run) {
					ctx.ui.notify("orchestrate: no run active", "info");
					return;
				}
				if (TERMINAL[run.state] !== true) {
					run.state = "stopped";
					persist();
				}
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
				// A worker session never STARTS a run: the run is the operator's, in this same cwd.
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
			ctx.ui.setWorkingMessage(`fade_orchestrate: loading ${THINK_LANE} on the router…`);
			const loaded = await loadLane(THINK_LANE);
			ctx.ui.setWorkingMessage();
			if (!loaded.ok) {
				ctx.ui.notify(`orchestrate: preflight failed loading ${THINK_LANE} (${loaded.detail}); nothing written`, "error");
				return;
			}
			const census = await listLanes();
			const resident = census.models.find((m) => m.status === "loaded");
			if (!census.error && resident?.id !== THINK_LANE) {
				ctx.ui.notify(`orchestrate: preflight expected ${THINK_LANE} loaded, router reports ${resident ? resident.id : "none"}; nothing written`, "error");
				return;
			}
			const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z").replace("T", "T")}-${Math.random().toString(36).slice(2, 6)}`;
			const repo = ctx.cwd;
			runDir = join(repo, "var", "omp-orchestrate");
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
			writeJson(join(runDir, ACTIVE_FILENAME), { run_id: runId, repo, goal, started_utc: run.started_utc, max_rounds: rounds });
			persist();
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
			pi.sendUserMessage(briefings.plan(run));
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// A delegated session NEVER adopts the run. The loop, its nudges, its lane loads and its
		// ledger belong to the session that owns the run. Measured cost of the old adoption (basalt
		// serve log 2026-11-15 04:16:13-04:20:14, two subagent spin-ups): `swap flash-next ->
		// deepseek` (18.0 s / 19.8 s, 129.5 GiB each) followed immediately by `swap deepseek ->
		// flash-next` (16.1 s, 52.2 GiB) with ZERO tokens served on the verifier — 70.1 s and four
		// loads, while the read-only refusals landed on the workers' own edits.
		if (isDelegatedSession()) return;
		await ensurePhaseTool();
		// Bind the chord for this session. A delegated worker never binds it: the keystroke is global
		// to the terminal, and the panel belongs to the session that owns the run.
		if (CHORD && !inputUnsub) {
			inputUnsub = ctx.ui.onTerminalInput((data) => {
				if (data !== CHORD || panelOpen) return undefined;
				void openPanelGuarded(ctx);
				return { consume: true };
			});
		}
		// One disclosure of the chord: the probe decides when it answers, the host's chord table when
		// it cannot (see `resolveChord`).
		resolveChord(ctx);
		const repo = ctx.cwd;
		const active = readJson<{ run_id?: string }>(join(repo, "var", "omp-orchestrate", ACTIVE_FILENAME));
		const state = readJson<RunState>(join(repo, "var", "omp-orchestrate", STATE_FILENAME));
		if (!active || !state) return;
		runDir = join(repo, "var", "omp-orchestrate");
		run = normalizeRun(state);
		settledNotified = false;
		paint(ctx);
		startMetricsTimer();
		if (TERMINAL[state.state] === true) {
			ctx.ui.notify(`orchestrate: run ${state.run_id} is ${state.state} (${statePath()})`, "info");
		} else if (process.env.FADE_ORCHESTRATE_AUTO_RESUME === "1") {
			setTimeout(() => {
				const idle = typeof ctx.hasPendingMessages === "function" ? !ctx.hasPendingMessages() : true;
				if (idle && ctx.isIdle()) pi.sendUserMessage(handoverText(state));
			}, 250);
			ctx.ui.notify("orchestrate: resumed with the condensed handover (FADE_ORCHESTRATE_AUTO_RESUME=1)", "info");
		} else {
			ctx.ui.notify("orchestrate: run mid-flight — /orchestrate handover sends the condensed state", "info");
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
			// Tier-1 protocol gate (Y1). A turn that ends with no accepted fade_phase is PROTOCOL
			// debt: `round`/`max_rounds` never move, and while the offending lane is the resident
			// one a nudge costs nothing (no swap). Three tiers, counted in `stall_count`.
			const tier = classifyTurnEnd(run, false);
			if (tier === "nudge") {
				pushRejection(run, "protocol", `turn ended in state ${run.state} with no fade_phase call (nudge ${run.stall_count}/${STALL_SYNTHESIZE_AT})`);
				persist();
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
				gateChecks(ctx);
				const gate = run.checks.length > 0 ? runGate(run.checks, run.repo) : undefined;
				if (gate) run.gate_last = gate;
				if (gate && !gate.passed) {
					const failing = gate.results.filter((r) => !r.ok);
					pushRejection(run, "task", `synthesized round refused: pre-swap gate red: ${failing.map((f) => f.cmd).join(" | ")}`);
					persist();
					paint(ctx);
					pending = { lane: CODE_LANE, phase: "gate" };
					settledNotified = false;
					await ensurePhaseTool();
					pi.sendUserMessage(briefings.gate(run));
					void recordTurn("gate_red");
					return;
				}
				const syn = synthesizeCodingDone(run, run.repo);
				pushRejection(run, "protocol", `coding_done SYNTHESIZED from git status/diff + gate exit codes after ${run.stall_count} phase-less turns`);
				const applied = applyPhase("coding_done", { done: syn.done });
				persist();
				paint(ctx);
				ctx.ui.notify(`orchestrate: coding_done synthesized from git + gate (round ${run.round}); the verifier swap is paid once`, "warning");
				void recordTurn("synthesized");
				settledNotified = false;
				await switchLane(applied.next, ctx);
				return;
			}
			if (tier === "stall") {
				// Tier-3 circuit breaker: halt cleanly, ZERO lane loads, state + diagnostic durable.
				const stalledFrom = run.state;
				run.state = "stalled_protocol_error";
				run.paused = true;
				run.reason = `${run.protocol_retries ?? 0} turn(s) ended with no fade_phase call from state ${stalledFrom}`;
				pushRejection(run, "protocol", `circuit breaker: ${run.reason}`);
				persist();
				paint(ctx);
				ctx.ui.notify(briefings.stalled(run), "error");
				void recordTurn("stalled_protocol_error");
				return;
			}
			// A phase-less turn in a state git cannot speak for (planning, verifying): nudge harder,
			// with the schemas attached, and never spend a round.
			pushRejection(run, "protocol", `turn ended in state ${run.state} with no fade_phase call (tier ${tier})`);
			persist();
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
		// queued at the router naming the lane we are leaving — that queue is what flipped the
		// lane back 0-2 s after every swap (the 21:55-21:58 ping-pong). `loadLane` settles an
		// in-flight swap and refuses to reload the resident entry, so a round that wants the
		// lane already resident pays 0 s.
		await switchLane(next.lane, ctx);
	});

	// Y15 enforcement: the verifier lane is read-only. An edit/write/apply_patch/task attempted
	// while the thinking lane holds the run is refused with the rule named, so the fix is
	// DELEGATED back to the coder instead of silently applied by the verifier.
	pi.on("tool_call", (event: { toolName?: string }) => {
		// The guard reads the ON-DISK run, not this session's copy: a session started before a lane
		// change would otherwise enforce a lane that no longer exists (measured: the operator's own
		// edits were refused by a stale in-memory `deepseek` with no way to unblock the session).
		// Enforcement is the VERIFIER'S TURN only — `state: verifying` is the state the row names —
		// and never inside a delegated session, which is inert by `isDelegatedSession`.
		if (!run || isDelegatedSession()) return undefined;
		const live = runDir ? readJson<RunState>(join(runDir, STATE_FILENAME)) : undefined;
		if (!live || live.state !== "verifying" || live.lane !== THINK_LANE) return undefined;
		const name = event.toolName ?? "";
		if (MUTATING_TOOLS[name] !== true) return undefined;
		pushRejection(run, "task", `verifier sandbox: ${name} refused on the thinking lane (read-only); the fix is delegated to the coder`);
		persist();
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
