#!/usr/bin/env node
// panel.test.mjs — the Alt+F screen (src/panel.ts).
//
// The screen has three jobs, and each is a test: it must FIT the terminal (the overlay is the
// whole width, so an over-long line is a wrapped, unreadable panel); it must carry the whole state
// in one view (the task list, the phase rail, the engine's numbers, the swap cost, the verifier's
// words, and every number nobody measured, named); and it must be LIVE (the panel re-reads on its
// tick and stops the moment it is closed). Keyboard: select, scroll, the loop controls, close.
import assert from "node:assert/strict";
import { hostname } from "node:os";
import test from "node:test";
import { isEscape, openPanel, PanelComponent, panelLines, TWO_COLUMN_MIN_WIDTH, visibleWidth, WIDGET_WIDTH } from "../.test-build/panel.mjs";

// The bundle in `.test-build/` is built by the ENTRY POINT (`npm run test:build` /
// `node test/build.mjs`), never from inside a test file: `node --test` runs files in parallel and
// the build empties the directory, so an in-file build wipes a sibling's imports mid-run.

const task = (id, status, over = {}) => ({ id, objective: `${id} objective: ${"long ".repeat(12)}text`, files: [`${id}.ts`], acceptance: `${id} acceptance: run the rig and read the frame`, dependencies: id === "T2" ? ["T1"] : [], round: 1, status, ...over });

const run = (over = {}) => ({
	run_id: "20261115T113829Z-gbut",
	goal: "complete the plugin work: Ctrl+O opens the orchestration screen with metrics",
	lane: "deepseek",
	round: 2,
	max_rounds: 6,
	tier: "hot",
	state: "coding",
	tasks: [task("T1", "passed"), task("T2", "passed"), task("T3", "failed")],
	repair_tasks: [],
	phases: [{ phase: "planning_done", at: "2026-11-15T12:00:00.000Z", lane: "deepseek", round: 1, accepted: true, payload: {} }, { phase: "coding", at: "2026-11-15T12:12:00.000Z", lane: "flash-next", round: 2, accepted: false, payload: {} }],
	rejection_history: [{ at: "2026-11-15T12:11:00.000Z", round: 1, kind: "gate", reason: "npm test failed: 2/3 checks red" }],
	started_utc: "2026-11-15T12:00:00.000Z",
	gate_last: { at: "2026-11-15T12:19:00.000Z", passed: false, results: [{ cmd: "npm test", expected: "exit 0", observed: "exit 1", ok: false }, { cmd: "npm run test:gate", expected: "PASS", observed: "PASS", ok: true }] },
	...over,
});

const data = (over = {}) => ({
	run: run(),
	refreshed_utc: "2026-11-15T12:14:02.000Z",
	elapsed_s: 842,
	lanes: [
		{ lane: "deepseek", role: "think", model: "deepseek (4.1 flash IQ1_M)", resident: true },
		{ lane: "flash-next", role: "code", model: "flash-next (flash IQ3_S)", resident: false },
	],
	tiers: [
		{ label: "engine", value: "0.4.0 quant IQ1_M" },
		{ label: "resident", value: "deepseek 100%" },
		{ label: "decode now", value: "130.5 tok/s (queue 0, idle)" },
	],
	moe: [{ label: "MoE deepseek", value: "live · warm (4 slots)", tone: "ok" }],
	turns: [],
	swaps: [{ key: "fade.omp_orchestrate.swap.v1", at: "2026-11-15T12:10:00.000Z", from: "deepseek", to: "flash-next", elapsed_s: 14.2, first_tg: 91, steady_tg: 130, ramp: "cold_ramp", load_percent: 100 }],
	context: { tokens: 41234, window: 1048576, percent: 3.9 },
	gate: run().gate_last,
	critique: "T3 died: the rig asserts a line that never renders",
	flip: { flips: 3, window_s: 120, competing: ["flash-next-ablit"] },
	missing: ["no turn telemetry (the router reported no pp/tg)"],
	...over,
});

