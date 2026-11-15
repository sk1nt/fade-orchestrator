#!/usr/bin/env node
// ui.test.mjs — the footer pill's contract. The operator's placement order (2026-11-15: "put this
// text up where DeepSeek-v4.1 … is, it should fit fine") is that the pill carries the FULL lane
// name: the host renders setStatus() text on the footer's extension-status row at full terminal
// width, directly under the stats row whose right side is the model identifier, and that
// identifier is longer than this line — so the full name fits. laneTag/pillCompact survive ONLY as
// the narrow-terminal fallback, where the host truncates the row with "…".
import assert from "node:assert/strict";
import test from "node:test";
import { laneTag, overlayLines, pill, pillCompact, statusTag, statusTagCompact } from "../.test-build/ui.mjs";
const task = (id, status) => ({ id, objective: `${id} objective`, files: [`${id}.ts`], acceptance: `${id} acceptance`, dependencies: [], round: 1, status });
const run = (over = {}) => ({
	lane: "flash-next",
	round: 1,
	max_rounds: 6,
	state: "coding",
	tasks: [task("T1", "passed"), task("T2", "pending"), task("T3", "passed")],
	repair_tasks: [],
	phases: [],
	rejection_history: [],
	...over,
});

test("statusTag: the FULL lane name with a short state, and a stall stays visible", () => {
	assert.equal(statusTag(run({ state: "coding" })), "flash-next:code");
	assert.equal(statusTag(run({ lane: "deepseek:high", state: "planning" })), "deepseek:high:plan");
	assert.equal(statusTag(run({ state: "stalled_protocol_error" })), "flash-next:stall");
	assert.equal(statusTag(run({ state: "unknown_future_state" })), "flash-next:unknown_future_state");
});

test("statusTagCompact: the narrow-terminal 2-character form is the fallback, not the default", () => {
	assert.equal(statusTagCompact(run()), "fn:code");
	assert.equal(statusTagCompact(run({ state: "stalled_protocol_error" })), "fn:stall");
});

test("pill: the full lane name lands in the footer row, round and tally intact", () => {
	const p = pill(run());
	assert.equal(p, "⚡ flash-next:code · R1/6 · T2/3 · [Ctrl+O]");
	assert.ok(p.includes("flash-next"), "the full lane name must be in the status row");
});

test("pillCompact: the fallback compacts the lane name and keeps every field", () => {
	assert.equal(pillCompact(run(), "hot 130t/s"), "⚡ fn:code · R1/6 · T2/3 · [Ctrl+O] · hot 130t/s");
});

test("pill: the Tier-1 protocol badge rides only while the stall counter runs", () => {
	assert.equal(pill(run({ stall_count: 1 })), "⚡ flash-next:code · R1/6 · T2/3 · [Ctrl+O] · protocol 1/3");
	assert.equal(pill(run({ stall_count: 3 })), "⚡ flash-next:code · R1/6 · T2/3 · [Ctrl+O] · protocol 3/3");
	assert.ok(!pill(run({ stall_count: 0 })).includes("protocol"), "a clean run must not advertise a stall");
});

test("pill: a paused run says so, so a parked loop is never read as a hung one", () => {
	assert.equal(pill(run({ paused: true })), "⚡ flash-next:code · R1/6 · T2/3 · [Ctrl+O] · paused");
});

test("overlay: protocol counters, the synthesized marker, the checkpoint tag, the stall diagnostic", () => {
	const lines = overlayLines({
		run: run({
			state: "stalled_protocol_error",
			stall_count: 3,
			protocol_retries: 3,
			synthesized: { phase: "coding_done", round: 2, at: "2026-11-15T00:00:00Z" },
			checkpoints: { T1: "omp-ckpt/test/T1-passed" },
			tasks: [{ id: "T1", objective: "do the thing", files: ["x"], acceptance: "y", dependencies: [], round: 1, status: "passed" }],
		}),
		swaps: [],
		tiers: [],
	});
	assert.ok(lines.some((l) => l.includes("protocol: 3 turn(s) ended without fade_phase · consecutive stalls 3/3")), "protocol row");
	assert.ok(lines.some((l) => l.includes("auto-synthesized coding_done at round 2")), "synthesized marker");
	assert.ok(lines.some((l) => l.includes("PROTOCOL STALL (Tier-3 circuit breaker)")), "stall diagnostic");
	assert.ok(lines.some((l) => l.includes("tag: omp-ckpt/test/T1-passed")), "checkpoint tag");
});

test("overlay: the pause row, the MoE ramp badge and the [p] key line", () => {
	const lines = overlayLines({
		run: run({ paused: true, operator_note: "editing the fixture by hand" }),
		swaps: [{ from: "deepseek", to: "flash-next", elapsed_s: 14.2, first_tg: 91, steady_tg: 130, ramp: "cold_ramp", at: "2026-11-15T00:00:00Z" }],
		tiers: [],
	});
	assert.ok(lines.some((l) => l.includes("paused: the loop is stopped for manual edits · operator note: editing the fixture by hand")));
	assert.ok(lines.some((l) => l.includes("MoE: Cold Ramp")), "the warm/cold ramp badge is the swap row's");
	assert.ok(lines.some((l) => l.includes("[p] pause/resume")));
});

test("laneTag: dash names abbreviate to the initials of their first two segments", () => {
	assert.equal(laneTag("flash-next"), "fn");
	assert.equal(laneTag("flash-ornith"), "fo");
	assert.equal(laneTag("deepseek-v4.1-flash"), "dv");
});

test("laneTag: a single token keeps its first two characters, short names pass through", () => {
	assert.equal(laneTag("deepseek"), "de");
	assert.equal(laneTag("phi"), "phi");
});
