/**
 * The state machine's data half: the run schema, the phase/validation rules, and the briefings
 * each lane is fed. Behavior is the monolith's (deploy/omp/fade_orchestrate.ts, the 2026-11-15
 * split) — the wording of every validation error is load-bearing: the model steers by it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CODE_LANE, THINK_LANE, msg } from "./router.ts";

export const STATE_KEY = "fade.omp_orchestrate.v1";
export const ACTIVE_FILENAME = "ACTIVE.json";
export const STATE_FILENAME = "state.json";
export const DEFAULT_ROUNDS = 6;
export const MAX_ROUNDS = 6;
export const MAX_TASKS = 6;
export const TERMINAL: Record<string, true> = { complete: true, failed: true, stopped: true };
export const PHASE_FOR_STATE: Record<string, string> = { planning: "planning_done", coding: "coding_done", repair: "coding_done", verifying: "verification_done" };
export const STATUS_KEY = "fade";

/** One rejection: a phase the verifier bounced, a payload the schema refused, a task forced. */
export interface Rejection {
	round: number;
	at: string;
	kind: "verification" | "schema" | "task";
	task_id?: string;
	reason: string;
}
export const MAX_REJECTIONS = 50;

/** v1 state files carry none of the v2 fields; resume fills the defaults, never crashes. */
export function normalizeRun(st: RunState): RunState {
	if (!Array.isArray(st.rejection_history)) st.rejection_history = [];
	if (typeof st.schema_retries !== "number") st.schema_retries = 0;
	return st;
}

export function pushRejection(run: RunState, kind: Rejection["kind"], reason: string, task_id?: string): void {
	if (!Array.isArray(run.rejection_history)) run.rejection_history = [];
	run.rejection_history.push({ round: run.round, at: new Date().toISOString(), kind, reason, task_id });
	if (run.rejection_history.length > MAX_REJECTIONS) run.rejection_history.splice(0, run.rejection_history.length - MAX_REJECTIONS);
}

/**
 * Adaptive round budget: 2 rounds (code+verify) per planning, +1 per 2 tasks, floored at 3 and
 * capped at the requested budget. Measured basis: 6-task runs land inside 2 coding rounds;
 * the budget is for repair rounds, so a small plan must not reserve six swaps.
 */
export function adaptiveRounds(nTasks: number, budget: number): number {
	return Math.min(budget, Math.max(3, 2 + Math.ceil(nTasks / 2)));
}

/** Emitted verbatim into the tool error after the second schema rejection (auto-repair hint). */
export const SCHEMA_HINT =
	'Payload schemas (exact, no extra keys; payload is the JSON object serialized to a string): planning_done {"tasks":[{"id":"T1","objective":"...","files":["a/b.ts"],"acceptance":"one command and what it proves","dependencies":[]}],"checks":[["cmd","expected"]]}; coding_done {"done":[{"id":"T1","status":"passed|failed|blocked","result":"what the acceptance command observed"}]}; verification_done {"verdict":"accepted|needs_repair","checks":[["cmd","observed"]],"notes":"the critique","tasks":[repair tasks, same shape as planning tasks]}.';

/** One pre-swap gate outcome: every check run deterministically, judged on exit code. */
export interface GateResult {
	at: string;
	passed: boolean;
	results: { cmd: string; expected: string; ok: boolean; tail: string }[];
}

/**
 * The pre-swap gate (T4): the verifier swap costs a 13-25 s pack load; running the plan's own
 * checks on the code lane FIRST means the swap is only ever paid for a tree whose deterministic
 * checks already pass. Exit code is the verdict (deterministic); the `expected` text rides to
 * the verifier briefing for the judgement calls.
 */
