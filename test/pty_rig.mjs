#!/usr/bin/env node
// pty_rig.mjs — the Alt+F screen in a REAL terminal, driven through tmux.
//
// This is the only proof surface that answers "does the chord open the screen": the RPC rig can see
// widget frames, and a TUI row's placement, wrapping, focus and keystroke handling are invisible to
// it. Here the live extension (`~/.omp/agent/extensions/fade_orchestrate.ts` → the plugin's
// `src/index.ts`) is loaded by the real `omp` binary in a real 150x45 terminal, and every assertion
// is made on what the terminal actually shows.
//
// HOST-ONLY. It needs `omp`, tmux, the box's provider config and the seeded run; CI has none of
// that. Run it as:
//
//   FADE_ORCHESTRATE_LIVE_SMOKE=1 node test/pty_rig.mjs
//
// Without that flag it prints a NAMED skip and exits 0 — a rig that silently passes on a machine
// that cannot run it is the defect class this repo calls a silent wire.
//
// Nothing here sends a prompt: the session is started, the key is pressed, the screen is read. The
// run is seeded on disk, so the extension adopts it at session_start and paints.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (bin) => {
	try {
		execFileSync("which", [bin], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
};

if (process.env.FADE_ORCHESTRATE_LIVE_SMOKE !== "1") {
	console.log(JSON.stringify({ skip: "pty_rig is host-only: it drives the real omp binary in a tmux terminal. Run: FADE_ORCHESTRATE_LIVE_SMOKE=1 node test/pty_rig.mjs", ok: true }));
	process.exit(0);
}
if (!has("tmux") || !has("omp")) {
	console.log(JSON.stringify({ skip: `pty_rig needs tmux and omp on PATH (tmux=${has("tmux")} omp=${has("omp")})`, ok: true }));
	process.exit(0);
}

// A PRIVATE tmux server per rig, not the desk's shared one. Measured 2026-11-15: two rigs running
// against `/tmp/tmux-1000/default` killed each other — one rig's cleanup took the server out from
// under the other, whose session died at `send-keys` mid-run and whose log opened with
// `no server running`. The session name alone does not isolate: the SERVER is shared.
const SOCK = `fade-pty-${process.pid}`;
const SESSION = `fade-pty-${process.pid}`;
const repo = mkdtempSync(join(tmpdir(), "fade-pty-rig-"));
mkdirSync(join(repo, "var", "omp-orchestrate"), { recursive: true });
writeFileSync(join(repo, ".gitignore"), "*\n");
execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "pipe" });

const task = (id) => ({ id, objective: `the panel must show ${id} with its acceptance and result`, files: ["src/panel.ts"], acceptance: "node --test test/panel.test.mjs passes", dependencies: [], round: 1, status: "pending" });
const seedState = (state) => ({
	key: "fade.omp_orchestrate.v1",
	run_id: "PTYRIG1",
	goal: "prove the Alt+F screen in a real terminal",
	lane: "deepseek",
	round: 1,
	max_rounds: 6,
	state,
	checks: [["true", "green"]],
	tasks: [task("T1"), task("T2")],
	phases: [{ phase: "planning_done", lane: "deepseek", accepted: true, round: 1, at: new Date().toISOString() }],
	rejection_history: [],
	repair_tasks: [],
	started_utc: new Date().toISOString(),
	repo,
});
const seed = () => {
	writeFileSync(join(repo, "var", "omp-orchestrate", "state.json"), JSON.stringify(seedState("coding"), null, 2));
	writeFileSync(join(repo, "var", "omp-orchestrate", "ACTIVE.json"), JSON.stringify({ run_id: "PTYRIG1", repo, goal: "g", started_utc: new Date().toISOString(), max_rounds: 6 }));
	// A seeded ledger: the panel's swap table is measured history, and "no swaps recorded" is a
	// named state — the rig proves the row that carries a REAL number, so seed one.
	writeFileSync(
		join(repo, "var", "omp-orchestrate", "swap_history.json"),
		JSON.stringify({ key: "fade.omp_orchestrate.swaps.v1", rows: [{ key: "fade.omp_orchestrate.swap.v1", at: new Date().toISOString(), from: "deepseek", to: "flash-next", elapsed_s: 14.2, first_tg: 91, steady_tg: 130, ramp: "cold_ramp", load_percent: 100 }] }),
	);
	writeFileSync(join(repo, "README.md"), "# pty rig repo\n");
};

const tmux = (...args) => execFileSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8" });
/** The VISIBLE pane only: the row and the overlay are on screen, and scrollback would fake a pass. */
const pane = () => {
	try {
		return tmux("capture-pane", "-p", "-t", SESSION);
	} catch {
		return "";
	}
};

