/**
 * core v2 unit tests: adaptive round budget, v1→v2 migration, rejection history (append + cap),
 * the repair briefing carrying prior rejections, the pre-swap gate judging on exit code, and
 * the gate briefing naming the failing commands.
 * The Tier-1 protocol gate: the nudge→synthesize→stall ladder costing no round, the
 * git-synthesized coding_done, the crash-safe state write, the checkpoint tags, and the
 * nudge/stalled briefings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	adaptiveRounds,
	applyDone,
	briefings,
	checkParses,
	checkpointName,
	classifyTurnEnd,
	countRejections,
	critiquesFor,
	diffStat,
	expectation,
	gateSummary,
	gitCaveat,
	handover,
	handoverText,
	isGitRepo,
	MAX_WINDOW_TASKS,
	normalizeRun,
	porcelain,
	porcelainEntries,
	pushRejection,
	readJson,
	refreshChecks,
	refreshRoot,
	roundWindow,
	roundsForTasks,
	runGate,
	sameTaskPlan,
	synthesizeCodingDone,
	tagCheckpoint,
	validateChecks,
	validateDone,
	validateTasks,
	writeJson,
} from "../.test-build/core.mjs";
import { gateRows } from "../.test-build/screendata.mjs";
import { commitAll, initRepo } from "./fixture.mjs";

const mkRun = (over = {}) =>
	normalizeRun({
		key: "k",
		run_id: "R",
		goal: "g",
		repo: "/repo",
		max_rounds: 6,
		round: 2,
		state: "repair",
		lane: "flash-next",
		checks: [],
		tasks: [],
		phases: [],
		repair_tasks: [{ id: "T1", objective: "fix it", files: ["a.ts"], acceptance: "make", dependencies: [] }],
		started_utc: "x",
		...over,
	});

test("adaptiveRounds: 2-task plan reserves 3, 4-task 4, 6-task 5; never above the budget, never below 3", () => {
	assert.equal(adaptiveRounds(2, 6), 3);
	assert.equal(adaptiveRounds(4, 6), 4);
	assert.equal(adaptiveRounds(6, 6), 5);
	assert.equal(adaptiveRounds(1, 6), 3, "floor 3");
	assert.equal(adaptiveRounds(6, 3), 3, "cap at the requested budget");
});

test("normalizeRun fills v2 defaults on a v1 state file", () => {
	const v1 = { tasks: [], phases: [], repair_tasks: [] };
	const st = normalizeRun(v1);
	assert.deepEqual(st.rejection_history, []);
	assert.equal(st.schema_retries, 0);
});

test("pushRejection appends newest-last and caps at 50", () => {
	const run = mkRun();
	for (let i = 0; i < 60; i++) pushRejection(run, "schema", `refusal ${i}`);
	assert.equal(run.rejection_history.length, 50);
	assert.equal(run.rejection_history[49].reason, "refusal 59");
	assert.equal(run.rejection_history[0].reason, "refusal 10", "oldest dropped");
});

test("the repair briefing carries the last rejections and omits the section when there are none", () => {
	const bare = mkRun();
	assert.equal(bare.rejection_history.length, 0);
	assert.equal(briefings.repair(bare).includes("Previously rejected"), false);
	pushRejection(bare, "verification", "verdict needed real acceptance output", "T1");
	const text = briefings.repair(bare);
	assert.match(text, /Previously rejected/);
	assert.match(text, /round 2 \[verification\] T1: verdict needed real acceptance output/);
});

test("runGate judges on exit code and captures the observed tail", async () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-gate-"));
	try {
		const g = await runGate(
			[
				["true", "always green"],
				["echo boom; exit 3", "must fail"],
			],
			dir,
		);
		assert.equal(g.passed, false);
		assert.equal(g.results[0].ok, true);
		assert.equal(g.results[1].ok, false);
		assert.match(g.results[1].tail, /boom/);
		const green = await runGate([["echo hi", "x"]], dir);
		assert.equal(green.passed, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the gate never blocks the event loop: a slow row leaves the host ticking", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-loop-"));
	let ticks = 0;
	const iv = setInterval(() => ticks++, 20);
	const g = await runGate([["sleep 0.3; exit 0", "slow but green"]], dir);
	clearInterval(iv);
	rmSync(dir, { recursive: true, force: true });
	assert.equal(g.passed, true, "the row is still judged on its exit code");
	// The synchronous form (`execFileSync`) measured ticks=0 here: the TUI stops painting,
	// keystrokes go dead and the swap watch's polls starve — the freeze, proved.
	assert.ok(ticks >= 5, `the gate ran ON the event loop: ${ticks} timer ticks during a 300 ms row`);
});

test("the gate's TOTAL budget bounds the run: a hung row is KILLED, the rows behind it are named UNMEASURED", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-budget-"));
	const prev = process.env.FADE_ORCHESTRATE_GATE_TOTAL_BUDGET_MS;
	process.env.FADE_ORCHESTRATE_GATE_TOTAL_BUDGET_MS = "1000";
	const t0 = Date.now();
	let g;
	try {
		g = await runGate([["sleep 30; exit 0", "hangs"], ["true", "would pass"]], dir);
	} finally {
		if (prev === undefined) delete process.env.FADE_ORCHESTRATE_GATE_TOTAL_BUDGET_MS;
		else process.env.FADE_ORCHESTRATE_GATE_TOTAL_BUDGET_MS = prev;
		rmSync(dir, { recursive: true, force: true });
	}
	const spent = Date.now() - t0;
	assert.ok(spent < 5_000, `the gate ran ${spent}ms, far past its 1 s total budget`);
	assert.equal(g.passed, false, "an unmeasured row is never a green gate");
	assert.equal(g.results.length, 2, "every check keeps a row: the gate never silently shrinks");
	assert.match(g.results[0].tail, /KILLED at the row's timeout/, "the hung row is named as killed, not passed silently");
	assert.equal(g.results[1].budget, true, "the row that never ran is marked budget");
	assert.match(g.results[1].tail, /NOT RUN/, "and its tail says UNMEASURED, so the coder fixes the hung check");
});

test("the gate briefing names each failing command and its expected text", () => {
	const run = mkRun({
		state: "coding",
		gate_last: {
			at: "2030-01-01T00:00:00Z",
			passed: false,
			results: [
				{ cmd: "cargo test --release -p x", expected: "0 failures", ok: false, tail: "test result: FAILED. 3 failed" },
				{ cmd: "true", expected: "green", ok: true, tail: "" },
			],
		},
	});
	const text = briefings.gate(run);
	assert.match(text, /Pre-swap gate RED/);
	assert.match(text, /FAIL: cargo test --release -p x/);
	assert.match(text, /test result: FAILED. 3 failed/);
	assert.equal(text.includes("FAIL: true"), false, "green checks are not listed");
});

test("handover is stable-first: definitions before statuses (the cache-hitting prefix)", () => {
	const run = mkRun({ repo: process.cwd(), state: "coding", round: 3 });
	pushRejection(run, "verification", "T1 verdict skipped a check", "T1");
	const text = handoverText(run);
	const stable = text.indexOf("Task definitions");
	const volatile = text.indexOf("Task state");
	const rej = text.indexOf("Rejections so far");
	assert.ok(stable > 0 && volatile > stable && rej > volatile, `stable=${stable} volatile=${volatile} rej=${rej}`);
	assert.match(text, /Phase contract/);
});

test("handover carries the gate failure tail", () => {
	const run = mkRun({
		gate_last: { at: "x", passed: false, results: [{ cmd: "cargo check", expected: "0", ok: false, tail: "error[E0308]" }] },
	});
	assert.match(handoverText(run), /Last pre-swap gate FAILED/);
	assert.match(handoverText(run), /E0308/);
});

test("diffStat names the working-tree change or the clean state", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-diff-"));
	try {
		initRepo(dir);
		writeFileSync(join(dir, "f.ts"), "x");
		commitAll(dir);
		assert.match(diffStat(dir), /working tree clean/);
		writeFileSync(join(dir, "f.ts"), "y");
		assert.match(diffStat(dir), /f\.ts/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("refreshChecks: the gate honors an on-disk repair of the plan's checks, keyed by run_id", () => {
	// The livelock this pins: two checks fixed in state.json while the gate keeps re-judging the
	// session's in-memory pair, every round.
	const broken = [["bash scripts/ops/scan_resident_parity.sh --artifacts <pinned dir>; echo $?", "PASS 0"], ["cargo run --release --bin lineage_check -- --only pattern_scan_driver", "claims pass"]];
	const run = mkRun({ checks: broken });
	const repaired = [["bash scripts/ops/scan_resident_parity_selftest.sh", "both legs PASS"], ["src/fade_store_guard/target/release/lineage_check --only pattern_scan_driver", "2 pass, 0 fail"]];
	const r = refreshChecks(run, { ...run, checks: repaired });
	assert.equal(r.changed, true);
	assert.equal(r.to, 2);
	assert.deepEqual(r.removed, broken.map((c) => c[0]), "the broken pair is named as replaced");
	assert.deepEqual(run.checks, repaired, "the run object now carries the file's commands");
	const again = refreshChecks(run, { ...run, checks: repaired });
	assert.equal(again.changed, false, "an equal file is a silent no-op — the announcement fires only when data moved");
	assert.equal(refreshChecks(run, undefined).changed, false, "no state file is a no-op");
	const foreign = refreshChecks(run, { ...run, run_id: "OTHER-RUN", checks: [["rm -rf /", "never"]] });
	assert.equal(foreign.changed, false, "a state file from another run is never adopted");
	assert.equal(run.checks[0][0], repaired[0][0], "the foreign file changed nothing");
	const ragged = refreshChecks(run, { ...run, checks: [["only-one-element"], ["good", "check"], null, [7, "x"]] });
	assert.equal(ragged.to, 1, "a malformed pair is dropped, never grafted into the gate");
	assert.deepEqual(run.checks, [["good", "check"]]);
});

test("refreshRoot: the gate re-roots when the state file names another working tree, keyed by run_id", () => {
	// The livelock this pins: a run started in repo A and aimed at repo B. Every check is
	// `bash -lc <cmd>` at run.repo, so B's src/, ci/ and benches/ do not exist, B's package is
	// "No module named", and no change made inside B can ever pay the gate.
	const run = mkRun({ repo: "/repo/A" });
	const moved = refreshRoot(run, { ...run, repo: "/repo/B" }, (p) => p === "/repo/B");
	assert.equal(moved.changed, true);
	assert.equal(run.repo, "/repo/B", "the gate runs where the code is");
	assert.deepEqual([moved.from, moved.to], ["/repo/A", "/repo/B"], "the move is named, never silent");
	assert.equal(refreshRoot(run, { ...run, repo: "/repo/B" }, () => true).changed, false, "an equal root is a no-op");
	const notGit = refreshRoot(run, { ...run, repo: "/repo/C" }, () => false);
	assert.equal(notGit.changed, false, "a path that is not a working tree is refused");
	assert.match(notGit.refused ?? "", /not a git working tree/, "the refusal names its reason");
	assert.equal(run.repo, "/repo/B", "the refusal left the run where it was");
	assert.equal(refreshRoot(run, { ...run, run_id: "OTHER-RUN", repo: "/repo/D" }, () => true).changed, false, "a state file from another run is never adopted");
	assert.equal(refreshRoot(run, undefined, () => true).changed, false, "no state file is a no-op");
	assert.equal(refreshRoot(run, { ...run, repo: "" }, () => true).changed, false, "an empty repo string is never adopted");
	const here = process.cwd();
	assert.equal(refreshRoot(mkRun({ repo: here }), { ...mkRun({ repo: here }), repo: here }).changed, false, "the default probe agrees: an equal path never moves");
});

test("a non-repo run root degrades by name: git's --no-index usage page never reaches a briefing", () => {
	// The defect: a run root that is not a working tree. Outside a tree `git diff` does not fail —
	// it switches to --no-index mode and prints ~60 lines of usage, which rides into the briefing as
	// the `Working tree:` line and into the TUI as a warning.
	const dir = mkdtempSync(join(tmpdir(), "orch-norepo-"));
	try {
		assert.equal(isGitRepo(dir), false, "a bare temp dir is not a working tree");
		const cases = [["diffStat", diffStat(dir)], ["porcelain", porcelain(dir)]];
		for (const [name, text] of cases) {
			assert.match(text, /not a git repo/, `${name} names the condition`);
			for (const leak of ["usage:", "no-index", "pathspec", "Not a git repository"]) {
				assert.ok(!text.includes(leak), `${name} never carries git's usage text (${leak})`);
			}
		}
		assert.equal(porcelainEntries(porcelain(dir)).length, 0, "the sentinel parses to ZERO entries");
		const run = mkRun({ repo: dir, state: "coding", round: 2, tasks: [mkTask("T1", ["a.ts"])], repair_tasks: [] });
		const syn = synthesizeCodingDone(run, dir);
		assert.equal(syn.done[0].status, "blocked");
		assert.match(syn.done[0].result, /not a git repo/, "the synthesizer's evidence names the missing repo");
		assert.match(handoverText(run), /not a git repo/, "the working-tree line is the sentinel");
		const ckpt = tagCheckpoint(dir, run, "T1");
		assert.equal(ckpt.ok, false);
		assert.match(ckpt.error ?? "", /not a git repo/, "the refused checkpoint tag is named");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const mkTask = (id, files) => ({ id, objective: `do ${id}`, files, acceptance: "npm test", dependencies: [], round: 0 });

test("classifyTurnEnd: a phase-less turn is protocol debt, never a coding round — 1 nudge, 2 synthesize, 3 stall", () => {
	const run = mkRun({ state: "coding", round: 4, max_rounds: 5 });
	assert.equal(classifyTurnEnd(run, false), "nudge");
	assert.equal(run.protocol_retries, 1);
	assert.equal(run.stall_count, 1);
	assert.equal(run.round, 4, "no coding round is burned by a silent turn");
	assert.equal(run.max_rounds, 5, "the budget is never resized");
	assert.equal(classifyTurnEnd(run, false), "synthesize");
	assert.equal(classifyTurnEnd(run, false), "stall");
	assert.equal(run.protocol_retries, 3);
	assert.equal(run.round, 4, "the circuit breaker spends a run, not a round");
	assert.equal(classifyTurnEnd(run, true), "phase");
	assert.equal(run.stall_count, 0, "an accepted phase clears the streak");
	assert.equal(run.protocol_retries, 3, "the cumulative count survives");
});

test("normalizeRun defaults the gate fields on a v1 file and never clobbers a value the file carries", () => {
	const v1 = normalizeRun({ key: "k", run_id: "R", goal: "g", repo: "/repo", max_rounds: 6, round: 1, state: "coding", lane: "l", checks: [], tasks: [], phases: [], repair_tasks: [], started_utc: "x" });
	assert.equal(v1.protocol_retries, 0);
	assert.equal(v1.stall_count, 0);
	assert.equal(v1.paused, false);
	assert.ok(v1.checkpoints === undefined || typeof v1.checkpoints === "object", "reading checkpoints is safe on a v1 resume");
	const v2 = normalizeRun({ ...v1, protocol_retries: 2, stall_count: 1, paused: true, operator_note: "holding for review", checkpoints: { T1: "omp-ckpt/R/T1-passed" } });
	assert.equal(v2.protocol_retries, 2, "resumed protocol debt is carried, not reset");
	assert.equal(v2.stall_count, 1);
	assert.equal(v2.paused, true);
	assert.equal(v2.operator_note, "holding for review");
	assert.equal(v2.checkpoints.T1, "omp-ckpt/R/T1-passed");
});

test("countRejections separates schema refusals from verification bounces; the round budget never moves", () => {
	const run = mkRun({ round: 3 });
	pushRejection(run, "schema", 'status "done" is not "passed|failed|blocked"', "T1");
	pushRejection(run, "schema", "payload is not JSON", "T1");
	pushRejection(run, "verification", "verdict skipped T2's acceptance command", "T2");
	assert.equal(countRejections(run, "schema"), 2);
	assert.equal(countRejections(run, "verification"), 1);
	assert.equal(countRejections(run, "task"), 0);
	assert.equal(run.round, 3, "a schema refusal is reported as schema_error and never spends a round");
});

test("synthesizeCodingDone reads real git: passed for the task whose file moved, blocked for the one that did not", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-synth-"));
	try {
		initRepo(dir);
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "a.ts"), "base");
		writeFileSync(join(dir, "src", "b.ts"), "base");
		commitAll(dir);
		writeFileSync(join(dir, "src", "a.ts"), "worked on it");
		const run = mkRun({
			repo: dir,
			state: "coding",
			round: 2,
			tasks: [mkTask("T1", ["src/a.ts"]), mkTask("T2", ["src/b.ts"])],
			repair_tasks: [],
			gate_last: { at: "2030-01-01T00:00:00Z", passed: false, results: [{ cmd: "npm test", expected: "0 failures", ok: false, tail: "1 failed" }] },
		});
		const s = synthesizeCodingDone(run, dir);
		const byId = Object.fromEntries(s.done.map((d) => [d.id, d]));
		assert.equal(byId.T1.status, "passed");
		assert.match(byId.T1.result, /src\/a\.ts/, "the result quotes the porcelain entry it used");
		assert.match(byId.T1.result, /M src\/a\.ts/);
		assert.equal(byId.T2.status, "blocked");
		assert.match(byId.T2.result, /src\/b\.ts/, "the block names the file with no change");
		assert.ok(s.sources.porcelain.length > 0, "sources.porcelain is non-empty");
		assert.match(s.sources.porcelain, /src\/a\.ts/);
		assert.match(s.sources.diffStat, /src\/a\.ts/);
		assert.match(s.sources.gate, /RED/);
		assert.match(s.sources.gate, /1 failed/);
		assert.equal(run.synthesized.phase, "coding_done");
		assert.equal(run.synthesized.round, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("porcelainEntries keeps the XY code and takes a rename's destination path", () => {
	assert.deepEqual(porcelainEntries(" M src/a.ts\nR  old/name.ts -> new/name.ts\n?? newdir/\n"), [
		{ status: " M", path: "src/a.ts" },
		{ status: "R ", path: "new/name.ts" },
		{ status: "??", path: "newdir/" },
	]);
	assert.deepEqual(porcelainEntries("(working tree clean)"), [], "the sentinel is not an entry");
});

test("checkpointName is run-namespaced and tagCheckpoint writes the tag, records it, and reports failure", () => {
	const run = mkRun();
	assert.equal(checkpointName(run, "T3"), "omp-ckpt/R/T3-passed");
	const dir = mkdtempSync(join(tmpdir(), "orch-ckpt-"));
	try {
		initRepo(dir);
		writeFileSync(join(dir, "f.ts"), "x");
		commitAll(dir);
		const first = tagCheckpoint(dir, run, "T1");
		assert.equal(first.ok, true, first.error);
		assert.equal(first.tag, "omp-ckpt/R/T1-passed");
		assert.equal(run.checkpoints.T1, first.tag);
		const listed = execFileSync("git", ["-C", dir, "tag", "--list"], { encoding: "utf8" });
		assert.match(listed, /^omp-ckpt\/R\/T1-passed$/m);
		assert.equal(tagCheckpoint(dir, run, "T1").ok, true, "a re-passed task moves its tag forward");
		assert.equal(checkpointName(run, "T1"), checkpointName(run, "T1"), "the name is stable per run+task");
		const bad = tagCheckpoint(join(dir, "not-a-repo"), run, "T2");
		assert.equal(bad.ok, false);
		assert.ok(bad.error && bad.error.length > 0, "the failure is named, never silent");
		assert.equal(run.checkpoints.T2, undefined, "a failed tag is never recorded");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeJson is crash-safe: fsync + rename leaves no .tmp and the record parses back", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-json-"));
	try {
		const path = join(dir, "runs", "state.json");
		writeJson(path, { run_id: "R", round: 3 });
		assert.equal(existsSync(`${path}.tmp`), false, "the temp file is renamed, never left behind");
		assert.deepEqual(readJson(path), { run_id: "R", round: 3 });
		assert.equal(JSON.parse(readFileSync(path, "utf8")).round, 3, "fsync ran and the bytes are on disk");
		writeJson(path, { run_id: "R", round: 4 });
		assert.equal(readJson(path).round, 4, "a rewrite over a live record stays atomic");
		assert.equal(existsSync(`${path}.tmp`), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the nudge briefing names the owed phase, the unspent round, and the cost of the next miss", () => {
	const run = mkRun({ state: "coding", round: 3 });
	classifyTurnEnd(run, false);
	const text = briefings.nudge(run);
	assert.match(text, /Protocol nudge 1\/2/);
	assert.match(text, /phase="coding_done"/);
	assert.match(text, /round 3\/6/);
	assert.match(text, /UNSPENT/);
	assert.match(text, /Payload schemas/, "the published schema rides with the nudge");
	assert.match(text, /stalled_protocol_error/, "the lane is told what the next miss costs");
});

test("the stalled briefing is the Tier-3 diagnostic: halted state, RED gate tails, git state, the resume path", () => {
	const run = mkRun({
		state: "coding",
		protocol_retries: 3,
		stall_count: 3,
		paused: true,
		operator_note: "reviewing by hand",
		phases: [{ phase: "coding_done", lane: "flash-next", accepted: true, round: 1, at: "x", notes: "gate was red" }],
		synthesized: { phase: "coding_done", round: 2, at: "2030-01-01T00:00:00Z" },
		gate_last: { at: "x", passed: false, results: [{ cmd: "npm test", expected: "0 failures", ok: false, tail: "2 failed" }] },
	});
	pushRejection(run, "schema", "payload is not JSON", "T1");
	const text = briefings.stalled(run);
	assert.match(text, /HALTED: stalled_protocol_error/);
	assert.match(text, /3 turn\(s\) ended with no fade_phase call/);
	assert.match(text, /RED: npm test/);
	assert.match(text, /2 failed/);
	assert.match(text, /Recent rejections:/);
	assert.match(text, /\[schema\] T1: payload is not JSON/);
	assert.match(text, /Synthesized coding_done at round 2/);
	assert.match(text, /coding_done round 1 accepted=true/);
	assert.match(text, /Operator note: reviewing by hand/);
	assert.match(text, /var\/omp-orchestrate\/state\.json/, "the diagnostic names the file to open");
	// The acts must be commands that EXIST on this build's surface: pause, code, stop.
	assert.match(text, /orchestrate pause to unpause in place/);
	assert.match(text, /orchestrate code to resume on the code lane/);
	assert.ok(!/orchestrate resume/.test(text), "there is no `resume` subcommand — never name one");
});

test("gateSummary states the verdict and every deterministic tail (the synthesizer's third source)", () => {
	const run = mkRun({
		gate_last: {
			at: "2030-01-01T09:00:00Z",
			passed: false,
			results: [
				{ cmd: "cargo check", expected: "0", ok: true, tail: "" },
				{ cmd: "npm test", expected: "0 failures", ok: false, tail: "3 failed" },
			],
		},
	});
	const text = gateSummary(run);
	assert.match(text, /^gate 2030-01-01T09:00:00Z RED:/);
	assert.match(text, /ok cargo check/);
	assert.match(text, /FAIL npm test -> 3 failed/);
	assert.equal(gateSummary(mkRun()), "(no pre-swap gate recorded)");
});

// ---- multi-task residency batching (one coder window, one coding_done) ----

const winTask = (id, dependencies = [], objective = `${id}: make ${id} green`, files = [`src/${id.toLowerCase()}.ts`]) => ({
	id,
	objective,
	files,
	acceptance: `npm test -- ${id}`,
	dependencies,
	round: 1,
});
const winRun = (tasks, over = {}) => mkRun({ state: "coding", repair_tasks: [], tasks, ...over });
const ids = (list) => list.map((t) => t.id).join(",");

test("roundWindow: T3 -> T1 leaves T1+T2 for ONE coder window and names T3's blocker", () => {
	const run = winRun([winTask("T1"), winTask("T2"), winTask("T3", ["T1"])]);
	const w = roundWindow(run);
	assert.deepEqual(w.readyNow.map((t) => t.id), ["T1", "T2"], "the window takes both unblocked tasks in plan order");
	assert.deepEqual(w.blocked, [{ id: "T3", blockedBy: ["T1"] }], "T3 is named with the dependency that holds it");
	assert.equal(ids(w.open), "T1,T2,T3", "every unpassed task is open");
});

test("roundWindow caps at MAX_WINDOW_TASKS, drops passed tasks, and counts a passed dependency as met", () => {
	const run = winRun([
		{ ...winTask("T1"), status: "passed" },
		winTask("T2"),
		winTask("T3"),
		winTask("T4", ["T1"]),
		winTask("T5"),
		winTask("T6"),
	]);
	const w = roundWindow(run);
	assert.equal(ids(w.open), "T2,T3,T4,T5,T6", "the passed task left the window (a forced-pass skip leaves it the same way)");
	assert.equal(w.readyNow.length, MAX_WINDOW_TASKS, "the window is capped, not the plan");
	assert.equal(ids(w.readyNow), "T2,T3,T4,T5", "T4's dependency is passed, so it is ready, in plan order");
	assert.deepEqual(w.blocked, [], "a passed dependency blocks nothing; the task cut by the cap is the NEXT window's work");
	assert.match(briefings.window(run), /past the 4-task window cap/, "the briefing names the cap that deferred it");
	assert.match(briefings.window(run), /cap.*T6/, "and the task it deferred");
});

test("a coding_done reporting T1+T2 marks BOTH passed and spends no extra round (one window, one swap)", () => {
	const run = winRun([winTask("T1"), winTask("T2"), winTask("T3", ["T1"])]);
	const v = validateDone(run, [
		{ id: "T1", status: "passed", result: "npm test: 63 pass" },
		{ id: "T2", status: "passed", result: "typecheck rc 0" },
	]);
	assert.equal(v.error, undefined, v.error ?? "the batch payload is accepted");
	const marked = applyDone(run, v.done);
	assert.deepEqual(marked.map((t) => [t.id, t.status]), [["T1", "passed"], ["T2", "passed"]], "every reported task is marked");
	assert.equal(run.tasks.find((t) => t.id === "T1").result, "npm test: 63 pass", "the observed result rides through verbatim");
	assert.equal(run.tasks.find((t) => t.id === "T3").status, undefined, "the blocked task is left untouched");
	assert.equal(run.round, 2, "the batch costs no extra round, so it buys no extra swap");
	assert.equal(ids(roundWindow(run).readyNow), "T3", "T3 is the next window, unblocked by the batch, in the SAME round");
});

test("briefings.window carries every ready objective UNTRUNCATED, the blocked ids, and the header", () => {
	const long = "HEAD-OF-A-LONG-CONTRACT " + "keep-this-card-in-full ".repeat(30) + " TAIL-OF-THE-ACCEPTANCE";
	const run = winRun([winTask("T1", [], long), winTask("T2"), winTask("T3", ["T1"])], { round: 1, max_rounds: 4 });
	const text = briefings.window(run);
	assert.match(text, /round 1\/4 · T2\/3 · lane flash-next/, "the round · tasks · lane header the other briefings use");
	assert.ok(text.includes(long), "the objective is verbatim: head AND tail present, nothing sliced");
	assert.ok(text.includes("src/t1.ts") && text.includes("npm test -- T1"), "files and acceptance ride in full");
	assert.match(text, /T3 blocked by T1/, "the blocked task is named with its blocker");
	assert.match(text, /ONE coding_done/, "the one-payload contract is in the turn's own words");
	assert.ok(text.includes('{"id":"T1"') && text.includes('{"id":"T2"'), "the payload template names BOTH tasks of the window");
	assert.ok(!text.includes('{"id":"T3"'), "the blocked task is never in the report template");
});

test("a coding_done naming NO task of the window is refused with the window rule named", () => {
	const run = winRun([winTask("T1"), winTask("T2"), winTask("T3", ["T1"])]);
	const v = validateDone(run, [{ id: "T3", status: "passed", result: "rushed ahead of its dependency" }]);
	assert.ok(v.error, "the per-task report is refused, not accepted");
	assert.match(v.error, /window rule/, "the refusal names the rule");
	assert.match(v.error, /one coding_done per window/, "and states it in terms the lane can act on");
	assert.match(v.error, /this window is T1,T2/, "and says what the window was");
	assert.equal(run.tasks.find((t) => t.id === "T3").status, undefined, "a refused payload marks nothing");
	const one = validateDone(run, [{ id: "T1", status: "passed", result: "x" }]);
	assert.equal(one.error, undefined, "a report naming a window task is accepted");
});

test("validateDone keeps the schema rules and refuses a duplicate entry", () => {
	const run = winRun([winTask("T1"), winTask("T2")]);
	assert.match(validateDone(run, []).error, /non-empty done\[\]/);
	assert.match(validateDone(run, [{ id: "T9", status: "passed" }]).error, /not a task of this run/);
	assert.match(validateDone(run, [{ id: "T1", status: "ok" }]).error, /passed\|failed\|blocked/);
	assert.match(validateDone(run, [{ id: "T1", status: "passed" }, { id: "T1", status: "failed" }]).error, /duplicate done entry for T1/);
	const mixed = validateDone(run, [{ id: "T1", status: "blocked", result: "gate red" }, { id: "T2", status: "passed", result: "green" }]);
	assert.equal(mixed.done.length, 2, "a window may report a failure and a pass in one payload");
	assert.equal(mixed.done[0].result, "gate red");
});

test("the window follows the repair pool while a repair round is in flight", () => {
	const run = mkRun();
	assert.equal(ids(roundWindow(run).readyNow), "T1", "the repair list is this round's plan");
	const v = validateDone(run, [{ id: "T1", status: "passed", result: "fixed" }]);
	assert.equal(v.error, undefined, v.error ?? "the repair task is in the window");
	assert.deepEqual(applyDone(run, v.done).map((t) => `${t.id}:${t.status}`), ["T1:passed"]);
	assert.equal(run.repair_tasks[0].status, "passed", "it is the repair task that was marked");
});

test("an all-blocked window says so and blocks the report it cannot make", () => {
	const run = winRun([{ ...winTask("T1", ["T2"]) }, { ...winTask("T2", ["T1"]) }]);
	const w = roundWindow(run);
	assert.deepEqual(w.readyNow, []);
	assert.deepEqual(w.blocked, [{ id: "T1", blockedBy: ["T2"] }, { id: "T2", blockedBy: ["T1"] }], "a dependency cycle is reported, not swallowed");
	assert.match(briefings.window(run), /window is EMPTY/);
	assert.equal(validateDone(run, [{ id: "T1", status: "passed", result: "x" }]).error, undefined, "with no window there is no window to skip");
});

// ---- the gate's plan-defect class -------------------------------------------------------------
// The plan declared `bash scripts/ops/scan_resident_parity.sh --artifacts <pinned dir>; echo $?`.
// `<pinned` is an input redirect and `dir>` an output redirect whose required word is the `;`
// operator, so bash dies at PARSE time: the row is red for every tree the run can build, and the
// gate refused seven coding_done reports over it. A check that is not a command is a defect in the
// PLAN, and the machine must say so in those words.
const NOT_A_COMMAND = "bash scripts/ops/scan_resident_parity.sh --artifacts <pinned dir>; echo $?";

test("checkParses separates a command from a string bash cannot parse", () => {
	assert.equal(checkParses("cd ci && npm test").ok, true);
	assert.equal(checkParses("true").ok, true);
	const bad = checkParses(NOT_A_COMMAND);
	assert.equal(bad.ok, false);
	assert.match(bad.detail, /syntax error/, "the parse error travels in the refusal");
});

test("validateChecks refuses an unparseable check at the plan's authoring edge", () => {
	const bad = validateChecks([[NOT_A_COMMAND, "PASS 0 on the pinned nightly"]]);
	assert.match(bad.error, /is not a command/);
	assert.match(bad.error, /--ref/, "the refusal names the runnable form, not just the failure");
	const good = validateChecks([["bash tools/parity_scan.sh --ref reports/parity/latest --lanes grid", "byte rc 0"]]);
	assert.equal(good.error, undefined, good.error ?? "the runnable form is accepted");
	assert.equal(good.checks.length, 1);
});

test("runGate NEVER spawns an unparseable check and grades it INVALID, not FAIL", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-parse-"));
	const marker = join(dir, "spawned");
	// The row keeps the plan's exact redirect shape and adds a side effect: if the gate spawned it,
	// `marker` would exist.
	const g = await runGate([[`touch ${marker} --artifacts <pinned dir>; echo $?`, "never runs"], ["true", "runs"]], dir);
	assert.equal(existsSync(marker), false, "an unparseable row is never executed");
	assert.equal(g.results[0].invalid, true);
	assert.match(g.results[0].tail, /not a command/);
	assert.equal(g.results[1].ok, true, "the parseable rows still run");
	assert.equal(g.passed, false, "a plan defect never pays the verifier swap");
	assert.match(gateSummary({ gate_last: g }), /INVALID/);
	rmSync(dir, { recursive: true, force: true });
});

test("the gate briefing names the plan defect and its exit, and keeps real failures separate", async () => {
	const g = await runGate([[NOT_A_COMMAND, "PASS 0"], ["false", "must pass"]], process.cwd());
	const text = briefings.gate({ gate_last: g, round: 1, run_id: "R", repo: "/repo" });
	assert.match(text, /INVALID CHECK \(not a command, never executed\)/);
	assert.match(text, /PLAN DEFECTS/);
	assert.match(text, /phase="planning_done"/, "the briefing names the plan act as the exit");
	assert.match(text, /FAIL: false/, "a check that ran and failed is still a failure");
});

test("sameTaskPlan: a plan act re-declares the checks, never the plan", () => {
	const plan = [
		{ id: "T1", objective: "a", files: ["b.ts", "a.ts"], acceptance: "x", dependencies: [] },
		{ id: "T2", objective: "b", files: ["c.ts"], acceptance: "y", dependencies: ["T1"] },
	];
	assert.equal(sameTaskPlan(plan, plan.map((t) => ({ ...t, round: 3, status: "passed" }))), true, "machine state is not the plan");
	assert.equal(sameTaskPlan(plan, [...plan].reverse()), true, "order is not the plan");
	assert.equal(sameTaskPlan(plan, [{ ...plan[0], objective: "changed" }, plan[1]]), false);
	assert.equal(sameTaskPlan(plan, [plan[0]]), false, "dropping a task is not a plan act");
});

// ---- plan-declared round caps, per-task negative memory, the compact repair prompt ------------

const tierTask = (id, complexity) => ({
	id,
	objective: `${id}: obj`,
	files: [`src/${id.toLowerCase()}.ts`],
	acceptance: `npm test -- ${id}`,
	dependencies: [],
	round: 1,
	...(complexity ? { complexity } : {}),
});
const rej = (round, kind, task_id, reason) => ({ round, at: `2030-01-01T0${round}:00:00.000Z`, kind, task_id, reason });

test("the plan declares the cap — trivial 2, standard 4, deep 6, the max over the plan, --rounds the ceiling", () => {
	assert.equal(roundsForTasks([tierTask("T1", "trivial"), tierTask("T2", "trivial")], 6), 2, "a plan of trivial edits reserves TWO rounds");
	assert.equal(roundsForTasks([tierTask("T1", "standard")], 6), 4, "standard is four");
	assert.equal(roundsForTasks([tierTask("T1", "deep")], 6), 6, "deep is six");
	assert.equal(roundsForTasks([tierTask("T1", "trivial"), tierTask("T2", "deep")], 6), 6, "the deepest task sets the cap");
	assert.equal(roundsForTasks([tierTask("T1", "deep")], 3), 3, "the operator's --rounds budget is the ceiling");
	assert.equal(roundsForTasks([tierTask("T1"), tierTask("T2")], 6), 3, "an unannotated plan keeps the measured count curve");
	assert.equal(roundsForTasks([tierTask("T1"), tierTask("T2"), tierTask("T3"), tierTask("T4"), tierTask("T5"), tierTask("T6")], 6), 5);
});

test("validateTasks carries a declared complexity and refuses a non-name by name", () => {
	const ok = validateTasks([{ id: "T1", objective: "o", files: ["a.ts"], acceptance: "a", dependencies: [], complexity: "trivial" }]);
	assert.equal(ok.error, undefined, ok.error ?? "");
	assert.equal(ok.tasks?.[0].complexity, "trivial");
	const bad = validateTasks([{ id: "T1", objective: "o", files: ["a.ts"], acceptance: "a", dependencies: [], complexity: "fast" }]);
	assert.match(bad.error ?? "", /complexity must be trivial\|standard\|deep/, "the refusal names the allowed set");
});

test("the loop reads the plan's cap — the window header and the nudge both say R/2", () => {
	const run = mkRun({ max_rounds: roundsForTasks([tierTask("T1", "trivial")], 6), round: 2, state: "coding", repair_tasks: [], tasks: [winTask("T1")] });
	assert.match(briefings.window(run), /round 2\/2/, "the coder sees the plan's budget, not the flat 6");
	assert.match(briefings.nudge(run), /round 2\/2/, "and so does the protocol nudge");
});

test("a task rejected twice is briefed with ITS OWN critique, counted, and told the diff was tried", () => {
	const run = mkRun({
		round: 3,
		state: "repair",
		repair_tasks: [
			{ id: "T1", objective: "fix the widget", files: ["w.ts"], acceptance: "npm test -- w", dependencies: [], round: 3 },
			{ id: "T2", objective: "the docs", files: ["d.md"], acceptance: "read d.md", dependencies: [], round: 3 },
		],
		rejection_history: [
			rej(1, "verification", "T1", "T1: the acceptance command exits 1 on w.ts"),
			rej(2, "verification", "T1", "T1: same diff, the test still exits 1"),
			rej(2, "task", "T2", "T2: no acceptance output in the report"),
		],
	});
	const p = briefings.repair(run);
	assert.match(p, /BY TASK:/, "the critique arrives grouped by task, not as a transcript");
	assert.match(p, /T1 — rejected 2× \(latest round 2, verification\)/, "the count and the newest round are named");
	assert.ok(p.includes("T1: same diff, the test still exits 1"), "the newest critique for T1 rides verbatim");
	assert.match(p, /the same diff was already tried; change the CAUSE/, "the anti-oscillation instruction rides on the count");
	assert.match(p, /T2 — rejected 1×/, "the other task gets its own line");
	assert.ok(p.includes("T2: no acceptance output in the report"));
});

test("a task with no history earns no critique line (the block is data, not boilerplate)", () => {
	const p = briefings.repair(mkRun({ round: 2, rejection_history: [] }));
	assert.ok(!p.includes("BY TASK:"), "no rejections, no critique block");
});

test("the coding window carries the critique of the tasks IN the window, on the round that re-briefs them", () => {
	const run = winRun([winTask("T1"), winTask("T2")], { round: 2, rejection_history: [rej(1, "verification", "T1", "T1: the cache key is stale")] });
	const w = briefings.window(run);
	assert.match(w, /Rejected before — the verifier's critique/, "round 2 names the rejections the window inherits");
	assert.ok(w.includes("T1: the cache key is stale"));
	const first = winRun([winTask("T1"), winTask("T2")], { round: 1, rejection_history: [rej(1, "verification", "T1", "T1: the cache key is stale")] });
	assert.ok(!briefings.window(first).includes("Rejected before"), "the FIRST window of a round has nothing to inherit");
});

test("critiquesFor reads the history BY TASK ID, newest last, and ignores schema/gate refusals", () => {
	const lines = critiquesFor(
		mkRun({
			rejection_history: [
				rej(1, "schema", "T1", "payload is not JSON"),
				rej(1, "verification", "T1", "T1: gate red on the plugin suite"),
				rej(2, "verification", "T1", "T1: gate red again, same diff"),
			],
		}),
		["T1", "T2"],
	);
	assert.equal(lines.length, 1, "T2 earned nothing, so it earns no line");
	assert.match(lines[0], /T1 — rejected 2×/, "a schema refusal is not a verifier critique");
	assert.ok(lines[0].includes("T1: gate red again, same diff"), "the newest critique is the one quoted");
});

test("the repair prompt is the compact set — diff stat, checklist, last rejections, no prior-round tool logs", () => {
	const run = mkRun({
		round: 3,
		repair_tasks: [{ id: "T1", objective: "fix", files: ["w.ts"], acceptance: "npm test -- w", dependencies: [], round: 3 }],
		rejection_history: [rej(2, "verification", "T1", "T1: red gate")],
	});
	const p = briefings.repair(run);
	assert.match(p, /^Working tree: /m, "the diff stat answers where the tree is");
	assert.ok(p.includes("Checklist: T1: npm test -- w"), "the checklist is one line, not the transcript");
	assert.match(p, /no prior-round tool logs/);
	assert.ok(!/stdout|traceback|full log/i.test(p), "no prior-round log dumps ride");
	assert.ok(p.length < 2500, `the repair prompt stays compact: ${p.length} chars`);
	const h = handover(run);
	assert.ok(h.stable.join("\n").includes("Task definitions:"), "the stable prefix (goal, contract, task definitions) leads");
	assert.ok(h.volatile.join("\n").includes("Working tree:"), "the volatile tail goes last");
});

test("a 3-task plan is ONE window — 3 ready, ONE coding_done marks all 3, and the prompt names all 3 ids", () => {
	const run = winRun([winTask("T1"), winTask("T2"), winTask("T3")]);
	assert.equal(ids(roundWindow(run).readyNow), "T1,T2,T3", "three tasks, one window, zero cuts");
	const v = validateDone(run, [
		{ id: "T1", status: "passed", result: "npm test: 3 pass" },
		{ id: "T2", status: "passed", result: "npm test: 2 pass" },
		{ id: "T3", status: "passed", result: "npm test: 1 pass" },
	]);
	assert.equal(v.error, undefined, v.error ?? "");
	assert.match(
		briefings.window(run),
		/ONE coding_done payload: \{"done":\[\{"id":"T1".*\{"id":"T2".*\{"id":"T3"/,
		"the contract the lane is briefed with names every id of the window",
	);
	assert.equal(applyDone(run, v.done).length, 3, "one payload marks the whole window");
	assert.equal(ids(roundWindow(run).readyNow), "", "the round has no second window left to pay");
});

// ── declared-failure checks: a plan can name a NON-zero exit as the accepted state ──────────────
// The defect: a plan declaring `git -C . rev-parse --git-dir` → "fails: the tree is not a git repo
// yet" and `grep -rln "burnin\." probes benches` → "no output: no probe or bench emits burnin.*
// metrics". Both ARE the accepted state, and a gate that reads exit-0-only paints a red run whose
// expectations were met. The declared forms are the head words; everything else keeps exit-0.
test("expectation: the plan's head words declare the accepted exit state", () => {
	assert.equal(expectation("exit 0, no failures"), "exit0");
	assert.equal(expectation("fails: the tree is not a git repo yet"), "nonzero");
	assert.equal(expectation("FAILS: nonzero on a clean tree"), "nonzero");
	assert.equal(expectation("no output: no probe emits burnin.* metrics"), "quiet");
	assert.equal(expectation("empty output"), "quiet");
});

test("runGate: a declared failure that fails is GREEN and labelled; a stale premise is a REPORTED break", async () => {
	const g = await runGate(
		[
			["git -C /nonexistent-orch-dir rev-parse --git-dir", "fails: the tree is not a git repo yet"],
			["true", "fails: this row should have failed"],
			["false", "no output: nothing prints"],
			["echo printed", "no output: nothing prints"],
			["true", "exit 0, no failures"],
			["false", "exit 0, no failures"],
		],
		process.cwd(),
	);
	const declared = g.results.find((r) => r.cmd.includes("nonexistent-orch-dir"));
	assert.equal(declared.ok, true, "declared failure, failed as declared = ok");
	assert.equal(declared.as_expected, true);
	assert.equal(declared.want, "nonzero");
	assert.match(declared.tail, /as expected/);
	const stale = g.results.find((r) => r.expected.includes("this row should have failed"));
	assert.equal(stale.ok, false, "a declared failure that exits 0 is a stale premise, named");
	assert.match(stale.tail, /stale/);
	const quiet = g.results.find((r) => r.cmd === "false" && r.want === "quiet");
	assert.equal(quiet.ok, true, "no output and non-zero exit is the declared state");
	assert.equal(quiet.as_expected, true);
	const printed = g.results.find((r) => r.cmd === "echo printed");
	assert.equal(printed.ok, false, "a quiet check that prints is a real break");
	assert.match(printed.tail, /expected no output and the command printed 1 line\(s\)/);
	assert.equal(g.results.find((r) => r.cmd === "true" && r.want === "exit0").ok, true);
	assert.equal(g.results.find((r) => r.cmd === "false" && r.want === "exit0").ok, false, "the exit-0 default is untouched");
	assert.equal(g.passed, false, "two real breaks keep the gate red");
});

test("gateRows: the as-expected rows are labelled and counted, and the gate reads them GREEN-side", async () => {
	const g = await runGate(
		[
			["git -C /nonexistent-orch-dir rev-parse --git-dir", "fails: the tree is not a git repo yet"],
			["true", "exit 0, no failures"],
		],
		process.cwd(),
	);
	const rows = gateRows(g);
	assert.equal(rows[0].tone, "ok", "every row is in its declared state, so the gate row is GREEN");
	assert.match(rows[0].value, /GREEN 0\/2 failing · 1 as expected/);
	assert.ok(rows.some((r) => r.label === "  ok*" && /not a git repo/.test(r.value)), "the as-expected row is named");
	assert.ok(!rows.some((r) => r.label === "  red"), "no red row is rendered for a declared state");
});

// ── the non-git run root: named at the first keystroke, not as a wall of red rows two rounds later ─
// Measured in a run rooted outside any git repo: the T2 synthesizer reads
// `git status --porcelain`, so all six tasks landed `blocked` with the sentinel tail.
test("gitCaveat and the briefings name a non-git run root, and stay silent in a working tree", () => {
	const plain = mkdtempSync(join(tmpdir(), "orch-nogit-"));
	const tree = mkdtempSync(join(tmpdir(), "orch-git-"));
	try {
		execFileSync("git", ["-C", tree, "init", "-q"], { stdio: "pipe" });
		assert.match(gitCaveat(plain), /NOT a git repo/);
		assert.ok(gitCaveat(plain).includes("git init " + plain), "the act is the literal command");
		assert.equal(gitCaveat(tree), "", "a working tree gets no caveat");
		const r = (repo) => mkRun({ repo });
					const pairs = [["plan", briefings.plan(r(plain))], ["code", briefings.code(r(plain))], ["window", briefings.window(r(plain))], ["repair", briefings.repair(r(plain))]];
			for (const [name, text] of pairs) {
			assert.match(text, /NOT a git repo/, `${name} briefing names the root state`);
			assert.match(text, /git init/, `${name} briefing names the act`);
		}
		assert.doesNotMatch(briefings.plan(r(tree)), /NOT a git repo/, "the same briefing in a repo says nothing");
	} finally {
		rmSync(plain, { recursive: true, force: true });
		rmSync(tree, { recursive: true, force: true });
	}
});
