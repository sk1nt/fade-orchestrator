/**
 * The screen's data: ONE typed snapshot the panel renders, assembled from the router, the run's
 * durable records and the host's context meter.
 *
 * The rule the aggregation obeys: a number nobody measured is NAMED, never printed as a zero. An
 * unreachable router answers `tiers: [{label: "router", value: "… unreachable"}]` and a `missing`
 * `no swaps recorded`; a session whose model has no context meter says `no context meter`. A panel
 * of zeros is decoration, and decoration is how a dead wire reads as a quiet market.
 *
 * The caller owns the clocks: `metrics` is the extension's cached 30 s snapshot (the panel opens
 * with the numbers the loop already paid for and refreshes on its own bounded tick), and
 * `swaps`/`turns` are injectable so the rig can drive a whole screen without a router.
 */
import type { GateResult, RunState } from "./core.ts";
import type { InstanceLock } from "./core.ts";
import { readTurns, readSwaps, type SwapRow, type TurnRecord } from "./history.ts";
import { fetchMetrics, tiersFromMetrics, type MetricsSnapshot } from "./livedata.ts";
import { moeBalanceRows, moeRows } from "./moe.ts";
import { ROUTER } from "./router.ts";
import { modelLabel, type FlipBadge, type TierRow } from "./ui.ts";

/** How many ledger rows the screen carries: enough for a sparkline and the last turns. */
export const SCREEN_TURNS = 12;
/** Swap rows shown newest-first: the operator reads the last swaps, not the run's whole history. */
export const SCREEN_SWAPS = 6;

export interface MetricRow {
	label: string;
	value: string;
	/** The panel's color class. A bare string hides the fact that a number is missing. */
	tone?: "ok" | "warn" | "bad" | "dim";
}

export interface LaneRow {
	lane: string;
	role: "think" | "code";
	/** The lane key; the model name rides only on the engine column's `resident` row (`modelLabel`). */
	model: string;
	/** The lane the router reports resident right now. */
	resident: boolean;
}

export interface ScreenContext {
	tokens: number;
	window: number;
	percent: number;
}

export interface ScreenData {
	run: RunState;
	refreshed_utc: string;
	/** Wall seconds since the run started; undefined when the state file carries no start. */
	elapsed_s?: number;
	lanes: LaneRow[];
	/** The router's own tiers: engine, resident lane, expert slots/spill, decode, best, prefix cache. */
	tiers: TierRow[];
	/** The MoE placement state per lane (warm start vs relearn). */
	moe: MetricRow[];
	turns: TurnRecord[];
	swaps: SwapRow[];
	context?: ScreenContext;
	gate?: GateResult;
	/** The last verifier critique, verbatim. */
	critique?: string;
	flip?: FlipBadge;
	/** Who holds the router's lane-switching right now. The screen is where an operator looks after
	 *  a start is refused, so the holder is named, not summarized. */
	claim?: InstanceLock | null;
	/** The named gaps behind every absent number, so the screen never reads as a zero. */
	missing: string[];
}

export interface ScreenSource {
	run: RunState;
	runDir: string;
	lanes: { think: string; code: string };
	/** lane -> the registry display name (`ctx.modelRegistry.find(provider, lane)?.name`). */
	names?: Record<string, string | undefined>;
	/** The host's context meter (`ctx.getContextUsage()`), whose tokens/percent can be null. */
	context?: { tokens: number | null; contextWindow: number; percent: number | null };
	/** The caller's cached snapshot; fetched only when the caller has none. */
	metrics?: MetricsSnapshot;
	moeConfigPath?: string;
	swaps?: SwapRow[];
	turns?: TurnRecord[];
	/** The flip guard's badge, as the wiring layer renders it. */
	flip?: FlipBadge;
	/** The router claim as the wiring layer reads it: the holder, `null` for a free router, and
	 *  `undefined` when the caller never looked — the row says so instead of guessing free. */
	claim?: InstanceLock | null;
	now?: () => Date;
}

/** Compact thousands: the panel's columns are narrow and 1,048,576 is unreadable at full width. */
export function compactNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
	return `${Math.round(n)}`;
}

/** `▁▂▃▄▅▆▇█` scaled to the row's own maximum; fewer than two values draws nothing. */
export function sparkline(values: number[]): string {
	const BARS = "▁▂▃▄▅▆▇█";
	const nums = values.filter((v) => Number.isFinite(v) && v > 0);
	if (nums.length < 2) return "";
	const max = Math.max(...nums);
	if (max <= 0) return "";
	return nums
		.map((v) => {
			const i = Math.min(BARS.length - 1, Math.floor((v / max) * (BARS.length - 1)));
			return BARS[i] ?? "▁";
		})
		.join("");
}