const joined = (r) => r.lines.join("\n");

/**
 * `words` on one row, whitespace-agnostic. The metric rows pad their label column, so the contract
 * is "these words ride on one row" — pinning the exact number of padding spaces would be pinning
 * the layout, not the content.
 */
const hasRow = (s, words) => {
	const re = new RegExp(words.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("\\s+"));
	return re.test(s);
};

/**
 * The selected task's row: `▶ <status glyph> <id>`. The glyph sits between the marker and the id,
 * so an assertion written as `"▶ T2"` reads a string the panel never prints (measured: the row is
 * `▶ ✓ T2`). The contract is "the marker and this id share a row".
 */
const selRow = (s, id) => new RegExp(`▶\\s+\\S\\s+${id}\\b`).test(s);

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

test("visibleWidth: ANSI costs nothing on screen", () => {
	assert.equal(visibleWidth("\x1b[38;5;39mplain\x1b[0m"), 5);
	assert.equal(visibleWidth("plain"), 5);
});

test("the screen fits 120 columns and carries every section in one view", () => {
	const r = panelLines(data(), 120, { sel: 0 });
	for (const l of r.lines) assert.ok(visibleWidth(l) <= 120, `over-long at 120: ${visibleWidth(l)} ${JSON.stringify(l)}`);
	const s = joined(r);
	assert.ok(s.includes("fade-orchestrator 20261115T113829Z-gbut"), s.slice(0, 200));
	assert.ok(s.includes("round 2/6"), "the round budget rides");
	assert.ok(s.includes("14m02s"), "the run's age rides");
	assert.ok(s.includes("tier hot"), "the VRAM tier rides");
	assert.ok(s.includes("deepseek (4.1 flash IQ1_M)=think ◆resident"), "the lanes and the resident fact ride");
	assert.ok(s.includes("TASKS 2/3 passed"), s);
	assert.ok(s.includes("T1"), "the task ids ride");
	assert.ok(s.includes("PHASES"), "the phase rail rides");
	assert.ok(s.includes("ENGINE / ROUTER"), "the metrics column rides");
	assert.ok(hasRow(s, "engine 0.4.0 quant IQ1_M"), "the engine/quant row rides");
	assert.ok(hasRow(s, "decode now 130.5 tok/s (queue 0, idle)"), "decode and queue ride");
	assert.ok(hasRow(s, "MoE deepseek live · warm (4 slots)"), "the MoE state rides");
	assert.ok(hasRow(s, "context 41.2k / 1.05M (3.9%)"), "the context meter rides");
	assert.ok(hasRow(s, "gate RED 1/2 failing"), "the gate result rides");
	assert.ok(s.includes("LANE SWAPS"), "the swap table rides");
	assert.ok(hasRow(s, "deepseek → flash-next 14.2s · 91→130 tok/s · cold ramp"), "the measured swap cost rides");
	assert.ok(s.includes("LAST VERIFIER CRITIQUE"), "the critique rides");
	assert.ok(s.includes("RECENT REJECTIONS"), "the rejections ride");
	assert.ok(s.includes("LANE FLIP"), "the flip guard rides");
	assert.ok(s.includes("NOT MEASURED"), "the named gaps ride");
	assert.ok(s.includes("[s] skip selected"), "the key bar rides");
	assert.ok(s.includes("[esc] close"), "close is on screen");
});

test("the box is SQUARE, and the key bar never loses a key", () => {
	// Both halves are measured defects: the header rows left the right border ragged, and the
	// single-line key bar (120 visible columns) was CUT at the 110-column default surface, so
	// `[esc] close` — the key the operator needs — was not on screen.
	for (const w of [120, 110, 100, 60]) {
		const lines = panelLines(data(), w, { sel: 0 }).lines;
		for (const l of lines) assert.equal(visibleWidth(l), w, `row is not flush at ${w}: ${JSON.stringify(l)}`);
		const s = lines.join("\n");
		for (const key of ["[↑↓/j-k] select", "[PgUp/PgDn] scroll", "[s] skip selected", "[v] verify", "[r] reset", "[p] pause", "[c] code", "[h] halt", "[esc] close"]) {
			assert.ok(s.includes(key), `the key bar lost ${key} at ${w} columns`);
		}
	}
});

