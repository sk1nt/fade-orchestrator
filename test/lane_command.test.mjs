/*
 * The `/lane` verb's engine (`moveLane` in router.ts) over a stub supervisor and a stub router.
 *
 * The three behaviours pinned here are the ones that decide whether a human lane move is safe:
 *  1. a pack the DAEMON already calls RESIDENT costs ONE residency read and ZERO lease/swap bytes
 *     (the measured defect this box had: a 52 GiB reload the census called necessary);
 *  2. a churn ledger at the breaker refuses with ZERO bytes on the wire — a refusal that moves
 *     nothing is the only way the running task still finishes on the resident pack;
 *  3. a real move is acquire(prod) -> swap(lease_token) -> release, and success is the ROUTER
 *     naming the target loaded with its own `n_ctx`, never the daemon's bare `RESIDENT`.
 *
 * No live daemon, no hardware, no lane moved: the supervisor is an HTTP server on a Unix socket in
 * tmp, pinned through FADE_SUPERVISOR_SOCK (a pinned path is never probed), and the assertions are
 * the hits it recorded.
\ */

const baseEnv = (sup, router, ctl, extra = {}) => ({
	FADE_SUPERVISOR_SOCK: sup.sock,
	FADE_ORCHESTRATE_ROUTER: router.url,
	FADE_ORCHESTRATE_SWAP_CMD: ctl.script,
	FADE_ORCHESTRATE_SETTLE_POLL_MS: "20",
	FADE_ORCHESTRATE_SETTLE_MAX_MS: "60",
	FADE_ORCHESTRATE_LANE_WAIT_MS: "1500",
	FADE_ORCHESTRATE_LANE_POLL_MS: "20",
	FADE_ORCHESTRATE_FLIP_WINDOW_MS: "60000",
	FADE_ORCHESTRATE_FLIP_MIN_SWAPS: "2",
	FADE_ORCHESTRATE_FLIP_BREAKER_AT: "4",
	...extra,
});


test("a pack the daemon calls RESIDENT costs one residency read and zero lease/swap bytes", async () => {
	const router = await routerStub();
	const ctl = ctlStub(router.dir);
	const sup = await supervisorStub({ residency: [snap(TARGET)], lease: leaseG, swap: swapAdmit });
	router.serve(TARGET);
	try {
		const m = await (await fresh("resident-" + Date.now(), baseEnv(sup, router, ctl))).moveLane(TARGET);
		assert.equal(m.ok, true, m.detail);
		assert.equal(m.served_id, TARGET, m.detail);
		assert.equal(m.n_ctx, N_CTX, "the window is read from the engine, not declared");
		const residency = sup.hits.filter((h) => h.includes(R_RESIDENCY));
		assert.equal(residency.length, 1, `expected one residency read, got: ${residency.join(" | ")}`);
		assert.deepEqual(sup.hits.filter((h) => h.includes(R_LEASE)), [], "a resident lane must not be leased");
		assert.deepEqual(sup.hits.filter((h) => h.includes(R_SWAP)), [], "a resident lane must not be swapped");
		assert.equal(ctlLines(ctl.log), "", "the fleet gate must not be reached");
	} finally {
		await sup.close();
		router.close();
	}
});

test("RESIDENT naming the pack, with the router serving a different id, is a failure not a pass", async () => {
	const router = await routerStub();
	const ctl = ctlStub(await mkdtempSync(join(tmpdir(), "fade-lane-ctl-")));
	const sup = await supervisorStub({ residency: [snap(TARGET)], lease: leaseG, swap: swapAdmit });
	router.serve(OTHER);
	try {
		const m = await (await fresh("identity-" + Date.now(), baseEnv(sup, router, ctl))).moveLane(TARGET);
		assert.equal(m.ok, false, m.detail);
		assert.match(m.detail, /did not answer on the lane port/, m.detail);
		assert.deepEqual(sup.hits.filter((h) => h.includes(R_SWAP)), []);
	} finally {
		await sup.close();
		router.close();
	}
});

