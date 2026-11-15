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
 *   seconds — decode tok/s = 1 / median(rest)). Measured on the same box: IQ1_M `expert_slots`
 *   2,200 with **no spill**; IQ2_XXS 1,600 with **2,680/15,360 experts and 27.37 GB in the file**,
 *   which is that pack's decode collapse — the tier row is the reason the plugin pins IQ1_M.
 * - The deepseek promote window measured ~91 tok/s for its first ~1,200 tokens, steady ~130;
 *   flash-next 480-647. Those are the cold-ramp and hot numbers the overlay labels.
 */
import { join } from "node:path";
import { ROUTER } from "./router.ts";
import type { TierRow } from "./ui.ts";
import { appendSwap, type SwapRow } from "./history.ts";
import type { LaneMoe } from "./moe.ts";
import { writeJson } from "./core.ts";

export const METRICS_FILENAME = "metrics_state.json";

export interface MetricsRequest {
	model?: string;
	prompt_n?: number;
	/** The current engine's own decode rate; older payloads carry per-token `durations` instead. */
	decode_tok_s?: number;
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
	loaded?: string;
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

/** Pull the fields the overlay shows out of the /metrics + /health payloads. */
export async function fetchMetrics(): Promise<MetricsSnapshot | undefined> {
	const [m, h] = await Promise.all([
		fetchJson<Record<string, unknown>>(`${ROUTER}/metrics`),
		fetchJson<Record<string, unknown>>(`${ROUTER}/health?phase=display`),
	]);
	if (!m && !h) return undefined;
	const mm = (m ?? {}) as Record<string, any>;
	const hh = (h ?? {}) as Record<string, any>;
	// basalt 0.4.0 nests the tier fields under `engine`; a pre-0.4 payload carried them flat
	// (`expert_slots.total`, `spill.bytes_gb`). Read both, newest first — a reader that silently
	// prints `?` for the numbers the overlay exists to show is the defect this ordering avoids.
	const eng = (mm.engine ?? {}) as Record<string, any>;
	const spill = (eng.spill ?? mm.spill) as Record<string, any> | undefined;
	const bytes = typeof spill?.bytes === "number" ? spill.bytes : undefined;
	const slots = typeof eng.expert_slots === "number" ? eng.expert_slots : mm.expert_slots?.total;
	const liveQueued = mm.live?.queued ?? mm.live?.slots?.queue_depth;
	const snap: MetricsSnapshot = {
		quant: eng.quant ?? mm.quant,
		engine_version: eng.version ?? mm.engine_version,
		slots,
		spill_experts: spill?.experts,
		spill_total: spill?.total ?? eng.expert_total,
		spill_bytes_gb: typeof spill?.bytes_gb === "number" ? spill.bytes_gb : bytes !== undefined ? bytes / 1e9 : undefined,
		live_state: mm.live?.state,
		live_slots: mm.live?.slots?.active,
		queue: typeof liveQueued === "number" ? liveQueued : Array.isArray(mm.queue) ? mm.queue.length : mm.queue,
		tok_s: mm.live?.tok_s,
		loaded: hh.loaded,
		loading: hh.loading,
		percent: hh.percent ?? null,
		requests: Array.isArray(mm.requests) ? mm.requests : undefined,
		at_utc: new Date().toISOString(),
	};
	return snap;
}

/** The tiers panel rows, from a snapshot (empty when the router is unreachable). */
export function tiersFromMetrics(s: MetricsSnapshot | undefined): TierRow[] {
	if (!s) return [{ label: "router", value: `${ROUTER} unreachable` }];
	const rates = (s.requests ?? []).map(rateFromRequest).filter((r): r is number => r !== undefined);
	const best = rates.length > 0 ? Math.max(...rates) : undefined;
	return [
		{ label: "engine", value: `${s.engine_version ?? "?"} quant ${s.quant ?? "?"}` },
		{ label: "resident", value: `${s.loaded ?? "?"}${s.loading ? " (loading)" : ""}${s.percent != null ? ` ${s.percent}%` : ""}` },
		{ label: "expert slots", value: `${s.slots ?? "?"} · spill ${s.spill_experts ?? "?"}/${s.spill_total ?? "?"}${s.spill_bytes_gb !== undefined ? ` · ${s.spill_bytes_gb.toFixed(1)} GB` : ""}` },
		{ label: "decode now", value: s.tok_s ? `${Math.round(s.tok_s)} tok/s (queue ${s.queue ?? 0}, ${s.live_state ?? "?"})` : "idle" },
		{ label: "best recent", value: best ? `${Math.round(best)} tok/s` : "no completed requests" },
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
 */
export function startSwapWatch(to: string, moe?: LaneMoe): SwapWatchHandle {
	const t0 = Date.now();
	const percentPath: number[] = [];
	let sawSwap = false;
	let stopped = false;
	const sample = async () => {
		while (!stopped && Date.now() - t0 < 120_000) {
			const h = await fetchJson<Record<string, any>>(`${ROUTER}/health?phase=load:${to.replace(/[^a-z0-9]+/gi, "_")}`, 2000);
			if (h?.swap) sawSwap = true;
			if (typeof h?.percent === "number") percentPath.push(h.percent);
			if (h?.loaded === to && h?.loading === false) break;
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
			const row: SwapRow = {
				from,
				to: toLane,
				elapsed_s,
				first_tg: first ?? 0,
				steady_tg: steady ?? 0,
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
 * The stable-prefix win, measured: a request's `hit_rate` is the fraction of its prompt reused
 * from the conversation cache (log lines measured 44.9% early and 82.3% once the prefix settles).
 * A handover built STABLE FIRST (core.handover) keeps this high across resumes and lane returns.
 */
export function moeCacheRow(requests: MetricsRequest[] | undefined): { label: string; value: string } {
	const withHit = (requests ?? []).filter((r) => typeof r.hit_rate === "number");
	if (withHit.length === 0) return { label: "prefix cache", value: "no hit_rate reported" };
	const last = withHit[withHit.length - 1];
	const n = Math.min(withHit.length, 8);
	const recent = withHit.slice(-n);
	const mean = recent.reduce((s, r) => s + (r.hit_rate ?? 0), 0) / recent.length;
	// `ssd_share` is the routed-expert fraction that came from the FILE — the spill cost as the
	// engine measures it, per request. IQ1_M read 0.0 on this host; IQ2_XXS read >0 on every
	// request it served, which is the whole reason the tier row matters.
	const ssd = recent.filter((r) => typeof r.ssd_share === "number");
	const ssdText = ssd.length > 0 ? ` · ssd ${((ssd.reduce((s, r) => s + (r.ssd_share ?? 0), 0) / ssd.length) * 100).toFixed(1)}%` : "";
	return {
		label: "prefix cache",
		value: `${(mean * 100).toFixed(1)}% hit over ${n} req · last ${((last.hit_rate ?? 0) * 100).toFixed(1)}% (${last.reused ?? 0} tok reused)${ssdText}`,
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
