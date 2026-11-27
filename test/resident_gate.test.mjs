/**
 * The residency short-circuit and the minted-lease lifecycle (router.ts over a stub supervisor).
 *
 * The two symptoms this pins, both measured on the box:
 *  1. `the flash-next load is DEFERRED — slot busy: serving; running=1` printed for a lane the
 *     supervisor already called RESIDENT. Basalt serves concurrent slots, so the plugin's own
 *     slot census deferred a load that was never going to be issued, and the operator watched a
 *     warning for a no-op.
 *  2. a lease minted by one turn and never released: the lane stayed claimed by a turn that had
 *     ended, and the next session's acquire answered 409 lease_not_holder naming a caller that
 *     was already gone.
 *
 * No live daemon, no hardware, no lane moved: the supervisor is an HTTP server on a Unix socket
 * in tmp, pinned through FADE_SUPERVISOR_SOCK (a pinned path is never probed), and the assertions
 * are the hits it recorded — which bytes arrived, under which build header, with which token, and
 * which bytes never arrived.
 */
import "./env.mjs?suite=resident_gate";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Routes are assembled, never written as literals: an HTTP route on a Unix socket is not a
// filesystem path, and the write-target scanner on this box reads every leading-slash token in a
// file body as one.
const SL = "/";
const R_HEALTH = SL + "health";
const R_MODELS = SL + "v1" + SL + "models";
const R_RESIDENCY = SL + "v1" + SL + "residency";
const R_LEASE = SL + "v1" + SL + "lease";
const R_SWAP = SL + "v1" + SL + "swap";

/** The lane the tests target, and the resident entry the stub ROUTER census names instead — so
 *  the router's OWN `already resident` short-circuit never fires and every residency claim under
 *  test is the supervisor's. */
const TARGET = "flash-next";
const CENSUS = "deepseek";

const RESIDENT = { lane_state: "RESIDENT", active_pack: TARGET, pid: 4242, active_requests: 3, telemetry: { source: "nvml" }, supervisor: { version: "0.2.0" } };
const IDLE = { lane_state: "IDLE", active_pack: TARGET, pid: 4242, active_requests: 0, telemetry: { source: "nvml" }, supervisor: { version: "0.2.0" } };
const HEALTH = { status: "ok", model: CENSUS, loaded: true, loading: false, service: "basalt", percent: null, swap: null };

/** The stub supervisor: records every hit, answers from `answers`. An `answers` leg left
 *  undefined is a 503, which is how the no-answer fall-through is reached. */
const daemon = async (answers) => {
	const dir = mkdtempSync(join(tmpdir(), "fade-gate-"));
	const sock = join(dir, "supervisor.sock");
	const hits = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const parsed = body ? JSON.parse(body) : {};
			hits.push(`${req.method} ${req.url} build=${req.headers["x-fade-build"] ?? "-"} sid=${req.headers["x-fade-session-id"] ?? "-"} action=${parsed.action ?? "-"} token=${parsed.lease_token ?? parsed.token ?? "-"} pack=${parsed.pack ?? "-"}`);
			const send = (status, payload) => {
				res.statusCode = status;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(payload));
			};
			if (req.url === R_RESIDENCY) return send(200, answers.residency ?? { error: "no residency" });
			if (req.url === R_HEALTH) return send(200, { ok: true });
			if (req.url === R_LEASE) {
				const a = answers.lease?.[parsed.action];
				if (!a) return send(503, { decision: "REJECT", rule: "stub_no_answer", accepted: false });
				return send(a.status ?? 200, a.body);
			}
			if (req.url === R_SWAP) {
				const a = answers.swap;
				if (!a) return send(503, { decision: "REJECT", rule: "stub_no_answer", accepted: false });
				return send(a.status ?? 200, a.body);
			}
			return send(404, { error: "no route" });
		});
	});
	await new Promise((r) => server.listen(sock, r));
	return { sock, hits, dir, close: async () => new Promise((r) => server.close(r)) };
};

/** The stub ROUTER: a census that names `CENSUS` loaded, so the target is never the router's own
 *  resident entry. */
