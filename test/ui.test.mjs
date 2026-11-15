#!/usr/bin/env node
// ui.test.mjs — the footer pill's contract. The operator's placement order (2026-11-15: "put this
// text up where DeepSeek-v4.1 … is, it should fit fine") is that the pill carries the FULL lane
// name: the host renders setStatus() text on the footer's extension-status row at full terminal
// width, directly under the stats row whose right side is the model identifier, and that
// identifier is longer than this line — so the full name fits. laneTag/pillCompact survive ONLY as
// the narrow-terminal fallback, where the host truncates the row with "…".
import os from "node:os";
import assert from "node:assert/strict";
import test from "node:test";
import { laneTag, openOverlay, OVERLAY_WIDGET_KEY, overlayLines, pill, pillCompact, redact, statusTag, statusTagCompact } from "../.test-build/ui.mjs";
const task = (id, status) => ({ id, objective: `${id} objective`, files: [`${id}.ts`], acceptance: `${id} acceptance`, dependencies: [], round: 1, status });
const run = (over = {}) => ({
	lane: "flash-next",
	round: 1,
	max_rounds: 6,
	state: "coding",
	tasks: [task("T1", "passed"), task("T2", "pending"), task("T3", "passed")],
	repair_tasks: [],
	phases: [],
	rejection_history: [],
	...over,
});

test("statusTag: the FULL lane name with a short state, and a stall stays visible", () => {
	assert.equal(statusTag(run({ state: "coding" })), "flash-next:code");
	assert.equal(statusTag(run({ lane: "deepseek:high", state: "planning" })), "deepseek:high:plan");
	assert.equal(statusTag(run({ state: "stalled_protocol_error" })), "flash-next:stall");
	assert.equal(statusTag(run({ state: "unknown_future_state" })), "flash-next:unknown_future_state");
});

test("statusTagCompact: the narrow-terminal 2-character form is the fallback, not the default", () => {
	assert.equal(statusTagCompact(run()), "fn:code");
	assert.equal(statusTagCompact(run({ state: "stalled_protocol_error" })), "fn:stall");
});

test("pill: the full lane name lands in the footer row, round and tally intact", () => {
	const p = pill(run());
	assert.equal(p, "⚡ flash-next:code · R1/6 · T2/3 · [Ctrl+O]");
	assert.ok(p.includes("flash-next"), "the full lane name must be in the status row");
});

test("pillCompact: the fallback compacts the lane name and keeps every field", () => {
	assert.equal(pillCompact(run(), "hot 130t/s"), "⚡ fn:code · R1/6 · T2/3 · [Ctrl+O] · hot 130t/s");
});

test("pill: the Tier-1 protocol badge rides only while the stall counter runs", () => {
	assert.equal(pill(run({ stall_count: 1 })), "⚡ flash-next:code · R1/6 · T2/3 · [Ctrl+O] · protocol 1/3");
	assert.equal(pill(run({ stall_count: 3 })), "⚡ flash-next:code · R1/6 · T2/3 · [Ctrl+O] · protocol 3/3");
	assert.ok(!pill(run({ stall_count: 0 })).includes("protocol"), "a clean run must not advertise a stall");
});

test("pill: a paused run says so, so a parked loop is never read as a hung one", () => {
	assert.equal(pill(run({ paused: true })), "⚡ flash-next:code · R1/6 · T2/3 · [Ctrl+O] · paused");
});

test("overlay: protocol counters, the synthesized marker, the checkpoint tag, the stall diagnostic", () => {
	const lines = overlayLines({
		run: run({
			state: "stalled_protocol_error",
			stall_count: 3,
			protocol_retries: 3,
			synthesized: { phase: "coding_done", round: 2, at: "2026-11-15T00:00:00Z" },
			checkpoints: { T1: "omp-ckpt/test/T1-passed" },
			tasks: [{ id: "T1", objective: "do the thing", files: ["x"], acceptance: "y", dependencies: [], round: 1, status: "passed" }],
		}),
		swaps: [],
		tiers: [],
	});
	assert.ok(lines.some((l) => l.includes("protocol: 3 turn(s) ended without fade_phase · consecutive stalls 3/3")), "protocol row");
	assert.ok(lines.some((l) => l.includes("auto-synthesized coding_done at round 2")), "synthesized marker");
	assert.ok(lines.some((l) => l.includes("PROTOCOL STALL (Tier-3 circuit breaker)")), "stall diagnostic");
	assert.ok(lines.some((l) => l.includes("tag: omp-ckpt/test/T1-passed")), "checkpoint tag");
});

