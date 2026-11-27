/**
 * The lane-switch decision (router.ts `switchPlan`): a target the router ALREADY holds pays nothing
 * — no idle gate, no load, and no `load is DEFERRED — slot busy` notify. The regression this pins is
 * the ordering bug: the gate ran BEFORE the residency check, so the plugin polled up to
 * GATE_BUDGET_MS and warned about a lane it was never going to move, while the request filling the
 * slot was the session asking for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import "./env.mjs?suite=switchplan";
import { switchPlan } from "../.test-build/router.mjs";

test("a resident target pays no idle gate and no load, and names the reason", () => {
	const p = switchPlan("flash-next", "flash-next");
	assert.equal(p.gate, false);
	assert.equal(p.load, false);
	assert.equal(p.reason, "already resident: flash-next; no load to gate");
});

test("a target the router is not holding keeps the full sequence: gate, then swap", () => {
	const p = switchPlan("flash-next", "deepseek");
	assert.equal(p.gate, true);
	assert.equal(p.load, true);
	assert.match(p.reason, /deepseek is not resident \(resident: flash-next\)/);
});

test("a router that names no loaded entry is a swap, never a skip", () => {
	const p = switchPlan(undefined, "flash-next");
	assert.equal(p.gate, true);
	assert.equal(p.load, true);
	assert.match(p.reason, /no loaded entry/);
});
