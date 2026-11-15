/**
 * fade_orchestrate: one OMP session, two basalt lanes.
 *
 * The coder endpoint is basalt's own ROUTER on :18014 (`fade-basalt-gpu1.service` ->
 * `deploy/ops/basalt_config_prod_v2_ds41.json`): two entries, one loaded at a time.
 * `POST /v1/load {"model": NAME}` blocks until the swap finishes; this extension drives it.
 * DeepSeek plans and verifies; Flash-Next codes.
 *
 *   /orchestrate [--rounds N] <goal>   start a run (default 6 rounds, max 6)
 *   /orchestrate status                state, lane, round, tasks, phase log, path
 *   /orchestrate stop [--clear]        mark the run stopped (leave the resident lane)
 *   /lanes                             live router census: both entries + health
 *
 * The loop is a phase contract, not tool sandboxing: the thinking lane answers with
 * `fade_phase`, and the tool validates, loads the next lane, records the phase and ends
 * the turn. `agent_end` is the only `setModel` site (the host defers model switches while
 * streaming). Every failure names the stage, the HTTP status and the body.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const ROUTER = process.env.FADE_ORCHESTRATE_ROUTER ?? "http://127.0.0.1:18014";
const PROVIDER = "strata-flash";
const THINK_LANE = "deepseek";
const CODE_LANE = "flash-next";
const THINKING: Record<string, string> = { [THINK_LANE]: "high", [CODE_LANE]: "low" };
const STATE_KEY = "fade.omp_orchestrate.v1";
const ACTIVE_FILENAME = "ACTIVE.json";
const STATE_FILENAME = "state.json";
const DEFAULT_ROUNDS = 6;
const MAX_ROUNDS = 6;
const MAX_TASKS = 6;
const TERMINAL: Record<string, true> = { complete: true, failed: true, stopped: true };
const PHASE_FOR_STATE: Record<string, string> = { planning: "planning_done", coding: "coding_done", repair: "coding_done", verifying: "verification_done" };
const STATUS_KEY = "fade";

interface Task {
	id: string;
	objective: string;
	files: string[];
	acceptance: string;
	dependencies: string[];
	round: number;
	status?: string;
	result?: string;
}

interface PhaseLog {
	phase: string;
	lane: string;
	accepted: boolean;
	round: number;
	at: string;
}

interface RunState {
	key: string;
	run_id: string;
	goal: string;
	repo: string;
	max_rounds: number;
	round: number;
	state: string;
	lane: string;
	checks: [string, string][];
	tasks: Task[];
	phases: PhaseLog[];
	repair_tasks: Task[];
	reason?: string;
	started_utc: string;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Temp + rename: a reader never sees a half-written record. */
function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}

type RouterLane = { id: string; status: string };

async function listLanes(): Promise<{ health: string; models: RouterLane[]; error?: string }> {
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

/** `POST /v1/load` blocks until the target is resident; non-200 is a named load failure. */
async function loadLane(lane: string): Promise<{ ok: boolean; detail: string }> {
	try {
		const r = await fetch(`${ROUTER}/v1/load`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: lane }),
			signal: AbortSignal.timeout(240_000),
		});
		const text = await r.text();
		return { ok: r.ok, detail: `http ${r.status} ${text.length > 300 ? `${text.slice(0, 300)}...` : text}` };
	} catch (e) {
		return { ok: false, detail: msg(e) };
	}
}

function isRepoRelative(path: string): boolean {
	if (typeof path !== "string" || path.trim() === "" || isAbsolute(path)) return false;
	return !path.split(/[\\/]/).includes("..");
}

function validateTasks(raw: unknown): { tasks?: Task[]; error?: string } {
	if (!Array.isArray(raw)) return { error: "tasks must be an array" };
	if (raw.length > MAX_TASKS) return { error: `at most ${MAX_TASKS} tasks` };
	const seen = new Set<string>();
	const tasks: Task[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) return { error: "each task must be an object" };
		const t = item as Record<string, unknown>;
		const id = t.id;
		if (typeof id !== "string" || !/^T[1-6]$/.test(id)) return { error: `task id ${JSON.stringify(id)} is not T1..T6` };
		if (seen.has(id)) return { error: `duplicate task id ${id}` };
		seen.add(id);
		if (typeof t.objective !== "string" || t.objective.trim() === "") return { error: `${id}: objective is required` };
		if (!Array.isArray(t.files) || t.files.length === 0) return { error: `${id}: files must be a non-empty array` };
		for (const f of t.files) if (!isRepoRelative(f as string)) return { error: `${id}: file ${JSON.stringify(f)} is not repo-relative` };
		if (typeof t.acceptance !== "string" || t.acceptance.trim() === "") return { error: `${id}: acceptance is required` };
		const deps = t.dependencies ?? [];
		if (!Array.isArray(deps)) return { error: `${id}: dependencies must be an array` };
		for (const d of deps) {
			if (typeof d !== "string" || !seen.has(d)) return { error: `${id}: dependency ${JSON.stringify(d)} must name an earlier task` };
		}
		tasks.push({ id, objective: String(t.objective), files: t.files as string[], acceptance: String(t.acceptance), dependencies: deps as string[], round: 0 });
	}
	return { tasks };
}

