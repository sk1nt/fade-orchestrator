#!/usr/bin/env node
// load_hostile.mjs — Y10: the PRE-UNLOAD GATE, driven by a hostile basalt `/health`.
//
// `POST /v1/load` is not additive: it unloads the resident context to make room for the next pack
// (flash-next 52.2 GiB, deepseek 120 GiB, 13-25 s each). So the decision is judged on the router's
// OWN health line before the byte is sent. This rig is the hostile half of that proof — every named
// class must produce ZERO `POST /v1/load` with the class in the returned detail — plus the healthy
// router loading exactly once, and the router that stops answering refusing by name.
//
// The router client reads `FADE_ORCHESTRATE_ROUTER`, the VRAM floor and the settle window at
// IMPORT, so the env is set here BEFORE the `import()` of the bundle, and the settle window is
// shrunk so the hung-context class is proved in milliseconds, not in the 120 s it takes live.
import assert from "node:assert/strict";
import { createServer } from "node:http";

let mode = "healthy";
let loads = 0;
const detail = [];

/** The health lines, keyed by the class each one names. `healthy` is the measured live shape. */
const HEALTH = {
	// curl 'http://127.0.0.1:18014/health' (2026-11-15): status ok, model, loaded, loading, percent
	// null, swap null — and NO VRAM fields, which is why an absent reading is never a zero.
	healthy: { status: "ok", max_context: 262144, model: "flash-next", images: true, api_key: false, loaded: true, loading: false, service: "basalt", percent: null, swap: null },
	error: { status: "error", model: "flash-next", loaded: true, loading: false, service: "basalt" },
	cuda_fatal: { status: "ok", state: "cuda_fatal", model: "flash-next", loaded: true, loading: false },
	zero_vram: { status: "ok", model: "flash-next", loaded: true, loading: false, vram_free_mib: 0, vram_total_mib: 131072 },
	low_vram: { status: "ok", model: "flash-next", loaded: true, loading: false, vram_free_mib: 1200, vram_total_mib: 131072 },
	negative_vram: { status: "ok", model: "flash-next", loaded: true, loading: false, vram: { free_mib: -3, total_mib: 131072 } },
	no_model: { status: "ok", model: "", loaded: true, loading: false },
	swapping: { status: "ok", model: "deepseek", loaded: true, loading: true, percent: 37, swap: { from: "deepseek", to: "flash-next", phase: "loading" } },
};

const server = createServer((req, res) => {
	const json = (code, body) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (req.url.startsWith("/health")) return json(200, HEALTH[mode]);
	if (req.url.startsWith("/v1/models")) {
		// The target lane is never the resident one: only then is a load the honest act.
		return json(200, { data: [{ id: "deepseek", status: { value: "loaded" } }, { id: "flash-next", status: { value: "offloaded" } }] });
	}
	if (req.url.startsWith("/metrics")) return json(200, {});
	if (req.url === "/v1/load" && req.method === "POST") {
		loads += 1;
		req.on("data", () => undefined);
		req.on("end", () => json(200, { ok: true, model: "flash-next" }));
		return;
	}
	res.writeHead(404);
	res.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
process.env.FADE_ORCHESTRATE_ROUTER = `http://127.0.0.1:${port}`;
process.env.FADE_ORCHESTRATE_VRAM_MIN_FREE_MIB = "4096";
process.env.FADE_ORCHESTRATE_SETTLE_POLL_MS = "20";
process.env.FADE_ORCHESTRATE_SETTLE_MAX_MS = "60";

const { loadLane, serveVerdict, VRAM_MIN_FREE_MIB } = await import("../.test-build/router.mjs");

assert.equal(VRAM_MIN_FREE_MIB, 4096, "the VRAM floor is the operator's lever");

// -- the pure verdict: the classes, named -------------------------------------------------------
assert.equal(serveVerdict(undefined).serve, false, "an unreachable router never serves");
assert.ok(serveVerdict(undefined).reason.includes("unreachable"), serveVerdict(undefined).reason);
assert.equal(serveVerdict(HEALTH.healthy).serve, true, "the measured live health line serves");
assert.ok(serveVerdict(HEALTH.healthy).reason.includes("flash-next"), serveVerdict(HEALTH.healthy).reason);
// No VRAM fields on the live build: absence is named, never read as a zero.
assert.ok(serveVerdict(HEALTH.healthy).reason.includes("VRAM not reported"), serveVerdict(HEALTH.healthy).reason);

// -- the gate: a hostile health line issues ZERO loads ------------------------------------------
const HOSTILE = [
	["error", 'reports "error"'],
	["cuda_fatal", 'reports "cuda_fatal"'],
	["zero_vram", "zero free VRAM"],
	["low_vram", "under the 4096 MiB pack floor"],
	["negative_vram", "zero free VRAM"],
	["no_model", "names no model"],
	["swapping", "swap in flight"],
];

for (const [name, expect] of HOSTILE) {
	mode = name;
	const before = loads;
	const r = await loadLane("flash-next");
	detail.push(`${name}: ${r.detail}`);
	assert.equal(r.ok, false, `${name}: the gate must refuse (${r.detail})`);
	assert.ok(r.detail.includes("refused pre-unload"), `${name}: the refusal must be named as the gate (${r.detail})`);
	assert.ok(r.detail.includes(expect), `${name}: the reason must name "${expect}" — got ${r.detail}`);
	assert.equal(loads - before, 0, `${name}: ZERO POST /v1/load into a context that cannot serve`);
}

// -- the healthy router still loads, exactly once -----------------------------------------------
mode = "healthy";
{
	const before = loads;
	const r = await loadLane("flash-next");
	assert.equal(r.ok, true, `a healthy router must load (${r.detail})`);
	assert.equal(loads - before, 1, `a healthy router loads exactly once (got ${loads - before})`);
}

// -- the router that stops answering: refused by name, and no byte sent -------------------------
await new Promise((resolve) => server.close(resolve));
{
	const before = loads;
	const r = await loadLane("flash-next");
	assert.equal(r.ok, false, `an unreachable router must be refused (${r.detail})`);
	assert.ok(r.detail.includes("unreachable"), `the class must be named — got ${r.detail}`);
	assert.equal(loads - before, 0, "an unreachable router sees ZERO POST /v1/load");
}

console.log("load hostile rig: all checks pass");
for (const d of detail) console.log(`  ${d}`);
