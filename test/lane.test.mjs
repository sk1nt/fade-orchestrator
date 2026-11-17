/**
 * The claim-time lane guard's parts: the `models.yml` scan, the spec resolution, the completion
 * probe, and the cache.
 *
 * The load-bearing tests are the ones the desk's irreversibility depends on. A `GET`-shaped reading
 * is NOT a pass: a provider whose key comes from `apiKey: "!bash -lc …"` answers `/v1/models` and
 * 401s a completion, and the route decision is taken BEFORE `claimBatch` — because a claim cannot
 * be undone (`openRequests` drops stamped requests at desk.ts:214 and nothing clears the stamp), a
 * batch claimed against a dead lane is OWED for the whole run. So every failure below must answer
 * `ok: false`, and no test may accept a pass the stub did not actually serve.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProviderBlocks, probeLane, probeVerifierLane, resolveLaneSpec, splitSpec, substituteEnv } from "../.test-build/lane.mjs";

const YML = `
# the operator's providers
providers:
  - id: ninfer-local
    name: NInfer (local GPU)
    baseUrl: http://127.0.0.1:18001/v1
    api: openai-completions
    apiKey: "!bash -lc 'source ~/.config/fade/ninfer-backend.env && printf %s \\"\${NINFER_API_KEY:-}\\"'"
    authHeader: true
    maxTokensField: max_tokens
    headers:
      X-Api-Key: \${NINFER_API_KEY}
    models:
      - id: coder-gpu
        name: coder-gpu
        contextWindow: 262144
      - id: coder-gpu1
        name: coder-gpu1
  - id: openai-codex
    baseUrl: https://chatgpt.com/backend-api/codex
    apiKey: "external_chatgpt_oauth"
    models:
      - id: gpt-5.6-luna
        name: gpt-5.6-luna
models: []
`;

test("the scan reads the fields a probe needs, quotes and comments included", () => {
	const blocks = parseProviderBlocks(YML);
	assert.equal(blocks.length, 2);
	const n = blocks[0];
	assert.equal(n.id, "ninfer-local");
	assert.equal(n.baseUrl, "http://127.0.0.1:18001/v1");
	assert.equal(n.api, "openai-completions");
	assert.equal(n.authHeader, true);
	assert.ok(n.apiKey?.startsWith("!bash -lc "), `the key is a command: ${n.apiKey}`);
	assert.ok(n.apiKey?.includes("printf"), "the command prints the key");
	assert.deepEqual(n.models, ["coder-gpu", "coder-gpu1"]);
	assert.equal(n.headers["X-Api-Key"], "${NINFER_API_KEY}");
	assert.deepEqual(blocks[1].models, ["gpt-5.6-luna"]);
	assert.notEqual(blocks[1].authHeader, true, "absent is absent, never a default true");
});

test("the spec resolves the provider, the model, and the key COMMAND (not its text)", () => {
	const r = resolveLaneSpec("ninfer-local/coder-gpu1", YML, { NINFER_API_KEY: "k" });
	assert.ok("spec" in r, r.error);
	assert.equal(r.spec.baseUrl, "http://127.0.0.1:18001/v1");
	assert.equal(r.spec.model, "coder-gpu1");
	assert.equal(r.spec.apiKey, undefined, "a !command key is never sent as a literal");
	assert.ok(r.spec.apiKeyCommand?.includes("source ~/.config/fade/ninfer-backend.env"));
	assert.equal(r.spec.authHeader, true);
	assert.equal(r.spec.source, "models.yml");
	assert.deepEqual(splitSpec("ninfer-local/coder-gpu1"), { provider: "ninfer-local", model: "coder-gpu1" });
	assert.deepEqual(splitSpec("coder-gpu1"), { provider: "", model: "coder-gpu1" });
});

test("an unresolvable spec is an error, never a pass", () => {
	assert.match(resolveLaneSpec("ghost/coder-gpu1", YML, {}).error, /not in models\.yml/);
	assert.match(resolveLaneSpec("ninfer-local/coder-gpu9", YML, {}).error, /not coder-gpu9/);
	assert.match(resolveLaneSpec("ninfer-local/coder-gpu1", null, {}).error, /cannot be resolved/);
});

test("the env override wins and strips the trailing slash", () => {
	const r = resolveLaneSpec("anything/lane-x", null, { FADE_ORCHESTRATE_VERIFIER_BASE_URL: "http://127.0.0.1:9999/v1/", FADE_ORCHESTRATE_VERIFIER_API_KEY: "k" });
	assert.equal(r.spec.baseUrl, "http://127.0.0.1:9999/v1");
	assert.equal(r.spec.apiKey, "k");
	assert.equal(r.spec.source, "env");
});

test("a header whose variable is unset does not resolve to an empty credential", () => {
	assert.equal(substituteEnv("${A}-${B}", { A: "x", B: "y" }), "x-y");
	assert.equal(substituteEnv("${A}", { A: "" }), undefined, "an empty variable is not a key");
	assert.equal(substituteEnv("$A", { A: "x" }), "x");
});

const BASE = "http://127.0.0.1:9999/v1";
const specOf = (over = {}) => ({
	spec: "stub/lane-x", provider: "stub", model: "lane-x", baseUrl: BASE, api: "openai-completions",
	apiKey: "k", authHeader: true, headers: {}, source: "env", ...over,
});

/** A fetch that records every request; a route value that is an Error throws. */
const fetcher = (routes, calls) => async (url, init) => {
	calls.push({ url, init });
	const r = routes[url] ?? { status: 404, body: { error: { message: `no stub for ${url}` } } };
	if (r instanceof Error) throw r;
	return { status: r.status, ok: r.status < 300, json: async () => r.body, text: async () => JSON.stringify(r.body) };
};
const okModels = (ids) => ({ status: 200, body: { data: ids.map((id) => ({ id })) } });
const okCompletion = { status: 200, body: { choices: [{ message: { role: "assistant", content: "ok" } }] } };

