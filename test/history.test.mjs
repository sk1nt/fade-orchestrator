/**
 * The two ledgers' contracts (src/history.ts).
 *
 * What this pins:
 *  - `summarizeSwaps` prices ONE run and no other. A row stamped with a foreign `run_id`, and a row
 *    carrying no `run_id` at all (every row written before the field existed), is never charged to
 *    the run asking: an unattributed cost is not this run's cost.
 *  - the per-turn ledger is append-only, so a long-lived plane grows it without bound. Past the
 *    byte cap it ROTATES, keeping exactly one predecessor, and `readTurns` reads the CURRENT file
 *    only: a rotated-out tail is a postmortem file, not a screen row. `0` disables rotation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSwap, appendTurn, readSwaps, readTurns, summarizeSwaps } from "../.test-build/history.mjs";

/** A swap row in the shape the watcher writes: the measured 0.4.0 ramp rates. */
const swapRow = (elapsed_s, run_id, task_class) => ({
	from: "flash-next",
	to: "deepseek",
	elapsed_s,
	first_tg: 91,
	steady_tg: 130,
	percent_path: [12, 61, 96],
	at: "2030-01-01T12:10:00.000Z",
	...(run_id ? { run_id } : {}),
	...(task_class ? { task_class } : {}),
});

/** A turn record the router could have reported: pp and tg both present. */
const turnRec = (n) => ({
	ts: `2030-01-01T07:00:${String(n).padStart(2, "0")}.000Z`,
	run_id: "run-a",
	turn: n,
	round: 1,
	pp: 1000,
	tg: 130,
	swap_ms: 0,
	round_outcome: "accepted",
});

/** A file that is not there has size 0 — the ledger's first append has no file to stat. */
const sizeOf = (path) => {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
};

/** The cap is read from the env at CALL time, so a test sets it and puts the process back. */
const withCap = async (cap, fn) => {
	const prev = process.env.FADE_ORCHESTRATE_LEDGER_MAX_BYTES;
	try {
		if (cap === undefined) delete process.env.FADE_ORCHESTRATE_LEDGER_MAX_BYTES;
		else process.env.FADE_ORCHESTRATE_LEDGER_MAX_BYTES = cap;
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.FADE_ORCHESTRATE_LEDGER_MAX_BYTES;
		else process.env.FADE_ORCHESTRATE_LEDGER_MAX_BYTES = prev;
	}
};

test("summarizeSwaps counts and sums only the rows stamped with the asking run", () => {
	const rows = [swapRow(14.04, "run-a"), swapRow(3.0, "run-b"), swapRow(2.6, "run-a"), swapRow(9.9)];
	const a = summarizeSwaps(rows, "run-a");
	assert.equal(a.count, 2, "two of the four rows are this run's");
	assert.equal(a.total_elapsed_s, 16.6, "14.04 + 2.6, printed to the one decimal the screen and status use");
	assert.deepEqual(summarizeSwaps(rows, "run-c"), { count: 0, total_elapsed_s: 0 }, "a run that paid nothing reads 0/0 for the caller to name");
});

test("an unattributed swap row is never charged to a run", () => {
	assert.equal(summarizeSwaps([swapRow(20)], "run-a").count, 0, "a row with no run_id predates attribution and belongs to no one");
	assert.equal(summarizeSwaps([swapRow(20, "run-a")], "run-a").count, 1, "the same row stamped does count");
});

test("the turn ledger rotates past the cap and keeps exactly one predecessor", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fade-ledger-"));
	const ledger = join(dir, "metrics.jsonl");
	try {
		await withCap("400", async () => {
			let n = 0;
			while (sizeOf(ledger) <= 400) await appendTurn(dir, turnRec(n++));
			const grown = sizeOf(ledger);
			await appendTurn(dir, turnRec(n++));
			assert.ok(sizeOf(`${ledger}.1`) >= grown, "the predecessor is the file that passed the cap");
			const current = sizeOf(ledger);
			assert.ok(current < 400, `the current file restarted (${current} B, under the 400 B cap)`);
			assert.equal(sizeOf(`${ledger}.2`), 0, "exactly one predecessor is kept — no unbounded shelf of rotated files");
			const turns = await readTurns(dir);
			assert.equal(turns.length, 1, "readTurns reads the CURRENT file only: the rotated-out tail is not a screen row");
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("FADE_ORCHESTRATE_LEDGER_MAX_BYTES=0 disables rotation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fade-ledger0-"));
	const ledger = join(dir, "metrics.jsonl");
	try {
		await withCap("0", async () => {
			for (let i = 0; i < 12; i++) await appendTurn(dir, turnRec(i));
			assert.ok(sizeOf(ledger) > 400, "the ledger grew past the cap the rotation test used, on purpose");
			assert.equal(sizeOf(`${ledger}.1`), 0, "cap 0 is one growing file, no rotation");
			assert.equal((await readTurns(dir)).length, 12, "nothing rotated out, so the reader still sees every turn");
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no cap set means the 8 MiB default, which one record never crosses", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fade-ledgerdef-"));
	const ledger = join(dir, "metrics.jsonl");
	try {
		await withCap(undefined, async () => {
			await appendTurn(dir, turnRec(0));
			assert.equal(sizeOf(`${ledger}.1`), 0, "the default cap is never crossed by one record, so nothing rotates");
			assert.equal((await readTurns(dir)).length, 1);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a swap row written through appendSwap is read back with its run_id", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fade-swaps-"));
	try {
		await appendSwap(dir, swapRow(14.2, "run-a"));
		const rows = await readSwaps(dir);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].run_id, "run-a", "the attribution survives the durable write, not just the return value");
		assert.equal(summarizeSwaps(rows, "run-a").count, 1, "the ledger read is what the status line prices");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a swap row's task_class survives the ledger, and the per-run bill is unchanged by it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fade-swaps-class-"));
	try {
		await appendSwap(dir, swapRow(14.2, "run-a", "ci"));
		await appendSwap(dir, swapRow(3.1, "run-a"));
		const rows = await readSwaps(dir);
		assert.equal(rows.find((r) => r.elapsed_s === 14.2).task_class, "ci", "the class rides the durable row, not just the argument");
		assert.equal(rows.find((r) => r.elapsed_s === 3.1).task_class, undefined, "a row written without one stays unclassified");
		assert.equal(rows[0].elapsed_s, 3.1, "the ledger stays newest-first, which is what the per-class census reads the profile off");
		const price = summarizeSwaps(rows, "run-a");
		assert.deepEqual([price.count, price.total_elapsed_s], [2, 17.3], "the class is a label on the row, not a second ledger: both rows still price the run");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
