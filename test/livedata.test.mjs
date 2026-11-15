/**
 * livedata + history unit tests: the pure readers behind the overlay (rates from /metrics
 * request durations, cold/hot against the lane baseline, tier rows) and the swap-history store
 * (append, newest-first order, cap). No network: fixtures are the measured /metrics shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coldHot, laneBestRate, moeCacheRow, rateFromRequest, tiersFromMetrics } from "../.test-build/livedata.mjs";
import { appendSwap, readSwaps } from "../.test-build/history.mjs";

test("rateFromRequest: 1 / median(per-token seconds after TTFT)", () => {
	assert.equal(rateFromRequest({ durations: [22.722, 0.01, 0.01, 0.02, 0.01, 0.01] }), 100);
	assert.equal(rateFromRequest({ durations: [1.0, 0.002, 0.002, 0.002] }), 500);
	assert.equal(rateFromRequest({ durations: [0.5, 0.01] }), undefined, "fewer than 3 per-token samples is no rate");
	assert.equal(rateFromRequest(undefined), undefined, "no request yet is not a crash (the post-swap window)");
	assert.equal(rateFromRequest({ durations: [] }), undefined);
});

test("coldHot: measured deepseek ramp 91 against steady 130 reads cold; 130 reads hot", () => {
	assert.equal(coldHot(91, 130).label, "cold");
	assert.equal(coldHot(130, 130).label, "hot");
	assert.equal(coldHot(104, 130).label, "hot", "0.8*130 = 104 is the boundary");
	assert.equal(coldHot(0, 130).label, "idle");
	assert.equal(coldHot(130, undefined).label, "idle", "no baseline is not hot");
});

test("tiersFromMetrics: engine/quant/slots/spill rows from the measured 0.4.0 payload", () => {
	// The measured shape: tiers nest under `engine`, spill bytes are decimal bytes (not GiB).
	const rows = tiersFromMetrics({
		engine_version: "0.4.0",
		quant: "IQ1_M",
		slots: 2200,
		spill_experts: 0,
		spill_total: 15360,
		spill_bytes_gb: 0.0,
		live_state: "decode",
		live_slots: 1,
		queue: 0,
		tok_s: 130,
		loaded: "deepseek",
		loading: false,
		percent: null,
		requests: [{ model: "strata-flash/deepseek", prompt_n: 1000, durations: [10, 0.0077, 0.0077, 0.0077, 0.0077] }],
		at_utc: "2026-11-15T00:00:00Z",
	});
	const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
	assert.equal(byLabel["engine"], "0.4.0 quant IQ1_M");
	assert.equal(byLabel["resident"], "deepseek");
	assert.match(byLabel["expert slots"], /2200 · spill 0\/15360 · 0\.0 GB/);
	assert.match(byLabel["decode now"], /130 tok\/s/);
	assert.equal(tiersFromMetrics(undefined)[0].label, "router");
});

test("tiersFromMetrics: the IQ1 lane reads zero spill, which is the whole choice", () => {
	const rows = tiersFromMetrics({
		engine_version: "0.4.0",
		quant: "IQ1_M",
		slots: 2200,
		spill_experts: 0,
		spill_total: 15360,
		live_state: "decode",
		live_slots: 1,
		queue: 0,
		tok_s: 130,
		loaded: "deepseek",
		at_utc: "2026-11-15T00:00:00Z",
	});
	const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
	assert.match(byLabel["expert slots"], /2200 · spill 0\/15360/);
	assert.doesNotMatch(byLabel["expert slots"], /GB/, "no spill bytes means no size suffix");
});

test("fetchMetrics field mapping is exercised through the flat pre-0.4 shape too", () => {
	// The pre-0.4 payload put the same numbers at the top level; the reader must not print `?`.
	const rows = tiersFromMetrics({
		engine_version: "0.3.3",
		quant: "IQ1_M",
		slots: 2200,
		spill_experts: 0,
		spill_total: 15360,
		spill_bytes_gb: 0,
		loaded: "deepseek",
		queue: 2,
		at_utc: "x",
	});
	const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
	assert.equal(byLabel["engine"], "0.3.3 quant IQ1_M");
	assert.match(byLabel["decode now"], /idle/, "no live rate reads idle, not a fake number");
});

test("laneBestRate: model-less (0.4.0) records count for the resident lane, tagged ones still filter", () => {
	const snap = {
		requests: [
			{ prompt_n: 100, decode_tok_s: 91 },
			{ prompt_n: 900, decode_tok_s: 130 },
			{ model: "strata-flash/flash-next", prompt_n: 900, durations: [1, 0.002, 0.002, 0.002, 0.002] },
		],
		at_utc: "x",
	};
	assert.equal(laneBestRate(snap, "strata-flash/deepseek"), 130);
	assert.equal(laneBestRate({ requests: [{ durations: [1, 0.01, 0.01, 0.01] }], at_utc: "x" }, "strata-flash/deepseek"), 100);
});

test("moeCacheRow: hit rate plus the engine's measured ssd share", () => {
	const row = moeCacheRow([
		{ hit_rate: 0.5, reused: 100, ssd_share: 0.0 },
		{ hit_rate: 1.0, reused: 900, ssd_share: 0.0 },
	]);
	assert.match(row.value, /75\.0% hit over 2 req/);
	assert.match(row.value, /ssd 0\.0%/);
	assert.equal(moeCacheRow(undefined).value, "no hit_rate reported");
});

test("laneBestRate: max over the lane's requests, other lanes ignored", () => {
	const snap = {
		requests: [
			{ model: "strata-flash/deepseek", prompt_n: 100, durations: [1, 0.01, 0.01, 0.01, 0.01] },
			{ model: "strata-flash/deepseek", prompt_n: 900, durations: [1, 0.008, 0.008, 0.008, 0.008] },
			{ model: "strata-flash/flash-next", prompt_n: 900, durations: [1, 0.002, 0.002, 0.002, 0.002] },
		],
		at_utc: "x",
	};
	assert.equal(laneBestRate(snap, "strata-flash/deepseek"), 125);
	assert.equal(laneBestRate(snap, "strata-flash/none"), undefined);
});

test("swap history: newest-first, capped at 200, survives re-read", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-hist-"));
	try {
		for (let i = 0; i < 210; i++) {
			appendSwap(dir, { from: "a", to: "b", elapsed_s: i, first_tg: 91, steady_tg: 130, percent_path: [10, 42, 100], at: `2026-11-15T00:00:${String(i % 60).padStart(2, "0")}Z` });
		}
		const rows = readSwaps(dir);
		assert.equal(rows.length, 200);
		assert.equal(rows[0].elapsed_s, 209, "newest first");
		assert.deepEqual(rows[0].percent_path, [10, 42, 100]);
		assert.equal(readSwaps(join(dir, "missing")).length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the engine's decode_tok_s wins over per-token durations; the prefix-cache row reports hit_rate", () => {
	assert.equal(rateFromRequest({ decode_tok_s: 130, durations: [1, 0.002, 0.002, 0.002] }), 130);
	assert.equal(rateFromRequest({ decode_tok_s: 0, durations: [1, 0.01, 0.01, 0.01] }), 100);
	const row = moeCacheRow([
		{ hit_rate: 0.449, reused: 509 },
		{ hit_rate: 0.823, reused: 1113, prompt_tokens: 1352 },
	]);
	assert.match(row.value, /81\.5% hit over 2 req|82\.3/);
	assert.match(row.value, /last 82\.3%/);
	assert.equal(moeCacheRow([]).value, "no hit_rate reported");
});
