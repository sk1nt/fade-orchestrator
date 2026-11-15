#!/usr/bin/env node
// ui_status.test.mjs — the status row's contract, in the operator's own words (2026-11-15:
// "if it can't go on that line, then leave it on top, but use a nerdfont or something and just say
// Orchestrator: plan R1/6 T0/0 etc..."). One line, docked above the editor, carrying the state, the
// round budget, the task tally and the panel key; the host's own model segment carries the model.
// The row is the ONLY surface the loop paints, and `chordBytes` is what makes the panel's chord
// deliverable: the listener consumes the keystroke, so the row and the key can never disagree.
import os from "node:os";
import assert from "node:assert/strict";
import test from "node:test";
import { chordBytes, keyLabel, laneTag, modelLabel, ORCH_STATUS_KEY, orchGlyph, shortState, statusLines, TOP_WIDGET_KEY } from "../.test-build/ui.mjs";

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

/** Set the glyph for one call, restore the ambient value after — the tests share `process.env`. */
const withGlyph = (value, fn) => {
	const prev = process.env.FADE_ORCHESTRATE_GLYPH;
	if (value === undefined) delete process.env.FADE_ORCHESTRATE_GLYPH;
	else process.env.FADE_ORCHESTRATE_GLYPH = value;
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env.FADE_ORCHESTRATE_GLYPH;
		else process.env.FADE_ORCHESTRATE_GLYPH = prev;
	}
};

// ---- the operator's line ----

test("statusLines: an empty planning run reads exactly the operator's line", () => {
	const lines = statusLines(run({ state: "planning", tasks: [] }));
	assert.deepEqual(lines, ["󰚩 Orchestrator: plan R1/6 · T0/0 · [Alt+Shift+F]"]);
});

test("statusLines: the state, the round budget and the task tally all ride", () => {
	assert.deepEqual(statusLines(run()), ["󰚩 Orchestrator: code R1/6 · T2/3 · [Alt+Shift+F]"]);
	assert.deepEqual(statusLines(run({ state: "verifying", round: 4, max_rounds: 6 })), ["󰚩 Orchestrator: ver R4/6 · T2/3 · [Alt+Shift+F]"]);
	assert.deepEqual(statusLines(run({ state: "repair", lane: "deepseek" })), ["󰚩 Orchestrator: fix R1/6 · T2/3 · [Alt+Shift+F]"]);
});

test("statusLines: the glyph is a Nerd Font codepoint and is overridable for a terminal without one", () => {
	assert.equal(withGlyph(undefined, orchGlyph), "󰚩");
	assert.deepEqual(withGlyph("⚡", () => statusLines(run({ tasks: [], state: "planning" }))), ["⚡ Orchestrator: plan R1/6 · T0/0 · [Alt+Shift+F]"]);
	// An empty glyph drops the glyph AND its space: the line still starts on the word.
	assert.deepEqual(withGlyph("", () => statusLines(run({ tasks: [], state: "planning" }))), ["Orchestrator: plan R1/6 · T0/0 · [Alt+Shift+F]"]);
});

test("statusLines: the Tier-1 protocol badge rides only while the stall counter runs", () => {
	assert.deepEqual(statusLines(run({ stall_count: 1 })), ["󰚩 Orchestrator: code R1/6 · T2/3 · [Alt+Shift+F] · protocol 1/3"]);
	assert.deepEqual(statusLines(run({ stall_count: 3 })), ["󰚩 Orchestrator: code R1/6 · T2/3 · [Alt+Shift+F] · protocol 3/3"]);
	assert.ok(!statusLines(run({ stall_count: 0 }))[0].includes("protocol"), "a clean run must not advertise a stall");
});

test("statusLines: a paused run says so, so a parked loop is never read as a hung one", () => {
	assert.deepEqual(statusLines(run({ paused: true })), ["󰚩 Orchestrator: code R1/6 · T2/3 · [Alt+Shift+F] · paused"]);
});

test("statusLines: the measured decode suffix rides last", () => {
	assert.deepEqual(statusLines(run({ tasks: [], state: "planning" }), { suffix: "hot 130t/s" }), ["󰚩 Orchestrator: plan R1/6 · T0/0 · [Alt+Shift+F] · hot 130t/s"]);
});

test("statusLines: the flip guard adds a second line naming the competing entries; a quiet router adds none", () => {
	const flip = { flips: 3, window_s: 120, competing: ["flash-next-ablit"] };
	const lines = statusLines(run(), { flip });
	assert.equal(lines.length, 2, JSON.stringify(lines));
	assert.ok(lines[1].includes("lane flip: 3 swaps in 120s"), lines[1]);
	assert.ok(lines[1].includes("flash-next-ablit"), "the competing entry is named");
	assert.equal(statusLines(run(), { flip: { flips: 0, window_s: 120, competing: [] } }).length, 1, "a quiet router never advertises a flip");
});

