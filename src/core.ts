/**
 * The state machine's data half: the run schema, the phase/validation rules, and the briefings
 * each lane is fed. The wording of every validation error is load-bearing — the model steers by
 * the exact text — so it is part of the protocol, not decoration.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { msg } from "./router.ts";
import { WORKER_AGENT } from "./subagent.ts";

const execFileAsync = promisify(execFile);

/**
 * One `git` call, OFF the TUI's loop. Every git reader in this file used `execFileSync`, which
 * holds the host's paint loop for the spawn: a repo the size of this one costs 20-60 ms per
 * `status`, and the synthesizer fired four of them back to back at a turn boundary. The bounds
 * are the sync form's (`timeout` 5 s, 1 MiB) so a hung git cannot park a lane load.
 */
export async function execGitAsync(repo: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
		timeout: opts.timeout ?? 5_000,
		maxBuffer: opts.maxBuffer ?? 1 << 20,
		encoding: "utf8",
	});
	return `${stdout}`;
}

export const STATE_KEY = "fade.omp_orchestrate.v1";
export const ACTIVE_FILENAME = "ACTIVE.json";
export const STATE_FILENAME = "state.json";
export const DEFAULT_ROUNDS = 6;
export const MAX_ROUNDS = 6;
export const MAX_TASKS = 6;
export const TERMINAL: Record<string, true> = { complete: true, failed: true, stopped: true };
export const PHASE_FOR_STATE: Record<string, string> = { planning: "planning_done", coding: "coding_done", repair: "coding_done", verifying: "verification_done" };

/**
 * One rejection: a phase the verifier bounced, a payload the schema refused (a formatting slip,
 * tracked as a COUNT, never a round and never a swap), a task forced, or a lane that ended a
 * turn with no `fade_phase` call at all (the protocol debt).
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
	// The arrays the surfaces deref are defaulted HERE, at the read boundary, because real state
	// files arrive without them and every consumer that derefs one crashes a surface: a state
	// written mid-plan has no `phases` (the panel throws), a hand-seeded state has no
	// `repair_tasks` (the panel throws), and `tasks`/`checks` are read raw by the row, the
	// briefing builder and the gate. Defaulting the protocol counters alone leaves that class
	// alive on every surface. A value already carried in the file is never clobbered.
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

/** Count of recorded rejections of one kind. The schema separator is a COUNT, not a new list. */
export function countRejections(run: RunState, kind: Rejection["kind"]): number {
	return (run.rejection_history ?? []).filter((r) => r.kind === kind).length;
}

/**
 * The protocol nudge ladder. A turn that ends without an accepted `fade_phase` payload is
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
 * fail cleanly: with two path args, and with `--stat` alone, it switches to `--no-index` mode
 * and answers with its ~60-line usage page, which then rides into the briefing as the
 * `Working tree:` line. One quiet `rev-parse --git-dir` answers for every git call the run makes,
 * so the degraded state is named in one line.
 *
 * ASYNC, and the answer is CACHED per repo for `FADE_ORCHESTRATE_REPO_PROBE_TTL_MS` (default
 * 15 s): the run's root does not move, and ONE phase asks this question from the caveat, the
 * handover, the diff stat, the synthesizer and every checkpoint tag — ten spawns per phase all
 * answering the same fact, each one on the TUI's loop. The cache is a TTL, not a permanent memo,
 * so a root that gets `git init`ed mid-run is noticed; `0` re-probes every call.
 */
let repoProbe: { repo: string; at: number; answer: Promise<boolean> } | undefined;

export function isGitRepo(repo: string): Promise<boolean> {
	const ttl = Number(process.env.FADE_ORCHESTRATE_REPO_PROBE_TTL_MS ?? 15_000);
	if (repoProbe && repoProbe.repo === repo && (ttl <= 0 || Date.now() - repoProbe.at < ttl)) return repoProbe.answer;
	const answer = execGitAsync(repo, ["rev-parse", "--git-dir"]).then(
		() => true,
		() => false,
	);
	repoProbe = { repo, at: Date.now(), answer };
	return answer;
}

/** The one sentinel every git reader emits on a non-repo run root. */
export const notARepo = (repo: string): string =>
	`(not a git repo: ${repo} — no git evidence; start the run inside a working tree, or run \`git init\` in it)`;

/** `git status --porcelain` verbatim (capped): the synthesizer's evidence base. */
export async function porcelain(repo: string): Promise<string> {
	if (!(await isGitRepo(repo))) return notARepo(repo);
	try {
		const out = await execGitAsync(repo, ["status", "--porcelain"]);
		const head = out.replace(/\n+$/, "").split("\n").slice(0, 200).join("\n");
		return head || "(working tree clean)";
	} catch (e) {
		return `(git status failed: ${msg(e)} in ${repo})`;
	}
}

/**
 * Adaptive round budget: 2 rounds (code+verify) per planning, +1 per 2 tasks, floored at 3 and
 * capped at the requested budget. The budget exists for repair rounds — long runs land inside
 * two coding rounds — so a small plan must not reserve six swaps.
 */
export function adaptiveRounds(nTasks: number, budget: number): number {
	return Math.min(budget, Math.max(3, 2 + Math.ceil(nTasks / 2)));
}

/**
 * Adaptive round budgets, declared by the PLAN. The tiers are trivial 2 / standard 4 / deep 6; a
 * flat six reserves five repair swaps for a two-line edit, and a swap is 13-25 s and 52-130 GiB.
 * A task declares `complexity` in `planning_done`, and the run's cap is the MAXIMUM tier it
 * declares — one deep task buys six rounds, a plan of trivial edits buys two.
 */
export type Complexity = "trivial" | "standard" | "deep";
export const TIER_ROUNDS: Record<Complexity, number> = { trivial: 2, standard: 4, deep: 6 };
export const isComplexity = (v: unknown): v is Complexity => v === "trivial" || v === "standard" || v === "deep";

/**
 * The run's round cap: the tiers the plan declares win (the max over its tasks); a plan that
 * declares none falls back to the task-count curve in `adaptiveRounds`; the operator's
 * `--rounds` budget is the ceiling in BOTH cases (an explicit budget outranks the plan). Floor 2:
 * one round is code + verify, so a run that cannot repair once is not a loop.
 */
export function roundsForTasks(tasks: Task[], budget: number): number {
	const declared = tasks.map((t) => t.complexity).filter(isComplexity);
	if (declared.length === 0) return adaptiveRounds(tasks.length, budget);
	return Math.min(budget, Math.max(2, ...declared.map((c) => TIER_ROUNDS[c])));
}

/**
 * Emitted verbatim into the tool error after the second schema rejection (auto-repair hint) and
 * carried by the protocol nudge. The three phases sit one per line inside a fenced block: the lane
 * copies the shape it can see. The `coding_done` line shows TWO entries on purpose because the
 * batch shape is what the lane is taught.
 */
export const SCHEMA_HINT = [
	"Payload schemas (exact, no extra keys; payload is the JSON object serialized to a string):",
	"```",
	'planning_done    {"tasks":[{"id":"T1","objective":"...","files":["a/b.ts"],"acceptance":"one command and what it proves","dependencies":[]}],"checks":[["cmd","expected"]]}',
	'coding_done      {"done":[{"id":"T1","status":"passed|failed|blocked","result":"what the acceptance command observed"},{"id":"T2","status":"passed|failed|blocked","result":"what its acceptance command observed"}]} — ONE coding_done reports EVERY task of the window',
	'verification_done {"verdict":"accepted|needs_repair","checks":[["cmd","observed"]],"notes":"the critique","tasks":[repair tasks, same shape as planning tasks]}',
	'verification_done  ·  optional "verdicts":[{"id":"V1.1","accepted":true,"notes":"…"}] — ONLY while a verification batch is open (the desk named its ids in your briefing): one row per id, and that write is what unblocks the workers parked in fade_verify',
	"```",
	'A planning check whose ACCEPTED state is not exit-0 says so in the expected text\'s first words — "fails: <why>" (a non-zero exit is the pass) or "no output: <why>" (empty stdout is the pass); anything else is judged on exit 0.',
].join("\n");