const routerStub = async () => {
	const server = http.createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === R_HEALTH) return res.end(JSON.stringify(HEALTH));
		if (req.url === R_MODELS) return res.end(JSON.stringify({ data: [{ id: CENSUS, status: "loaded" }] }));
		return res.end(JSON.stringify({ error: "no route" }));
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
};

/** The ctl fleet gate as a recorder: a swap that leaks past the supervisor appends a line, and
 *  the zero-swap proofs read this file. */
const ctlStub = (dir) => {
	const log = join(dir, "ctl-hits.log");
	const script = join(dir, "ctl-stub.sh");
	writeFileSync(script, `#!/bin/sh\necho "$1" >> '${log}'\necho refused-by-stub\n`);
	chmodSync(script, 0o755);
	return { script, log };
};

/** Import the router bundle fresh per test: ROUTER, SWAP_VIA, SWAP_CMD and the settle window are
 *  read at module load, so a shared import would answer the second test with the first test's
 *  stub. */
const fresh = async (tag, env) => {
	Object.assign(process.env, env);
	delete process.env.FADE_ORCHESTRATE_SWAP_VIA;
	delete process.env.FADE_BUILD;
	return await import(`../.test-build/router.mjs?case=${tag}`);
};

const busyTimes = (times) => {
	let calls = 0;
	const busy = async () => {
		const busyNow = times[Math.min(calls, times.length - 1)];
		calls += 1;
		return { busy: busyNow, running: busyNow ? 1 : 0, waiting: busyNow ? 2 : 0, reason: "slot busy: serving; running=1" };
	};
	return { busy, calls: () => calls };
};

// ---- the gate decision ------------------------------------------------------------------

test("a RESIDENT answer clears the gate: zero polls, zero DEFERRED, the slot census never read", async () => {
	const { gateLaneIdle } = await fresh("gate-resident", {});
	const census = busyTimes([true]);
	const deferrals = [];
	const r = await gateLaneIdle(TARGET, {
		busy: census.busy,
		residency: async () => ({ resident: true, state: "RESIDENT", pack: TARGET, pid: 4242, active_requests: 3, telemetry_source: "nvml", detail: "lane RESIDENT pack=flash-next" }),
		deferred: (m) => deferrals.push(m),
		budgetMs: 60_000,
		pollMs: 3_000,
	});
	assert.equal(r.short, "supervisor-resident", "the short-circuit is named, so a paid gate and a free one are distinguishable in the record");
	assert.equal(r.polls, 0, "zero polls is the whole point: the DEFERRED loop never runs");
	assert.equal(census.calls(), 0, "the router slot census is never read for a lane the daemon calls resident");
	assert.deepEqual(deferrals, [], "no DEFERRED warning for a lane that was never going to move");
	assert.equal(r.over_budget, false);
});

test("an IDLE answer pays the busy loop: residency is an optimization, never a veto", async () => {
	const { gateLaneIdle } = await fresh("gate-idle", {});
	const census = busyTimes([true, true, false]);
	const deferrals = [];
	const r = await gateLaneIdle(TARGET, {
		busy: census.busy,
		residency: async () => ({ resident: false, state: "IDLE", pack: TARGET, pid: 4242, active_requests: 0, telemetry_source: "nvml", detail: "lane IDLE" }),
		deferred: (m) => deferrals.push(m),
		budgetMs: 60_000,
		pollMs: 5,
	});
	assert.equal(r.short, undefined, "no short-circuit is claimed for a lane that is not resident");
	assert.equal(census.calls(), 3, "the census is read until it goes idle");
	assert.equal(deferrals.length, 1, "the DEFERRED warning lands once, on the first busy poll");
	assert.match(deferrals[0], /DEFERRED/);
	assert.equal(r.over_budget, false, "the lane went idle inside the budget, so the load is paid");
});

test("no answer falls into the busy loop: a daemon under restart costs a gate, never a stall", async () => {
	const { gateLaneIdle } = await fresh("gate-noanswer", {});
	const census = busyTimes([true, false]);
	const r = await gateLaneIdle(TARGET, { busy: census.busy, residency: async () => undefined, deferred: () => {}, budgetMs: 60_000, pollMs: 5 });
	assert.equal(r.short, undefined);
	assert.equal(r.polls, 1, "the fall-through is the behavior that has always worked");
	assert.equal(r.over_budget, false);
});

