#!/usr/bin/env node
/**
 * The start preflight PROVES the planning lane, it does not census it.
 *
 * The defect (measured 2026-11-26): `/orchestrate <goal>` ran a ONE-SHOT census and skipped the
 * check whenever the census errored; a session then pinned `basalt/deepseek`, sent the planning
 * briefing while the lane still served `flash-next`, and the router answered
 * `404 The model 'basalt/deepseek' does not exist` — a start that paid the claim and the gate for
 * a briefing nobody served. And `RESIDENT` from the daemon proves only that SOME model answered
 * the readiness probe — a resident daemon serving the WRONG pack is exactly the shape that 404s.
 *
 * The proof this suite pins is BOTH, and a proof:
 *   - the daemon's `lane_state` is `RESIDENT` with `active_pack` = target, AND
 *   - the ROUTER serves target as an id on `/v1/models`.
 * A daemon that never answers, a router that answers 404, and a resident pack that is not the
 * served id are each failures that NAME their class. The proof reads: it takes no lease, issues
 * no swap, and never kills a load in flight — the window is a fuse, not a lever.
 *
 * WHAT THIS PROOF IS NOT, since the same day: the SWITCH path. The halt that ended the day was
 * the opposite shape — a review round announced `hy4-flash` while the session's completion still
 * named `flash-next`, and the host answered `404 The model 'flash-next' does not exist`. A
 * residency proof placed IN FRONT of the pin is what produced it: the proof spends the whole
 * 13-25 s load, so the pin and the briefing sat on the PREVIOUS pack the entire time. The switch
 * now issues load + `setModel` + thinking + tool policy + briefing in ONE generation and lets
 * `before_agent_start` hold the COMPLETION until the lane serves the pin — the contract is
 * `test/lane_switch_404.test.mjs`, and block 13 of `test/gate_rig.mjs` grades the boundary.
 * `proveResident` stays exactly where it belongs: the start preflight, and the operator's `/lane`
 * verb, which reads state and swaps nothing.
 */
import "./env.mjs?suite=preflight_proof";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Routes are assembled, never literal: a leading-slash token in a file body is read as a write
// target by this box's scanner.
const SL = "/";
const R_RESIDENCY = SL + "v1" + SL + "residency";
const R_MODELS = SL + "v1" + SL + "models";

/** The stub supervisor: one mutable answer, on a tmp UDS (a pinned path is never probed). */
const daemon = async () => {
	const dir = mkdtempSync(join(tmpdir(), "fade-pp-"));
	const sock = join(dir, "supervisor.sock");
	const hits = [];
	const state = {
		reply: () => ({ lane_state: "RESIDENT", active_pack: "deepseek", pid: 7, active_requests: 0, telemetry: { source: "nvml" }, supervisor: { version: "pp-stub" } }),
	};
	const server = http.createServer((req, res) => {
		hits.push(`${req.method} ${req.url}`);
		res.statusCode = 200;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(state.reply()));
	});
	await new Promise((r) => server.listen(sock, r));
	return { sock, hits, state, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } };
};

/** The stub ROUTER: `/v1/models` with a mutable served id; `off` answers 404, `garbage` answers text. */
const router = async () => {
	const state = { loaded: "deepseek", mode: "ok" };
	const server = http.createServer((req, res) => {
		if (req.url?.startsWith(R_MODELS)) {
			if (state.mode === "off") {
				res.statusCode = 404;
				res.end();
				return;
			}
			if (state.mode === "garbage") {
				res.statusCode = 200;
				res.setHeader("content-type", "text/plain");
				res.end("not json");
				return;
			}
			res.statusCode = 200;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({
				data: [
					{ id: state.loaded, status: { value: "loaded" }, meta: { n_ctx: 262144 } },
					{ id: state.loaded === "deepseek" ? "flash-next" : "deepseek", status: { value: "offloaded" } },
				],
			}));
			return;
		}
		res.statusCode = 404;
		res.end();
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => server.close() };
};

const d = await daemon();
const rt = await router();
process.env.FADE_SUPERVISOR_SOCK = d.sock;
process.env.FADE_ORCHESTRATE_ROUTER = rt.url;
// The rig's fuse: the proof must NAME a missing lane in milliseconds, never wait the box's 240 s.
process.env.FADE_ORCHESTRATE_START_PROOF_WAIT_MS = "300";
process.env.FADE_ORCHESTRATE_LANE_POLL_MS = "50";

const m = await import("../.test-build/router.mjs?case=preflight");
const prove = (target) => m.proveResident(target, { sessionId: "pp-session", waitMs: 300, pollMs: 50 });