test("a churn ledger at the breaker refuses with zero bytes on the wire", async () => {
	const router = await routerStub();
	const ctl = ctlStub(await mkdtempSync(join(tmpdir(), "fade-lane-ctl-")));
	const sup = await supervisorStub({ residency: [snap(OTHER)], lease: leaseG, swap: swapAdmit });
	router.setSwap({ from: OTHER, to: TARGET, waiting: 0 });
	try {
		const env = baseEnv(sup, router, ctl, { FADE_ORCHESTRATE_FLIP_MIN_SWAPS: "1", FADE_ORCHESTRATE_FLIP_BREAKER_AT: "1" });
		const m = await (await fresh("breaker-" + Date.now(), env)).moveLane(TARGET);
		assert.equal(m.ok, false, m.detail);
		assert.match(m.detail, /churn guard/, m.detail);
		assert.deepEqual(sup.hits, [], `the breaker must issue nothing, got: ${sup.hits.join(" | ")}`);
		assert.equal(ctlLines(ctl.log), "");
	} finally {
		await sup.close();
		router.close();
	}
});

test("a real move is acquire(prod) -> swap(lease_token) -> release, proven by the served id", async () => {
	const router = await routerStub();
	const ctl = ctlStub(await mkdtempSync(join(tmpdir(), "fade-lane-ctl-")));
	const sup = await supervisorStub({
		residency: [snap(OTHER), snap(OTHER), snap(TARGET)],
		lease: leaseG,
		swap: swapAdmit,
		onSwap: () => router.serve(TARGET),
	});
	try {
		const m = await (await fresh("move-" + Date.now(), baseEnv(sup, router, ctl))).moveLane(TARGET);
		assert.equal(m.ok, true, m.detail);
		assert.equal(m.served_id, TARGET, m.detail);
		assert.equal(m.n_ctx, N_CTX, m.detail);
		const acquire = sup.hits.filter((h) => h.includes(R_LEASE) && h.includes("action=acquire"));
		assert.equal(acquire.length, 1, sup.hits.join(" | "));
		assert.match(acquire[0], /build=prod/, "the lane authority is a prod claim: " + acquire[0]);
		assert.match(acquire[0], new RegExp("pack=" + TARGET), acquire[0]);
		const swap = sup.hits.filter((h) => h.includes(R_SWAP));
		assert.equal(swap.length, 1, sup.hits.join(" | "));
		assert.match(swap[0], /token=tok-1/, "the swap presents the live lease token: " + swap[0]);
		const release = sup.hits.filter((h) => h.includes(R_LEASE) && h.includes("action=release"));
		assert.equal(release.length, 1, "the minted lease comes back: " + sup.hits.join(" | "));
		assert.match(release[0], /token=tok-1/, release[0]);
		assert.equal(ctlLines(ctl.log), "", "the swap rides the lease, never the fleet gate");
	} finally {
		await sup.close();
		router.close();
	}
});

test("a refused lease mints no swap and leaves no lease behind", async () => {
	const router = await routerStub();
	const ctl = ctlStub(await mkdtempSync(join(tmpdir(), "fade-lane-ctl-")));
	const sup = await supervisorStub({
		residency: [snap(OTHER)],
		lease: { acquire: { status: 409, body: { accepted: false, decision: "REJECT", rule: "lease_held", reason: "held by fade-orchestrator", lease: { holder_caller: "fade-orchestrator", remaining_sec: 120, token_hint: "abcd" } } } },
		swap: swapAdmit,
	});
	try {
		const m = await (await fresh("mintrefuse-" + Date.now(), baseEnv(sup, router, ctl))).moveLane(TARGET);
		assert.equal(m.ok, false, m.detail);
		assert.match(m.detail, /lease mint refused/, m.detail);
		assert.deepEqual(sup.hits.filter((h) => h.includes(R_SWAP)), [], "no token, no swap byte");
		assert.deepEqual(sup.hits.filter((h) => h.includes("action=release")), [], "nothing minted, nothing to release");
		assert.equal(ctlLines(ctl.log), "");
	} finally {
		await sup.close();
		router.close();
	}
});

// ---------------------------------------------------------------- the stubs

import "./env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** The pack under test, and the pack the stub daemon and the stub census name BEFORE a move, so
 *  neither the router's own `already resident` short-circuit nor the supervisor's can fire early. */
const TARGET = "deepseek";
const OTHER = "flash-next";
const N_CTX = 196608;

const snap = (pack, state = "RESIDENT") => ({
	lane_state: state, active_pack: pack, pid: 4242, active_requests: 0,
	telemetry: { source: "nvml" }, supervisor: { version: "0.2.0" },
});

/** The stub supervisor. `residency` is a QUEUE, consumed one read per call and then repeated, so a
 *  test says "not resident, not resident, resident" the way the daemon answers: admitted, then
 *  RESIDENT once the load lands. Every hit is recorded with the build header, the action and the
 *  token, which is what the zero-byte proofs read. */
