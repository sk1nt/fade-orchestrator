/**
 * livedata + history unit tests: the pure readers behind the overlay (rates from /metrics
 * request durations, cold/hot against the lane baseline, tier rows) and the swap-history store
 * (append, newest-first order, cap), the Y12 ramp class, and the Y18 per-turn JSONL ledger. No network: fixtures are the measured /metrics shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coldHot, laneBestRate, moeCacheRow, rateFromRequest, tiersFromMetrics, turnMetricsFrom } from "../.test-build/livedata.mjs";
import { appendSwap, rampClass, readSwaps, appendTurn, readTurns, turnRecordOrNull } from "../.test-build/history.mjs";

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

test("rampClass: the measured 91 ramp is cold, 130 steady is hot, a restored MoE map wins", () => {
	assert.equal(rampClass(91, false), "cold_ramp", "the measured deepseek promote window");
	assert.equal(rampClass(130, false), "hot_steady", "its measured steady rate");
	assert.equal(rampClass(91, true), "map_restored", "a start that placed from the saved map is warm by construction, whatever the rate reads");
	assert.equal(rampClass(480, false), "hot_steady", "flash-next's measured floor (480-647)");
	assert.equal(rampClass(undefined, false), "cold_ramp", "no rate is no evidence of a steady lane");
	assert.equal(rampClass(91, false, 90), "hot_steady", "the steady line is an argument, not a magic number");
});

test("swap history: elapsed_ms and the Y12 ramp class survive the round trip", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-hist-"));
	try {
		appendSwap(dir, { from: "deepseek", to: "flash-next", elapsed_s: 14.2, elapsed_ms: 14200, ramp: rampClass(480, false), first_tg: 480, steady_tg: 647, percent_path: [12, 100], at: "2026-11-15T09:12:32Z" });
		const rows = readSwaps(dir);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].elapsed_ms, 14200, "the row keeps the transition timer's own unit (measured 14.2 s)");
		assert.equal(rows[0].ramp, "hot_steady");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const ID = { run_id: "20261115T091232Z-rqtj", turn: 3, round: 1, phase: "coding_done", swap_ms: 14200, round_outcome: "accepted" };

test("turnRecordOrNull: an unreachable router yields NO record, so metrics.jsonl is never created", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-turn-"));
	try {
		const dead = turnMetricsFrom(undefined); // exactly what fetchTurnMetrics() hands back on a closed router
		assert.deepEqual(dead, {}, "missing numbers report as missing, never as 0");
		assert.equal(turnRecordOrNull(dead, ID), undefined);
		assert.equal(turnRecordOrNull(undefined, ID), undefined, "no /metrics at all is not a crash");
		assert.equal(turnRecordOrNull({ tg: 130 }, ID), undefined, "tg without pp is not a record");
		assert.equal(turnRecordOrNull({ pp: 1499 }, ID), undefined, "pp without tg is not a record");
		// The caller appends only what turnRecordOrNull returned; it returned nothing, so nothing lands.
		assert.equal(existsSync(join(dir, "metrics.jsonl")), false, "a no-record turn leaves no ledger behind");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("turnMetricsFrom: pp from prompt_ms, tg from durations, kv_hit_pct from the last hit_rate", () => {
	assert.deepEqual(
		turnMetricsFrom([
			{ prompt_tokens: 106000, prompt_ms: 3500, ttft_s: 3.5, hit_rate: 0.449, reused: 509, durations: [3.5, 0.01, 0.01, 0.01] },
			{ prompt_tokens: 2000, prompt_ms: 500, hit_rate: 0.823, reused: 1646, durations: [0.5, 0.002, 0.002, 0.002] },
		]),
		{ pp: 4000, tg: 500, ttft: 0.5, kv_hit_pct: 82.3 },
	);
	assert.deepEqual(turnMetricsFrom([{ pp: 1499, decode_tok_s: 130, ttft_s: 3.5, hit_rate: 0.823 }]), { pp: 1499, tg: 130, ttft: 3.5, kv_hit_pct: 82.3 }, "the engine's own pp/decode_tok_s win");
	assert.deepEqual(turnMetricsFrom([]), {}, "an empty window reports nothing, inventing nothing");
});

test("turnRecordOrNull: the record carries the four numbers, and only the numbers it was given", () => {
	const rec = turnRecordOrNull({ pp: 1499, tg: 130, ttft: 3.5, kv_hit_pct: 82.3 }, { ...ID, ts: "2026-11-15T09:12:32Z" });
	assert.deepEqual(rec, { ts: "2026-11-15T09:12:32Z", run_id: ID.run_id, turn: 3, round: 1, phase: "coding_done", pp: 1499, tg: 130, ttft: 3.5, kv_hit_pct: 82.3, swap_ms: 14200, round_outcome: "accepted" });
	const sparse = turnRecordOrNull({ pp: 1499, tg: 480 }, { ...ID, phase: undefined });
	assert.deepEqual(Object.keys(sparse).sort(), ["pp", "round", "round_outcome", "run_id", "swap_ms", "tg", "ts", "turn"], "no ttft/hit reported means no key, not a zero");
});

test("appendTurn/readTurns: exactly one line per turn, round-trips, a corrupt line is skipped", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-turn-"));
	const file = join(dir, "metrics.jsonl");
	try {
		const rec = turnRecordOrNull({ pp: 1499, tg: 130, ttft: 3.5, kv_hit_pct: 44.9 }, { ...ID, ts: "2026-11-15T09:12:32Z" });
		assert.ok(rec);
		appendTurn(dir, rec);
		assert.equal(readFileSync(file, "utf8").split("\n").filter((l) => l !== "").length, 1, "EXACTLY one line");
		assert.deepEqual(readTurns(dir, 10), [rec], "the record round-trips");
		const next = { ...rec, turn: 4, tg: 480, swap_ms: 0 };
		appendTurn(dir, next);
		appendFileSync(file, "{not json\n");
		appendFileSync(file, '{"ts":"2026-11-15T09:13:00Z"}\n');
		const all = readTurns(dir, 10);
		assert.equal(all.length, 2, "a hand-corrupted line and a numberless line are skipped, not fatal");
		assert.deepEqual(readTurns(dir, 1), [next], "readTurns returns the LAST n");
		appendTurn(join(dir, "sub"), rec);
		assert.equal(readTurns(join(dir, "sub"), 5).length, 1, "appendTurn creates the dir");
		assert.equal(readTurns(join(dir, "nope"), 5).length, 0, "no ledger yet is not a crash");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