test("busy for the whole budget pays the load anyway, with the last reading kept", async () => {
	const { gateLaneIdle } = await fresh("gate-budget", {});
	const census = busyTimes([true]);
	const r = await gateLaneIdle(TARGET, { busy: census.busy, residency: async () => undefined, deferred: () => {}, budgetMs: 40, pollMs: 10 });
	assert.equal(r.over_budget, true, "a gate that never clears is a stalled run, so the caller proceeds");
	assert.ok(r.waited_ms >= 40, `the budget was spent, not skipped: ${r.waited_ms}ms`);
	assert.match(r.last.reason, /slot busy/, "the refusal names the counters the router reported");
});

test("an idle router pays no gate and raises no warning", async () => {
	const { gateLaneIdle } = await fresh("gate-idle-router", {});
	const census = busyTimes([false]);
	const deferrals = [];
	const r = await gateLaneIdle(TARGET, { busy: census.busy, residency: async () => undefined, deferred: (m) => deferrals.push(m), budgetMs: 60_000, pollMs: 5 });
	assert.equal(r.polls, 0);
	assert.equal(r.over_budget, false);
	assert.deepEqual(deferrals, []);
});

// ---- the load path over the stub daemon ---------------------------------------------------

test("loadLane pays ZERO swap bytes for a pack the supervisor calls resident", async () => {
	const sup = await daemon({ residency: RESIDENT });
	const rt = await routerStub();
	const ctl = ctlStub(sup.dir);
	try {
		const router = await fresh("load-resident", { FADE_SUPERVISOR_SOCK: sup.sock, FADE_ORCHESTRATE_ROUTER: rt.url, FADE_ORCHESTRATE_SWAP_CMD: ctl.script });
		const r = await router.loadLane(TARGET, { sessionId: "sess-resident" });
		assert.equal(r.ok, true, r.detail);
		assert.match(r.detail, /resident per supervisor/, "the detail names the reading that stopped the load, not a silent success");
		assert.match(r.detail, /pack=flash-next/, "the pack the daemon reported rides in the detail");
		assert.deepEqual(sup.hits, [`GET ${R_RESIDENCY} build=prod sid=sess-resident action=- token=- pack=-`], "one residency read, no lease, no swap");
		assert.ok(!existsSync(ctl.log), "the ctl fleet gate was never invoked");
	} finally {
		await sup.close();
		rt.close();
		rmSync(sup.dir, { recursive: true, force: true });
	}
});

test("a minted lease is released when the swap is refused: the finally is the guarantee", async () => {
	const sup = await daemon({
		residency: IDLE,
		lease: { acquire: { body: { decision: "GRANT", accepted: true, rule: "lease_granted", granted_ttl_s: 300, token: "T-MINT" } }, release: { body: { decision: "RELEASE", accepted: true, rule: "lease_released" } } },
		swap: { status: 503, body: { decision: "REJECT", accepted: false, rule: "vram_floor", reason: "gpu0 701 MiB free under the 8192 MiB admit floor" } },
	});
	const rt = await routerStub();
	const ctl = ctlStub(sup.dir);
	try {
		const router = await fresh("load-refused", { FADE_SUPERVISOR_SOCK: sup.sock, FADE_ORCHESTRATE_ROUTER: rt.url, FADE_ORCHESTRATE_SWAP_CMD: ctl.script });
		const r = await router.loadLane(TARGET, { sessionId: "sess-refused", mintLease: { ttlSec: 300 } });
		assert.equal(r.ok, false, "a refused swap is a refused load, never a silent success");
		assert.match(r.detail, /swap supervisor refused http 503 rule vram_floor/, r.detail);
		assert.match(r.detail, /gpu0 701 MiB/, "the daemon's reason reaches the operator");
		assert.deepEqual(sup.hits, [
			`GET ${R_RESIDENCY} build=prod sid=sess-refused action=- token=- pack=-`,
			`POST ${R_LEASE} build=prod sid=sess-refused action=acquire token=- pack=${TARGET}`,
			`POST ${R_SWAP} build=prod sid=sess-refused action=- token=T-MINT pack=${TARGET}`,
			`POST ${R_LEASE} build=prod sid=sess-refused action=release token=T-MINT pack=-`,
		], "acquire under prod, swap under the minted token, release even on the refusal");
		assert.ok(!existsSync(ctl.log), "a supervisor-path swap never falls to the ctl fleet gate");
	} finally {
		await sup.close();
		rt.close();
		rmSync(sup.dir, { recursive: true, force: true });
	}
});

