#!/usr/bin/env node
/**
 * The three-lane identity: coder / planner / advisor, and the refusal rule that keeps them three.
 *
 * Measured on run 20261126T063911Z-m5or: `~/.config/inference-keys.env` exports
 * `FADE_ORCHESTRATE_THINK_LANE=flash-next`, the think lane became the code lane, `loadLane`
 * short-circuited on the resident pack, NO swap was ever issued, and planning plus coding both ran
 * on the coder's 52 GiB pack at `THINKING=low` — the loop churned with zero thinking. The rule this
 * suite pins: a lane env that collapses the loop is REFUSED and NAMED (flushed at login through
 * `ENV_NOTICES`), the documented lane wins, and the three lanes stay three:
 *   - the coder's pack is never a documented thinking pack (the mirror of the same poison);
 *   - the planning lane is never the coder's pack;
 *   - the advisor lane is never the coder's pack (advisor == planner is legal: one deep-thinking
 *     pack answering its own verdict act is a lane economy choice, not a collapse);
 *   - every thinking lane thinks at `high`, the coder at `low`.
 */
import { resetLaneEnv } from "./env.mjs?suite=lane_identity";
import { test } from "node:test";
import assert from "node:assert/strict";

/** A fresh router module per env shape: the lanes resolve at IMPORT, so the import is the test.
 *  `resetLaneEnv()` is load-bearing HERE, not just at file top: every suite file evaluates
 *  before any test body runs, so a rig's exported windows (`START_PROOF_WAIT_MS=600`) are in
 *  the environment when this helper imports — and this suite asserts the production default. */
const fresh = async (tag, env) => {
	resetLaneEnv();
	Object.assign(process.env, env);
	return await import(`../.test-build/router.mjs?case=${tag}`);
};

test("the documented lanes: basalt fronts coder flash-next, planner deepseek, advisor hy4-flash", async () => {
	const m = await fresh("li-default-" + Date.now(), {});
	assert.equal(m.PROVIDER, "basalt", "the provider that declares every alias of the single :18014 lane");
	assert.equal(m.CODE_LANE, "flash-next");
	assert.equal(m.THINK_LANE, "deepseek");
	assert.equal(m.VERIFY_LANE, "hy4-flash", "verification rides its own pack: never the coder's");
	assert.equal(m.ENV_NOTICES.length, 0, "honest env, honest silence");
});

test("the box poison: THINK_LANE=flash-next is refused and NAMED, and planning stays deepseek", async () => {
	const m = await fresh("li-poison-" + Date.now(), { FADE_ORCHESTRATE_THINK_LANE: "flash-next" });
	assert.equal(m.THINK_LANE, "deepseek", "the coder's pack is refused as the planning lane");
	assert.equal(m.CODE_LANE, "flash-next");
	const notice = m.ENV_NOTICES.join("\n");
	assert.ok(notice.includes('FADE_ORCHESTRATE_THINK_LANE="flash-next"'), notice);
	assert.ok(/planning runs on deepseek/.test(notice), notice);
});

test("the mirror poison: CODE_LANE=deepseek is refused; the coder stays on flash-next", async () => {
	const m = await fresh("li-code-" + Date.now(), { FADE_ORCHESTRATE_CODE_LANE: "deepseek" });
	assert.equal(m.CODE_LANE, "flash-next", "naming a thinking pack the coder collapses every lane");
	assert.equal(m.THINK_LANE, "deepseek");
	assert.ok(m.ENV_NOTICES.join("\n").includes('FADE_ORCHESTRATE_CODE_LANE="deepseek"'), m.ENV_NOTICES.join("\n"));
});

