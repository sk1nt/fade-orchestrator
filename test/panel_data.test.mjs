#!/usr/bin/env node
// panel_data.test.mjs — the screen's data contract (src/screendata.ts).
//
// The load-bearing rule is the ledger's: a number nobody measured is NAMED, never printed as a
// zero. So the unreachable-router case is not a nicety — it is the defect class this module exists
// to prevent (a dead wire reading as a quiet market). Everything here runs with injected sources:
// no live router, no live session, deterministic fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimRow, clockOf, collectScreen, compactNumber, formatElapsed, gateRows, laneRows, nameResidentRow, sparkline, swapRows, turnRows } from "../.test-build/screendata.mjs";
import { moeCacheRow, tiersFromMetrics } from "../.test-build/livedata.mjs";
import { moeRows } from "../.test-build/moe.mjs";

const task = (id, status, over = {}) => ({ id, objective: `${id} objective`, files: [`${id}.ts`], acceptance: `${id} acceptance`, dependencies: [], round: 1, status, ...over });
const run = (over = {}) => ({
	lane: "deepseek",
	round: 2,
	max_rounds: 6,
	state: "coding",
	tasks: [task("T1", "passed"), task("T2", "pending"), task("T3", "failed")],
	repair_tasks: [],
	phases: [
		{ phase: "planning_done", at: "2030-01-01T12:00:00.000Z", lane: "deepseek", round: 1, accepted: true, payload: {} },
		{ phase: "verification_done", at: "2030-01-01T12:20:00.000Z", lane: "deepseek", round: 1, accepted: true, payload: {}, notes: "T3 died: the rig asserts a line that never renders" },
	],
	rejection_history: [],
	started_utc: "2030-01-01T12:00:00.000Z",
	gate_last: {
		at: "2030-01-01T12:19:00.000Z",
		passed: false,
		results: [
			{ cmd: "npm test", expected: "exit 0", observed: "exit 1", ok: false },
			{ cmd: "npm run test:gate", expected: "PASS", observed: "PASS", ok: true },
			{ cmd: "node test/pty_rig.mjs", expected: "PASS", observed: "timeout", ok: false },
		],
	},
	...over,
});

// A MetricsSnapshot in the shape `fetchMetrics` builds from basalt 0.4.0's `/metrics` + `/health`:
// the field names the reader ACTUALLY reads (`live_state`, `spill_experts`, a request's `hit_rate`
// and `ssd_share`). An invented flat shape silently proves nothing: the reader answered `?` for
// every row and the assertions read the fixture, not the code.
const metrics = {
	engine_version: "0.4.0",
	quant: "IQ1_M",
	loaded: "deepseek",
	loading: false,
	percent: 100,
	slots: 2200,
	spill_experts: 0,
	spill_total: 0,
	spill_bytes_gb: 0,
	live_state: "decoding",
	tok_s: 130.5,
	queue: 0,
	requests: [{ pp: 1200, decode_tok_s: 130, ttft_s: 0.4, hit_rate: 0.823, reused: 900, ssd_share: 0 }],
};

const swapFixture = [
	{ key: "fade.omp_orchestrate.swap.v1", at: "2030-01-01T12:10:00.000Z", from: "deepseek", to: "flash-next", elapsed_s: 14.2, first_tg: 91, steady_tg: 130, ramp: "cold_ramp", load_percent: 100 },
	{ key: "fade.omp_orchestrate.swap.v1", at: "2030-01-01T12:18:00.000Z", from: "flash-next", to: "deepseek", elapsed_s: 8.9, first_tg: 120, steady_tg: 128, ramp: "hot_steady", load_percent: 100 },
];

const turnFixture = [
	{ key: "fade.omp_orchestrate.turn.v1", turn: 1, round: 1, phase: "planning", at: "2030-01-01T12:01:00.000Z", pp: 1000, tg: 50, ttft: 0.4, swap_ms: 200, kv_hit_pct: 12.5 },
	{ key: "fade.omp_orchestrate.turn.v1", turn: 2, round: 2, phase: "coding", at: "2030-01-01T12:12:00.000Z", pp: 4000, tg: 200, ttft: 0.6, swap_ms: 14200 },
	{ key: "fade.omp_orchestrate.turn.v1", turn: 3, round: 2, phase: "coding", at: "2030-01-01T12:14:00.000Z", pp: 4200, tg: 100, ttft: 0.5, swap_ms: 0, kv_hit_pct: 88 },
];

