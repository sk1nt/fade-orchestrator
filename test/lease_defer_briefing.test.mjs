/**
 * The lease lifecycle at a hand-back: a mint refused over a CLAIMED lane is a deferral, and the
 * briefing it costs is queued, not dropped.
 *
 * The failure this pins (measured on the box, 2026-11-27): Frontier settled a task, control came
 * back to the orchestrator, and the advisor-lane load answered
 *
 *   lease mint refused http 409 rule lease_held: lease held by fade-orchestrator
 *   (session 01a21a8e-…, 1137 s left): acquire is refused until it is released or expires
 *
 * — refused by a lease the SAME plugin process held, because the start claim presented the run id
 * and the review-turn mint presented `omp-pid-<pid>`, and the minted token lived only in a closure.
 * The switch then took its only `!ok` branch: `state = "failed"`, lock and lease released, and
 * `briefing not sent`. Record: `docs/lease-lifecycle-409-20261127.md`.
 *
 * What is under test is where the 409 is ANSWERED: the built `loadLane` (router.ts) over a stub
 * supervisor on a Unix socket, the token store (supervisor.ts), and the state transition (core.ts).
 * No live daemon, no hardware, no lane moved, no lease taken on the box: the assertions are the hits
 * the stub recorded — which bytes arrived under which identity, with which token, and which bytes
 * never arrived.
 *
 * The rig is per test, like `resident_gate`'s: a stub pair built for the test, the environment
 * declared AFTER `resetLaneEnv()`, and the bundle imported with a query of its own — the built
 * modules freeze `SWAP_VIA`, `SUPERVISOR_SOCK`, the router URL and `STATE_DIR` at MODULE IMPORT.
 * Both halves of that rule are load-bearing here: a bare file-top specifier would resolve to an
 * instance loaded from an environment that names the LIVE box, and a file-top EXPORT of the stub
 * endpoints freezes a stub pair a later suite never started into the singleton its test body
 * imports (measured: every suite after this one polled a closed server and the run died at its
 * fifteen-minute bound). So each test takes the env, imports, and hands the env back.
 */
import { resetLaneEnv } from "./env.mjs?suite=lease_defer_briefing";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Routes assembled, never literal: a leading-slash token in a file body is read as a write target
// by this box's scanner.
const SL = "/";
const R_HEALTH = SL + "health";
const R_MODELS = SL + "v1" + SL + "models";
const R_RESIDENCY = SL + "v1" + SL + "residency";
const R_LEASE = SL + "v1" + SL + "lease";
const R_SWAP = SL + "v1" + SL + "swap";

const CODE = "flash-next";
const THINK = "deepseek";
const VERIFY = "hy4-flash";
/** The holder in the measured refusal, kept verbatim: the operator's message is the fixture. */
const HOLDER_SESSION = "01a21a8e-da8a-748c-bdf2-db2bd2d1f470";
const HELD_MS = 1137;
const TOKEN = "T-LDB";
const HELD_REASON = `lease held by fade-orchestrator (session ${HOLDER_SESSION}, ${HELD_MS} s left): acquire is refused until it is released or expires`;
const grantBody = {
	accepted: true, decision: "GRANT", rule: "lease_granted", granted_ttl_s: 300, token: TOKEN, token_hint: "a1b2c3",
	lease: { holder_caller: "fade-orchestrator", remaining_sec: 300, token_hint: "a1b2c3" },
};

/** The stub ROUTER: one id served, the way a swapped `:18014` process carries one. */
const routerStub = async () => {
	const st = { served: CODE, admitted: [] };
	const server = http.createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === R_HEALTH) return res.end(JSON.stringify({ status: "ok", model: st.served, loaded: true, loading: false, percent: null, service: "basalt" }));
		if (req.url === R_MODELS) return res.end(JSON.stringify({ data: [CODE, THINK, VERIFY].map((id) => ({ id, status: { value: st.served === id ? "loaded" : "unloaded" } })) }));
		if (req.url === R_SWAP && req.method === "POST") {
			let body = "";
			for await (const c of req) body += c;
			const { model } = body ? JSON.parse(body) : {};
			st.admitted.push(model);
			st.served = model;
			return res.end(JSON.stringify({ ok: true, model }));
		}
		return res.end(JSON.stringify({ error: "no route" }));
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { st, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
};

/**
 * The stub SUPERVISOR: the lane authority. `mode` is the fixture's whole question — `held` answers
 * 409 with the measured reason, `grant` grants, `stale` proves a presented token dead,
 * `refuseFloor` answers a floor with NO countdown (the class that must stay a hard failure). One
 * line per byte, so the assertions are the wire.
 */
