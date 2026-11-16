/**
 * The shelf of finished runs.
 *
 * `state.json` is ONE slot: the next `/orchestrate <goal>` overwrites the run it adopted, and the
 * finished one is then unanswerable — the goal it was given, the rounds it spent, which tasks
 * passed. This module is the durable answer to "what did the last run do?": a start archives the
 * TERMINAL run it is about to overwrite into `<dir>/runs/<run_id>.json`, and the operator reads the
 * shelf with `/orchestrate runs`.
 *
 * Async only, and a corrupt file is skipped, never fatal: the shelf is a postmortem surface, and a
 * surface that dies on one bad file answers no question at all.
 */
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { TERMINAL, readJsonAsync, writeJsonAsync, type RunState, type Task } from "./core.ts";

export const RUNS_DIRNAME = "runs";

/** A row of the shelf: the numbers an operator reads BEFORE opening a run's own file. */
export interface RunSummary {
	run_id: string;
	state: string;
	goal: string;
	started_utc?: string;
	ended_utc?: string;
	/** The round the run reached — the rounds it spent. */
	rounds: number;
	tasks_total: number;
	tasks_passed: number;
}

export const runsDir = (dir: string): string => join(dir, RUNS_DIRNAME);
export const runArchivePath = (dir: string, runId: string): string => join(runsDir(dir), `${runId}.json`);

/**
 * Archive a TERMINAL run into `<dir>/runs/<run_id>.json` — the whole state plus `ended_utc`, through
 * the same tmp → fdatasync → rename ordering that makes `state.json` survive a `kill -9`. Returns
 * the path written.
 *
 * Two refusals, both load-bearing:
 * - a run that is NOT terminal writes nothing: a run live in another session is not this keystroke's
 *   to rewrite, and a half-run archived as a finished one is a false record;
 * - an archive that already exists is never overwritten: the first record of a run is the true one,
 *   and a later start cannot improve it.
 */
export async function archiveRun(dir: string, state: RunState): Promise<string | undefined> {
	if (TERMINAL[state.state] !== true) return undefined;
	const path = runArchivePath(dir, state.run_id);
	try {
		await stat(path);
		return undefined; // already on the shelf
	} catch {
		/* no archive yet: write it */
	}
	// The archive IS the state, plus when it ended: `state.json`'s own `key` rides, so a file on the
	// shelf parses as a run record by the same reader the live slot uses.
	await writeJsonAsync(path, { ...state, ended_utc: new Date().toISOString() });
	return path;
}

/** The sort stamp: when the run ended, falling back to when it started; unparseable is oldest. */
const stampOf = (r: RunSummary): number => {
	const t = Date.parse(r.ended_utc ?? r.started_utc ?? "");
	return Number.isFinite(t) ? t : 0;
};

/**
 * The shelf, newest first. `ended_utc` when the archive carries it, `started_utc` otherwise.
 *
 * An unparseable file is skipped, a missing dir is an empty shelf, and nothing here throws: the verb
 * that prints this runs on the operator's keystroke, and a shelf that answers nothing beats a shelf
 * that crashes on one hand-corrupted file.
 */
export async function listRuns(dir: string): Promise<RunSummary[]> {
	const shelf = runsDir(dir);
	let names: string[];
	try {
		names = await readdir(shelf);
	} catch {
		return [];
	}
	const summaries: RunSummary[] = [];
	for (const name of names.filter((n) => n.endsWith(".json"))) {
		const rec = await readJsonAsync<RunState & { ended_utc?: string }>(join(shelf, name));
		// A record with no goal is not a run: a stray or half-written file is skipped, named by
		// nothing, and never rendered as an empty run.
		if (typeof rec?.goal !== "string") continue;
		const tasks: Task[] = Array.isArray(rec.tasks) ? rec.tasks : [];
		const runId = typeof rec.run_id === "string" ? rec.run_id : name.replace(/\.json$/, "");
		summaries.push({
			run_id: runId,
			state: typeof rec.state === "string" ? rec.state : "unknown",
			goal: rec.goal,
			...(typeof rec.started_utc === "string" ? { started_utc: rec.started_utc } : {}),
			...(typeof rec.ended_utc === "string" ? { ended_utc: rec.ended_utc } : {}),
			rounds: typeof rec.round === "number" ? rec.round : 0,
			tasks_total: tasks.length,
			tasks_passed: tasks.filter((t) => t?.status === "passed").length,
		});
	}
	summaries.sort((a, b) => stampOf(b) - stampOf(a));
	return summaries;
}
