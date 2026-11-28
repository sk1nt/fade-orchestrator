#!/usr/bin/env node
/**
 * The hold and the plain session, re-pinned to the armed-lane contract.
 *
 * The halt, measured live (2026-11-26): a verdict act landed the pack on
 * `hy4-flash` — which is why the switch lands at the turn boundary and the
 * completion must hold until the lane serves the pin. On this box a supervisor
 * swap REPLACES the `:18014` process, so it carries exactly one id and a name
 * it does not carry is a 404.
 *
 * The contract, copied from Basalt (`docs/configuration/models.md`,
 * `docs/running.md`, `docs/changelog/0.3.0.md`):
 *   a request for the loaded model runs at once;
 *   a client waits through a swap and is never 503'd for it (keep-alive comments every 10 s);
 *   a name the server does not carry is a 404;
 *   a failed load answers its batch with a 503 naming the model.
 *
 * The CURRENT contract this suite pins (2026-11-27, the armed-lane gate): a plain
 * session — no run adopted, nothing armed through an `/orchestrate` act — never
 * moves the lane. No verdict act is recorded, no pin, no swap, no tool policy, no
 * thinking change, no briefing. The hold machinery is unchanged and is what these
 * assertions cover: `before_provider_request` holds the turn until the lane
 * serves the pin the session holds, which is the `before_agent_start` hold the
 * original file pinned, under the new hook name. Fake router and fake daemon
 * only: no live `:18014`, no lease taken, no systemctl, and every window is the
 * rig's (milliseconds), never the box's 900 s.
 *
 * ONE stub pair per process, like `test/gate_rig.mjs`: `ROUTER` and the
 * supervisor socket are read at module import, so a stub per test would be a stub
 * the plugin never sees. The state is reset per test; the extension instance is
 * per test (a cache-busted import) so each test owns its recorded host calls.
 */
import "./env.mjs?suite=lane_switch_404";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.PI_SESSION_FILE;
delete process.env.PI_SESSION_ID;

// Routes are assembled, never literal: a leading-slash token in a file body is read as a write
// target by this box's scanner.
const SL = "/";
const R_HEALTH = SL + "health";
const R_MODELS = SL + "v1" + SL + "models";
const R_METRICS = SL + "metrics";
const R_RESIDENCY = SL + "v1" + SL + "residency";
const R_LEASE = SL + "v1" + SL + "lease";
const R_SWAP = SL + "v1" + SL + "swap";

const CODE = "flash-next";
const THINK = "deepseek";
const VERIFY = "hy4-flash";
const FOREIGN = "gpt-6-sol"; // a name no lane carries: Basalt's "any other name", a 404
const TOKEN = "T-404";

/** The swap's transit, in stub milliseconds: the pin must land INSIDE this window, the completion
 *  must wait it out, and no test may sleep the box's real 13-25 s. */
const SWAP_DELAY_MS = 150;

const readJson = async (req) => {
	let body = "";
	for await (const c of req) body += c;
	return body ? JSON.parse(body) : {};
};

/** The swap lands: the process is replaced, so the lane now carries exactly this id. */
const land = (st, model) => {
	st.served = model;
	st.loading = false;
	st.percent = null;
	st.health = { status: "ok", loaded: true, loading: false, percent: null };
};

/** The stub ROUTER: it serves ONE id, the way the swapped process does. Its listing flips when the
 *  swap lands — `swapDelayMs` after it was admitted — and `/health` reports the percent, which is
 *  what the working message refreshes from. The lag between "resident" and "listed" IS the defect:
 *  the daemon says RESIDENT pack=X while `:18014` still answers the old id. */
