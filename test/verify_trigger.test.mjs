/*
 * The verification trigger (`verifyTrigger` in router.ts): which tool call means "the thinking
 * lane answers this", and which means "coding resumed".
 *
 * This is the whole mechanism a plain session gets: no phase contract, no run, no /orchestrate.
 * The decision is pure, so it is pinned exactly — the lane move it causes is proven by
 * lane_command.test.mjs (resident → zero bytes, breaker → zero bytes, admitted → acquire/swap/
 * release with the served id proven).
 */
import "./env.mjs?suite=verify_trigger";
import { test } from "node:test";
import assert from "node:assert/strict";

const fresh = async (tag, env) => {
	for (const k of ["FADE_ORCHESTRATE_PROVIDER", "FADE_ORCHESTRATE_THINK_LANE", "FADE_ORCHESTRATE_CODE_LANE",
		"FADE_ORCHESTRATE_LANE_ON_VERIFY", "FADE_ORCHESTRATE_VERIFY_IN_OPS",
		"FADE_ORCHESTRATE_VERIFY_OUT_OPS", "FADE_ORCHESTRATE_VERIFY_AGENTS", "FADE_ORCHESTRATE_VERIFY_LANE"]) delete process.env[k];
	Object.assign(process.env, env);
	return await import(`../.test-build/router.mjs?case=${tag}`);
};

test("frontier report and review are verdict acts: the advisor lane answers", async () => {
	const m = await fresh("vt-in-" + Date.now(), { FADE_ORCHESTRATE_THINK_LANE: "deepseek", FADE_ORCHESTRATE_CODE_LANE: "flash-next", FADE_ORCHESTRATE_VERIFY_LANE: "hy4-flash" });
	for (const op of ["report", "review"]) {
		const t = m.verifyTrigger("frontier", { op });
		assert.equal(t.lane, "hy4-flash", `${op}: ${JSON.stringify(t)}`);
		assert.match(t.reason, /verdict|advisor/, t.reason);
	}
});

test("frontier intake and abort are coding: the code lane comes back", async () => {
	const m = await fresh("vt-out-" + Date.now(), { FADE_ORCHESTRATE_THINK_LANE: "deepseek", FADE_ORCHESTRATE_CODE_LANE: "flash-next" });
	for (const op of ["intake", "abort"]) {
		const t = m.verifyTrigger("frontier", { op });
		assert.equal(t.lane, "flash-next", `${op}: ${JSON.stringify(t)}`);
	}
});

test("a frontier op that is not a verdict act moves nothing", async () => {
	const m = await fresh("vt-none-" + Date.now(), {});
	for (const op of ["propose", "status"]) {
		const t = m.verifyTrigger("frontier", { op });
		assert.equal(t.lane, undefined, `${op}: ${JSON.stringify(t)}`);
	}
	assert.equal(m.verifyTrigger("frontier", {}).lane, undefined, "an op-less call moves nothing");
	assert.equal(m.verifyTrigger("bash", { command: "make test" }).lane, undefined, "a gate run is not a verdict act");
});

test("a task carrying a reviewer agent is verification; a coding worker is not", async () => {
	const m = await fresh("vt-task-" + Date.now(), { FADE_ORCHESTRATE_THINK_LANE: "deepseek", FADE_ORCHESTRATE_CODE_LANE: "flash-next", FADE_ORCHESTRATE_VERIFY_LANE: "hy4-flash" });
	assert.equal(m.verifyTrigger("task", { agent: "reviewer" }).lane, "hy4-flash");
	assert.equal(m.verifyTrigger("task", { agent: "reviewer:high" }).lane, "hy4-flash", "the effort suffix is stripped");
	assert.equal(m.verifyTrigger("task", { agent: "frontier-reviewer" }).lane, "hy4-flash");
	assert.equal(m.verifyTrigger("task", { list: [{ phase: "Verifying", items: [{ task: "check", agent: "task" }] }] }).lane, undefined, "a coding worker is not a verifier");
	const nested = m.verifyTrigger("task", { list: [{ phase: "Verifying", items: [{ task: "check", agent: "reviewer" }] }] });
	assert.equal(nested.lane, "hy4-flash", JSON.stringify(nested));
});

test("the env knobs move the boundaries, and off disables the mechanism", async () => {
	const off = await fresh("vt-off-" + Date.now(), { FADE_ORCHESTRATE_LANE_ON_VERIFY: "off" });
	assert.equal(off.verifyTrigger("frontier", { op: "report" }).lane, undefined);
	assert.match(off.verifyTrigger("frontier", { op: "report" }).none, /off/);

	const wide = await fresh("vt-wide-" + Date.now(), {
		FADE_ORCHESTRATE_THINK_LANE: "deepseek",
		FADE_ORCHESTRATE_CODE_LANE: "flash-next",
		FADE_ORCHESTRATE_VERIFY_LANE: "hy4-flash",
		FADE_ORCHESTRATE_VERIFY_IN_OPS: "report,review,status",
		FADE_ORCHESTRATE_VERIFY_AGENTS: "reviewer,frontier-reviewer,scout",
	});
	assert.equal(wide.verifyTrigger("frontier", { op: "status" }).lane, "hy4-flash", "an added op is a verdict act");
	assert.equal(wide.verifyTrigger("task", { agent: "scout" }).lane, "hy4-flash", "an added agent kind is verification");
});

test("the defaults match the box: provider basalt, thinking deepseek, coding flash-next", async () => {
	const m = await fresh("vt-defaults-" + Date.now(), {});
	assert.equal(m.PROVIDER, "basalt", "the provider must be the one that declares every lane alias");
	assert.equal(m.THINK_LANE, "deepseek");
	assert.equal(m.CODE_LANE, "flash-next");
	assert.equal(m.THINKING[m.THINK_LANE], "high", "the thinking lane runs at :high");
	assert.equal(m.THINKING[m.CODE_LANE], "low", "the coding lane runs at :low");
	assert.equal(m.VERIFY_LANE, "hy4-flash", "the advisor lane is its own pack: it is never the coder");
	// A verdict act with no env at all resolves to a pack the registry can name.
	const t = m.verifyTrigger("frontier", { op: "report" });
	assert.equal(t.lane, "hy4-flash", JSON.stringify(t));
});
