/**
 * Swap-residency history: one row per lane swap the orchestrator drove, appended to
 * `var/omp-orchestrate/swap_history.json` (temp+rename, capped). The overlay renders it, and it
 * is the durable record behind the "batch verifications into one residency" question: a 13-25 s
 * pack swap is only justifiable once what swaps cost has been measured.
 *
 * Alongside it, the per-turn telemetry ledger: `metrics.jsonl`, one JSON record per completed
 * turn, appended until the byte cap rotates it (`appendTurn`) — the per-turn
 * `pp`/`tg`/`ttft`/`kv_hit_pct`/`swap_ms` record a postmortem reads line by line.
 *
 * Every read and write here is `fs.promises`, and `readTurns` reads a TAIL (default
 * `turnTail()`, env `FADE_ORCHESTRATE_TURN_TAIL`), never the whole file: the panel asks for both
 * ledgers on the Alt+F keystroke and on its 2 s refresh tick, on the TUI's loop.
 */
import { join } from "node:path";
import { appendFile, mkdir, open, rename, stat, type FileHandle } from "node:fs/promises";
import { readJsonAsync, writeJsonAsync } from "./core.ts";
import type { LaneMoe } from "./moe.ts";

export const HISTORY_FILENAME = "swap_history.json";
/** Per-turn telemetry ledger: one JSON record per completed turn, rotated past the byte cap. */
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
	/** The run that PAID this swap. A row written before the field existed has none, and
	 *  `summarizeSwaps` never charges such a row to the run asking — the panel's `swaps this run`
	 *  row names that gap instead of reading another run's cost as this run's. */
	run_id?: string;
	/** The class of the work this swap was PAID for (taskmoe.ts): the per-class warm-start record,
	 *  so "did the CI work come in warm?" is answerable from the ledger. A row from a watcher that
	 *  named no class has none, and `classWarmth` charges such a row to no class. */
	task_class?: string;
}

/**
 * The swap ledger. ASYNC: the panel reads it on the Alt+F keystroke and on its 2 s refresh tick,
 * and a `readFileSync` there is a stall of the host's paint loop.
 */
export async function readSwaps(dir: string): Promise<SwapRow[]> {
	const rows = await readJsonAsync<{ rows?: SwapRow[] }>(join(dir, HISTORY_FILENAME));
	return Array.isArray(rows?.rows) ? rows!.rows! : [];
}

/** Read → prepend → durable write, all off the TUI's loop (`writeJsonAsync`: tmp, fdatasync, rename). */
export async function appendSwap(dir: string, row: SwapRow): Promise<void> {
	const rows = await readSwaps(dir);
	rows.unshift(row);
	if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
	await writeJsonAsync(join(dir, HISTORY_FILENAME), { key: "fade.omp_orchestrate.swaps.v1", rows });
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
 * What ONE run paid in pack swaps, counted and summed over the rows stamped with its `run_id`.
 * A row with no `run_id` is never charged to anyone: an unattributed cost is not this run's cost.
 * The total is one decimal, the unit the screen and `/orchestrate status` both print.
 */
export function summarizeSwaps(rows: SwapRow[], runId: string): { count: number; total_elapsed_s: number } {
	const mine = rows.filter((r) => r.run_id === runId);
	const total = mine.reduce((s, r) => s + (typeof r.elapsed_s === "number" ? r.elapsed_s : 0), 0);
	return { count: mine.length, total_elapsed_s: Math.round(total * 10) / 10 };
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

/** The ledger's size cap in bytes; `FADE_ORCHESTRATE_LEDGER_MAX_BYTES` moves it and `0` disables
 *  rotation. Read at CALL time, like `turnTail()`: it is configuration, not a build constant. */
export const LEDGER_MAX_BYTES_DEFAULT = 8_388_608;
export const ledgerMaxBytes = (): number => {
	const raw = process.env.FADE_ORCHESTRATE_LEDGER_MAX_BYTES;
	if (raw === undefined || raw === "") return LEDGER_MAX_BYTES_DEFAULT;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : LEDGER_MAX_BYTES_DEFAULT;
};

/**
 * Exactly one newline-terminated line per call, into `${dir}/metrics.jsonl` (dir created) — past
 * the cap, rotate first.
 *
 * The ledger is append-only, so a long-lived plane grows it without bound. Past the cap the
 * current file is ROTATED to `metrics.jsonl.1` (the older `.1` is replaced) and the append starts
 * a fresh current file: one predecessor, enough for a postmortem, bounded on disk.
 *
 * `readTurns` reads the CURRENT file only, so a rotated-out tail is a postmortem file and not a
 * screen row — the honest reading, and the one the panel can still reach in bounded time.
 */
export async function appendTurn(dir: string, rec: TurnRecord): Promise<void> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, METRICS_JSONL_FILENAME);
	const cap = ledgerMaxBytes();
	if (cap > 0) {
		let size = 0;
		try {
			size = (await stat(path)).size;
		} catch {
			size = 0;
		}
		if (size > cap) {
			try {
				await rename(path, `${path}.1`);
			} catch {
				/* a rotation race loses to the winner: the append below still lands, in one file */
			}
		}
	}
	await appendFile(path, `${JSON.stringify(rec)}\n`);
}

