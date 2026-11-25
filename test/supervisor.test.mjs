/**
 * The fade-supervisor lane-lease client (supervisor.ts).
 *
 * Two layers proved, no live daemon and no hardware:
 *  1. the pure shapers — socket resolution, the X-Fade-* header set, the
 *     request bodies, the token mask, and the verdict mapping (grant, the 409
 *     lease floors, swap acceptance) — table-driven on the input shapes;
 *  2. the transport — acquire -> swap -> release driven against a real HTTP
 *     server bound to a Unix socket path, asserting the exact bytes on the wire
 *     (the lease token is threaded into the swap, build=prod is sent, the
 *     phase_boundary assertion rides) and that a 409 lease_not_holder is
 *     surfaced as a refusal, never a silent success.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireBody,
	acquireLease,
	fadeHeaders,
	leaseLine,
	leaseVerdict,
	maskToken,
	releaseBody,
	releaseLease,
	renewBody,
	resolveSock,
	statusBody,
	swapBody,
	swapLeased,
	swapVerdict,
	CALLER,
	BUILD_PROD,
	ROOT_SOCK,
	USER_SOCK,
	RULE_LEASE_NOT_HOLDER,
	RULE_LEASE_HELD,
	RULE_LEASE_STALE_TOKEN,
} from "../.test-build/supervisor.mjs";

// ---- pure shapers.

test("the socket resolves env-first, then root=/run and non-root=/tmp", () => {
	assert.equal(resolveSock({ FADE_SUPERVISOR_SOCK: "/custom/sock" }, 0), "/custom/sock");
	assert.equal(resolveSock({ FADE_SUPERVISOR_SOCK: "/custom/sock" }, 1000), "/custom/sock");
	assert.equal(resolveSock({}, 0), ROOT_SOCK);
	assert.equal(resolveSock({}, 1000), USER_SOCK);
	// An empty env value is not a path: fall through to the privilege rule.
	assert.equal(resolveSock({ FADE_SUPERVISOR_SOCK: "" }, 1000), USER_SOCK);
});

test("every write carries the accountability headers with prod eviction authority", () => {
	const h = fadeHeaders("sess-42");
	assert.equal(h["x-fade-caller"], CALLER);
	assert.equal(h["x-fade-caller"], "fade-orchestrator");
	assert.equal(h["x-fade-build"], BUILD_PROD);
	assert.equal(h["x-fade-build"], "prod");
	assert.equal(h["x-fade-session-id"], "sess-42");
	assert.equal(h["content-type"], "application/json");
	// A dev build is nameable (the daemon refuses its acquire) but the client's
	// default is prod, the authority.
	assert.equal(fadeHeaders("s", "dev")["x-fade-build"], "dev");
});

test("the bodies carry the daemon's exact wire fields", () => {
	assert.deepEqual(acquireBody("deepseek", 900), { action: "acquire", pack: "deepseek", ttl_s: 900, reason: "plan-authority" });
	assert.deepEqual(renewBody("tok", 300), { action: "renew", token: "tok", ttl_s: 300 });
	assert.deepEqual(releaseBody("tok"), { action: "release", token: "tok", reason: "return-coder" });
	assert.deepEqual(statusBody(), { action: "status" });
	// A swap asserts phase_boundary and carries the lease token.
	const s = swapBody("deepseek", "tok-abc");
	assert.equal(s.phase_boundary, true);
	assert.equal(s.pack, "deepseek");
	assert.equal(s.lease_token, "tok-abc");
});

test("maskToken never reveals the secret", () => {
	const tok = "a1b2c3d4e5f60718293a";
	const m = maskToken(tok);
	assert.ok(m.startsWith("a1b2"), m);
	assert.ok(m.includes(`(${tok.length})`), m);
	assert.ok(!m.includes(tok), "the raw token must never appear in the mask");
	assert.equal(maskToken(""), "");
	assert.equal(maskToken(undefined), "");
});

test("a lease grant maps ok + token + TTL; a 409 surfaces the holder and mints no token", () => {
	const grant = leaseVerdict({ status: 200, body: { decision: "GRANTED", accepted: true, rule: "acquired", granted_ttl_s: 900, token: "tok", lease: { holder_caller: "fade-orchestrator" } }, raw: "" });
	assert.equal(grant.ok, true);
	assert.equal(grant.token, "tok");
	assert.equal(grant.granted_ttl_s, 900);
	assert.equal(grant.holder, "fade-orchestrator");

	// The daemon's acquire refusal: rule lease_held, the top-level lease block
	// left zero, the holder published at lane.lease (server.go dispatchLease).
	const held = leaseVerdict({ status: 409, body: { decision: "REJECT", accepted: false, rule: RULE_LEASE_HELD, reason: "lane held by other", lease: { held: false, remaining_sec: 0 }, lane: { lease: { holder_caller: "other", holder_session: "s-2", remaining_sec: 400 } } }, raw: "" });
	assert.equal(held.ok, false);
	assert.equal(held.rule, RULE_LEASE_HELD);
	assert.equal(held.holder, "other");
	assert.equal(held.remaining_s, 400);
	assert.equal(held.token, undefined, "a refusal never mints a token");
	assert.ok(leaseLine(held).includes("other"), "lease held must name the holder: " + leaseLine(held));
	assert.ok(leaseLine(held).includes("400s"), leaseLine(held));
});

test("a swap is accepted only at 200/202 with accepted:true; a 409 lease floor is a named refusal", () => {
	assert.equal(swapVerdict({ status: 202, body: { decision: "ADMITTED", accepted: true, lane: { pack: "deepseek" } }, raw: "" }).ok, true);
	assert.equal(swapVerdict({ status: 200, body: { decision: "NOOP", accepted: true }, raw: "" }).ok, true);
	assert.equal(swapVerdict({ status: 200, body: { decision: "REJECT", accepted: false }, raw: "" }).ok, false);
	const refused = swapVerdict({ status: 409, body: { decision: "REJECT", accepted: false, rule: RULE_LEASE_NOT_HOLDER, reason: "not the holder" }, raw: "" });
	assert.equal(refused.ok, false);
	assert.equal(refused.rule, RULE_LEASE_NOT_HOLDER);
});

test("leaseLine names the holder and countdown, never the token", () => {
	const line = leaseLine({ ok: false, status: 409, decision: "REJECT", rule: RULE_LEASE_NOT_HOLDER, reason: "x", holder: "other-run", remaining_s: 250, token: "SECRET-TOKEN" });
	assert.ok(line.includes("other-run"), line);
	assert.ok(line.includes("250s"), line);
	assert.ok(!line.includes("SECRET-TOKEN"), "the line never renders the token");
});

// ---- the transport, against a stub daemon on a real Unix socket.

/** A stub supervisor: records every lease/swap body + header, answers the script. */
function startStub() {
	const calls = [];
	const state = { grantToken: "tok-xyz", leaseHeldByOther: false };
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", () => {
			const body = JSON.parse(raw || "{}");
			calls.push({ url: req.url, body, headers: req.headers });
			const send = (status, obj) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(obj));
			};
			if (req.url === "/v1/lease" && body.action === "acquire") {
				if (state.leaseHeldByOther) return send(409, { decision: "REJECT", accepted: false, rule: RULE_LEASE_HELD, reason: "lane held by other", lease: { held: false, remaining_sec: 0 }, lane: { lease: { holder_caller: "other-session", holder_session: "s-2", remaining_sec: 400 } } });
				return send(200, { decision: "GRANTED", accepted: true, rule: "acquired", granted_ttl_s: 1800, token: state.grantToken, lease: { holder_caller: CALLER, token_hint: "tok-" } });
			}
			if (req.url === "/v1/swap") {
				// The daemon admits only the token holder; a non-holder token is a 409.
				if (body.lease_token !== state.grantToken) return send(409, { decision: "REJECT", accepted: false, rule: RULE_LEASE_NOT_HOLDER, reason: "swap admitted only for the lease holder", lane: { lease: { holder_caller: "other-session", remaining_sec: 400 } } });
				return send(202, { decision: "ADMITTED", accepted: true, rule: "admitted", lane: { state: "live", active_pack: body.pack } });
			}
			if (req.url === "/v1/lease" && body.action === "release") {
				if (body.token !== state.grantToken) return send(403, { decision: "REJECT", accepted: false, rule: RULE_LEASE_STALE_TOKEN, reason: "stale token" });
				return send(200, { decision: "RELEASED", accepted: true, rule: "released", lease: {} });
			}
			send(404, { decision: "REJECT", accepted: false, rule: "no_route" });
		});
	});
	// A Unix socket path must be short and the dir must be writable: a unique
	// file under tmpdir, cleaned up by the caller.
	const sock = join(tmpdir(), `fs-sup-test-${process.pid}-${Math.random().toString(36).slice(2, 7)}.sock`);
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(sock, () => resolve({ server, sock, calls, state, close: () => new Promise((r) => { server.close(() => { try { unlinkSync(sock); } catch {} r(null); }); }) }));
	});
}