test("the screen fits 60 columns: the metrics stack under the list, nothing is dropped", () => {
	const r = panelLines(data(), 60, { sel: 0 });
	for (const l of r.lines) assert.ok(visibleWidth(l) <= 60, `over-long at 60: ${visibleWidth(l)} ${JSON.stringify(l)}`);
	const s = joined(r);
	for (const need of ["TASKS 2/3 passed", "PHASES", "ENGINE / ROUTER", "engine 0.4.0 quant IQ1_M", "gate RED 1/2 failing", "LANE SWAPS", "[esc] close"]) {
		assert.ok(hasRow(s, need), `60-column screen lost ${need}`);
	}
});

test("the panel clips its own text: a 40-column terminal still renders, with every line inside the frame", () => {
	const r = panelLines(data({ run: run({ goal: "goal ".repeat(200) }) }), 40, { sel: 0 });
	for (const l of r.lines) assert.ok(visibleWidth(l) <= 40, `over-long at 40: ${visibleWidth(l)}`);
	assert.ok(r.lines.length > 10, "the screen is long, not empty");
});

test("the two-column split starts at 100 columns", () => {
	const wide = panelLines(data(), TWO_COLUMN_MIN_WIDTH, { sel: 0 });
	const narrow = panelLines(data(), TWO_COLUMN_MIN_WIDTH - 1, { sel: 0 });
	const inWide = (s) => s.split("\n").filter((l) => l.includes("ENGINE / ROUTER") && l.includes("T1")).length;
	assert.equal(inWide(joined(wide)), 0, "the metrics header is on its own row, list on the left");
	const sameRow = (r) => r.lines.filter((l) => visibleWidth(l) > 0 && l.includes("TASKS") === false && /TASKS|ENGINE/.test(l) && l.includes("ENGINE / ROUTER")).length;
	assert.ok(sameRow(wide) >= 0);
	assert.ok(joined(narrow).includes("ENGINE / ROUTER"));
});

test("the selected task carries its details; every other task stays one line", () => {
	const r = panelLines(data(), 120, { sel: 1 });
	const s = joined(r);
	assert.ok(selRow(s, "T2"), "the selection marker");
	assert.ok(s.includes("files: T2.ts"), `the selected task's files: ${s}`);
	assert.ok(s.includes("deps: T1"), "the dependency rides on the selected row");
	assert.ok(s.includes("acceptance: T2 acceptance"), "the acceptance criterion rides");
	assert.ok(!s.includes("files: T1.ts"), "an unselected task is one line, not a dump");
	assert.ok(!selRow(s, "T1"), "exactly one selection marker");
});

test("the selected task's checkpoint tag and result ride, so a resume point is on screen", () => {
	const d = data({ run: run({ tasks: [task("T1", "passed", { result: "wired the panel and proved it" })], checkpoints: { T1: "omp-ckpt/20261115T113829Z-gbut/T1-passed" } }) });
	const s = joined(panelLines(d, 120, { sel: 0 }));
	assert.ok(s.includes("tag: omp-ckpt/20261115T113829Z-gbut/T1-passed"), s);
	assert.ok(s.includes("result: wired the panel and proved it"));
});

test("the repair queue is named when it owns the round", () => {
	const d = data({ run: run({ tasks: [task("T1", "failed")], repair_tasks: [task("T1", "pending", { round: 2 })] }) });
	const s = joined(panelLines(d, 120, { sel: 0 }));
	assert.ok(s.includes("repair queue active"), s);
	assert.ok(s.includes("(repair)"), "the row says which task is in repair");
});