test("overlay: the pause row, the MoE ramp badge and the [p] key line", () => {
	const lines = overlayLines({
		run: run({ paused: true, operator_note: "editing the fixture by hand" }),
		swaps: [{ from: "deepseek", to: "flash-next", elapsed_s: 14.2, first_tg: 91, steady_tg: 130, ramp: "cold_ramp", at: "2026-11-15T00:00:00Z" }],
		tiers: [],
	});
	assert.ok(lines.some((l) => l.includes("paused: the loop is stopped for manual edits · operator note: editing the fixture by hand")));
	assert.ok(lines.some((l) => l.includes("MoE: Cold Ramp")), "the warm/cold ramp badge is the swap row's");
	assert.ok(lines.some((l) => l.includes("[p] pause/resume")));
});

test("laneTag: dash names abbreviate to the initials of their first two segments", () => {
	assert.equal(laneTag("flash-next"), "fn");
	assert.equal(laneTag("flash-ornith"), "fo");
	assert.equal(laneTag("deepseek-v4.1-flash"), "dv");
});

test("laneTag: a single token keeps its first two characters, short names pass through", () => {
	assert.equal(laneTag("deepseek"), "de");
	assert.equal(laneTag("phi"), "phi");
});

// Y19 `--demo-redact`: a screenshot of the bar must show no username, no home path, no hostname
// and no repo path. FADE_ORCHESTRATE_REDACT=1 is a DISPLAY concern, applied only at the render
// boundary (pill / statusTag / overlayLines and the widget those lines feed). The durable record —
// state.json, metrics.jsonl, swap_history.json — is written by other modules and stays verbatim,
// which is why the flag-off cases below demand byte-identical output.
const REPO = "/home/rwest/projects/fadetheworld";
const HOST = os.hostname();

/** Set the switch for one call, restore the ambient value after — the tests share `process.env`. */
const withFlag = (value, fn) => {
	const prev = process.env.FADE_ORCHESTRATE_REDACT;
	if (value === undefined) delete process.env.FADE_ORCHESTRATE_REDACT;
	else process.env.FADE_ORCHESTRATE_REDACT = value;
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env.FADE_ORCHESTRATE_REDACT;
		else process.env.FADE_ORCHESTRATE_REDACT = prev;
	}
};

const assertNoIdentity = (s) => {
	assert.ok(!s.includes("rwest"), `the account must not survive: ${s}`);
	assert.ok(!s.includes("/home/"), `the home path must not survive: ${s}`);
	assert.ok(!s.includes(REPO), `the repo path must not survive: ${s}`);
	if (HOST) assert.ok(!s.includes(HOST), `the hostname must not survive: ${s}`);
};

const overlayData = () => ({
	run: run({
		lane: "deepseek",
		repo: REPO,
		run_id: "R1",
		goal: `redact the bar in ${REPO} for ${HOST}`,
		protocol_retries: 2,
		stall_count: 2,
		checkpoints: { T1: "omp-ckpt/test/T1-passed" },
		tasks: [{ id: "T1", objective: "redact the bar", files: ["deploy/omp/src/ui.ts"], acceptance: "npm test", dependencies: [], round: 1, status: "passed" }],
	}),
	swaps: [{ from: "deepseek", to: "flash-next", elapsed_s: 14.2, first_tg: 91, steady_tg: 130, ramp: "hot_steady", at: "2026-11-15T00:00:00Z" }],
	tiers: [{ label: "engine", value: "/home/rwest/.basalt/config.json" }],
	critique: `verified: 60 pass in ${REPO}`,
});