/** The tail bound: how many of the newest turn records a reader ever asks for. */
export const TURN_TAIL_DEFAULT = 500;
/** Read at CALL time: it is configuration, and `FADE_ORCHESTRATE_TURN_TAIL` is how an operator
 *  trades ledger depth for the panel's read size. */
export const turnTail = (): number => Math.max(1, Number(process.env.FADE_ORCHESTRATE_TURN_TAIL ?? TURN_TAIL_DEFAULT));
/** Bytes per requested record when sizing the tail read — a record is ~300 B, this is headroom. */
const TURN_RECORD_BYTES = 4096;

/**
 * The last `n` records (default: the tail bound, `turnTail()`).
 *
 * A TAIL read, not a whole-file read. The ledger is append-only and a long run leaves thousands
 * of lines in it; the old reader read and parsed ALL of them on the panel's every 2 s tick, on
 * the TUI's own loop, to show twelve rows. This opens the file, stats it, and reads the last
 * `n * TURN_RECORD_BYTES` bytes at an offset — so the cost is the tail's size, not the ledger's.
 * A tail that starts mid-file starts INSIDE a record: that first partial line is dropped, never
 * parsed. A half-written or hand-corrupted line is skipped, never fatal, and a missing ledger is
 * an empty list, never a crash and never a fabricated row.
 */
export async function readTurns(dir: string, n: number = turnTail()): Promise<TurnRecord[]> {
	const limit = Math.max(1, Math.floor(n));
	let fh: FileHandle | undefined;
	try {
		fh = await open(join(dir, METRICS_JSONL_FILENAME), "r");
	} catch {
		return [];
	}
	let text = "";
	let partial = false;
	try {
		const size = (await fh.stat()).size;
		if (size === 0) return [];
		const start = Math.max(0, size - limit * TURN_RECORD_BYTES);
		const buf = Buffer.alloc(size - start);
		await fh.read(buf, 0, buf.length, start);
		text = buf.toString("utf8");
		partial = start > 0;
	} finally {
		await fh.close();
	}
	const recs: TurnRecord[] = [];
	const lines = text.split("\n");
	if (partial) lines.shift();
	for (const line of lines) {
		const s = line.trim();
		if (s === "") continue;
		try {
			const rec = JSON.parse(s) as TurnRecord;
			// A line without the two numbers the store exists for is not a record.
			if (rec && typeof rec === "object" && typeof rec.pp === "number" && typeof rec.tg === "number") recs.push(rec);
		} catch {
			/* corrupt line: skipped */
		}
	}
	return recs.slice(Math.max(0, recs.length - limit));
}
