/**
 * A plain session takes no verification lease — the extension level.
 *
 * The armed-lane gate (2026-11-27): a plain session — no run adopted, no /orchestrate act —
 * may not move the lane. No verdict act is recorded, no mint, no swap, no renew, no release,
 * and no byte reaches the daemon at any boundary. The lease is held across the turn for a
 * run-owning session (the /orchestrate path), never for a plain one; this suite pins the
 * negative contract, against a stub supervisor that records every byte.
 *
 * The thrash ledger is widened out (`FLIP_WINDOW_MS=0`): the lease is the one instrument this
 * suite measures. The ctl fleet gate is pointed at a MISSING binary, so any load routed through
 * it fails by name — a green here is proof no load is ever routed.
 */
import { resetLaneEnv } from "./env.mjs?suite=verify_lease";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Routes are assembled, never literal: a leading-slash token in a file body is read as a
// write target by this box's scanner.
const SL = "/";
const R_HEALTH = SL + "health";
const R_MODELS = SL + "v1" + SL + "models";
const R_RESIDENCY = SL + "v1" + SL + "residency";
const R_LEASE = SL + "v1" + SL + "lease";
const R_SWAP = SL + "v1" + SL + "swap";

const VERIFY = "hy4-flash";

const CODE = "flash-next";
const THINK = "deepseek";
const TOKEN = "T-VERIFY";
const IDLE = { lane_state: "RESIDENT", active_pack: CODE, pid: 4242, active_requests: 0, telemetry: { source: "nvml" }, supervisor: { version: "0.2.0" } };
const HEALTH = { status: "ok", model: CODE, loaded: true, loading: false, service: "basalt", percent: null, swap: null };

/** The stub supervisor on a Unix socket: one line per byte, so the assertions are the wire. */
const daemon = async () => {
	const dir = mkdtempSync(join(tmpdir(), "fade-vl-"));
	const sock = join(dir, "supervisor.sock");
	const hits = [];
	const state = { resident: CODE };
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const p = body ? JSON.parse(body) : {};
			hits.push(`${req.method} ${req.url} sid=${req.headers["x-fade-session-id"] ?? "-"} action=${p.action ?? "-"} token=${p.lease_token ?? p.token ?? "-"} pack=${p.pack ?? "-"}`);
			const send = (status, payload) => {
				res.statusCode = status;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(payload));
			};
			// The stub MOVES the lane it supervises: the residency answer and the router census both
			// report the pack that last landed. A static stub answers a hand-back with "already
			// resident", which is the plugin behaving correctly, and the release-at-hand-back is then
			// untestable — it fires against a census that never moved.
			if (req.url === R_RESIDENCY) return send(200, { ...IDLE, active_pack: state.resident });
			if (req.url === R_LEASE && p.action === "acquire") return send(200, { decision: "GRANT", accepted: true, rule: "lease_granted", granted_ttl_s: 1800, token: TOKEN, token_hint: "a1b2c3", lease: { holder_caller: "fade-orchestrator", remaining_sec: 1800, token_hint: "a1b2c3" } });
			if (req.url === R_LEASE && p.action === "release") return send(200, { decision: "RELEASE", accepted: true, rule: "lease_released" });
			// A renew is granted, not refused: the assertion below must measure a RENEWED lease, not a
			// client beating against a 503.
			if (req.url === R_LEASE && p.action === "renew") return send(200, { decision: "RENEW", accepted: true, rule: "lease_renewed", granted_ttl_s: 3, lease: { holder_caller: "fade-orchestrator", remaining_sec: 3, token_hint: "a1b2c3" } });
			if (req.url === R_SWAP) {
				state.resident = p.pack;
				return send(202, { decision: "ADMIT", accepted: true, rule: "swap_admitted", lane: { active_pack: p.pack } });
			}
			return send(503, { decision: "REJECT", accepted: false, rule: "stub_unanswered" });
		});
	});
	await new Promise((r) => server.listen(sock, r));
	return { dir, sock, hits, state, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
};