/**
 * The lane rows: role and the router's resident fact, named by lane KEY — model naming defers to
 * `modelLabel`. The `◆resident` marker on this line names which lane the router holds.
 */
export function laneRows(src: ScreenSource, metrics: MetricsSnapshot | undefined): LaneRow[] {
	const resident = metrics?.loaded;
	const spec: { lane: string; role: "think" | "code" }[] = [
		{ lane: src.lanes.think, role: "think" },
		{ lane: src.lanes.code, role: "code" },
	];
	return spec.map((s) => ({
		lane: s.lane,
		role: s.role,
		model: s.lane,
		resident: resident !== undefined && resident === s.lane,
	}));
}

/** The per-turn ledger rows: one line per turn, newest last, with the numbers the router reported. */
export function turnRows(turns: TurnRecord[]): MetricRow[] {
	if (turns.length === 0) return [];
	const rows: MetricRow[] = [];
	const spark = sparkline(turns.map((t) => t.tg));
	if (spark !== "") rows.push({ label: "tok/s by turn", value: spark, tone: "dim" });
	for (const t of turns.slice(-4).reverse()) {
		const bits = [`pp ${compactNumber(t.pp)}`, `tg ${t.tg}`, ...(t.ttft !== undefined ? [`ttft ${t.ttft.toFixed(2)}s`] : []), ...(t.kv_hit_pct !== undefined ? [`kv ${t.kv_hit_pct}%`] : []), `swap ${Math.round(t.swap_ms / 100) / 10}s`];
		rows.push({ label: `#${t.turn} R${t.round}${t.phase ? ` ${t.phase}` : ""}`, value: bits.join(" · ") });
	}
	return rows;
}

/** The swap rows: what each pack swap cost, and the ramp class of its first completion. */
export function swapRows(swaps: SwapRow[]): MetricRow[] {
	return swaps.slice(0, SCREEN_SWAPS).map((s) => {
		const ramp = s.ramp === "map_restored" ? "MoE restored" : s.ramp === "hot_steady" ? "hot steady" : s.ramp === "cold_ramp" ? "cold ramp" : "ramp ?";
		return {
			label: `${s.from} → ${s.to}`,
			value: `${s.elapsed_s.toFixed(1)}s · ${Math.round(s.first_tg)}→${Math.round(s.steady_tg)} tok/s · ${ramp} · ${clockOf(s.at)}`,
		};
	});
}

/** The pre-swap gate as one row: a red gate is the reason a round repeated. */
export function gateRows(gate: GateResult | undefined): MetricRow[] {
	if (!gate) return [{ label: "gate", value: "no gate run this round", tone: "dim" }];
	const bad = gate.results.filter((r) => !r.ok);
	const asExpected = gate.results.filter((r) => r.as_expected);
	const rows: MetricRow[] = [
		{
			label: "gate",
			value: `${gate.passed ? "GREEN" : "RED"} ${bad.length}/${gate.results.length} failing${asExpected.length ? ` · ${asExpected.length} as expected` : ""} · ${clockOf(gate.at)}`,
			tone: gate.passed ? "ok" : "bad",
		},
	];
	for (const f of bad) rows.push({ label: "  red", value: `${f.cmd} → ${f.expected}`, tone: "bad" });
	// A declared-failure row that failed as declared is GREEN, and it says so — never a silent pass.
	for (const a of asExpected) rows.push({ label: "  ok*", value: `${a.cmd} → ${a.expected}`, tone: "dim" });
	return rows;
}

