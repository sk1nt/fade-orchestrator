/**
 * Red-gate triage: the prompt, the envelope decode, and the boundaries.
 *
 * The load-bearing tests are the boundaries, not the prose: the call is TOOL-LESS (the prompt
 * carries the gate's own rows, so an advisory agent never edits the tree the coder is repairing),
 * every failure path returns an EMPTY note (a missing binary, a timeout, a cancelled turn, a
 * non-JSON answer — the gate briefing must ship exactly as it did before this feature), and stdout
 * with a banner before the JSON still decodes, because the CLI's progress output is not under
 * anyone's control.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAnswer, gateTriage, triageEnabled, triageLine, triagePrompt } from "../.test-build/triage.mjs";

const row = (over = {}) => ({ cmd: "npm test", expected: "exit 0", ok: false, tail: "AssertionError: 4 !== 9", ...over });

test("the prompt carries the gate's own rows and forbids a guess", () => {
	const p = triagePrompt([row(), row({ cmd: "bash check.sh", expected: "fails: the parser rejects the flag", want: "nonzero", tail: "x".repeat(5000) })]);
	assert.ok(p.includes("npm test") && p.includes("exit 0") && p.includes("AssertionError: 4 !== 9"));
	assert.ok(p.includes("declared: nonzero"), "a declared-failure row says so");
	assert.ok(p.includes("cause not determinable from the tails"), "the honest answer is a nameable option");
	assert.ok(p.includes("ONE command"), "the answer is a hypothesis plus a check");
	assert.ok(!p.includes("x".repeat(1000)), "a tail is TRUNCATED, not pasted whole");
});

test("the decode survives a banner before the JSON, and refuses everything else", () => {
	const banner = decodeAnswer(`Grok Build 0.1 (session 42)\n{"text":"cause: the flag is gone","stopReason":"end_turn","usage":{"input_tokens":6200}}`);
	assert.equal(banner.text, "cause: the flag is gone");

	const collapsed = decodeAnswer(`{"text":"line one\\nline two\\tthree","stopReason":"end_turn"}`);
	assert.equal(collapsed.text, "line one line two three", "one briefing line, no embedded newlines");

	const cut = decodeAnswer(`{"text":"${"y".repeat(900)}","stopReason":"end_turn"}`);
	assert.ok(cut.text.length <= 400, "the advisory is bounded, whatever the CLI says");

	assert.match(decodeAnswer("").why, /printed nothing/);
	assert.match(decodeAnswer("plain prose, no JSON").why, /did not answer JSON/);
	assert.match(decodeAnswer(`{"stopReason":"cancelled"}`).why, /stopReason cancelled/, "a cancelled turn is NOT a cause");
	assert.match(decodeAnswer(`{"text":"   ","stopReason":"end_turn"}`).why, /no text/);
});

test("the call is tool-less, one turn, bounded, and answered from the gate's text alone", async () => {
	const seen = [];
	const r = await gateTriage([row()], "/repo/under/repair", {
		env: {},
		runCli: async (args, cwd, timeoutMs) => {
			seen.push({ args, cwd, timeoutMs });
			return { code: 0, out: JSON.stringify({ text: "cause: the flag is gone", stopReason: "end_turn" }) };
		},
	});
	assert.equal(r.note, "cause: the flag is gone");
	assert.equal(seen[0].cwd, "/repo/under/repair", "the CLI runs in the run's repo, not the plugin's");
	assert.ok(seen[0].args.includes("--disallowed-tools") && seen[0].args[seen[0].args.indexOf("--disallowed-tools") + 1] === "*", "no tools: it cannot edit the tree");
	assert.ok(seen[0].args.includes("--max-turns") && seen[0].args[seen[0].args.indexOf("--max-turns") + 1] === "1");
	assert.ok(seen[0].args.includes("--output-format"));
	assert.ok(seen[0].timeoutMs > 0);
	assert.ok(triageLine(r).includes("no authority"), "the line says what it is not");
});

test("every failure path returns an empty note, never a throw", async () => {
	const missing = await gateTriage([row()], "/repo", { env: {}, runCli: async () => { throw new Error("spawn grok ENOENT"); } });
	assert.equal(missing.note, "");
	assert.match(missing.why, /ENOENT/);

	const cancelled = await gateTriage([row()], "/repo", { env: {}, runCli: async () => ({ code: 0, out: JSON.stringify({ stopReason: "cancelled" }) }) });
	assert.equal(cancelled.note, "");
	assert.match(cancelled.why, /cancelled/);

	const empty = await gateTriage([], "/repo", { env: {}, runCli: async () => ({ code: 0, out: "{}" }) });
	assert.equal(empty.note, "");
	assert.match(empty.why, /no failing rows/, "a green gate asks the CLI nothing at all");

	const off = await gateTriage([row()], "/repo", { env: { FADE_ORCHESTRATE_GATE_TRIAGE: "0" }, runCli: async () => { throw new Error("must not spawn"); } });
	assert.equal(off.note, "");
	assert.equal(off.skipped, true, "disabled is a named state, never an empty note read as a failed call");
	assert.equal(triageEnabled({ FADE_ORCHESTRATE_GATE_TRIAGE: "0" }), false);
	assert.equal(triageEnabled({}), true);
});

test("an empty note produces NO line — the briefing ships as it did before", () => {
	assert.equal(triageLine({ note: "", ms: 12, why: "the CLI printed nothing" }), "");
	assert.equal(triageLine({ note: "", ms: 0, skipped: true }), "");
});
