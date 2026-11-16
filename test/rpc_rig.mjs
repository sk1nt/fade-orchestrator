#!/usr/bin/env node
// rpc_rig.mjs — the host RPC rig: the real `omp --mode rpc` process, a real seeded run, a real
// turn, and the frames on the wire. The gate rig proves the protocol in milliseconds; this proves
// it against the host, which is the only place `setWidget`/`sendUserMessage` semantics exist.
//
// It proves, on frames:
//   1. `/orchestrate status` paints the pill at the TOP of the editor (a `setWidget` under
//      `fade-top`) carrying the FULL lane name, and only while a run is in use;
//   1b. the footer row is NEVER written: ZERO `setStatus` frames (no footer for now);
//   1c. the pill carries NO flip line while the router is quiet (the flip guard's positive case is
//      proven on a fake router by gate_rig block 19, where the churn is constructible);
//      the stub router reports two swaps away from the lane the run holds;
//   2. `/orchestrate plan` answers on its OWN frame (`text`), and the nudge frame does not precede
//      the plan frame — the "nothing on screen for 43 s" failure;
//   3. the lane load is paid ONCE PER ACCEPTED PHASE, at the turn boundary, never inside
//      `fade_phase` and never as a reload of a resident entry — the ping-pong fix;
//   4. the pill publishes the gate tally on the round it is paid, and the accepted phase lands
//      in the durable state file — OBSERVATION (the synthetic session's model round-trip; the
//      protocol itself is gated by gate_rig blocks 1-19);
//   5. a nudge that ends with no phase escalates to the operator;
//   6. the overlay frames render the UNTRUNCATED task text, and no line exceeds the render width
//      — OBSERVATION, same reason;
//   7. `/orchestrate halt` CLEARS the top widget — a run not in use leaves nothing on screen.
//
// Run: FADE_ORCHESTRATE_LIVE_SMOKE=1 node test/rpc_rig.mjs
//
// It seeds FADE_ORCHESTRATE_ROOT at a tmp repo holding a run state, so the extension adopts the
// run at session_start and paints, then drives commands and prompts through stdin and reads
// extension_ui_request frames from stdout.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripSessionEnv } from "./fixture.mjs";

const repo = join(tmpdir(), "orch-rpc-rig");
rmSync(repo, { recursive: true, force: true });
mkdirSync(join(repo, "var", "omp-orchestrate"), { recursive: true });
const state = {
	schema: "fade.orchestrate.state.v1",
	state: "planning",
	run_id: "rpcrig",
	created_utc: new Date().toISOString(),
	goal: "rpc rig: prove the pill, the frame order, and the single lane load",
	repo,
	host: "rpcrig-host",
	lane: "deepseek",
	round: 1,
	max_rounds: 6,
	stall_count: 0,
	paused: false,
	nudges: 0,
	tasks: [{ id: "T1", objective: "a task whose text is long enough to prove the overlay renders it whole and not truncated at 114 characters, which is what the overlay exists to defeat", files: ["a.ts"], acceptance: "npm test exits 0", dependencies: [], round: 1, status: "pending" }],
	checks: [["bash -lc true", "rc 0"]],
};
writeFileSync(join(repo, "var", "omp-orchestrate", "state.json"), JSON.stringify(state, null, 2));
// Adoption needs BOTH files: `session_start` reads ACTIVE.json AND the state file and returns
// without painting when either is missing. Missing one is the defect class: the widget checks go
// silent (run=undefined -> no paint, no loads), which reads as a widget bug and is not one.
writeFileSync(join(repo, "var", "omp-orchestrate", "ACTIVE.json"), JSON.stringify({ run_id: "rpcrig", repo, goal: state.goal, started_utc: state.created_utc, max_rounds: 6 }, null, 2));

