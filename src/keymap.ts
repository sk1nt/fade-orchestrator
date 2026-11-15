/**
 * The overlay's single-key loop controls, as PURE functions over the run state: the TUI
 * component's handleInput, the `/orchestrate` subcommands and the headless rig all drive the
 * same code, so the keystroke path and the proven path never diverge.
 *
 * Each returns a directive; persistence and lane switching stay with the caller (index.ts),
 * because only the caller owns state.json writes and the router.
 */
import { CODE_LANE, THINK_LANE } from "./router.ts";
import type { RunState } from "./core.ts";

export interface ActionDirective {
	/** Lane to load next, or undefined to leave the resident lane. */
	next?: string;
	/** Resulting state (persisted by the caller). */
	nextState: string;
	/** What happened, for the notify line. */
	note: string;
}

/** s — skip/force-pass a blocked task. `task` picks it explicitly; default = first unfinished. */
export function actSkip(run: RunState, task?: string): ActionDirective {
	const pool = run.repair_tasks.length > 0 ? run.repair_tasks : run.tasks;
	const target = task ? pool.find((t) => t.id === task) ?? run.tasks.find((t) => t.id === task) : pool.find((t) => t.status !== "passed");
	if (!target) return { nextState: run.state, note: task ? `skip: no task ${task} in this run` : "skip: every task already passed" };
	target.status = "passed";
	target.result = `${target.result ? `${target.result} · ` : ""}manual skip (operator) at ${new Date().toISOString()}`;
	return { nextState: run.state, note: `skipped ${target.id} (forced passed; recorded as manual skip)` };
}

/** v — trigger verification early from coding/repair: the run moves to the thinking lane. */
export function actVerify(run: RunState): ActionDirective {
	if (run.state !== "coding" && run.state !== "repair") return { nextState: run.state, note: `verify: state ${run.state} is not a coding phase` };
	run.state = "verifying";
	return { next: THINK_LANE, nextState: "verifying", note: "verification requested early; thinking lane loads at the turn boundary" };
}

/** r — reset the round counter, keep the task list and their statuses. */
export function actReset(run: RunState): ActionDirective {
	run.round = 1;
	run.repair_tasks = [];
	return { nextState: run.state, note: "round reset to 1 (tasks and statuses kept)" };
}

/** h — halt cleanly: the run is stopped, state.json is preserved, lane left resident. */
export function actHalt(run: RunState): ActionDirective {
	run.state = "stopped";
	return { nextState: "stopped", note: `halted; resident lane left as ${run.lane}; state preserved` };
}

/** c — resume a halted/coding run back to the code lane. */
export function actCode(run: RunState): ActionDirective {
	if (run.state === "complete" || run.state === "failed") return { nextState: run.state, note: `code: run is ${run.state}` };
	run.state = run.tasks.length === 0 ? "planning" : "coding";
	return { next: CODE_LANE, nextState: run.state, note: "coding requested from the overlay" };
}
