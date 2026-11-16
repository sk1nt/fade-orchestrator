#!/usr/bin/env node
// gate_rig.mjs — headless proof of the phase tool, the pre-swap gate and state v2, without a
// model and without the omp binary: a fake `pi` captures the registered tool/commands/hooks, a
// stub router counts every request, and the extension's own code runs unmodified.
//
// Proves:
//   1. v1 state.json migrates to v2 on resume (rejection_history [], schema_retries 0),
//   2. planning_done sets tier S / adaptive max_rounds 3 for a 2-task plan,
//   3. an invalid coding_done payload increments schema_retries (round unchanged) and records the
//      refusal — then the SECOND refusal carries the exact payload schemas back,
//   4. a RED gate (check `false`) issues ZERO POST /v1/load and records a task rejection; the
//      gate briefing names the failing command,
//   5. a GREEN gate on the next run lets agent_end issue exactly ONE POST /v1/load (the verifier
//      swap) and the state reaches verifying,
//   6. needs_repair records the verifier notes + task ids into rejection_history, round 2,
//   7. /orchestrate halt persists state=stopped,
//   8. the Tier-1 protocol gate: a phase-less turn is nudged with the round UNSPENT and no swap,
//      the second miss synthesizes coding_done from `git status --porcelain` + gate exit codes,
//      the third halts as stalled_protocol_error with ZERO lane loads,
//   9. [p] pauses as a flag (load deferred, operator note durable) and resumes,
//  10. the turn ledger writes one JSONL line per turn from the router's own numbers, and NO line
//      when the router reports no pp/tg (never a fabricated zero),
//  11. the verifier lane's active set carries no writers and a verifier edit/task is BLOCKED,
//  12. an accepted verification tags `omp-ckpt/<run>/T<n>-passed` in the repo,
//  13. the FLIP GUARD: swaps the router reports AWAY from the resident lane are counted as a
//      flip and named, a quiet lane reports none, and a reload of the resident lane inside the
//      guard window issues ZERO `POST /v1/load` and says why.
//
// Usage: node test/gate_rig.mjs
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildTestBundle } from "./build.mjs";

// The rig must not inherit the CALLER's session identity — the same hygiene `test/rpc_rig.mjs` and
// `test/pty_rig.mjs` already carry, and the same trap: `isDelegatedSession` (src/index.ts:94) reads
// a session file nested inside a dated parent dir as a delegated subagent, which is the shape of a
// `task` agent's `PI_SESSION_FILE`. Inherited, the rig's seeded run is never adopted and every
// `fade_phase` is refused with `fade_phase: no orchestrated run is active` — and a gate that is
// green only in an environment without those two variables is non-hermetic in exactly the lane
// that runs the plan's checks.
delete process.env.PI_SESSION_FILE;
delete process.env.PI_SESSION_ID;

// The rig IS the acceptance command (`node test/gate_rig.mjs`), so it builds the bundle it imports
// instead of trusting whatever `.test-build/` some earlier run left behind: a stale build dies on
// `ERR_MODULE_NOT_FOUND .test-build/router.mjs`, and the gate's acceptance command must not.
buildTestBundle();

const repo = join(tmpdir(), "orch-gate-rig");
rmSync(repo, { recursive: true, force: true });
mkdirSync(join(repo, "var", "omp-orchestrate"), { recursive: true });

// ---- stub router: counts requests, tracks the resident lane ----
const reqLog = [];
let resident = "flash-next";
let metricsOn = true;
/** The swap the router is mid-way through, as its own `/health` line reports it. `null`
 *  between swaps, exactly as the real router clears `swap` when a swap lands. */
