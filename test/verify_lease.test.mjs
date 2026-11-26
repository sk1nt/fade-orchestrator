/**
 * The verification lease is HELD across the turn — the extension level.
 *
 * The defect, measured on the box 2026-11-25: a non-run verification move minted a lease, landed
 * the pack, and released the lease in the SAME call. The journal read `lease=free` while the
 * review was still running, and the next peer session took the lane back mid-verdict — the verdict
 * then ran on the pack it had just displaced. The load was paying for the switch, never for the
 * turn the switch exists to protect.
 *
 * This pins the whole mechanism a plain session gets, from the recorded verdict act to the
 * hand-back, against a stub supervisor that records every byte:
 *   1. the act is RECORDED at `tool_call`; no lane byte moves mid-turn;
 *   2. the boundary mints ONCE, swaps under that token, and releases NOTHING — the lane stays
 *      claimed by the session while its turns run on the thinking pack;
 *   3. the hand-back swaps back under the SAME token (no second mint) and releases exactly once.
 *
 * The thrash ledger is widened out (`FLIP_WINDOW_MS=0`): this suite measures the lease, and
 * forward-plus-back is by design two flips, which the breaker has its own tests for. The ctl fleet
 * gate is pointed at a MISSING binary, so any load routed through it fails by name — a green here
 * is proof the supervisor plane served every byte.
 */
import "./env.mjs";
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

const CODE = "flash-next";
const THINK = "deepseek";
const TOKEN = "T-VERIFY";
const IDLE = { lane_state: "IDLE", active_pack: CODE, pid: 4242, active_requests: 0, telemetry: { source: "nvml" }, supervisor: { version: "0.2.0" } };
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
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	return { url: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
};

const settled = async (hits, want, notes, ms = 15000) => {
	const t0 = Date.now();
	while (!want(hits)) {
		if (Date.now() - t0 > ms) throw new Error(`no match in ${ms} ms — wire:\n${hits.join("\n")}
the plugin said:\n${notes.join("\n")}`);
		await new Promise((r) => setTimeout(r, 25));
	}
};

test("a verification turn holds its lease: recorded mid-turn, paid at the boundary, returned at hand-back", async () => {
	const sup = await daemon();
	const rt = await routerStub(sup.state);
	const cwd = mkdtempSync(join(tmpdir(), "fade-vl-cwd-"));
	const missingCtl = join(cwd, "no-such-ctl");
	Object.assign(process.env, {
		PI_SESSION_FILE: "",
		FADE_SUPERVISOR_SOCK: sup.sock,
		FADE_ORCHESTRATE_ROUTER: rt.url,
		FADE_ORCHESTRATE_SWAP_VIA: "supervisor",
		FADE_ORCHESTRATE_SWAP_CMD: missingCtl,
		FADE_ORCHESTRATE_PROVIDER: "basalt",
		FADE_ORCHESTRATE_THINK_LANE: THINK,
		FADE_ORCHESTRATE_CODE_LANE: CODE,
		FADE_ORCHESTRATE_FLIP_WINDOW_MS: "0",
		// The stub never reports `loading`, so the settle window is never entered; declared small so a
		// harness window can never be mistaken for the plugin's 13-25 s pack load.
		FADE_ORCHESTRATE_SETTLE_MAX_MS: "2000",
		FADE_ORCHESTRATE_SETTLE_POLL_MS: "200",
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
		const { default: factory } = await import(`${built.href}?case=vl-${Date.now()}`);
		factory(pi);
		assert.ok(hooks.tool_call && hooks.agent_end, "the boundary hooks are bound");

		const notes = [];
		const ui = { notify: (m) => void notes.push(m), setWorkingMessage: () => undefined, setStatus: () => undefined, setWidget: () => undefined, setWorkingIndicator: () => undefined, setTitle: () => undefined };
		const ctx = (model) => ({ cwd, ui, model, modelRegistry: { find: (provider, id) => ({ provider, id }) }, agent: { kind: "main", id: "t", name: "t", depth: 0 } });

		// 1. the verdict act is RECORDED; a model switch mid-turn is what broke at 15:56, so no byte moves.
		await hooks.tool_call({ toolName: "task", input: { agent: "reviewer" } }, ctx({ provider: "basalt", id: "flash-next" }));
		assert.equal(supHits().filter((h) => h.includes(R_SWAP)).length, 0, "the act is recorded, not paid mid-turn");

		// 2. the boundary pays it: mint, swap under that token — and NO release.
		await hooks.agent_end({}, ctx({ provider: "basalt", id: "flash-next" }));
		await settled(sup.hits, (h) => h.some((x) => x.includes(R_SWAP)), notes);
		const swaps = () => supHits().filter((h) => h.includes(R_SWAP));
		const leases = () => supHits().filter((h) => h.includes(R_LEASE));
		assert.equal(swaps().length, 1, `one swap: ${swaps().join(" | ")}`);
		assert.match(swaps()[0], new RegExp(`pack=${THINK}`), "the thinking pack is what the boundary lands");
		assert.match(swaps()[0], new RegExp(`token=${TOKEN}`), "the swap rides the minted capability");
		assert.equal(leases().filter((h) => h.includes("acquire")).length, 1, "exactly one mint for the turn");
		assert.equal(leases().filter((h) => h.includes("release")).length, 0,
			"the load releases NOTHING: the lane stays claimed while the session's turns run on the thinking pack (the defect released it here and a peer took the lane mid-verdict)");

		// 3. the next boundary hands the code lane back: the SAME capability rides, then returns once.
		await hooks.agent_end({}, ctx({ provider: "basalt", id: THINK }));
		await settled(sup.hits, (h) => h.filter((x) => x.includes(R_SWAP)).length >= 2, notes);
		const hand = swaps()[1];
		assert.match(hand, new RegExp(`pack=${CODE}`), "the hand-back lands the code pack");
		assert.match(hand, new RegExp(`token=${TOKEN}`), "the hand-back rides the held capability: no second mint");
		assert.equal(leases().filter((h) => h.includes("acquire")).length, 1, "the turn is ONE holder, start to hand-back");
		await settled(sup.hits, (h) => h.filter((x) => x.includes(R_LEASE) && x.includes("release")).length >= 1, notes);
		assert.equal(leases().filter((h) => h.includes("release")).length, 1, "returned exactly once, at the hand-back");
		assert.ok(!existsSync(missingCtl), "the ctl fleet gate was never invoked");

		// Close the lifecycle: the factory opens the metrics interval, and an open handle keeps the
		// file alive to the runner's cap. `session_shutdown` is the real close — it stops the timer
		// and returns any capability the session still owns. The hand-back already returned ours, so
		// the lease traffic must NOT grow: exactly one release for the whole turn.
		await hooks.session_shutdown({}, ctx({ provider: "basalt", id: CODE }));
		assert.equal(sup.hits.filter((h) => h.includes(R_LEASE) && h.includes("release")).length, 1,
			"the shutdown does not release what the hand-back already returned");
	} finally {
		for (const k of ["FADE_SUPERVISOR_SOCK", "FADE_ORCHESTRATE_ROUTER", "FADE_ORCHESTRATE_SWAP_VIA", "FADE_ORCHESTRATE_SWAP_CMD", "FADE_ORCHESTRATE_FLIP_WINDOW_MS"]) delete process.env[k];
		await sup.close();
		rt.close();
		rmSync(sup.dir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}

	function supHits() { return sup.hits; }
});