test("the advisor env: the coder's pack is refused, the planner's pack is honored, blank keeps hy4-flash", async () => {
	const coder = await fresh("li-adv-coder-" + Date.now(), { FADE_ORCHESTRATE_VERIFY_LANE: "flash-next" });
	assert.equal(coder.VERIFY_LANE, "hy4-flash", "the advisor is never the coder");
	assert.ok(coder.ENV_NOTICES.join("\n").includes('FADE_ORCHESTRATE_VERIFY_LANE="flash-next"'), coder.ENV_NOTICES.join("\n"));

	const planner = await fresh("li-adv-plan-" + Date.now(), { FADE_ORCHESTRATE_VERIFY_LANE: "deepseek" });
	assert.equal(planner.VERIFY_LANE, "deepseek", "advisor == planner is a lane-economy choice, honored");
	assert.equal(planner.ENV_NOTICES.length, 0, "a legal choice is not a refusal");

	const blank = await fresh("li-adv-blank-" + Date.now(), { FADE_ORCHESTRATE_VERIFY_LANE: "  " });
	assert.equal(blank.VERIFY_LANE, "hy4-flash", "a blank env is the documented default, not a lane");
});

test("the thinking set: the planner and the advisor think at high, the coder at low, strangers not at all", async () => {
	const m = await fresh("li-think-" + Date.now(), {});
	assert.equal(m.isThinkingLane(m.THINK_LANE), true);
	assert.equal(m.isThinkingLane(m.VERIFY_LANE), true);
	assert.equal(m.isThinkingLane(m.CODE_LANE), false, "the coder is not a thinking lane: the hand-back rule reads this");
	assert.equal(m.isThinkingLane("some-stranger"), false);
	assert.equal(m.THINKING[m.THINK_LANE], "high", "planning runs at :high");
	assert.equal(m.THINKING[m.VERIFY_LANE], "high", "verdicts run at :high");
	assert.equal(m.THINKING[m.CODE_LANE], "low", "coding runs at :low");
});

test("every env shape keeps the three lanes three", async () => {
	// The sweep the poison taught: whatever the operator's shell exports, the resolved lanes must
	// admit a swap — advisor ≠ coder and planner ≠ coder are the two collapses that make the loop
	// churn with zero thinking and zero lane moves.
	const shapes = [
		{},
		{ FADE_ORCHESTRATE_THINK_LANE: "flash-next" },
		{ FADE_ORCHESTRATE_CODE_LANE: "deepseek" },
		{ FADE_ORCHESTRATE_VERIFY_LANE: "flash-next" },
		{ FADE_ORCHESTRATE_VERIFY_LANE: "deepseek" },
		{ FADE_ORCHESTRATE_THINK_LANE: "hy3-max", FADE_ORCHESTRATE_VERIFY_LANE: "hy4-flash" },
		{ FADE_ORCHESTRATE_CODE_LANE: "custom-coder", FADE_ORCHESTRATE_VERIFY_LANE: "custom-coder" },
	];
	for (const shape of shapes) {
		const m = await fresh("li-sweep-" + Date.now() + "-" + JSON.stringify(shape), shape);
		assert.notEqual(m.THINK_LANE, m.CODE_LANE, `${JSON.stringify(shape)}: planning collapsed onto the coder`);
		assert.notEqual(m.VERIFY_LANE, m.CODE_LANE, `${JSON.stringify(shape)}: the advisor collapsed onto the coder`);
		assert.ok(m.THINKING[m.THINK_LANE], `${JSON.stringify(shape)}: the planning lane carries no thinking level`);
		assert.ok(m.THINKING[m.VERIFY_LANE], `${JSON.stringify(shape)}: the advisor lane carries no thinking level`);
		assert.equal(m.THINKING[m.CODE_LANE], "low", `${JSON.stringify(shape)}: the coder thinks at :low`);
	}
});

test("the start proof's window is the cold-load bound, not a hunch", async () => {
	const m = await fresh("li-wait-" + Date.now(), {});
	assert.equal(m.START_PROOF_WAIT_MS, 240_000, "a cold pack load plus the daemon's readiness window; it never kills a load in flight");
});