const withMoe = (value, fn) => {
	const prev = process.env.FADE_ORCHESTRATE_MOE_CONFIG;
	if (value === undefined) delete process.env.FADE_ORCHESTRATE_MOE_CONFIG;
	else process.env.FADE_ORCHESTRATE_MOE_CONFIG = value;
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env.FADE_ORCHESTRATE_MOE_CONFIG;
		else process.env.FADE_ORCHESTRATE_MOE_CONFIG = prev;
	}
};

const names = {
	deepseek: "deepseek (DeepSeek-V4.1-Flash IQ1_M, dual RTX 5090, RAM+SSD expert tier)",
	"flash-next": "flash-next (Swift Flash Next IQ3_S, dual RTX 5090)",
};

test("compactNumber/formatElapsed: the columns stay narrow", () => {
	assert.equal(compactNumber(1048576), "1.05M");
	assert.equal(compactNumber(41234), "41.2k");
	assert.equal(compactNumber(4123456), "4.12M");
	assert.equal(compactNumber(842), "842");
	assert.equal(formatElapsed(0), "0m00s");
	assert.equal(formatElapsed(842), "14m02s");
	assert.equal(formatElapsed(3840), "1h04m");
});

test("sparkline: scaled to the row's own maximum; one value draws nothing", () => {
	assert.equal(sparkline([50, 100, 200]), "▂▄█");
	assert.equal(sparkline([200]), "");
	assert.equal(sparkline([0, 0]), "", "no rate, no bars");
});

test("clockOf: a real stamp prints the clock; an unparseable one prints itself, never a fake time", () => {
	assert.match(clockOf("2030-01-01T12:19:00.000Z"), /^\d\d:\d\d:\d\d$/);
	assert.equal(clockOf("not-a-time"), "not-a-time");
});

test("laneRows: the lane KEY rides, never the display name — the model is named in exactly one place", () => {
	const rows = laneRows({ run: run(), runDir: "/tmp/nope", lanes: { think: "deepseek", code: "flash-next" }, names }, metrics);
	assert.deepEqual(rows, [
		{ lane: "deepseek", role: "think", model: "deepseek", resident: true },
		{ lane: "flash-next", role: "code", model: "flash-next", resident: false },
	]);
	const blind = laneRows({ run: run(), runDir: "/tmp/nope", lanes: { think: "deepseek", code: "flash-next" } }, undefined);
	assert.ok(blind.every((l) => l.resident === false), "an unreachable router answers no resident lane");
});

test("nameResidentRow: the engine column carries the abbreviated display name, once", () => {
	const tiers = [
		{ label: "engine", value: "0.4.0 quant IQ3_S" },
		{ label: "resident", value: "flash-next" },
		{ label: "decode now", value: "130 tok/s (queue 0, idle)" },
	];
	const named = nameResidentRow(tiers, { loaded: "flash-next", loading: false, percent: 100 }, names);
	const byLabel = new Map(named.map((r) => [r.label, r.value]));
	assert.equal(byLabel.get("resident"), "flash-next (IQ3_S, dual)");
	assert.equal(byLabel.get("engine"), "0.4.0 quant IQ3_S", "only the resident row is rewritten");
	// A router key with no registry name passes through; a mid-load router says so.
	assert.equal(nameResidentRow(tiers, { loaded: "mystery", loading: true, percent: 47 }, undefined)[1].value, "mystery loading");
	assert.equal(nameResidentRow(tiers, undefined, names)[1].value, "flash-next", "no router, no renaming");
});

test("turnRows: the tok/s sparkline and one row per turn, with pp/tg/ttft/kv/swap", () => {
	const rows = turnRows(turnFixture);
	assert.equal(rows[0].label, "tok/s by turn");
	assert.equal(rows[0].value, "▂█▄");
	const byLabel = new Map(rows.map((r) => [r.label, r.value]));
	assert.ok(byLabel.get("#3 R2 coding").includes("pp 4.2k"), byLabel.get("#3 R2 coding"));
	assert.ok(byLabel.get("#3 R2 coding").includes("tg 100"));
	assert.ok(byLabel.get("#3 R2 coding").includes("kv 88%"));
	assert.ok(byLabel.get("#2 R2 coding").includes("swap 14.2s"), "the swap cost rides in the turn that paid it");
	assert.ok(!byLabel.get("#2 R2 coding").includes("kv"), "no kv measurement, no kv field");
	assert.deepEqual(turnRows([]), [], "an empty ledger draws no rows");
});