function validateChecks(raw: unknown): { checks?: [string, string][]; error?: string } {
	if (!Array.isArray(raw)) return { error: "checks must be an array" };
	const checks: [string, string][] = [];
	for (const pair of raw) {
		if (!Array.isArray(pair) || pair.length !== 2 || pair.some((x) => typeof x !== "string")) return { error: "each check must be [command, expected]" };
		checks.push([pair[0] as string, pair[1] as string]);
	}
	return { checks };
}

const briefings = {
	plan: (run: RunState): string =>
		[
			`Phase 0 (planning), round ${run.round} of orchestrated run ${run.run_id}.`,
			`Goal: ${run.goal}`,
			`Produce a plan as a SINGLE object {"tasks":[...],"checks":[...]} with at most ${MAX_TASKS} tasks. Each task: {"id":"T<n>","objective":"...","files":["repo/relative/path"],"acceptance":"one command and what it proves","dependencies":[]}.`,
			`Give dependent tasks earlier ids first. Files are repo-relative and disjoint. Plan only: no edits, no writes.`,
			`Then call the fade_phase tool: phase="planning_done", payload=<that JSON as a string>.`,
		].join("\n"),
	code: (run: RunState): string =>
		[
			`Phase 1 (coding), round ${run.round} of orchestrated run ${run.run_id}.`,
			`Goal: ${run.goal}`,
			`Tasks: ${JSON.stringify(run.tasks)}`,
			`Implement exactly these tasks in ${run.repo}. After each task run its acceptance command and record what it observed. Do not commit.`,
			`Then call the fade_phase tool: phase="coding_done", payload={"done":[{"id":"T<n>","status":"passed"|"failed"|"blocked","result":"..."}]}`,
		].join("\n"),
	verify: (run: RunState): string =>
		[
			`Phase 2 (verification), round ${run.round} of orchestrated run ${run.run_id}.`,
			`Goal: ${run.goal}`,
			`Task results: ${JSON.stringify(run.tasks.map((t) => ({ id: t.id, status: t.status, result: t.result, files: t.files, acceptance: t.acceptance })))}`,
			`Read the diff (run "git diff" in ${run.repo} yourself) and re-run every check: ${JSON.stringify(run.checks)}.`,
			`Then call the fade_phase tool: phase="verification_done", payload={"verdict":"accepted"|"needs_repair","checks":[["cmd","observed"]],"notes":"...","tasks":[...]}; accepted ends the run, needs_repair must name the tasks for round ${run.round + 1}.`,
		].join("\n"),
	repair: (run: RunState): string =>
		[
			`Phase 1 (repair), round ${run.round} of orchestrated run ${run.run_id}.`,
			`Goal: ${run.goal}`,
			`Repair tasks: ${JSON.stringify(run.repair_tasks)}`,
			`Implement the repairs in ${run.repo}, run each acceptance command, do not commit.`,
			`Then call the fade_phase tool: phase="coding_done", payload={"done":[{"id":"T<n>","status":"passed"|"failed"|"blocked","result":"..."}]}`,
		].join("\n"),
	final: (run: RunState): string => {
		const path = join(run.repo, "var", "omp-orchestrate", STATE_FILENAME);
		if (run.state === "complete") return `Orchestrated run ${run.run_id} completed: verdict accepted after round ${run.round}. State and phase log: ${path}. Resident lane ${run.lane}; nothing is preloaded.`;
		if (run.state === "failed") return `Orchestrated run ${run.run_id} failed at round ${run.round} in state ${run.state}: ${run.reason ?? "unreported"}. State file: ${path}.`;
		return `Orchestrated run ${run.run_id} stopped at round ${run.round}; resident lane left as ${run.lane}.`;
	},
};

