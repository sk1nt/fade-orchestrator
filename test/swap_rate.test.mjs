/**
 * The swap ledger's rates, measured from the payload the live router publishes.
 *
 * The defect this pins, first seen on a screen capture: every `LANE SWAPS` row read `0→0 tok/s`
 * — including the real, measured swaps in `swap_history.json`. Cause,
 * both ends of it: basalt 0.4.0 publishes per-request `decode_tok_s` and NO `model` and NO
 * per-token `durations`, while the swap watcher's `finish()` filtered requests by lane NAME and then
 * required >3 `durations`. Every request was discarded, `rateFromRequest` saw nothing, and
 * `first_tg`/`steady_tg` fell through to 0 — the row that exists to price a swap printed a zero the
 * router never reported. Absence must read as absence, and a published number must not read as zero.
 *
 * The stub speaks the measured shape, captured from a live engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stub = async (requests) => {
	const server = createServer((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		if (req.url.startsWith("/health")) return res.end(JSON.stringify({ status: "ok", model: "deepseek", loaded: true, loading: false, service: "basalt", percent: null, swap: null }));
		res.end(JSON.stringify({ engine: { model: "deepseek", version: "0.4.0", quant: "deepseek" }, live: { state: "idle", tok_s: null }, requests }));
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
};

/** The measured 0.4.0 request row: no `model`, no `durations`, a published decode rate. */
const MEASURED_ROW = { id: "r_3849", path: "/v1/chat/completions", slot: 0, duration_s: 0.6, prompt_tokens: 98536, reused: 98230, output_tokens: 147, decode_tok_s: 437.2, hit_rate: 0.999, ttft_s: 0.25 };

const watch = async (requests) => {
	const s = await stub([requests]);
	process.env.FADE_ORCHESTRATE_ROUTER = s.url;
	const { startSwapWatch } = await import(`../.test-build/livedata.mjs?stub=${encodeURIComponent(s.url)}`);
	const dir = mkdtempSync(join(tmpdir(), "fade-swaprate-"));
	const row = await startSwapWatch("deepseek").finish("flash-next", "deepseek", 14.0, dir);
	rmSync(dir, { recursive: true, force: true });
	s.close();
	return row;
};

test("a swap row reads the rate the 0.4.0 router published (no model, no durations)", async () => {
	const row = await watch(MEASURED_ROW);
	assert.ok(row, "a swap that landed writes a row");
	assert.equal(row.steady_tg, 437.2, "the published decode_tok_s is the steady rate — not the 0 the ledger used to print");
	assert.equal(row.first_tg, 437.2, "one request in the window: first and steady are that request");
});

test("a request publishing no rate writes 0, and the row still lands", async () => {
	const row = await watch({ ...MEASURED_ROW, decode_tok_s: undefined });
	assert.ok(row);
	assert.equal(row.first_tg, 0, "no published rate is 0, and the row's own absence is a named state in the panel");
	assert.equal(row.elapsed_s, 14, "the swap cost is measured independently of the rate");
});

test("the row the watcher writes is the row the panel reads", async () => {
	const s = await stub([MEASURED_ROW]);
	process.env.FADE_ORCHESTRATE_ROUTER = s.url;
	const { startSwapWatch } = await import(`../.test-build/livedata.mjs?write=${encodeURIComponent(s.url)}`);
	const dir = mkdtempSync(join(tmpdir(), "fade-swaprate2-"));
	const row = await startSwapWatch("deepseek").finish("flash-next", "deepseek", 16.8, dir);
	const ledger = JSON.parse(readFileSync(join(dir, "swap_history.json"), "utf8"));
	assert.equal(ledger.rows[0].to, "deepseek");
	assert.equal(ledger.rows[0].steady_tg, row.steady_tg, "the ledger carries the measured number, not a render-time invention");
	rmSync(dir, { recursive: true, force: true });
	s.close();
});

test("the run that paid the swap rides on the row, and its absence is an absence", async () => {
	const s = await stub([MEASURED_ROW]);
	process.env.FADE_ORCHESTRATE_ROUTER = s.url;
	const { startSwapWatch } = await import(`../.test-build/livedata.mjs?runid=${encodeURIComponent(s.url)}`);
	const dir = mkdtempSync(join(tmpdir(), "fade-swaprate3-"));
	const paid = await startSwapWatch("deepseek").finish("flash-next", "deepseek", 12.5, dir, "20261116T070757Z-x5m9");
	const unattributed = await startSwapWatch("deepseek").finish("flash-next", "deepseek", 3.2, dir);
	const ledger = JSON.parse(readFileSync(join(dir, "swap_history.json"), "utf8"));
	assert.equal(paid.run_id, "20261116T070757Z-x5m9", "the caller names the run, the row carries it");
	assert.equal(unattributed.run_id, undefined, "a watch that names no run writes an unattributed row, never a guessed owner");
	assert.equal(ledger.rows.find((r) => r.elapsed_s === 12.5).run_id, "20261116T070757Z-x5m9", "the stamp survives the durable write, so the per-run cost is answerable from the file");
	assert.equal(ledger.rows.find((r) => r.elapsed_s === 3.2).run_id, undefined, "and the unstamped row stays unattributed on disk");
	rmSync(dir, { recursive: true, force: true });
	s.close();
});
