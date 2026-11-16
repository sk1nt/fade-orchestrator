/**
 * keymap unit tests: the overlay's s/v/r/p/c/h semantics, exercised headlessly. The TUI keystroke
 * path and the `/orchestrate` command path both call these functions, so this is the whole
 * action surface minus the terminal plumbing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { actCode, actHalt, actPause, actReset, actSkip, actVerify } from "../.test-build/keymap.mjs";

const mkRun = (over = {}) => ({
	key: "fade.omp_orchestrate.run.v1",
	run_id: "test",
	goal: "g",
	lane: "flash-next",
	round: 3,
	max_rounds: 6,
	state: "coding",
	tasks: [
		{ id: "T1", objective: "a", files: ["x"], acceptance: "y", dependencies: [], round: 1, status: "passed", result: "ok" },
		{ id: "T2", objective: "b", files: ["z"], acceptance: "w", dependencies: [], round: 1 },
	],
	repair_tasks: [],
	phases: [],
	started_utc: "2030-01-01T00:00:00Z",
	...over,
});

test("skip marks the first unfinished task passed and records a manual skip", () => {
	const run = mkRun();
	const d = actSkip(run);
	assert.equal(d.note.includes("T2"), true);
	assert.equal(run.tasks[1].status, "passed");
	assert.match(run.tasks[1].result, /manual skip \(operator\)/);
	assert.equal(run.tasks[0].status, "passed");
});

test("skip with an explicit id targets that task; unknown id is a named no-op", () => {
	const run = mkRun();
	actSkip(run, "T1");
	assert.match(run.tasks[0].result, /manual skip/);
	const d = actSkip(run, "T9");
	assert.equal(d.note.includes("no task T9"), true);
	assert.equal(run.tasks[1].status, undefined);
});

test("skip with everything passed names it and changes nothing", () => {
	const run = mkRun();
	run.tasks[1].status = "passed";
	const d = actSkip(run);
	assert.equal(d.note.includes("every task already passed"), true);
});

test("verify from coding moves to the thinking lane; from planning it is a named no-op", () => {
	const run = mkRun();
	const d = actVerify(run);
	assert.equal(d.nextState, "verifying");
	assert.equal(typeof d.next, "string");
	assert.equal(run.state, "verifying");
	const p = mkRun({ state: "planning" });
	const d2 = actVerify(p);
	assert.equal(d2.next, undefined);
	assert.match(d2.note, /not a coding phase/);
});

test("reset zeroes the round and keeps tasks and statuses", () => {
	const run = mkRun();
	const d = actReset(run);
	assert.equal(d.note.includes("round reset to 1"), true);
	assert.equal(run.round, 1);
	assert.equal(run.tasks[0].status, "passed");
});

test("halt stops the run and leaves the lane resident", () => {
	const run = mkRun();
	const d = actHalt(run);
	assert.equal(d.nextState, "stopped");
	assert.equal(d.next, undefined);
	assert.equal(run.state, "stopped");
});

test("code resumes a stopped run onto the code lane; a complete run is refused", () => {
	const run = mkRun({ state: "stopped" });
	const d = actCode(run);
	assert.equal(d.nextState, "coding");
	assert.equal(typeof d.next, "string");
	const done = mkRun({ state: "complete" });
	const d2 = actCode(done);
	assert.equal(d2.next, undefined);
});

test("pause parks the loop as a FLAG, never a state: [p] pauses, [p] resumes, note lands on the run", () => {
	const run = mkRun();
	const p = actPause(run, "hand-editing the fixture");
	assert.equal(p.nextState, "coding");
	assert.equal(p.next, undefined);
	assert.equal(run.paused, true);
	assert.equal(run.state, "coding");
	assert.equal(run.operator_note, "hand-editing the fixture");
	assert.match(p.note, /paused \(round 3/);
	const r = actPause(run);
	assert.equal(run.paused, false);
	assert.match(run.operator_note, /resumed at round 3/);
});

test("code clears the pause flag: [c] is an explicit keep-going", () => {
	const run = mkRun({ state: "coding" });
	actPause(run);
	const d = actCode(run);
	assert.equal(run.paused, false);
	assert.equal(d.nextState, "coding");
});

test("reset grows the round budget by 3 up to the cap and names it", () => {
	const run = mkRun({ max_rounds: 3 });
	const d = actReset(run);
	assert.equal(run.round, 1);
	assert.equal(run.max_rounds, 6);
	assert.match(d.note, /budget \+3 → 6 rounds/);
	const capped = mkRun();
	const d2 = actReset(capped);
	assert.equal(capped.max_rounds, 6);
	assert.match(d2.note, /budget already at the 6-round cap/);
});
