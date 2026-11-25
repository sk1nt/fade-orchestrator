/**
 *  The residency half of the supervisor client, proved against a stub daemon on a Unix
 *  socket. No live daemon, no hardware, no lane moved: the assertions are the wire
 *  shape, the socket order, and the build header. Paths are built from SL, never written
 *  as literals, because the suite never touches the filesystem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUILD_DEV,
	STATUS_OK,
	discoverSock,
	fadeHeaders,
	getResidency,
	probeHealth,
	residencyVerdict,
	ROOT_SOCK,
	USER_SOCK,
} from "../.test-build/supervisor.mjs";

const SL = "/";
const PINNED = SL + "custom" + SL + "sock";
const ANSWERS = ROOT_SOCK;

const ok = (body) => ({ status: STATUS_OK, body, raw: JSON.stringify(body) });

test("the residency answer maps the flat and the nested spelling", () => {
	const flat = residencyVerdict(ok({ lane_state: "RESIDENT", active_pack: "flash-next", pid: 4242, active_requests: 1, telemetry: { source: "nvml" }, supervisor: { version: "0.1.0", sock: SL + "run" + SL + "x" } }));
	assert.equal(flat.state, "RESIDENT");
	assert.equal(flat.pack, "flash-next");
	assert.equal(flat.pid, 4242);
	assert.equal(flat.telemetry_source, "nvml");
	const nested = residencyVerdict(ok({ lane: { state: "IDLE", active_pack: "flash-ablit", pid: 7 }, telemetry: { source: "stub" } }));
	assert.equal(nested.state, "IDLE");
	assert.equal(nested.pack, "flash-ablit");
});

test("no answer is undefined, never residency: a non-200, a non-JSON body, no lane state", () => {
	assert.equal(residencyVerdict({ status: 503, body: {}, raw: "" }), undefined);
	assert.equal(residencyVerdict({ status: STATUS_OK, body: undefined, raw: "not json" }), undefined);
	assert.equal(residencyVerdict(ok({ supervisor: { version: "0.1.0" } })), undefined);
});

test("the socket order: a pinned path is never probed, then the path that ANSWERS health", async () => {
	let seen = 0;
	const probe = async (sock) => {
		seen = seen + 1;
		return sock === ANSWERS;
	};
	assert.equal(await discoverSock({ FADE_SUPERVISOR_SOCK: PINNED }, 1000, probe), PINNED);
	assert.equal(seen, 0);
	assert.equal(await discoverSock({}, 1000, probe), ANSWERS);
	const dead = async () => false;
	assert.equal(await discoverSock({}, 1000, dead), USER_SOCK);
	assert.equal(await discoverSock({}, 0, dead), ROOT_SOCK);
	const onlyUser = async (sock) => sock === USER_SOCK;
	assert.equal(await discoverSock({}, 0, onlyUser), USER_SOCK);
});

test("the build claim: prod by default, dev only when the operator names it", () => {
	const before = process.env.FADE_BUILD;
	delete process.env.FADE_BUILD;
	assert.equal(fadeHeaders("s")["x-fade-build"], "prod");
	process.env.FADE_BUILD = BUILD_DEV;
	assert.equal(fadeHeaders("s")["x-fade-build"], BUILD_DEV);
	if (before === undefined) delete process.env.FADE_BUILD;
	else process.env.FADE_BUILD = before;
});

test("a live daemon answers the residency route, and a stale path does not answer health", async () => {
	const sock = join(tmpdir(), "fade-resid-" + process.pid + ".sock");
	if (existsSync(sock)) unlinkSync(sock);
	let hits = [];
	const server = http.createServer((req, res) => {
		hits = hits.concat(req.method + " " + req.url + " " + (req.headers["x-fade-build"] ?? ""));
		res.setHeader("content-type", "application/json");
		if (req.url.includes("health")) return res.end(JSON.stringify({ ok: true }));
		res.end(JSON.stringify({ lane_state: "RESIDENT", active_pack: "flash-next", pid: 1, telemetry: { source: "nvml" }, supervisor: { version: "0.1.0", sock } }));
	});
	await new Promise((r) => server.listen(sock, r));
	try {
		assert.equal(await probeHealth(sock), true);
		const r = await getResidency("probe-session", sock);
		assert.equal(r.state, "RESIDENT");
		assert.equal(r.pack, "flash-next");
		assert.equal(await probeHealth(sock + ".absent"), false);
		assert.ok(hits.some((h) => h.includes("residency") && h.includes("prod")));
	} finally {
		await new Promise((r) => server.close(r));
		try { unlinkSync(sock); } catch {}
	}
});