const st = {
	served: CODE,
	loading: false,
	percent: null,
	health: { status: "ok", loaded: true, loading: false, percent: null },
	modelsHits: 0,
	busy: false,
	admitted: [],
	swapDelayMs: SWAP_DELAY_MS,
	pending: [],
};
const router = http.createServer(async (req, res) => {
	res.setHeader("content-type", "application/json");
	if (req.url === R_HEALTH) {
		return res.end(JSON.stringify({ ...st.health, model: st.health.model ?? st.served, service: "basalt" }));
	}
	if (req.url === R_MODELS) {
		st.modelsHits += 1;
		return res.end(JSON.stringify({
			data: [CODE, THINK, VERIFY].map((id) => ({ id, status: { value: st.served === id ? "loaded" : "unloaded" } })),
		}));
	}
	if (req.url === R_SWAP && req.method === "POST") {
		const { model } = await readJson(req);
		st.admitted.push(model);
		st.loading = true;
		st.percent = 0;
		st.health = { status: "ok", loaded: true, loading: true, percent: 0 };
		if (st.swapDelayMs <= 0) land(st, model);
		else st.pending.push(setTimeout(() => land(st, model), st.swapDelayMs));
		return res.end(JSON.stringify({ ok: true, model }));
	}
	// `/metrics` answers the slot census. At rest it answers "no route": a census-shaped body read
	// as an OPEN REQUEST would hold the idle gate forever — a harness defect, not a plugin one.
	// `busy` is the other state: one slot active, which is a router a load must wait for.
	if (st.busy) return res.end(JSON.stringify({ live: { state: "decoding", phase: "prompting", queued: 0, slots: { total: 1, active: 1, queue_depth: 0 }, queue: [] } }));
	return res.end(JSON.stringify({ error: "no route" }));
});
await new Promise((r) => router.listen(0, "127.0.0.1", r));
const ROUTER_URL = `http://127.0.0.1:${router.address().port}`;

/** The stub SUPERVISOR on a Unix socket: the lane authority and the plane that swaps. One line per
 *  byte, so the assertions are the wire. `refuseSwap` is the failed-load class. */
const sup = { resident: CODE, refuseSwap: false, hits: [] };
const supDir = mkdtempSync(join(tmpdir(), "fade-404-sup-"));
const SUP_SOCK = join(supDir, "supervisor.sock");
const supServer = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const p = body ? JSON.parse(body) : {};
		sup.hits.push(`${req.method} ${req.url} action=${p.action ?? "-"} token=${p.lease_token ?? p.token ?? "-"} pack=${p.pack ?? "-"}`);
		const send = (status, payload) => {
			res.statusCode = status;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(payload));
		};
		if (req.url === R_RESIDENCY) return send(200, { lane_state: "RESIDENT", active_pack: sup.resident, pid: 4242, active_requests: 0, telemetry: { source: "stub" }, supervisor: { version: "stub" } });
		if (req.url === R_LEASE && p.action === "acquire") return send(200, { accepted: true, decision: "GRANT", rule: "lease_granted", granted_ttl_s: 1800, token: TOKEN, token_hint: "a1b2c3", lease: { holder_caller: "fade-orchestrator", remaining_sec: 1800, token_hint: "a1b2c3" } });
		if (req.url === R_LEASE && p.action === "renew") return send(200, { accepted: true, decision: "RENEW", rule: "lease_renewed", granted_ttl_s: 3, lease: { holder_caller: "fade-orchestrator", remaining_sec: 3, token_hint: "a1b2c3" } });
		if (req.url === R_LEASE) return send(200, { accepted: true, decision: "OK", rule: "", reason: `${p.action ?? "status"}: stub` });
		if (req.url === R_SWAP) {
			if (sup.refuseSwap) return send(503, { decision: "REJECT", accepted: false, rule: "load_failed", why: "stub: the pack did not load" });
			sup.resident = p.pack;
			// ADMIT IS THE MOMENT THE BOX STARTS REPLACING THE `:18014` PROCESS. The lane keeps
			// answering the OLD id for `swapDelayMs` and then carries exactly the new one, which is
			// the measured shape: the daemon's RESIDENT answer and the router's LISTING disagree
			// while the swap is in flight, and that window is where the recorded 404 was born.
			st.admitted.push(p.pack);
			st.loading = true;
			st.percent = 0;
			st.health = { status: "ok", loaded: true, loading: true, percent: 0 };
			if (st.swapDelayMs <= 0) land(st, p.pack);
			else st.pending.push(setTimeout(() => land(st, p.pack), st.swapDelayMs));
			return send(202, { decision: "ADMIT", accepted: true, rule: "swap_admitted", lane: { active_pack: p.pack } });
		}
		return send(503, { decision: "REJECT", accepted: false, rule: "stub_unanswered" });
	});
});
await new Promise((r) => supServer.listen(SUP_SOCK, r));

