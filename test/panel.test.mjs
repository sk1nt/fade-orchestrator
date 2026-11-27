#!/usr/bin/env node
// panel.test.mjs — the Alt+F screen (src/panel.ts).
//
// The screen has three jobs, and each is a test: it must FIT the terminal (the overlay is the
// whole width, so an over-long line is a wrapped, unreadable panel); it must carry the whole state
// in one view (the task list, the phase rail, the engine's numbers, the swap cost, the verifier's
// words, and every number nobody measured, named); and it must be LIVE (the panel re-reads on its
// tick and stops the moment it is closed). Keyboard: select, scroll, the loop controls, close.
import assert from "node:assert/strict";
import { hostname, userInfo } from "node:os";

/**
 * The account the REDACTOR masks, resolved the way `ui.ts` `account()` resolves it: `$USER` first,
 * the passwd entry as the fallback. A fixture that guessed (the old `"someone"` fallback) tested a
 * string the redactor never masks: it passes only where `$USER` is set — the public CI — and goes
 * red in the fade-ci container, because that container runs with `--user 1000:1000` and no login
 * name reaches `$USER`. The fixture resolves the account through the same fallback the redactor
 * uses; it never names one.
 */
const account = () => {
	const env = process.env.USER;
	if (env && env.length > 1) return env;
	try {
		return userInfo().username || "";
	} catch {
		return "";
	}
};
import "./env.mjs?suite=panel";
import test from "node:test";
import { isClose, isEscape, openPanel, PanelComponent, panelLines, PANEL_FALLBACK_COLUMNS, PANEL_FALLBACK_ROWS, terminalSize, TWO_COLUMN_MIN_WIDTH, visibleWidth, WIDGET_WIDTH } from "../.test-build/panel.mjs";

const task = (id, status, over = {}) => ({ id, objective: `${id} objective: ${"long ".repeat(12)}text`, files: [`${id}.ts`], acceptance: `${id} acceptance: run the rig and read the frame`, dependencies: id === "T2" ? ["T1"] : [], round: 1, status, ...over });

const run = (over = {}) => ({
	run_id: "20300101T113829Z-gbut",
	goal: "complete the plugin work: Alt+F opens the orchestration screen with metrics",
	lane: "deepseek",
	round: 2,
	max_rounds: 6,
	tier: "hot",
	state: "coding",
	tasks: [task("T1", "passed"), task("T2", "passed"), task("T3", "failed")],
	repair_tasks: [],
	phases: [{ phase: "planning_done", at: "2030-01-01T12:00:00.000Z", lane: "deepseek", round: 1, accepted: true, payload: {} }, { phase: "coding", at: "2030-01-01T12:12:00.000Z", lane: "flash-next", round: 2, accepted: false, payload: {} }],
	rejection_history: [{ at: "2030-01-01T12:11:00.000Z", round: 1, kind: "gate", reason: "npm test failed: 2/3 checks red" }],
	started_utc: "2030-01-01T12:00:00.000Z",
	gate_last: { at: "2030-01-01T12:19:00.000Z", passed: false, results: [{ cmd: "npm test", expected: "exit 0", observed: "exit 1", ok: false }, { cmd: "npm run test:gate", expected: "PASS", observed: "PASS", ok: true }] },
	...over,
});

const data = (over = {}) => ({
	run: run(),
	refreshed_utc: "2030-01-01T12:14:02.000Z",
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
	swaps: [{ key: "fade.omp_orchestrate.swap.v1", at: "2030-01-01T12:10:00.000Z", from: "deepseek", to: "flash-next", elapsed_s: 14.2, first_tg: 91, steady_tg: 130, ramp: "cold_ramp" }],
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
	assert.ok(s.includes("fade-orchestrator 20300101T113829Z-gbut"), s.slice(0, 200));
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
	assert.ok(hasRow(s, "swaps this run 0 · older runs only"), "the run's own cost rides, and a ledger of unattributed rows prices it at nothing this run can prove");
	const bill = r.lines.findIndex((l) => l.includes("swaps this run"));
	const table = r.lines.findIndex((l) => l.includes("deepseek → flash-next"));
	assert.ok(bill >= 0 && table >= 0 && bill < table, "the run's bill sits ABOVE the plane's swap table: two questions, in reading order");
	assert.ok(s.includes("LAST VERIFIER CRITIQUE"), "the critique rides");
	assert.ok(s.includes("RECENT REJECTIONS"), "the rejections ride");
	assert.ok(s.includes("LANE FLIP"), "the flip guard rides");
	assert.ok(s.includes("NOT MEASURED"), "the named gaps ride");
	assert.ok(s.includes("[s] skip selected"), "the key bar rides");
	assert.ok(s.includes("[esc/q/Alt+F] close"), "close is on screen");
});