/** One pre-swap gate outcome: every check run deterministically, judged on exit code. */
export interface GateResult {
	at: string;
	passed: boolean;
	results: {
		cmd: string;
		expected: string;
		ok: boolean;
		invalid?: boolean;
		/** The exit state the plan ASKED for: `exit0` is the default; `nonzero`/`quiet` are declared. */
		want?: "exit0" | "nonzero" | "quiet";
		/** A declared-failure check that failed as declared: green, and labelled, never a silent pass. */
		as_expected?: boolean;
		/** The row never ran: the gate's TOTAL budget was spent by the rows before it. Named, so a
		 *  red gate says which rows are UNMEASURED, never silently fewer. */
		budget?: boolean;
		tail: string;
	}[];
	/** One advisory cause line for a RED gate, from the tails this gate already captured. It carries
	 *  NO authority: the verdict is the exit codes above, and a `coding_done` re-runs the checks. */
	triage?: string;
}
/**
 * Can bash even PARSE this check string? A check is a claim the machine runs, and a string that
 * does not parse fails before exec, so the gate records an exit code no tree state can move: a
 * `<placeholder>` in the text is an input redirect whose required word swallows the `;` operator,
 * and the round livelocks — repeated `coding_done` reports, identical refusals, zero lane loads,
 * because "the check failed" and "the check is not a command" look identical to the gate. The
 * gate must never spawn such a row, and a plan that carries one is refused where it is authored.
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
 * The plan's `expected` text can NAME a state that is not exit-0. "fails: <why>" declares the
 * accepted state to be a non-zero exit (a check that the tree is not a git repo before
 * `git init`), and "no output: <why>" declares empty stdout to be the pass. Under the plain
 * exit-0 rule both land as RED rows on a run whose expectations were met. The declared forms
 * are the head words below; anything else keeps the exit-0 rule.
 */
export function expectation(expected: string): "exit0" | "nonzero" | "quiet" {
	const e = (expected ?? "").trim();
	if (/^(no output|no matches?|empty( |$)|silent)\b/i.test(e)) return "quiet";
	if (/^(fails?|failed|non-?zero|exits? ?[1-9]\d*|exit code [1-9]\d*|[1-9]\d* ?(on exit|exit))\b/i.test(e)) return "nonzero";
	return "exit0";
}

/**
 * The gate's wall-clock bound ACROSS ALL the plan's checks. 120 s is ONE row's timeout; this is
 * the loop's, so a plan of ten hung commands cannot spend twenty minutes of the session. A row
 * that starts with the budget spent is never spawned and lands as a named red row.
 */
export const GATE_TOTAL_BUDGET_DEFAULT_MS = 600_000;
/** Read at CALL time, not load time: it is configuration, and a rig must be able to prove the
 *  bound in milliseconds. */
export const gateTotalBudgetMs = (): number => Math.max(1_000, Number(process.env.FADE_ORCHESTRATE_GATE_TOTAL_BUDGET_MS ?? GATE_TOTAL_BUDGET_DEFAULT_MS));

/** One row announced BEFORE it is spawned, so the caller can paint `gate i/n: <cmd>` and the
 *  operator watches the gate move instead of watching a frozen terminal. */
export type GateProgress = (row: { index: number; total: number; cmd: string }) => void;

/**
 * The pre-swap gate: the verifier swap costs a 13-25 s pack load; running the plan's own
 * checks on the code lane FIRST means the swap is only ever paid for a tree whose deterministic
 * checks already pass. Exit code is the verdict (deterministic); the `expected` text rides to
 * the verifier briefing for the judgement calls, and its head words can declare the accepted
 * exit state (see `expectation`).
 *
 * ASYNC on purpose. The synchronous form (`execFileSync`, 120 s per row, rows run back to back)
 * held the event loop for the whole run of the gate: the TUI stopped painting, keystrokes went
 * dead, and the swap watch's ticks were starved — the session read as a freeze, worst on the
 * slowest plan. Each check now runs as a child process awaited off the loop, so the host keeps
 * rendering, the panel keeps refreshing, and `onCheck` names the row that is running.
 */