let swapLine = null;
const server = http.createServer(async (req, res) => {
  reqLog.push(`${req.method} ${req.url}`);
  let body = "";
  for await (const c of req) body += c;
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  // The basalt 0.4.0 `/health` shape, as the real router answers it:
  // `loaded` is a BOOLEAN — "is a pack resident" — and the resident lane rides under `model`;
  // `percent` is null at rest. The invented shape (`loaded: <lane key>`) is what let the panel crash
  // on the live router: the reader took `true` for a name and the renderer threw
  // (`name.indexOf is not a function`), so the panel opened nothing.
  if (req.url.startsWith("/health"))
    return send(200, {
      status: "ok",
      max_context: 262144,
      model: resident,
      images: 0,
      api_key: "set",
      loaded: resident !== null,
      loading: swapLine !== null,
      service: "basalt",
      percent: null,
      swap: swapLine,
    });
  if (req.url === "/v1/models")
    return send(200, {
      data: [
        { id: "flash-next", status: { value: resident === "flash-next" ? "loaded" : "unloaded" } },
        { id: "deepseek", status: { value: resident === "deepseek" ? "loaded" : "unloaded" } },
      ],
    });
  if (req.url === "/v1/load" && req.method === "POST") {
    const { model } = JSON.parse(body || "{}");
    resident = model;
    return send(200, { ok: true, model });
  }
  if (req.url === "/metrics")
    // The basalt 0.4.0 `/metrics` payload, as the real router answers it, trimmed to the
    // fields the panel reads. The load-bearing details, each of which an invented fixture missed:
    //  - the tier fields are NESTED under `engine`;
    //  - `engine.quant` carries the LANE NAME, so the engine row must print no quant at all;
    //  - `engine.spill` is null and `expert_total` sits beside `expert_slots`;
    //  - `live.tok_s` is null when idle, and the queue is `live.slots.queue_depth`/`live.queued`;
    //  - `requests[]` carries NO `model` field (only `path`/`slot`), and `best.decode.tok_s` is the
    //    strongest rate the router publishes.
    return send(200, {
      engine: { model: resident, version: "0.4.0", quant: resident, expert_slots: 2200, expert_total: 15360, spill: null, max_context: 262144, kv: "int8" },
      live: {
        state: metricsOn ? "decoding" : "idle",
        load: null,
        queued: 0,
        slots: { total: 1, active: metricsOn ? 1 : 0, queue_depth: 0 },
        queue: [],
        tok_s: metricsOn ? 130.5 : null,
      },
      best: { prefill: { tok_s: 14947.5 }, decode: { tok_s: 471.0 } },
      totals: { requests: 1844, prompt: 229256971, reused: 224063798 },
      requests: metricsOn ? [{ id: "r_1844", path: "/v1/chat/completions", slot: 0, duration_s: 0.7, prompt_tokens: 1499, reused: 1187, output_tokens: 312, decode_tok_s: 130.0, hit_rate: 0.82, ttft_s: 0.4 }] : [],
      swap: swapLine,
    });
  send(404, { error: "unknown" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.FADE_ORCHESTRATE_ROUTER = `http://127.0.0.1:${server.address().port}`;
process.env.FADE_ORCHESTRATE_HEADLESS = "1";

// ---- fake pi + ctx ----
const tools = {};
const commands = {};
const hooks = {};
const sent = [];
/** The registered chords (the host's table, as the extension sees it) and the recorded surfaces:
 *  the rigs read the SAME contract the TUI renders — widget writes, status-bar writes, and the
 *  raw-input listeners the extension binds (the panel's chord is delivered there, never by registerShortcut). */
const shortcuts = {};
const widgets = new Map();
const statusRows = new Map();
const inputHandlers = [];
let activeTools = ["read", "bash", "edit", "write", "grep", "task"];
/** The host's chord table, as the rig models it: `registerShortcut` REFUSES a chord the host's own
 *  table binds — it refuses "Extension shortcut conflicts with built-in shortcut" for `ctrl+o`,
 *  and its own keybinding table answers `tui.editor.cursorWordRight` for `alt+f`.
 *  The rig must refuse exactly where the host refuses, or the panel's raw-layer claim is never
 *  exercised: a fake host that accepts every chord proves the registration, not the delivery. */
const HOST_TABLE = new Set(["ctrl+c", "ctrl+d", "ctrl+g", "ctrl+l", "ctrl+o", "ctrl+r", "ctrl+s", "ctrl+t", "ctrl+y", "ctrl+z", "ctrl+.", "alt+a", "alt+b", "alt+d", "alt+f", "alt+g", "alt+h", "alt+i", "alt+k", "alt+l", "alt+m", "alt+n", "alt+o", "alt+p", "alt+r", "alt+y", "alt+shift+c", "alt+shift+k", "alt+shift+l", "alt+shift+p", "alt+shift+v"]);
const pi = {
  registerTool: (t) => void (tools[t.name] = t),
  registerCommand: (name, c) => void (commands[name] = c),
  on: (evt, h) => void (hooks[evt] = h),
  registerShortcut: (key, opts) => {
    if (HOST_TABLE.has(String(key))) throw new Error(`Extension shortcut conflicts with built-in shortcut: ${key}`);
    shortcuts[key] = opts;
  },
  setModel: async () => ({ switched: true }),
  setThinkingLevel: () => {},
  getActiveTools: () => activeTools,
  setActiveTools: (t) => void (activeTools = t),
  sendUserMessage: (t) => void sent.push(t),
};
const notes = [];
/** The chord disclosure, captured separately: it is a ONE-SHOT at the first `session_start`, and the
 *  `notes` transcript is scoped and cleared by the later blocks, so the disclosure must not be
 *  asserted against a transcript that has already moved on. */
let disclosure = "";
const ctx = {
  hasUI: false,
  cwd: repo,
  modelRegistry: { find: () => ({ id: "stub" }) },
  getContextUsage: () => ({ tokens: 41234, contextWindow: 1048576, percent: 3.9, baselineSource: "test" }),
  abort: () => {},
  isIdle: () => true,
  hasPendingMessages: () => false,
  signal: undefined,
  ui: {
    setStatus: (key, text) => void (text === undefined ? statusRows.delete(key) : statusRows.set(key, text)),
    setWidget: (key, lines, opts) => void (lines === undefined ? widgets.delete(key) : widgets.set(key, { lines, opts })),
    notify: (m) => {
      notes.push(m);
      if (disclosure === "" && /orchestration screen/.test(m)) disclosure = m;
    },
    setWorkingMessage: () => {},
    custom: async () => undefined,
    onTerminalInput: (h) => {
      inputHandlers.push(h);
      return () => {
        const i = inputHandlers.indexOf(h);
        if (i >= 0) inputHandlers.splice(i, 1);
      };
    },
  },
};

const task = (id) => ({ id, objective: `${id} objective`, files: ["a.ts"], acceptance: "echo", dependencies: [], round: 1 });
const seedState = (state, checks) => ({
  key: "fade.omp_orchestrate.v1",
  run_id: "GATE1",
  goal: "gate rig goal",
  lane: "flash-next",
  round: 1,
  max_rounds: 6,
  state,
  checks,
  tasks: state === "coding" ? [task("T1"), task("T2")] : [],
  phases: [{ phase: "planning_done", lane: "deepseek", accepted: true, round: 1, at: "2030-01-01T00:00:00.000Z" }],
  repair_tasks: [],
  started_utc: "2030-01-01T00:00:00.000Z",
  repo,
});
const writeState = (s) => {
  writeFileSync(join(repo, "var", "omp-orchestrate", "state.json"), JSON.stringify(s, null, 2));
  writeFileSync(join(repo, "var", "omp-orchestrate", "ACTIVE.json"), JSON.stringify({ run_id: "GATE1", repo, goal: "g", started_utc: s.started_utc, max_rounds: 6 }));
};
const readState = () => JSON.parse(readFileSync(join(repo, "var", "omp-orchestrate", "state.json"), "utf8"));
const loads = () => reqLog.filter((r) => r === "POST /v1/load").length;
const exec = (phase, payload) => tools.fade_phase.execute("id", { phase, payload: JSON.stringify(payload) }, null, null, ctx);

const mod = await import("../.test-build/index.mjs");
mod.default(pi);
const checks = [];
const ok = (name, cond, detail = "") => checks.push({ name, ok: Boolean(cond), detail });


/**
 * `words` on one row, whitespace-agnostic: the panel pads its metric label column, so the contract
 * is that the words ride on one row, never the exact padding count.
 */
const hasRow = (s, words) => new RegExp(words.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("\\s+")).test(s);

// 1+2. v1 -> v2 migration happens on resume; the first persisted snapshot proves it, together
// with the planning tier and adaptive budget (a 2-task plan reserves 3 rounds).
writeState(seedState("planning", []));
await hooks.session_start({}, ctx);
await exec("planning_done", { tasks: [task("T1"), task("T2")], checks: [["false", "must fail"]] });
{
  const s = readState();
  ok("v1 -> v2 migration persists on the first phase", Array.isArray(s.rejection_history) && s.schema_retries === 0);
  ok("planning sets tier S and max_rounds 3 for 2 tasks", s.tier === "S" && s.max_rounds === 3, `${s.tier}/${s.max_rounds}`);
}

// 3. schema retries are separate from rounds; the 2nd refusal carries the schemas
{
  let msg = "";
  try {
    await exec("coding_done", { done: [{ id: "T1", status: "ok" }] });
  } catch (e) {
    msg = e.message;
  }
  const s = readState();
  ok("invalid status refused, schema_retries 1, round unchanged", /passed\|failed\|blocked/.test(msg) && s.schema_retries === 1 && s.round === 1);
  ok("first refusal does not yet carry the schema hint", !msg.includes("Payload schemas"));
  let msg2 = "";
  try {
    await exec("coding_done", { done: [{ id: "T1", status: "ok" }] });
  } catch (e) {
    msg2 = e.message;
  }
  ok("second refusal carries the exact payload schemas", msg2.includes("Payload schemas"));
}

// 4. RED gate: zero loads, rejection recorded, gate briefing names the command
{
  await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "x" }] });
  const s = readState();
  ok("red gate issues ZERO verifier loads", loads() === 0, `loads=${loads()}`);
  ok("red gate keeps state coding", s.state === "coding");
  ok("red gate records a task rejection", (s.rejection_history ?? []).some((r) => r.kind === "task" && r.reason.includes("gate")));
  ok("red gate stores gate_last passed=false", s.gate_last && s.gate_last.passed === false);
}