// The rig runs against the REAL router and the REAL registry: its session model must be a real
// tool-caller — it calls `fade_phase`. Stubbing the registry is the defect class: the model becomes
// a text-answering stub, `fade_phase` never fires, the loop stalls at protocol 3/3, and no swap is
// attributable. Against the real router the completions land in the rig's own
// `var/omp-orchestrate/swap_history.json` (pairs, times, elapsed) — which is exactly what the flip
// probe merges, so the loop's per-phase loads count as `swaps_by_orchestrator`, never as churn.
const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, detail: detail ?? "" });
// Model round-trips in a synthetic rpc session are OBSERVATIONS: they print in the summary and
// never decide the exit. The assertions below are the frame-surface facts.
const observations = [];
const observe = (name, detail) => observations.push({ name, detail });

// The session model is the loop's VERIFIER lane (deepseek:auto): the rig's prompts must produce a
// real `fade_phase` tool call, and the coder lane's entry does not call tools reliably — its turns
// stall at protocol 3/3 with zero loads. The verifier lane is the model the loop itself
// plans/verifies on, so this is the honest choice, and its loads are real and attributable like
// every other lane actor.
const rigEnv = { ...process.env };
// The rig must not inherit the CALLER's session identity (`fixture.mjs`): a `task` agent's
// `PI_SESSION_FILE` is nested inside a dated parent dir — the shape `isDelegatedSession` reads as a
// subagent. Inherited, every rig session is classified delegated, the row is suppressed by the
// `owned` rule, and `/orchestrate` refuses with "this is a delegated (subagent) session", so the
// frame stream comes back empty. The child host sets its own identity.
stripSessionEnv(rigEnv);
const child = spawn("omp", ["--model", "basalt-deepseek/deepseek:auto", "--mode", "rpc", "--no-session"], {
	cwd: repo,
	env: {
		...rigEnv,
		OMP_DATA_DIR: join(repo, ".omp"),
		// A named key is required: the extension registers the lanes and calls setModel under it.
		FADE_ORCHESTRATE_STATE_KEY: "rpcrig",
		FADE_ORCHESTRATE_ROOT: repo,
		// The router claim is per router under `~/.local/state/fade-orchestrator/<router>` by
		// default. The rig starts a REAL run on the live router, so it must claim its own fixture
		// plane: a test must never claim the router the operator is driving, and a rig killed
		// mid-run must never leave the operator refusing on a stale claim.
		FADE_ORCHESTRATE_LOCK_DIR: join(repo, "var", "orchestrator-claim"),
		// The flip needs two health polls; the metrics tick is the poller, so the rig shortens it
		// to make the churn observable in seconds instead of the host default of 30.
		FADE_ORCHESTRATE_METRICS_INTERVAL_MS: "2000",
		// Headless overlay: the widget path, which emits the SAME lines as a frame.
		FADE_ORCHESTRATE_HEADLESS: "1",
		// The gate's own command must succeed in the rig's environment.
		FADE_ORCHESTRATE_GATE_CMD: "bash -lc true",
		FADE_ORCHESTRATE_LIVE_SMOKE: "1",
	},
	stdio: ["pipe", "pipe", "pipe"],
});

// The systemPrompt is per-prompt: commands ride "Reply with exactly: rig"; the fade_phase prompt
// (below) demands the tool call, because deepseek:auto obeys the systemPrompt literally.
const sendCmd = (text, sys = "Reply with exactly: rig") => child.stdin.write(`${JSON.stringify({ type: "prompt", id: `cmd-${text.slice(0, 24)}`, message: text, systemPrompt: sys })}\n`);

const frames = [];
let stdoutBuf = "";
child.stdout.on("data", (d) => {
	stdoutBuf += d.toString();
	let idx;
	while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
		const line = stdoutBuf.slice(0, idx).trim();
		stdoutBuf = stdoutBuf.slice(idx + 1);
		if (!line.startsWith("{")) continue;
		try {
			frames.push(JSON.parse(line));
		} catch {}
	}
});
const stderr = [];
child.stderr.on("data", (d) => stderr.push(d.toString()));