test("acquire -> swap -> release threads the lease token to the swap and sends prod headers", async () => {
	const stub = await startStub();
	try {
		const grant = await acquireLease("deepseek", 1800, "run-1", stub.sock);
		assert.equal(grant.ok, true);
		assert.ok(grant.token, "the grant carries the token");

		const swap = await swapLeased("deepseek", grant.token, "run-1", stub.sock);
		assert.equal(swap.ok, true);
		assert.equal(swap.resident, "deepseek");
		assert.equal(swap.decision, "ADMITTED");

		const rel = await releaseLease(grant.token, "run-1", stub.sock);
		assert.equal(rel.ok, true);
		assert.equal(rel.decision, "RELEASED");

		// The swap byte: phase_boundary true, the grant's token, build prod, caller.
		const swapCall = stub.calls.find((c) => c.url === "/v1/swap");
		assert.equal(swapCall.body.phase_boundary, true);
		assert.equal(swapCall.body.lease_token, grant.token);
		assert.equal(swapCall.body.pack, "deepseek");
		assert.equal(swapCall.headers["x-fade-build"], "prod");
		assert.equal(swapCall.headers["x-fade-caller"], "fade-orchestrator");
		assert.equal(swapCall.headers["x-fade-session-id"], "run-1");

		// The grant never sends a token (it mints one); the release presents it.
		const acquireCall = stub.calls.find((c) => c.url === "/v1/lease" && c.body.action === "acquire");
		assert.equal(acquireCall.body.action, "acquire");
		assert.equal(acquireCall.body.pack, "deepseek");
		assert.equal(acquireCall.body.ttl_s, 1800);
		const releaseCall = stub.calls.find((c) => c.body.action === "release");
		assert.equal(releaseCall.body.token, grant.token);
	} finally {
		await stub.close();
	}
});

