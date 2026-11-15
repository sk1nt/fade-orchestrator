/**
 * core v2 unit tests: adaptive round budget, v1→v2 migration, rejection history (append + cap),
 * the repair briefing carrying prior rejections, the pre-swap gate judging on exit code, and
 * the gate briefing naming the failing commands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptiveRounds, briefings, diffStat, handover, handoverText, normalizeRun, pushRejection, runGate } from "../.test-build/core.mjs";

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