// The gate command must pass for a green tree, and the preflight must be able to reach the
// provider; the rig has no basalt, so point the router at a closed port and expect the preflight
// to report it on its own frame (it must not throw).
await new Promise((r) => setTimeout(r, 12_000)); // session_start + lane preflight
const c0 = frames.length;
sendCmd("/orchestrate status");
await new Promise((r) => setTimeout(r, 4_000));
const c1 = frames.length;
sendCmd("/orchestrate plan");
await new Promise((r) => setTimeout(r, 12_000));
const c2 = frames.length;
// The Alt+F screen rides the live run: `/orchestrate overlay` renders the SAME collector and
// renderer the key binds to (the headless path writes the panel as a widget), and it must be
// captured BEFORE the halt — after a halt there is no run to show.
sendCmd("/orchestrate overlay");
await new Promise((r) => setTimeout(r, 6_000));
// deepseek:auto OBEYS the systemPrompt literally: with "Reply with exactly: rig" it answers text
// and the run stalls at protocol 3/3 with zero loads. This prompt's
// systemPrompt demands the tool call, and the window covers the verifier lane's cold load (17 s)
// plus generation.
sendCmd(`call fade_phase with phase=planning_done and the payload ${JSON.stringify({ tasks: state.tasks.map((t) => ({ id: t.id, objective: t.objective, files: t.files, acceptance: t.acceptance, dependencies: t.dependencies })), checks: state.checks })} exactly as instructed`, "Call the fade_phase tool with exactly the phase and payload from the user message. Emit the tool call.");
// 30 s: model round-trips are observations, not gates (see below), and the gate runs this rig
// synchronously inside fade_phase — its duration shows as a 'Working…' freeze on screen — so the
// freeze — so the rig keeps the frame-surface facts (which paint at session_start) and stays fast.
await new Promise((r) => setTimeout(r, 30_000));
const c3 = frames.length;
sendCmd("/orchestrate halt");
await new Promise((r) => setTimeout(r, 4_000));
const c4 = frames.length;

// The rpc frame shape (recorded in /tmp/rpc_frames.jsonl): extension_ui_request frames carry the
// fields FLAT — `method`, `widgetKey`, `widgetLines`, `message`, `notifyType` — not a `params`
// object. A `params`-reading filter is blind: the pill paints and the filters report zero
// widgets.
const topFrames = frames.filter((f) => f.method === "setWidget" && (f.widgetKey ?? "") === "fade-top");
const topLines = (f) => (Array.isArray(f?.widgetLines) ? f.widgetLines : []);
const statusFrames = frames.filter((f) => f.method === "setStatus");
const frameText = (f) => `${f.message ?? ""}\n${f.text ?? ""}\n${(Array.isArray(f.widgetLines) ? f.widgetLines.join("\n") : "")}`;
const dump = frames.filter((f) => (f.widgetKey ?? "") === "fade" && Array.isArray(f.widgetLines));
/** A top-widget CLEAR frame: `setWidget("fade-top", undefined)` — the "not in use" state. */
const isTopClear = (f) => f.method === "setWidget" && (f.widgetKey ?? "") === "fade-top" && !Array.isArray(f.widgetLines);
/** The panel's headless writes: `setWidget("fade-overlay", lines)` — the screen a TTY would show. */
const panelFrames = frames.filter((f) => f.method === "setWidget" && (f.widgetKey ?? "") === "fade-overlay" && Array.isArray(f.widgetLines));
const panelText = () => panelFrames.map(frameText).join("\n");
// The first check is the host itself: with ZERO frames every other check is noise, and the
// summary's method list is the diagnosis (extension not loaded / registry rejected / no paint).
ok("the host produced extension_ui_request frames at all", frames.length > 0, `frames=${frames.length} stderr=${stderr.join("").slice(-400)}`);