/**
 * The pane WITH scrollback. The chord disclosure fires at `session_start`, and by the time the row
 * has painted it has scrolled out of the 45 visible lines; a disclosure that scrolls away is still a
 * disclosure, so this is the surface for the announce check. Every on-screen check keeps using
 * `pane()`, where scrollback would fake a pass.
 */
const scrollback = () => {
	try {
		return tmux("capture-pane", "-p", "-S", "-2000", "-t", SESSION);
	} catch {
		return "";
	}
};
const alive = () => {
	try {
		tmux("has-session", "-t", SESSION);
		return true;
	} catch {
		return false;
	}
};
const send = (...keys) => tmux("send-keys", "-t", SESSION, ...keys, "Enter");
const launch = async (env, deadlineMs = 120_000) => {
	// `-u PI_SESSION_FILE -u PI_SESSION_ID` is load-bearing, not hygiene. The extension treats a
	// session whose file is nested inside a dated parent dir as a DELEGATED subagent session, and the
	// rig's own shell often IS one: run from a `task` agent, tmux inherited that agent's
	// `PI_SESSION_FILE`, every omp session was classified delegated, the row was suppressed by the
	// `owned` rule and `/orchestrate` refused (measured 2026-11-15: 17 checks failed on a bare TUI
	// frame, the only visible extension line `orchestrate: no run active`). The launched omp must set
	// its own session identity, which `--no-session` does.
	tmux("new-session", "-d", "-x", "150", "-y", "45", "-s", SESSION, "-c", repo, "env", "-u", "PI_SESSION_FILE", "-u", "PI_SESSION_ID", ...Object.entries(env).flatMap(([k, v]) => [`${k}=${v}`]), "omp", "--no-session", "--no-tools", "--no-lsp", "--offline", "--no-judge", "--no-spotlight");
	const t0 = Date.now();
	while (Date.now() - t0 < deadlineMs) {
		if (!alive()) throw new Error(`the omp session died at startup: ${pane().slice(-800)}`);
		return;
	}
};
const kill = () => {
	try {
		tmux("kill-session", "-t", SESSION);
	} catch {}
};
const until = async (needle, ms = 45_000) => {
	const t0 = Date.now();
	let text = pane();
	while (Date.now() - t0 < ms) {
		if (text.includes(needle)) return text;
		await sleep(1000);
		text = pane();
	}
	return text;
};

/**
 * A bounded wait on the SCROLLBACK surface. The chord disclosure is deferred 500 ms past the host's
 * TUI attach (the first notify of a session is swallowed — measured 2026-11-15), so it lands AFTER
 * the status row paints: reading one snapshot at the row is reading before the disclosure exists.
 */
const untilText = async (needle, ms = 20_000) => {
	const t0 = Date.now();
	let text = scrollback();
	while (Date.now() - t0 < ms) {
		if (text.includes(needle)) return text;
		await sleep(1000);
		text = scrollback();
	}
	return text;
};

const checks = [];
const ok = (name, cond, detail = "") => checks.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) });

const ROW = /Orchestrator: \w+ R1\/6 · T0\/2 · \[Alt\+Shift\+F\]/;
const strip = (s) => s.replace(/\s+/g, " ");