test("the probe sends ONE 1-token completion, through the lane's own auth path", async () => {
	const calls = [];
	const r = await probeLane(specOf(), { fetchImpl: fetcher({ [`${BASE}/models`]: okModels(["lane-x"]), [`${BASE}/chat/completions`]: okCompletion }, calls) });
	assert.equal(r.ok, true, r.detail);
	const post = calls.find((c) => c.url === `${BASE}/chat/completions`);
	assert.equal(post.init.method, "POST");
	assert.equal(post.init.headers.authorization, "Bearer k");
	const sent = JSON.parse(post.init.body);
	assert.equal(sent.model, "lane-x");
	assert.equal(sent.max_tokens, 1, "a probe never generates a sentence");
	assert.match(post.init.headers["content-type"], /application\/json/);
});

test("a 200 on /v1/models plus a 401 completion is a REFUSAL — the GET-only trap", async () => {
	const calls = [];
	const r = await probeLane(specOf(), {
		fetchImpl: fetcher({ [`${BASE}/models`]: okModels(["lane-x"]), [`${BASE}/chat/completions`]: { status: 401, body: { error: { message: "missing api key" } } } }, calls),
	});
	assert.equal(r.ok, false);
	assert.match(r.detail, /http 401/);
	assert.match(r.detail, /missing api key/);
	assert.match(r.detail, /lane-x/, "the line names the model that was refused");
});

test("a pinned id the server does not advertise is refused without paying a completion", async () => {
	const calls = [];
	const r = await probeLane(specOf({ model: "lane-z" }), { fetchImpl: fetcher({ [`${BASE}/models`]: okModels(["lane-x"]) }, calls) });
	assert.equal(r.ok, false);
	assert.match(r.detail, /not lane-z/);
	assert.equal(calls.filter((c) => c.url.endsWith("/chat/completions")).length, 0);
});

test("an unreachable lane, a 200 with no choices, and a dead key command all refuse", async () => {
	const dead = await probeLane(specOf(), { fetchImpl: fetcher({ [`${BASE}/chat/completions`]: new Error("ECONNREFUSED") }, []) });
	assert.equal(dead.ok, false);
	assert.match(dead.detail, /refused: ECONNREFUSED/);

	const empty = await probeLane(specOf(), { fetchImpl: fetcher({ [`${BASE}/models`]: okModels(["lane-x"]), [`${BASE}/chat/completions`]: { status: 200, body: { choices: [] } } }, []) });
	assert.equal(empty.ok, false, "an empty choices array is not an answer");
	assert.match(empty.detail, /no completion/);

	const noKey = await probeLane(specOf({ apiKey: undefined, apiKeyCommand: "false" }), { fetchImpl: fetcher({}, []), runShell: async () => ({ code: 1, out: "" }) });
	assert.equal(noKey.ok, false);
	assert.match(noKey.detail, /exited 1/);

	const silentKey = await probeLane(specOf({ apiKey: undefined, apiKeyCommand: "true" }), { fetchImpl: fetcher({}, []), runShell: async () => ({ code: 0, out: "  " }) });
	assert.equal(silentKey.ok, false, "a key command that prints nothing is not a key");

	const headerCalls = [];
	const noHeader = await probeLane(specOf({ headers: { "X-Api-Key": "${NOT_SET}" } }), {
		fetchImpl: fetcher({ [`${BASE}/chat/completions`]: { status: 401, body: { error: { message: "api key required" } } } }, headerCalls),
		env: {},
	});
	assert.equal(noHeader.ok, false);
	assert.match(noHeader.detail, /sent without X-Api-Key/, "an unset variable is REPORTED, never sent as an empty credential");
	assert.equal(headerCalls.filter((c) => c.url.endsWith("/chat/completions")).length, 1, "the completion still decides, so a lane that works is not refused on a cosmetic");
});

