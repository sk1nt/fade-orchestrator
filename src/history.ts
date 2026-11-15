/**
 * Swap-residency history: one row per lane swap the orchestrator drove, appended to
 * `var/omp-orchestrate/swap_history.json` (temp+rename, capped). The overlay renders it, and it
 * is the durable record behind the "batch verifications into one residency" question: you can
 * only justify paying a 13-25 s pack swap when you have measured what swaps cost.
 */
import { join } from "node:path";
import { readJson, writeJson } from "./core.ts";
import type { LaneMoe } from "./moe.ts";

export const HISTORY_FILENAME = "swap_history.json";
const MAX_ROWS = 200;

export interface SwapRow {
	from: string;
	to: string;
	/** Wall seconds from `/v1/load` issued to the router reporting the lane resident. */
	elapsed_s: number;
	/** Decode tok/s of the first completion on the new lane (the cold expert ramp reads low:
	 *  the measured deepseek promote window ran ~91 tok/s for its first ~1,200 tokens). */
	first_tg: number;
	/** Decode tok/s once the lane settles (measured steady ~130 on deepseek, 480-647 flash-next). */
	steady_tg: number;
	/** /health `percent` samples observed while the swap was in flight, in arrival order. */
	percent_path: number[];
	/** The lane's MoE placement state at the moment the swap started (moe.ts): warm start or not. */
	moe?: LaneMoe;
	at: string;
}

export function readSwaps(dir: string): SwapRow[] {
	const rows = readJson<{ rows?: SwapRow[] }>(join(dir, HISTORY_FILENAME));
	return Array.isArray(rows?.rows) ? rows!.rows! : [];
}

export function appendSwap(dir: string, row: SwapRow): void {
	const rows = readSwaps(dir);
	rows.unshift(row);
	if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
	writeJson(join(dir, HISTORY_FILENAME), { key: "fade.omp_orchestrate.swaps.v1", rows });
}