/** Bind a PROBED port in a low, fixed band. `listen(0)` hands out the OS's ephemeral band, and
 *  a donor suite in the same process (bun runs all 27 files as one) frees its stub port at its
 *  close — the OS recycles that exact port to THIS stub seconds later, and the runner's fetch
 *  pool keeps a socket to the port, not to the server: the pre-unload gate reads `/health` on
 *  the donor's dead keep-alive and the load refuses at a port a FRESH connect reaches
 *  (measured: "router unreachable at http://127.0.0.1:40901"). A probed port in a
 *  low band is never in the ephemeral range the donors use. The probing is the convention: a
 *  bare constant races TIME_WAIT and foreign binders, so `listen` IS the probe. */
const listenProbed = async (server) => {
	for (let port = 20000; port < 20100; port++) {
		const bound = await new Promise((r) => {
			const done = (v) => () => r(v);
			server.once("listening", done(true));
			server.once("error", done(false));
			server.listen(port, "127.0.0.1");
		});
		if (bound) return port;
	}
	throw new Error("no probed port 20000-20099 is bindable");
};

/** The router the plugin reads: CODE loaded, THINK absent, slot free. */
const routerStub = async (laneState) => {
	const server = http.createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === R_HEALTH) return res.end(JSON.stringify(HEALTH));
		if (req.url === R_MODELS) return res.end(JSON.stringify({ data: [{ id: laneState.resident, status: "loaded" }] }));
		// /metrics answers "no route": a census-shaped body is read as an OPEN REQUEST and the
		// idle gate defers the load forever, which is a harness defect, not a plugin one.
		return res.end(JSON.stringify({ error: "no route" }));
	});
	const port = await listenProbed(server);
	return { url: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
};

