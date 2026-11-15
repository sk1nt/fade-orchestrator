/**
 * Live router data for the overlay: the tiers panel, the swap watcher that times every pack
 * swap, and the cold/hot read of the resident lane.
 *
 * Measured basis (basalt 0.4.0, this host, 2026-11-14/15):
 * - `/health` during a swap: `{"loaded","loading","percent":42,"swap":{"from","to","phase","since"}}`.
 * - `/metrics`: the tier fields are nested under `engine` —
 *   `engine.{quant,version,expert_slots,expert_total,spill:{experts,total,bytes}}`,
 *   `live:{state,queued,slots:{total,active,queue_depth},tok_s}`, and per-request records carrying
 *   `decode_tok_s`, `hit_rate`, `reused`, `pcie_share`, `ssd_share`, `drafts_offered/accepted`
 *   (older payloads carry `durations` whose FIRST element is TTFT and the rest per-token decode
 *   seconds — decode tok/s = 1 / median(rest)). Measured on the same box: the served IQ1_M
 *   `expert_slots` is 2,200 with **no spill** — the tier row is the reason the plugin pins
 *   IQ1_M.
 * - The deepseek promote window measured ~91 tok/s for its first ~1,200 tokens, steady ~130;
 *   flash-next 480-647. Those are the cold-ramp and hot numbers the overlay labels.
 */
import { join } from "node:path";
import { ROUTER } from "./router.ts";
import type { TierRow } from "./ui.ts";
import { appendSwap, rampClass, type SwapRow, type TurnMetrics } from "./history.ts";
import type { LaneMoe } from "./moe.ts";
import { writeJson } from "./core.ts";

export const METRICS_FILENAME = "metrics_state.json";

export interface MetricsRequest {
	model?: string;
	prompt_n?: number;
	/** The current engine's own decode rate; older payloads carry per-token `durations` instead. */
	decode_tok_s?: number;
	/** Prompt-processing tok/s, the serve log's own `pp`; older payloads report only `prompt_ms`. */
	pp?: number;
	/** Prompt tokens reused from the conversation cache (the stable-prefix win). */
	hit_rate?: number;
	reused?: number;
	prompt_tokens?: number;
	/** Routed-expert reads that crossed PCIe / landed in the file (the spill cost, per request). */
	pcie_share?: number;
	ssd_share?: number;
	drafts_offered?: number;
	drafts_accepted?: number;
	ttft_s?: number;
	prompt_ms?: number;
	durations?: number[];
}

export interface MetricsSnapshot {
	quant?: string;
	engine_version?: string;
	slots?: number;
	spill_experts?: number;
	spill_total?: number;
	spill_bytes_gb?: number;
	live_state?: string;
	live_slots?: number;
	queue?: number;
	tok_s?: number;
	/** The router's own best decode rate (`best.decode.tok_s`), the strongest rate it publishes. */
	best_decode?: number;
	/** The lane the router RESIDENTS, as a lane key ("flash-next"). Measured on basalt 0.4.0,
	 *  `/health?phase=display` answers `loaded` as a BOOLEAN ("is a pack resident") and names the
	 *  lane under `model`. Reading `loaded` as the name — the flat pre-0.4 shape — printed
	 *  `resident true`, made the `◆resident` marker unmatchable, and threw in the renderer
 *  (`name.indexOf is not a function`), so the panel opened nothing. `src/router.ts` already reads
	 *  this correctly; this reader now agrees with it. */
	loaded?: string;
	/** The router's own boolean: is any pack resident at all. */
	packLoaded?: boolean;
	loading?: boolean;
	percent?: number | null;
	requests?: MetricsRequest[];
	at_utc: string;
}

async function fetchJson<T>(url: string, timeoutMs = 1500): Promise<T | undefined> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ac.signal });
		if (!res.ok) return undefined;
		return (await res.json()) as T;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** Decode tok/s from one /metrics request record: 1 / median(per-token seconds after TTFT). */