// 5. GREEN gate: exactly one swap at agent_end
{
  resident = "flash-next";
  writeState({
    ...seedState("coding", [["true", "green"]]),
    schema_retries: 0,
    rejection_history: [],
  });
  await hooks.session_start({}, ctx);
  const before = loads();
  await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "x" }] });
  await hooks.agent_end({}, ctx);
  const after = loads();
  const s = readState();
  ok("green gate lets agent_end issue exactly one load", after - before === 1, `${after - before}`);
  ok("green gate reaches verifying", s.state === "verifying", s.state);
}

// 6. needs_repair records the verifier critique
{
  await exec("verification_done", { verdict: "needs_repair", notes: "T2 acceptance never ran", tasks: [task("T2")] });
  const s = readState();
  const r = (s.rejection_history ?? []).find((x) => x.kind === "verification");
  ok("needs_repair records verifier notes + task ids", Boolean(r) && r.reason === "T2 acceptance never ran" && r.task_id === "T2");
  ok("needs_repair advances to round 2 repair", s.state === "repair" && s.round === 2);
}

// 7. halt persists
{
  await commands.orchestrate.handler("halt", ctx);
  ok("halt persists state stopped", readState().state === "stopped");
}

// 8. condensed handover: resume sends it, and it is STABLE-FIRST (the cache-hitting prefix)
{
	resident = "flash-next";
	writeState(seedState("coding", [["true", "green"]]));
	process.env.FADE_ORCHESTRATE_AUTO_RESUME = "1";
	sent.length = 0;
	await hooks.session_start({}, ctx);
	await new Promise((r) => setTimeout(r, 400));
	const h = sent.find((m) => m.includes("Resume of orchestrated run"));
	ok("auto-resume sends the condensed handover", Boolean(h));
	const stableIdx = h ? h.indexOf("Task definitions") : -1;
	const volatileIdx = h ? h.indexOf("Task state") : -1;
	ok("handover is stable-first (definitions before statuses)", stableIdx > 0 && volatileIdx > stableIdx, `stable=${stableIdx} volatile=${volatileIdx}`);
	delete process.env.FADE_ORCHESTRATE_AUTO_RESUME;
}

// 9. Tier-1 protocol gate: a turn that ends with no `fade_phase` is protocol debt. The
//    round budget and the lane swap are the two currencies here, so the gate must touch NEITHER.
{
	const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
	git("init", "-q");
	git("config", "user.email", "rig@localhost");
	git("config", "user.name", "fade-orchestrator-rig");
	writeFileSync(join(repo, "a.ts"), "seed\n");
	git("add", "-A");
	git("commit", "-q", "-m", "rig seed");
	writeFileSync(join(repo, "a.ts"), "changed by the coder lane\n");

	writeState({ ...seedState("coding", [["true", "green"]]), schema_retries: 0, rejection_history: [], protocol_retries: 0, stall_count: 0, paused: false });
	await hooks.session_start({}, ctx);
	sent.length = 0;
	const base = loads();

	await hooks.agent_end({}, ctx); // miss 1 → nudge, in place, free
	let s = readState();
	ok("tier 1: nudge burns NO round", s.round === 1 && s.stall_count === 1 && s.protocol_retries === 1, `round=${s.round} stall=${s.stall_count} retries=${s.protocol_retries}`);
	ok("tier 1: nudge pays NO swap", loads() === base, `loads=${loads() - base}`);
	ok("tier 1: the nudge is sent to the resident lane", sent.some((m) => m.includes("Protocol nudge 1/2")), sent.join(" | ").slice(0, 140));

	await hooks.agent_end({}, ctx); // miss 2 → synthesize from git + gate
	await new Promise((r) => setTimeout(r, 60));
	s = readState();
	ok("tier 2: coding_done SYNTHESIZED from git + gate", s.synthesized?.phase === "coding_done" && s.state === "verifying", `${s.synthesized?.phase}/${s.state}`);
	ok("tier 2: the synthesized result quotes git evidence", (s.tasks.find((t) => t.id === "T1")?.result ?? "").includes("git status --porcelain"), s.tasks[0]?.result);
	ok("tier 2: the verifier swap is paid EXACTLY once", loads() - base === 1, `${loads() - base}`);
	ok("tier 2: protocol debt is recorded as its own kind", (s.rejection_history ?? []).some((r) => r.kind === "protocol"), JSON.stringify((s.rejection_history ?? []).map((r) => r.kind)));
}

