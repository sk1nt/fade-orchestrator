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
	briefings,
	checkpointName,
	classifyTurnEnd,
	countRejections,
	diffStat,
	gateSummary,
	handover,
	handoverText,
	normalizeRun,
	porcelainEntries,
	pushRejection,
	readJson,
	runGate,
	synthesizeCodingDone,
	tagCheckpoint,
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