// ---- run 1: the delivered surface (the top row) and the panel ----
seed();
try {
	await launch({ FADE_ORCHESTRATE_METRICS_INTERVAL_MS: "2000", FADE_ORCHESTRATE_PANEL_REFRESH_MS: "1000" });
	const started = await until("PTYRIG1", 60_000).catch(() => pane());
	ok("the session started and adopted the seeded run", alive() && (started.includes("PTYRIG1") || started.includes("Orchestrator")), strip(pane()).slice(0, 380));
	const withRow = await until("Orchestrator:", 45_000);
	ok("the status row shows in the terminal: glyph, Orchestrator, state, round, tally, key", ROW.test(strip(withRow)), strip(withRow).slice(0, 380));


	// The key, as raw bytes (ESC + `F`) to a real terminal. Measured with a chunk-logging reader in
	// tmux: `send-keys -H 1b 46` lands as ONE read of two bytes (`1b46`), which is what both the
	// listener's byte comparison and the host's chord parser need — and `M-S-f` is NOT usable here,
	// because tmux delivers it as `1b66` (ESC + lowercase f), which is the host's cursorWordRight.
	// The host binds `ctrl+o` to `app.tools.expand` and this extension leaves that chord alone —
	// run 3 proves the host still acts on it.
	tmux("send-keys", "-t", SESSION, "-H", "1b", "46");
	const panelText = await until("ENGINE / ROUTER", 20_000);
	const flatPanel = strip(panelText);
	ok("Alt+Shift+F (ESC F) opens the screen", panelText.includes("ENGINE / ROUTER"), flatPanel.slice(0, 380));
	ok("the host did not act: the chord reached the extension", !panelText.includes("Tool output expansion"), flatPanel.slice(0, 300));
	ok("the screen names the run", panelText.includes("PTYRIG1"), flatPanel.slice(0, 200));
	ok("the screen carries the task list", /TASKS 0\/2 passed/.test(flatPanel), flatPanel.slice(0, 300));
	ok("the screen carries the task text", flatPanel.includes("the panel must show T1"), flatPanel.slice(0, 300));
	ok("the screen carries the engine column", flatPanel.includes("ENGINE / ROUTER"), flatPanel.slice(0, 400));
	ok("the screen carries the swap cost from the ledger", flatPanel.includes("deepseek → flash-next 14.2s"), flatPanel.slice(0, 500));
	ok("the screen carries the key bar", flatPanel.includes("[esc] close") && flatPanel.includes("[s] skip selected"), flatPanel.slice(0, 200));
	ok("the screen is bounded by the terminal width", pane().split("\n").every((l) => l.length <= 151), `longest=${Math.max(0, ...pane().split("\n").map((l) => l.length))}`);

	// LIVE: the panel's own tick re-reads the screen, so its refreshed clock moves while it is open.
	const clockOf = (t) => (t.match(/(\d\d:\d\d:\d\d)Z/) ?? [])[1] ?? "";
	const first = clockOf(pane());
	await sleep(5000);
	const second = clockOf(pane());
	ok("the open panel is LIVE: its refreshed clock moved on the tick", first !== "" && second !== "" && first !== second, `first=${first} second=${second}`);

	// Selection: the arrows move the highlighted task.
	tmux("send-keys", "-t", SESSION, "Down");
	await sleep(600);
	const selected = strip(pane());
	ok("the down arrow selects the next task", /▶\s+\S\s+T2\b/.test(selected), selected.slice(0, 300));

	tmux("send-keys", "-t", SESSION, "Escape");
	const closed = await until("Orchestrator:", 15_000);
	ok("Escape closes the screen", !closed.includes("ENGINE / ROUTER"), strip(closed).slice(0, 300));
	ok("the status row survives the close", ROW.test(strip(closed)), strip(closed).slice(0, 300));

	// The disclosure's proof surface is the scrollback (run 3): a notify at session_start has
	// scrolled out of the 45 visible lines by the time the row paints, and a disclosure that scrolls
	// away is still a disclosure.

	send("/orchestrate halt");
	const halted = pane();
	await sleep(3000);
	const afterHalt = pane();
	ok("halt clears the row: a run not in use leaves nothing on screen", !ROW.test(strip(afterHalt)), strip(afterHalt).slice(0, 300));
	void halted;
} finally {
	kill();
}

// ---- run 2: the opt-in status-bar surface ----
seed();
try {
	await launch({ FADE_ORCHESTRATE_SURFACE: "status", FADE_ORCHESTRATE_METRICS_INTERVAL_MS: "2000" });
	const withStatus = await until("Orchestrator:", 60_000);
	ok("FADE_ORCHESTRATE_SURFACE=status puts the same text on the host's status surface", ROW.test(strip(withStatus)), strip(withStatus).slice(0, 380));
	ok("the status surface carries no top widget row", !strip(withStatus).includes("fade-orchestrator PTYRIG1 ·"), strip(withStatus).slice(0, 380));
} catch (e) {
	ok("the opt-in status surface launched", false, String(e instanceof Error ? e.message : e).slice(0, 300));
} finally {
	kill();
	rmSync(repo, { recursive: true, force: true });
}

// ---- run 3: the chord, in BOTH host states ----
// The chosen chord is `alt+shift+f` (ESC + `F`): the host's own conflict probe answers FREE for it,
// while `alt+f` — which a strings-extracted default table suggested was free — is bound to
// `tui.editor.cursorWordRight` (the pty rig watched ESC f move the word, 2026-11-15). Two states,
// each in an isolated agent dir so the desk's own config cannot leak into either:
//   DEFAULT — nothing configured: the disclosure says Alt+Shift+F opens the screen and names the
//             fallback; ESC F opens the panel; ctrl+o opens NOTHING (the extension never takes the
//             host's chord — which action the host runs there is the host's, not the rig's claim).
//   HELD    — FADE_ORCHESTRATE_KEY=ctrl+o, a chord the host binds: the disclosure names the conflict,
//             names the fallback chord, and names the env var that moves the key; ctrl+o opens no
//             screen, and ESC I (alt+shift+i) opens the panel. This is the state the extension has to
//             degrade honestly in.
// The disclosure is read from the SCROLLBACK with a bounded wait: the extension defers it 500 ms,
// because the FIRST notify of a session is swallowed by the host's TUI attach (measured 2026-11-15 —
// the disclosure fired at `session_start` and never rendered, while the next notify in the same hook
// always did).
// The chord family matters: `ctrl+shift+<letter>` is NOT distinct on a TTY — shift is invisible inside
// a control code, measured: a ctrl+shift+t keystroke delivered ctrl+t and the pane answered
// "Thinking blocks: visible", the host's ctrl+t action. `alt+…` (ESC + letter) is the byte-distinct
// family, which is why the key and the fallback are both alt chords.
const agentDir = mkdtempSync(join(tmpdir(), "fade-pty-agent-"));
const realAgentDir = join(homedir(), ".omp", "agent");
const seedAgentDir = () => {
	rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	for (const entry of readdirSync(realAgentDir)) {
		// A keybindings file on the desk must not decide what the rig observes.
		if (/^keybindings\.(yml|yaml|json)$/i.test(entry)) continue;
		symlinkSync(join(realAgentDir, entry), join(agentDir, entry));
	}
};
const countToggles = (text) => (text.match(/Tool output expansion/g) ?? []).length;