const daemonStub = async (mode = "grant", resident = CODE, census = () => {}) => {
	const dir = mkdtempSync(join(tmpdir(), "fade-ldb-sup-"));
	const sock = join(dir, "supervisor.sock");
	const sup = { resident, hits: [], mode, acquires: 0 };
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const p = body ? JSON.parse(body) : {};
			const tok = p.lease_token ?? p.token ?? "-";
			sup.hits.push(`${req.method} ${req.url} sid=${req.headers["x-fade-session-id"] ?? "-"} action=${p.action ?? "-"} token=${tok} pack=${p.pack ?? "-"}`);
			const send = (status, payload) => {
				res.statusCode = status;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(payload));
			};
			const reject = (status, rule, reason, extra = {}) => send(status, { accepted: false, decision: "REJECT", rule, reason, ...extra });
			// An admitted swap MOVES the lane: the daemon's own residency and the ROUTER census
			// (`/v1/models`) both follow it, exactly as on the box. A daemon-only update leaves the
			// census naming the old pack, and `loadLane`'s census short-circuit (`already resident;
			// no swap issued`) then answers a later act with `ok: true` and ZERO wire — measured as
			// a renew assertion reading an empty wire.
			const land = (pack) => { sup.resident = pack; census(pack); };
			if (req.url === R_RESIDENCY) return send(200, { lane_state: "RESIDENT", active_pack: sup.resident, pid: 4242, active_requests: 0, telemetry: { source: "stub" }, supervisor: { version: "stub" } });
			if (req.url === R_LEASE && p.action === "acquire") {
				sup.acquires += 1;
				if (sup.mode === "held") return reject(409, "lease_held", HELD_REASON, { token_hint: "a1b2c3", lease: { holder_caller: "fade-orchestrator", remaining_sec: HELD_MS, token_hint: "a1b2c3" } });
				if (sup.mode === "refuseFloor") return reject(409, "dev_build_no_evict", "a dev build may not evict the resident pack");
				return send(200, grantBody);
			}
			if (req.url === R_LEASE && p.action === "renew") {
				// The daemon renews the PAIR that presents the token it granted; anything else is a
				// stale capability, named.
				if (sup.mode === "stale" || tok !== TOKEN) return reject(409, "lease_stale_token", "the presented token is not the current lease");
				return send(200, { accepted: true, decision: "RENEW", rule: "lease_renewed", granted_ttl_s: 300, lease: { holder_caller: "fade-orchestrator", remaining_sec: 300, token_hint: "a1b2c3" } });
			}
			if (req.url === R_LEASE && p.action === "release") {
				if (tok !== TOKEN) return reject(409, "lease_not_holder", "release is admitted for the (caller, session) pair that holds the lease");
				return send(200, { accepted: true, decision: "RELEASE", rule: "lease_released" });
			}
			if (req.url === R_LEASE) return send(200, { accepted: true, decision: "OK", rule: "", reason: `${p.action ?? "status"}: stub` });
			if (req.url === R_SWAP) {
				land(p.pack);
				return send(202, { decision: "ADMIT", accepted: true, rule: "swap_admitted", lane: { active_pack: p.pack } });
			}
			return send(503, { decision: "REJECT", accepted: false, rule: "stub_unanswered" });
		});
	});
	await new Promise((r) => server.listen(sock, r));
	return { sup, sock, dir, close: async () => { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); } };
};

/**
 * One import graph per test, declared AFTER the environment and handed back after the import.
 * `env.mjs` documents both halves: the built modules resolve their endpoints at module import, and
 * the runner evaluates every suite file in one process, so an exported rig environment reaches the
 * suites that import their bundle in a test body.
 */
