/**
 * The state machine's data half: the run schema, the phase/validation rules, and the briefings
 * each lane is fed. Behavior is the monolith's (deploy/omp/fade_orchestrate.ts, the 2026-11-15
 * split) — the wording of every validation error is load-bearing: the model steers by it.
 */
import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/**
 * One rejection: a phase the verifier bounced, a payload the schema refused (Y2: a formatting
 * slip, tracked as a COUNT, never a round and never a swap), a task forced, or a lane that ended
 * a turn with no `fade_phase` call at all (the Tier-1 protocol debt, Y1).
 */
export interface Rejection {
	round: number;
	at: string;
	kind: "verification" | "schema" | "task" | "protocol";
	task_id?: string;
	reason: string;
}
export const MAX_REJECTIONS = 50;

/**
 * v1/v2 state files are read by the SAME resume path: every field the protocol gate adds is
 * defaulted here, guarded by a type test so a value already carried in the file is never
 * clobbered. A pre-gate file resumes as a fresh, unpaused run with zero protocol debt.
 */
export function normalizeRun(st: RunState): RunState {
	// The arrays the surfaces deref are defaulted HERE, at the read boundary, because they are
	// measured missing in real files and every consumer that derefs one crashes a surface: a state
	// written mid-plan had no `phases` (the panel threw), a hand-seeded state had no `repair_tasks`
	// (the panel threw), and `tasks`/`checks` are read raw by the row (`src/ui.ts`), the briefing
	// builder (`core.ts` 286/337/343/344) and the gate (`index.ts` 756/1081). Defaulting the
	// protocol counters alone left that class alive on every surface but the panel (verifier review
	// 2026-11-15). A value already carried in the file is never clobbered.
	if (!Array.isArray(st.tasks)) st.tasks = [];
	if (!Array.isArray(st.repair_tasks)) st.repair_tasks = [];
	if (!Array.isArray(st.phases)) st.phases = [];
	if (!Array.isArray(st.checks)) st.checks = [];
	if (!Array.isArray(st.rejection_history)) st.rejection_history = [];
	if (typeof st.schema_retries !== "number") st.schema_retries = 0;
	if (typeof st.protocol_retries !== "number") st.protocol_retries = 0;
	if (typeof st.stall_count !== "number") st.stall_count = 0;
	if (typeof st.paused !== "boolean") st.paused = false;
	return st;
}

export function pushRejection(run: RunState, kind: Rejection["kind"], reason: string, task_id?: string): void {
	if (!Array.isArray(run.rejection_history)) run.rejection_history = [];
	run.rejection_history.push({ round: run.round, at: new Date().toISOString(), kind, reason, task_id });
	if (run.rejection_history.length > MAX_REJECTIONS) run.rejection_history.splice(0, run.rejection_history.length - MAX_REJECTIONS);
}

/** Count of recorded rejections of one kind. The schema separator (Y2) is a COUNT, not a new list. */
export function countRejections(run: RunState, kind: Rejection["kind"]): number {
	return (run.rejection_history ?? []).filter((r) => r.kind === kind).length;
}

/**
 * The Tier-1 protocol gate (Y1). A turn that ends without an accepted `fade_phase` payload is
 * protocol debt, NOT a coding round: `round` and `max_rounds` are never touched here, so the
 * round budget a plan reserved is not burned by a lane that stayed silent.
 *  stall_count 1 -> "nudge"      re-brief the lane in VRAM (no swap, no round)
 *  stall_count 2 -> "synthesize" build coding_done from git + gate exit codes (T2)
 *  stall_count 3 -> "stall"      circuit breaker: state stalled_protocol_error, paused (T3)
 * Any accepted phase clears the streak; `protocol_retries` keeps the cumulative count.
 */
export const STALL_SYNTHESIZE_AT = 2;
export const STALL_HALT_AT = 3;
export type TurnEnd = "phase" | "nudge" | "synthesize" | "stall";

export function classifyTurnEnd(run: RunState, hadPhase: boolean): TurnEnd {
	if (hadPhase) {
		run.stall_count = 0;
		return "phase";
	}
	run.protocol_retries = (run.protocol_retries ?? 0) + 1;
	run.stall_count = (run.stall_count ?? 0) + 1;
	if (run.stall_count >= STALL_HALT_AT) return "stall";
	if (run.stall_count >= STALL_SYNTHESIZE_AT) return "synthesize";
	return "nudge";
}