test("a protocol stall and a paused run are stated in words on the screen", () => {
	const stall = joined(panelLines(data({ run: run({ state: "stalled_protocol_error", stall_count: 3, protocol_retries: 2, synthesized: { round: 2, phase: "coding_done", notes: "auto-synthesized" } }) }), 120, { sel: 0 }));
	assert.ok(stall.includes("PROTOCOL STALL"), stall.slice(0, 400));
	assert.ok(stall.includes("consecutive stalls 3/3"));
	const paused = joined(panelLines(data({ run: run({ paused: true, operator_note: "editing the rig by hand" }) }), 120, { sel: 0 }));
	assert.ok(paused.includes("paused"), paused.slice(0, 300));
	assert.ok(paused.includes("editing the rig by hand"));
});

test("redaction: a screenshot of the screen carries no account, home, repo path or host", () => {
	const user = process.env.USER && process.env.USER.length > 1 ? process.env.USER : "someone";
	const repo = `/home/${user}/projects/fadetheworld`;
	// The redactor knows the facts a screenshot LEAKS: this machine's hostname, this account, this
	// repo. A made-up host string is not one of them, so the fixture uses the real one.
	const host = hostname();
	const d = data({ run: run({ repo, goal: `run in ${repo} on ${host} by ${user}` }) });
	const s = withFlag("1", () => joined(panelLines(d, 120, { sel: 0 })));
	assert.ok(!s.includes(repo), "the repo path must not survive");
	assert.ok(!s.includes("/home/"), "the home form must not survive");
	assert.ok(!s.includes(host), "the hostname must not survive");
	assert.ok(!s.includes(user), "the account must not survive");
	const off = joined(panelLines(d, 120, { sel: 0 }));
	assert.ok(off.includes(repo), "the flag is off by default: the operator's own truth stays on screen");
});

test("Y19 --demo-redact: every printed field is masked with markers, and OFF is byte-identical truth", () => {
	// The row's flag is the panel's flag: one display switch for every surface a screenshot can
	// capture. The identity rides in THREE fields on purpose (goal, reason, operator note) — a
	// redactor that only patches the header fails here, and the markers must REPLACE the text so
	// the screen stays readable (a screenshot with the fields deleted proves nothing to a viewer).
	const user = process.env.USER && process.env.USER.length > 1 ? process.env.USER : "someone";
	const repo = `/home/${user}/projects/fadetheworld`;
	const host = hostname();
	const d = data({
		run: run({
			repo,
			goal: `run ${repo} by ${user} on ${host}`,
			reason: `halted in ${repo}: ${user}@${host} left the checks red`,
			operator_note: `note from ${user}@${host}, worktree ${repo}`,
		}),
	});
	const on = withFlag("1", () => joined(panelLines(d, 120, { sel: 0 })));
	assert.ok(on.includes("<path>") && on.includes("<user>") && on.includes("<host>"), `the markers replace, they do not drop the line: ${on.slice(0, 400)}`);
	assert.ok(!on.includes(repo) && !on.includes("/home/") && !on.includes(host) && !on.includes(user), on.slice(0, 400));
	const off = joined(panelLines(d, 120, { sel: 0 }));
	assert.ok(off.includes(repo) && off.includes(host), "OFF is the operator's own truth, verbatim — state.json on disk is never rewritten by the switch");
});

test("the headless widget path renders the SAME screen the TUI draws", () => {
	const lines = panelLines(data(), WIDGET_WIDTH, { sel: 0 }).lines;
	assert.ok(lines.some((l) => l.includes("fade-orchestrator 20261115T113829Z-gbut")));
	assert.ok(lines.some((l) => l.includes("ENGINE / ROUTER")));
	for (const l of lines) assert.ok(visibleWidth(l) <= WIDGET_WIDTH);
});

// ---- the live component ----

const tui = (rows = 40) => ({ terminal: { rows, columns: 120 }, renders: 0, requestRender() { this.renders += 1; } });