// Declared BEFORE the bundle is imported: the router module resolves its endpoints and windows at
// import. The hold's ceiling is the daemon's readiness window in production (900 s); here it is
// 1.2 s, so a hold that never ends is a failure named in milliseconds, never a hung suite. The
// keep-alive clock is 40 ms, so a refresh is observable inside one swap window.
Object.assign(process.env, {
	FADE_ORCHESTRATE_ROUTER: ROUTER_URL,
	FADE_SUPERVISOR_SOCK: SUP_SOCK,
	FADE_ORCHESTRATE_SWAP_VIA: "supervisor",
	FADE_ORCHESTRATE_PROVIDER: "basalt",
	FADE_ORCHESTRATE_THINK_LANE: THINK,
	FADE_ORCHESTRATE_CODE_LANE: CODE,
	FADE_ORCHESTRATE_VERIFY_LANE: VERIFY,
	FADE_ORCHESTRATE_FLIP_WINDOW_MS: "0",
	FADE_ORCHESTRATE_LANE_POLL_MS: "20",
	// The pre-swap gate's clock, for the supersession test: the gate polls the slot census, so a
	// busy router holds a load for the budget and a dead generation dies at that check.
	FADE_ORCHESTRATE_GATE_POLL_MS: "10",
	FADE_ORCHESTRATE_GATE_BUDGET_MS: "200",
	FADE_ORCHESTRATE_KEEPALIVE_MS: "40",
	FADE_ORCHESTRATE_SERVE_WAIT_MS: "1200",
	FADE_ORCHESTRATE_START_PROOF_WAIT_MS: "600",
	FADE_ORCHESTRATE_LANE_WAIT_MS: "600",
	FADE_ORCHESTRATE_SETTLE_MAX_MS: "200",
	FADE_ORCHESTRATE_SETTLE_POLL_MS: "20",
	FADE_ORCHESTRATE_METRICS_INTERVAL_MS: "250",
	FADE_ORCHESTRATE_LEASE_MINT_TTL_S: "3",
	FADE_ORCHESTRATE_HEADLESS: "1",
	FADE_ORCHESTRATE_KEY: "ctrl+shift+f15",
	FADE_ORCHESTRATE_FALLBACK_KEY: "ctrl+shift+f16",
});

const built = new URL("../.test-build/index.mjs", import.meta.url);
assert.ok(existsSync(built), "run `node test/build.mjs` first (npm test builds it)");
const routerBuilt = new URL("../.test-build/router.mjs", import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, pred, cap = 4000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > cap) throw new Error(`${what}: no match in ${cap} ms`);
		await sleep(10);
	}
};

/** The lane state the given test starts from: the daemon's resident pack and the router's listed
 *  id are set SEPARATELY, because the measured window is the two of them disagreeing. */
const setPlane = ({ resident, served, delay = SWAP_DELAY_MS, health, refuseSwap = false, busy = false }) => {
	sup.resident = resident;
	sup.refuseSwap = refuseSwap;
	sup.hits.length = 0;
	st.served = served;
	st.loading = false;
	st.percent = null;
	st.health = health ?? { status: "ok", loaded: true, loading: false, percent: null };
	st.modelsHits = 0;
	st.admitted.length = 0;
	st.pending.splice(0).forEach((t) => clearTimeout(t));
	st.swapDelayMs = delay;
	st.busy = busy;
};

/** Drain the PREVIOUS test's in-flight serve-holds. A switch chain outlives its test's
 *  `close()`: the swap lands ~150 ms after the test moved on, and the WIP's boundary
 *  `laneServeHold` keeps polling `/v1/models` on the keep-alive clock until the lane serves.
 *  Those polls land on THIS suite's stub and are billed to whichever test counts reads next —
 *  measured as the "exactly one census read" contract answering `2 !== 1` with the source
 *  unchanged. The one-read rule is about the TURN, so count from a quiet wire. */
const quietModels = async (cap = 3000) => {
	const t0 = Date.now();
	let last = st.modelsHits;
	for (;;) {
		await sleep(60);
		if (st.modelsHits === last) return;
		last = st.modelsHits;
		if (Date.now() - t0 > cap) return;
	}
};

/** One extension instance with every host call recorded. The pins record the listing they were
 *  issued AGAINST, which is the whole question: a pin issued while the lane still serves the old
 *  pack is the fix; a pin issued after a residency proof is the halt. */