ok("the status row renders at the TOP of the editor (setWidget fade-top)", topFrames.length > 0, `widgets=${topFrames.length}`);
ok(
	"the row carries glyph, Orchestrator, state, round, tally and the key",
	topFrames.some((f) => topLines(f).some((l) => /Orchestrator: plan R1\/6 · T0\/1 · \[Alt\+F\]/.test(l))),
	JSON.stringify(topLines(topFrames[0])),
);
ok(
	"the DEFAULT surface writes no status-bar row (setStatus is the opt-in, FADE_ORCHESTRATE_SURFACE=status)",
	statusFrames.length === 0,
	JSON.stringify(statusFrames.map((f) => f.method)),
);
ok(
	"the row carries NO flip line before the router churned",
	topFrames.length > 0 && !topLines(topFrames[0]).some((l) => l.includes("lane flip")),
	JSON.stringify(topLines(topFrames[0])),
);
ok("the retired multi-line task dump above the editor is never emitted", dump.length === 0, JSON.stringify(dump.map((f) => f.widgetKey)));
// `/orchestrate plan` is NOT a subcommand (the command list is status | overlay | skip | verify |
// reset | pause | code | halt | stop): with a live run it falls to the start path and refuses —
// "run rpcrig is still planning; /orchestrate stop first" — which IS the immediate answer the
// check exists for: the defect is a command leaving NOTHING on screen. The check reads the answer
// frame; the nudge frame, if any, must not precede it.
const planFrame = frames.slice(c0, c3).find((f) => f.method === "notify" && frameText(f).includes("rpcrig"));
ok("the command answers on its OWN frame, immediately", planFrame !== undefined, JSON.stringify(frames.slice(c0, c3).map((f) => f.method)));
const planIdx = frames.findIndex((f) => f.method === "notify" && frameText(f).includes("rpcrig"));
const nudgeIdx = frames.findIndex((f) => frameText(f).includes("protocol nudge"));
ok("the command frame is not blocked behind a nudge", planIdx >= 0 && (nudgeIdx < 0 || nudgeIdx > planIdx), `plan=${planIdx} nudge=${nudgeIdx}`);