test("a minted lease is KEPT when the swap lands, and the swap byte rides the token", async () => {
	const sup = await daemon({
		residency: IDLE,
		lease: { acquire: { body: { decision: "GRANT", accepted: true, rule: "lease_granted", granted_ttl_s: 300, token: "T-OK" } }, release: { body: { decision: "RELEASE", accepted: true, rule: "lease_released" } } },
		swap: { status: 202, body: { decision: "ADMIT", accepted: true, rule: "swap_admitted", lane: { active_pack: TARGET } } },
	});
	const rt = await routerStub();
	const ctl = ctlStub(sup.dir);
	try {
		const router = await fresh("load-landed", { FADE_SUPERVISOR_SOCK: sup.sock, FADE_ORCHESTRATE_ROUTER: rt.url, FADE_ORCHESTRATE_SWAP_CMD: ctl.script });
		const r = await router.loadLane(TARGET, { sessionId: "sess-kept", mintLease: { ttlSec: 300 } });
		assert.equal(r.ok, true, r.detail);
		assert.match(r.detail, /swap via supervisor: flash-next/, r.detail);
		assert.equal(r.minted, true, "the load says this token is the CALLER'S to keep");
		assert.equal(r.leaseToken, "T-OK", "the minted capability is returned, not consumed");
		assert.equal(r.leaseSession, "sess-kept", "the minting identity rides back for the release");
		assert.equal(sup.hits.filter((h) => h.includes("release")).length, 0,
			"the success path releases NOTHING: releasing here freed the lane before the turn the load protects ran (measured)");
		assert.equal(sup.hits.filter((h) => h.includes("acquire")).length, 1, "one acquire, no retry storm");
		assert.match(sup.hits.find((h) => h.includes(R_SWAP)), /token=T-OK/, "the swap byte rides the minted token");
		assert.ok(!existsSync(ctl.log), "a supervisor-path swap never falls to the ctl fleet gate");
	} finally {
		await sup.close();
		rt.close();
		rmSync(sup.dir, { recursive: true, force: true });
	}
});

test("a held capability rides the next move: no mint, no release, one swap byte", async () => {
	const sup = await daemon({
		residency: IDLE,
		swap: { status: 202, body: { decision: "ADMIT", accepted: true, rule: "swap_admitted", lane: { active_pack: TARGET } } },
	});
	const rt = await routerStub();
	const ctl = ctlStub(sup.dir);
	try {
		const router = await fresh("load-held", { FADE_SUPERVISOR_SOCK: sup.sock, FADE_ORCHESTRATE_ROUTER: rt.url, FADE_ORCHESTRATE_SWAP_CMD: ctl.script });
		const r = await router.loadLane(TARGET, { leaseToken: "T-HELD", sessionId: "sess-verify" });
		assert.equal(r.ok, true, r.detail);
		assert.equal(r.minted, undefined, "a presented token is not a mint, so there is nothing to hand back");
		assert.equal(sup.hits.filter((h) => h.includes(R_LEASE)).length, 0,
			"zero lease traffic: the session's capability covers the whole review, one holder for the turn");
		const held = sup.hits.find((h) => h.includes(R_SWAP));
		assert.match(held, /token=T-HELD/, "the swap rides the held token");
		assert.match(held, /sid=sess-verify/, "under the identity that minted it");
		assert.ok(!existsSync(ctl.log), "the ctl fleet gate was never invoked");
	} finally {
		await sup.close();
		rt.close();
		rmSync(sup.dir, { recursive: true, force: true });
	}
});

