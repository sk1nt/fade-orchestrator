import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frontierIsActive, frontierPhase, frontierPhaseFromHistory, queueHandover, readFrontierPhase } from "../.test-build/recovery.mjs";

test("the journal observes slash-command aborts and checks every active task", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "fade-frontier-ownership-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const first = join(root, "session", "first");
	const second = join(root, "session", "second");
	await mkdir(first, { recursive: true });
	await mkdir(second);
	const save = (directory, phase) => writeFile(join(directory, "task.json"), JSON.stringify({ taskId: "fixture", rounds: 1, phase }));
	await save(first, "review");
	await save(second, "done");
	assert.equal(await readFrontierPhase("session", root), "review");
	await save(first, "aborted");
	assert.equal(await readFrontierPhase("session", root), "none");
	assert.equal(await readFrontierPhase("missing", root), "none");
	assert.equal(await readFrontierPhase(undefined, root), undefined);
});

test("Frontier ownership is restored from its latest recorded result", () => {
	const entries = [
		{ message: { toolName: "frontier", details: { frontier: { phase: "executing" } } } },
		{ message: { toolName: "read", details: {} } },
		{ message: { toolName: "frontier", details: { frontier: { phase: "done" } } } },
	];
	assert.equal(frontierPhaseFromHistory(entries), "done");
	assert.equal(frontierIsActive(frontierPhaseFromHistory(entries)), false);
	assert.equal(frontierIsActive("review"), true);
	assert.equal(frontierIsActive("parked"), true);
	assert.equal(frontierPhase(null), undefined);
	assert.equal(frontierPhase({ frontier: "malformed" }), undefined);
	assert.equal(frontierPhaseFromHistory([null, {}, { message: null }]), undefined);
});

async function until(predicate) {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "handover condition was not reached");
		await sleep(5);
	}
}

function fixture(t, overrides = {}) {
	const delivered = [];
	const errors = [];
	let completed = 0;
	const cancel = queueHandover({
		isCurrent: () => true,
		isIdle: () => true,
		build: async () => "current run",
		deliver: (message) => delivered.push(message),
		onDelivered: () => completed++,
		onError: (error) => errors.push(error),
		delayMs: 5,
		...overrides,
	});
	t.after(cancel);
	return { delivered, errors, cancel, completed: () => completed };
}

test("a busy host keeps the handover queued and delivers once when idle", async (t) => {
	let idle = false;
	let polls = 0;
	const f = fixture(t, { isIdle: () => { polls++; return idle; } });
	await until(() => polls >= 3);
	assert.deepEqual(f.delivered, []);
	idle = true;
	await until(() => f.completed() === 1);
	await sleep(25);
	assert.deepEqual(f.delivered, ["current run"]);
	assert.equal(f.completed(), 1);
});

test("canceling during an asynchronous read fences its eventual delivery", async (t) => {
	let release;
	const reading = new Promise((resolve) => { release = resolve; });
	let started = false;
	const f = fixture(t, { build: () => { started = true; return reading; } });
	await until(() => started);
	f.cancel();
	release("obsolete run");
	await sleep(25);
	assert.deepEqual(f.delivered, []);
	assert.equal(f.completed(), 0);
});

test("a host becoming busy during a read gets a fresh handover when ready", async (t) => {
	let idle = true;
	let builds = 0;
	const f = fixture(t, { isIdle: () => idle, build: async () => {
		builds++;
		if (builds === 1) idle = false;
		return `revision ${builds}`;
	} });
	await until(() => builds === 1);
	assert.deepEqual(f.delivered, []);
	idle = true;
	await until(() => f.completed() === 1);
	assert.deepEqual(f.delivered, ["revision 2"]);
});

test("a transient failure is reported and retried without duplicate delivery", async (t) => {
	let builds = 0;
	const f = fixture(t, { build: async () => {
		if (++builds < 3) throw new Error("temporary read failure");
		return "recovered run";
	} });
	await until(() => f.completed() === 1);
	assert.equal(f.errors.length, 1);
	assert.deepEqual(f.delivered, ["recovered run"]);
});

test("a superseded run cannot send its handover", async (t) => {
	let current = true;
	let reads = 0;
	const f = fixture(t, { isCurrent: () => current, build: async () => {
		reads++;
		current = false;
		return "stopped run";
	} });
	await until(() => reads === 1);
	await sleep(25);
	assert.deepEqual(f.delivered, []);
});