test("swapRows: the measured cost of each swap, newest first, with the ramp class named", () => {
	const rows = swapRows(swapFixture);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].label, "deepseek → flash-next");
	assert.ok(rows[0].value.includes("14.2s"), rows[0].value);
	assert.ok(rows[0].value.includes("91→130 tok/s"), rows[0].value);
	assert.ok(rows[0].value.includes("cold ramp"), rows[0].value);
	assert.ok(rows[1].value.includes("hot steady"), rows[1].value);
});

test("gateRows: RED names the failing count and every red command; a green gate says GREEN; no gate is named", () => {
	const red = gateRows(run().gate_last);
	assert.equal(red[0].value, `RED 2/3 failing · ${clockOf("2030-01-01T12:19:00.000Z")}`);
	assert.equal(red[0].tone, "bad");
	assert.ok(red[1].value.includes("npm test → exit 0"), JSON.stringify(red[1]));
	assert.ok(red[2].value.includes("node test/pty_rig.mjs → PASS"), JSON.stringify(red[2]));
	assert.ok(!red.some((r) => r.value.includes("npm run test:gate")), "the green check is not a red row");
	const green = gateRows({ at: "2030-01-01T12:19:00.000Z", passed: true, results: [{ cmd: "npm test", expected: "exit 0", observed: "exit 0", ok: true }] });
	assert.equal(green[0].value.split(" ")[0], "GREEN");
	assert.equal(green[0].tone, "ok");
	assert.deepEqual(gateRows(undefined), [{ label: "gate", value: "no gate run this round", tone: "dim" }]);
});