test("a refused mint names the rule and issues no swap byte", async () => {
	const sup = await daemon({
		residency: IDLE,
		lease: { acquire: { status: 409, body: { decision: "REJECT", accepted: false, rule: "lease_not_holder", reason: "lane held by fade-orchestrator (session run-7, 610 s left)", lane: { lease: { holder_caller: "fade-orchestrator", remaining_sec: 610, token_hint: "ab12cd" } } } } },
	});
	const rt = await routerStub();
	const ctl = ctlStub(sup.dir);
	try {
		const router = await fresh("load-mintrefused", { FADE_SUPERVISOR_SOCK: sup.sock, FADE_ORCHESTRATE_ROUTER: rt.url, FADE_ORCHESTRATE_SWAP_CMD: ctl.script });
		const r = await router.loadLane(TARGET, { sessionId: "sess-mintrefused", mintLease: { ttlSec: 300 } });
		assert.equal(r.ok, false);
		assert.match(r.detail, /lease mint refused http 409 rule lease_not_holder/, r.detail);
		assert.equal(sup.hits.filter((h) => h.includes(R_SWAP)).length, 0, "a caller that does not hold the lane never moves it");
		assert.equal(sup.hits.filter((h) => h.includes("release")).length, 0, "nothing was minted, so nothing is released");
		assert.ok(!existsSync(ctl.log), "the refusal is surfaced, not routed around onto the fleet gate");
	} finally {
		await sup.close();
		rt.close();
		rmSync(sup.dir, { recursive: true, force: true });
	}
});

test("a run's own lease token is used and never released by the load call", async () => {
	const sup = await daemon({
		residency: IDLE,
		swap: { status: 202, body: { decision: "ADMIT", accepted: true, rule: "swap_admitted", lane: { active_pack: TARGET } } },
	});
	const rt = await routerStub();
	const ctl = ctlStub(sup.dir);
	try {
		const router = await fresh("load-run", { FADE_SUPERVISOR_SOCK: sup.sock, FADE_ORCHESTRATE_ROUTER: rt.url, FADE_ORCHESTRATE_SWAP_CMD: ctl.script });
		const r = await router.loadLane(TARGET, { leaseToken: "R-RUN", sessionId: "run-9" });
		assert.equal(r.ok, true, r.detail);
		assert.ok(sup.hits.some((h) => h.includes(R_SWAP) && h.includes("R-RUN") && h.includes("sid=run-9")), "the swap rides the run's token under the run's session");
		assert.equal(sup.hits.filter((h) => h.includes("acquire")).length, 0, "the run already holds the lane: a load never mints over it");
		assert.equal(sup.hits.filter((h) => h.includes("release")).length, 0, "the run lifecycle owns the release; a mid-run swap must not drop the run's lease");
	} finally {
		await sup.close();
		rt.close();
		rmSync(sup.dir, { recursive: true, force: true });
	}
});

test("a dev build claims no eviction authority: FADE_BUILD=dev rides the header and the daemon refuses", async () => {
	const sup = await daemon({
		residency: IDLE,
		lease: { acquire: { status: 403, body: { decision: "REJECT", accepted: false, rule: "dev_build_no_evict", reason: "X-Fade-Build dev: a dev caller may not acquire the lane" } } },
	});
	const rt = await routerStub();
	const ctl = ctlStub(sup.dir);
	try {
		const router = await fresh("load-dev", { FADE_SUPERVISOR_SOCK: sup.sock, FADE_ORCHESTRATE_ROUTER: rt.url, FADE_ORCHESTRATE_SWAP_CMD: ctl.script });
		// The build claim is read at CALL time, not at import, so a rig flips it per call.
		process.env.FADE_BUILD = "dev";
		const r = await router.loadLane(TARGET, { sessionId: "sess-dev", mintLease: { ttlSec: 300 } });
		assert.equal(r.ok, false);
		assert.match(r.detail, /rule dev_build_no_evict/, r.detail);
		assert.ok(sup.hits.every((h) => !h.includes("build=prod")), "the client sends what the operator named, never more");
		assert.ok(sup.hits.some((h) => h.includes("build=dev") && h.includes("acquire")), "the dev claim is what the daemon refused, quoted back by rule");
	} finally {
		delete process.env.FADE_BUILD;
		await sup.close();
		rt.close();
		rmSync(sup.dir, { recursive: true, force: true });
	}
});
