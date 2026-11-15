/**
 * core v2 unit tests: adaptive round budget, v1→v2 migration, rejection history (append + cap),
 * the repair briefing carrying prior rejections, the pre-swap gate judging on exit code, and
 * the gate briefing naming the failing commands.
 * The Tier-1 protocol gate (Y1/Y2/Y5/Y16): the nudge→synthesize→stall ladder costing no round,
 * the git-synthesized coding_done, the crash-safe state write, the checkpoint tags, and the
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
	diffStat,
	gateSummary,
	handover,
	handoverText,
	isGitRepo,
	MAX_WINDOW_TASKS,
	normalizeRun,
	porcelain,
	porcelainEntries,
	pushRejection,
	readJson,
	roundWindow,
	runGate,
	sameTaskPlan,
	synthesizeCodingDone,
	tagCheckpoint,
	validateChecks,
	validateDone,
	writeJson,
} from "../.test-build/core.mjs";

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

test("runGate judges on exit code and captures the observed tail", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-gate-"));
	try {
		const g = runGate(
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
		const green = runGate([["echo hi", "x"]], dir);
		assert.equal(green.passed, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the gate briefing names each failing command and its expected text", () => {
	const run = mkRun({
		state: "coding",
		gate_last: {
			at: "2026-11-15T00:00:00Z",
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
		execFileSync("git", ["init", "-q"], { cwd: dir });
		writeFileSync(join(dir, "f.ts"), "x");
		execFileSync("git", ["add", "f.ts"], { cwd: dir });
		execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "c"], { cwd: dir });
		assert.match(diffStat(dir), /working tree clean/);
		writeFileSync(join(dir, "f.ts"), "y");
		assert.match(diffStat(dir), /f\.ts/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a non-repo run root degrades by name: git's --no-index usage page never reaches a briefing", () => {
	// Measured 2026-11-15: a run whose root was a rig dir under /tmp. Outside a working tree
	// `git diff` does not fail — it switches to --no-index mode and prints ~60 lines of usage,
	// which rode into the briefing as the `Working tree:` line and into the TUI as a warning.
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
const gitCommitAll = (dir) => {
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "c"], { cwd: dir });
};

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
		execFileSync("git", ["init", "-q"], { cwd: dir });
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "a.ts"), "base");
		writeFileSync(join(dir, "src", "b.ts"), "base");
		gitCommitAll(dir);
		writeFileSync(join(dir, "src", "a.ts"), "worked on it");
		const run = mkRun({
			repo: dir,
			state: "coding",
			round: 2,
			tasks: [mkTask("T1", ["src/a.ts"]), mkTask("T2", ["src/b.ts"])],
			repair_tasks: [],
			gate_last: { at: "2026-11-15T00:00:00Z", passed: false, results: [{ cmd: "npm test", expected: "0 failures", ok: false, tail: "1 failed" }] },
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
		execFileSync("git", ["init", "-q"], { cwd: dir });
		writeFileSync(join(dir, "f.ts"), "x");
		gitCommitAll(dir);
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
		synthesized: { phase: "coding_done", round: 2, at: "2026-11-15T00:00:00Z" },
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
			at: "2026-11-15T09:00:00Z",
			passed: false,
			results: [
				{ cmd: "cargo check", expected: "0", ok: true, tail: "" },
				{ cmd: "npm test", expected: "0 failures", ok: false, tail: "3 failed" },
			],
		},
	});
	const text = gateSummary(run);
	assert.match(text, /^gate 2026-11-15T09:00:00Z RED:/);
	assert.match(text, /ok cargo check/);
	assert.match(text, /FAIL npm test -> 3 failed/);
	assert.equal(gateSummary(mkRun()), "(no pre-swap gate recorded)");
});

// ---- Y7: multi-task residency batching (one coder window, one coding_done) ----

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

// ---- the gate's plan-defect class (run 20261115T091232Z-rqtj) -------------------------------
// The plan declared `bash scripts/ops/scan_resident_parity.sh --artifacts <pinned dir>; echo $?`.
// `<pinned` is an input redirect and `dir>` an output redirect whose required word is the `;`
// operator, so bash dies at PARSE time: the row is red for every tree the run can build, and the
// gate refused seven coding_done reports over it. A check that is not a command is a defect in the
// PLAN, and the machine must say so in those words.
const NOT_A_COMMAND = "bash scripts/ops/scan_resident_parity.sh --artifacts <pinned dir>; echo $?";

test("checkParses separates a command from a string bash cannot parse", () => {
	assert.equal(checkParses("cd deploy/omp && npm test").ok, true);
	assert.equal(checkParses("true").ok, true);
	const bad = checkParses(NOT_A_COMMAND);
	assert.equal(bad.ok, false);
	assert.match(bad.detail, /syntax error/, "the parse error travels in the refusal");
});

test("validateChecks refuses an unparseable check at the plan's authoring edge", () => {
	const bad = validateChecks([[NOT_A_COMMAND, "PASS 0 on the pinned nightly"]]);
	assert.match(bad.error, /is not a command/);
	assert.match(bad.error, /--ref/, "the refusal names the runnable form, not just the failure");
	const good = validateChecks([["bash scripts/ops/scan_resident_parity.sh --ref reports/evaluation/pattern_scan_20261115 --lanes grid", "byte rc 0"]]);
	assert.equal(good.error, undefined, good.error ?? "the runnable form is accepted");
	assert.equal(good.checks.length, 1);
});

test("runGate NEVER spawns an unparseable check and grades it INVALID, not FAIL", () => {
	const dir = mkdtempSync(join(tmpdir(), "gate-parse-"));
	const marker = join(dir, "spawned");
	// The row keeps the plan's exact redirect shape and adds a side effect: if the gate spawned it,
	// `marker` would exist.
	const g = runGate([[`touch ${marker} --artifacts <pinned dir>; echo $?`, "never runs"], ["true", "runs"]], dir);
	assert.equal(existsSync(marker), false, "an unparseable row is never executed");
	assert.equal(g.results[0].invalid, true);
	assert.match(g.results[0].tail, /not a command/);
	assert.equal(g.results[1].ok, true, "the parseable rows still run");
	assert.equal(g.passed, false, "a plan defect never pays the verifier swap");
	assert.match(gateSummary({ gate_last: g }), /INVALID/);
	rmSync(dir, { recursive: true, force: true });
});

test("the gate briefing names the plan defect and its exit, and keeps real failures separate", () => {
	const g = runGate([[NOT_A_COMMAND, "PASS 0"], ["false", "must pass"]], process.cwd());
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