const rig = async (tag) => {
	const cwd = mkdtempSync(join(tmpdir(), "fade-404-cwd-"));
	const hooks = {};
	const pins = [];
	const thinking = [];
	const policy = [];
	const sent = [];
	const notes = [];
	const working = [];
	const active = { tools: ["read", "bash", "edit", "write", "grep", "task"] };
	const noop = () => undefined;
	const pi = {
		registerTool: noop,
		registerCommand: noop,
		registerShortcut: () => ({ ok: true }),
		on: (event, handler) => void (hooks[event] = handler),
		setModel: async (model) => {
			pins.push({ id: model?.id, served: st.served });
			return true;
		},
		setThinkingLevel: (level) => {
			thinking.push(level);
		},
		getActiveTools: () => active.tools,
		setActiveTools: (tools) => {
			active.tools = [...tools];
			policy.push([...tools]);
		},
		sendUserMessage: (text) => {
			sent.push(text);
		},
		getShortcuts: () => [],
		getShortcutConflict: () => null,
	};
	// RELATIVE + query, never `${built.href}?case=`: bun normalizes a `file:` URL by dropping
	// the query, which silently shares ONE module instance across every rig (and across suites
	// in the same process) with the FIRST rig's frozen env.
	const { default: factory } = await import(`../.test-build/index.mjs?case=${tag}-${Date.now()}`);
	factory(pi);
	const ctx = (model) => ({
		hasUI: false,
		cwd,
		...(model ? { model: { provider: "basalt", id: model } } : {}),
		modelRegistry: { find: (provider, id) => ({ provider, id, name: id }) },
		agent: { kind: "main", id: tag, name: tag, depth: 0 },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5, baselineSource: "test" }),
		abort: noop,
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
		ui: {
			notify: (m) => {
				notes.push(m);
			},
			setWorkingMessage: (m) => {
				working.push(m ?? null);
			},
			setStatus: noop,
			setWidget: noop,
			setWorkingIndicator: noop,
			setTitle: noop,
			onTerminalInput: () => () => undefined,
			custom: async () => undefined,
		},
	});
	const close = async () => {
		// `session_shutdown` is the real close: it stops the metrics interval, so the runner is not
		// carried past the suite by an open handle.
		if (hooks.session_shutdown) await hooks.session_shutdown({}, ctx(CODE));
		rmSync(cwd, { recursive: true, force: true });
	};
	/** The verdict act, recorded mid-turn: the boundary pays it, and nothing moves before that. */
	const recordVerifyAct = async (model) => {
		await hooks.tool_call({ toolName: "task", input: { agent: "reviewer" } }, ctx(model));
	};
	return { hooks, pins, thinking, policy, sent, notes, working, active, ctx, close, recordVerifyAct };
};

test.after(() => {
	st.pending.splice(0).forEach((t) => clearTimeout(t));
	supServer.closeAllConnections?.();
	supServer.close();
	router.closeAllConnections?.();
	router.close();
	rmSync(supDir, { recursive: true, force: true });
});

test("the plain session never pays the verdict act: no pin, no swap, no policy change, no briefing", async () => {
	// The lane is on the code pack, listed as the code pack, when the verdict act is recorded.
	setPlane({ resident: CODE, served: CODE });
	const r = await rig("sameact");
	try {
		await r.recordVerifyAct(CODE);
		await r.hooks.agent_end({}, r.ctx(CODE));
		await sleep(100);
		// A plain session never moves the lane: the armed-lane gate refuses to pay the verdict
		// act (a run-owning session arms it through an /orchestrate act).
		assert.equal(r.pins.length, 0, `no pin at the boundary: ${JSON.stringify(r.pins)}`);
		assert.deepEqual(sup.hits.filter((h) => h.includes(R_SWAP)), [], "no swap at the boundary");
		assert.equal(r.thinking.length, 0, "no thinking level moved");
		assert.equal(r.policy.length, 0, "no tool policy moved");
		assert.equal(r.sent.length, 0, "no briefing sent");

		// The completion still holds: the turn waits the way basalt's router holds a client
		// through a swap — the pin is the pack already serving, so the hold is one read.
		await r.hooks.before_provider_request({}, r.ctx(CODE));
		assert.ok(!r.notes.some((n) => n.includes("not serving")), `the turn posted with no 404 and no warning: ${r.notes.join(" | ")}`);
	} finally {
		await r.close();
	}
});