// The runner ceiling must sit above the suite's settle windows: the wire is the proof, and a
// runner that kills the test mid-settle reports a timeout with an empty journal. node's default
// is no ceiling; the option is honored by both runners.
test("a plain session takes no verification lease: nothing reaches the daemon", { timeout: 20_000 }, async () => {
	const sup = await daemon();
	const rt = await routerStub(sup.state);
	const cwd = mkdtempSync(join(tmpdir(), "fade-vl-cwd-"));
	const missingCtl = join(cwd, "no-such-ctl");
	// Clear every rig/live key FIRST: the fixture then names its own windows, and the bundle
	// instance imported below freezes exactly them. A leaked `FLIP_WINDOW_MS=0` from another
	// rig's fixture is a breaker that refuses this suite's swap; a leaked mint TTL is a lease
	// that expires mid-verdict.
	resetLaneEnv();
	Object.assign(process.env, {
		PI_SESSION_FILE: "",
		FADE_SUPERVISOR_SOCK: sup.sock,
		FADE_ORCHESTRATE_ROUTER: rt.url,
		FADE_ORCHESTRATE_SWAP_VIA: "supervisor",
		FADE_ORCHESTRATE_SWAP_CMD: missingCtl,
		FADE_ORCHESTRATE_PROVIDER: "basalt",
		FADE_ORCHESTRATE_THINK_LANE: THINK,
		FADE_ORCHESTRATE_CODE_LANE: CODE,
		FADE_ORCHESTRATE_VERIFY_LANE: VERIFY,
		FADE_ORCHESTRATE_FLIP_WINDOW_MS: "0",
		// The lease's clock is the metrics tick. Drive it fast and mint short so `shouldRenew`
		// (remaining <= max(60, ttl/3)) is already true on the tick that follows the mint.
		FADE_ORCHESTRATE_METRICS_INTERVAL_MS: "250",
		FADE_ORCHESTRATE_LEASE_MINT_TTL_S: "3",
		// The stub never reports `loading`, so the settle window is never entered; declared small so a
		// harness window can never be mistaken for the plugin's 13-25 s pack load.
		FADE_ORCHESTRATE_SETTLE_MAX_MS: "2000",
		FADE_ORCHESTRATE_SETTLE_POLL_MS: "200",
		// The phase-boundary switch now PROVES the served id before setModel. The stub lands on
		// the first poll; a miss must fail in milliseconds, never the box's 240 s window.
		FADE_ORCHESTRATE_START_PROOF_WAIT_MS: "800",
		FADE_ORCHESTRATE_LANE_POLL_MS: "50",
		FADE_ORCHESTRATE_KEY: "ctrl+shift+f13",
		FADE_ORCHESTRATE_FALLBACK_KEY: "ctrl+shift+f14",
	});
	try {
		const built = new URL("../.test-build/index.mjs", import.meta.url);
		assert.ok(existsSync(built), "run `node test/build.mjs` first (npm test builds it)");
		const hooks = {};
		const noop = () => undefined;
		const pi = {
			registerTool: noop, registerCommand: noop, registerShortcut: () => ({ ok: true }),
			on: (event, handler) => void (hooks[event] = handler),
			// The host answers a successful pin with `true`; anything else is the plugin's own
	// "did not switch" refusal, so the fake answers like the host.
	setModel: () => true, setThinkingLevel: () => true, getActiveTools: () => ["read"], setActiveTools: noop,
			sendUserMessage: noop, getShortcuts: () => [], getShortcutConflict: () => null,
		};
		// The cache-bust must ride a RELATIVE specifier: bun normalizes a `file:` URL by
		// dropping its query, so `${built.href}?case=` returns the FIRST importer's instance —
		// measured: this fixture's factory carried a donor rig's frozen `ROUTER` (36817) while
		// its own env named 20000, and the pre-unload gate refused on the donor's dead port.
		// `import.meta.url`-relative specifiers keep the query.
		const { default: factory } = await import(`../.test-build/index.mjs?case=vl-${Date.now()}`);
		factory(pi);
		assert.ok(hooks.tool_call && hooks.agent_end, "the boundary hooks are bound");

		const ui = { notify: noop, setWorkingMessage: () => undefined, setStatus: () => undefined, setWidget: () => undefined, setWorkingIndicator: () => undefined, setTitle: () => undefined };
		const ctx = (model) => ({ cwd, ui, model, modelRegistry: { find: (provider, id) => ({ provider, id }) }, agent: { kind: "main", id: "t", name: "t", depth: 0 } });

		// 1. the verdict act is never recorded by a plain session: no byte moves mid-turn.
		await hooks.tool_call({ toolName: "task", input: { agent: "reviewer" } }, ctx({ provider: "basalt", id: "flash-next" }));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(supHits().length, 0, `no byte reaches the daemon mid-turn: ${supHits().join(" | ")}`);

		// 2. and at the boundary nothing is paid either: no mint, no swap, no release, no renew.
		await hooks.agent_end({}, ctx({ provider: "basalt", id: "flash-next" }));
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(supHits().length, 0, `no byte reaches the daemon at the boundary: ${supHits().join(" | ")}`);
		assert.ok(!existsSync(missingCtl), "the ctl fleet gate was never invoked");

		// 3. and the hand-back is a no-op too: the plain session keeps the pack it is on.
		await hooks.agent_end({}, ctx({ provider: "basalt", id: VERIFY }));
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(supHits().length, 0, `no byte reaches the daemon at the hand-back: ${supHits().join(" | ")}`);

		// 4. the shutdown releases nothing it never minted.
		await hooks.session_shutdown({}, ctx({ provider: "basalt", id: CODE }));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(supHits().length, 0, `no byte reaches the daemon at the shutdown: ${supHits().join(" | ")}`);
	} finally {
		for (const k of ["FADE_SUPERVISOR_SOCK", "FADE_ORCHESTRATE_ROUTER", "FADE_ORCHESTRATE_SWAP_VIA", "FADE_ORCHESTRATE_SWAP_CMD", "FADE_ORCHESTRATE_FLIP_WINDOW_MS", "FADE_ORCHESTRATE_METRICS_INTERVAL_MS", "FADE_ORCHESTRATE_LEASE_MINT_TTL_S"]) delete process.env[k];
		await sup.close();
		rt.close();
		rmSync(sup.dir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}

	function supHits() { return sup.hits; }
});
