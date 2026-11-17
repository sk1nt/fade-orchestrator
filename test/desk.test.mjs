/**
 * The verification desk: the batching rule, the one-use claim, the verdict fan-out, and the
 * worker's bounded block.
 *
 * The load-bearing tests are the ones that prove a batch is NOT answered per arrival (the churn
 * the operator named): one registration with two workers expected answers `not ready`, and the
 * same epoch is claimed exactly once, so the batch that is answered is answered once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	DESK_SCHEMA,
	attachVerdicts,
	awaitVerdict,
	claimBatch,
	deskCensus,
	deskLine,
	deskPath,
	emptyDesk,
	enqueueRequest,
	mutateDesk,
	noteTaskBatch,
	openRequests,
	parseDesk,
	readDesk,
	readyToAddress,
	requestById,
	sealBatch,
	setChurn,
} from "../.test-build/desk.mjs";

const T0 = Date.parse("2000-01-01T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

/** A desk with an open epoch and `n` workers' registrations, `expected` workers launched. */
function deskWith({ expected = 0, registrations = [], at = T0 } = {}) {
	let d = { ...emptyDesk("run-1", iso(at)), expected: expected > 0 ? expected : registrations.length };
	for (const r of registrations) d = enqueueRequest(d, { agent: r.agent ?? "scout", session: `s-${r.agent ?? "scout"}`, objective: r.objective ?? `verify ${r.agent ?? "scout"}`, checks: r.checks }, iso(at + (r.at ?? 0))).desk;
	return d;
}

test("an empty desk is never addressable — no arrival, no lane load", () => {
	const d = emptyDesk("run-1", iso(T0));
	const r = readyToAddress(d, T0);
	assert.equal(r.ready, false);
	assert.equal(r.reason, "desk_empty");
});

test("one worker registered while two are expected is NOT ready — the batch waits for its peers", () => {
	const d = deskWith({ expected: 2, registrations: [{ agent: "scout", at: 0 }] });
	const r = readyToAddress(d, T0 + 1_000, { settleMs: 8_000, deadlineMs: 120_000 });
	assert.equal(r.ready, false, `must not pay a swap for one of two: ${r.reason}`);
	assert.match(r.reason, /waiting for the batch to close: 1\/2/);
	assert.equal(r.open, 1);
});

test("the batch closes the instant every expected worker has registered — one pass addresses all", () => {
	const d = deskWith({ expected: 3, registrations: [{ agent: "a", at: 0 }, { agent: "b", at: 1_000 }, { agent: "c", at: 2_000 }] });
	const r = readyToAddress(d, T0 + 3_000, { settleMs: 8_000, deadlineMs: 120_000 });
	assert.equal(r.ready, true);
	assert.equal(r.reason, "all_registered");
	assert.equal(r.open, 3);
});

test("the launching task call settling seals the batch — every registration it will produce has landed", () => {
	const open = deskWith({ expected: 2, registrations: [{ agent: "a" }] });
	assert.equal(readyToAddress(open, T0 + 1_000).ready, false);
	const sealed = sealBatch(open, iso(T0 + 1_500));
	const r = readyToAddress(sealed, T0 + 1_600, { settleMs: 8_000 });
	assert.equal(r.ready, true);
	assert.equal(r.reason, "sealed");
});

test("the settle window and the hard deadline close a batch the task call never sealed", () => {
	const d = deskWith({ expected: 5, registrations: [{ agent: "a", at: 0 }] });
	assert.equal(readyToAddress(d, T0 + 3_000, { settleMs: 8_000, deadlineMs: 120_000 }).ready, false);
	assert.equal(readyToAddress(d, T0 + 9_000, { settleMs: 8_000, deadlineMs: 120_000 }).reason, "settled");
	assert.equal(readyToAddress(d, T0 + 130_000, { settleMs: 8_000, deadlineMs: 120_000 }).reason, "deadline");
});

