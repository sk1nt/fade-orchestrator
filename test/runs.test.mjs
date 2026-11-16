/**
 * The shelf of finished runs (src/runs.ts).
 *
 * The gap this closes: `state.json` is ONE slot, so the run that just finished is unanswerable the
 * moment the next `/orchestrate <goal>` writes over it. A start archives a TERMINAL run first, and
 * `/orchestrate runs` reads the shelf back.
 *
 * The rules pinned here: only a terminal run is archived (a run live in another session is not this
 * keystroke's to rewrite); an archive is never overwritten; the shelf is newest-first; a corrupt
 * file is skipped; a missing shelf is empty, never a throw.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNS_DIRNAME, archiveRun, listRuns, runArchivePath, runsDir } from "../.test-build/runs.mjs";

/** A run state in the shape core validates. */
const runState = (over = {}) => ({
	key: "fade.omp_orchestrate.v1",
	run_id: "20300101T113829Z-gbut",
	goal: "do another sweep of the repo and suggest any other features",
	repo: "/tmp/fixture",
	max_rounds: 6,
	round: 3,
	state: "complete",
	lane: "deepseek",
	checks: [["npm test", "exit 0"]],
	tasks: [
		{ id: "T1", objective: "one", acceptance: "npm test", files: [], dependencies: [], status: "passed", result: "green" },
		{ id: "T2", objective: "two", acceptance: "npm test", files: [], dependencies: [], status: "failed", result: "red" },
	],
	phases: [],
	repair_tasks: [],
	rejection_history: [],
	schema_retries: 0,
	started_utc: "2030-01-01T11:38:29.000Z",
	...over,
});

const tmp = () => mkdtempSync(join(tmpdir(), "fade-runs-"));

test("a run that is not terminal is never archived", async () => {
	const dir = tmp();
	try {
		for (const state of ["coding", "planning", "verifying", "repair"]) {
			assert.equal(await archiveRun(dir, runState({ state })), undefined, `${state} is a run in flight, not a finished record`);
		}
		assert.deepEqual(await listRuns(dir), [], "and nothing reached the shelf");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a terminal run lands on the shelf with the moment it ended", async () => {
	const dir = tmp();
	try {
		for (const state of ["complete", "failed", "stopped"]) {
			const path = await archiveRun(dir, runState({ state, run_id: `run-${state}` }));
			assert.equal(path, runArchivePath(dir, `run-${state}`), "the path returned is the file the shelf reads");
			const rec = JSON.parse(readFileSync(path, "utf8"));
			assert.equal(rec.state, state);
			assert.equal(rec.run_id, `run-${state}`);
			assert.ok(Number.isFinite(Date.parse(rec.ended_utc)), "ended_utc is a real timestamp: the shelf can be ordered by it");
			assert.equal(rec.key, "fade.omp_orchestrate.v1", "the archive is a run record the same reader parses, not a new schema");
		}
		assert.equal(runsDir(dir), join(dir, RUNS_DIRNAME));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("archiving the same run twice writes nothing the second time", async () => {
	const dir = tmp();
	try {
		const first = await archiveRun(dir, runState({ run_id: "run-once" }));
		const written = readFileSync(first, "utf8");
		assert.equal(await archiveRun(dir, runState({ run_id: "run-once" })), undefined, "the first record of a run is the true one");
		assert.equal(readFileSync(first, "utf8"), written, "and a later start cannot rewrite it");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("listRuns is newest-first by when the run ended, and counts the run's own tasks", async () => {
	const dir = tmp();
	try {
		const shelf = runsDir(dir);
		mkdirSync(shelf, { recursive: true });
		// The archives carry explicit end stamps. Three runs archived inside one test all END in
		// the same millisecond — a fixture artifact, not the order the shelf promises — so the
		// record's `ended_utc` is what this asserts on, plus the fallback for a record that has
		// none (an archive written by an older build).
		const seeded = [
			{ run_id: "run-old", ended_utc: "2030-01-04T10:00:00.000Z" },
			{ run_id: "run-mid", ended_utc: "2030-01-05T10:00:00.000Z" },
			{ run_id: "run-new", ended_utc: "2030-01-06T10:00:00.000Z" },
			{ run_id: "run-unended", started_utc: "2030-01-03T10:00:00.000Z", ended_utc: undefined },
		];
		for (const s of seeded) writeFileSync(join(shelf, `${s.run_id}.json`), JSON.stringify(runState(s)));
		const rows = await listRuns(dir);
		assert.deepEqual(rows.map((r) => r.run_id), ["run-new", "run-mid", "run-old", "run-unended"], "newest first; a record with no end stamp falls back to its start");
		const newest = rows[0];
		assert.equal(newest.tasks_total, 2);
		assert.equal(newest.tasks_passed, 1, "passed counts the task statuses, not the phase log");
		assert.equal(newest.rounds, 3, "the round reached is the rounds spent");
		assert.ok(newest.goal.includes("sweep"), "the goal rides, so a shelf row is recognisable without opening the file");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a corrupt shelf file is skipped, and a missing shelf is empty", async () => {
	const dir = tmp();
	try {
		await archiveRun(dir, runState({ run_id: "run-good" }));
		mkdirSync(runsDir(dir), { recursive: true });
		writeFileSync(join(runsDir(dir), "run-broken.json"), "{ not json");
		writeFileSync(join(runsDir(dir), "run-hollow.json"), JSON.stringify({ state: "complete" }));
		const shelf = await listRuns(dir);
		assert.deepEqual(shelf.map((r) => r.run_id), ["run-good"], "one hand-corrupted file costs the whole shelf nothing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	const missing = tmp();
	rmSync(missing, { recursive: true, force: true });
	assert.deepEqual(await listRuns(missing), [], "a repo that has never finished a run has an empty shelf, not an error");
});