// 10. [p] pause: a flag, not a state — the lane load is deferred and the note is durable.
{
	const base = loads();
	await commands.orchestrate.handler("pause hand-editing the fixture", ctx);
	let s = readState();
	ok("pause sets the flag and writes the operator note", s.paused === true && s.operator_note === "hand-editing the fixture", JSON.stringify(s.operator_note));
	await hooks.agent_end({}, ctx);
	ok("a paused loop sends no nudge and pays no swap", loads() === base && notes.some((n) => n.includes("no nudge sent")), notes.slice(-1)[0]);
	await commands.orchestrate.handler("pause", ctx);
	s = readState();
	ok("the second pause resumes and clears the flag", s.paused === false, String(s.paused));
}

// 11. Tier-3 circuit breaker: the third phase-less turn halts cleanly, ZERO lane loads.
{
	const base = loads();
	await hooks.agent_end({}, ctx); // miss 3 (synthesis is not an accepted phase, so the streak stands)
	await new Promise((r) => setTimeout(r, 20));
	let s = readState();
	ok("tier 3: halts as stalled_protocol_error, paused", s.state === "stalled_protocol_error" && s.paused === true, `${s.state}/${s.paused}`);
	ok("tier 3: ZERO lane loads", loads() === base, `${loads() - base}`);
	ok("tier 3: the diagnostic names the acts", notes.some((n) => n.includes("stalled_protocol_error") && n.includes("/orchestrate code")), (notes.slice(-1)[0] ?? "").slice(0, 160));
	let refused = "";
	try {
		await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "x" }] });
	} catch (e) {
		refused = e.message;
	}
	ok("a stalled run refuses a phase with the rule named", /takes no phase/.test(refused), refused);
	await commands.orchestrate.handler("code", ctx);
	await new Promise((r) => setTimeout(r, 60));
	s = readState();
	ok("[c] resumes a stalled run onto the code lane", s.state === "coding" && s.paused === false, `${s.state}/${s.paused}`);
}

// 12. The turn ledger: one line per turn from the router's numbers, and NO line without them.
{
	const jsonl = join(repo, "var", "omp-orchestrate", "metrics.jsonl");
	const lines = () => (existsSync(jsonl) ? readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean) : []);
	metricsOn = true;
	// The tree carries a diff ABOVE the fast-path threshold on purpose: a first-try green round
	// of a 1-file/2-line diff completes on the code lane, and this block needs the verifier's
	// turn (the run must reach `verifying` and stay live for the blocks that follow).
	writeFileSync(join(repo, "a.ts"), "pad\n".repeat(20));
	await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "rig" }, { id: "T2", status: "passed", result: "rig" }] });
	await hooks.agent_end({}, ctx);
	await new Promise((r) => setTimeout(r, 60));
	const withMetrics = lines();
	const last = JSON.parse(withMetrics[withMetrics.length - 1] ?? "{}");
	// pp is a RATE (prompt tokens over the prefill window: 1499 tok over the 0.4 s ttft = 3748 tok/s)
	// and tg the decode rate; the fixture's numbers are the expectation, not a remembered string.
	ok("the ledger writes one JSONL line per turn from the router's numbers", withMetrics.length >= 1 && last.pp === 3748 && last.tg === 130 && last.ttft === 0.4 && last.kv_hit_pct === 82 && last.phase === "coding_done" && typeof last.swap_ms === "number", JSON.stringify(last));
	metricsOn = false;
	const before = lines().length;
	await exec("verification_done", { verdict: "needs_repair", notes: "rig repair", tasks: [task("T2")] });
	await hooks.agent_end({}, ctx);
	await new Promise((r) => setTimeout(r, 60));
	ok("a router reporting no pp/tg appends NO line (never a fabricated zero)", lines().length === before, `${before} → ${lines().length}`);
}

// 13. The verifier sandbox: the thinking lane has no writers, and the guard enforces it.
{
	activeTools = ["read", "bash", "edit", "write", "grep", "task", "fade_phase"];
	await commands.orchestrate.handler("verify", ctx);
	await new Promise((r) => setTimeout(r, 60));
	ok("the verifier lane's active set carries no writers (delegation stays)", !activeTools.includes("edit") && !activeTools.includes("write") && activeTools.includes("task") && activeTools.includes("fade_phase"), JSON.stringify(activeTools));
	const blocked = await hooks.tool_call({ type: "tool_call", toolName: "edit", toolCallId: "x", input: {} }, ctx);
	ok("a verifier edit is BLOCKED with the rule named", blocked?.block === true && /read-only/.test(blocked.reason ?? ""), JSON.stringify(blocked));
	const spawn = await hooks.tool_call({ type: "tool_call", toolName: "task", toolCallId: "y", input: {} }, ctx);
	ok("delegation is NOT blocked (a subagent writes nothing; its session is inert by block 15)", spawn === undefined, JSON.stringify(spawn));
	const allowed = await hooks.tool_call({ type: "tool_call", toolName: "read", toolCallId: "z", input: {} }, ctx);
	ok("a verifier read is NOT blocked", allowed === undefined, JSON.stringify(allowed));
	// The self-lockout to guard: a session that adopted the thinking lane at start must not keep
	// refusing the operator's editor once the run is no longer the verifier's turn. The guard reads
	// the ON-DISK state for exactly this reason.
	const s13 = readState();
	ok("the enforced state is the verifier's turn on the thinking lane", s13.state === "verifying" && s13.lane === resident, `${s13.state}/${s13.lane} vs resident ${resident}`);
	writeState({ ...s13, state: "planning" });
	const after = await hooks.tool_call({ type: "tool_call", toolName: "edit", toolCallId: "w", input: {} }, ctx);
	ok("outside the verifier's turn the operator's edit is NOT blocked", after === undefined, JSON.stringify(after));
}

// 14. Every task accepted by the verifier leaves a checkpoint tag the tree rolls back to.
{
	await exec("verification_done", { verdict: "accepted", checks: [["true", "green"]], notes: "rig accepted" });
	const s = readState();
	ok("accepted verification tags one checkpoint per passed task", s.checkpoints?.T1 === "omp-ckpt/GATE1/T1-passed" && s.checkpoints?.T2 === "omp-ckpt/GATE1/T2-passed", JSON.stringify(s.checkpoints));
	const tagList = execFileSync("git", ["-C", repo, "tag", "-l"], { encoding: "utf8" });
	ok("the checkpoint tag exists in the repo", tagList.includes("omp-ckpt/GATE1/T1-passed"), tagList.trim().split("\n").join(","));
	ok("the run completes", s.state === "complete", s.state);
}

