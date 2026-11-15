#!/usr/bin/env node
// ui.test.mjs — the footer pill's contract. The status row is SHARED (the host renders it beside
// the model name and the token counters), so the pill must stay short and must never hide a
// stalled protocol error; the full lane name stays in `/orchestrate status` and the overlay.
import assert from "node:assert/strict";
import test from "node:test";
import { laneTag, pill, statusTag } from "../.test-build/ui.mjs";

const run = (over = {}) => ({
	lane: "flash-next",
	round: 1,
	max_rounds: 6,
	state: "coding",
	tasks: [{ status: "passed" }, { status: "pending" }, { status: "passed" }],
	...over,
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

test("statusTag: every state machine name has a short tag, and a stall stays visible", () => {
	assert.equal(statusTag(run({ state: "coding" })), "fn:code");
	assert.equal(statusTag(run({ state: "verifying" })), "fn:ver");
	assert.equal(statusTag(run({ state: "stalled_protocol_error" })), "fn:stall");
	assert.equal(statusTag(run({ state: "unknown_future_state" })), "fn:unknown_future_state");
});

test("pill: one line, no full model name, round and task tally intact", () => {
	const p = pill(run());
	assert.equal(p, "⚡ fn:code · R1/6 · T2/3 · [Ctrl+O]");
	assert.ok(!p.includes("flash-next"));
	assert.ok(p.length < 48, `pill overflows the footer row: ${p.length} chars`);
});

test("pill: the tok/s suffix is appended after the key hint and never truncates the core", () => {
	assert.equal(pill(run(), "hot 130t/s"), "⚡ fn:code · R1/6 · T2/3 · [Ctrl+O] · hot 130t/s");
});
