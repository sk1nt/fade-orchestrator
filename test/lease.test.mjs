/**
 * The DURABLE LOAD (lane lease) client.
 *
 * The defect this ride kills: the basalt router swapped the resident lane out the moment any
 * queued request named a different model, so a DS4 advisory turn died mid-flight into flash-next
 * (journal: `swap: flash-next ready in 16.4 s`, then `(1 waiting)`). The router now honors a
 * lease — `POST /v1/load {"lease": true}` pins the lane and refuses foreign requests 409 — and
 * lands its default lane on `{"lease": false}`. These tests pin the plugin's half: the exact
 * bytes on the wire, and that a release is best-effort (a dead router must never take a run's
 * end down with it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";

const built = new URL("../.test-build/router.mjs", import.meta.url);
assert.ok(existsSync(built), "run `node test/build.mjs` first (npm test builds it)");

/** A stub router: records every POST /v1/load body; /health answers with the current resident. */
function startStubRouter() {
	const state = { resident: "flash-next", bodies: [], healthStatus: 200, killNextLoad: false, busySwap: false };
	const server = http.createServer((req, res) => {
		if (req.method === "GET" && req.url === "/health") {
			res.writeHead(state.healthStatus, { "content-type": "application/json" });
			res.end(JSON.stringify(state.busySwap
				? { status: "ok", loaded: true, model: state.resident, loading: true, swap: { from: "deepseek", to: state.resident, phase: "loading" } }
				: { status: "ok", loaded: true, model: state.resident, loading: false, vram: { free_mib: 30000 } }));
			return;
		}
		if (req.method === "GET" && req.url === "/v1/models") {
			const ids = ["flash-next", "deepseek"];
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: ids.map((id) => ({ id, status: { value: id === state.resident ? "loaded" : "off" } })) }));
			return;
		}
		if (req.method === "POST" && req.url === "/v1/load") {
			if (state.killNextLoad) {
				state.killNextLoad = false;
				req.destroy(); // the dead-router class: the connection dies mid-request
				return;
			}
			let raw = "";
			req.on("data", (c) => (raw += c));
			req.on("end", () => {
				const body = JSON.parse(raw);
				state.bodies.push(body);
				if (state.healthStatus !== 200) {
					res.writeHead(500, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "stub refuses" }));
					return;
				}
				if (body.lease === true) state.resident = body.model;
				if (body.lease === false) state.resident = "flash-next";
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, lease: body.lease === true ? { svc: body.model, owner: body.owner ?? null } : null }));
			});
			return;
		}
		res.writeHead(404);
		res.end();
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` });
		});
	});
}

const stub = await startStubRouter();
process.env.FADE_ORCHESTRATE_ROUTER = stub.url;
// Shrink the settle window BEFORE the import: these consts are read at module load, and the
// busy-swap test must grade in milliseconds, not the 120 s default.
process.env.FADE_ORCHESTRATE_SETTLE_POLL_MS = "5";
process.env.FADE_ORCHESTRATE_SETTLE_MAX_MS = "20";
const { loadLane, releaseLease, serveVerdict } = await import(built.href);

test("loadLane without lease sends the bare model byte — no lease fields leak into a plain load", async () => {
	const r = await loadLane("deepseek");
	assert.ok(r.ok, r.detail);
	const body = stub.state.bodies.at(-1);
	assert.equal(body.model, "deepseek");
	assert.ok(!("lease" in body) && !("owner" in body), `plain load must not carry lease fields: ${JSON.stringify(body)}`);
});

test("loadLane with lease sends {lease:true, owner} — the durable-load handover the router honors", async () => {
	stub.state.resident = "flash-next";
	const r = await loadLane("deepseek", { lease: true });
	assert.ok(r.ok, r.detail);
	const body = stub.state.bodies.at(-1);
	assert.deepEqual(body, { model: "deepseek", lease: true, owner: "fade_orchestrate" });
	assert.equal(stub.state.resident, "deepseek", "the stub records the lease handover as a resident change");
});

test("the resident lane is never reloaded, leased or not — no byte is sent", async () => {
	stub.state.resident = "deepseek";
	const before = stub.state.bodies.length;
	const r = await loadLane("deepseek", { lease: true });
	assert.ok(r.ok, r.detail);
	assert.match(r.detail, /already resident/);
	assert.equal(stub.state.bodies.length, before, "a resident lane issues no POST /v1/load");
});

test("releaseLease sends {lease:false} and lands the default lane", async () => {
	const r = await releaseLease("deepseek");
	assert.ok(r.ok, r.detail);
	const body = stub.state.bodies.at(-1);
	assert.deepEqual(body, { model: "deepseek", lease: false });
	assert.equal(stub.state.resident, "flash-next", "release lands the router's default lane");
});

test("releaseLease is best-effort: a 500 from the router answers ok:false, never a throw", async () => {
	stub.state.healthStatus = 500;
	try {
		const r = await releaseLease("deepseek");
		assert.equal(r.ok, false);
		assert.match(r.detail, /http 500/);
	} finally {
		stub.state.healthStatus = 200;
	}
});

test("releaseLease against a dead router answers ok:false, never a throw — a run's end survives", async () => {
	stub.state.killNextLoad = true;
	const r = await releaseLease("deepseek");
	assert.equal(r.ok, false);
});

test("the pre-unload gate refuses a leased load while a swap is in flight — no byte to a busy router", async () => {
	// A `loading: true` health line must stop the load BEFORE the POST: the lease handover is the
	// same swap, and a queued ping-pong is exactly what the lease exists to end.
	const line = { status: "ok", loaded: true, model: "flash-next", loading: true, swap: { from: "deepseek", to: "flash-next" } };
	const v = serveVerdict(line);
	assert.equal(v.serve, false);
	assert.match(v.reason, /swap in flight/);
	stub.state.busySwap = true;
	stub.state.resident = "flash-next";
	const before = stub.state.bodies.length;
	try {
		const r = await loadLane("deepseek", { lease: true });
		assert.equal(r.ok, false);
		assert.match(r.detail, /refused pre-unload.*swap in flight/);
		assert.equal(stub.state.bodies.length, before, "the gate must refuse before POST /v1/load");
	} finally {
		stub.state.busySwap = false;
	}
});

test("teardown", async () => {
	await new Promise((r) => stub.server.close(r));
});
