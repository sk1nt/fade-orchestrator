/**
 * The overlay's single-key loop controls, as PURE functions over the run state: the TUI
 * component's handleInput, the `/orchestrate` subcommands and the headless rig all drive the
 * same code, so the keystroke path and the proven path never diverge.
 *
 * Each returns a directive; persistence and lane switching stay with the caller (index.ts),
 * because only the caller owns state.json writes and the router.
 */
import { CODE_LANE, THINK_LANE } from "./router.ts";
import { MAX_ROUNDS, type RunState } from "./core.ts";

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

/**
 * r — reset the round counter and add rounds to the budget (Y13: "[r] +3 rounds without
 * restarting"). The round goes to 1 and the cap grows by 3 up to the hard `MAX_ROUNDS`, so the
 * key covers both readings of "reset the round budget": a stalled run gets a fresh round AND a
 * deeper reserve, and a run at the cap gets the named no-op.
 */
export function actReset(run: RunState): ActionDirective {
	run.round = 1;
	run.repair_tasks = [];
	const grew = run.max_rounds < MAX_ROUNDS;
	run.max_rounds = Math.min(MAX_ROUNDS, run.max_rounds + 3);
	return { nextState: run.state, note: `round reset to 1 (tasks and statuses kept)${grew ? ` · budget +3 → ${run.max_rounds} rounds` : ` · budget already at the ${MAX_ROUNDS}-round cap`}` };
}

/**
 * p — pause/resume the loop for a manual edit. Pause is a flag, never a state: the run keeps its
 * state, its tasks and its lane, so resuming lands exactly where it stopped. The note is the
 * operator's reason and lands in `state.json` (Y13: "writes the operator note to state.json").
 */
export function actPause(run: RunState, note?: string): ActionDirective {
	run.paused = !(run.paused === true);
	run.operator_note = note ?? (run.paused ? `paused at round ${run.round} for a manual edit` : `resumed at round ${run.round}`);
	return { nextState: run.state, note: run.paused ? `paused (round ${run.round}, lane ${run.lane} left resident; [p] resumes)` : `resumed (round ${run.round}; the loop advances again)` };
}

/** h — halt cleanly: the run is stopped, state.json is preserved, lane left resident. */
export function actHalt(run: RunState): ActionDirective {
	run.state = "stopped";
	return { nextState: "stopped", note: `halted; resident lane left as ${run.lane}; state preserved` };
}

/**
 * c — resume a halted, paused or coding run back to the code lane. Resuming clears the pause
 * flag: `[c]` is an explicit "keep going", so it cannot leave the loop parked.
 */
export function actCode(run: RunState): ActionDirective {
	if (run.state === "complete" || run.state === "failed") return { nextState: run.state, note: `code: run is ${run.state}` };
	run.paused = false;
	run.state = run.tasks.length === 0 ? "planning" : "coding";
	return { next: CODE_LANE, nextState: run.state, note: "coding requested from the overlay" };
}