test("a peer holding the lane: acquire is 409 lease_not_holder, naming the holder; the swap is refused for a non-holder token", async () => {
	const stub = await startStub();
	stub.state.leaseHeldByOther = true;
	try {
		const grant = await acquireLease("deepseek", 1800, "run-2", stub.sock);
		assert.equal(grant.ok, false);
		assert.equal(grant.rule, RULE_LEASE_HELD);
		assert.equal(grant.holder, "other-session");
		assert.equal(grant.remaining_s, 400);
		assert.ok(leaseLine(grant).includes("other-session"), "the deferring caller sees the holder: " + leaseLine(grant));
		assert.equal(grant.token, undefined);

		// A swap presented with a token the daemon never minted is refused, not silently ok.
		const swap = await swapLeased("deepseek", "forged", "run-2", stub.sock);
		assert.equal(swap.ok, false);
		assert.equal(swap.rule, RULE_LEASE_NOT_HOLDER);
	} finally {
		await stub.close();
	}
});

test("a dead socket is a transport error, never a fabricated success", async () => {
	const missing = join(tmpdir(), `fs-sup-dead-${process.pid}-${Math.random().toString(36).slice(2, 7)}.sock`);
	assert.ok(!existsSync(missing));
	await assert.rejects(() => acquireLease("deepseek", 1800, "run-3", missing), /./);
});