test("a claim is one-use: the batch is answered once, and a later arrival lands in the NEXT batch", () => {
	const d = deskWith({ expected: 2, registrations: [{ agent: "a", at: 0 }, { agent: "b", at: 500 }] });
	const claimed = claimBatch(d, "swap", iso(T0 + 1_000));
	assert.deepEqual(claimed.ids, ["V1.1", "V1.2"]);
	assert.equal(claimed.desk.epoch, 1);
	assert.equal(claimed.desk.addressed.length, 1);
	assert.equal(claimed.desk.addressed[0].routed, "swap");
	// The epoch advanced, so nothing is live: re-claiming addresses nothing, ever.
	assert.equal(readyToAddress(claimed.desk, T0 + 2_000).reason, "desk_empty");
	assert.deepEqual(claimBatch(claimed.desk, "swap", iso(T0 + 2_000)).ids, []);
	// A worker that registers during verification waits for the next pass — no second swap.
	const late = enqueueRequest(claimed.desk, { agent: "c", session: "s-c", objective: "verify c" }, iso(T0 + 1_500)).desk;
	assert.equal(requestById(late, "V2.1").batch, 1);
	assert.equal(openRequests(late).length, 1);
	const ready = readyToAddress(late, T0 + 1_600, { settleMs: 8_000, deadlineMs: 120_000 });
	assert.equal(ready.ready, false, "the new epoch has no launched task call named yet");
});

test("one worker registers once per objective — a second call reuses the request, never widens the batch", () => {
	const first = enqueueRequest(emptyDesk("run-1", iso(T0)), { agent: "scout", session: "s", objective: "verify the gate" });
	const again = enqueueRequest(first.desk, { agent: "scout", session: "s", objective: "verify the gate" });
	assert.equal(again.deduped, true);
	assert.equal(again.request.id, first.request.id);
	assert.equal(again.desk.requests.length, 1);
	assert.equal(again.desk.agents.length, 1);
});

test("expected only grows: a second delegation wave keeps the ceiling, so a batch cannot close early", () => {
	let d = noteTaskBatch(emptyDesk("run-1", iso(T0)), { count: 3, agents: ["a", "b", "c"] });
	assert.equal(d.expected, 3);
	d = noteTaskBatch(d, { count: 1, agents: ["d"] });
	assert.equal(d.expected, 3, "a shrinking expected closes the batch while peers are unregistered");
	assert.deepEqual(d.agents, ["a", "b", "c", "d"]);
});

test("verdicts fan out by id, and an id the desk does not hold is named, not absorbed", () => {
	const d = deskWith({ expected: 2, registrations: [{ agent: "a" }, { agent: "b" }] });
	const claimed = claimBatch(d, "swap", iso(T0 + 1)).desk;
	const res = attachVerdicts(claimed, [{ id: "V1.1", accepted: true, notes: "cargo test: 2 passed" }, { id: "V9.9", accepted: true, notes: "invented" }], iso(T0 + 2));
	assert.deepEqual(res.attached, ["V1.1"]);
	assert.deepEqual(res.unknown, ["V9.9"]);
	assert.equal(requestById(res.desk, "V1.1").verdict.accepted, true);
	assert.equal(requestById(res.desk, "V1.1").verdict.notes, "cargo test: 2 passed");
	assert.equal(requestById(res.desk, "V1.2").verdict, undefined, "the second worker is still owed its verdict");
	const c = deskCensus(res.desk);
	assert.equal(c.answered, 1);
	assert.equal(c.owed, 1);
});

test("churn is a declared state with a timestamp, and it is releasable", () => {
	const on = setChurn(emptyDesk("run-1", iso(T0)), true, iso(T0));
	assert.equal(on.churn, true);
	assert.equal(on.churn_utc, iso(T0));
	assert.match(setChurn(on, false, iso(T0 + 1)).churn_utc ?? "", /^$/);
	assert.equal(setChurn(on, false, iso(T0 + 1)).churn, false);
	assert.match(deskLine(setChurn(emptyDesk("run-1", iso(T0)), true)), /CHURN ROUTE/);
});