/** `HH:MM:SS` in the operator's clock; an unparseable stamp prints as the raw text, never a fake time. */
export function clockOf(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const pad = (n: number) => `${n}`.padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Wall time since the run started, seconds; undefined for a missing/unparseable start. */
export function elapsedSince(startedUtc: string | undefined, now: Date): number | undefined {
	if (!startedUtc) return undefined;
	const t = new Date(startedUtc).getTime();
	if (Number.isNaN(t)) return undefined;
	return Math.max(0, Math.round((now.getTime() - t) / 1000));
}

/** `14m02s` / `1h04m` — the run's age, the number the operator reads first. */
export function formatElapsed(seconds: number): string {
	const m = Math.floor(seconds / 60);
	if (m < 60) return `${m}m${`${Math.round(seconds % 60)}`.padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${`${m % 60}`.padStart(2, "0")}m`;
}

/**
 * The ONE row that names the model: the engine column's `resident` row, printed through
 * `modelLabel` — the naming rule lives there. The lane key comes from the router's `model` field
 * (basalt 0.4.0 answers `loaded` as a BOOLEAN), so the display name comes from the registry names
 * the caller injects; with no name the key rides, never a fabricated label.
 *
 * The type guard is not decoration: `loaded` is not guaranteed to be a lane key, and a non-string
 * reaching `modelLabel` throws, which kills the panel OPEN and leaves no screen on the live
 * router. A screen must never die on a shape it did not predict.
 */
export function nameResidentRow(tiers: MetricRow[], metrics: MetricsSnapshot | undefined, names: Record<string, string | undefined> | undefined): MetricRow[] {
	const loaded = typeof metrics?.loaded === "string" ? metrics.loaded : undefined;
	if (!loaded) return tiers;
	const label = modelLabel(names?.[loaded] ?? loaded);
	const state = metrics?.loading === true ? " loading" : "";
	return tiers.map((r) => (r.label === "resident" ? { ...r, value: `${label}${state}`.trim() } : r));
}

/**
 * The whole screen, assembled. Every source is read once; the router request is the only network
 * call, and it is skipped when the caller already holds a snapshot. The two ledgers
 * (`swap_history.json`, the `metrics.jsonl` tail) are read ASYNC and TOGETHER — this runs on the
 * Alt+F keystroke and on the panel's 2 s refresh tick, and the old synchronous whole-file reads
 * there were the worst freeze in the product: the keystroke painted nothing while the append-only
 * ledger was parsed line by line.
 */
export async function collectScreen(src: ScreenSource): Promise<ScreenData> {
	const now = (src.now ?? (() => new Date()))();
	const [metrics, swaps, turns] = await Promise.all([
		src.metrics ?? fetchMetrics(),
		src.swaps ?? readSwaps(src.runDir),
		src.turns ?? readTurns(src.runDir, SCREEN_TURNS),
	]);
	const moe = [
		...moeRows([src.lanes.think, src.lanes.code], { configPath: src.moeConfigPath }),
		// GPU placement: the serve config names each alias's `gpu` and reserves, so the row exists for
		// BOTH lanes; the file-tier spill is only measurable on the RESIDENT engine, so the other
		// lane's row says spill is unmeasured rather than claiming zero.
		...moeBalanceRows([src.lanes.think, src.lanes.code], {
			configPath: src.moeConfigPath,
			healthByLane: metrics?.loaded ? { [metrics.loaded]: { spill_experts: metrics.spill_experts, spill_total: metrics.spill_total, spill_bytes_gb: metrics.spill_bytes_gb, slots: metrics.slots } } : {},
		}),
	];
	const tiers = [...nameResidentRow(tiersFromMetrics(metrics), metrics, src.names), claimRow(src)];
	const missing: string[] = [];
	if (!metrics) missing.push(`router ${ROUTER} unreachable — engine, decode and queue are not measured`);
	if (swaps.length === 0) missing.push("no swaps recorded");
	if (turns.length === 0) missing.push("no turn telemetry (the router reported no pp/tg)");
	const elapsed_s = elapsedSince(src.run.started_utc, now);
	if (elapsed_s === undefined) missing.push("no run start in the state file");

	const context: ScreenContext | undefined =
		src.context && typeof src.context.tokens === "number" && src.context.percent !== null
			? { tokens: src.context.tokens, window: src.context.contextWindow, percent: src.context.percent }
			: undefined;
	if (!context) missing.push("no context meter");

	let critique: string | undefined;
	// A run state written mid-plan can lack `phases` entirely, and a screen must never die on a
	// shape it did not predict: `src.run.phases.length` throws `undefined is not an object` on
	// such a state and the panel arrives as an error notify. An absent history is no critique.
	const phases = Array.isArray(src.run.phases) ? src.run.phases : [];
	for (let i = phases.length - 1; i >= 0; i--) {
		const p = phases[i] as { phase?: string; notes?: unknown };
		if (p?.phase === "verification_done" && typeof p.notes === "string") {
			critique = p.notes;
			break;
		}
	}

	return {
		run: src.run,
		refreshed_utc: now.toISOString(),
		elapsed_s,
		lanes: laneRows(src, metrics),
		tiers,
		moe,
		turns,
		swaps,
		context,
		gate: src.run.gate_last,
		critique,
		flip: src.flip,
			claim: src.claim ?? null,
		missing,
	};
}

/** The router's claim in the operator's terms: this run, a NAMED foreign holder, free, or not
 *  measured. A refused start names the same fields in its notify, and this is the row the operator
 *  reads next, so it carries pid, run, repo and host — never a bare "locked". */
export function claimRow(src: ScreenSource): TierRow {
	if (src.claim === undefined) return { label: "router claim", value: "not measured" };
	if (src.claim === null) return { label: "router claim", value: "free — no run holds this router" };
	return src.claim.run_id === src.run.run_id
		? { label: "router claim", value: `this run (pid ${src.claim.pid})` }
		: { label: "router claim", value: `HELD BY pid ${src.claim.pid}: run ${src.claim.run_id} in ${src.claim.repo} on ${src.claim.host}` };
}
