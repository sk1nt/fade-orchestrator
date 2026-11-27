import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The lease store is a REAL file tree: `supervisor.ts` resolves `STATE_DIR` at module import and
 * writes one file per minted `(caller, session)`, so a renew-before-mint can pay a lease the
 * caller already owns. A rig that merely DELETES `FADE_ORCHESTRATE_STATE_DIR` therefore mints into
 * the operator's own state directory, and a file left there makes a LATER suite renew a lease it
 * never asked for — measured: `resident_gate` gained a `renew token=T-OK` wire line from a
 * neighbour's mint. Every suite gets a scratch store of its own instead: one directory per process,
 * made here, removed at exit. A rig that names its own store (the lease-lifecycle suite) overrides
 * this by assigning the key after importing.
 */
const SUITE_STATE_DIR = mkdtempSync(join(tmpdir(), "fade-orchestrator-leases-"));
process.on("exit", () => rmSync(SUITE_STATE_DIR, { recursive: true, force: true }));
/**
 * The suites that assert lane IDENTITY must not inherit the operator's live lane config.
 *
 * The router module resolves PROVIDER / THINK_LANE / CODE_LANE from process.env at module import,
 * so a shell parked on one lane (this box runs FADE_ORCHESTRATE_THINK_LANE=flash-next for
 * single-lane mode) silently redefines ROUTER_ENTRIES: `isRouterModel("deepseek")` answers false and
 * the router-entry test goes red with NO change to the code under test. Import this module FIRST in
 * such a suite — ESM evaluates imports in declaration order, so the deletes land before the bundle
 * is evaluated — and the suite measures the documented defaults in every environment.
 *
 * The rule this file enforces, widened: the runner evaluates EVERY suite file in ONE
 * process, and the bundles resolve their endpoints, sockets and windows at MODULE IMPORT. A rig
 * file that exports its stub values at module top therefore freezes them into the singleton every
 * later suite imports — measured as `served_id: undefined` (the proof polled a stub server that
 * suite never started), a thinklane residency gate that never fires (the router endpoint no longer
 * matches), and a lease check that expires on a 3 s rig TTL. The deletes below run at each suite's
 * own evaluation, before its bundle import, so every suite measures the documented defaults.
 *
 * `PI_SESSION_FILE` is the box's own contribution: every agent shell exports it, and
 * `isDelegatedSession()` reads it at CALL time — a rig that inherits it is a delegated session,
 * the verify act is never recorded, and the whole lane machinery silently stops (three
 * `lane_switch_404` tests died this way with an empty tool-policy capture).
 * The module is a CACHE KEY: a bare `import "./env.mjs"` evaluates ONCE for the whole run, at
 * the FIRST suite's position — so suites that run later inherit whatever a rig exported in
 * between. Two mechanisms, both in use:
 *  1. import with a per-suite query (`import "./env.mjs?suite=panel"`) — each file gets its own
 *     instance, so the deletes land at that file's graph position, before its bundle import;
 *  2. for imports that happen in a TEST BODY (after every file has run), call `resetLaneEnv()`
 *     immediately before the bundle import.
 */

/** Delete the whole rig/live surface so the next bundle import resolves the documented defaults. */
export function resetLaneEnv() {
	runDeletes();
}

export const LANE_ENV_DEFAULTS = {
	FADE_ORCHESTRATE_PROVIDER: "basalt",
	FADE_ORCHESTRATE_THINK_LANE: "deepseek",
	FADE_ORCHESTRATE_CODE_LANE: "flash-next",
	FADE_ORCHESTRATE_VERIFY_LANE: "hy4-flash",
	FADE_ORCHESTRATE_VERIFIER_MODEL: "ninfer-local/coder-gpu1",
};

function runDeletes() {
	for (const k of [
		"PI_SESSION_FILE",
		"PI_SESSION_ID",
		"FADE_ORCHESTRATE_PROVIDER",
		"FADE_ORCHESTRATE_THINK_LANE",
		"FADE_ORCHESTRATE_CODE_LANE",
		"FADE_ORCHESTRATE_VERIFY_LANE",
		"FADE_ORCHESTRATE_SWAP_VIA",
		"FADE_ORCHESTRATE_SWAP_CMD",
		"FADE_ORCHESTRATE_VERIFIER_MODEL",
		"FADE_ORCHESTRATE_BASALT_CONFIG",
		"FADE_ORCHESTRATE_VRAM_MIN_FREE_MIB",
		"FADE_ORCHESTRATE_START_PROOF_WAIT_MS",
		// The router and the daemon socket. A rig's stub URL frozen into the singleton is a proof
		// that polls a closed server; the shell's live `:18014` in a rig is a rig driving the box.
		"FADE_ORCHESTRATE_ROUTER",
		"FADE_SUPERVISOR_SOCK",
		// The two windows the serve-hold runs on. A shell that exported the RIG's millisecond
		// values would silently redefine every suite's swap transit, and a suite that exported the
		// box's 900 s would hang on a hold the code bounded in milliseconds.
		"FADE_ORCHESTRATE_SERVE_WAIT_MS",
		"FADE_ORCHESTRATE_KEEPALIVE_MS",
		"FADE_ORCHESTRATE_PANEL_FIRST_MS",
		"FADE_ORCHESTRATE_PANEL_REFRESH_MS",
		"FADE_ORCHESTRATE_KEY",
		"FADE_ORCHESTRATE_FALLBACK_KEY",
		// The rest of the rig clocks: mint TTL, poll cadence, settle window, gate budget, flip
		// window, metrics tick, headless. Each is a rig value; none is a suite default.
		"FADE_ORCHESTRATE_LEASE_MINT_TTL_S",
		"FADE_ORCHESTRATE_LANE_POLL_MS",
		"FADE_ORCHESTRATE_LANE_WAIT_MS",
		"FADE_ORCHESTRATE_GATE_POLL_MS",
		"FADE_ORCHESTRATE_GATE_BUDGET_MS",
		"FADE_ORCHESTRATE_SETTLE_MAX_MS",
		"FADE_ORCHESTRATE_SETTLE_POLL_MS",
		"FADE_ORCHESTRATE_METRICS_INTERVAL_MS",
		"FADE_ORCHESTRATE_FLIP_WINDOW_MS",
		"FADE_ORCHESTRATE_HEADLESS",
		// The lease-lifecycle rig keys. `STATE_DIR` resolves at module import in supervisor.ts,
		// so a rig's temp store frozen into the singleton is a suite minting into a deleted
		// directory and a renew reading nothing; the retry floors are rig clocks, and a leaked
		// 60 s cap is a deferral that stops re-asking.
		"FADE_ORCHESTRATE_STATE_DIR",
		"FADE_ORCHESTRATE_LEASE_RETRY_MIN_MS",
		"FADE_ORCHESTRATE_LEASE_RETRY_MAX_MS",
		"FADE_ORCHESTRATE_LEASE_RETRY_MAX_TRIES",
	]) {
		delete process.env[k];
	}
	// Never the documented default: the default is the operator's real store.
	process.env.FADE_ORCHESTRATE_STATE_DIR = SUITE_STATE_DIR;
}
runDeletes();