// 15. A delegated (subagent) session NEVER drives the loop. It shares the cwd, so an unguarded
//     session_start adopts the operator's run and pays a full verifier pack swap per spin-up while
//     serving zero tokens.
{
	const nested = join(repo, "sessions", "2030-01-01T09-11-28-519Z_01a1de79-d407-740b-a74e-ce2c57a1c556", "Worker.jsonl");
	mkdirSync(dirname(nested), { recursive: true });
	writeFileSync(nested, "");
	const jsonl = join(repo, "var", "omp-orchestrate", "metrics.jsonl");
	const lines = () => (existsSync(jsonl) ? readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean) : []);
	process.env.PI_SESSION_FILE = nested;
	const base = loads();
	const before = lines().length;
	writeState({ ...seedState("coding", [["true", "green"]]), protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
	await hooks.session_start({}, ctx);
	for (let i = 0; i < 3; i++) await hooks.agent_end({}, ctx); // three phase-less turns
	await new Promise((r) => setTimeout(r, 60));
	const s = readState();
	ok("a delegated session pays ZERO lane loads", loads() === base, `${loads() - base}`);
	ok("a delegated session writes NO ledger line", lines().length === before, `${before} → ${lines().length}`);
	ok("a delegated session leaves the run's protocol counters untouched", s.protocol_retries === 0 && s.stall_count === 0, `${s.protocol_retries}/${s.stall_count}`);
	const refused = await commands.orchestrate.handler("nested goal from a worker", ctx);
	void refused;
	ok("a delegated session refuses to start a run", notes.some((n) => n.includes("delegated (subagent) session") && n.includes("refused")), notes.slice(-1)[0]);
	delete process.env.PI_SESSION_FILE;
}

// 16. [p] between rounds DEFERS the lane load — the swap is never paid into a paused loop, and
//     resuming pays it exactly once.
{
	resident = "flash-next";
	writeState({ ...seedState("coding", [["true", "green"]]), protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
	await hooks.session_start({}, ctx);
	await new Promise((r) => setTimeout(r, 60));
	await commands.orchestrate.handler("pause", ctx); // park the loop between rounds
	const base = loads();
	await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "rig" }, { id: "T2", status: "passed", result: "rig" }] });
	await hooks.agent_end({}, ctx); // the gate is green, so the verifier load is now pending
	await new Promise((r) => setTimeout(r, 60));
	ok("a paused turn boundary defers the verifier load", loads() === base && notes.some((n) => n.includes("load is deferred")), `loads=${loads() - base} · ${(notes.slice(-1)[0] ?? "").slice(0, 90)}`);
	await commands.orchestrate.handler("pause", ctx); // resume → the deferred load is paid
	await new Promise((r) => setTimeout(r, 60));
	ok("resuming pays the deferred load exactly once", loads() - base === 1, `${loads() - base}`);
	ok("the resumed run sits on the verifier lane", readState().state === "verifying", readState().state);
}