test("redact: account, home, tilde, hostname and the repo path become fixed markers, everything else byte-identical", () => {
	const raw = `${REPO} /home/other/x ~/x ${HOST} rwest@${HOST} · R1/6 · T2/3`;
	const on = withFlag("1", () => redact(raw, true, REPO));
	assertNoIdentity(on);
	assert.ok(on.includes("<path>"), `the path marker must be there: ${on}`);
	assert.ok(on.includes("<user>"), `the account marker must be there: ${on}`);
	if (HOST) assert.ok(on.includes("<host>"), `the hostname marker must be there: ${on}`);
	assert.ok(on.includes("· R1/6 · T2/3"), "everything else passes through byte-identical");
	assert.equal(withFlag("1", () => redact(raw, false, REPO)), raw, "on=false is a no-op");
	assert.equal(withFlag("0", () => redact(raw, false, REPO)), raw, "off is a no-op");
	assert.equal(withFlag("1", () => redact("⚡ deepseek:code · R1/6 · T2/3 · [Ctrl+O]", true, REPO)), "⚡ deepseek:code · R1/6 · T2/3 · [Ctrl+O]", "a line with no identity is untouched");
});

test("redact: the pill is screenshot-safe with the flag on, lane/round/tally intact", () => {
	const r = run({ lane: "deepseek", repo: REPO });
	const p = withFlag("1", () => pill(r, `130t/s · ${REPO} by rwest on ${HOST}`));
	assertNoIdentity(p);
	assert.equal(p, "⚡ deepseek:code · R1/6 · T2/3 · [Ctrl+O] · 130t/s · <path> by <user> on <host>", "the round/task tally survives");
	const c = withFlag("1", () => pillCompact(r, `hot 130t/s in ${REPO}`));
	assertNoIdentity(c);
	assert.ok(c.includes("⚡ de:code · R1/6 · T2/3 · [Ctrl+O] · hot 130t/s in <path>"), `the narrow fallback keeps every field: ${c}`);
	assertNoIdentity(withFlag("1", () => statusTag(run({ lane: "deepseek", repo: REPO, goal: REPO }))));
});

test("redact: the overlay body carries markers, not identity, and keeps every row", () => {
	const lines = withFlag("1", () => overlayLines(overlayData()));
	lines.forEach((l) => assertNoIdentity(l));
	assert.ok(lines.some((l) => l.includes("fade-orchestrator R1 · coding · lane deepseek · round 1/6")), `the header keeps run/lane/round: ${lines[0]}`);
	assert.ok(lines.some((l) => l.includes("goal: redact the bar in <path> for <host>")), lines.find((l) => l.startsWith("goal:")));
	assert.ok(lines.some((l) => l.includes("T1 [passed] (in repair)  redact the bar")), "the task row survives");
	assert.ok(lines.some((l) => l.includes("files: deploy/omp/src/ui.ts · deps: - · round 1")), "repo-relative files are untouched");
	assert.ok(lines.some((l) => l.includes("protocol: 2 turn(s) ended without fade_phase · consecutive stalls 2/3")), "the protocol counters survive");
	assert.ok(lines.some((l) => l.includes("deepseek -> flash-next  14.2 s")), "the swap row survives");
	assert.ok(lines.some((l) => l.includes("engine: <path>/.basalt/config.json")), `the tier row keeps its label: ${lines.join("\n")}`);
	assert.ok(lines.some((l) => l.includes("verified: 60 pass in <path>")), "the critique keeps its verdict");
});

test("redact: the widget path (RPC/headless overlay) emits the same redacted lines", async () => {
	let shown;
	const ctx = { hasUI: false, ui: { setWidget: (key, lines) => { shown = { key, lines }; } } };
	await withFlag("1", () => openOverlay(ctx, overlayData(), undefined, true));
	assert.equal(shown.key, OVERLAY_WIDGET_KEY);
	shown.lines.forEach((l) => assertNoIdentity(l));
	assert.ok(shown.lines.some((l) => l.includes("round 1/6")), "the widget keeps the round tally");
});

test("redact: off is the default, and the rendered bytes are today's, verbatim", () => {
	const bare = overlayLines(overlayData());
	assert.ok(bare.some((l) => l.includes(`goal: redact the bar in ${REPO} for ${HOST}`)), "off keeps the operator's own truth on screen");
	assert.deepEqual(withFlag("0", () => overlayLines(overlayData())), bare, "FADE_ORCHESTRATE_REDACT=0 is off: identical bytes");
	assert.deepEqual(withFlag(undefined, () => overlayLines(overlayData())), bare, "unset is off: identical bytes");
	assert.equal(withFlag(undefined, () => pill(run({ lane: "deepseek", repo: REPO }))), "⚡ deepseek:code · R1/6 · T2/3 · [Ctrl+O]");
	assert.equal(withFlag("0", () => statusTagCompact(run({ lane: "deepseek", repo: REPO }))), "de:code");
});