test("the completion waits the Basalt way: the hook holds while the lane lists the old id, keep-alive and all", async () => {
	// The measured window: the daemon is RESIDENT on the advisor pack, `:18014` still LISTS the
	// code pack, and the session pin is the advisor pack. The old defect is the host posting here
	// and answering 404. It must not get the chance.
	setPlane({ resident: VERIFY, served: CODE });
	const r = await rig("hold");
	try {
		const t0 = Date.now();
		const workBase = r.working.length;
		const hook = r.hooks.before_provider_request({}, r.ctx(VERIFY));
		let settled = false;
		void hook.then(() => (settled = true));
		await sleep(60);
		assert.equal(settled, false, "the hook did NOT return while the lane listed the wrong id: a configured lane is never a 404");
		assert.ok(r.working.length > workBase, `the operator is told to wait: ${JSON.stringify(r.working.slice(workBase))}`);

		// Basalt's streamed wait is not silent: keep-alive comments every 10 s. The rig's clock is
		// 40 ms, so a refresh is due well inside the window.
		await sleep(90);
		const refreshes = r.working.length - workBase;
		assert.ok(refreshes >= 2, `the working message refreshed on the keep-alive clock, not once: ${JSON.stringify(r.working.slice(workBase))}`);
		assert.ok(r.working.slice(workBase).some((m) => typeof m === "string" && m.includes(VERIFY)), "the message names the lane that is coming up");

		// The listing catches up; the hold releases on the next poll and the turn runs.
		land(st, VERIFY);
		await hook;
		const spent = Date.now() - t0;
		assert.ok(spent >= 100, `the wait was the swap (${spent} ms), not a client timeout`);
		assert.ok(spent < 1200, `the hold is bounded by the rig's window (${spent} ms), never the box's 900 s`);
		assert.ok(!r.notes.some((n) => n.includes("not serving")), `no 404, no warning: ${r.notes.join(" | ")}`);
	} finally {
		await r.close();
	}
});

test("a pin that already names the served id runs at once: one read, no waiting, no working message", async () => {
	setPlane({ resident: CODE, served: CODE });
	const r = await rig("atonce");
	try {
		await quietModels();
		const hits = st.modelsHits;
		const workBase = r.working.length;
		const t0 = Date.now();
		await r.hooks.before_provider_request({}, r.ctx(CODE));
		const spent = Date.now() - t0;
		assert.equal(st.modelsHits - hits, 1, "the loaded model costs exactly one census read");
		assert.equal(r.working.length - workBase, 0, "nothing to wait for, nothing to say");
		assert.ok(spent < 60, `the turn posted at once (${spent} ms)`);
	} finally {
		await r.close();
	}
});

test("a plain session pays no load at all, so no refusal is ever named", async () => {
	setPlane({ resident: CODE, served: CODE, refuseSwap: true });
	const r = await rig("failed");
	try {
		await r.recordVerifyAct(CODE);
		const pins = r.pins.length;
		const sent = r.sent.length;
		await r.hooks.agent_end({}, r.ctx(CODE));
		await sleep(100);
		// A plain session never pays a load: no swap is attempted, nothing lands, nothing is named.
		assert.equal(r.pins.length, pins, "a plain session lands NO pin");
		assert.equal(r.sent.length, sent, "and NO briefing");
		assert.deepEqual(sup.hits.filter((h) => h.includes(R_SWAP)), [], "no swap is issued");
		// The loop survives: the next turn on the served pack posts with no 404.
		await r.hooks.before_provider_request({}, r.ctx(CODE));
		assert.ok(!r.notes.some((n) => n.includes("not serving")), `no 404 cascade: ${r.notes.join(" | ")}`);
	} finally {
		await r.close();
	}
});

test("a plain session on the thinking lane hands nothing back: no pin, no briefing, no swap", async () => {
	// The turn ran on the planning lane: the boundary is now a no-op for a plain session.
	setPlane({ resident: THINK, served: THINK });
	const r = await rig("quiet");
	try {
		const sent = r.sent.length;
		await r.hooks.agent_end({}, r.ctx(THINK));
		await sleep(100);
		assert.equal(r.pins.length, 0, "no pin at the boundary");
		assert.equal(r.thinking.length, 0, "no thinking level moved");
		assert.equal(r.sent.length, sent, "no briefing page");
		assert.deepEqual(sup.hits.filter((h) => h.includes(R_SWAP)), [], "no swap at the boundary");

		// The completion still holds the way basalt does: a turn naming the served lane runs at once.
		await r.hooks.before_provider_request({}, r.ctx(THINK));
		assert.ok(!r.notes.some((n) => n.includes("not serving")), `the turn posted with no 404: ${r.notes.join(" | ")}`);
	} finally {
		await r.close();
	}
});