// 17. The plan-defect class: a check bash cannot parse is INVALID and is NEVER spawned, and the
//     only way out is a plan act — a `planning_done` from `coding` that keeps EVERY task and
//     re-declares the checks. A gate that reads "not a command" as "the tree fails" livelocks on
//     identical refusals, round after round.
{
	resident = "flash-next";
	const BAD = "bash scripts/ops/scan_resident_parity.sh --artifacts <pinned dir>; echo $?";
	const plain = (s) => s.tasks.map((t) => ({ id: t.id, objective: t.objective, files: t.files, acceptance: t.acceptance, dependencies: t.dependencies }));

	// 17a. Where the plan is authored, the row is refused there, paying no swap.
	writeState({ ...seedState("planning", []), schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
	await hooks.session_start({}, ctx);
	const authorBase = loads();
	let authorThrew = "";
	try {
		await exec("planning_done", { tasks: [task("T1")], checks: [[BAD, "PASS 0 on the pinned nightly"]] });
	} catch (e) {
		authorThrew = e.message;
	}
	ok("planning refuses a check that is not a command", /is not a command/.test(authorThrew), authorThrew.slice(0, 90));
	ok("the authoring refusal pays NO swap and burns no round", loads() === authorBase && readState().state === "planning", `loads=${loads() - authorBase} state=${readState().state}`);

	// 17b. A plan that already carries it: the gate runs at the turn boundary, grades the row
	// INVALID, keeps the coder resident (ZERO loads, round unspent) and names the plan act.
	writeState({ ...seedState("coding", [[BAD, "PASS 0"], ["true", "green"]]), schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
	await hooks.session_start({}, ctx);
	const gateBase = loads();
	await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "rig" }, { id: "T2", status: "passed", result: "rig" }] });
	sent.length = 0;
	await hooks.agent_end({}, ctx);
	await new Promise((r) => setTimeout(r, 80));
	const g = readState();
	const gateText = sent.join(" | ");
	ok("the gate grades the unparseable row INVALID", (g.gate_last?.results ?? []).some((r) => r.invalid === true && r.cmd === BAD), JSON.stringify((g.gate_last?.results ?? []).map((r) => [r.ok, r.invalid])));
	ok("the gate briefing names the plan defect and its exit", /INVALID CHECK \(not a command, never executed\)/.test(gateText) && /PLAN DEFECTS/.test(gateText) && /planning_done/.test(gateText), gateText.slice(0, 140));
	ok("a plan defect pays NO verifier swap", loads() === gateBase, `${loads() - gateBase}`);
	ok("a plan defect leaves the round and the coder lane alone", g.round === 1 && g.state === "coding", `${g.round}/${g.state}`);

	// 17c. The plan act: accepted from `coding`; checks replaced; tasks, round, budget and lane
	// untouched; no swap; recorded by name.
	let actErr = "";
	try {
		await exec("planning_done", { tasks: plain(g), checks: [["true", "green"]] });
	} catch (e) {
		actErr = e.message;
	}
	const st1 = readState();
	ok("the plan act is accepted from coding", actErr === "" && st1.checks.length === 1 && st1.checks[0][0] === "true", actErr.slice(0, 110));
	ok("the plan act leaves the round, the state and the tasks alone", st1.round === g.round && st1.state === "coding" && st1.tasks.map((t) => t.id).join(",") === g.tasks.map((t) => t.id).join(","), `${st1.round}/${st1.state}`);
	ok("the plan act pays NO swap", loads() === gateBase, `${loads() - gateBase}`);
	ok("the plan act is recorded by name in the phase log", `${st1.phases.at(-1).notes}`.includes("plan act"), `${st1.phases.at(-1).notes}`);

	// 17d. The exception is bounded: ONE plan act per round, and it can never rewrite the plan.
	let second = "";
	try {
		await exec("planning_done", { tasks: plain(st1), checks: [["false", "must fail"]] });
	} catch (e) {
		second = e.message;
	}
	ok("a round gets ONE plan act", /already spent its one plan act/.test(second), second.slice(0, 90));
	let changed = "";
	try {
		await exec("planning_done", {
			tasks: [
				{ ...task("T1"), objective: "a DIFFERENT objective" },
				{ ...task("T2") },
			],
			checks: [["true", "green"]],
		});
	} catch (e) {
		changed = e.message;
	}
	ok("a plan act cannot rewrite the plan", /must carry the plan's tasks UNCHANGED/.test(changed), changed.slice(0, 90));
}

// 18. The gate's checks are DATA: a plan repaired in state.json must reach the gate. The unit
// test can only call refreshChecks; this is the end-to-end shape: the session adopts the file at
// session_start and the gate judges the in-memory copy, so a check repaired on disk is seen only
// after a re-read. A gate that never re-reads livelocks the round on commands that already pass.
{
	resident = "flash-next";
	const broken = [["false", "unrunnable by design"], ["bash -c 'exit 3'", "red by design"]];
	writeState(seedState("coding", broken));
	await hooks.session_start({}, ctx); // the session adopts the broken pair
	const l0 = loads();
	notes.length = 0;
	await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "rig" }, { id: "T2", status: "passed", result: "rig" }] });
	const red = readState();
	ok("broken checks keep the run in coding and pay zero loads", red.state === "coding" && loads() === l0, `state=${red.state} loads=${loads() - l0}`);
	ok("the red gate names both broken commands", (red.rejection_history ?? []).some((r) => r.reason.includes("gate") && r.reason.includes("false") && r.reason.includes("exit 3")), (red.rejection_history ?? []).slice(-1)[0]?.reason);

	// The repair lands ONLY on disk: the run object in this session still carries `broken`.
	writeState({ ...red, checks: [["true", "green"], ["echo ok", "ok"]] });
	notes.length = 0;
	const l1 = loads();
	await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "rig" }, { id: "T2", status: "passed", result: "rig" }] });
	const s = readState();
	ok("a pair repaired on disk reaches the gate and leaves coding", s.state === "verifying", s.state);
	ok("the repaired pair is the one that ran", (s.gate_last?.results ?? []).length === 2 && (s.gate_last?.results ?? []).every((r) => r.ok), JSON.stringify(s.gate_last?.results ?? []));
	ok("the refresh is announced, never silent", notes.some((n) => n.includes("re-read the checks") && n.includes("replaced")), JSON.stringify(notes.slice(-2)));
	ok("no load is paid inside the phase call itself", loads() === l1, `loads=${loads() - l1}`);
	await hooks.agent_end({}, ctx);
	ok("the verifier swap is paid once for the refreshed green tree", loads() - l1 === 1, `loads=${loads() - l1}`);
}

// 19. The FLIP GUARD. The churn this guards is NOT the loop's: clients outside the orchestrator
// (the host's title generator, a memory completion) resolve onto another lane, and the router
// answers a queued request by swapping to the entry that request names. The orchestrator cannot
// prevent that — it can NAME it, and it must never pay a reload of a lane that is already resident
// while the churn runs. The router module is imported fresh here so its swap log is this block's
// own.
{
  const rt = await import("../.test-build/router.mjs");
  const l19 = loads();

  // A quiet lane reports no flip.
  swapLine = null;
  const quiet = await rt.observeSwaps();
  ok("a quiet lane reports no flip", quiet.flips === 0 && quiet.competing.length === 0, JSON.stringify(quiet));

  // Two swaps away from the resident lane, with a settle between them (the router's `swap` clears
  // when a swap lands, which is what re-arms the recorder): that is a flip, and it names the
  // entry the competing requests asked for.
  resident = "deepseek";
  swapLine = { from: "deepseek", to: "flash-next", phase: "loading", waiting: 1 };
  await rt.observeSwaps();
  swapLine = null;
  await rt.observeSwaps();
  swapLine = { from: "deepseek", to: "flash-next", phase: "loading", waiting: 3 };
  await rt.observeSwaps();
  swapLine = null;
  const churned = await rt.observeSwaps();
  ok("two swaps away from the resident lane report a flip", churned.flips === 2, JSON.stringify(churned));
  ok("the flip names the competing entry", churned.competing.length === 1 && churned.competing[0] === "flash-next", JSON.stringify(churned.competing));
  ok("the guard is engaged", rt.flipGuarded(churned) === true, JSON.stringify(churned.flips));

  // The same window judged for the lane the swaps LANDED on reads NO flip: the guard counts the
  // swaps that moved away from the lane the run holds, never the raw swap count. And the recorder
  // is once-per-swap: the same pair seen again with no settle between is one row, not two.
  const before = (await rt.observeSwaps()).rows.length;
  swapLine = { from: "deepseek", to: "flash-next", phase: "loading", waiting: 1 };
  await rt.observeSwaps();
  await rt.observeSwaps();
  const deduped = await rt.observeSwaps();
  ok("three polls of one in-flight swap add exactly ONE row", deduped.rows.length === before + 1, `${before} -> ${deduped.rows.length}`);
  swapLine = null;
  resident = "flash-next";
  const landed = await rt.observeSwaps();
  ok("the lane the swaps landed on reads no flip", landed.flips === 0, JSON.stringify(landed));
  resident = "deepseek";

  // A reload of the RESIDENT lane inside the guard window pays nothing and says why.
  resident = "deepseek";
  swapLine = { from: "deepseek", to: "flash-next", phase: "loading", waiting: 1 };
  await rt.observeSwaps();
  swapLine = null;
  const refused = await rt.loadLane("deepseek");
  ok("a reload of the resident lane issues ZERO POST /v1/load", loads() === l19, `extra=${loads() - l19}`);
  ok("the refusal carries the guard's evidence", refused.ok === true && refused.guarded === true && /FLIP GUARD/.test(refused.detail), JSON.stringify(refused.detail));

  // The clause is silent on a quiet lane, so a healthy run's detail never carries it.
  const quietNote = rt.flipNote(quiet);
  ok("a quiet lane carries no guard clause", quietNote === "", JSON.stringify(quietNote));
}