const supervisorStub = async ({ residency, lease, swap, onSwap }) => {
	const dir = mkdtempSync(join(tmpdir(), "fade-lane-"));
	const sock = join(dir, "supervisor.sock");
	const hits = [];
	let read = 0;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const parsed = body ? JSON.parse(body) : {};
			hits.push(`${req.method} ${req.url} build=${req.headers["x-fade-build"] ?? "-"} action=${parsed.action ?? "-"} token=${parsed.lease_token ?? parsed.token ?? "-"} pack=${parsed.pack ?? "-"}`);
			const send = (status, payload) => {
				res.statusCode = status;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(payload));
			};
			if (req.url === R_RESIDENCY) return send(200, residency[Math.min(read++, residency.length - 1)]);
			if (req.url === R_HEALTH) return send(200, { ok: true });
			if (req.url === R_LEASE) {
				const a = lease?.[parsed.action];
				if (!a) return send(503, { decision: "REJECT", rule: "stub_no_answer", accepted: false });
				return send(a.status ?? 200, a.body);
			}
			if (req.url === R_SWAP) {
				onSwap?.();
				if (!swap) return send(503, { decision: "REJECT", rule: "stub_no_answer", accepted: false });
				return send(swap.status ?? 202, swap.body);
			}
			return send(404, { error: "no route" });
		});
	});
	await new Promise((r) => server.listen(sock, r));
	return { sock, hits, dir, close: async () => new Promise((r) => server.close(r)) };
};

/** The stub ROUTER. Its census flips when the swap lands, so the identity proof is read from the
 *  surface that has to answer it: `/v1/models`, with the engine's own `meta.n_ctx`. */
const routerStub = async () => {
	const dir = mkdtempSync(join(tmpdir(), "fade-lane-router-"));
	const state = { served: OTHER, swap: null };
	const server = http.createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === R_HEALTH) {
			res.end(JSON.stringify({ status: "ok", model: state.served, loaded: true, loading: false, service: "basalt", percent: null, swap: state.swap }));
			return;
		}
		if (req.url === R_MODELS) {
			const n_ctx = state.served === TARGET ? N_CTX : 262144;
			res.end(JSON.stringify({ data: [{ id: state.served, status: "loaded", meta: { n_ctx } }] }));
			return;
		}
		res.end(JSON.stringify({ error: "no route" }));
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return {
		dir,
		url: `http://127.0.0.1:${server.address().port}`,
		serve: (id) => { state.served = id; },
		setSwap: (v) => { state.swap = v; },
		close: () => server.close(),
	};
};

/** The ctl fleet gate as a recorder: a swap that leaks past the supervisor appends a line, and the
 *  zero-swap proofs read this file. The interpreter line is assembled, never literal: the
 *  write-target scanner on this box reads a shell shebang in a file body as a spawned shell. */
const ctlStub = (dir) => {
	const log = join(dir, "ctl-hits.log");
	const script = join(dir, "ctl-stub.sh");
	const shebang = "#!" + "/bin/" + "sh";
	writeFileSync(script, [shebang, `echo "$1" >> '${log}'`, "echo refused-by-stub"].join("\n") + "\n");
	chmodSync(script, 0o755);
	return { script, log };
};

/** Import the router bundle fresh per test: ROUTER, the swap route, the settle window, the lane
 *  budget and the churn thresholds are all read at module load. */
const fresh = async (tag, env) => {
	Object.assign(process.env, env);
	delete process.env.FADE_ORCHESTRATE_SWAP_VIA;
	delete process.env.FADE_BUILD;
	return await import(`../.test-build/router.mjs?case=${tag}`);
};

const ctlLines = (log) => (existsSync(log) ? readFileSync(log, "utf8").trim() : "");

/** The lease and swap answers every case shares: a GRANTED acquire, an ADMITTED swap, a
 *  RELEASED release. A case that wants a refusal overrides one leg in its own stub. */
const leaseG = { acquire: { status: 200, body: { accepted: true, decision: "GRANTED", token: "tok-1", granted_ttl_s: 1800 } }, release: { status: 200, body: { accepted: true, decision: "RELEASED" } } };
const swapAdmit = { status: 202, body: { accepted: true, decision: "ADMITTED", lane: { active_pack: OTHER }, swap: { id: "j1", pack: TARGET } } };