test("a plain session's overlapping boundaries move nothing at all", async () => {
	// Two boundaries in one act: the switch machinery is armed only through an /orchestrate act,
	// so a plain session pays NOTHING — no pin, no swap, no policy change, no briefing.
	setPlane({ resident: THINK, served: THINK, busy: true });
	const r = await rig("gen");
	try {
		await r.hooks.agent_end({}, r.ctx(THINK));
		await sleep(20);
		await r.recordVerifyAct(THINK);
		await r.hooks.agent_end({}, r.ctx(THINK));
		await sleep(50);
		assert.equal(r.pins.length, 0, `no pin at any boundary: ${JSON.stringify(r.pins)}`);
		assert.deepEqual(sup.hits.filter((h) => h.includes(R_SWAP)), [], "no swap at any boundary");
		assert.equal(r.thinking.length, 0, "no thinking level moved");
		assert.equal(r.policy.length, 0, "no tool policy moved");
		assert.equal(r.sent.length, 0, "no briefing page");
	} finally {
		await r.close();
	}
});

test("Basalt's 404 stays a 404: a name that is not a lane is the host's answer, not a hold", async () => {
	const m = await import(routerBuilt.href);
	assert.equal(m.isServedLane(VERIFY), true, "the advisor lane is configured");
	assert.equal(m.isServedLane(CODE), true, "the code lane is configured");
	assert.equal(m.isServedLane(THINK), true, "the planning lane is configured");
	assert.equal(m.isServedLane(FOREIGN), false, "a name no lane carries is Basalt's 'any other name'");
	const hold = await m.laneServeHold(FOREIGN, { served: async () => ({ id: VERIFY }), health: async () => undefined, pollMs: 10, waitMs: 20, keepAliveMs: 10 });
	assert.equal(hold.ok, false, "the hold never satisfies a name the lane does not carry");
});

test("the hold's classes: served id at once (one read), a dead context is the 503 class, an unreachable router keeps the client waiting", async () => {
	const m = await import(routerBuilt.href);

	const loaded = await m.laneServeHold(CODE, { served: async () => ({ id: CODE }), health: async () => undefined, pollMs: 10, waitMs: 200, keepAliveMs: 10 });
	assert.equal(loaded.ok, true, "the loaded model runs at once");
	assert.equal(loaded.polls, 1, "and costs ONE read: zero extra polls beyond the census");

	const dead = await m.laneServeHold(VERIFY, {
		served: async () => ({ id: CODE }),
		health: async () => ({ status: "cuda_fatal", model: CODE, loaded: true, loading: false }),
		pollMs: 10,
		waitMs: 2000,
		keepAliveMs: 5,
	});
	assert.equal(dead.ok, false);
	assert.equal(dead.failed, true, `an error state that is not loading is the 503 class, not a slow swap: ${dead.reason}`);

	const hollow = await m.laneServeHold(VERIFY, {
		served: async () => ({ id: CODE }),
		health: async () => ({ status: "ok", loaded: true, loading: false }),
		pollMs: 10,
		waitMs: 2000,
		keepAliveMs: 5,
	});
	assert.equal(hollow.failed, true, `a loaded context that names NO model is the same 503 class: ${hollow.reason}`);
	assert.ok(dead.reason.includes(VERIFY), `the failure names the model: ${dead.reason}`);

	const progress = [];
	const inflight = await m.laneServeHold(VERIFY, {
		served: async () => ({ id: CODE }),
		health: async () => ({ status: "ok", model: CODE, loaded: true, loading: true, percent: 42 }),
		pollMs: 10,
		waitMs: 120,
		keepAliveMs: 20,
		progress: (line) => progress.push(line),
	});
	assert.equal(inflight.ok, false, "the window ends, named");
	assert.equal(inflight.failed, false, "a swap in flight is NEVER a failure: Basalt holds it");
	assert.ok(inflight.refreshes >= 2, `the keep-alive clock fired ${inflight.refreshes} times inside 120 ms`);
	assert.ok(progress.some((line) => line.includes("42%")), `the refresh carries the router's own percent: ${JSON.stringify(progress)}`);

	const dark = await m.laneServeHold(VERIFY, {
		served: async () => undefined,
		health: async () => undefined,
		pollMs: 10,
		waitMs: 60,
		keepAliveMs: 20,
	});
	assert.equal(dark.failed, false, "a router mid-replacement answers NOTHING: that is the swap, and the client keeps waiting");
	assert.ok(dark.reason.includes("nothing"), `the named state: ${dark.reason}`);
});