export async function runGate(checks: [string, string][], cwd: string, onCheck?: GateProgress): Promise<GateResult> {
	const deadline = Date.now() + gateTotalBudgetMs();
	const results: GateResult["results"] = [];
	for (let i = 0; i < checks.length; i++) {
		const [cmd, expected] = checks[i];
		onCheck?.({ index: i + 1, total: checks.length, cmd });
		// A row that cannot parse is never spawned: its exit code is a property of the STRING, so
		// recording it as a code failure tells the coder to fix a tree that is already green.
		const parse = checkParses(cmd);
		if (!parse.ok) {
			results.push({
				cmd,
				expected,
				ok: false,
				invalid: true,
				want: "exit0" as const,
				tail: `not a command — bash -n: ${parse.detail} | plan defect: re-declare this check (planning_done); no tree state can make it pass`,
			});
			continue;
		}
		const want = expectation(expected);
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			results.push({
				cmd,
				expected,
				ok: false,
				want,
				budget: true,
				tail: `NOT RUN — the gate's ${Math.round(gateTotalBudgetMs() / 1000)} s total budget was spent by the rows before this one; this check is unmeasured (FADE_ORCHESTRATE_GATE_TOTAL_BUDGET_MS)`,
			});
			continue;
		}
		let out = "";
		try {
			const r = await execFileAsync("/bin/bash", ["-lc", cmd], { cwd, timeout: Math.min(120_000, remaining), maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
			out = r.stdout;
		} catch (e) {
			const err = e as { stdout?: string; status?: number; code?: number | string; killed?: boolean; signal?: string; message?: string };
			out = `${err.stdout ?? ""}`;
			// The sync form reported the exit code as `status`; the async form reports it as `code`.
			const code = typeof err.status === "number" ? err.status : typeof err.code === "number" ? err.code : undefined;
			const timedOut = err.killed === true && (err.signal === "SIGTERM" || err.code === "ETIMEDOUT");
			if (want === "nonzero") {
				results.push({ cmd, expected, ok: true, want, as_expected: true, tail: `as expected — the plan declares this state: ${expected} | exit ${code ?? "non-zero"}: ${`${out}${err.message ?? String(e)}`.slice(-300)}`.slice(-400) });
				continue;
			}
			if (want === "quiet" && out.trim() === "") {
				results.push({ cmd, expected, ok: true, want, as_expected: true, tail: `as expected — no output, exit ${code ?? "non-zero"}; the plan declares this state: ${expected}` });
				continue;
			}
			const suffix = timedOut ? ` | KILLED at the row's timeout (the command did not finish)` : "";
			results.push({ cmd, expected, ok: false, want, tail: `${out}${err.message ?? String(e)}${suffix}`.slice(-400) });
			continue;
		}
		// exit 0: a declared-failure row whose premise is stale is a REPORTED break, not a pass.
		if (want === "nonzero") {
			results.push({ cmd, expected, ok: false, want, tail: `expected a failure and the command exited 0 — the plan's declared state is stale, re-declare the check: ${expected} | ${out.slice(-300)}` });
			continue;
		}
		if (want === "quiet" && out.trim() !== "") {
			results.push({ cmd, expected, ok: false, want, tail: `expected no output and the command printed ${out.trim().split("\n").length} line(s): ${out.slice(0, 300)}` });
			continue;
		}
		results.push({ cmd, expected, ok: true, want, tail: `${out}`.slice(-400) });
	}
	return { at: new Date().toISOString(), passed: results.every((r) => r.ok), results };
}

/**
 * The gate runs the plan's checks, and the checks are DATA. Repairing a check string in
 * `state.json` does not move the gate: `runGate` reads the owner session's in-memory
 * `run.checks`, and only `session_start` re-reads the file, so the gate stays red on the SAME
 * repaired strings forever. Refresh the run's checks from the on-disk state, keyed by `run_id`
 * so a state file belonging to another run is never adopted, and report the delta so the
 * refresh is visible, never silent.
 *
 * The comparison is over the WHOLE pair. A row is `["<command>", "<accepted state>"]`, and the
 * accepted state is judged from the SECOND element: `expectation()` reads its head words
 * ("fails:", "exits 1", "no output:") to decide whether a non-zero exit is the pass. Re-declaring
 * a row's expected state — the repair a red row needs when the command is right and the declared
 * state was written in prose — changes no command, so a command-keyed refresh reports
 * `changed: false` and keeps judging the stale state forever.
 */
export function refreshChecks(run: RunState, live: RunState | undefined): { changed: boolean; to: number; added: string[]; removed: string[]; redrafted: number } {
	const before = run.checks;
	const none = { changed: false, to: before.length, added: [] as string[], removed: [] as string[], redrafted: 0 };
	if (!live || live.run_id !== run.run_id || !Array.isArray(live.checks)) return none;
	const isPair = (c: unknown): c is [string, string] =>
		Array.isArray(c) && c.length === 2 && typeof c[0] === "string" && typeof c[1] === "string";
	const next: [string, string][] = (live.checks as unknown[]).filter(isPair);
	if (JSON.stringify(before) === JSON.stringify(next)) return { ...none, to: next.length };
	const redrafted = before.filter((b) => next.some((a) => a[0] === b[0] && a[1] !== b[1])).length;
	run.checks = next;
	return {
		changed: true,
		to: next.length,
		added: next.filter((a) => !before.some((b) => b[0] === a[0])).map((a) => a[0]),
		removed: before.filter((b) => !next.some((a) => a[0] === b[0])).map((b) => b[0]),
		redrafted,
	};
}

/**
 * The run's ROOT is data as well, and it is the one field the gate cannot survive being wrong
 * about: every check is `bash -lc <cmd>` at `run.repo`, so a run started in repo A and aimed at
 * repo B fails on files that exist only in B — `No such file or directory`, `No module named
 * "<B's package>"`, a suite of thousands of A's tests — and no change inside B can ever pay that
 * gate. Adopt `repo` from the on-disk state on the same rule refreshChecks uses for the checks:
 * keyed by `run_id`, never for a path that is not a git working tree, and announced, never
 * silent. The refusal is returned so the caller can name the reason out loud.
 */
export async function refreshRoot(run: RunState, live: RunState | undefined, probe: (repo: string) => boolean | Promise<boolean> = isGitRepo): Promise<{ changed: boolean; from: string; to: string; refused?: string }> {
	if (!live || live.run_id !== run.run_id || typeof live.repo !== "string" || live.repo === "") return { changed: false, from: run.repo, to: run.repo };
	if (live.repo === run.repo) return { changed: false, from: run.repo, to: run.repo };
	if (!(await probe(live.repo))) return { changed: false, from: run.repo, to: run.repo, refused: `${live.repo} is not a git working tree` };
	const from = run.repo;
	run.repo = live.repo;
	return { changed: true, from, to: live.repo };
}

/** `git diff --stat` tail: the volatile "what changed since" line a fresh lane needs. */
export async function diffStat(repo: string): Promise<string> {
	if (!(await isGitRepo(repo))) return notARepo(repo);
	try {
		const out = await execGitAsync(repo, ["diff", "--stat"]);
		const tail = out.trim().split("\n").slice(-6).join("\n");
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
	const parts = g.results.map((r) => `${r.ok ? (r.as_expected ? "ok*" : "ok") : r.invalid ? "INVALID" : "FAIL"} ${r.cmd}${r.ok ? "" : ` -> ${r.tail}`}`);
	const asExp = g.results.filter((r) => r.as_expected).length;
	return `gate ${g.at} ${g.passed ? "GREEN" : "RED"}${asExp ? ` (${asExp} as expected)` : ""}: ${parts.join(" | ") || "no checks"}`;
}

export interface SynthesizedDone {
	done: { id: string; status: string; result: string }[];
	sources: { porcelain: string; diffStat: string; gate: string };
}

/**
 * The coder lane ended a turn with no `fade_phase` call twice. The result is SYNTHESIZED from
 * what the machine can prove — `git status --porcelain`, `git diff --stat` and the deterministic
 * pre-swap gate exit codes — never from a model's word. A task whose declared files are absent
 * from the porcelain output is `blocked`, naming the evidence that is missing; nothing here
 * ever claims a result no source supports.
 *
 * ASYNC: the four git calls this used to fire (`rev-parse` twice, `status`, `diff`) ran back to
 * back through `execFileSync` at a turn boundary, on the TUI's own loop. ONE cached repo probe
 * feeds both readers, and the two readers run together.
 */
export async function synthesizeCodingDone(run: RunState, repo: string): Promise<SynthesizedDone> {
	const [raw, stat] = await Promise.all([porcelain(repo), diffStat(repo)]);
	const entries = porcelainEntries(raw);
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

/** Tags are namespaced per run so a repair round never shadows an earlier run's checkpoint. */
export function checkpointName(run: RunState, taskId: string): string {
	return `omp-ckpt/${run.run_id}/${taskId}-passed`;
}

/**
 * Checkpoint the tree at the moment a task passed. The orchestrator never commits, so the tag
 * names the HEAD the task was accepted against; `git checkout -f <tag> -- .` plus `git clean
 * -fd` against the pair restores the tree exactly. Re-tagging a re-passed task moves the tag
 * forward (`-f`) instead of failing the phase.
 *
 * ASYNC, and the repo probe is the CACHED one: a phase that passes twelve tasks used to pay
 * twenty-four sync spawns (probe + tag, per task) on the tool's own return path.
 */
export async function tagCheckpoint(repo: string, run: RunState, taskId: string): Promise<{ tag: string; ok: boolean; error?: string }> {
	const tag = checkpointName(run, taskId);
	if (!(await isGitRepo(repo))) return { tag, ok: false, error: `not a git repo: ${repo} — no checkpoint tag is possible` };
	try {
		await execGitAsync(repo, ["tag", "-f", tag]);
		if (typeof run.checkpoints !== "object" || run.checkpoints === null) run.checkpoints = {};
		run.checkpoints[taskId] = tag;
		return { tag, ok: true };
	} catch (e) {
		return { tag, ok: false, error: msg(e) };
	}
}

/**
 * Negative memory per task: the critiques THIS task has already been given, with the count and
 * the round the newest landed. The failure this guards against is a run oscillating between two
 * broken fixes across repair rounds, and the cure is per-task: a coder that sees a flat
 * transcript of everything the verifier ever said does not know which critique is about the file
 * it is editing, and re-issues the same diff.
 */
export function critiquesFor(run: RunState, ids: string[]): string[] {
	const out: string[] = [];
	for (const id of ids) {
		const hits = (run.rejection_history ?? []).filter((r) => (r.task_id === id || `${r.reason}`.includes(id)) && (r.kind === "verification" || r.kind === "task"));
		if (hits.length === 0) continue;
		const last = hits[hits.length - 1];
		out.push(`  ${id} — rejected ${hits.length}× (latest round ${last.round}, ${last.kind}): ${last.reason}${hits.length > 1 ? "  ⇐ the same diff was already tried; change the CAUSE, not the wording" : ""}`);
	}
	return out;
}

/**
 * Condensed handover — the "get on topic faster" contract. The prompt is built STABLE FIRST:
 * goal, phase contract, task definitions; the volatile tail (statuses, gate tails, rejections,
 * diff stat) goes last. Basalt's conversation cache reuses a request's prefix, and a prefix that
 * changes near the end keeps the cache warm — the same discipline a new lane gets for free when
 * it starts from this digest instead of replaying the transcript.
 */
export async function handover(run: RunState): Promise<{ stable: string[]; volatile: string[] }> {
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
		...(run.gate_last?.triage
			? [`Gate triage (ADVISORY, no authority — the gate's exit codes are the verdict; name the cause you actually confirm): ${run.gate_last.triage}`]
			: []),
		...(run.rejection_history.length > 0
			? [
					`Rejections so far (do not repeat): ${JSON.stringify(
						run.rejection_history.slice(-5).map((r) => ({ round: r.round, kind: r.kind, task: r.task_id, reason: r.reason })),
					)}`,
				]
			: []),
		`Working tree: ${await diffStat(run.repo)}`,
	];
	return { stable, volatile };
}

/** Condensed handover as one message: what /orchestrate handover sends and a resume opens with. */
export async function handoverText(run: RunState): Promise<string> {
	const h = await handover(run);
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
	/** The plan's own complexity tier, declared at `planning_done`; it sets the run's cap. */
	complexity?: Complexity;
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
	/** Every bounced phase/payload, newest last; the repair briefing feeds the last five. */
	rejection_history: Rejection[];
	/** Count of schema-refused fade_phase payloads; at 2+ the tool returns SCHEMA_HINT. */
	schema_retries: number;
	/** Last pre-swap gate run on the code lane; the gate briefing replays the tails. */
	gate_last?: GateResult;
	/** v2: plan-size tier from planning_done (S ≤2 tasks, M ≤4, L more). */
	tier?: "S" | "M" | "L";
	/** The verification batch the desk claimed for THIS round, and how it is being answered. Set by
	 *  the desk dispatch (index.ts) and cleared when the verdicts land: it is what makes the
	 *  verifier's `verdicts[]` legal, and what stops one batch being answered twice. */
	verify_batch?: { batch: number; ids: string[]; routed: "swap" | "subagent"; at: string };
	/** Cumulative turns that ended with NO fade_phase call; the round budget never moves. */
	protocol_retries?: number;
	/** Consecutive phase-less turns; 1 nudge, 2 synthesize, 3 stall. Reset by any accepted phase. */
	stall_count?: number;
	/** The loop is halted (circuit breaker) or operator-paused; nothing more is sent. */
	paused?: boolean;
	/** The operator's note, recorded by [s]/[p] and replayed in the handover. */
	operator_note?: string;
	/** A coding_done the machine synthesized from git + gate exit codes, not from the lane. */
	synthesized?: { phase: string; round: number; at: string };
	/** Task id -> the checkpoint tag naming the HEAD that task passed against. */
	checkpoints?: Record<string, string>;
	/** The last claim-time probe of the verifier lane: what it asked and what answered. Recorded
	 *  every time the zero-swap route is taken or refused; the panel and `verifier` print it. */
	lane_probe?: { ok: boolean; detail: string; at: string; ms: number; skipped?: boolean };
	/** The last IN-PROCESS lane call (thinklane.ts): the model and endpoint it named, how it ended,
	 *  the class of a refusal, the elapsed ms and the answer's size. Recorded by the verb so
	 *  `/orchestrate status` answers "did that thinking call cost a swap?" with a fact: an in-process
	 *  call NEVER swaps, so its cost is the elapsed line alone. */
	lane_call?: { ok: boolean; cls: string; model: string; endpoint: string; ms: number; at: string; chars: number; detail: string };
	/** The supervisor lane lease this run holds — the single authority over
	 *  :18014. `lease_state` is `held` (this run may swap under its token),
	 *  `deferred` (a peer session holds the lease: this run shares the resident
	 *  coder and never swaps), `released`, or `refused`. `lease_token` is a write
	 *  capability and is NEVER rendered; the surfaces show holder / granted_ttl_s
	 *  / hint only (the daemon masks its side the same way). */
	lease_state?: "held" | "deferred" | "released" | "refused";
	lease_token?: string;
	lease_holder?: string;
	lease_granted_ttl_s?: number;
	lease_hint?: string;
	/** The lane move a refused lease mint DEFERRED. A 409 naming a holder is not a run
	 *  failure: the pin stays on the pack the lane SERVES (so the next completion is held
	 *  by `laneServeHold`, never 404'd), the page the switch owed is QUEUED in
	 *  `deferred_briefing`, and the retry rides the holder's own `remaining_s`. The next
	 *  successful switch to `deferred_lane` sends the queued page and clears the pair.
	 *  Design and the measured refusal: docs/lease-lifecycle-409-20261127.md. */
	deferred_lane?: string;
	deferred_briefing?: "verify" | "verifyBatch" | "code" | "repair" | "gate" | "plan";
	deferred_since_utc?: string;
	/** When the deferral re-asks, as the client decided it from the daemon's countdown.
	 *  Rendered; the countdown is the daemon's, this is the appointment. */
	lease_retry_at_utc?: string;
	/** How the current briefing stands, in the operator's words: `sent` (a page went
	 *  out), `queued` (owed by a deferred lane move), `quiet` (a hand-back that ships no
	 *  page by design), `not-sent` (the switch failed outright, no queue). A hand-back
	 *  that ships no page never prints "briefing not sent" without naming the review
	 *  state and the queue beside it — the message that read as a failure was the
	 *  operator's only signal, and it named neither. */
	briefing_delivery?: "sent" | "queued" | "quiet" | "not-sent";
	briefing_sent_at_utc?: string;
	/** The review state as the last lane act read it (round, phase, desk verdicts).
	 *  Rendered beside the briefing state; absent prints as `unknown`, never a guess. */
	review_state?: string;
}

/** A lane move the daemon refused because the lane is CLAIMED, as the client recorded it. */
export interface LaneDeferral {
	lane: string;
	/** The page the landing owes, in the plugin's words. Stored as a KIND, never as text: the
	 *  page is built from the run state when the lane frees, and a page built at the refusal is
	 *  a snapshot of a round that moved on while the lane was busy. */
	kind: "verify" | "verifyBatch" | "code" | "repair" | "gate" | "plan";
	rule?: string;
	holder?: string;
	remaining_s?: number;
	token_hint?: string;
	/** The appointment, in ms from `at`, decided from the daemon's own countdown. */
	retry_delay_ms: number;
	/** A quiet landing (a hand-back) owes no page, so the queue records `quiet`, never `queued`. */
	quiet?: boolean;
}

/**
 * Record that a lane move is DEFERRED, in the state the row, the panel and the next session read.
 *
 * A 409 over a HELD lane is not a run failure, and this function is where that is enforced:
 * `state`, `round`, `stall_count` and the protocol counters are untouched — the run's plan
 * survives a pack that has not arrived. What lands is the owed lane, the page it owes, the holder
 * named by the daemon, and the appointment to re-ask. The record is durable on purpose: a session
 * that closes with the queue open re-asks at the next boundary, and the completion of the pack
 * that SERVES is held by `laneServeHold`, so an unanswered queue never becomes a 404.
 */
export function applyLaneDeferral(st: RunState, d: LaneDeferral, at: string = new Date().toISOString()): void {
	st.deferred_lane = d.lane;
	st.deferred_briefing = d.kind;
	st.deferred_since_utc = at;
	st.briefing_delivery = d.quiet ? "quiet" : "queued";
	st.lease_state = "deferred";
	st.lease_holder = d.holder;
	if (d.token_hint) st.lease_hint = d.token_hint;
	st.lease_retry_at_utc = new Date(Date.parse(at) + d.retry_delay_ms).toISOString();
	st.review_state = reviewStateLabel(st);
}

/** The lane move landed: record what the briefing did and clear the deferral it answers. A quiet
 *  landing answers the queue too — a lane that landed quietly is not owed, and a row that names it
 *  as owed is a lie about the plane. */
export function clearLaneDeferral(st: RunState, lane: string, delivery: "sent" | "quiet", at: string = new Date().toISOString()): void {
	st.briefing_delivery = delivery;
	if (delivery === "sent") st.briefing_sent_at_utc = at;
	if (st.deferred_lane === lane) {
		st.deferred_lane = undefined;
		st.deferred_briefing = undefined;
		st.deferred_since_utc = undefined;
		st.lease_retry_at_utc = undefined;
	}
}

/**
 * The run's review state in the operator's words — the single rule the row, the deferral line and
 * the suite read. Frontier prints its own `settled unreviewed` warning on the frontier surface;
 * this is the orchestrate side of the same fact, printed beside the briefing state so a hand-back
 * that ships no page is never mistaken for a lost round. Never a guess: an unmapped state prints
 * as what it is, with its round.
 */
export function reviewStateLabel(st: RunState): string {
	if (st.state === "complete") return `accepted (round ${st.round})`;
	if (st.state === "verifying") return `verdicts open (round ${st.round}${st.verify_batch ? `, batch ${st.verify_batch.batch + 1}` : ""})`;
	if (st.state === "repair") return `repair owed (round ${st.round})`;
	if (st.state === "failed") return `FAILED: ${st.reason ?? "no reason recorded"}`;
	return `${st.state} (round ${st.round})`;
}

/**
 * What the batch briefing prints: the desk's claimed batch, as plain data. `VerifyRequest`
 * satisfies it structurally, so core.ts needs no runtime import of desk.ts (the desk reads the
 * run state, not the other way round).
 */
export interface VerifyBatchBriefing {
	batch: number;
	ids: string[];
	routed: "swap" | "subagent";
	requests: Array<{ id: string; agent: string; task_id?: string; objective: string; acceptance?: string; checks: [string, string][] }>;
}

/** Parse a state/ledger record: anything unparsable is `undefined`, never a throw, never a zero. */
export function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

/**
 * The async read of the same file. `state.json` is read on EVERY tool call (the verifier
 * sandbox) and the swap ledger on every panel tick, where `readFileSync` is a stall of the
 * host's paint loop the operator can see.
 */
export async function readJsonAsync<T>(path: string): Promise<T | undefined> {
	try {
		return parseJson<T>(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Durable write: temp + fdatasync + rename + directory sync — the SAME ordering as `writeJson`,
 * with only the BLOCKING removed: every step is `fs.promises`, so the host paints and takes
 * keystrokes while the record travels to the disk. `handle.sync()` is `fdatasync`: the record's
 * bytes and its length are on the platter before the rename publishes them. Directory sync is
 * best-effort (platforms that refuse an `r` fd on a directory must not fail the phase).
 */
export async function writeJsonAsync(path: string, value: unknown): Promise<void> {
	const dir = join(path, "..");
	await mkdir(dir, { recursive: true });
	// A temp name PRIVATE to this call, not a shared `${path}.tmp`: two writers of one file
	// interleave the moment writes are async (the metrics tick and a panel refresh both publish
	// `metrics_state.json`), and the loser's `rename` then reports ENOENT for a source the other
	// already published. Atomicity is the rename; the name only has to be private.
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	const h = await open(tmp, "w");
	try {
		await h.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await h.sync();
	} finally {
		await h.close();
	}
	try {
		await rename(tmp, path);
	} catch (e) {
		await unlink(tmp).catch(() => {});
		throw e;
	}
	try {
		const d = await open(dir, "r");
		try {
			await d.sync();
		} finally {
			await d.close();
		}
	} catch {
		/* the rename is already atomic; the directory flush is the durability we can add, not the record */
	}
}

/** One path's coalescing slot: the chain of writes in flight, and the payload that replaces them. */
const coalesced = new Map<string, { tail: Promise<void>; settled: Promise<void>; pending: { value: unknown } | undefined }>();

/**
 * A durable write that COALESCES per path: ONE write in flight, and a newer payload REPLACES the
 * pending one. A phase boundary persists three times (the phase, the rejection, the lane) and
 * with this pays ONE write — the LAST payload. The ordering inside each write is
 * `writeJsonAsync`'s, so a `kill -9` still leaves a whole record, never a half one. Two rapid
 * calls share the slot's promise: that identity is what "one write" means, and what the test
 * reads.
 */
export function coalesceWrite(path: string, value: unknown): Promise<void> {
	const slot: { tail: Promise<void>; settled: Promise<void>; pending: { value: unknown } | undefined } = coalesced.get(path) ?? {
		tail: Promise.resolve(),
		settled: Promise.resolve(),
		pending: undefined,
	};
	coalesced.set(path, slot);
	const queued = slot.pending !== undefined;
	slot.pending = { value };
	if (queued) return slot.settled;
	const drain = async (): Promise<void> => {
		while (slot.pending) {
			const v = slot.pending.value;
			slot.pending = undefined;
			await writeJsonAsync(path, v);
		}
		if (coalesced.get(path) === slot) coalesced.delete(path);
	};
	// The chain a later call joins must never carry an EARLIER write's failure. The state directory
	// is the operator's: a janitor, a `reset` or a rig can remove it mid-run, and the write that
	// lands after the wipe used to poison every later phase and reach the host's loop as an
	// unhandled rejection. The caller that awaited THIS write still sees the error; the chain moves on.
	const run = slot.tail.then(drain);
	slot.tail = run.catch(() => undefined);
	slot.settled = run;
	return slot.settled;
}

/**
 * Durable write: temp + fsync + rename + fsync of the parent directory. A `kill -9` in the
 * middle of a multi-hour run leaves `state.json` parsing as the PREVIOUS phase — a reader never
 * sees a half-written record, and the rename itself survives the crash because the directory
 * entry is flushed after it. Directory fsync is best-effort (platforms that refuse an `r` fd on
 * a directory must not fail the phase).
 *
 * The SYNC form is the last resort, kept for the ONE site that must be durable before it
 * returns: `/orchestrate stop`, after which the operator may close the session in the same
 * keystroke. Every hot path uses `writeJsonAsync`/`coalesceWrite`.
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

/**
 * The router is single-tenant: one resident lane, one live-turn ledger, one flip guard. Two
 * orchestrators driving it from two omp sessions — even two checkouts of two repos on one host —
 * interleave their turns and each one's gate ends up judging the other's tree. So the lock is
 * taken on the ROUTER, not the repo, and it is taken exactly once per run.
 *
 * `O_CREAT|O_EXCL` (`"wx"`) is the whole mutual exclusion: the filesystem picks one winner, so
 * there is nothing to race with and no read-then-write window. What is left is decay: a machine
 * that rebooted, a `kill -9`, a power cut. The lock's own pid answers that — `kill(pid, 0)` says
 * `ESRCH` for a corpse and `EPERM` for a process that exists and is not ours. A pid we cannot
 * believe (no pid, no finite pid, unparsable file) is treated as a corpse, because the file that
 * cannot name its owner can never release it. Reclaim is a single retry: two runs racing for a
 * freed lock produce one winner and one honest `{ok:false, stale:true}`, never a spin.
 */
export const LOCK_FILENAME = "orchestrator.lock";

export interface InstanceLock {
	pid: number;
	run_id: string;
	repo: string;
	started: string;
	host: string;
}

/** Reads the claim, or `undefined` for absent / empty / unparsable / non-object content. */
export function readInstanceLock(dir: string): InstanceLock | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(dir, LOCK_FILENAME), "utf8"));
		return raw && typeof raw === "object" ? (raw as InstanceLock) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Is the claimed pid alive? Our OWN pid counts as alive: a second run in the same process is
 * refused rather than deadlocked, which is the same fact the router needs — it has one lane.
 */
function holderAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// ESRCH is the only "this pid is gone" answer; EPERM and friends say the pid exists.
		return (e as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * Exclusive acquire. Creates `dir` when missing. The claim is fsynced before the fd closes, so a
 * `kill -9` right after the acquire still leaves a lock naming this run.
 */
export function acquireInstanceLock(dir: string, info: { run_id: string; repo: string }): { ok: true } | { ok: false; holder: InstanceLock; stale: boolean } {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, LOCK_FILENAME);
	const claim = () => {
		const lock: InstanceLock = { pid: process.pid, run_id: info.run_id, repo: info.repo, started: new Date().toISOString(), host: hostname() };
		const fd = openSync(path, "wx");
		try {
			writeFileSync(fd, `${JSON.stringify(lock)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	};
	const taken = (): boolean => {
		try {
			claim();
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw e;
		}
	};
	if (taken()) return { ok: true };
	const holder = readInstanceLock(dir);
	if (holderAlive(holder?.pid)) return { ok: false, holder: holder as InstanceLock, stale: false };
	rmSync(path, { force: true });
	if (taken()) return { ok: true };
	// The corpse was buried by a rival in the same instant: it owns the router, and the
	// file we cannot read is still a claim we must not break.
	const rival = readInstanceLock(dir) ?? holder ?? { pid: 0, run_id: "unknown", repo: info.repo, started: new Date().toISOString(), host: hostname() };
	return { ok: false, holder: rival, stale: true };
}

/**
 * Release, by owner only: an instance that lost the race (or resumed under a new pid) must never
 * delete the lock the live run is holding. A missing file is not an error; neither is a file that
 * has no readable owner, since nothing can be deleted safely from it.
 */
export function releaseInstanceLock(dir: string, pid: number = process.pid): void {
	const holder = readInstanceLock(dir);
	if (!holder || holder.pid !== pid) return;
	try {
		unlinkSync(join(dir, LOCK_FILENAME));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
}

/**
 * Where the router claim lives: per ROUTER, not per repo. The router is single-tenant (one resident
 * lane, one live-turn ledger, one flip guard), so two sessions driving it from two checkouts of two
 * repos must meet at one file. `FADE_ORCHESTRATE_LOCK_DIR` moves the whole plane (rigs, containers,
 * a second router on one box).
 */
export function instanceLockDir(router: string = process.env.FADE_ORCHESTRATE_ROUTER ?? "http://127.0.0.1:18014"): string {
	if (process.env.FADE_ORCHESTRATE_LOCK_DIR) return process.env.FADE_ORCHESTRATE_LOCK_DIR;
	const slug = router.replace(/^[a-z]+:\/\//i, "").replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "") || "router";
	return join(homedir(), ".local", "state", "fade-orchestrator", slug);
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
		if (t.complexity !== undefined && !isComplexity(t.complexity)) return { error: `${id}: complexity must be trivial|standard|deep (got ${JSON.stringify(t.complexity)})` };
		const deps = t.dependencies ?? [];
		if (!Array.isArray(deps)) return { error: `${id}: dependencies must be an array` };
		for (const d of deps) {
			if (typeof d !== "string" || !seen.has(d)) return { error: `${id}: dependency ${JSON.stringify(d)} must name an earlier task` };
		}
		tasks.push({ id, objective: String(t.objective), files: t.files as string[], acceptance: String(t.acceptance), dependencies: deps as string[], round: 0, ...(isComplexity(t.complexity) ? { complexity: t.complexity } : {}) });
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
		// produce, and a plan carrying one livelocks the coder — repeated refusals, zero lane
		// loads, because the gate cannot tell a broken string from a failure.
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
 * The tasks ONE coder window takes. The unit of cost is the lane swap — 15-20 s and 52-130 GiB,
 * paid once per turn at `agent_end` — so a round costs the NUMBER OF WINDOWS, not the number of
 * tasks: a 3-task plan reported one task per turn pays six transitions where two do the job.
 *
 * 4 is set against the bounds the loop publishes:
 *  - planning caps a tier-M plan at 4 tasks, so a whole M plan is ONE window: a 3-task round
 *    is code + verify — exactly 2 swaps, by construction;
 *  - `adaptiveRounds` budgets the plan at 2 tasks per round (2 + ceil(n/2)), so 4 is DOUBLE the
 *    rate the round budget assumes: the plan the planner sizes for two coding rounds lands in
 *    one window and leaves the reserved rounds for repairs;
 *  - the plan ceiling is `MAX_TASKS`, so 4 keeps every task card UNTRUNCATED (objective, files,
 *    acceptance, dependencies) inside one coder context along with its own test runs, and bounds
 *    a bounced window to at most half a maximal plan — a repair round is never "redo the whole
 *    plan".
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
 * The window the coder takes in THIS turn. `open` is every unpassed task in the pool; `readyNow`
 * is the open tasks whose every dependency is resolved (passed, including a forced skip), in
 * plan order, capped at `MAX_WINDOW_TASKS`; `blocked` names each open task with an unmet
 * dependency and those ids. A ready task cut by the cap is in neither list — it is the NEXT
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
 * Validate a whole `coding_done` — SEVERAL tasks at once, all of them marked by `applyDone`.
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

/**
 * The run root's git state, said out loud where it changes what the loop can prove. Measured
 * a run rooted in a directory that is NOT a git repo: the T2 phase
 * synthesizer reads `git status --porcelain`, so EVERY task landed `blocked` with the sentinel
 * tail, and the operator met a wall of six red rows two rounds after a clean-looking start. The
 * cause is knowable at the first keystroke, so the first keystroke says it.
 */
export const gitCaveat = async (repo: string): Promise<string> =>
	(await isGitRepo(repo))
		? ""
		: ["The run root " + repo + " is NOT a git repo: git status/git diff evidence does not exist here, so the phase synthesizer names every task blocked and the checkpoint tags are unavailable.",
		  "The act is `git init " + repo + "` (or start the run inside a working tree)."].join(" ");

// ---- the briefing renderer ---------------------------------------------------------------

// A lane reads a briefing once per turn and answers it, so the shape decides whether the contract
// is obeyed. The old shape was a wall of single-newline lines with payload dumps mid-sentence:
// skimmable, and the lanes skim — a payload skeleton lost inside prose is a shape the lane invents.
// These helpers render every briefing the same way: a title line, `## ` sections, task cards as
// bullets with sub-bullets, and the payload/check skeletons FENCED so their braces read as shape.
// The anchors the suite pins are kept verbatim on purpose: they are the contract, not its layout.

/** `## title` over its body; a section with no data renders nothing, so no header sits over emptiness. */
function section(title: string, ...body: unknown[]): string {
	const lines = body.filter((v) => v !== "" && v !== undefined && v !== null && v !== false) as string[];
	return lines.length === 0 ? "" : [`## ${title}`, ...lines].join("\n");
}

/** The page: sections a blank line apart — the paragraph break a single `\n` cannot draw. */
function page(...parts: unknown[]): string {
	return parts.filter((v) => v !== "" && v !== undefined && v !== null && v !== false).join("\n\n");
}

/** A fenced block: the skeleton a lane must emit, set off from the prose that describes it. */
function fence(body: string): string {
	return "```\n" + body + "\n```";
}

/** One task as a card: id and objective on the bullet, every field a sub-bullet, UNTRUNCATED. */
function card(t: Task, extra: string[] = []): string {
	return [
		`- **${t.id}**${t.status ? ` [${t.status}]` : ""} — ${t.objective}`,
		`  - files: ${t.files.length > 0 ? t.files.join(", ") : "-"}`,
		`  - acceptance: ${t.acceptance}`,
		`  - dependencies: ${t.dependencies.length > 0 ? t.dependencies.join(", ") : "none"}`,
		...extra,
	].join("\n");
}

export const briefings = {
	plan: async (run: RunState): Promise<string> =>
		page(
			`Phase 0 (planning), round ${run.round} of orchestrated run ${run.run_id}.`,
			section("Goal", run.goal),
			section(
				"Output — a plan is ONE object",
				`At most ${MAX_TASKS} tasks, and the checks that prove the goal:`,
				fence('{"tasks":[{"id":"T1","objective":"...","files":["repo/relative/path"],"acceptance":"one command and what it proves","dependencies":[]}],"checks":[["cmd","the observation that counts as green"]]}'),
				"Every task carries an id, an objective, repo-relative files, an acceptance that is ONE command plus what it proves, and its dependencies.",
			),
			section(
				"Checks are DATA the pre-swap gate runs through bash",
				fence(JSON.stringify(run.checks.length ? run.checks : [["<the command that proves the goal>", "<the observation that counts as green>"]])),
				"Each row is ONE command bash can parse. A row with a <placeholder>, an ellipsis or prose is a PLAN DEFECT: bash refuses it, it is never executed, and the gate stays red no matter what the tree does — so name commands this repo actually has, with real flags.",
			),
			section("Rules", "- Give dependent tasks earlier ids first.", "- Files are repo-relative and disjoint.", "- Plan only: no edits, no writes."),
			await gitCaveat(run.repo),
			section("Call", 'fade_phase phase="planning_done", payload=<that JSON as a string>.'),
		),
	code: async (run: RunState): Promise<string> =>
		page(
			`Phase 1 (coding), round ${run.round} of orchestrated run ${run.run_id}.`,
			section("Goal", run.goal),
			section("Tasks", ...run.tasks.map((t) => card(t))),
			section("Contract", `Implement exactly these tasks in ${run.repo}. After each task run its acceptance command and record what it observed. Do not commit.`),
			await gitCaveat(run.repo),
			section("Call", 'fade_phase phase="coding_done", payload:', fence('{"done":[{"id":"T1","status":"passed|failed|blocked","result":"what the acceptance command observed"}]}')),
		),
	/**
	 * The coder's BATCH briefing — one window, one turn, one `coding_done`. Every task of
	 * `roundWindow().readyNow` is spelled out UNTRUNCATED (objective, files, acceptance,
	 * dependencies) because a card the lane cannot read in full is a card it implements from
	 * imagination; the blocked tasks are listed with the ids that hold them so the lane knows
	 * what to leave alone; and the one-payload contract is stated in the turn's own words, which
	 * is the half that kills the per-task window (the refusal in `validateDone` is the other
	 * half). The fenced payload IS the window: the ids it names are the ids that may be reported.
	 */
	window: async (run: RunState): Promise<string> => {
		const { readyNow, blocked, open } = roundWindow(run);
		const inWindow = new Set(readyNow.map((t) => t.id));
		const blockedIds = new Set(blocked.map((b) => b.id));
		const deferred = open.filter((t) => !inWindow.has(t.id) && !blockedIds.has(t.id)).map((t) => t.id);
		// A re-briefed window (round > 1) carries the critique PER TASK, so the lane knows
		// which rejection belongs to the file it is about to edit.
		const critiques = run.round > 1 ? critiquesFor(run, readyNow.map((t) => t.id)) : [];
		const entry = (id: string) => `{"id":"${id}","status":"passed|failed|blocked","result":"what the acceptance command observed"}`;
		return page(
			`Phase 1 (coding) — ONE WINDOW, round ${run.round}/${run.max_rounds} · T${readyNow.length}/${open.length} · lane ${run.lane} · orchestrated run ${run.run_id}.`,
			section("Goal", run.goal),
			section(
				"Window contract",
				readyNow.length > 0
					? `This ONE turn implements EVERY task below in ${run.repo} and reports them ALL in ONE coding_done payload:`
					: "The window is EMPTY: every open task is blocked by an unpassed dependency. There is nothing to implement in this turn — do not send a coding_done naming a blocked task; report the blockers and end the turn.",
				readyNow.length > 0 ? fence(`{"done":[${readyNow.map((t) => entry(t.id)).join(",")}]}`) : "",
				readyNow.length > 0 ? "Do not report after one task and do not take a second coding turn for these tasks — one window, one coding_done, one lane swap." : "",
			),
			section(`Tasks in this window (${readyNow.length} of ${open.length} open)`, readyNow.length > 0 ? "each card in full:" : "none.", ...readyNow.map((t) => card(t))),
			section(
				"Not in this window",
				blocked.length > 0 ? "Unmet dependencies — do not start them and never name one in coding_done:" : "",
				...blocked.map((b) => `- ${b.id} blocked by ${b.blockedBy.join(", ")}`),
			),
			deferred.length > 0
				? section("Deferred", `Ready but past the ${MAX_WINDOW_TASKS}-task window cap (the NEXT window's work, leave it alone now): ${deferred.join(", ")}.`)
				: "",
			critiques.length > 0
				? section("Rejected before — the verifier's critique", "for the tasks of THIS window, by task id; a task rejected twice has already had this diff tried, so change the cause:", ...critiques)
				: "",
			section(
				"Context",
				'this prompt carries the goal, the phase contract, the task definitions, the diff stat, the gate and the last rejections — nothing else. Re-reading a file you read this round, and pasting tool logs into "result", are what break the stable prefix the conversation cache reuses.',
				'Run each task\'s acceptance command and put what it printed in that task\'s "result". Do not commit.',
			),
			section(
				"Delegated verification",
				`A slice handed to a \`task\` worker can verify ITSELF: launch it as agent "${WORKER_AGENT}", whose definition carries the \`fade_verify\` tool. Its request joins the desk, the batch closes when every worker the round launched has registered, and ONE verification pass answers the whole batch by id.`,
				`A worker launched on an agent whose tools do NOT carry \`fade_verify\` (a read-only reviewer, for example) runs its checks and cannot register; the census counted it, so the batch closes on the settle window instead of on its request — install the definition with \`/orchestrate verifier install\`.`,
			),
			await gitCaveat(run.repo),
		);
	},
	verify: (run: RunState): string =>
		page(
			`Phase 2 (verification), round ${run.round} of orchestrated run ${run.run_id}.`,
			section("Goal", run.goal),
			section("Task results", ...run.tasks.map((t) => card(t, [`  - result: ${t.result ?? "unreported"}`]))),
			section(
				"Checks to re-run",
				`Read the diff (run "git diff" in ${run.repo} yourself) and re-run every check:`,
				fence(JSON.stringify(run.checks)),
				'Verdict rule: "accepted" needs EVERY check re-run BY YOU in this turn, each row reported as ["cmd","observed"] with what THAT run printed. The pre-swap gate already ran them green on the coding lane and its row is in the state file; a row copied from the gate\'s result is not a re-run, and a check you did not run cannot be accepted.',
			),
			section(
				"needs_repair",
				`"needs_repair" ends the round and must name the tasks for round ${run.round + 1} as full cards:`,
				fence('{"id":"R1","objective":"the CAUSE, not the same attempt","files":["repo/relative/path"],"acceptance":"one command and what it proves","dependencies":[]}'),
				"A task rejected twice has had this exact diff tried: name the cause the next round can act on.",
			),
		),
	/**
	 * The BATCH verification briefing: one lane load, every worker's request in it, judged once.
	 *
	 * The window is the point of the page. The lane is told the ids are the whole universe of this
	 * pass — a verifier that wanders onto a slice another worker is still holding starts a second
	 * pass over the same tree, which is the churn the desk batches away — and that its verdicts land
	 * on the desk BY ID (`fade_verdicts`), because that is the only path that unblocks a worker
	 * parked in `fade_verify`. The round's own verdict is the aggregate of the batch.
	 */
	verifyBatch: (run: RunState, batch: VerifyBatchBriefing): string =>
		page(
			`Phase 2 (verification) — ONE BATCH, batch ${batch.batch + 1} of orchestrated run ${run.run_id}, round ${run.round}/${run.max_rounds}, routed ${batch.routed}.`,
			section("Goal", run.goal),
			section(
				"Batch contract",
				`${batch.ids.length} delegated worker request${batch.ids.length === 1 ? "" : "s"} landed on the verification desk while the code lane worked. This ONE turn judges ALL of them and posts ALL of the verdicts. Do not verify anything outside these ids, and do not take a second verification turn for them — one batch, one pass, one lane swap.`,
			),
			section(
				`Requests (${batch.ids.length})`,
				...batch.requests.map((r) =>
					[
						`- ${r.id} — worker \`${r.agent}\`${r.task_id ? ` (task ${r.task_id})` : ""}: ${r.objective}`,
						r.acceptance ? `    acceptance: ${r.acceptance}` : "",
						r.checks.length > 0 ? `    run yourself:\n${r.checks.map(([cmd, expected]) => `      - \`${cmd}\` (expected ${expected})`).join("\n")}` : "    no commands named: judge from the diff and the named acceptance.",
					]
						.filter(Boolean)
						.join("\n"),
				),
			),
			section(
				"Post the verdicts BY ID",
				`Call the \`fade_verdicts\` tool ONCE with \`batch: ${batch.batch + 1}\` (the batch number in this page's heading) and one row per id. That write is what unblocks each worker parked in \`fade_verify\`; a verdict in prose alone leaves every worker waiting.`,
				fence(`{"batch":${batch.batch + 1},"verdicts":[{"id":"${batch.ids[0] ?? "V1.1"}","accepted":true,"notes":"the command you ran and what it printed, or the cause to fix"}]}`),
			),
			section(
				"Then the round's verdict",
				`Call fade_phase phase="verification_done" with the AGGREGATE: "accepted" only when EVERY id above passed on checks YOU re-ran this turn; "needs_repair" naming the repair tasks the batch implies. Pass the per-id rows in \`verdicts\` too, so the desk record and the round record cannot diverge.`,
				fence('{"verdict":"accepted|needs_repair","checks":[["cmd","observed"]],"notes":"the batch verdict","tasks":[],"verdicts":[{"id":"V1.1","accepted":true,"notes":"…"}]}'),
			),
			section(
				"Verdict rule",
				`"accepted" needs every command above re-run BY YOU in this turn, in ${run.repo}, with what THAT run printed. A check you did not run cannot be accepted, and a request you did not judge is a defect, not a pass.`,
			),
		),
	repair: async (run: RunState): Promise<string> => {
		const prior = (run.rejection_history ?? []).slice(-5).map((r) => `- round ${r.round} [${r.kind}]${r.task_id ? ` ${r.task_id}:` : ""} ${r.reason}`);
		const ids = (run.repair_tasks ?? []).map((t) => t.id);
		const critiques = critiquesFor(run, ids);
		const checklist = (run.repair_tasks ?? []).map((t) => `${t.id}: ${t.acceptance}`);
		return page(
			`Phase 1 (repair), round ${run.round} of orchestrated run ${run.run_id}.`,
			section("Goal", run.goal),
			section("Repair tasks", ...(run.repair_tasks ?? []).map((t) => card(t))),
			// The critique the task itself earned, with its count — the anti-oscillation line.
			critiques.length > 0 ? section("Rejected before — the verifier's words, BY TASK:", ...critiques) : "",
			prior.length > 0 ? section("Previously rejected — fix the cause, do not repeat the attempt", ...prior) : "",
			// Compaction: the diff and the checklist answer "where am I"; no prior-round logs ride.
			section("Tree", `Working tree: ${await diffStat(run.repo)}`, checklist.length > 0 ? `Checklist: ${checklist.join(" | ")}` : ""),
			section(
				"Context",
				"this prompt carries the task definitions, the diff stat, the checklist and the last rejections — no prior-round tool logs. Re-running the acceptance command is the only re-read this round needs.",
				`Implement the repairs in ${run.repo}, run each acceptance command, do not commit.`,
			),
			await gitCaveat(run.repo),
			section("Call", 'fade_phase phase="coding_done", payload:', fence('{"done":[{"id":"T1","status":"passed|failed|blocked","result":"what the acceptance command observed"}]}')),
		);
	},
	gate: (run: RunState): string => {
		const results = run.gate_last?.results ?? [];
		const invalid = results.filter((r) => r.invalid);
		const failing = results.filter((r) => !r.ok && !r.invalid);
		return page(
			`Pre-swap gate RED, round ${run.round} of orchestrated run ${run.run_id} — the verifier lane was NOT loaded; the swap is only paid for a green tree.`,
			section("Plan defects (never executed)", ...invalid.map((f) => [`- INVALID CHECK (not a command, never executed): ${f.cmd}`, `  - expected: ${f.expected}`, `  - observed: ${f.tail}`].join("\n"))),
			section("Checks that ran and failed", ...failing.map((f) => [`- FAIL: ${f.cmd}`, `  - expected: ${f.expected}`, `  - observed tail: ${f.tail}`].join("\n"))),
			invalid.length > 0
				? section(
						"The exit is a plan act",
						`${invalid.length} of the plan's checks are PLAN DEFECTS: bash refuses to parse them, so no state of ${run.repo} can make them green and no amount of coding will pay the swap. Fixing the tree is not the remedy — the exit is a plan act: call fade_phase phase="planning_done" with the rows re-declared as runnable commands (the tool's own --ref / --root / absolute-binary forms, no <placeholders>), keeping every task.`,
					)
				: "",
			section("Fix", `Fix the causes in ${run.repo} (the checks are the plan's own), re-run them yourself until they pass, then call fade_phase phase="coding_done" again.`),
		);
	},
	final: (run: RunState): string => {
		const path = join(run.repo, "var", "omp-orchestrate", STATE_FILENAME);
		if (run.state === "complete") return `Orchestrated run ${run.run_id} completed: verdict accepted after round ${run.round}. State and phase log: ${path}. Resident lane ${run.lane}; nothing is preloaded.`;
		if (run.state === "failed") return `Orchestrated run ${run.run_id} failed at round ${run.round} in state ${run.state}: ${run.reason ?? "unreported"}. State file: ${path}.`;
		return `Orchestrated run ${run.run_id} stopped at round ${run.round}; resident lane left as ${run.lane}.`;
	},
	/**
	 * Tier 1 of the protocol ladder: the lane ended its turn without calling `fade_phase`. No
	 * round was spent and no swap happens — the same lane is re-briefed in VRAM with the ONE
	 * thing it owes, plus the published schema, and told exactly what the next miss costs.
	 */
	nudge: (run: RunState): string => {
		const phase = PHASE_FOR_STATE[run.state] ?? "coding_done";
		return page(
			`Protocol nudge ${run.stall_count ?? 1}/${STALL_SYNTHESIZE_AT} — orchestrated run ${run.run_id}, state ${run.state}, round ${run.round}/${run.max_rounds} (UNSPENT: the round budget does not move here), lane ${run.lane}.`,
			section("What is missing", "Your turn ended with NO fade_phase call. The loop cannot advance without it and will not swap lanes."),
			section("Call it now", `Call the fade_phase tool NOW: phase="${phase}", payload=<the JSON object serialized to a string>.`),
			SCHEMA_HINT,
			section("Answer", 'The work is done? Say so with the acceptance command and what it printed in "result". The work is NOT done? Finish it, then report.'),
			section("Cost of the next miss", "The next miss auto-synthesizes this round's coding_done from git and the gate exit codes; the one after halts the run as stalled_protocol_error."),
		);
	},
	/**
	 * Tier 3 of the protocol ladder: the circuit breaker tripped. The run is paused, the lane is
	 * left as it is, and this is the diagnostic an operator acts on: what the machine saw, what
	 * is RED, what git says, and the exact files to open.
	 */
	stalled: async (run: RunState): Promise<string> => {
		const path = join(run.repo, "var", "omp-orchestrate", STATE_FILENAME);
		const phases = (run.phases ?? []).slice(-3).map((p) => `${p.phase} round ${p.round} accepted=${p.accepted}${p.notes ? ` notes=${p.notes}` : ""}`);
		const failing = (run.gate_last?.results ?? []).filter((r) => !r.ok).map((r) => [`- RED: ${r.cmd}`, `  - expected: ${r.expected}`, `  - observed: ${r.tail}`].join("\n"));
		const rejections = (run.rejection_history ?? []).slice(-5).map((r) => `- round ${r.round} [${r.kind}]${r.task_id ? ` ${r.task_id}:` : ""} ${r.reason}`);
		return page(
			`Orchestrated run ${run.run_id} HALTED: stalled_protocol_error — ${run.protocol_retries ?? 0} turn(s) ended with no fade_phase call (state ${run.state}, round ${run.round}/${run.max_rounds}, lane ${run.lane}). The loop is paused; nothing further is sent to any lane and no lane was swapped.`,
			section("Phases the machine saw", phases.length > 0 ? phases.join("\n") : "No phase was ever accepted by this run."),
			section("Synthesis", run.synthesized ? `Synthesized coding_done at round ${run.synthesized.round} (${run.synthesized.at}): ${JSON.stringify(run.synthesized)}` : "Nothing was synthesized."),
			section("Deterministic gate", gateSummary(run)),
			failing.length > 0 ? section("Checks that are RED", ...failing) : "",
			rejections.length > 0 ? section("Recent rejections", ...rejections) : "",
			section("Tree", `Working tree: ${await diffStat(run.repo)}`, run.operator_note ? `Operator note: ${run.operator_note}` : ""),
			section("Act on it", `read ${path}, run the plan's own checks in ${run.repo}, then /orchestrate pause to unpause in place, /orchestrate code to resume on the code lane, or /orchestrate stop to end the run.`),
		);
	},
};