test("statusLines: a run not in use answers undefined — no run, terminal, and a run this session does not own", () => {
	assert.equal(statusLines(undefined), undefined);
	for (const state of ["complete", "failed", "stopped"]) {
		assert.equal(statusLines(run({ state })), undefined, `${state} is terminal: it never advertises`);
	}
	// A protocol stall is NOT terminal: the circuit breaker is the operator's to see.
	assert.ok(statusLines(run({ state: "stalled_protocol_error", stall_count: 3 }))[0].includes("stall"));
	assert.equal(statusLines(run(), { owned: false }), undefined, "a delegated worker session paints nothing");
});

// ---- the chord bytes, and why the panel's key is `alt+shift+f` ----
//
// Every claim here is measured, not read off a table:
//  - `ctrl+shift+<letter>` is NOT a distinct keystroke on a TTY (shift is invisible inside a control
//    code): a ctrl+shift+t keystroke arrived as ctrl+t and ran the host's ctrl+t action (the pty rig,
//    pane printed "Thinking blocks: visible").
//  - `alt+f` LOOKS free in the strings-extracted default table and is NOT: the host's own
//    `getShortcutConflict` answers `keybinding tui.editor.cursorWordRight` for it (rpc probe,
//    2026-11-15), and the pty rig watched ESC f move the word instead of opening a panel.
//  - `alt+shift+f` (ESC + `F`) answers FREE, and that is the panel's key; `alt+shift+i` the fallback.
test("chordBytes: the byte the listener consumes, and the family that has none", () => {
	assert.equal(chordBytes("ctrl+o"), "\x0f");
	assert.equal(chordBytes("CTRL+G"), "\x07", "case-insensitive, like the host's own chord table");
	assert.equal(chordBytes("  ctrl+a  "), "\x01");
	assert.equal(chordBytes("alt+f"), "\x1bf", "ESC + letter — bound to the host's cursorWordRight, so never the panel's key");
	assert.equal(chordBytes("alt+shift+f"), "\x1bF", "the panel's key: ESC + uppercase, distinct from alt+f");
	assert.equal(chordBytes("ALT+SHIFT+I"), "\x1bI", "the fallback: ESC + uppercase I, measured FREE");
	assert.equal(chordBytes("ctrl+shift+o"), undefined, "no byte form: on a TTY it IS ctrl+o, so it is never claimed as distinct");
	assert.equal(chordBytes("ctrl+1"), undefined);
	assert.equal(chordBytes("f1"), undefined);
});

test("keyLabel: the row names the chord the way a keycap does", () => {
	assert.equal(keyLabel("alt+shift+f"), "Alt+Shift+F");
	assert.equal(keyLabel("alt+f"), "Alt+F");
	assert.equal(keyLabel("ctrl+o"), "Ctrl+O");
	assert.equal(keyLabel("alt+shift+i"), "Alt+Shift+I");
});

test("statusLines: the key hint is the configured chord's label, never a literal", () => {
	assert.deepEqual(statusLines(run({ tasks: [], state: "planning" }), { key: "Alt+Shift+F" }), ["󰚩 Orchestrator: plan R1/6 · T0/0 · [Alt+Shift+F]"]);
	assert.deepEqual(statusLines(run({ tasks: [], state: "planning" }), { key: "Alt+Shift+I" }), ["󰚩 Orchestrator: plan R1/6 · T0/0 · [Alt+Shift+I]"], "the HELD state passes the fallback chord: the row names the chord that OPENS the screen, and the pty rig proved the old row advertising `[Ctrl+O]` in exactly that state while its own assertion read \"ctrl+o opens nothing\"");
	assert.deepEqual(statusLines(run({ tasks: [], state: "planning" })), ["󰚩 Orchestrator: plan R1/6 · T0/0 · [Alt+Shift+F]"], "the default is the delivered chord — `Ctrl+O` is the chord the host holds and this extension never binds, so defaulting to it would advertise a dead key");
});

test("statusLines: a disk state with no `tasks` renders T0/0 — the row is painted on every tick", () => {
	// The crash class the rpc rig measured for the panel (a state with no `phases`, then no
	// `repair_tasks`): a JSON file is not the type. The row runs inside a host callback on every
	// metrics tick, so an absent array must read as an empty plan, never as a throw.
	assert.deepEqual(statusLines({ state: "coding", round: 1, max_rounds: 6 }), ["󰚩 Orchestrator: code R1/6 · T0/0 · [Alt+Shift+F]"]);
});

// ---- the short labels the panel's rows use ----

test("shortState: the ≤5-character state, and an unknown state passes through unmasked", () => {
	assert.equal(shortState("planning"), "plan");
	assert.equal(shortState("stalled_protocol_error"), "stall");
	assert.equal(shortState("unknown_future_state"), "unknown_future_state");
});

test("laneTag: the 2-character form for a compact row", () => {
	assert.equal(laneTag("flash-next"), "fn");
	assert.equal(laneTag("deepseek"), "de");
	assert.equal(laneTag("flash-next-ablit"), "fn");
	assert.equal(laneTag("phi"), "phi");
});

