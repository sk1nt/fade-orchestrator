/**
 * The in-process lane call (thinklane.ts): the residency rule, the classes, and the ONE rule the
 * whole file exists for — **no load byte, on any path.**
 *
 * The cost this path avoids is a pack swap: `POST /v1/load` is non-additive, it unloads the resident
 * context (router.ts), and the recorded price is 13-25 s per direction for a 52.2 GiB / 242.1 GiB
 * pack. So the load-bearing assertions below are not "did it parse the answer" — they are:
 *   * a call naming a model the ROUTER does not hold is refused with ZERO bytes sent (a request
 *     naming it is what makes the router swap the lane), and
 *   * no call in any branch, success or failure, ever names `/v1/load`.
 * The endpoint is resolved from an injected `models.yml`, so a fictional plane answers deterministically
 * and no real router is touched; `resident` is injected so the residency rule is testable without a
 * router at all.
 */
import "./env.mjs?suite=thinklane";
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerText, askLane, probeThink, resolveAskSpec } from "../.test-build/thinklane.mjs";

/** The provider plane the rigs resolve against: the router's host, one server on its own port, and
 *  a lane whose key comes from a `!command` (the shape that 401s a completion and passes `/models`). */
const YML = `
providers:
  - id: strata-flash
    baseUrl: http://127.0.0.1:18014/v1
    api: openai-completions
    models:
      - id: flash-next
      - id: deepseek
  - id: basalt-deepseek
    baseUrl: http://127.0.0.1:18016/v1
    api: openai-completions
    models:
      - id: deepseek
  - id: ninfer-local
    baseUrl: http://127.0.0.1:18001/v1
    apiKey: "!printf secret-key"
    authHeader: true
    models:
      - id: coder-gpu1
models: []
`;

/** The fetch seam: records every URL and init, answers what the test names. */
const stub = (answers = { status: 200, body: { choices: [{ message: { content: "READY" } }] } }) => {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		if (answers.throw) throw answers.throw;
		const payload = typeof answers.body === "function" ? answers.body(url) : answers.body;
		return {
			status: answers.status ?? 200,
			ok: (answers.status ?? 200) < 400,
			json: async () => payload,
			text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
		};
	};
	return { calls, fetchImpl };
};

const completion = "http://127.0.0.1:18014/v1/chat/completions";

/** The rule the file is named for, checked on every path. */
const noLoadByte = (calls) => assert.ok(!calls.some((c) => c.url.includes("/v1/load")), `a load was issued: ${calls.map((c) => c.url).join(" ")}`);

test("the resident router lane answers in process, and the load endpoint is never touched", async () => {
	const { calls, fetchImpl } = stub();
	const r = await askLane("strata-flash/flash-next", "say READY", {}, { yml: YML, resident: "flash-next", fetchImpl });
	assert.equal(r.ok, true);
	assert.equal(r.text, "READY");
	assert.equal(r.cls, "ok");
	assert.equal(r.endpoint, completion);
	assert.deepEqual(calls.map((c) => c.url), [completion]);
	noLoadByte(calls);
});

test("a router entry that is NOT resident is refused with ZERO bytes sent", async () => {
	const { calls, fetchImpl } = stub();
	const r = await askLane("strata-flash/deepseek", "plan this", {}, { yml: YML, resident: "flash-next", fetchImpl });
	assert.equal(r.ok, false);
	assert.equal(r.cls, "lane_not_resident");
	assert.equal(r.text, "");
	assert.equal(calls.length, 0);
	assert.match(r.detail, /NOT the resident lane/);
	assert.match(r.detail, /flash-next/);
	assert.match(r.detail, /SWAPPING the lane/);
	assert.match(r.detail, /zero bytes/);
	noLoadByte(calls);
});

test("the residency reading is a measured act: the injected reading decides, and only the completion is sent", async () => {
	const { calls, fetchImpl } = stub();
	const r = await askLane("strata-flash/flash-next", "go", {}, { yml: YML, lanes: async () => "flash-next", fetchImpl });
	assert.equal(r.ok, true);
	assert.equal(r.text, "READY");
	assert.deepEqual(calls.map((c) => c.url), [completion]);
	noLoadByte(calls);
});

test("a reading naming NO loaded entry refuses — an unknown lane is not a free pass", async () => {
	const { calls, fetchImpl } = stub();
	const r = await askLane("strata-flash/flash-next", "go", {}, { yml: YML, lanes: async () => undefined, fetchImpl });
	assert.equal(r.ok, false);
	assert.equal(r.cls, "lane_not_resident");
	assert.match(r.detail, /resident unknown/);
	assert.equal(calls.length, 0);
	noLoadByte(calls);
});