test("the box is SQUARE, and the key bar never loses a key", () => {
	// Both halves are measured defects: the header rows left the right border ragged, and the
	// single-line key bar (120 visible columns) was CUT at the 110-column default surface, so
	// `[esc] close` — the key the operator needs — was not on screen.
	for (const w of [120, 110, 100, 60]) {
		const lines = panelLines(data(), w, { sel: 0 }).lines;
		for (const l of lines) assert.equal(visibleWidth(l), w, `row is not flush at ${w}: ${JSON.stringify(l)}`);
		const s = lines.join("\n");
		for (const key of ["[↑↓/j-k] select", "[PgUp/PgDn] scroll", "[s] skip selected", "[v] verify", "[r] reset", "[p] pause", "[c] code", "[h] halt", "[esc/q/Alt+F] close"]) {
			assert.ok(s.includes(key), `the key bar lost ${key} at ${w} columns`);
		}
	}
});

test("the screen fits 60 columns: the metrics stack under the list, nothing is dropped", () => {
	const r = panelLines(data(), 60, { sel: 0 });
	for (const l of r.lines) assert.ok(visibleWidth(l) <= 60, `over-long at 60: ${visibleWidth(l)} ${JSON.stringify(l)}`);
	const s = joined(r);
	for (const need of ["TASKS 2/3 passed", "PHASES", "ENGINE / ROUTER", "engine 0.4.0 quant IQ1_M", "gate RED 1/2 failing", "LANE SWAPS", "[esc/q/Alt+F] close"]) {
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
	const d = data({ run: run({ tasks: [task("T1", "passed", { result: "wired the panel and proved it" })], checkpoints: { T1: "omp-ckpt/20300101T113829Z-gbut/T1-passed" } }) });
	const s = joined(panelLines(d, 120, { sel: 0 }));
	assert.ok(s.includes("tag: omp-ckpt/20300101T113829Z-gbut/T1-passed"), s);
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
	const user = account() || "someone";
	const repo = `/home/${user}/projects/sample-project`;
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
	assert.ok(off.includes(repo), "the flag is off by default: the user's own truth stays on screen");
});

test("--demo-redact: every printed field is masked with markers, and OFF is byte-identical truth", () => {
	// The row's flag is the panel's flag: one display switch for every surface a screenshot can
	// capture. The identity rides in THREE fields on purpose (goal, reason, operator note) — a
	// redactor that only patches the header fails here, and the markers must REPLACE the text so
	// the screen stays readable (a screenshot with the fields deleted proves nothing to a viewer).
	const user = account() || "someone";
	const repo = `/home/${user}/projects/sample-project`;
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
	assert.ok(lines.some((l) => l.includes("fade-orchestrator 20300101T113829Z-gbut")));
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
	c.handleInput("\x1bf");
	assert.deepEqual(last(), { key: "close" }, "the OPEN chord closes an open panel: the overlay is keystroke-owned, so it can always be left by hand");
	c.handleInput("\x1b[99;5u");
	assert.deepEqual(last(), { key: "close" }, "the Kitty CSI-u Ctrl+C closes too: the host focuses the overlay and hands IT Ctrl+C");
	c.dispose();
});

test("isClose: the close set is a parse, not a byte — every ESC encoding, Ctrl+C, and the chord close", () => {
	// ESC in EVERY encoding the host's parser recognizes: the legacy byte, the Kitty
	// keyboard-protocol CSI-u form (`\x1b[<code>;<mod>u` — kitty, wezterm, ghostty, foot, where
	// the ESC key sends CSI-u and a legacy-only matcher traps the overlay), and xterm's
	// modifyOtherKeys (`\x1b[27;<mod>;<code>~`). tmux's `screen` cannot enable the Kitty
	// protocol, which is exactly why the pty rig passed for weeks while ESC was dead live.
	assert.equal(isEscape("\x1b"), true);
	assert.equal(isEscape("\x1b[27u"), true, "the Kitty CSI-u escape");
	assert.equal(isEscape("\x1b[27;5u"), true, "Kitty CSI-u with a modifier");
	assert.equal(isEscape("\x1b[27:3u"), false, "the Kitty RELEASE form is excluded: one press is one close");
	assert.equal(isEscape("\x1b[27;1;27~"), true, "xterm modifyOtherKeys");
	assert.equal(isClose("\x1b"), true);
	assert.equal(isClose("\x1b[27u"), true);
	assert.equal(isClose("\x03"), true, "Ctrl+C closes — the host focuses the overlay and hands IT Ctrl+C");
	assert.equal(isClose("\x1b[99;5u"), true, "Ctrl+C as Kitty CSI-u");
	assert.equal(isClose("\x1b[27;5;99~"), true, "Ctrl+C as modifyOtherKeys");
	assert.equal(isClose("\x1bf"), true, "the open chord closes: the overlay is keystroke-owned (the toggle)");
	assert.equal(isClose("\x1b[102;3u"), true, "Alt+F as Kitty CSI-u closes");
	assert.equal(isClose("\x1b[102;3:3u"), false, "the chord RELEASE byte is not a second close");
	assert.equal(isClose("q"), true, "`q` is in the close family the component honors");
	assert.equal(isClose("x"), false, "an unbound byte is not close");
	assert.equal(isClose("\x1b[Z"), false, "shift-TAB is not close");
	assert.equal(isClose("\x1bq"), false, "ESC-q is a chord, not ESC");
	assert.equal(isClose("\x1bb"), false, "alt-left is a host edit, not close");
	assert.equal(isClose("\x0f"), false, "Ctrl+O (0x0f) is NOT close: raw 15 is not ESC");
});

test("the close set follows the CONFIGURED chord: move the key, move the toggle", async () => {
	// OPEN_CHORD is read at import, like the raw listener's byte. The suite owns the env
	// (`env.mjs` deleted `FADE_ORCHESTRATE_KEY`), so this is a fresh import with the chord moved.
	process.env.FADE_ORCHESTRATE_KEY = "alt+shift+i";
	try {
		const m = await import(`../.test-build/panel.mjs?case=chord-${Date.now()}`);
		assert.equal(m.isClose("\x1bI"), true, "the configured chord closes an open panel");
		assert.equal(m.isClose("\x1bf"), false, "with the key moved, the default byte is not the panel's chord");
	} finally {
		delete process.env.FADE_ORCHESTRATE_KEY;
	}
});

test("openPanel bounds the FIRST read: a provider that never answers leaves NO overlay and a clearable flag", async () => {
	// The overlay flag is set BEFORE the first read; a provider that never resolves used to strand
	// it with NO `ctx.ui.custom` mounted — no key, not even Ctrl+C, could leave, and the chord was
	// dead for the session. The bound returns; the caller's `finally` clears the flag; the keystroke
	// retries.
	process.env.FADE_ORCHESTRATE_PANEL_FIRST_MS = "20";
	const notices = [];
	const widgets = [];
	const ctx = {
		hasUI: false,
		ui: {
			notify: (m) => notices.push(m),
			setWidget: (k) => widgets.push(k),
		},
	};
	const t0 = Date.now();
	await openPanel(ctx, () => new Promise(() => undefined), undefined, true);
	const spent = Date.now() - t0;
	assert.ok(notices.some((n) => n.includes("did not answer")), notices.join(" | "));
	assert.equal(widgets.length, 0, "no widget is written from a read that never landed");
	assert.ok(spent < 2000, `the bound, not the default: ${spent}ms`);
	delete process.env.FADE_ORCHESTRATE_PANEL_FIRST_MS;
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
		return data({ refreshed_utc: `2030-01-01T12:14:${String(calls).padStart(2, "0")}Z` });
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
		return data({ run: run({ tasks: Array.from({ length: 30 }, (_, i) => task(`T${i + 1}`, "pending")) }), refreshed_utc: `2030-01-01T12:14:${String(n).padStart(2, "0")}Z` });
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
	assert.ok(shown.includes("fade-orchestrator 20300101T113829Z-gbut"), "the screen is still the run's screen");
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
	assert.ok(calls[0].lines.some((l) => l.includes("fade-orchestrator 20300101T113829Z-gbut")));
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
	// Observed in the rpc rig: a seeded `state.json` carried `tasks`/`checks` but no
	// `repair_tasks`, and `run.repair_tasks.length` threw inside `taskBlock` — `/orchestrate overlay`
	// produced an error notify and ZERO widget frames. An earlier defect was the same class:
	// a state written mid-plan with no `phases`. A JSON file is not the type; the screen reads an
	// absent array as empty and says so in words.
	const bare = data({ run: { ...run(), tasks: undefined, phases: undefined, repair_tasks: undefined } });
	const s = joined(panelLines(bare, 120, { sel: 0 }));
	assert.ok(s.includes("TASKS 0/0 passed"), "the task block names an empty plan instead of throwing");
	assert.ok(s.includes("no plan yet"), "and says the loop is still planning");
	assert.ok(s.includes("none accepted yet"), "the phase rail says none accepted");
});

// ── ESC closes the screen in EVERY encoding the host delivers ─────────────────────────────────
// The focused component receives RAW bytes, and the host's own escape matcher accepts THREE forms:
// the legacy byte, the Kitty keyboard-protocol CSI-u sequence, and xterm modifyOtherKeys. A terminal
// that enables the Kitty protocol (kitty, wezterm, ghostty, foot) delivers ESC as `\x1b[27u`, so a
// byte-equal compare against "\x1b" leaves ESC dead while `q` closes. tmux's `screen` terminal never
// enables the protocol, which is why the pty rig — `send-keys Escape` → the legacy byte — never
// catches it.
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

test("the swap block bills a run whose ledger rows carry its id", () => {
	// The plane's ledger is shared by every run. The bill is the stamped rows only: the same fixture
	// with the stamp present must read the measured cost, and never a zero for a paid swap.
	const stamped = data({ swaps: [{ ...data().swaps[0], run_id: "20300101T113829Z-gbut" }] });
	const s = joined(panelLines(stamped, 120, { sel: 0 }));
	assert.ok(hasRow(s, "swaps this run 1 · 14.2s paid"), s.slice(0, 400));
});

// ── the terminal-size wrapper: the screen paints on a host that reports nothing ─────────────
// Measured 2026-11-26 on the live box, at extension load: the host's render pass called
// `getHeight()`, `this.tui.terminal` was `undefined`, and the host's per-frame catch painted
//   extension render failed: undefined is not an object (evaluating 'this.tui.terminal.rows')
// in place of the screen — every frame, so Alt+F opened nothing. The host's loading-phase surface
// is exactly this shape (a stub whose members answer `undefined` and whose action methods throw on
// the call), and a TUI that is detaching answers `0`. Every one is a NON-ANSWER: the panel draws
// its own box. A throw here is the one failure mode a status line cannot have — it is the surface
// the operator reads a pack load on.
const FALLBACK_BOX = { rows: PANEL_FALLBACK_ROWS, columns: PANEL_FALLBACK_COLUMNS };

test("terminalSize: every shape the host answers when it has no terminal gets the fallback box", () => {
	const shapes = [
		["no terminal member", {}],
		["the loading-phase stub (undefined members)", { terminal: undefined }],
		["a detaching TUI (zeroes)", { terminal: { rows: 0, columns: 0 } }],
		["a stub answering null", { terminal: { rows: null, columns: null } }],
		["text where numbers belong", { terminal: { rows: "40", columns: "120" } }],
		["NaN", { terminal: { rows: NaN, columns: NaN } }],
		["negative", { terminal: { rows: -24, columns: -1 } }],
	];
	for (const [name, t] of shapes) assert.deepEqual(terminalSize(t), FALLBACK_BOX, `${name} must draw the panel's own box, never a 0-row panel`);
	assert.deepEqual(terminalSize(undefined), FALLBACK_BOX, "no TUI at all is the same non-answer");
	assert.deepEqual(terminalSize({ terminal: { rows: 45.7, columns: 150 } }), { rows: 45, columns: 150 }, "a real size passes through, floored");
});

test("terminalSize: a proxy that THROWS on the terminal read is a non-answer, not a crash", () => {
	// The same shape `src/index.ts` guards for the host's loading-phase action methods: a property
	// GET that throws. The panel reads the size inside a host render pass, where the throw becomes
	// a dead screen.
	const hostile = {
		get terminal() {
			throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
		},
		requestRender() {},
	};
	assert.deepEqual(terminalSize(hostile), FALLBACK_BOX, "the getter throw answers the fallback, and the screen paints");
});

for (const [name, tui] of [
	["a TUI with no terminal member", { requestRender() {} }],
	["a TUI whose terminal getter throws", { get terminal() { throw new Error("not initialized"); }, requestRender() {} }],
]) {
	test(`the component renders on ${name} — a sizeless TUI never produces an extension-render-failed frame`, () => {
		const c = new PanelComponent(data(), async () => data(), undefined, tui, () => undefined, 60000);
		const lines = c.render(200);
		assert.ok(lines.length > 0 && lines.length <= PANEL_FALLBACK_ROWS - 2, `the frame is bounded by the fallback height: ${lines.length} rows`);
		for (const l of lines) assert.ok(visibleWidth(l) <= PANEL_FALLBACK_COLUMNS, `the width is clamped to the fallback columns: ${visibleWidth(l)}`);
		assert.ok(lines.some((l) => l.includes("fade-orchestrator 20300101T113829Z-gbut")), "the screen paints the run, not an error frame");
		// The keys go through the same height read, so they must survive the shape too.
		c.handleInput("j");
		c.handleInput("\x1b[6~");
		c.handleInput("G");
		assert.ok(c.render(200).length > 0, "scrolling on a sizeless TUI still answers a frame");
		c.dispose();
	});
}

// ── the holding page: a pack load is 13-25 s, and this is the screen that reads it ──────────
test("the header paints the switch as a HOLDING PAGE while a pack loads", () => {
	const d = data({ swap: { from: "deepseek", to: "flash-next", percent: 47 } });
	const s = joined(panelLines(d, 120, { sel: 0 }));
	assert.ok(s.includes("switching deepseek → flash-next 47%"), s.slice(0, 700));
	assert.ok(s.includes("HOLDING PAGE"), "the row says the numbers under it are the last measured, not live");
	// A screen that advertises a swap that already landed is a lie, so the row is load-scoped.
	assert.ok(!joined(panelLines(data(), 120, { sel: 0 })).includes("HOLDING PAGE"), "no load in flight, no switch row");
	const noPercent = joined(panelLines(data({ swap: { from: "deepseek", to: "flash-next" } }), 120, { sel: 0 }));
	assert.ok(noPercent.includes("switching deepseek → flash-next —") && !noPercent.includes("null%"), "a router that reports no percent prints no percent, never a null");
});

test("openPanel: a first read that does not answer mounts the HOLDING PAGE, not a warning", async () => {
	// The chord pressed at a phase boundary is the keystroke that matters, and the panel's first
	// read IS the router: mid-swap the process is being replaced, and the two ledgers are appending.
	// The fuse (`FADE_ORCHESTRATE_PANEL_FIRST_MS`) ends the wait; `holding` is the wiring's cheap
	// read — the run's state, the cached metrics, the swap pill, empty ledgers.
	const notes = [];
	const calls = [];
	const ctx = {
		hasUI: false,
		ui: {
			setWidget: (key, lines, opts) => calls.push({ key, lines, opts }),
			notify: (m) => notes.push(m),
			custom: async () => {
				throw new Error("headless must not open an overlay");
			},
		},
	};
	const prev = process.env.FADE_ORCHESTRATE_PANEL_FIRST_MS;
	process.env.FADE_ORCHESTRATE_PANEL_FIRST_MS = "20";
	try {
		await openPanel(
			ctx,
			() => new Promise((res) => setTimeout(() => res(data()), 5000)),
			undefined,
			true,
			() => data({ swap: { from: "deepseek", to: "flash-next", percent: 12 }, swaps: [], turns: [] }),
		);
	} finally {
		if (prev === undefined) delete process.env.FADE_ORCHESTRATE_PANEL_FIRST_MS;
		else process.env.FADE_ORCHESTRATE_PANEL_FIRST_MS = prev;
	}
	assert.equal(calls.length, 1, "a slow router is a page, never a warning-only keystroke");
	const s = calls[0].lines.join("\n");
	assert.ok(s.includes("switching deepseek → flash-next 12%"), s.slice(0, 700));
	assert.ok(s.includes("the live read did not answer in 0.02s"), "the page names its own staleness and the fuse that ended the wait");
	assert.ok(s.includes("no swaps recorded"), "the empty ledgers are NAMED, never printed as a zero");
	assert.equal(notes.length, 0, `no refusal when a page exists: ${notes.join(" | ")}`);
});

test("openPanel: with no page in hand, the refusal stays named", async () => {
	const notes = [];
	const calls = [];
	const ctx = {
		hasUI: false,
		ui: {
			setWidget: (key, lines) => calls.push(lines),
			notify: (m) => notes.push(m),
			custom: async () => undefined,
		},
	};
	const prev = process.env.FADE_ORCHESTRATE_PANEL_FIRST_MS;
	process.env.FADE_ORCHESTRATE_PANEL_FIRST_MS = "20";
	try {
		await openPanel(ctx, () => new Promise(() => undefined), undefined, true);
	} finally {
		if (prev === undefined) delete process.env.FADE_ORCHESTRATE_PANEL_FIRST_MS;
		else process.env.FADE_ORCHESTRATE_PANEL_FIRST_MS = prev;
	}
	assert.equal(calls.length, 0, "nothing to show, nothing painted");
	assert.ok(notes.some((n) => n.includes("the screen did not open")), `the refusal is named: ${notes.join(" | ")}`);
});