// 20. The Alt+F screen and the status row. The row is the one line the operator sees all day, and
//     it says what the loop is doing in plain words: glyph, Orchestrator, state, round, tally, key.
//     The panel is the detail view, opened on `alt+f` — claimed at the RAW-INPUT layer, because the
//     host's table binds that byte (`tui.editor.cursorWordRight`; `ctrl+o` is `app.tools.expand`)
//     and refuses its registration. The default surface writes no status-bar row, and a terminal
//     run clears the row.
{
  resident = "flash-next";
  writeState(seedState("coding", [["true", "green"]]));
  await hooks.session_start({}, ctx);
  const top = widgets.get("fade-top");
  const row = top?.lines?.[0] ?? "";
  ok("the status row is the operator's line: glyph, Orchestrator, state, round, tally, key", row === "󰚩 Orchestrator: code R1/6 · T0/2 · [Alt+F]", JSON.stringify(row));
  ok("the row is docked above the editor (the surface the loop can own)", top?.opts?.placement === "aboveEditor", JSON.stringify(top?.opts));
  ok("the default surface writes NO status-bar row", statusRows.size === 0, JSON.stringify([...statusRows.keys()]));
  ok("the chord is bound by the raw-input listener", inputHandlers.length === 1, `handlers=${inputHandlers.length}`);
  ok("the panel's chord is claimed at the raw layer, never registered over the host", !shortcuts["alt+f"] && inputHandlers.length === 1, JSON.stringify(Object.keys(shortcuts)));
  ok("the fallback chord is registered where the host accepts it", Boolean(shortcuts["alt+shift+i"]), JSON.stringify(Object.keys(shortcuts)));
  ok("an unrelated keystroke is not consumed", inputHandlers[0]("x") === undefined);
  const consumed = inputHandlers[0]("\x1bf");
  ok("Alt+F (ESC f, 0x1b 0x66) is consumed and opens the panel", consumed?.consume === true, JSON.stringify(consumed));
  await new Promise((r) => setTimeout(r, 300));
  const panel = (widgets.get("fade-overlay")?.lines ?? []).join("\n");
  ok("the panel opens with the run's header", panel.includes("fade-orchestrator GATE1"), panel.slice(0, 240));
  ok("the panel carries the task list", panel.includes("TASKS 0/2 passed"), panel.slice(0, 400));
  ok("the panel carries the phase rail", panel.includes("PHASES") && panel.includes("planning_done"), panel.slice(0, 900));
  ok("the panel carries the engine column", panel.includes("ENGINE / ROUTER") && hasRow(panel, "resident flash-next"), panel.slice(0, 900));
  ok("the panel carries the context meter", hasRow(panel, "context 41.2k / 1.05M (3.9%)"), panel.slice(0, 900));
  ok("the panel names the ledger it has: the swap this rig drove is on screen, not a placeholder", panel.includes("LANE SWAPS") && /→/.test(panel) && !panel.includes("no swaps recorded"), panel.slice(0, 1200));
  ok("the panel ends with the key bar", panel.includes("[esc] close") && panel.includes("[s] skip selected"));
  await commands.orchestrate.handler("halt", ctx);
  ok("a terminal run clears the status row", !widgets.has("fade-top"), JSON.stringify([...widgets.keys()]));
  process.env.PI_SESSION_FILE = join(repo, "sessions", "2030-01-01T00-00-00-000Z_parent", "agent.jsonl");
  await hooks.session_start({}, ctx);
  ok("a delegated session binds no extra listener on the chord", inputHandlers.length === 1, `handlers=${inputHandlers.length}`);
  delete process.env.PI_SESSION_FILE;
}