test("an endpoint on its own port is served with no residency rule, and never reaches the router", async () => {
	const { calls, fetchImpl } = stub();
	const r = await askLane("basalt-deepseek/deepseek", "think", {}, { yml: YML, resident: "flash-next", fetchImpl });
	assert.equal(r.ok, true);
	assert.equal(r.endpoint, "http://127.0.0.1:18016/v1/chat/completions");
	assert.deepEqual(calls.map((c) => c.url), ["http://127.0.0.1:18016/v1/chat/completions"]);
	noLoadByte(calls);
});

test("http 500 is a named class carrying the status and the payload excerpt", async () => {
	const { calls, fetchImpl } = stub({ status: 500, body: { error: { message: "context is loading" } } });
	const r = await askLane("basalt-deepseek/deepseek", "think", {}, { yml: YML, fetchImpl });
	assert.equal(r.ok, false);
	assert.equal(r.cls, "http_error");
	assert.match(r.detail, /http 500/);
	assert.match(r.detail, /context is loading/);
	noLoadByte(calls);
});

test("a 200 with no completion text is a refusal, never an empty success", async () => {
	const { calls, fetchImpl } = stub({ body: { choices: [] } });
	const r = await askLane("basalt-deepseek/deepseek", "think", {}, { yml: YML, fetchImpl });
	assert.equal(r.ok, false);
	assert.equal(r.cls, "no_completion");
	assert.equal(r.text, "");
	assert.match(r.detail, /NO completion text/);
	noLoadByte(calls);
});

test("a dead endpoint is endpoint_unreachable and says nothing was loaded", async () => {
	const refused = new Error("connect ECONNREFUSED 127.0.0.1:18016");
	const { calls, fetchImpl } = stub({ throw: refused });
	const r = await askLane("basalt-deepseek/deepseek", "think", {}, { yml: YML, fetchImpl });
	assert.equal(r.ok, false);
	assert.equal(r.cls, "endpoint_unreachable");
	assert.match(r.detail, /ECONNREFUSED/);
	assert.match(r.detail, /nothing was loaded/);
	noLoadByte(calls);
});

test("a wedged lane is `timeout`, named as busy-or-loading, not a silent empty answer", async () => {
	const wedged = new Error("The operation was aborted due to timeout");
	wedged.name = "TimeoutError";
	const { calls, fetchImpl } = stub({ throw: wedged });
	const r = await askLane("basalt-deepseek/deepseek", "think", { timeoutMs: 5 }, { yml: YML, fetchImpl });
	assert.equal(r.ok, false);
	assert.equal(r.cls, "timeout");
	assert.match(r.detail, /answered no completion in/);
	assert.match(r.detail, /no load and no swap was issued/);
	noLoadByte(calls);
});

test("a `!command` key is RUN and sent as the bearer; the key text never lands in the URL", async () => {
	const { calls, fetchImpl } = stub();
	const r = await askLane("ninfer-local/coder-gpu1", "verify", {}, { yml: YML, fetchImpl, runShell: async () => ({ code: 0, out: "secret-key\n" }) });
	assert.equal(r.ok, true);
	const sent = calls[0].init;
	assert.equal(sent.headers.authorization, "Bearer secret-key");
	assert.ok(!calls.some((c) => c.url.includes("secret-key")));
	noLoadByte(calls);
});

test("a key command that refuses sends NO request and names the refusal", async () => {
	const { calls, fetchImpl } = stub();
	const r = await askLane("ninfer-local/coder-gpu1", "verify", {}, { yml: YML, fetchImpl, runShell: async () => ({ code: 1, out: "" }) });
	assert.equal(r.ok, false);
	assert.equal(r.cls, "endpoint_unreachable");
	assert.match(r.detail, /key command refused/);
	assert.equal(calls.length, 0);
});

test("the request carries the prompt, the token budget and the thinking level", async () => {
	const { calls, fetchImpl } = stub();
	await askLane("basalt-deepseek/deepseek", "answer in one word", { maxTokens: 512, thinking: "high" }, { yml: YML, fetchImpl });
	const body = JSON.parse(calls[0].init.body);
	assert.equal(body.model, "deepseek");
	assert.equal(body.max_tokens, 512);
	assert.equal(body.temperature, 0);
	assert.equal(body.stream, false);
	assert.equal(body.reasoning_effort, "high");
	assert.equal(body.messages.at(-1).role, "user");
	assert.equal(body.messages.at(-1).content, "answer in one word");
});

