/**
 * Swap-residency history: one row per lane swap the orchestrator drove, appended to
 * `var/omp-orchestrate/swap_history.json` (temp+rename, capped). The overlay renders it, and it
 * is the durable record behind the "batch verifications into one residency" question: a 13-25 s
 * pack swap is only justifiable once what swaps cost has been measured.
 *
 * Alongside it, the per-turn telemetry ledger: `metrics.jsonl`, one JSON record per completed
 * turn, append-only — the per-turn `pp`/`tg`/`ttft`/`kv_hit_pct`/`swap_ms` record a postmortem
 * reads line by line.
 */
import { join } from "node:path";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { readJson, writeJson } from "./core.ts";
import type { LaneMoe } from "./moe.ts";

export const HISTORY_FILENAME = "swap_history.json";
/** Per-turn telemetry ledger: one JSON record per completed turn, append-only. */
export const METRICS_JSONL_FILENAME = "metrics.jsonl";
/** The cold/hot decode boundary. 120 sits under deepseek's ~130 steady line and over its
 *  ~91 tok/s cold ramp, and well under flash-next's 480-647. */
export const HOT_STEADY_TPS = 120;
const MAX_ROWS = 200;

export interface SwapRow {
	from: string;
	to: string;
	/** Wall seconds from `/v1/load` issued to the router reporting the lane resident. */
	elapsed_s: number;
	/** Decode tok/s of the first completion on the new lane (the cold expert ramp reads low:
	 *  deepseek's promote window runs ~91 tok/s for its first ~1,200 tokens). */
	first_tg: number;
	/** Decode tok/s once the lane settles (~130 steady on deepseek, 480-647 on flash-next). */
	steady_tg: number;
	/** `elapsed_s` in milliseconds: the overlay's transition timer and the JSONL's `swap_ms` are
	 *  the same measurement in the unit each one prints, so the row keeps both. */
	elapsed_ms?: number;
	/** Warm/cold read of the first completion: `map_restored` = the start placed from a saved
	 *  MoE placement map, `hot_steady` = it decoded at/over the steady line, `cold_ramp` = it is
	 *  still relearning placement (the ~91 tok/s window). */
	ramp?: "cold_ramp" | "hot_steady" | "map_restored";
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

/**
 * The badge class for a first-completion rate. A restored placement map wins: that start was
 * warm by construction, whatever the first rate happens to read.
 */
export function rampClass(decodeTps: number | undefined, mapRestored: boolean, threshold = HOT_STEADY_TPS): "cold_ramp" | "hot_steady" | "map_restored" {
	if (mapRestored) return "map_restored";
	return decodeTps !== undefined && decodeTps >= threshold ? "hot_steady" : "cold_ramp";
}

/**
 * The per-turn numbers the /metrics window can report. A closed router (or a request record
 * without these fields) reports EVERY field missing — `turnRecordOrNull` then writes nothing
 * rather than a row of zeros, which is the difference between telemetry and decoration.
 */
export interface TurnMetrics {
	/** Prompt-processing tok/s for the turn's request. */
	pp?: number;
	/** Decode tok/s. */
	tg?: number;
	/** Time to first token, seconds. */
	ttft?: number;
	/** Conversation-cache prefix reuse, in percent. */
	kv_hit_pct?: number;
}

/** What the caller knows and the router does not: which turn this was, what it cost, what it came to. */
export interface TurnIdentity {
	run_id: string;
	turn: number;
	round: number;
	/** The phase the turn ended with; a phase-less turn has none. */
	phase?: string;
	/** Lane-swap wall time inside the turn, ms (0 when the turn did not swap). */
	swap_ms: number;
	/** The turn's outcome as the loop recorded it (accepted / needs_repair / refused / …). */
	round_outcome: string;
	ts?: string;
}

export interface TurnRecord {
	ts: string;
	run_id: string;
	turn: number;
	round: number;
	phase?: string;
	pp: number;
	tg: number;
	ttft?: number;
	kv_hit_pct?: number;
	swap_ms: number;
	round_outcome: string;
}

/** A turn record, or `undefined` when the router gave no `pp`/`tg` — no fabricated zeros. */
export function turnRecordOrNull(m: TurnMetrics | undefined, id: TurnIdentity): TurnRecord | undefined {
	if (typeof m?.pp !== "number" || typeof m?.tg !== "number") return undefined;
	return {
		ts: id.ts ?? new Date().toISOString(),
		run_id: id.run_id,
		turn: id.turn,
		round: id.round,
		...(id.phase !== undefined ? { phase: id.phase } : {}),
		pp: m.pp,
		tg: m.tg,
		...(typeof m.ttft === "number" ? { ttft: m.ttft } : {}),
		...(typeof m.kv_hit_pct === "number" ? { kv_hit_pct: m.kv_hit_pct } : {}),
		swap_ms: id.swap_ms,
		round_outcome: id.round_outcome,
	};
}

/** Exactly one newline-terminated line per call, into `${dir}/metrics.jsonl` (dir created). */
export function appendTurn(dir: string, rec: TurnRecord): void {
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, METRICS_JSONL_FILENAME), `${JSON.stringify(rec)}\n`);
}

/** The last `n` records. A half-written or hand-corrupted line is skipped, never fatal. */
export function readTurns(dir: string, n: number): TurnRecord[] {
	let raw: string;
	try {
		raw = readFileSync(join(dir, METRICS_JSONL_FILENAME), "utf8");
	} catch {
		return [];
	}
	const recs: TurnRecord[] = [];
	for (const line of raw.split("\n")) {
		const text = line.trim();
		if (text === "") continue;
		try {
			const rec = JSON.parse(text) as TurnRecord;
			// A line without the two numbers the store exists for is not a record.
			if (rec && typeof rec === "object" && typeof rec.pp === "number" && typeof rec.tg === "number") recs.push(rec);
		} catch {
			/* corrupt line: skipped */
		}
	}
	return recs.slice(Math.max(0, recs.length - n));
}