test("the reading is CACHED for the window, then re-probed", async () => {
	let t = 1_000_000;
	const calls = [];
	const env = { FADE_ORCHESTRATE_VERIFIER_MODEL: "cachetest/lane-x", FADE_ORCHESTRATE_VERIFIER_BASE_URL: BASE, FADE_ORCHESTRATE_VERIFIER_API_KEY: "k", FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS: "60000" };
	const deps = { fetchImpl: fetcher({ [`${BASE}/models`]: okModels(["lane-x"]), [`${BASE}/chat/completions`]: okCompletion }, calls), now: () => t, env };
	const first = await probeVerifierLane(deps);
	assert.equal(first.ok, true, first.detail);
	t += 59_000;
	const cached = await probeVerifierLane(deps);
	assert.equal(cached.at, first.at, "a cache hit carries the ORIGINAL reading time");
	assert.equal(calls.filter((c) => c.url.endsWith("/chat/completions")).length, 1, "the window pays one probe, not one per batch");
	t += 2_000;
	const fresh = await probeVerifierLane(deps);
	assert.equal(calls.filter((c) => c.url.endsWith("/chat/completions")).length, 2, "past the window the lane is proved again");
	assert.ok(fresh.at > first.at);
});

test("a disabled probe says disabled — a caller can never read it as a proved lane", async () => {
	const calls = [];
	const r = await probeVerifierLane({
		fetchImpl: fetcher({}, calls),
		env: { FADE_ORCHESTRATE_VERIFIER_MODEL: "disabled/lane-x", FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS: "0" },
	});
	assert.equal(r.skipped, true);
	assert.match(r.detail, /probing disabled/);
	assert.equal(calls.length, 0);
});

/**
 * The operator's file declares providers as a MAPPING (`ninfer-local:` is a key), not the sequence
 * form. A scan that reads only sequences reports every provider as missing, and the guard turns
 * that into a false refusal — the swap price lands on every churn batch, on a box whose lane is
 * fine. So the mapping form is the primary fixture, `compat:` keys and a model's own FIELDS
 * included, because a scan that reads them as ids reports the lane as advertising nonsense.
 */
const MAPPING_YML = `
providers:
  ninfer-local:
    baseUrl: http://127.0.0.1:8002/v1
    api: openai-completions
    apiKey: "!bash -lc 'source \\"$HOME/.config/fade/ninfer-backend.env\\" && printf %s \\"$FADE_NINFER_API_KEY\\"'"
    authHeader: true
    compat:
      maxTokensField: max_tokens
      supportsStrictMode: false
      extraBody:
        prompt_cache_options:
          mode: implicit
    models:
      - id: coder-gpu1
        name: coder-gpu1 (NInfer GPU1)
        contextWindow: 262144
        maxTokens: 4096
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}
  strata-flash:
    baseUrl: http://127.0.0.1:18014/v1
    models:
      - id: flash-next
models: []
`;

test("the scan reads the MAPPING form the operator's file actually uses", () => {
	const blocks = parseProviderBlocks(MAPPING_YML);
	assert.deepEqual(blocks.map((b) => b.id), ["ninfer-local", "strata-flash"]);
	const n = blocks[0];
	assert.equal(n.baseUrl, "http://127.0.0.1:8002/v1");
	assert.equal(n.authHeader, true);
	assert.ok(n.apiKey?.startsWith("!bash -lc "), `the key is a command: ${n.apiKey}`);
	assert.deepEqual(n.models, ["coder-gpu1"], "compat's keys and a model's fields are not advertised ids");
	const r = resolveLaneSpec("ninfer-local/coder-gpu1", MAPPING_YML, {});
	assert.ok("spec" in r, r.error);
	assert.equal(r.spec.baseUrl, "http://127.0.0.1:8002/v1");
	assert.equal(r.spec.apiKey, undefined, "the command key is run, never sent as text");
	assert.ok(r.spec.apiKeyCommand?.includes("FADE_NINFER_API_KEY"));
});

test("a ROUTER entry is refused WITHOUT a request: probing it pays the swap the route avoids", async () => {
	const calls = [];
	const r = await probeVerifierLane({
		fetchImpl: fetcher({}, calls),
		env: { FADE_ORCHESTRATE_VERIFIER_MODEL: "strata-flash/flash-next", FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS: "60000" },
	});
	assert.equal(r.ok, false);
	assert.match(r.detail, /ROUTER entry/);
	assert.equal(calls.length, 0, "no probe, so no `/v1/load`, so the resident lane stays resident");
});