export function rateFromRequest(r: MetricsRequest | undefined): number | undefined {
	if (!r) return undefined;
	if (typeof r.decode_tok_s === "number" && r.decode_tok_s > 0) return r.decode_tok_s;
	if (!Array.isArray(r.durations)) return undefined;
	const perToken = (r.durations ?? []).slice(1).filter((d) => typeof d === "number" && d > 0);
	if (perToken.length < 3) return undefined;
	perToken.sort((a, b) => a - b);
	const med = perToken[Math.floor(perToken.length / 2)];
	return med > 0 ? 1 / med : undefined;
}

/** Time to first token, seconds: the engine's own field, else the measured `durations[0]` = TTFT. */
function ttftOf(r: MetricsRequest | undefined): number | undefined {
	if (!r) return undefined;
	if (typeof r.ttft_s === "number" && r.ttft_s > 0) return r.ttft_s;
	const d = Array.isArray(r.durations) ? r.durations[0] : undefined;
	return typeof d === "number" && d > 0 ? d : undefined;
}

/** Prompt-processing tok/s: the engine's `pp` (the serve log's `pp=111459`), else prompt tokens
 *  over the prefill window — `prompt_ms` when reported, TTFT as the bound. Measured basis: a
 *  106k-token prompt prefills in 3.5 s (1,499 tok/s), the same prompt at an 82% hit in 0.5 s. */
function promptRateOf(r: MetricsRequest | undefined): number | undefined {
	if (!r) return undefined;
	if (typeof r.pp === "number" && r.pp > 0) return r.pp;
	const n = typeof r.prompt_tokens === "number" ? r.prompt_tokens : r.prompt_n;
	if (typeof n !== "number" || n <= 0) return undefined;
	const secs = typeof r.prompt_ms === "number" && r.prompt_ms > 0 ? r.prompt_ms / 1000 : ttftOf(r);
	return secs !== undefined && secs > 0 ? n / secs : undefined;
}

/**
 * The four per-turn numbers the telemetry record needs (Y18), read off the newest /metrics
 * request record. Each field is MISSING when the engine did not report it, and a closed router
 * yields an empty object: `turnRecordOrNull` then writes no line, so the ledger has no zeros.
 */
export function turnMetricsFrom(requests: MetricsRequest[] | undefined): TurnMetrics {
	const reqs = requests ?? [];
	const last = reqs[reqs.length - 1];
	const out: TurnMetrics = {};
	const pp = promptRateOf(last);
	if (pp !== undefined) out.pp = Math.round(pp);
	const tg = rateFromRequest(last);
	if (tg !== undefined) out.tg = Math.round(tg);
	const ttft = ttftOf(last);
	if (ttft !== undefined) out.ttft = Math.round(ttft * 1000) / 1000;
	const withHit = reqs.filter((r) => typeof r.hit_rate === "number");
	const hit = withHit[withHit.length - 1];
	if (hit) out.kv_hit_pct = Math.round((hit.hit_rate ?? 0) * 1000) / 10;
	return out;
}

/** The live read of the same numbers: one `/metrics` request, fields undefined when unreachable. */
export async function fetchTurnMetrics(): Promise<TurnMetrics> {
	const m = await fetchJson<Record<string, any>>(`${ROUTER}/metrics`);
	return turnMetricsFrom(Array.isArray(m?.requests) ? (m.requests as MetricsRequest[]) : undefined);
}