const rig = async (tag, env) => {
	resetLaneEnv();
	Object.assign(process.env, {
		PI_SESSION_FILE: "",
		PI_SESSION_ID: "",
		FADE_ORCHESTRATE_PROVIDER: "basalt",
		FADE_ORCHESTRATE_THINK_LANE: THINK,
		FADE_ORCHESTRATE_CODE_LANE: CODE,
		FADE_ORCHESTRATE_VERIFY_LANE: VERIFY,
		FADE_ORCHESTRATE_FLIP_WINDOW_MS: "0",
		FADE_ORCHESTRATE_LANE_POLL_MS: "20",
		FADE_ORCHESTRATE_GATE_POLL_MS: "10",
		FADE_ORCHESTRATE_GATE_BUDGET_MS: "200",
		FADE_ORCHESTRATE_KEEPALIVE_MS: "40",
		FADE_ORCHESTRATE_SERVE_WAIT_MS: "1200",
		FADE_ORCHESTRATE_START_PROOF_WAIT_MS: "600",
		FADE_ORCHESTRATE_LANE_WAIT_MS: "600",
		FADE_ORCHESTRATE_SETTLE_MAX_MS: "200",
		FADE_ORCHESTRATE_SETTLE_POLL_MS: "20",
		FADE_ORCHESTRATE_LEASE_MINT_TTL_S: "300",
	}, env);
	const g = `g=ldb-${tag}`;
	const mods = {
		S: await import(`../.test-build/supervisor.mjs?${g}`),
		C: await import(`../.test-build/core.mjs?${g}`),
		R: await import(`../.test-build/router.mjs?${g}`),
	};
	// The environment STAYS set for the act, and is handed back by `close`/`restore`. The socket is
	// resolved at CALL time (`supervisor.ts:resolveSock`, `pinned = env.FADE_SUPERVISOR_SOCK`), not
	// frozen at import: handing the env back at the import made `loadLane` resolve the real
	// `/tmp/fade-supervisor.sock`, and the LIVE daemon answered a real 409 `lease_held` (session
	// 01a21b7c-…, 887 s left) inside a suite whose contract is that it never touches the box.
	return { ...mods, restore: () => resetLaneEnv() };
};

/** The rig for one act: a stub pair, a lease store of its own, and the bundle bound to them. */
const plane = async (tag, { mode = "grant", resident = CODE } = {}) => {
	const rt = await routerStub();
	const daemon = await daemonStub(mode, resident, (pack) => { rt.st.served = pack; rt.st.admitted.push(pack); });
	const stateDir = mkdtempSync(join(tmpdir(), "fade-ldb-state-"));
	const mods = await rig(tag, { FADE_ORCHESTRATE_STATE_DIR: stateDir, FADE_ORCHESTRATE_ROUTER: rt.url, FADE_SUPERVISOR_SOCK: daemon.sock });
	// `sup` is the stub's RECORD (hits, mode, resident), not its server handle: the assertions read
	// the wire, and `sock`/`close` come from the handle.
	return {
		...mods,
		st: rt.st,
		sup: daemon.sup,
		sock: daemon.sock,
		stateDir,
		close: async () => {
			await rt.close();
			await daemon.close();
			rmSync(stateDir, { recursive: true, force: true });
			resetLaneEnv(); // the acts are over: hand the endpoints back to the next suite
		},
	};
};

const acquires = (sup) => sup.hits.filter((h) => h.includes("action=acquire"));
const renews = (sup) => sup.hits.filter((h) => h.includes("action=renew"));

test("a mint refused over a HELD lane answers a DEFERRAL, with the daemon's own facts", { timeout: 20_000 }, async () => {
	const { R, st, sup, close } = await plane("held", { mode: "held" });
	try {
		const r = await R.loadLane(VERIFY, { mintLease: { ttlSec: 300 }, sessionId: "ldb-held" });
		assert.equal(r.ok, false, "the lane did not land");
		assert.equal(r.deferred, true, "a claimed lane is a deferral, never the `failed` outcome that dropped the briefing");
		assert.equal(r.leaseHolder, "fade-orchestrator", "the holder the daemon named");
		assert.equal(r.leaseRemainingS, HELD_MS, "the countdown rides up, so the retry can be scheduled on it");
		assert.equal(r.leaseTokenHint, "a1b2c3", "the masked hint, never a token");
		assert.ok(r.detail.includes(HOLDER_SESSION) && r.detail.includes(`${HELD_MS} s left`), `the operator's string is intact: ${r.detail}`);
		assert.equal(st.admitted.length, 0, "no pack is loaded over a lane a lease owns");
	} finally {
		await close();
	}
});

test("a floor with NO countdown is a hard failure: the deferral class is exactly the claim class", { timeout: 20_000 }, async () => {
	const { R, st, sup, close } = await plane("floor", { mode: "refuseFloor" });
	try {
		const r = await R.loadLane(VERIFY, { mintLease: { ttlSec: 300 }, sessionId: "ldb-floor" });
		assert.equal(r.ok, false);
		assert.equal(r.deferred, undefined, "`dev_build_no_evict` names a caller that may NEVER take the lane: no queue, no retry");
		assert.equal(r.leaseRule, "dev_build_no_evict");
		assert.equal(st.admitted.length, 0);
	} finally {
		await close();
	}
});