export function runGate(checks: [string, string][], cwd: string): GateResult {
	const results = checks.map(([cmd, expected]) => {
		try {
			const out = execFileSync("/bin/bash", ["-lc", cmd], { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
			return { cmd, expected, ok: true, tail: `${out}`.slice(-400) };
		} catch (e) {
			const err = e as { stdout?: string; message?: string };
			return { cmd, expected, ok: false, tail: `${err.stdout ?? ""}${err.message ?? String(e)}`.slice(-400) };
		}
	});
	return { at: new Date().toISOString(), passed: results.every((r) => r.ok), results };
}

/** `git diff --stat` tail: the volatile "what changed since" line a fresh lane needs. */
export function diffStat(repo: string): string {
	try {
		const out = execFileSync("git", ["-C", repo, "diff", "--stat"], { timeout: 5_000, maxBuffer: 1 << 20, encoding: "utf8" });
		const tail = `${out}`.trim().split("\n").slice(-6).join("\n");
		return tail || "(working tree clean)";
	} catch (e) {
		return `(git diff failed: ${msg(e)} in ${repo})`;
	}
}

/**
 * Condensed handover — the "get on topic faster" contract. The prompt is built STABLE FIRST:
 * goal, phase contract, task definitions; the volatile tail (statuses, gate tails, rejections,
 * diff stat) goes last. Basalt's conversation cache reuses a request's prefix (measured
 * `hit_rate` / `reused` on /metrics: 44.9% early, 82.3% once the prefix settles; 106k-token
 * prefill ran 3.5 s at 1,499 tok/s, so a 2–6k condensed handover costs tenths of a second), and a
 * prefix that changes near the end keeps the cache warm — the same discipline a new lane gets
 * for free when it starts from this digest instead of replaying the transcript.
 */
export function handover(run: RunState): { stable: string[]; volatile: string[] } {
	const stable = [
		`Resume of orchestrated run ${run.run_id} (${run.state}, round ${run.round}/${run.max_rounds}).`,
		`Goal: ${run.goal}`,
		`Phase contract: call the fade_phase tool with ONE validated phase per turn — planning_done {"tasks":[...],"checks":[["cmd","expected"]]}; coding_done {"done":[{"id","status","result"}]}; verification_done {"verdict":"accepted|needs_repair","checks":[[...]],"notes","tasks"}. Invalid payloads are refused by name.`,
		`Checks the plan declares: ${JSON.stringify(run.checks)}`,
		`Task definitions: ${JSON.stringify(
			run.tasks.map((t) => ({ id: t.id, objective: t.objective, files: t.files, acceptance: t.acceptance, dependencies: t.dependencies })),
		)}`,
	];
	const volatile = [
		`Task state: ${JSON.stringify(run.tasks.map((t) => ({ id: t.id, status: t.status ?? "pending", result: t.result ?? "" })))}`,
		...(run.repair_tasks.length > 0 ? [`In repair: ${JSON.stringify(run.repair_tasks.map((t) => ({ id: t.id, objective: t.objective, acceptance: t.acceptance })))}`] : []),
		...(run.gate_last && run.gate_last.passed === false
			? [`Last pre-swap gate FAILED: ${JSON.stringify(run.gate_last.results.filter((r) => !r.ok).map((r) => ({ cmd: r.cmd, tail: r.tail })))}`]
			: []),
		...(run.rejection_history.length > 0
			? [
					`Rejections so far (do not repeat): ${JSON.stringify(
						run.rejection_history.slice(-5).map((r) => ({ round: r.round, kind: r.kind, task: r.task_id, reason: r.reason })),
					)}`,
				]
			: []),
		`Working tree: ${diffStat(run.repo)}`,
	];
	return { stable, volatile };
}

/** Condensed handover as one message: what /orchestrate handover sends and a resume opens with. */
export function handoverText(run: RunState): string {
	const h = handover(run);
	return [
		...h.stable,
		"",
		...h.volatile,
		"",
		`Continue from here: the resident lane is ${run.lane}. Report the next phase with fade_phase.`,
	].join("\n");
}

export interface Task {
	id: string;
	objective: string;
	files: string[];
	acceptance: string;
	dependencies: string[];
	round: number;
	status?: string;
	result?: string;
}

export interface PhaseLog {
	phase: string;
	lane: string;
	accepted: boolean;
	round: number;
	at: string;
	/** The phase payload's `notes`, kept verbatim: the overlay shows the last verifier critique. */
	notes?: string;
}

export interface RunState {
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
	/** v2: every bounced phase/payload, newest last; the repair briefing feeds the last five. */
	rejection_history: Rejection[];
	/** v2: count of schema-refused fade_phase payloads; at 2+ the tool returns SCHEMA_HINT. */
	schema_retries: number;
	/** v2: last pre-swap gate run on the code lane (T4); the gate briefing replays the tails. */
	gate_last?: GateResult;
	/** v2: plan-size tier from planning_done (S ≤2 tasks, M ≤4, L more). */
	tier?: "S" | "M" | "L";
}

export function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Temp + rename: a reader never sees a half-written record. */
export function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}

export function isRepoRelative(path: string): boolean {
	if (typeof path !== "string" || path.trim() === "" || isAbsolute(path)) return false;
	return !path.split(/[\\/]/).includes("..");
}

export function validateTasks(raw: unknown): { tasks?: Task[]; error?: string } {
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

export function validateChecks(raw: unknown): { checks?: [string, string][]; error?: string } {
	if (!Array.isArray(raw)) return { error: "checks must be an array" };
	const checks: [string, string][] = [];
	for (const pair of raw) {
		if (!Array.isArray(pair) || pair.length !== 2 || pair.some((x) => typeof x !== "string")) return { error: "each check must be [command, expected]" };
		checks.push([pair[0] as string, pair[1] as string]);
	}
	return { checks };
}

export const briefings = {
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
	repair: (run: RunState): string => {
		const prior = (run.rejection_history ?? []).slice(-5).map((r) => `round ${r.round} [${r.kind}]${r.task_id ? ` ${r.task_id}:` : ""} ${r.reason}`);
		return [
			`Phase 1 (repair), round ${run.round} of orchestrated run ${run.run_id}.`,
			`Goal: ${run.goal}`,
			`Repair tasks: ${JSON.stringify(run.repair_tasks)}`,
			...(prior.length > 0 ? ["Previously rejected — fix the cause, do not repeat the attempt:", ...prior.map((p) => `  ${p}`)] : []),
			`Implement the repairs in ${run.repo}, run each acceptance command, do not commit.`,
			`Then call the fade_phase tool: phase="coding_done", payload={"done":[{"id":"T<n>","status":"passed"|"failed"|"blocked","result":"..."}]}`,
		].join("\n");
	},
	gate: (run: RunState): string => {
		const failing = (run.gate_last?.results ?? []).filter((r) => !r.ok);
		return [
			`Pre-swap gate RED, round ${run.round} of orchestrated run ${run.run_id} — the verifier lane was NOT loaded; the swap is only paid for a green tree.`,
			...failing.map((f) => `FAIL: ${f.cmd}\n  expected: ${f.expected}\n  observed tail: ${f.tail}`),
			`Fix the causes in ${run.repo} (the checks are the plan's own), re-run them yourself until they pass, then call fade_phase phase="coding_done" again.`,
		].join("\n");
	},
	final: (run: RunState): string => {
		const path = join(run.repo, "var", "omp-orchestrate", STATE_FILENAME);
		if (run.state === "complete") return `Orchestrated run ${run.run_id} completed: verdict accepted after round ${run.round}. State and phase log: ${path}. Resident lane ${run.lane}; nothing is preloaded.`;
		if (run.state === "failed") return `Orchestrated run ${run.run_id} failed at round ${run.round} in state ${run.state}: ${run.reason ?? "unreported"}. State file: ${path}.`;
		return `Orchestrated run ${run.run_id} stopped at round ${run.round}; resident lane left as ${run.lane}.`;
	},
};

export const LANES_LABEL = `${THINK_LANE} plans and verifies; ${CODE_LANE} codes.`;