// 21. Alt+F is the panel's chord, claimed at the RAW-INPUT layer. The host's own table binds
//     `alt+f` (`tui.editor.cursorWordRight`), so its SHORTCUT registration is refused and the byte
//     is the delivery: `ESC f` (0x1b 0x66) opens the panel. The row names the chord it honors, and
//     `--demo-redact` masks identity for screenshots. The real-terminal half of this proof is
//     `test/pty_rig.mjs`.
{
  resident = "flash-next";
  const user = process.env.USER && process.env.USER.length > 1 ? process.env.USER : "someone";
  const host = hostname();
  writeState({ ...seedState("coding", [["true", "green"]]), goal: `run ${repo} on ${host} by ${user}`, schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
  await hooks.session_start({}, ctx);
  await new Promise((r) => setTimeout(r, 700)); // the disclosure is deferred past the TUI attach
  const row21 = widgets.get("fade-top")?.lines?.[0] ?? "";
  ok("the row names [Alt+F], the chord the raw layer claims", row21.endsWith("· [Alt+F]"), JSON.stringify(row21));
  ok("one raw-input listener is bound, for ESC f", inputHandlers.length === 1, `handlers=${inputHandlers.length}`);
  const gotF = inputHandlers[0]("\x1bf");
  ok("ESC f (0x1b 0x66) is consumed and opens the panel", gotF?.consume === true, JSON.stringify(gotF));
  await new Promise((r) => setTimeout(r, 300));
  const panel21 = (widgets.get("fade-overlay")?.lines ?? []).join("\n");
  ok("the panel opened on ESC f", panel21.includes("fade-orchestrator GATE1"), panel21.slice(0, 200));
  ok("the host-held chord is NOT registered as a shortcut (the byte is the delivery)", !shortcuts["alt+f"], JSON.stringify(Object.keys(shortcuts)));
  ok("the registered fallback chord survives", Boolean(shortcuts["alt+shift+i"]), JSON.stringify(Object.keys(shortcuts)));
  ok("the disclosure names Alt+F and the raw-byte claim", /Alt\+F[\s\S]*raw byte/.test(disclosure), JSON.stringify(disclosure));
  ok("the unredacted panel carries the account, host and repo path", panel21.includes(repo) && panel21.includes(host) && panel21.includes(user), panel21.slice(0, 300));
  await commands.orchestrate.handler("--demo-redact", ctx);
  ok("--demo-redact flips the display switch", process.env.FADE_ORCHESTRATE_REDACT === "1" && notes.some((n) => n.includes("demo redaction ON")), JSON.stringify(notes.slice(-1)));
  inputHandlers[0]("\x1bf"); // re-open, so the SAME screen is re-rendered under the switch
  await new Promise((r) => setTimeout(r, 300));
  const panelR = (widgets.get("fade-overlay")?.lines ?? []).join("\n");
  ok("--demo-redact: the panel shows no repo path, home, host or account", panelR.length > 0 && !panelR.includes(repo) && !panelR.includes("/home/") && !panelR.includes(host) && !panelR.includes(user), panelR.slice(0, 300));
  ok("--demo-redact is display-only: state.json keeps the repo verbatim", readState().repo === repo, readState().repo);
  await commands.orchestrate.handler("--demo-redact=off", ctx);
  ok("--demo-redact=off turns the switch back", process.env.FADE_ORCHESTRATE_REDACT === undefined, JSON.stringify(process.env.FADE_ORCHESTRATE_REDACT));
}

// 22. Fast-path single-model bypass. The pre-swap gate has already produced the verifier's
//     evidence (the plan's own exit codes) on the code lane, so a single-file diff under the
//     15-line threshold, green on the FIRST try, completes with ZERO lane loads. The counterfactual
//     in the same block: over the threshold, the verifier swap is paid exactly once.
{
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  // The run's own state plane is not part of the coder's diff: `var/` is gitignored in the real
  // repo. The rig's seed commit tracked it before the ignore existed, so it is untracked here —
  // otherwise the fast path prices its own ledger as the coder's change and the fast path never
  // fires.
  writeFileSync(join(repo, ".gitignore"), "var/\nsessions/\n");
  git("rm", "-r", "-q", "--cached", "var");
  // The committed base is normalized to ONE line so the sub-case below measures a 2-line diff (1 insertion, 1 deletion) and the fast path applies; the over-threshold sub-case is then 21 lines against that same base.
  writeFileSync(join(repo, "a.ts"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "rig: ignore the run plane");
  resident = "flash-next";
  writeFileSync(join(repo, "a.ts"), "small edit\n");
  writeState({ ...seedState("coding", [["true", "green"]]), schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
  await hooks.session_start({}, ctx);
  const base22 = loads();
  const res22 = await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "rig" }, { id: "T2", status: "passed", result: "rig" }] });
  await hooks.agent_end({}, ctx);
  await new Promise((r) => setTimeout(r, 60));
  const s22 = readState();
  ok("a green first try on a 1-file/2-line diff completes on the code lane", s22.state === "complete" && s22.lane === "flash-next", `${s22.state}/${s22.lane}`);
  ok("the fast path pays ZERO lane loads (one transition for the round, not two)", loads() === base22, `${loads() - base22}`);
  ok("the payload reports the fast path and no next lane", res22?.details?.fast_path === true && res22?.details?.next_lane === null, JSON.stringify(res22?.details));
  ok("the accepted phase is recorded by name for the rail", `${s22.phases.at(-1)?.notes}`.includes("fast path"), JSON.stringify(s22.phases.at(-1)?.notes));
  ok("the fast path tags the checkpoints an accepted verification would tag", Object.keys(s22.checkpoints ?? {}).length === 2, JSON.stringify(s22.checkpoints));
  // Counterfactual: the same report with a 20-line diff is over the threshold, so the verifier
  // swap is paid — exactly once.
  resident = "flash-next"; // the case below pays a swap, so start it on the coder lane
  writeFileSync(join(repo, "a.ts"), "line\n".repeat(20));
  writeState({ ...seedState("coding", [["true", "green"]]), schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [], checkpoints: {} });
  await hooks.session_start({}, ctx);
  const base23 = loads();
  const res23 = await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "rig" }, { id: "T2", status: "passed", result: "rig" }] });
  await hooks.agent_end({}, ctx);
  await new Promise((r) => setTimeout(r, 60));
  ok("over the threshold the verifier swap is paid EXACTLY once", loads() - base23 === 1, `${loads() - base23}`);
  ok("over the threshold the run reaches verifying, not complete", readState().state === "verifying" && res23?.details?.fast_path === undefined, `${readState().state}/${JSON.stringify(res23?.details)}`);
  resident = "flash-next"; // as above: a resident verifier lane pays no load (the flip guard)
  // A round that already took a rejection is not a first try, however small its diff.
  writeFileSync(join(repo, "a.ts"), "tiny again\n");
  writeState({
    ...seedState("coding", [["true", "green"]]),
    schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, checkpoints: {},
    rejection_history: [{ round: 1, at: "2030-01-01T00:00:00.000Z", kind: "task", reason: "pre-swap gate red: false", task_id: "T1" }],
  });
  await hooks.session_start({}, ctx);
  const base24 = loads();
  await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "rig" }, { id: "T2", status: "passed", result: "rig" }] });
  await hooks.agent_end({}, ctx);
  await new Promise((r) => setTimeout(r, 60));
  ok("a round with a rejection is not a FIRST TRY, so the swap is paid", loads() - base24 === 1 && readState().state === "verifying", `${loads() - base24}/${readState().state}`);
}
const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ checks, notes, requests: reqLog.length }, null, 1));
if (failed.length > 0) {
  console.error(JSON.stringify({ failed: failed.map((f) => `${f.name} (${f.detail})`) }, null, 1));
  process.exit(1);
}
console.log("gate rig: all checks pass");
process.exit(0);