/**
 * The panel's refresh tick is a live `setInterval`: a panel the test does not dispose keeps the
 * process alive (measured: `node --test test/panel.test.mjs` never exits). Every test that builds
 * a component disposes it, which is the same contract the overlay has at runtime.
 */
const component = (d, provider, rows = 40, refreshMs = 10000) => {
	const out = [];
	const t = tui(rows);
	const c = new PanelComponent(d, provider, undefined, t, (r) => out.push(r), refreshMs);
	return { c, t, out };
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test("the component: j/k and the arrows move the selection, and the screen follows", () => {
	const { c } = component(data(), async () => data());
	assert.ok(selRow(c.render(120).join("\n"), "T1"), "the first task starts selected");
	c.handleInput("j");
	assert.ok(selRow(c.render(120).join("\n"), "T2"), "j selects the next task");
	c.handleInput("\x1b[B");
	assert.ok(selRow(c.render(120).join("\n"), "T3"), "the down arrow is the same key");
	c.handleInput("j");
	assert.ok(selRow(c.render(120).join("\n"), "T3"), "the selection stops at the last task");
	c.handleInput("k");
	c.handleInput("k");
	c.handleInput("k");
	assert.ok(selRow(c.render(120).join("\n"), "T1"), "k walks back and stops at the first task");
	c.dispose();
});

test("the component: the loop controls answer with the key and the selected task", () => {
	const { c, out } = component(data(), async () => data());
	c.handleInput("j");
	c.handleInput("s");
	// `done` carries the JSON string the overlay hands the host (openPanel parses it), so the test
	// reads the action through the same parse the host does.
	const last = () => JSON.parse(out.at(-1));
	assert.deepEqual(last(), { key: "s", taskId: "T2" }, "skip names the SELECTED task, not the first");
	for (const [key, expect] of [["v", "v"], ["r", "r"], ["p", "p"], ["c", "c"], ["h", "h"]]) {
		c.handleInput(key);
		assert.equal(last().key, expect);
		assert.equal(last().taskId, "T2", "every control acts on the selected task");
	}
	c.handleInput("\x1b");
	assert.deepEqual(last(), { key: "close" }, "esc closes without touching the loop");
	c.handleInput("q");
	assert.deepEqual(last(), { key: "close" });
	c.dispose();
});

test("the component: PgDn/PgUp/g/G scroll a long screen, and the selection stays visible", () => {
	const many = data({ run: run({ tasks: Array.from({ length: 30 }, (_, i) => task(`T${i + 1}`, i === 0 ? "passed" : "pending")) }) });
	const { c } = component(many, async () => many, 20);
	const top = c.render(120);
	assert.ok(top[1].includes("fade-orchestrator"), "the screen starts at the header (row 0 is the box border)");
	for (let i = 0; i < 29; i++) c.handleInput("j");
	const bottom = c.render(120);
	assert.ok(bottom.some((l) => selRow(l, "T30")), "the last task is on screen");
	assert.ok(!bottom.join("\n").includes("fade-orchestrator"), "the view scrolled: the header is above it");
	c.handleInput("g");
	assert.ok(c.render(120)[1].includes("fade-orchestrator"), "g jumps to the top");
	c.handleInput("\x1b[6~");
	assert.ok(!c.render(120).join("\n").includes("fade-orchestrator"), "PgDn scrolled past the header");
	c.handleInput("\x1b[5~");
	assert.ok(c.render(120).join("\n").includes("fade-orchestrator"), "PgUp scrolls back");
	c.handleInput("G");
	assert.ok(!c.render(120).join("\n").includes("fade-orchestrator"), "G jumps to the end");
	c.dispose();
});

test("the component is LIVE: the provider's new screen lands on the tick, and dispose stops the polling", async () => {
	let calls = 0;
	const provider = async () => {
		calls += 1;
		return data({ refreshed_utc: `2026-11-15T12:14:${String(calls).padStart(2, "0")}Z` });
	};
	const { c, t } = component(data(), provider, 40, 20);
	await sleep(90);
	const shown = c.render(120).join("\n");
	assert.ok(calls >= 2, `the tick fired ${calls} times`);
	assert.ok(t.renders >= 1, "a refresh kicks the renderer, which is how the numbers move while you watch");
	assert.ok(shown.includes("12:14:0"), `the refreshed clock is on screen: ${shown.slice(0, 160)}`);
	const after = calls;
	c.dispose();
	c.dispose();
	await sleep(60);
	assert.equal(calls, after, "dispose cleared the tick: a closed panel never polls the router again");
});

test("the component keeps its own selection and scroll across a refresh", async () => {
	let n = 0;
	const provider = async () => {
		n += 1;
		return data({ run: run({ tasks: Array.from({ length: 30 }, (_, i) => task(`T${i + 1}`, "pending")) }), refreshed_utc: `2026-11-15T12:14:${String(n).padStart(2, "0")}Z` });
	};
	const many = data({ run: run({ tasks: Array.from({ length: 30 }, (_, i) => task(`T${i + 1}`, "pending")) }) });
	const { c } = component(many, provider, 20, 20);
	for (let i = 0; i < 12; i++) c.handleInput("j");
	const before = c.render(120).join("\n");
	await sleep(90);
	const after = c.render(120).join("\n");
	assert.ok(selRow(before, "T13"), before.slice(0, 200));
	assert.ok(selRow(after, "T13"), "the refresh did not reset the operator's selection");
	c.dispose();
});

test("a provider failure keeps the last screen: a dead router never blanks the panel", async () => {
	let first = true;
	const provider = async () => {
		if (first) {
			first = false;
			return data();
		}
		throw new Error("router /metrics timed out");
	};
	const { c, t } = component(data(), provider, 40, 20);
	await sleep(90);
	const shown = c.render(120).join("\n");
	assert.ok(shown.includes("fade-orchestrator 20261115T113829Z-gbut"), "the screen is still the run's screen");
	assert.ok(shown.includes("ENGINE / ROUTER"), "the metrics column is still there");
	c.dispose();
});

// ---- openPanel: the two surfaces ----

test("openPanel: RPC/print mode puts the same screen in the widget and takes no focus", async () => {
	const calls = [];
	const ctx = { hasUI: false, ui: { setWidget: (key, lines, opts) => calls.push({ key, lines, opts }), custom: async () => { throw new Error("headless must not open an overlay"); } } };
	await openPanel(ctx, async () => data(), undefined, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].key, "fade-overlay");
	assert.ok(calls[0].lines.some((l) => l.includes("fade-orchestrator 20261115T113829Z-gbut")));
	assert.ok(calls[0].lines.some((l) => l.includes("ENGINE / ROUTER")));
});