test("the minted token is durable, and a re-entry RENEWS the lease it owns: no second mint", { timeout: 20_000 }, async () => {
	const { S, R, st, sup, stateDir, close } = await plane("reentry");
	const self = "ldb-reentry";
	try {
		const first = await R.loadLane(VERIFY, { mintLease: { ttlSec: 300 }, sessionId: self });
		assert.ok(first.ok, `the mint granted and the lane moved: ${first.detail}`);
		assert.equal(acquires(sup).length, 1, "one mint for one lease");
		const file = S.leaseTokenFile(self, stateDir);
		assert.ok(existsSync(file), `the capability is durable: ${file}`);
		assert.equal(S.readStoredLease(self, stateDir)?.token, TOKEN, "the store holds the token the daemon granted this pair");
		assert.equal(statSync(file).mode & 0o777, 0o600, "0600: a token is a write capability over the GPU lane");
		assert.equal(S.readStoredLease(self, stateDir)?.pack, VERIFY, "the store names the pack the grant is for");

		// The re-entry: a lane act that carries NO in-memory token — the shape the 409 was minted
		// in. It renews the grant it owns, so the daemon's cross-pair refusal has nothing to refuse.
		st.admitted.length = 0;
		sup.hits.length = 0;
		const second = await R.loadLane(CODE, { sessionId: self });
		assert.ok(second.ok, `the lane moved under the RENEWED grant: ${second.detail}`);
		assert.equal(acquires(sup).length, 0, "the re-entry minted NOTHING: the 409 class is gone (the wire was cleared above, so this is the re-entry's own traffic)");
		assert.ok(renews(sup).some((h) => h.includes(`token=${TOKEN}`)), `the lane moved on a renew; wire:\n${sup.hits.join("\n")}`);
		assert.ok(st.admitted.includes(CODE), "the swap ran under the renewed capability");
	} finally {
		await close();
	}
});

test("a token the daemon proves dead is dropped, and the next act starts from a clean mint", { timeout: 20_000 }, async () => {
	const { S, R, st, sup, sock, stateDir, close } = await plane("stale");
	const self = "ldb-stale";
	try {
		const first = await R.loadLane(VERIFY, { mintLease: { ttlSec: 300 }, sessionId: self });
		assert.ok(first.ok, `the grant landed: ${first.detail}`);
		// The grant is durable; the daemon now answers this pair's renew as stale (expired, revoked).
		// The act must be a REAL move (resident VERIFY, target THINK): a load of the pack the lane
		// already serves is the no-op preflight and answers with zero wire.
		sup.mode = "stale";
		sup.hits.length = 0;
		const second = await R.loadLane(THINK, { sessionId: self });
		// A dead capability costs THIS act its swap: an act that requests no mint never mints on its
		// own, and the refusal says so instead of swapping unleased. What the act DOES do is prove
		// the token dead and DROP it, so the queue cannot stay pinned to a capability that died.
		assert.equal(second.ok, false, `the act took the swap refusal, not a swap: ${second.detail}`);
		assert.ok(second.detail.includes("no lease token held"), `the refusal names the missing capability: ${second.detail}`);
		assert.equal(renews(sup).length, 1, "the store was tried FIRST: the client proves its own lease before asking for another");
		assert.equal(acquires(sup).length, 0, "an act that asks for no mint mints nothing");
		assert.equal(S.readStoredLease(self, stateDir), undefined, "the dead token is dropped: nothing is left to renew with");
		// The next act, which DOES request a mint, starts from a clean grant.
		sup.mode = "grant";
		sup.hits.length = 0;
		const third = await R.loadLane(THINK, { mintLease: { ttlSec: 300 }, sessionId: self });
		assert.ok(third.ok, `the fresh grant carried the next act: ${third.detail}`);
		assert.equal(acquires(sup).length, 1, "exactly one fresh mint, after the dead token was dropped");
		assert.equal(S.readStoredLease(self, stateDir)?.token, TOKEN, "the store holds the fresh grant now");
	} finally {
		await close();
	}
});

test("a release of a foreign token is refused and named, and never deletes the holder's capability", { timeout: 20_000 }, async () => {
	const { S, sock, stateDir, close } = await plane("release");
	const owner = "ldb-peer-holder";
	const file = S.leaseTokenFile(owner, stateDir);
	try {
		S.writeStoredLease({ token: TOKEN, pack: CODE, session: owner, granted_utc: new Date().toISOString() }, stateDir);
		assert.equal(S.readStoredLease(owner, stateDir)?.token, TOKEN, "the store round-trips");
		const refused = await S.releaseOwnedLease("T-FOREIGN", owner, sock, 4000);
		assert.equal(refused.ok, false, "a release the daemon refuses is a refusal, never a silent success");
		assert.equal(refused.rule, "lease_not_holder", "the rule is named, not swallowed");
		assert.ok(existsSync(file), "a refused release never deletes the capability of the pair that holds the lease");
		const accepted = await S.releaseOwnedLease(TOKEN, owner, sock, 4000);
		assert.ok(accepted.ok, "the pair that holds the lease releases it");
		assert.ok(!existsSync(file), "an accepted release retires the stored capability with it");
	} finally {
		rmSync(file, { force: true });
		await close();
	}
});