/** Pull the fields the overlay shows out of the /metrics + /health payloads. */
export async function fetchMetrics(): Promise<MetricsSnapshot | undefined> {
	const [m, h] = await Promise.all([
		fetchJson<Record<string, unknown>>(`${ROUTER}/metrics`),
		fetchJson<Record<string, unknown>>(`${ROUTER}/health?phase=display`),
	]);
	if (!m && !h) return undefined;
	const mm = (m ?? {}) as Record<string, any>;
	const hh = (h ?? {}) as Record<string, any>;
	/** A lane key is a non-empty string; the router's boolean/number fields are never one. */
	const laneKey = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
	// basalt 0.4.0 nests the tier fields under `engine`; a pre-0.4 payload carried them flat
	// (`expert_slots.total`, `spill.bytes_gb`). Read both, newest first — a reader that silently
	// prints `?` for the numbers the overlay exists to show is the defect this ordering avoids.
	const eng = (mm.engine ?? {}) as Record<string, any>;
	const spill = (eng.spill ?? mm.spill) as Record<string, any> | undefined;
	const bytes = typeof spill?.bytes === "number" ? spill.bytes : undefined;
	const slots = typeof eng.expert_slots === "number" ? eng.expert_slots : mm.expert_slots?.total;
	const liveQueued = mm.live?.queued ?? mm.live?.slots?.queue_depth;
	// Measured on the live router (2026-11-15): `engine.quant` carries the LANE NAME, not a
	// quantization, so a reader that prints it labels the engine `quant flash-next`. A quant is only
	// printed when the payload names one that is not the lane.
	const lane = laneKey(hh.model) ?? laneKey(eng.model) ?? laneKey(mm.model);
	const quant = [eng.quant, mm.quant].find((q) => typeof q === "string" && q.length > 0 && q !== lane);
	const bestDecode = typeof mm.best?.decode?.tok_s === "number" ? mm.best.decode.tok_s : undefined;
	const snap: MetricsSnapshot = {
		quant: typeof quant === "string" ? quant : undefined,
		engine_version: eng.version ?? mm.engine_version,
		slots,
		spill_experts: spill?.experts,
		spill_total: spill?.total ?? eng.expert_total,
		spill_bytes_gb: typeof spill?.bytes_gb === "number" ? spill.bytes_gb : bytes !== undefined ? bytes / 1e9 : undefined,
		live_state: mm.live?.state,
		live_slots: mm.live?.slots?.active,
		queue: typeof liveQueued === "number" ? liveQueued : Array.isArray(mm.queue) ? mm.queue.length : mm.queue,
		tok_s: mm.live?.tok_s,
		best_decode: bestDecode,
		loaded: lane,
		packLoaded: typeof hh.loaded === "boolean" ? hh.loaded : undefined,
		loading: hh.loading === true,
		percent: typeof hh.percent === "number" ? hh.percent : null,
		requests: Array.isArray(mm.requests) ? mm.requests : undefined,
		at_utc: new Date().toISOString(),
	};
	return snap;
}

/** The tiers panel rows, from a snapshot (empty when the router is unreachable). */
export function tiersFromMetrics(s: MetricsSnapshot | undefined): TierRow[] {
	if (!s) return [{ label: "router", value: `${ROUTER} unreachable` }];
	const rates = (s.requests ?? []).map(rateFromRequest).filter((r): r is number => r !== undefined);
	const bestRate = Math.max(s.best_decode ?? -Infinity, ...(rates.length > 0 ? rates : [-Infinity]));
	const best = Number.isFinite(bestRate) ? bestRate : undefined;
	return [
		{ label: "engine", value: `${s.engine_version ?? "?"}${s.quant ? ` quant ${s.quant}` : ""}` },
		{ label: "resident", value: `${s.loaded ?? (s.packLoaded === true ? "pack (lane unnamed)" : "?")}${s.loading ? " (loading)" : ""}${s.percent != null ? ` ${s.percent}%` : ""}` },
		{ label: "expert slots", value: `${s.slots ?? "?"} · spill ${s.spill_experts ?? "?"}/${s.spill_total ?? "?"}${s.spill_bytes_gb !== undefined ? ` · ${s.spill_bytes_gb.toFixed(1)} GB` : ""}` },
		{ label: "decode now", value: s.tok_s ? `${Math.round(s.tok_s)} tok/s (queue ${s.queue ?? 0}, ${s.live_state ?? "?"})` : "idle" },
		{ label: "best recent", value: best !== undefined ? `${Math.round(best)} tok/s` : "no completed requests" },
		moeCacheRow(s.requests),
	];
}