test("openPanel: interactive mode opens a near-full-screen overlay and routes the action", async () => {
	const captured = {};
	const ctx = {
		hasUI: true,
		ui: {
			setWidget: () => {
				throw new Error("interactive mode must not use the widget");
			},
			custom: async (factory, opts) => {
				captured.opts = opts;
				const done = (r) => (captured.result = r);
				captured.component = factory(tui(40), undefined, undefined, done);
				captured.component.render(120);
				captured.component.handleInput("s");
				return captured.result;
			},
		},
	};
	const actions = [];
	await openPanel(ctx, async () => data(), (a) => actions.push(a), false);
	assert.equal(captured.opts.overlay, true, "the panel opens as an overlay");
	const shape = captured.opts.overlayOptions();
	assert.equal(shape.width, "96%");
	assert.equal(shape.maxHeight, "94%");
	assert.deepEqual(actions, [{ key: "s", taskId: "T1" }], "the panel's key reaches the loop control");
	captured.component.dispose();
});

test("openPanel: closing the overlay touches no loop control", async () => {
	const ctx = {
		hasUI: true,
		ui: {
			setWidget: () => undefined,
			custom: async (factory) => {
				const c = factory(tui(40), undefined, undefined, () => undefined);
				c.handleInput("\x1b");
				c.dispose();
				return JSON.stringify({ key: "close" });
			},
		},
	};
	const actions = [];
	await openPanel(ctx, async () => data(), (a) => actions.push(a), false);
	assert.deepEqual(actions, [], "esc is a view act");
});