/**
 * Is `repo` a git working tree? Probed, never assumed. Outside a working tree `git diff` does NOT
 * fail cleanly: with two path args (and, measured 2026-11-15, with `--stat` alone in the harness's
 * own status call) it switches to `--no-index` mode and answers with its ~60-line usage page,
 * which then rides into the briefing as the `Working tree:` line. One quiet `rev-parse --git-dir`
 * answers for every git call the run makes, so the degraded state is named in one line.
 */
export function isGitRepo(repo: string): boolean {
	try {
		execFileSync("git", ["-C", repo, "rev-parse", "--git-dir"], { timeout: 5_000, maxBuffer: 1 << 20, encoding: "utf8", stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/** The one sentinel every git reader emits on a non-repo run root. */
export const notARepo = (repo: string): string =>
	`(not a git repo: ${repo} — no git evidence; start the run inside a working tree, or run \`git init\` in it)`;

/** `git status --porcelain` verbatim (capped): the T2 synthesizer's evidence base. */
export function porcelain(repo: string): string {
	if (!isGitRepo(repo)) return notARepo(repo);
	try {
		const out = execFileSync("git", ["-C", repo, "status", "--porcelain"], { timeout: 5_000, maxBuffer: 1 << 20, encoding: "utf8" });
		const head = `${out}`.replace(/\n+$/, "").split("\n").slice(0, 200).join("\n");
		return head || "(working tree clean)";
	} catch (e) {
		return `(git status failed: ${msg(e)} in ${repo})`;
	}
}

/**
 * Adaptive round budget: 2 rounds (code+verify) per planning, +1 per 2 tasks, floored at 3 and
 * capped at the requested budget. Measured basis: 6-task runs land inside 2 coding rounds;
 * the budget is for repair rounds, so a small plan must not reserve six swaps.
 */
export function adaptiveRounds(nTasks: number, budget: number): number {
	return Math.min(budget, Math.max(3, 2 + Math.ceil(nTasks / 2)));
}

/**
 * Emitted verbatim into the tool error after the second schema rejection (auto-repair hint).
 * Y7: the `coding_done` example shows TWO entries on purpose — the batch shape is what the lane
 * is taught, and the shape it sees in the hint is the shape it writes.
 */
export const SCHEMA_HINT =
	'Payload schemas (exact, no extra keys; payload is the JSON object serialized to a string): planning_done {"tasks":[{"id":"T1","objective":"...","files":["a/b.ts"],"acceptance":"one command and what it proves","dependencies":[]}],"checks":[["cmd","expected"]]}; coding_done {"done":[{"id":"T1","status":"passed|failed|blocked","result":"what the acceptance command observed"},{"id":"T2","status":"passed|failed|blocked","result":"what its acceptance command observed"}]} — ONE coding_done reports EVERY task of the window; verification_done {"verdict":"accepted|needs_repair","checks":[["cmd","observed"]],"notes":"the critique","tasks":[repair tasks, same shape as planning tasks]}.';

/** One pre-swap gate outcome: every check run deterministically, judged on exit code. */
export interface GateResult {
	at: string;
	passed: boolean;
	results: { cmd: string; expected: string; ok: boolean; invalid?: boolean; tail: string }[];
}
/**
 * Can bash even PARSE this check string? A check is a claim the machine runs, and a string that
 * does not parse fails before exec, so the gate records an exit code no tree state can move.
 * Measured on run `20261115T091232Z-rqtj`: the plan declared
 * `bash scripts/ops/scan_resident_parity.sh --artifacts <pinned dir>; echo $?` — `<pinned` is an
 * input redirect and `dir>` an output redirect whose required word is the `;` operator — and the
 * round livelocked: seven `coding_done` reports, seven identical refusals, zero lane loads, because
 * "the check failed" and "the check is not a command" looked identical to the gate. The gate must
 * never spawn such a row, and a plan that carries one is refused where the plan is authored.
 */
export function checkParses(cmd: string): { ok: boolean; detail: string } {
	try {
		execFileSync("/bin/bash", ["-n", "-c", cmd], { stdio: "pipe", timeout: 5_000 });
		return { ok: true, detail: "" };
	} catch (e) {
		const err = e as { stderr?: string; message?: string };
		return { ok: false, detail: `${err.stderr ?? ""}${err.message ?? String(e)}`.replace(/\s+/g, " ").slice(0, 220) };
	}
}

/**
 * The pre-swap gate (T4): the verifier swap costs a 13-25 s pack load; running the plan's own
 * checks on the code lane FIRST means the swap is only ever paid for a tree whose deterministic
 * checks already pass. Exit code is the verdict (deterministic); the `expected` text rides to
 * the verifier briefing for the judgement calls.
 */
export function runGate(checks: [string, string][], cwd: string): GateResult {
	const results = checks.map(([cmd, expected]) => {
		// A row that cannot parse is never spawned: its exit code is a property of the STRING, so
		// recording it as a code failure tells the coder to fix a tree that is already green.
		const parse = checkParses(cmd);
		if (!parse.ok) {
			return {
				cmd,
				expected,
				ok: false,
				invalid: true,
				tail: `not a command — bash -n: ${parse.detail} | plan defect: re-declare this check (planning_done); no tree state can make it pass`,
			};
		}
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

/**
 * The gate runs the plan's checks, and the checks are DATA. Measured 2026-11-15, run
 * 20261115T091232Z-rqtj: two of the eight commands were unrunnable (`--artifacts` is not a flag of
 * scan_resident_parity.sh, whose flags are --ref/--out/--lanes/--keep, and a `<placeholder>` is a
 * shell redirect, so `bash -lc` died on the `<`). They were repaired in `state.json`, and the gate
 * stayed red on the SAME two strings forever: `runGate` reads the owner session's in-memory
 * `run.checks`, and only `session_start` re-reads the file. Refresh the run's checks from the
 * on-disk state, keyed by `run_id` so a state file belonging to another run is never adopted, and
 * report the delta so the refresh is visible, never silent.
 */
export function refreshChecks(run: RunState, live: RunState | undefined): { changed: boolean; to: number; added: string[]; removed: string[] } {
	const before = run.checks.map((c) => c[0]);
	if (!live || live.run_id !== run.run_id || !Array.isArray(live.checks)) return { changed: false, to: before.length, added: [], removed: [] };
	const isPair = (c: unknown): c is [string, string] =>
		Array.isArray(c) && c.length === 2 && typeof c[0] === "string" && typeof c[1] === "string";
	const next: [string, string][] = (live.checks as unknown[]).filter(isPair);
	const after = next.map((c) => c[0]);
	if (JSON.stringify(before) === JSON.stringify(after)) return { changed: false, to: after.length, added: [], removed: [] };
	run.checks = next;
	return { changed: true, to: after.length, added: after.filter((c) => !before.includes(c)), removed: before.filter((c) => !after.includes(c)) };
}

/** `git diff --stat` tail: the volatile "what changed since" line a fresh lane needs. */
export function diffStat(repo: string): string {
	if (!isGitRepo(repo)) return notARepo(repo);
	try {
		const out = execFileSync("git", ["-C", repo, "diff", "--stat"], { timeout: 5_000, maxBuffer: 1 << 20, encoding: "utf8" });
		const tail = `${out}`.trim().split("\n").slice(-6).join("\n");
		return tail || "(working tree clean)";
	} catch (e) {
		return `(git diff failed: ${msg(e)} in ${repo})`;
	}
}

/** One `git status --porcelain` entry: the XY code and the live path (a rename's DESTINATION). */
export interface PorcelainEntry {
	status: string;
	path: string;
}

/**
 * Parse the porcelain lines. Only a real entry counts: the XY pair must be git's status alphabet
 * followed by the space separator, so the sentinel lines `porcelain()` emits on a clean tree or a
 * failed git call parse to ZERO entries — every task then reports `blocked`, naming that line.
 */
const XY = /^[ MADRCU?!][ MADRCU?!] /;

export function porcelainEntries(text: string): PorcelainEntry[] {
	const out: PorcelainEntry[] = [];
	for (const line of text.split("\n")) {
		if (!XY.test(line)) continue;
		const status = line.slice(0, 2);
		let path = line.slice(3);
		const arrow = path.indexOf(" -> ");
		if (arrow >= 0) path = path.slice(arrow + 4);
		out.push({ status, path: path.replace(/^"|"$/g, "") });
	}
	return out;
}

/** Does a status entry touch one of a task's declared files? An untracked DIRECTORY (`new/`) counts. */
function entryTouches(e: PorcelainEntry, files: string[]): boolean {
	return files.some((f) => {
		if (e.path === f) return true;
		const entryDir = e.path.endsWith("/") ? e.path : `${e.path}/`;
		const fileDir = f.endsWith("/") ? f : `${f}/`;
		return f.startsWith(entryDir) || e.path.startsWith(fileDir);
	});
}

/** The last pre-swap gate as one line: the verdict plus every deterministic tail. */
export function gateSummary(run: RunState): string {
	const g = run.gate_last;
	if (!g) return "(no pre-swap gate recorded)";
	const parts = g.results.map((r) => `${r.ok ? "ok" : r.invalid ? "INVALID" : "FAIL"} ${r.cmd}${r.ok ? "" : ` -> ${r.tail}`}`);
	return `gate ${g.at} ${g.passed ? "GREEN" : "RED"}: ${parts.join(" | ") || "no checks"}`;
}

export interface SynthesizedDone {
	done: { id: string; status: string; result: string }[];
	sources: { porcelain: string; diffStat: string; gate: string };
}

/**
 * Tier-1 T2 (Y1): the coder lane ended a turn with no `fade_phase` call twice. The result is
 * SYNTHESIZED from what the machine can prove — `git status --porcelain`, `git diff --stat` and
 * the deterministic pre-swap gate exit codes — never from a model's word. A task whose declared
 * files are absent from the porcelain output is `blocked`, naming the evidence that is missing;
 * nothing here ever claims a result no source supports.
 */
export function synthesizeCodingDone(run: RunState, repo: string): SynthesizedDone {
	const raw = porcelain(repo);
	const entries = porcelainEntries(raw);
	const stat = diffStat(repo);
	const gate = gateSummary(run);
	const tasks = run.tasks.length > 0 ? run.tasks : run.repair_tasks;
	const done = tasks.map((t) => {
		const hits = entries.filter((e) => entryTouches(e, t.files));
		if (hits.length === 0) {
			return { id: t.id, status: "blocked", result: `synthesize: no working-tree change matches ${JSON.stringify(t.files)} — git status --porcelain says [${raw.slice(0, 300)}]` };
		}
		const quoted = hits.slice(0, 8).map((e) => `${e.status} ${e.path}`).join(", ");
		return { id: t.id, status: "passed", result: `synthesize: git status --porcelain shows ${hits.length} ${hits.length === 1 ? "entry" : "entries"} touching this task's declared files [${quoted}]` };
	});
	run.synthesized = { phase: "coding_done", round: run.round, at: new Date().toISOString() };
	return { done, sources: { porcelain: raw, diffStat: stat, gate } };
}

/** Y16: tags are namespaced per run so a repair round never shadows an earlier run's checkpoint. */
export function checkpointName(run: RunState, taskId: string): string {
	return `omp-ckpt/${run.run_id}/${taskId}-passed`;
}

/**
 * Checkpoint the tree at the moment a task passed (Y16). The orchestrator never commits, so the
 * tag names the HEAD the task was accepted against; `git checkout -f <tag> -- .` plus
 * `git clean -fd` against the pair restores the tree exactly. Re-tagging a re-passed task moves
 * the tag forward (`-f`) instead of failing the phase.
 */
export function tagCheckpoint(repo: string, run: RunState, taskId: string): { tag: string; ok: boolean; error?: string } {
	const tag = checkpointName(run, taskId);
	if (!isGitRepo(repo)) return { tag, ok: false, error: `not a git repo: ${repo} — no checkpoint tag is possible` };
	try {
		execFileSync("git", ["-C", repo, "tag", "-f", tag], { timeout: 5_000, maxBuffer: 1 << 20, encoding: "utf8" });
		if (typeof run.checkpoints !== "object" || run.checkpoints === null) run.checkpoints = {};
		run.checkpoints[taskId] = tag;
		return { tag, ok: true };
	} catch (e) {
		return { tag, ok: false, error: msg(e) };
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
	/** Y1: cumulative turns that ended with NO fade_phase call; the round budget never moves. */
	protocol_retries?: number;
	/** Y1: consecutive phase-less turns; 1 nudge, 2 synthesize, 3 stall. Reset by any accepted phase. */
	stall_count?: number;
	/** Y1 T3 / Y13: the loop is halted (circuit breaker) or operator-paused; nothing more is sent. */
	paused?: boolean;
	/** Y13: the operator's note, recorded by [s]/[p] and replayed in the handover. */
	operator_note?: string;
	/** Y1 T2: a coding_done the machine synthesized from git + gate exit codes, not from the lane. */
	synthesized?: { phase: string; round: number; at: string };
	/** Y16: task id -> the checkpoint tag naming the HEAD that task passed against. */
	checkpoints?: Record<string, string>;
}

export function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/**
 * Durable write (Y5): temp + fsync + rename + fsync of the parent directory. A `kill -9` in the
 * middle of a multi-hour run leaves `state.json` parsing as the PREVIOUS phase — a reader never
 * sees a half-written record, and the rename itself survives the crash because the directory
 * entry is flushed after it. Directory fsync is best-effort (platforms that refuse an `r` fd on
 * a directory must not fail the phase).
 */
export function writeJson(path: string, value: unknown): void {
	const dir = join(path, "..");
	mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp`;
	const fd = openSync(tmp, "w");
	try {
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	try {
		const dfd = openSync(dir, "r");
		try {
			fsyncSync(dfd);
		} finally {
			closeSync(dfd);
		}
	} catch {
		/* the rename is already atomic; the directory flush is the durability we can add, not the record */
	}
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
		const cmd = pair[0] as string;
		// A check is a claim the machine RUNS. Refuse one that is not a command HERE, at the plan's
		// authoring edge: a `bash -n` failure never execs, so it is red for every tree the run can
		// produce, and a plan carrying one livelocks the coder (run 20261115T091232Z-rqtj: seven
		// refusals, zero lane loads, because the gate could not tell a broken string from a failure).
		const parse = checkParses(cmd);
		if (!parse.ok) {
			return {
				error: `check ${checks.length + 1} is not a command — bash cannot parse it: ${parse.detail} | the command ${JSON.stringify(cmd)} (a <placeholder> in the text is a shell redirect, not an argument); re-declare the check with a runnable command (e.g. the tool's own --ref/--root form)`,
			};
		}
		checks.push([cmd, pair[1] as string]);
	}
	return { checks };
}

/** The phase note a plan act leaves in `phases`, and the bound: ONE plan act per round. */
export const PLAN_ACT_NOTE = "plan act: checks re-declared (the gate proved a check is not a command)";

/**
 * Is `b` the SAME plan as `a`? A plan act re-declares the CHECKS the gate proved to be
 * non-commands; the tasks are not up for renegotiation mid-round, so equality is element for
 * element on every planning field (`round`/`status`/`result` are machine state, not the plan).
 */
export function sameTaskPlan(a: Task[], b: unknown[]): boolean {
	if (!Array.isArray(b) || a.length !== b.length) return false;
	const key = (t: { id: string; objective: string; files: string[]; acceptance: string; dependencies: string[] }) =>
		JSON.stringify([t.id, t.objective, [...t.files].sort(), t.acceptance, [...t.dependencies].sort()]);
	const want = a.map(key).sort();
	const got = (b as Parameters<typeof key>[0][]).map(key).sort();
	return want.length === got.length && want.every((k, i) => k === got[i]);
}

/**
 * Y7: the tasks ONE coder window takes. The unit of cost is the lane swap — 15-20 s and
 * 52-130 GiB, paid once per turn at `agent_end` — so a round costs the NUMBER OF WINDOWS, not the
 * number of tasks: a 3-task plan reported one task per turn pays six transitions where two do the
 * job.
 *
 * 4 is set against the bounds this file and `index.ts` already publish:
 *  - planning calls `tasks.length <= 4` tier M, so a whole M plan is ONE window: a 3-task round
 *    is code + verify — exactly 2 swaps, by construction;
 *  - `adaptiveRounds` budgets the plan at 2 tasks per round (2 + ceil(n/2)), so 4 is DOUBLE the
 *    rate the round budget assumes: the plan the planner sizes for two coding rounds lands in one
 *    window and leaves the reserved rounds for repairs;
 *  - the plan ceiling is `MAX_TASKS` (6 in this build, 8 at the ceiling), so 4 keeps every task
 *    card UNTRUNCATED (objective, files, acceptance, dependencies) inside one coder context along
 *    with its own test runs, and bounds a bounced window to at most half a maximal plan — a
 *    repair round is never "redo the whole plan".
 */
export const MAX_WINDOW_TASKS = 4;

/** One open task this window cannot start, and the dependency ids that hold it. */
export interface WindowBlocked {
	id: string;
	blockedBy: string[];
}

export interface RoundWindow {
	/** The tasks this window implements, in plan order, capped at `MAX_WINDOW_TASKS`. */
	readyNow: Task[];
	/** Open tasks with at least one unmet dependency, naming the unmet ids. */
	blocked: WindowBlocked[];
	/** Every task not yet passed — an operator's forced-pass skip (`[s]`) has left the window. */
	open: Task[];
}

/**
 * The task pool the current coding turn is briefed on, the same choice `[s] skip` makes in
 * `keymap.ts`: a non-empty repair list IS this round's plan, otherwise the run's plan.
 * `roundWindow`, `validateDone` and `applyDone` all read this pool, so the window it computes,
 * the briefing it sends and the tasks it marks can never disagree.
 */
export function windowPool(run: RunState): Task[] {
	return (run.repair_tasks ?? []).length > 0 ? run.repair_tasks : run.tasks;
}

/**
 * Y7: the window the coder takes in THIS turn. `open` is every unpassed task in the pool;
 * `readyNow` is the open tasks whose every dependency is resolved (passed, including a forced
 * skip), in plan order, capped at `MAX_WINDOW_TASKS`; `blocked` names each open task with an
 * unmet dependency and those ids. A ready task cut by the cap is in neither list — it is the NEXT
 * window's `readyNow`, and `briefings.window` names it so the lane never starts it early.
 */
export function roundWindow(run: RunState): RoundWindow {
	const pool = windowPool(run);
	const resolved = new Set(pool.filter((t) => t.status === "passed").map((t) => t.id));
	const unmet = (t: Task) => t.dependencies.filter((d) => !resolved.has(d));
	const open = pool.filter((t) => t.status !== "passed");
	const readyNow = open.filter((t) => unmet(t).length === 0).slice(0, MAX_WINDOW_TASKS);
	const taken = new Set(readyNow.map((t) => t.id));
	const blocked = open
		.filter((t) => !taken.has(t.id))
		.map((t) => ({ id: t.id, blockedBy: unmet(t) }))
		.filter((b) => b.blockedBy.length > 0);
	return { readyNow, blocked, open };
}

/** One reported task of a `coding_done` payload. */
export interface DoneEntry {
	id: string;
	status: string;
	result?: string;
}

/** The rule in the lane's own words; every refusal quotes it so the model can act on it. */
export const WINDOW_RULE = "one coding_done per window: report EVERY task of this window in ONE payload, never one payload per task";

/**
 * Y7: validate a whole `coding_done` — SEVERAL tasks at once, all of them marked by `applyDone`.
 * A payload naming NO task in `roundWindow().readyNow` while one exists is refused with the rule
 * named: that one-task-per-turn report is exactly what makes a 3-task round cost six swaps, and
 * the refusal is what closes the per-task window.
 */
export function validateDone(run: RunState, raw: unknown): { done?: DoneEntry[]; error?: string } {
	if (!Array.isArray(raw) || raw.length === 0) return { error: "coding_done needs a non-empty done[]" };
	const ids = new Set(windowPool(run).map((t) => t.id));
	const done: DoneEntry[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) return { error: "each done entry must be an object" };
		const e = item as Record<string, unknown>;
		if (typeof e.id !== "string" || !ids.has(e.id)) return { error: `done entry ${JSON.stringify(e.id)} is not a task of this run` };
		if (done.some((d) => d.id === e.id)) return { error: `duplicate done entry for ${e.id as string}` };
		if (!["passed", "failed", "blocked"].includes(String(e.status))) return { error: `${e.id as string} status must be passed|failed|blocked` };
		done.push({ id: e.id as string, status: String(e.status), result: typeof e.result === "string" ? (e.result as string) : undefined });
	}
	const ready = roundWindow(run).readyNow;
	if (ready.length > 0 && !done.some((d) => ready.some((t) => t.id === d.id))) {
		return { error: `window rule (${WINDOW_RULE}): this window is ${ready.map((t) => t.id).join(",")}; ${JSON.stringify(done.map((d) => d.id))} names none of them` };
	}
	return { done };
}

/**
 * Mark every reported task. Pure state: `round`, `max_rounds` and `state` belong to the phase
 * application in `index.ts`, so marking a whole window spends no extra round and buys no swap
 * beyond the one this turn already pays. Returns the tasks it marked, in report order.
 */
export function applyDone(run: RunState, done: DoneEntry[]): Task[] {
	const pool = windowPool(run);
	const marked: Task[] = [];
	for (const d of done) {
		const task = pool.find((t) => t.id === d.id);
		if (!task) continue;
		task.status = d.status;
		task.result = d.result;
		marked.push(task);
	}
	return marked;
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
	/**
	 * Y7: the coder's BATCH briefing — one window, one turn, one `coding_done`. Every task of
	 * `roundWindow().readyNow` is spelled out UNTRUNCATED (objective, files, acceptance,
	 * dependencies) because a card the lane cannot read in full is a card it implements from
	 * imagination; the blocked tasks are listed with the ids that hold them so the lane knows what
	 * to leave alone; and the one-payload contract is stated in the turn's own words, which is the
	 * half that kills the per-task window (the refusal in `validateDone` is the other half).
	 */
	window: (run: RunState): string => {
		const { readyNow, blocked, open } = roundWindow(run);
		const inWindow = new Set(readyNow.map((t) => t.id));
		const blockedIds = new Set(blocked.map((b) => b.id));
		const deferred = open.filter((t) => !inWindow.has(t.id) && !blockedIds.has(t.id)).map((t) => t.id);
		const entry = (id: string) => `{"id":"${id}","status":"passed"|"failed"|"blocked","result":"what the acceptance command observed"}`;
		return [
			`Phase 1 (coding) — ONE WINDOW, round ${run.round}/${run.max_rounds} · T${readyNow.length}/${open.length} · lane ${run.lane} · orchestrated run ${run.run_id}.`,
			`Goal: ${run.goal}`,
			readyNow.length > 0
				? `Window contract: this ONE turn implements EVERY task below in ${run.repo} and reports them ALL in ONE coding_done payload: {"done":[${readyNow.map((t) => entry(t.id)).join(",")}]}. Do not report after one task and do not take a second coding turn for these tasks — one window, one coding_done, one lane swap.`
				: `The window is EMPTY: every open task is blocked by an unpassed dependency. There is nothing to implement in this turn — do not send a coding_done naming a blocked task; report the blockers and end the turn.`,
			readyNow.length > 0 ? `Tasks in this window (${readyNow.length} of ${open.length} open), each card in full:` : `Tasks in this window: none.`,
			...readyNow.flatMap((t) => [
				`  ${t.id} [${t.status ?? "pending"}] objective: ${t.objective}`,
				`      files: ${t.files.join(", ")}`,
				`      acceptance: ${t.acceptance}`,
				`      dependencies: ${t.dependencies.length > 0 ? t.dependencies.join(", ") : "-"}`,
			]),
			blocked.length > 0
				? `NOT in this window, unmet dependencies — do not start them and never name one in coding_done: ${blocked.map((b) => `${b.id} blocked by ${b.blockedBy.join(", ")}`).join("; ")}.`
				: `Nothing is blocked by a dependency.`,
			deferred.length > 0 ? `Ready but past the ${MAX_WINDOW_TASKS}-task window cap (the NEXT window's work, leave it alone now): ${deferred.join(", ")}.` : "",
			`Run each task's acceptance command and put what it printed in that task's "result". Do not commit.`,
		].filter(Boolean).join("\n");
	},
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
		const results = run.gate_last?.results ?? [];
		const invalid = results.filter((r) => r.invalid);
		const failing = results.filter((r) => !r.ok && !r.invalid);
		return [
			`Pre-swap gate RED, round ${run.round} of orchestrated run ${run.run_id} — the verifier lane was NOT loaded; the swap is only paid for a green tree.`,
			...invalid.map((f) => `INVALID CHECK (not a command, never executed): ${f.cmd}\n  expected: ${f.expected}\n  ${f.tail}`),
			...failing.map((f) => `FAIL: ${f.cmd}\n  expected: ${f.expected}\n  observed tail: ${f.tail}`),
			...(invalid.length > 0
				? [
						`${invalid.length} of the plan's checks are PLAN DEFECTS: bash refuses to parse them, so no state of ${run.repo} can make them green and no amount of coding will pay the swap. Fixing the tree is not the remedy — the exit is a plan act: call fade_phase phase="planning_done" with the rows re-declared as runnable commands (the tool's own --ref / --root / absolute-binary forms, no <placeholders>), keeping every task.`,
					]
				: []),
			`Fix the causes in ${run.repo} (the checks are the plan's own), re-run them yourself until they pass, then call fade_phase phase="coding_done" again.`,
		].join("\n");
	},
	final: (run: RunState): string => {
		const path = join(run.repo, "var", "omp-orchestrate", STATE_FILENAME);
		if (run.state === "complete") return `Orchestrated run ${run.run_id} completed: verdict accepted after round ${run.round}. State and phase log: ${path}. Resident lane ${run.lane}; nothing is preloaded.`;
		if (run.state === "failed") return `Orchestrated run ${run.run_id} failed at round ${run.round} in state ${run.state}: ${run.reason ?? "unreported"}. State file: ${path}.`;
		return `Orchestrated run ${run.run_id} stopped at round ${run.round}; resident lane left as ${run.lane}.`;
	},
	/**
	 * Y1 Tier 1: the lane ended its turn without calling `fade_phase`. No round was spent and no
	 * swap happens — the same lane is re-briefed in VRAM with the ONE thing it owes, plus the
	 * published schema, and told exactly what the next miss costs.
	 */
	nudge: (run: RunState): string => {
		const phase = PHASE_FOR_STATE[run.state] ?? "coding_done";
		return [
			`Protocol nudge ${run.stall_count ?? 1}/${STALL_SYNTHESIZE_AT} — orchestrated run ${run.run_id}, state ${run.state}, round ${run.round}/${run.max_rounds} (UNSPENT: the round budget does not move here), lane ${run.lane}.`,
			`Your turn ended with NO fade_phase call. The loop cannot advance without it and will not swap lanes.`,
			`Call the fade_phase tool NOW: phase="${phase}", payload=<the JSON object serialized to a string>.`,
			SCHEMA_HINT,
			`The work is done? Say so with the acceptance command and what it printed in "result". The work is NOT done? Finish it, then report.`,
			`The next miss auto-synthesizes this round's coding_done from git and the gate exit codes; the one after halts the run as stalled_protocol_error.`,
		].join("\n");
	},
	/**
	 * Y1 Tier 3: the circuit breaker tripped. The run is paused, the lane is left as it is, and
	 * this is the diagnostic an operator acts on: what the machine saw, what is RED, what git
	 * says, and the exact files to open.
	 */
	stalled: (run: RunState): string => {
		const path = join(run.repo, "var", "omp-orchestrate", STATE_FILENAME);
		const phases = (run.phases ?? []).slice(-3).map((p) => `${p.phase} round ${p.round} accepted=${p.accepted}${p.notes ? ` notes=${p.notes}` : ""}`);
		const failing = (run.gate_last?.results ?? []).filter((r) => !r.ok).map((r) => `  RED: ${r.cmd}\n    expected: ${r.expected}\n    observed: ${r.tail}`);
		const rejections = (run.rejection_history ?? []).slice(-5).map((r) => `  round ${r.round} [${r.kind}]${r.task_id ? ` ${r.task_id}:` : ""} ${r.reason}`);
		return [
			`Orchestrated run ${run.run_id} HALTED: stalled_protocol_error — ${run.protocol_retries ?? 0} turn(s) ended with no fade_phase call (state ${run.state}, round ${run.round}/${run.max_rounds}, lane ${run.lane}). The loop is paused; nothing further is sent to any lane and no lane was swapped.`,
			phases.length > 0 ? `Last phases the machine saw: ${phases.join(" | ")}` : `No phase was ever accepted by this run.`,
			run.synthesized ? `Synthesized coding_done at round ${run.synthesized.round} (${run.synthesized.at}): ${JSON.stringify(run.synthesized)}` : `Nothing was synthesized.`,
			`Deterministic gate: ${gateSummary(run)}`,
			...(failing.length > 0 ? ["Checks that are RED:", ...failing] : []),
			...(rejections.length > 0 ? ["Recent rejections:", ...rejections] : []),
			`Working tree: ${diffStat(run.repo)}`,
			run.operator_note ? `Operator note: ${run.operator_note}` : "",
			`Act on it: read ${path}, run the plan's own checks in ${run.repo}, then /orchestrate pause to unpause in place, /orchestrate code to resume on the code lane, or /orchestrate stop to end the run.`,
		].filter(Boolean).join("\n");
	},
};

export const LANES_LABEL = `${THINK_LANE} plans and verifies; ${CODE_LANE} codes.`;