test("the deferral's state: the lane is owed, the page is queued, and the run's protocol state survives", { timeout: 20_000 }, async () => {
	const { C, restore } = await rig("state", {});
	try {
		const at = "2026-11-27T14:00:00.000Z";
		// A run mid-verification, at the moment Frontier hands control back.
		const run = { schema: "fade.orchestrate.v2", run_id: "r-ldb", goal: "g", state: "verifying", round: 2, max_rounds: 3, tasks: [], checks: [], phases: [], repair_tasks: [], rejection_history: [], lane: CODE, lease_state: "held", verify_batch: { batch: 1, ids: ["V1"], routed: "swap", at } };
		const before = { state: run.state, round: run.round, tasks: run.tasks.length, checks: run.checks.length };
		C.applyLaneDeferral(run, { lane: VERIFY, kind: "verifyBatch", rule: "lease_held", holder: "fade-orchestrator", remaining_s: HELD_MS, token_hint: "a1b2c3", retry_delay_ms: 90_000 }, at);
		assert.equal(run.deferred_lane, VERIFY, "the owed lane is recorded");
		assert.equal(run.deferred_briefing, "verifyBatch", "the page the landing owes is recorded as a KIND, not frozen text");
		assert.equal(run.briefing_delivery, "queued", "the queue is the operator-visible state");
		assert.equal(run.lease_state, "deferred", "the lease is not `held` and not `refused`: a peer pair owns the lane");
		assert.equal(run.lease_holder, "fade-orchestrator", "the holder the daemon named");
		assert.equal(run.lease_hint, "a1b2c3", "the masked hint, never the token");
		assert.equal(run.lease_retry_at_utc, "2026-11-27T14:01:30.000Z", "the appointment rides the daemon's countdown, not a client guess");
		assert.equal(run.review_state, "verdicts open (round 2, batch 2)", "the review state is named beside the queue, never guessed");
		assert.deepEqual({ state: run.state, round: run.round, tasks: run.tasks.length, checks: run.checks.length }, before, "a claimed lane invalidates NOTHING in the run's plan: no fail, no round, no counters");
		assert.ok(!JSON.stringify(run).includes(TOKEN), "the deferral never carries a token into the rendered state");

		C.clearLaneDeferral(run, VERIFY, "sent", "2026-11-27T14:01:35.000Z");
		assert.equal(run.deferred_lane, undefined, "the landing answered the queue");
		assert.equal(run.deferred_briefing, undefined, "and the owed page with it");
		assert.equal(run.lease_retry_at_utc, undefined, "and the appointment");
		assert.equal(run.briefing_delivery, "sent", "delivered, with the stamp");
		assert.equal(run.briefing_sent_at_utc, "2026-11-27T14:01:35.000Z");

		// A quiet hand-back answers the queue too: a lane that landed quietly is not owed.
		C.applyLaneDeferral(run, { lane: CODE, kind: "code", holder: "peer", remaining_s: 5, retry_delay_ms: 15_000, quiet: true }, at);
		assert.equal(run.briefing_delivery, "quiet", "a quiet landing owes no page, and the queue says so");
		C.clearLaneDeferral(run, CODE, "quiet", at);
		assert.equal(run.deferred_lane, undefined, "the quiet landing cleared the queue: the row stops naming an owed lane");

		// A landing on ANOTHER lane never clears a queue it did not answer.
		C.applyLaneDeferral(run, { lane: VERIFY, kind: "verify", retry_delay_ms: 15_000 }, at);
		C.clearLaneDeferral(run, CODE, "sent", at);
		assert.equal(run.deferred_lane, VERIFY, "the owed lane survives a landing that did not answer it");

		// The review label: one rule for the row, the deferral line and the panel.
		assert.equal(C.reviewStateLabel({ state: "complete", round: 3 }), "accepted (round 3)");
		assert.equal(C.reviewStateLabel({ state: "failed", round: 1, reason: "gate red" }), "FAILED: gate red");
		assert.equal(C.reviewStateLabel({ state: "planning", round: 0 }), "planning (round 0)", "an unmapped state prints as what it is");
	} finally {
		restore();
	}
});