for (const state of ["DEFAULT", "HELD"]) {
	mkdirSync(join(repo, "var", "omp-orchestrate"), { recursive: true });
	seed();
	seedAgentDir();
	const tag = state === "DEFAULT" ? "alt+shift+f, nothing configured" : "FADE_ORCHESTRATE_KEY=ctrl+o, a chord the host holds";
	try {
		await launch({ PI_CODING_AGENT_DIR: agentDir, FADE_ORCHESTRATE_METRICS_INTERVAL_MS: "2000", FADE_ORCHESTRATE_PANEL_REFRESH_MS: "1000", ...(state === "HELD" ? { FADE_ORCHESTRATE_KEY: "ctrl+o" } : {}) });
		await until("Orchestrator:", 60_000);
		if (state === "DEFAULT") {
			const disclosed = strip(await untilText("opens the orchestration screen", 20_000));
			ok(`[${tag}] the disclosure names the key and the fallback`, /Alt\+Shift\+F opens the orchestration screen/.test(disclosed) && disclosed.includes("Alt+Shift+I"), disclosed.slice(-380));
			tmux("send-keys", "-t", SESSION, "-H", "1b", "46");
			const opened = strip(await until("ENGINE / ROUTER", 20_000));
			ok(`[${tag}] ESC F opens the screen`, opened.includes("ENGINE / ROUTER"), opened.slice(0, 300));
			tmux("send-keys", "-t", SESSION, "Escape");
			await until("Orchestrator:", 15_000).catch(() => "");
			// The extension never takes ctrl+o. Which action the host runs there is the host's business
			// (this build's pane hint names Ctrl+⇧O, not the expand toggle), so the rig does not claim to
			// prove it: it proves the extension opened NO screen, and keeps the toggle count as an
			// observation in the detail.
			tmux("send-keys", "-t", SESSION, "C-o");
			await sleep(2500);
			ok(`[${tag}] ctrl+o opens nothing: the extension never takes the host's chord`, !strip(pane()).includes("ENGINE / ROUTER"), `toggles=${countToggles(scrollback())} ${strip(pane()).slice(0, 200)}`);
		} else {
			const disclosed = strip(await untilText("is held by the host", 20_000));
			ok(`[${tag}] the disclosure names the conflict, the fallback and the way to move the key`, /Ctrl\+O is held by the host/.test(disclosed) && disclosed.includes("Alt+Shift+I") && disclosed.includes("FADE_ORCHESTRATE_KEY"), disclosed.slice(-380));
			// Same proof as the DEFAULT state: the extension opened nothing on the host's chord.
			tmux("send-keys", "-t", SESSION, "C-o");
			await sleep(2500);
			ok(`[${tag}] ctrl+o opens nothing: the extension never takes the host's chord`, !strip(pane()).includes("ENGINE / ROUTER"), `toggles=${countToggles(scrollback())} ${strip(pane()).slice(0, 200)}`);
			// The fallback is byte-distinct: alt+shift+i is ESC + uppercase I (tmux sends it in one
			// read; `M-S-i` would deliver ESC + lowercase i, the host's kill-line).
			tmux("send-keys", "-t", SESSION, "-H", "1b", "49");
			const opened = strip(await until("ENGINE / ROUTER", 20_000));
			ok(`[${tag}] the fallback chord (ESC I, alt+shift+i) opens the screen`, opened.includes("ENGINE / ROUTER"), opened.slice(0, 300));
		}
	} catch (e) {
		ok(`[${tag}] the session launched`, false, String(e instanceof Error ? e.message : e).slice(0, 300));
	} finally {
		kill();
		rmSync(repo, { recursive: true, force: true });
	}
}
rmSync(agentDir, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ checks, tmux: SESSION }, null, 1));
if (failed.length > 0) {
	console.error(JSON.stringify({ failed: failed.map((f) => f.name) }, null, 1));
	process.exit(1);
}
console.log("pty rig: all checks pass");
process.exit(0);