/**
 * Cold vs hot: the pill suffix. A lane is cold while its decode rate sits under 80% of the best
 * rate observed for that lane since it became resident (the measured deepseek ramp: 91 cold
 * against 130 steady = 0.70).
 */
export function coldHot(tok_s: number | undefined, laneBest: number | undefined): { label: "cold" | "hot" | "idle"; rate?: number } {
	if (tok_s === undefined || laneBest === undefined || laneBest <= 0) return { label: "idle" };
	if (tok_s < 0.5) return { label: "idle" };
	return { label: tok_s >= 0.8 * laneBest ? "hot" : "cold", rate: tok_s };
}

export interface SwapWatchHandle {
	/** Stop sampling without writing a row (failure path). */
	cancel(): void;
	/** Await the swap completing (bounded), compute first/steady rates, append the history row. */
	finish(from: string, to: string, elapsed_s: number, dir: string): Promise<SwapRow | undefined>;
}

/**
 * Start watching a swap the caller is about to drive: sample /health (phase/percent) every 2 s.
 * The row is only written when the router actually swapped (a swap object observed, or the
 * resident lane differed at start); a no-op "load the resident entry" produces nothing.
 *
 * `onSample` reports each sample's percent as it arrives, so the status row can animate the load
 * (the multicolored "switching" line) instead of showing one static word for 20 seconds.
 */
export function startSwapWatch(to: string, moe?: LaneMoe, onSample?: (percent: number | undefined) => void): SwapWatchHandle {
	const t0 = Date.now();
	const percentPath: number[] = [];
	let sawSwap = false;
	let stopped = false;
	const sample = async () => {
		while (!stopped && Date.now() - t0 < 120_000) {
			const h = await fetchJson<Record<string, any>>(`${ROUTER}/health?phase=load:${to.replace(/[^a-z0-9]+/gi, "_")}`, 2000);
			if (h?.swap) sawSwap = true;
			const pct = typeof h?.percent === "number" ? h.percent : undefined;
			if (pct !== undefined) percentPath.push(pct);
			onSample?.(pct);
			// basalt 0.4.0 names the resident lane under `model` and answers `loaded` as a boolean, so
			// the old `h.loaded === to` test could NEVER fire on this router: every swap ran out the
			// full 120 s window and the row's percent never moved. The string form stays as the
			// pre-0.4 / rig shape.
			const resident = typeof h?.model === "string" ? h.model : typeof h?.loaded === "string" ? h.loaded : undefined;
			if (resident !== undefined && resident === to && (h?.loading === false || h?.loaded === true)) break;
			await new Promise((r) => setTimeout(r, 2000));
		}
		stopped = true;
	};
	void sample();
	return {
		cancel() {
			stopped = true;
		},
		async finish(from, toLane, elapsed_s, dir) {
			stopped = true;
			if (!sawSwap && from === toLane) return undefined;
			const m = await fetchJson<Record<string, any>>(`${ROUTER}/metrics`);
			const reqs = (Array.isArray(m?.requests) ? m.requests : [])
				.filter((r: any) => typeof r.model === "string" && r.model.replace(":", "") === toLane.replace(":", ""))
				.map((r: any) => ({ model: r.model, prompt_n: r.prompt_n ?? r.prompt_tokens ?? 0, durations: r.durations ?? [] }))
				.filter((r) => r.durations.length > 3)
				.sort((a, b) => a.prompt_n - b.prompt_n);
			const big = reqs.filter((r) => r.prompt_n >= 500);
			const first = rateFromRequest(big.length > 0 ? big[0] : reqs[0]);
			const steady = rateFromRequest(reqs[reqs.length - 1]);
			// A start that placed from a saved MoE placement map is warm BY CONSTRUCTION (moe.ts
			// samples the profile's existence BEFORE the swap); the rate alone cannot tell a warm
			// start from a lane that simply has not decoded anything long enough yet.
			const mapRestored = moe?.state === "live" && moe.profile_exists === true;
			const row: SwapRow = {
				from,
				to: toLane,
				elapsed_s,
				first_tg: first ?? 0,
				steady_tg: steady ?? 0,
				elapsed_ms: Math.round(elapsed_s * 1000),
				ramp: rampClass(first, mapRestored),
				percent_path: percentPath.slice(0, 60),
				...(moe ? { moe } : {}),
				at: new Date().toISOString(),
			};
			appendSwap(dir, row);
			return row;
		},
	};
}