export default function fadeOrchestrate(pi: ExtensionAPI): void {
	let run: RunState | undefined;
	let runDir: string | undefined;
	let pending: { lane: string; phase: string } | undefined;
	let settledNotified = false;

	// Measured on this host: registerTool() puts fade_phase in the registry (/tools lists it) but
	// NOT in the active set the model is offered, so every phase briefing must activate it first.
	const ensurePhaseTool = async (): Promise<void> => {
		const active = pi.getActiveTools();
		if (!active.includes("fade_phase")) await pi.setActiveTools([...active, "fade_phase"]);
	};

	const statePath = (): string => (runDir ? join(runDir, STATE_FILENAME) : "<unset>");
	const persist = (): void => {
		if (run && runDir) writeJson(statePath(), run);
	};

	const paint = (ctx: ExtensionContext): void => {
		if (!run) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(STATUS_KEY, undefined);
			return;
		}
		const total = run.tasks.length;
		const passed = run.tasks.filter((t) => t.status === "passed").length;
		ctx.ui.setStatus(STATUS_KEY, `orchestrate R${run.round}/${run.max_rounds} ${run.state} · ${run.lane} · T${passed}/${total}`);
		const last = run.phases[run.phases.length - 1];
		ctx.ui.setWidget(STATUS_KEY, [
			`goal: ${run.goal}`,
			`state: ${run.state} · lane ${run.lane} · round ${run.round}/${run.max_rounds} · tasks ${passed}/${total} passed`,
			...(run.reason ? [`reason: ${run.reason}`] : []),
			...run.tasks.map((t) => `  ${t.id} ${t.status ?? "pending"} ${t.objective.slice(0, 90)}`),
			last ? `last phase: ${last.phase} r${last.round} accepted=${last.accepted} at ${last.at}` : "last phase: none",
			`state: ${statePath()}`,
		]);
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

	/** Apply one validated phase; returns the lane to load and the resulting state. */
	const applyPhase = (phase: string, payload: Record<string, unknown>): { next: string; nextState: string } => {
		if (!run) throw new Error("unreachable: no run");
		run.phases.push({ phase, lane: run.lane, accepted: true, round: run.round, at: new Date().toISOString() });
		if (phase === "planning_done") {
			run.tasks = (payload.tasks as Task[]).map((t) => ({ ...t, round: run.round }));
			run.checks = payload.checks as [string, string][];
			run.repair_tasks = [];
			run.state = "coding";
			return { next: CODE_LANE, nextState: "coding" };
		}
		if (phase === "coding_done") {
			for (const d of payload.done as Array<{ id: string; status: string; result?: string }>) {
				const task = run.tasks.find((t) => t.id === d.id) ?? run.repair_tasks.find((t) => t.id === d.id);
				if (task) {
					task.status = d.status;
					task.result = d.result;
				}
			}
			run.state = "verifying";
			return { next: THINK_LANE, nextState: "verifying" };
		}
		const accepted = String(payload.verdict) === "accepted";
		run.phases[run.phases.length - 1].accepted = accepted;
		if (accepted) {
			run.state = "complete";
			return { next: THINK_LANE, nextState: "complete" };
		}
		if (run.round + 1 > run.max_rounds) {
			run.state = "failed";
			run.reason = `round budget exhausted (${run.max_rounds}) with verdict needs_repair`;
			return { next: THINK_LANE, nextState: "failed" };
		}
		run.round += 1;
		run.repair_tasks = (payload.tasks as Task[]).map((t) => ({ ...t, round: run.round, status: undefined, result: undefined }));
		run.state = "repair";
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
		loadMode: "essential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!run) throw new Error("fade_phase: no orchestrated run is active (start one with /orchestrate <goal>)");
			if (TERMINAL[run.state] === true) throw new Error(`fade_phase: run ${run.run_id} is already ${run.state}`);
			if (run.round > run.max_rounds) throw new Error(`fade_phase: round ${run.round} exceeds max_rounds ${run.max_rounds}`);
			const allowed = PHASE_FOR_STATE[run.state];
			if (!allowed) throw new Error(`fade_phase: state ${run.state} takes no phase`);
			if (params.phase !== allowed) throw new Error(`fade_phase: state ${run.state} takes phase ${allowed}, not ${params.phase}`);
			let payload: Record<string, unknown>;
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
			// the lane to PRELOAD is the one the conversation moves TO, not the one it came from:
			// planning_done hands off to the code lane, coding_done to the think lane, and a
			// needs_repair verdict back to the code lane - so the next turn never waits on a swap.
			const lane =
				params.phase === "coding_done"
					? THINK_LANE
					: params.phase === "planning_done"
						? CODE_LANE
						: String(payload.verdict) === "accepted"
							? THINK_LANE
							: CODE_LANE;
			ctx.ui.setWorkingMessage(`fade_orchestrate: loading ${lane} on the router…`);
			const loaded = await loadLane(lane);
			ctx.ui.setWorkingMessage();
			if (!loaded.ok) {
				fail(ctx, `loading lane ${lane} failed (${loaded.detail}); phase ${params.phase} not recorded`);
				throw new Error(`fade_phase: lane load failed: ${loaded.detail}`);
			}
			const applied = applyPhase(params.phase, payload);
			run!.lane = lane;
			persist();
			paint(ctx);
			pending = applied.nextState === "failed" || applied.nextState === "complete" ? undefined : { lane: applied.next, phase: params.phase };
			settledNotified = false;
			ctx.abort();
			return {
				content: [{ type: "text", text: `phase ${params.phase} recorded; ${lane} is resident; state ${applied.nextState}${pending ? `, next lane ${pending.lane}` : ""}` }],
				details: { phase: params.phase, state: applied.nextState, resident: lane },
			};
		},
	});

	pi.registerCommand("lanes", {
		description: "Live basalt router census on :18014: both entries' load state and /health",
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

	pi.registerCommand("orchestrate", {
		description: "One session, two basalt lanes: DeepSeek plans/verifies, Flash-Next codes. /orchestrate [--rounds N] <goal> | status | stop [--clear]",
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
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.setWidget(STATUS_KEY, undefined);
				ctx.ui.notify(`orchestrate: stopped; resident lane left as ${run.lane}; state ${statePath()}`, "info");
				if (raw.includes("--clear")) {
					try {
						unlinkSync(join(runDir!, ACTIVE_FILENAME));
					} catch {}
					run = undefined;
				}
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
			if (switched !== true && (switched as { switched?: boolean } | null)?.switched !== true) {
				fail(ctx, `setModel(${PROVIDER}/${THINK_LANE}) did not switch: ${JSON.stringify(switched)}`);
				return;
			}
			pi.setThinkingLevel(THINKING[THINK_LANE]);
			paint(ctx);
			await ensurePhaseTool();
			pi.sendUserMessage(briefings.plan(run));
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await ensurePhaseTool();
		const repo = ctx.cwd;
		const active = readJson<{ run_id?: string }>(join(repo, "var", "omp-orchestrate", ACTIVE_FILENAME));
		const state = readJson<RunState>(join(repo, "var", "omp-orchestrate", STATE_FILENAME));
		if (!active || !state) return;
		runDir = join(repo, "var", "omp-orchestrate");
		run = state;
		settledNotified = false;
		paint(ctx);
		if (TERMINAL[state.state] === true) ctx.ui.notify(`orchestrate: run ${state.run_id} is ${state.state} (${statePath()})`, "info");
	});

	pi.on("agent_start", async (_event, ctx) => paint(ctx));

	pi.on("agent_end", async (_event, ctx) => {
		if (!run) return;
		const next = pending;
		pending = undefined;
		if (!next) {
			paint(ctx);
			if (TERMINAL[run.state] === true && !settledNotified) {
				settledNotified = true;
				ctx.ui.notify(briefings.final(run), "info");
			} else if (TERMINAL[run.state] !== true) {
				ctx.ui.notify(`orchestrate: turn ended without a fade_phase call; ${run.state} did not advance (round ${run.round})`, "warning");
			}
			return;
		}
		const target = next.lane;
		const model = ctx.modelRegistry.find(PROVIDER, target);
		if (!model) {
			fail(ctx, `model ${PROVIDER}/${target} is not in the registry`);
			return;
		}
		const switched = await pi.setModel(model);
		if (switched !== true && (switched as { switched?: boolean } | null)?.switched !== true) {
			fail(ctx, `setModel(${PROVIDER}/${target}) did not switch: ${JSON.stringify(switched)}`);
			return;
		}
		pi.setThinkingLevel(THINKING[target]);
		paint(ctx);
		setTimeout(async () => {
			await ensurePhaseTool();
			const text = run!.state === "repair" ? briefings.repair(run!) : target === CODE_LANE ? briefings.code(run!) : briefings.verify(run!);
			pi.sendUserMessage(text);
		}, 0);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(STATUS_KEY, undefined);
	});
}