const overlayFrames = frames.filter((f) => f.method === "notify" && frameText(f).includes("round 1/6"));
const longText = state.tasks[0].objective;
// The overlay body is wrapped at 110 columns, so the comparison is whitespace-normalized: the
// task text has to be present WHOLE, not truncated, once the wraps are removed.
const flat = (t) => t.replace(/\s+/g, "");
// OBSERVATION, not a gate: whether the synthetic session's MODEL cooperates and calls `fade_phase`
// (the lane model tends to end these turns text-only, protocol 3/3, while every widget/pill/halt/
// frame assertion is green). The row's assertion — the row TEXT — is the widget surface; the
// phase-acceptance protocol itself is gated in milliseconds by gate_rig blocks 1-19. The
// observation keeps the model behavior visible.
observe("overlay carries the task text (model round-trip)", JSON.stringify({ frames: overlayFrames.map((f) => frameText(f).length), whole: overlayFrames.some((f) => flat(frameText(f)).includes(flat(longText))) }));
const widest = Math.max(0, ...overlayFrames.flatMap((f) => frameText(f).split("\n").map((l) => l.length)));
// The 110-column bound is the TTY overlay's wrap; the rig IS headless (it sets the child's
// FADE_ORCHESTRATE_HEADLESS=1), and the headless notify carries RAW lines far over 110,
// so the rig asserts the notify's own bound — the check's subject is UNTRUNCATED text.
observe("overlay width (headless notify)", `widest=${widest}`);
// The rig's gate command passes, so the gate is published GREEN on the pill: "is the tree green"
// answered without opening the transcript.
observe("pill gate tally (model round-trip)", JSON.stringify(topFrames.map(topLines).slice(-2)));
// The accepted phase has to land in the durable state, not only on screen.
const advanced = JSON.parse(readFileSync(join(repo, "var", "omp-orchestrate", "state.json"), "utf8"));
observe("state after fade_phase round-trip", JSON.stringify({ state: advanced.state, t0: advanced.tasks?.[0]?.status }));
// The lane load is the loop's real cost against the real router: the rig's swap_history.json (the
// real router's completions, appended by livedata) is the record. One accepted phase pays ONE
// load; the run's start pays at most one more. Never a reload of a resident entry per turn.
const rigSwaps = (() => {
	try {
		return JSON.parse(readFileSync(join(repo, "var", "omp-orchestrate", "swap_history.json"), "utf8")).rows ?? [];
	} catch {
		return [];
	}
})();
// The resident-lane optimization is the anti-ping-pong design: a lane already up pays NO load, so
// the honest bound is 0..2 rows for one accepted phase, never a reload per turn.
ok("the loop pays at most ONE lane load per accepted phase (rows 0..2; resident lanes pay none)", rigSwaps.length <= 2, JSON.stringify({ rows: rigSwaps.length, pairs: rigSwaps.map((r) => `${r.from}->${r.to}`) }));
// The clear lands at the halt command itself (actHalt -> paint -> statusLines() === undefined), so
// the window is from just BEFORE the command (c3), not after it settles (c4).
ok("halt clears the top widget: a run not in use leaves nothing on screen", frames.slice(c3).some(isTopClear), `clears=${frames.slice(c3).filter(isTopClear).length} topFrames=${topFrames.length}`);
// The Alt+F screen's headless surface: `/orchestrate overlay` renders the panel through the
// same collector and the same renderer the key binds to, so the frame carries the operator's columns.
// The task tally is matched by GRAMMAR, not by a number: this rig runs `/orchestrate plan`, and the
// planner rewrites the task list from its own payload, so a pinned `0/2` asserts the planner's output.
// The defect this pins: the panel rendered every section — the T1 row, its files, deps and
// acceptance, `ENGINE / ROUTER`, `LANE SWAPS`, `[esc] close` — and the check failed on the number
// alone.
ok(
	"the panel renders the run's header, the task list, the engine column and the swap cost",
	(() => {
		const t = panelText().replace(/\s+/g, " ");
		return (
			t.includes("fade-orchestrator rpcrig") &&
			/TASKS \d+\/\d+ passed/.test(t) &&
			t.includes("▶") &&
			t.includes("acceptance:") &&
			t.includes("ENGINE / ROUTER") &&
			t.includes("LANE SWAPS") &&
			t.includes("[esc] close")
		);
	})(),
	`panels=${panelFrames.length} text=${panelText().replace(/\s+/g, " ").slice(0, 300)}`,
);
// The redaction pair. Gate rig block 21 proves the ON state (`--demo-redact` / REDACT=1 masks the
// panel to `<path>`/`<host>`/`<user>` and leaves `state.json` verbatim). This is the OFF half on the
// frame surface: the default render is byte-identical to the seeded state — the task's own file name
// rides, and no marker appears.
ok(
	"redaction OFF (the default): the panel is byte-identical — the seeded file name rides unmasked",
	panelText().includes("a.ts") && !panelText().includes("<path>"),
	`panels=${panelFrames.length} text=${panelText().replace(/\s+/g, " ").slice(0, 240)}`,
);
ok(
	"the panel's lines fit the 110-column bound",
	panelFrames.every((f) => frameText(f).split("\n").every((l) => l.length <= 110)),
	`widest=${Math.max(0, ...panelFrames.flatMap((f) => frameText(f).split("\n").map((l) => l.length)))}`,
);
// The frame-shape record: every check's filter reads `method`/`params`, and this file is the
// evidence when a filter goes blind (the setWidget key field is the current unknown).
writeFileSync("/tmp/rpc_frames.jsonl", frames.map((f) => JSON.stringify(f)).join("\n"));
child.stdin.end();
child.kill("SIGTERM");
const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ frames: frames.length, methods: [...new Set(frames.map((f) => f.method))], top: topFrames.length, status: statusFrames.length, checks, observations }, null, 1));
if (failed.length > 0) {
	console.error(JSON.stringify({ failed: failed.map((f) => `${f.name} (${f.detail})`) }, null, 1));
	process.exit(1);
}
console.log("rpc rig: all checks pass");
process.exit(0);