test("modelLabel: the registry names compact to the operator's abbreviated form", () => {
	// The exact form the operator ordered 2026-11-15: quant + GPU count, nothing else.
	assert.equal(modelLabel("deepseek (DeepSeek-V4.1-Flash IQ1_M, dual RTX 5090, RAM+SSD expert tier)"), "deepseek (IQ1_M, dual)");
	assert.equal(modelLabel("deepseek (Basalt DeepSeek-V4.1-Flash UD-IQ1_M, dual RTX 5090, 122 GiB RAM SSD tier)"), "deepseek (IQ1_M, dual)");
	assert.equal(modelLabel("flash-next (Swift Flash Next IQ3_S, dual RTX 5090)"), "flash-next (IQ3_S, dual)");
});

test("modelLabel: a name with no quant/GPU count passes its base segment through", () => {
	assert.equal(modelLabel("gpt-5.2"), "gpt-5.2");
	assert.equal(modelLabel("mystery"), "mystery");
});

// ---- the two faces of the row: steady is plain, switching is multicolored ----

test("the steady row names NO model and carries no escape codes (the model is named once, on the panel)", () => {
	const line = statusLines(run({ lane: "flash-next" }))[0];
	assert.ok(!/flash-next|deepseek/.test(line), `the steady row named a model: ${line}`);
	assert.ok(!line.includes("\x1b"), "a steady row is plain text: the color means working");
});

test("the switching row is multicolored, and the incoming model is named exactly once", () => {
	const lines = statusLines(run({ lane: "deepseek" }), { swap: { from: "deepseek", to: "flash-next (IQ3_S, dual)", percent: 47 } });
	const raw = lines[0];
	const plain = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
	assert.equal(plain, "󰚩 Orchestrator: switching deepseek→flash-next (IQ3_S, dual) 47% · [Alt+Shift+F]");
	const colors = raw.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? [];
	assert.ok(colors.length >= 20, `the row is not multicolored (${colors.length} color runs)`);
	assert.equal(plain.match(/flash-next/g).length, 1, "the model name rides once");
	// The percent drives the ramp's phase, so each sample repaints a different row.
	const later = statusLines(run({ lane: "deepseek" }), { swap: { from: "deepseek", to: "flash-next (IQ3_S, dual)", percent: 82 } })[0];
	assert.notEqual(later.match(/\x1b\[38;2;\d+;\d+;\d+m/)[0], raw.match(/\x1b\[38;2;\d+;\d+;\d+m/)[0], "the ramp phase moves with the percent");
});

// ---- the widget keys ----

test("the surface keys: the top dock and the opt-in status-bar key", () => {
	assert.equal(TOP_WIDGET_KEY, "fade-top");
	assert.equal(ORCH_STATUS_KEY, "fade-orch");
});

// ---- redaction: the row is screenshot-safe ----

// Y19 `--demo-redact`: a screenshot of the bar must show no username, no home path, no hostname
// and no repo path. FADE_ORCHESTRATE_REDACT=1 is a DISPLAY concern, applied only at the render
// boundary; the durable record — state.json, metrics.jsonl, swap_history.json — is written by other
// modules and stays verbatim, which is why the flag-off case below demands byte-identical output.
// The identity the redactor must erase is the MACHINE's, never a literal: a hardcoded account made
// these tests red on GitHub Actions (the runner's account is not the developer's).
const USER = process.env.USER && process.env.USER.length > 1 ? process.env.USER : safeUsername();
const HOME = `/home/${USER}`; // the shape of the HOME_PATH rule (`/home/<account>`), any OS
const REPO = `${HOME}/projects/fadetheworld`;
const HOST = os.hostname();

function safeUsername() {
	try {
		return os.userInfo().username;
	} catch {
		return "";
	}
}

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
	if (USER) assert.ok(!s.includes(USER), `the account must not survive: ${s}`);
	assert.ok(!s.includes("/home/"), `the /home/<account> form must not survive: ${s}`);
	assert.ok(!s.includes(REPO), `the repo path must not survive: ${s}`);
	if (HOST) assert.ok(!s.includes(HOST), `the hostname must not survive: ${s}`);
};

test("redact: the row is screenshot-safe with the flag on, state/round/tally intact", () => {
	const r = run({ lane: "deepseek", repo: REPO });
	const lines = withFlag("1", () => statusLines(r, { suffix: `130t/s · ${REPO} by ${USER} on ${HOST}` }));
	lines.forEach(assertNoIdentity);
	assert.equal(lines[0], "󰚩 Orchestrator: code R1/6 · T2/3 · [Alt+Shift+F] · 130t/s · <path> by <user> on <host>", "the round/task tally survives");
});

test("redact: off is the default, and the rendered bytes are today's, verbatim", () => {
	const r = run({ lane: "deepseek", repo: REPO, goal: `run in ${REPO} on ${HOST}` });
	const bare = statusLines(r, { suffix: `${REPO} on ${HOST}` })[0];
	assert.ok(bare.includes(`· ${REPO} on ${HOST}`), "off keeps the operator's own truth on screen");
	assert.equal(withFlag("0", () => statusLines(r, { suffix: `${REPO} on ${HOST}` })[0]), bare, "FADE_ORCHESTRATE_REDACT=0 is off: identical bytes");
	assert.equal(withFlag(undefined, () => statusLines(r, { suffix: `${REPO} on ${HOST}` })[0]), bare, "unset is off: identical bytes");
});