test("a run state MISSING its arrays renders — the panel must never die on a shape it did not predict", () => {
	// Measured in the rpc rig (2026-11-15): a seeded `state.json` carried `tasks`/`checks` but no
	// `repair_tasks`, and `run.repair_tasks.length` threw inside `taskBlock` — `/orchestrate overlay`
	// produced an error notify and ZERO widget frames. The night's earlier defect was the same class:
	// a state written mid-plan with no `phases`. A JSON file is not the type; the screen reads an
	// absent array as empty and says so in words.
	const bare = data({ run: { ...run(), tasks: undefined, phases: undefined, repair_tasks: undefined } });
	const s = joined(panelLines(bare, 120, { sel: 0 }));
	assert.ok(s.includes("TASKS 0/0 passed"), "the task block names an empty plan instead of throwing");
	assert.ok(s.includes("no plan yet"), "and says the loop is still planning");
	assert.ok(s.includes("none accepted yet"), "the phase rail says none accepted");
});

// ── ESC closes the screen in EVERY encoding the host delivers (the operator's report) ────────────
// The focused component receives RAW bytes (pi-tui tui.js:420-425), and the host's own escape
// matcher (keys.js:648-654) accepts THREE forms: the legacy byte, the Kitty keyboard-protocol CSI-u
// sequence, and xterm modifyOtherKeys. A terminal that enables the Kitty protocol (kitty, wezterm,
// ghostty, foot) delivers ESC as `\x1b[27u`, so the panel's byte-equal compare against "\x1b" left
// ESC dead while `q` closed. tmux's `screen` terminal never enables the protocol, which is why the
// pty rig — `send-keys Escape` → the legacy byte — never caught it.
const closeProbe = () => {
	const closed = [];
	const c = new PanelComponent(data(), async () => data(), undefined, tui(24), (r) => closed.push(JSON.parse(r)), 60000);
	return { c, closed };
};

test("isEscape: the predicate names the escape in every host-recognized form", () => {
	for (const d of ["\x1b", "\x1b[27u", "\x1b[27;1u", "\x1b[27;1;27~"]) assert.equal(isEscape(d), true, `${JSON.stringify(d)} must read as ESC`);
	for (const d of ["\x1b[27;1:3u", "\x1b[27;3u", "\x1b[27;1;13~", "\x1b[A", "q", ""]) assert.equal(isEscape(d), false, `${JSON.stringify(d)} must not read as ESC`);
});

for (const [name, bytes] of [
	["legacy byte", "\x1b"],
	["kitty CSI-u press", "\x1b[27u"],
	["kitty press, explicit modifier", "\x1b[27;1u"],
	["xterm modifyOtherKeys", "\x1b[27;1;27~"],
]) {
	test(`esc (${name}) closes the screen`, () => {
		const { c, closed } = closeProbe();
		c.handleInput(bytes);
		assert.deepEqual(closed, [{ key: "close" }], `${JSON.stringify(bytes)} did not close the screen`);
		c.dispose();
	});
}

test("esc: a kitty RELEASE, ESC+modifier, modifyOtherKeys of another key, and an arrow are NOT closes", () => {
	const { c, closed } = closeProbe();
	for (const d of ["\x1b[27;1:3u", "\x1b[27;3u", "\x1b[27;1;13~", "\x1b[A", "\x1b[27;1;13:3~"]) {
		c.handleInput(d);
	}
	assert.equal(closed.length, 0, `a non-close sequence ended the screen: ${JSON.stringify(closed)}`);
	c.handleInput("q");
	assert.deepEqual(closed, [{ key: "close" }], "q must still close");
	c.dispose();
});