/**
 * The stable-prefix win, measured: a request's `hit_rate` is the fraction of its prompt reused from
 * the conversation cache (measured 2026-11-15 on the served lane: 0.796-0.858, ~200k tokens reused
 * per request). A handover built STABLE FIRST (core.handover) keeps this high across resumes — the
 * cache itself does NOT cross a lane swap: the same 47k-token prefix reused **0** tokens on the lane
 * a swap landed on (`scripts/ops/basalt_cache_probe.sh --swap`, 2026-11-15), which is exactly why
 * swaps are expensive and the flip guard prices them.
 */
export function moeCacheRow(requests: MetricsRequest[] | undefined): { label: string; value: string } {
	const withHit = (requests ?? []).filter((r) => typeof r.hit_rate === "number");
	if (withHit.length === 0) return { label: "prefix cache", value: "no hit_rate reported" };
	const last = withHit[0]; // /metrics `requests` is newest-first: the row's "last" is the most recent request
	const n = Math.min(withHit.length, 8);
	const recent = withHit.slice(0, n); // newest-first source: the LAST n requests are the FIRST n entries
	const mean = recent.reduce((s, r) => s + (r.hit_rate ?? 0), 0) / recent.length;
	// `pcie_share` / `ssd_share` are the routed-expert reads that crossed PCIe / landed in the file
	// — the spill cost as the engine measures it, per request. Live on this box: pcie reported
	// (~0.54), ssd_share NULL on every request. An absent reading is NAMED, never rendered as a zero.
	const share = (key: "ssd_share" | "pcie_share"): string => {
		const vals = recent.filter((r) => typeof r[key] === "number").map((r) => r[key] as number);
		return vals.length === 0 ? `${key === "ssd_share" ? "ssd" : "pcie"} not reported` : `${key === "ssd_share" ? "ssd" : "pcie"} ${((vals.reduce((s, v) => s + v, 0) / vals.length) * 100).toFixed(1)}%`;
	};
	return {
		label: "prefix cache",
		value: `${(mean * 100).toFixed(1)}% hit over ${n} req · last ${((last.hit_rate ?? 0) * 100).toFixed(1)}% (${last.reused ?? 0} tok reused) · ${share("pcie_share")} · ${share("ssd_share")}`,
	};
}

/** Best decode rate observed for a lane across the /metrics request window (the hot baseline). */
export function laneBestRate(s: MetricsSnapshot, lane: string): number | undefined {
	const slug = lane.replace(":", "");
	// basalt 0.4.0's request records carry no `model` (the window belongs to the resident lane, and
	// `/metrics?model=` is filtered server-side); older payloads DO carry it. Either shape counts,
	// and a model-tagged record for a DIFFERENT lane is still ignored.
	const rates = (s.requests ?? [])
		.filter((r) => typeof r.model !== "string" || r.model.replace(":", "") === slug)
		.map(rateFromRequest)
		.filter((r): r is number => r !== undefined);
	return rates.length > 0 ? Math.max(...rates) : undefined;
}

/** Persist the latest snapshot next to state.json: the desk and postmortems can read the tiers. */
export function persistMetrics(dir: string, snap: MetricsSnapshot): void {
	writeJson(join(dir, METRICS_FILENAME), { key: "fade.omp_orchestrate.metrics.v1", ...snap });
}