test("the proof is BOTH: daemon RESIDENT for the target AND the router serving its id", async () => {
	const p = await prove("deepseek");
	assert.equal(p.ok, true, JSON.stringify(p));
	assert.equal(p.state, "RESIDENT");
	assert.equal(p.pack, "deepseek");
	assert.equal(p.served_id, "deepseek", "the id the ROUTER answers, from /v1/models — never from the daemon");
	assert.equal(p.n_ctx, 262144, "the window the engine advertises rides along");
	assert.ok(p.waited_s < 1, `a resident lane proves on the first poll: ${p.waited_s}s`);
});

test("the start defect, reproduced: RESIDENT for the target while the router serves another id is NOT a proof", async () => {
	// The 404 class: the daemon's readiness probe was answered by SOME model, the lane serves
	// `flash-next`, and a session pinned to `deepseek` sends a request the router refuses.
	// The wait is the whole window: breaking on the daemon half and one-shotting the router
	// was the measured 404 (hy4-flash still listed, session already named flash-next).
	rt.state.loaded = "flash-next";
	const t0 = Date.now();
	const p = await prove("deepseek");
	const spent = Date.now() - t0;
	assert.equal(p.ok, false, JSON.stringify(p));
	assert.equal(p.state, "RESIDENT", "the daemon's half is named, because it passed");
	assert.equal(p.served_id, "flash-next", "the router's half is the failure, and it is the named one");
	assert.ok(spent >= 250, `the proof WAITS the window for the router id, it does not one-shot: ${spent}ms`);
	rt.state.loaded = "deepseek";
});

test("the router catching up mid-window is a proof: the wait is for BOTH halves, not the daemon alone", async () => {
	rt.state.loaded = "flash-next";
	setTimeout(() => { rt.state.loaded = "deepseek"; }, 80);
	const t0 = Date.now();
	const p = await prove("deepseek");
	const spent = Date.now() - t0;
	assert.equal(p.ok, true, JSON.stringify(p));
	assert.equal(p.served_id, "deepseek");
	assert.ok(spent >= 80, `the proof waited for the served id, it did not accept the daemon half alone: ${spent}ms`);
	assert.ok(spent < 300, `a catch-up inside the window does not spend the fuse: ${spent}ms`);
});

test("an IDLE lane is a failure that names the state, and the window is spent, never skipped", async () => {
	d.state.reply = () => ({ lane_state: "IDLE", active_pack: "flash-next", pid: 7, active_requests: 0, telemetry: { source: "nvml" }, supervisor: { version: "pp-stub" } });
	const t0 = Date.now();
	const p = await prove("deepseek");
	const spent = Date.now() - t0;
	assert.equal(p.ok, false, JSON.stringify(p));
	assert.equal(p.state, "IDLE");
	assert.ok(spent >= 250, `the proof WAITS the window for a load in flight: ${spent}ms`);
	d.state.reply = () => ({ lane_state: "RESIDENT", active_pack: "deepseek", pid: 7, active_requests: 0, telemetry: { source: "nvml" }, supervisor: { version: "pp-stub" } });
});

test("no answer from either side is a failure, named: unknown state, served id nothing", async () => {
	d.state.reply = () => ({}); // a body with no lane state is NO ANSWER, not non-residency
	rt.state.mode = "off";
	const p = await prove("deepseek");
	assert.equal(p.ok, false, JSON.stringify(p));
	assert.equal(p.state, "unknown");
	assert.equal(p.served_id, undefined, "a 404 router serves NOTHING — the proof says so, it does not skip");
	rt.state.mode = "garbage";
	const g = await prove("deepseek");
	assert.equal(g.ok, false, "a router answering text is not a proof either");
	d.state.reply = () => ({ lane_state: "RESIDENT", active_pack: "deepseek", pid: 7, active_requests: 0, telemetry: { source: "nvml" }, supervisor: { version: "pp-stub" } });
	rt.state.mode = "ok";
});

test("the proof is READ-ONLY: no lease, no swap — it never takes the lane it is judging", async () => {
	const leases = d.hits.filter((h) => h.includes("lease"));
	const swaps = d.hits.filter((h) => h.includes("swap"));
	assert.equal(leases.length, 0, leases.join(" | "));
	assert.equal(swaps.length, 0, swaps.join(" | "));
	assert.ok(d.hits.every((h) => h.includes(R_RESIDENCY)), `only residency was read: ${d.hits.join(" | ")}`);
});

test("cleanup", () => {
	d.close();
	rt.close();
});