test("collectScreen: the whole screen from injected sources — tiers, lanes, context, turns, swaps, gate, critique", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fade-panel-"));
	try {
		writeFileSync(join(dir, "swap_history.json"), JSON.stringify({ key: "fade.omp_orchestrate.swaps.v1", rows: swapFixture }));
		writeFileSync(join(dir, "metrics.jsonl"), turnFixture.map((t) => JSON.stringify(t)).join("\n"));
		const d = await withMoe(undefined, () =>
			collectScreen({
				run: run(),
				runDir: dir,
				lanes: { think: "deepseek", code: "flash-next" },
				names,
				context: { tokens: 41234, contextWindow: 1048576, percent: 3.9 },
				metrics,
				now: () => new Date("2030-01-01T12:14:02.000Z"),
			}),
		);
		const tiers = new Map(d.tiers.map((t) => [t.label, t.value]));
		assert.equal(tiers.get("engine"), "0.4.0 quant IQ1_M");
		assert.equal(tiers.get("resident"), "deepseek (IQ1_M, dual)", "the ONE place the model is named, abbreviated");
		// tok/s is rounded by design (a compact column); the live state is the router's own word.
		assert.equal(tiers.get("decode now"), "131 tok/s (queue 0, decoding)");
		assert.ok(String(tiers.get("expert slots")).includes("2200"), String(tiers.get("expert slots")));
		// the row grew the pcie/ssd shares as NAMED columns; this fixture carries no pcie_share.
		assert.equal(tiers.get("prefix cache"), "82.3% hit over 1 req · last 82.3% (900 tok reused) · pcie not reported · ssd 0.0%");
		assert.deepEqual(
			d.lanes.map((l) => l.model),
			["deepseek", "flash-next"],
			"the lane line names no model: the model rides once, in the engine column",
		);
		assert.deepEqual(d.context, { tokens: 41234, window: 1048576, percent: 3.9 });
		assert.equal(d.swaps.length, 2, "the ledger is read from the run dir");
		assert.equal(d.turns.length, 3);
		assert.equal(d.gate?.passed, false);
		assert.ok(String(d.critique).includes("the rig asserts a line that never renders"), "the verifier's words ride");
		assert.equal(d.elapsed_s, 842, "the run's age from its own start stamp");
		assert.deepEqual(d.missing, [], "every source answered, so nothing is missing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("collectScreen: a run state with NO `phases` renders as no critique — the screen must never die on a shape it did not predict", async () => {
	// Measured in the rpc rig: a state written mid-plan carried no `phases`, the critique loop threw
	// `undefined is not an object (evaluating 'src.run.phases.length')`, and the operator got an error
	// notify where the panel should have been. An absent history has one meaning: no critique.
	const dir = mkdtempSync(join(tmpdir(), "fade-panel-"));
	try {
		const d = await withMoe(undefined, () =>
			collectScreen({
				run: { ...run(), phases: undefined },
				runDir: dir,
				lanes: { think: "deepseek", code: "flash-next" },
				names,
				metrics,
				now: () => new Date("2030-01-01T12:14:02.000Z"),
			}),
		);
		assert.equal(d.critique, undefined, "no phases means no critique, not a throw");
		assert.ok(d.tiers.length > 0, "the rest of the screen still renders");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("collectScreen: an absent source is NAMED in `missing`, never a zero", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fade-panel-"));
	try {
		const d = await withMoe(undefined, () =>
			collectScreen({
				run: run({ started_utc: undefined, gate_last: undefined }),
				runDir: dir,
				lanes: { think: "deepseek", code: "flash-next" },
				metrics,
			}),
		);
		assert.deepEqual(
			d.missing.slice().sort(),
			["no context meter", "no run start in the state file", "no swaps recorded", "no turn telemetry (the router reported no pp/tg)"].sort(),
			JSON.stringify(d.missing),
		);
		assert.equal(d.context, undefined);
		assert.equal(d.elapsed_s, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("collectScreen: an unreachable router prints its own name, and NO engine/decode row is fabricated", () => {
	// A child process, because ROUTER is resolved at module load and must not be the live box's.
	const dir = mkdtempSync(join(tmpdir(), "fade-panel-"));
	const script = join(dir, "probe.mjs");
	const bundle = new URL("../.test-build/screendata.mjs", import.meta.url).href;
	writeFileSync(
		script,
		`import { collectScreen } from ${JSON.stringify(bundle)};
const run = { lane: "deepseek", round: 1, max_rounds: 6, state: "coding", tasks: [], repair_tasks: [], phases: [], rejection_history: [], started_utc: "2030-01-01T12:00:00.000Z" };
process.env.FADE_ORCHESTRATE_MOE_CONFIG = "/nonexistent/moe.json";
const d = await collectScreen({ run, runDir: ${JSON.stringify(dir)}, lanes: { think: "deepseek", code: "flash-next" } });
process.stdout.write(JSON.stringify({ tiers: d.tiers, moe: d.moe, missing: d.missing }));
`,
	);
	try {
		const out = execFileSync(process.execPath, [script], { env: { ...process.env, FADE_ORCHESTRATE_ROUTER: "http://127.0.0.1:1" }, encoding: "utf8", timeout: 30000 });
		const d = JSON.parse(out);
		assert.equal(d.tiers[0].label, "router");
		assert.match(d.tiers[0].value, /unreachable/);
		// The dead router adds exactly TWO rows: its own `router …unreachable`, and the claim row the
		// caller never read — the named-absent form, not a guessed "free". No engine/decode/resident row
		// is fabricated.
		assert.deepEqual(d.tiers.map((t) => t.label), ["router", "router claim"], `a dead router fabricates no measured tier: ${JSON.stringify(d.tiers)}`);
		assert.equal(d.tiers[1].value, "not measured", "an unread claim is named unread, never reported free");
		assert.ok(d.missing.some((m) => m.includes("unreachable")), JSON.stringify(d.missing));
		assert.ok(d.moe.every((m) => m.value !== "0"), JSON.stringify(d.moe));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── the CAPTURED live shapes ───────────────────────────────────────────────────────────────────
// The spill reading is ABSENT (0.4.0 /metrics has no spill-use key — null, NOT a zero), the slots
// read 2200/15360, hit_rate 0.79-0.80 with ~200k tokens reused, ssd_share null on every request,
// pcie_share ~0.54. Each row below is composed the way the screen composes it.
const liveSnapshot = {
	at_utc: "2030-01-01T13:40:00Z",
	quant: "IQ1_M",
	slots: 2200,
	spill_experts: undefined,
	spill_total: 15360,
	requests: [
		{ hit_rate: 0.8, reused: 204348, ssd_share: null, pcie_share: 0.54 },
		{ hit_rate: 0.79, reused: 150000, ssd_share: null, pcie_share: 0.53 },
	],
};
const liveRows = (over = {}) => [
	...tiersFromMetrics(liveSnapshot),
	moeCacheRow(liveSnapshot.requests),
	...moeRows(["flash-next", "deepseek"], { configPath: over.configPath, proof: over.proof }),
	...swapRows([]),
];
const liveRow = (rows, label) => {
	const r = rows.find((x) => x.label === label);
	assert.ok(r, `row ${label} exists: ${rows.map((x) => x.label).join(", ")}`);
	return r;
};

test("live shape: the absent spill reads ?/15360, measured pcie prints, the null ssd is NAMED", () => {
	const rows = liveRows({ configPath: "/nonexistent-basalt-config.json" });
	assert.equal(liveRow(rows, "expert slots").value, "2200 · spill ?/15360");
	const cache = liveRow(rows, "prefix cache").value;
	assert.match(cache, /79\.5% hit over 2 req · last 80\.0% \(204348 tok reused\) · pcie 53\.5% · ssd not reported/);
});

test("live config shape: a save-writing lane says so, and the unsupported lane is never sold as saving", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-panel-"));
	try {
		const prof = join(dir, "flash-next.prof");
		writeFileSync(prof, "P");
		const cfg = join(dir, "config.json");
		writeFileSync(cfg, JSON.stringify({ version: 2, models: [
			{ alias: "flash-next", model: "qwen3.8-coder.basalt", "expert-profile-save": prof, "expert-profile-save-every": 10 },
			{ alias: "deepseek", model: "DeepSeek-V4.1-Flash.basalt" },
		] }));
		const mtime_s = statSync(prof).mtimeMs / 1000;
		const rows = liveRows({ configPath: cfg, proof: { routerConfigPath: cfg, engineStartEpoch: mtime_s - 60 } });
		assert.match(liveRow(rows, "MoE flash-next").value, /written by this engine · warm start/);
		assert.match(liveRow(rows, "MoE deepseek").value, /unsupported \(Flash-Next only/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("live config, stale profile: the reload act renders instead of a green", () => {
	const dir = mkdtempSync(join(tmpdir(), "orch-panel-"));
	try {
		const prof = join(dir, "flash-next.prof");
		writeFileSync(prof, "P");
		const cfg = join(dir, "config.json");
		writeFileSync(cfg, JSON.stringify({ version: 2, models: [{ alias: "flash-next", model: "qwen3.8-coder.basalt", "expert-profile-save": prof }] }));
		const mtime_s = statSync(prof).mtimeMs / 1000;
		const rows = liveRows({ configPath: cfg, proof: { routerConfigPath: cfg, engineStartEpoch: mtime_s + 3600 } });
		assert.match(liveRow(rows, "MoE flash-next").value, /earlier engine's file · warm on reload/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── the router claim row: the screen names WHO holds the router ────────────────────────────────
// A refused start names the holder in its notify, and the panel is where the operator looks next, so
// the same fields ride the screen. "free" is a MEASURED answer; a caller that never read the claim is
// reported as not measured, never guessed free.
test("the claim row names this run, a foreign holder, free, and not measured, with the age", async () => {
	const foreign = { pid: 4242, run_id: "OTHER9", repo: "/home/elsewhere/checkout", started: "2030-01-01T00:00:00.000Z", host: "other-box" };
	// A fixed clock: the age is the row's "is this abandoned?" reading, so it is asserted, not left
	// to the wall.
	const src = (over) => ({ run: { run_id: "MINE1" }, runDir: "/none", lanes: { think: "deepseek", code: "flash-next" }, now: () => new Date("2030-01-01T12:00:00.000Z"), ...over });
	assert.equal(claimRow(src({ claim: foreign })).value, "HELD BY pid 4242: run OTHER9 in /home/elsewhere/checkout on other-box · held 12h00m", "the fields a refused start names, and the age");
	assert.equal(claimRow(src({ claim: { ...foreign, run_id: "MINE1" } })).value, "this run (pid 4242) · held 12h00m", "the run reading its own claim says so, with the pid");
	assert.equal(claimRow(src({ claim: { ...foreign, started: "hand written" } })).value, "HELD BY pid 4242: run OTHER9 in /home/elsewhere/checkout on other-box", "an unparseable start prints no age, never a guessed one");
	assert.equal(claimRow(src({ claim: null })).value, "free — no run holds this router", "free is a real reading");
	assert.equal(claimRow(src({})).value, "not measured", "a caller that never read the claim does not report a free router");
	const dir = mkdtempSync(join(tmpdir(), "fade-panel-claim-"));
	try {
		const d = await withMoe(undefined, () => collectScreen({ run: { ...run(), run_id: "MINE1" }, runDir: dir, lanes: { think: "deepseek", code: "flash-next" }, metrics, claim: foreign, now: () => new Date("2030-01-01T12:00:00.000Z") }));
		assert.ok(d.tiers.some((t) => t.label === "router claim" && t.value.includes("HELD BY pid 4242") && t.value.includes("· held 12h00m")), JSON.stringify(d.tiers.filter((t) => t.label === "router claim")));
		assert.equal(d.claim.run_id, "OTHER9", "the structured claim rides the screen data, not only its rendering");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