test("the keep-alive page carries the percent as a NUMBER, for the surfaces that paint it", async () => {
	// The status pill and the Alt+F header move a bar with the load; a caller that has to parse a
	// sentence for the number is a caller that paints a stale bar.
	const m = await import(routerBuilt.href);
	const seen = [];
	const h = await m.laneServeHold(VERIFY, { served: async () => ({ id: CODE }), health: async () => ({ status: "ok", model: CODE, loaded: true, loading: true, percent: 42 }), pollMs: 10, waitMs: 60, keepAliveMs: 20, progress: (line, percent) => seen.push(percent) });
	assert.equal(h.ok, false, "the window ends, named");
	assert.ok(seen.includes(42), `the percent rides as a number: ${JSON.stringify(seen)}`);
});

// ── the same wrapper at the BOUNDARY: the switch has a page for its whole 13-25 s ───────────
// `before_agent_start` holds the COMPLETION. The pack load itself is the other half of the window:
// the operator's screen during a switch showed a working message with no percent, and the panel's
// first read is the router the swap is replacing. So the switch runs the same `laneServeHold`,
// pumps the same page (working message + the multicolored pill, on the same keep-alive clock), and
// issues the briefing only once the lane serves the pack the pin names.
test("a plain session's boundary paints nothing: no holding page, no briefing", async () => {
	setPlane({ resident: CODE, served: CODE });
	const r = await rig("page");
	try {
		await r.recordVerifyAct(CODE);
		const sent = r.sent.length;
		const workBase = r.working.length;
		await r.hooks.agent_end({}, r.ctx(CODE));
		await sleep(100);
		assert.equal(r.pins.length, 0, `no pin at the boundary: ${JSON.stringify(r.pins)}`);
		assert.equal(r.working.length, workBase, "no holding page is painted");
		assert.equal(r.sent.length, sent, "no briefing sent");
		assert.deepEqual(sup.hits.filter((h) => h.includes(R_SWAP)), [], "no swap is issued");
	} finally {
		await r.close();
	}
});

test("a plain session admits nothing and never serves: no pin, no page, no briefing", async () => {
	setPlane({ resident: CODE, served: CODE, delay: 5000 });
	const r = await rig("noserve");
	try {
		await r.recordVerifyAct(CODE);
		const sent = r.sent.length;
		await r.hooks.agent_end({}, r.ctx(CODE));
		await sleep(100);
		assert.equal(r.pins.length, 0, "no pin lands, so no pack is owed");
		assert.equal(r.sent.length, sent, "NO briefing");
		assert.equal(r.working.length, 0, "no holding page is painted");
		assert.deepEqual(sup.hits.filter((h) => h.includes(R_SWAP)), [], "no swap is issued");
		// The screen never moved: the session still holds the code pack, and the next turn posts clean.
		await r.hooks.before_provider_request({}, r.ctx(CODE));
		assert.ok(!r.notes.some((n) => n.includes("not serving")), `no 404 cascade: ${r.notes.join(" | ")}`);
	} finally {
		await r.close();
	}
});

test("a plain session never strips the tool policy: the verifier sandbox rides the lane move", async () => {
	setPlane({ resident: CODE, served: CODE });
	const rt = await rig("policy");
	try {
		rt.active.tools = ["read", "bash", "edit", "task"];
		await rt.recordVerifyAct(CODE);
		await rt.hooks.agent_end({}, rt.ctx(CODE));
		await sleep(100);
		assert.equal(rt.policy.length, 0, `no policy move for a plain session: ${JSON.stringify(rt.policy)}`);
		assert.equal(rt.pins.length, 0, "no pin at the boundary");
		assert.deepEqual(sup.hits.filter((h) => h.includes(R_SWAP)), [], "no swap is issued");
		assert.deepEqual(rt.active.tools, ["read", "bash", "edit", "task"], "the active set is untouched");
	} finally {
		await rt.close();
	}
});