test("the verifier's env lever does NOT move the thinking lane's endpoint", async () => {
	const { calls, fetchImpl } = stub();
	const env = { FADE_ORCHESTRATE_VERIFIER_BASE_URL: "http://127.0.0.1:9999/v1", FADE_ORCHESTRATE_VERIFIER_API: "openai-completions" };
	const r = await askLane("strata-flash/flash-next", "go", {}, { yml: YML, resident: "flash-next", fetchImpl, env });
	assert.equal(r.endpoint, completion);
	assert.deepEqual(calls.map((c) => c.url), [completion]);
});

test("an unresolvable spec is named and sends nothing", async () => {
	const { calls, fetchImpl } = stub();
	const r = await askLane("ghost/lane", "go", {}, { yml: YML, resident: "flash-next", fetchImpl });
	assert.equal(r.ok, false);
	assert.equal(r.cls, "spec_unresolved");
	assert.match(r.detail, /ghost/);
	assert.equal(calls.length, 0);
});

test("the probe refuses a non-resident router entry WITHOUT probing", async () => {
	const { calls, fetchImpl } = stub();
	const r = await probeThink("strata-flash/deepseek", { yml: YML, resident: "flash-next", fetchImpl, env: {} });
	assert.equal(r.ok, false);
	assert.equal(r.skipped, undefined);
	assert.match(r.detail, /refused with zero bytes sent/);
	assert.equal(calls.length, 0);
});

test("the probe proves a resident entry by COMPLETION, then caches the reading", async () => {
	let clock = 1_000;
	const now = () => clock;
	const answers = (url) => (url.endsWith("/models") ? { data: [{ id: "lane-a" }] } : { choices: [{ message: { content: "pong" } }] });
	const { calls, fetchImpl } = stub({ body: answers });
	const yml = "providers:\n  - id: probe-a\n    baseUrl: http://127.0.0.1:18021/v1\n    api: openai-completions\n    models:\n      - id: lane-a\nmodels: []\n";
	const first = await probeThink("probe-a/lane-a", { yml, resident: "lane-a", fetchImpl, env: {}, now });
	assert.equal(first.ok, true, first.detail);
	const posts = calls.filter((c) => c.init?.method === "POST");
	assert.equal(posts.length, 1);
	assert.equal(JSON.parse(posts[0].init.body).max_tokens, 1);
	clock += 1_000;
	const second = await probeThink("probe-a/lane-a", { yml, resident: "lane-a", fetchImpl, env: {}, now });
	assert.equal(second, first);
	assert.equal(calls.length, 2);
});

test("probing switched off says so, and is never read as a pass", async () => {
	const { calls, fetchImpl } = stub();
	const r = await probeThink("strata-flash/flash-next", { yml: YML, resident: "flash-next", fetchImpl, env: { FADE_ORCHESTRATE_THINK_PROBE_CACHE_MS: "0" } });
	assert.equal(r.ok, true);
	assert.equal(r.skipped, true);
	assert.match(r.detail, /probing disabled/);
	assert.equal(calls.length, 0);
});

test("answerText reads the shapes the engines answer with, and counts reasoning", () => {
	assert.deepEqual(answerText("openai-completions", { choices: [{ message: { content: "hi", reasoning_content: "because" } }] }), { text: "hi", reasoning: 7 });
	assert.deepEqual(answerText("openai-completions", { choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] }), { text: "ab", reasoning: 0 });
	assert.deepEqual(answerText("anthropic-messages", { content: [{ type: "text", text: "anthropic says hi" }] }), { text: "anthropic says hi", reasoning: 0 });
	// The shape the box actually answers with at a 24-token budget on the thinking lane (measured on
	// :18014): a NULL content, a populated reasoning channel, and the engine naming why it stopped.
	assert.deepEqual(answerText("openai-completions", { choices: [{ message: { role: "assistant", content: null, reasoning_content: "thinking" }, finish_reason: "length" }] }), { text: "", reasoning: 8, finish: "length" });
	assert.deepEqual(answerText("openai-completions", null), { text: "", reasoning: 0 });
});

test("resolution reports the provider plane in words an operator can act on", () => {
	assert.equal(resolveAskSpec("basalt-deepseek/deepseek", { yml: YML }).spec.baseUrl, "http://127.0.0.1:18016/v1");
	assert.match(resolveAskSpec("strata-flash/nope", { yml: YML }).error, /advertises flash-next, deepseek, not nope/);
});