test("parseDesk refuses a foreign record and normalizes the shapes a model writes", () => {
	assert.equal(parseDesk({ schema: "other", epoch: 0 }), undefined);
	assert.equal(parseDesk({ schema: DESK_SCHEMA, run_id: "run-2", epoch: 0 }, "run-1"), undefined);
	const ok = parseDesk({
		schema: DESK_SCHEMA,
		run_id: "run-1",
		epoch: 2,
		open_utc: iso(T0),
		requests: [
			{ id: "V3.1", agent: "scout", objective: "x", checks: [{ cmd: "npm test", expected: "exit 0" }] },
			{ objective: "no id — not a request" },
		],
	});
	assert.equal(ok.epoch, 2);
	assert.equal(ok.requests.length, 1);
	assert.deepEqual(ok.requests[0].checks, [["npm test", "exit 0"]]);
	assert.deepEqual(ok.addressed, []);
});

test("the desk file: two sessions writing in the same instant both land", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fade-desk-"));
	try {
		const a = mutateDesk(dir, "run-1", (d) => enqueueRequest(d, { agent: "a", session: "sa", objective: "verify a" }).desk);
		const b = mutateDesk(dir, "run-1", (d) => enqueueRequest(d, { agent: "b", session: "sb", objective: "verify b" }).desk);
		const [da, db] = await Promise.all([a, b]);
		const onDisk = await readDesk(dir, "run-1");
		assert.equal(onDisk.requests.length, 2, `both registrations must survive: ${da.requests.length}/${db.requests.length} in memory`);
		assert.deepEqual(onDisk.agents.slice().sort(), ["a", "b"]);
		// The file is a real JSON record, and the run key is carried for the reader's refusal.
		assert.equal(JSON.parse(readFileSync(deskPath(dir), "utf8")).run_id, "run-1");
		assert.equal(await readDesk(dir, "other-run"), undefined, "a desk of another run is never read as this run's");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a worker's block is answered by the fan-out, and bounded when its own verdict never lands", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fade-desk-wait-"));
	try {
		// Two workers of one batch: the verifier answers one of them, so the other's request is the
		// real shape of a partial pass — a verdict for a PEER must never unblock this worker.
		const enq = enqueueRequest(emptyDesk("run-1"), { agent: "scout", session: "s1", objective: "verify a" }).desk;
		const two = enqueueRequest(enq, { agent: "task", session: "s2", objective: "verify b" }).desk;
		const claimed = claimBatch(two, "swap");
		await mutateDesk(dir, "run-1", () => claimed.desk);
		const post = setTimeout(async () => {
			await mutateDesk(dir, "run-1", (d) => attachVerdicts(d, [{ id: "V1.1", accepted: false, notes: "cargo clippy: 2 errors" }]).desk);
		}, 40);
		const wait = await awaitVerdict(dir, "run-1", "V1.1", { pollMs: 10, timeoutMs: 5_000 });
		clearTimeout(post);
		assert.equal(wait.state, "answered");
		assert.equal(wait.request.verdict.accepted, false);
		assert.match(wait.note, /needs_repair: cargo clippy: 2 errors/);

		// V1.2's batch was claimed and no pass answered it: the block ENDS by name, and the request
		// stays on the desk for the next pass — a worker is never parked forever.
		const stalled = await awaitVerdict(dir, "run-1", "V1.2", { pollMs: 10, timeoutMs: 60 });
		assert.equal(stalled.state, "deferred");
		assert.match(stalled.note, /owed its verification pass/);
		const d = await readDesk(dir, "run-1");
		assert.equal(d.requests.filter((r) => r.verdict).length, 1);
		assert.equal(deskCensus(d).owed, 1, "the unanswered one is counted as owed, not absorbed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
