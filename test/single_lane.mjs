#!/usr/bin/env node
// single_lane.mjs — the SINGLE-LANE mode, one whole round, at ZERO pack swaps.
//
// The box this runs on carries one pack's worth of RAM: flash-next is resident (basalt RSS 52.9 GiB,
// `MemAvailable` 63.9-64.1 GiB) and the deepseek pack is 242 GiB on disk / ~120 GiB of RAM, so the
// start's preflight load of the thinking lane is a swap the box cannot take — the operator's own
// host-RAM floor (`FADE_ORCHESTRATE_RAM_MIN_FREE_MIB`, 64 GiB by default) sits exactly on the box's
// operating point, and the off-router verifier endpoint is down because both GPUs are full of
// basalt. The only runnable configuration is ONE lane:
// `FADE_ORCHESTRATE_THINK_LANE == FADE_ORCHESTRATE_CODE_LANE` == the resident entry. Zero swaps,
// zero RAM events.
//
// Two halves, both run against a stub router on an ephemeral port — no omp CLI, no basalt, no
// provider, and the operator's real `~/.local/state/fade-orchestrator/` claim is never touched:
//
// A. THE PREFLIGHT, on a router that cannot take the swap. A start needs a load only when the
//    CENSUS does not already name the lane resident, so the three shapes are: the resident entry
//    with a HOSTILE health line (the gate is never asked — the run starts at ZERO loads), a lane
//    that must be loaded into a context the health line refuses (refused at ZERO loads, the cause
//    named), and a lane loaded into a healthy context that never reports it loaded (the one load is
//    paid, then the census refuses). Every refusal writes NOTHING and releases its claim.
//
// B. THE ROUND, once the entry is resident. Every lane-role decision used to be keyed by LANE, so
//    with one entry the two roles collapsed onto one answer and the mode was unusable:
//      * the tool policy removed the mutating tools whenever the landing's lane was the thinking
//        lane, so the single lane's CODER was read-only forever and every task landed `blocked`;
//      * a `{ [THINK_LANE]: "high", [CODE_LANE]: "low" }` literal is a duplicate key whose value is
//        `low`, so planning and verifying silently ran at LOW thinking;
//      * the landing briefing was picked by `lane === CODE_LANE`, so a single-lane run's `verifying`
//        landing got the CODE page.
//    The fix keys each landing on its ROLE — `landingRole(state, lane)` — and this rig is that proof,
//    end to end on one run: planning lands `high` + a read-only set that keeps `fade_phase`, coding
//    lands `low` + its writers + the CODE page, verifying lands `high` + read-only + the VERIFY page
//    (and its `edit` is blocked by the guard the coder's is not), and EVERY landing pays ZERO
//    `POST /v1/load` because the entry it asks for is already resident. Two-lane behaviour is
//    untouched.
//
// Usage: node test/build.mjs && node test/single_lane.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestBundle, ROOT } from "./build.mjs";

// The rig must not inherit the CALLER's session identity: `isDelegatedSession` reads a session file
// nested inside a dated parent dir as a delegated subagent, and a delegated session never adopts a
// run — every phase would be refused and no landing would ever happen.
delete process.env.PI_SESSION_FILE;
delete process.env.PI_SESSION_ID;

// The rig IS its acceptance command, so it builds the bundle it imports.
buildTestBundle();

const fixtures = [];
/** One fixture per process (`mkdtempSync`, never a fixed name), swept on exit — the hygiene
 *  `test/gate_rig.mjs` carries, so parallel rigs never delete each other's tree mid-assertion. */
function fixture(tag) {
  const repo = mkdtempSync(join(tmpdir(), `fade-single-lane-${tag}-`));
  fixtures.push(repo);
  const runDir = join(repo, "var", "omp-orchestrate");
  mkdirSync(runDir, { recursive: true });
  // The run root is a working tree BEFORE the extension loads: `isGitRepo` caches its probe, the
  // phase synthesizer reads `git status --porcelain`, and an accepted verification tags a checkpoint
  // per passed task, which needs a HEAD.
  const gitAt = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  gitAt("init", "-q");
  gitAt("config", "user.email", "rig@localhost");
  gitAt("config", "user.name", "fade-orchestrator-rig");
  writeFileSync(join(repo, "a.ts"), "seed\n");
  gitAt("add", "-A");
  gitAt("commit", "-q", "-m", "rig seed");
  // The router claim lives per router under `~/.local/state/fade-orchestrator/<router>` by default.
  // Every fixture names its own plane: a test run must never claim (or refuse on) the router the
  // operator is using. The stub router below is the second guarantee — the real one is never named.
  const claimDir = join(repo, "var", "orchestrator-claim");
  return { repo, runDir, claimDir, stateFile: join(runDir, "state.json"), claimFile: join(claimDir, "orchestrator.lock") };
}
process.on("exit", () => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

// ---- stub router: flash-next RESIDENT, deepseek OFFLOADED ----
// The measured live basalt `/health` shape: `loaded` is a BOOLEAN ("is a pack resident"), the
// resident lane rides under `model`, `percent` is null at rest and `swap` is null between swaps.
// Two hostile shapes drive the preflight blocks: `hostile` answers `/health` with a line the
// pre-unload gate refuses (a fatal state and zero free VRAM), `offloaded` answers the census with no
// loaded entry. The first proves ZERO `POST /v1/load`; the second is the census refusal.
const reqLog = [];
let healthMode = "resident";
let censusMode = "resident";
const server = http.createServer(async (req, res) => {
  reqLog.push(`${req.method} ${req.url}`);
  let body = "";
  for await (const chunk of req) body += chunk;
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith("/health")) {
    const h = { status: "ok", model: "flash-next", loaded: true, loading: false, service: "basalt", percent: null, swap: null };
    if (healthMode === "hostile") {
      h.status = "cuda_fatal";
      h.state = "cuda_fatal";
      h.vram_free_mib = 0;
    }
    return send(200, h);
  }
  if (req.url === "/v1/models")
    return send(200, {
      data: [
        { id: "flash-next", status: { value: censusMode === "resident" ? "loaded" : "offloaded" } },
        { id: "deepseek", status: { value: "offloaded" } },
      ],
    });
  if (req.url === "/v1/load" && req.method === "POST") {
    const { model } = JSON.parse(body || "{}");
    return send(200, { ok: true, model });
  }
  if (req.url === "/metrics") return send(200, {});
  send(404, { error: "unknown" });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.FADE_ORCHESTRATE_ROUTER = `http://127.0.0.1:${server.address().port}`;

// The module consts read the environment AT IMPORT, so every lever is set before the `import()`
// below — the same ordering `test/load_hostile.mjs` proves is load-bearing.
// THE MODE UNDER TEST: one entry running both roles. The code lane's default is already
// `flash-next`; the thinking lane is named explicitly so the rig states the configuration it runs.
process.env.FADE_ORCHESTRATE_THINK_LANE = "flash-next";
process.env.FADE_ORCHESTRATE_CODE_LANE = "flash-next";
process.env.FADE_ORCHESTRATE_HEADLESS = "1";
// The host-RAM floor is a real `/proc/meminfo` reading and the rigs run on the operator's box,
// where a 64 GiB floor would refuse loads for reasons unrelated to the case under test. The round's
// whole thesis is that this mode pays NO loads, so the floor is off and `loads() === 0` is proved at
// the router, not granted by a refusal. The preflight's refusal block rides on the stub's own
// `/health` line: a context that stopped saying `ok` is the line the pre-unload gate reads.
process.env.FADE_ORCHESTRATE_RAM_MIN_FREE_MIB = "0";
process.env.FADE_ORCHESTRATE_VRAM_MIN_FREE_MIB = "4096";
// The settle window and the idle gate in milliseconds: the stub answers idle, so a landing that
// asked for a load would pay it instantly and count it. Nothing here waits on a real 13-25 s swap.
process.env.FADE_ORCHESTRATE_SETTLE_POLL_MS = "20";
process.env.FADE_ORCHESTRATE_SETTLE_MAX_MS = "60";
process.env.FADE_ORCHESTRATE_GATE_POLL_MS = "5";
process.env.FADE_ORCHESTRATE_GATE_BUDGET_MS = "15";
// The off-router verifier probe and the red-gate triage bin are out of this rig's scope (the gate
// runs green); the flip ledger's windows are pinned so a stray swap would read as churn.
process.env.FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS = "0";
process.env.FADE_ORCHESTRATE_GATE_TRIAGE_BIN = ":";
process.env.FADE_ORCHESTRATE_LANE_AUTH_GRACE_MS = "0";
process.env.FADE_ORCHESTRATE_FLIP_WINDOW_MS = "60000";
process.env.FADE_ORCHESTRATE_FLIP_BREAKER_AT = "3";
// The metrics tick exists to watch a lane a live run holds; the rig's router answers a static line,
// so one tick per instance for the whole run keeps the request log readable.
process.env.FADE_ORCHESTRATE_METRICS_INTERVAL_MS = "600000";

// ---- fake pi + ctx (the gate rig's contract, with `setThinkingLevel` RECORDED) ----
/** The tools a host reports ACTIVE at start. */
const HOST_TOOLS = ["read", "bash", "edit", "write", "grep", "task"];
function makeHost(cwd) {
  const tools = {};
  const commands = {};
  const hooks = {};
  /** Every `sendUserMessage` text, in order: the briefings land here, so the rig reads the page each
   *  landing owes rather than a flag the extension set for itself. */
  const sent = [];
  /** Every `setThinkingLevel` value, in order. `test/gate_rig.mjs` discards this call; the
   *  single-lane defect IS the thinking level (a duplicate-key map answers `low` for both roles), so
   *  the rig keeps the whole sequence and judges the LAST value at each landing. */
  const thinking = [];
  const notes = [];
  let activeTools = [...HOST_TOOLS];
  const widgets = new Map();
  const statusRows = new Map();
  const pi = {
    registerTool: (t) => void (tools[t.name] = t),
    registerCommand: (name, c) => void (commands[name] = c),
    on: (evt, h) => void (hooks[evt] = h),
    registerShortcut: () => {},
    setModel: async () => ({ switched: true }),
    setThinkingLevel: (level) => void thinking.push(level),
    getActiveTools: () => activeTools,
    setActiveTools: (t) => void (activeTools = t),
    sendUserMessage: (t) => void sent.push(t),
  };
  const ctx = {
    hasUI: false,
    cwd,
    modelRegistry: { find: () => ({ id: "stub" }) },
    getContextUsage: () => ({ tokens: 41234, contextWindow: 1048576, percent: 3.9, baselineSource: "test" }),
    abort: () => {},
    isIdle: () => true,
    hasPendingMessages: () => false,
    signal: undefined,
    ui: {
      setStatus: (key, text) => void (text === undefined ? statusRows.delete(key) : statusRows.set(key, text)),
      setWidget: (key, lines, opts) => void (lines === undefined ? widgets.delete(key) : widgets.set(key, { lines, opts })),
      notify: (m) => void notes.push(m),
      setWorkingMessage: () => {},
      custom: async () => undefined,
      onTerminalInput: () => () => {},
    },
  };
  return { pi, ctx, tools, commands, hooks, sent, thinking, notes, get activeTools() { return activeTools; } };
}

/**
 * The mutating tools, READ OUT OF THE SOURCE. The verifier sandbox is a denylist (`MUTATING_TOOLS`),
 * so an allowlist copied into this rig would go stale the day a writer is added — and the rig's
 * central assertion is that the CODER keeps its writers. Parsed from the literal, with the parse
 * itself asserted.
 */
const mutLiteral = /const MUTATING_TOOLS[^=]*=\s*\{([^}]*)\}/.exec(readFileSync(join(ROOT, "src", "index.ts"), "utf8"));
assert.ok(mutLiteral, "single_lane: the MUTATING_TOOLS literal was not found in src/index.ts — the rig reads the denylist, it does not guess it");
const MUTATING = [...mutLiteral[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*true/g)].map((m) => m[1]);
assert.ok(MUTATING.length >= 3, `single_lane: MUTATING_TOOLS parsed to ${JSON.stringify(MUTATING)} — expected the writer denylist`);
/** The writers at stake: the denylist ∩ the tools a host actually carries. `apply_patch` and the
 *  notebook writer live on real hosts; demanding a tool this host never registered would prove
 *  nothing, and asserting the sandbox stripped it would be true of an empty set. The rig's host's
 *  writers are the test's writers, and the denylist names every one of them. */
const HOST_WRITERS = MUTATING.filter((t) => HOST_TOOLS.includes(t));

// The briefing headers, VERBATIM from `briefings.plan` / `briefings.code` / `briefings.verify`.
const planHeader = (id) => `Phase 0 (planning), round 1 of orchestrated run ${id}.`;
const codeHeader = (id) => `Phase 1 (coding), round 1 of orchestrated run ${id}.`;
const verifyHeader = (id) => `Phase 2 (verification), round 1 of orchestrated run ${id}.`;
const firstLine = (t) => String(t).split("\n")[0];

const loads = () => reqLog.filter((r) => r === "POST /v1/load").length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A ZERO-load contract is proved by waiting, never by settling on a number that never arrives
 *  (`test/gate_rig.mjs`: absence keeps its fixed sleep; a count that must ARRIVE is settled). */
const ZERO_WAIT_MS = 2000;
/** The switch is queued on the extension's serial chain, so the tool set and the thinking level land
 *  a few ticks AFTER the call that asked for them. Settle on the field the landing OWNS — its
 *  briefing page is the last effect of a landing, written after `setModel`, `setThinkingLevel` and
 *  the tool policy — bounded, then judge the rest. A fixed sleep overruns on a loaded runner. */
const settleLanding = async (h, from, cap = 8000) => {
  const t0 = Date.now();
  while (h.sent.length <= from && Date.now() - t0 < cap) await sleep(10);
  return h.sent.length - from;
};
/** The preflight refusal is a `notify` behind a router round-trip, so it arrives a tick after the
 *  verb returns: settle on the note ARRIVING (bounded), then judge its words — the same discipline
 *  a landing's page gets. */
const settleNote = async (h, cap = 6000) => {
  const t0 = Date.now();
  while (h.notes.length === 0 && Date.now() - t0 < cap) await sleep(10);
  return h.notes.join("\n");
};
/** The state file as it stands at this instant (after a settle has proved it written). */
const readStateSync = (stateFile) => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {});
const readStateWhen = async (stateFile, pred, cap = 6000) => {
  const read = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const t0 = Date.now();
  let s = existsSync(stateFile) ? read() : {};
  while (!pred(s) && Date.now() - t0 < cap) {
    await sleep(10);
    s = existsSync(stateFile) ? read() : {};
  }
  return s;
};
const task = (id) => ({ id, objective: `${id} objective`, files: ["a.ts"], acceptance: "true", dependencies: [] });

const checks = [];
const ok = (name, cond, detail = "") => {
  checks.push(name);
  assert.ok(cond, `${name} — observed: ${detail}`);
};

const mod = await import("../.test-build/index.mjs");

ok(
  "the rig runs the mode under test: ONE entry named by both lane levers",
  process.env.FADE_ORCHESTRATE_THINK_LANE === process.env.FADE_ORCHESTRATE_CODE_LANE,
  `THINK=${process.env.FADE_ORCHESTRATE_THINK_LANE} CODE=${process.env.FADE_ORCHESTRATE_CODE_LANE}`,
);
ok("the denylist parsed from the source is the sandbox's own list", MUTATING.length >= 3 && MUTATING.includes("edit") && MUTATING.includes("write"), JSON.stringify(MUTATING));

// ==================== A. THE PREFLIGHT, MEASURED AGAINST THIS BOX'S SHAPE ====================
// A start needs a load only when the CENSUS does not already name the lane resident. The three
// shapes below are the three answers `/orchestrate <goal>` can get on a box that cannot swap:
// the resident entry (no gate, no byte, the run starts), a lane that must be loaded into a context
// the health line refuses (refused at ZERO loads), and a lane that must be loaded into a healthy
// context that never reports it loaded (refused after the ONE load it attempted).
/** One `/orchestrate <goal>` against one fixture, with the stub's health/census shapes set. */
const startProbe = async (tag, health, census) => {
  const f = fixture(tag);
  process.env.FADE_ORCHESTRATE_LOCK_DIR = f.claimDir;
  healthMode = health;
  censusMode = census;
  const h = makeHost(f.repo);
  mod.default(h.pi);
  await h.hooks.session_start({}, h.ctx);
  const before = loads();
  const outcome = await h.commands.orchestrate.handler("single lane smoke", h.ctx).then(() => "resolved", (e) => `REJECTED ${String(e && e.message)}`);
  return { f, h, before, outcome };
};
{
  // A1. The single-lane box: flash-next resident, and the router's health line HOSTILE. The run
  //     needs no load, so the gate is never asked and the run starts at ZERO swaps.
  const { f, h, before, outcome } = await startProbe("resident-hostile-health", "hostile", "resident");
  ok("the resident-lane start resolves (no rejection)", outcome === "resolved", outcome);
  const sent = await settleLanding(h, 0);
  ok("the hostile health line does NOT block a start that needs no load", sent === 1, `pages=${JSON.stringify(h.sent.map(firstLine))}`);
  await sleep(ZERO_WAIT_MS);
  ok("it pays ZERO POST /v1/load", loads() === before, `loads=${loads() - before}`);
  const s = readStateSync(f.stateFile);
  ok("the run is live in planning on the resident lane", s.state === "planning" && s.lane === "flash-next", JSON.stringify({ state: s.state, lane: s.lane }));
  ok("the planner landed at HIGH thinking on the single lane", JSON.stringify(h.thinking) === '["high"]', JSON.stringify(h.thinking));
  ok("its page is the plan briefing", firstLine(h.sent[0]) === planHeader(s.run_id), firstLine(h.sent[0]));
  // The shared extension state now holds this run; `/orchestrate halt` ends it (the round below
  // starts a fresh one, and a live run owned by another repo is a refusal by design).
  await h.commands.orchestrate.handler("halt", h.ctx);
  ok("the probe run halts", readStateSync(f.stateFile).state === "stopped", `state=${readStateSync(f.stateFile).state}`);
}
{
  // A2. The lane must be loaded and the health line refuses the context: refused in words, at ZERO
  //     loads, nothing written, the claim released. The rig states this is the operator's box.
  const { f, h, before, outcome } = await startProbe("gate-refuses", "hostile", "offloaded");
  ok("the refused start resolves (no rejection)", outcome === "resolved", outcome);
  const note = await settleNote(h);
  ok(
    "the gate refusal names the health line and ZERO loads",
    /start refused at ZERO loads/.test(note) && /cuda_fatal/.test(note) && /cannot serve the next lane/.test(note),
    note.slice(0, 220),
  );
  ok("the refused start pays ZERO POST /v1/load (the gate answers before the byte)", loads() === before, `loads=${loads() - before}`);
  ok("the refused start writes NOTHING", !existsSync(f.stateFile) && !existsSync(join(f.runDir, "ACTIVE.json")), `${f.stateFile} exists=${existsSync(f.stateFile)}`);
  ok("the refused start releases its router claim", !existsSync(f.claimFile), readdirSync(f.claimDir).join(",") || "(claim dir empty)");
  ok("the refused start asked for no landing", h.sent.length === 0, JSON.stringify(h.sent.map(firstLine)));
}
{
  // A3. The gate passes, the load lands, and the census never reports the lane loaded: the start is
  //     refused for that reason and writes nothing. This path pays the ONE load it attempted.
  const { f, h, before, outcome } = await startProbe("census-refuses", "resident", "offloaded");
  ok("the census refusal resolves (no rejection)", outcome === "resolved", outcome);
  const note = await settleNote(h);
  ok(
    "the census refusal names the missing lane",
    /preflight expected flash-next loaded, router reports none; nothing written/.test(note),
    note.slice(0, 220),
  );
  ok("the census check sits behind the load, so this refusal paid the ONE load it attempted", loads() === before + 1, `loads=${loads() - before}`);
  ok("the census refusal writes NOTHING", !existsSync(f.stateFile) && !existsSync(join(f.runDir, "ACTIVE.json")), `${f.stateFile} exists=${existsSync(f.stateFile)}`);
  ok("the census refusal releases its router claim", !existsSync(f.claimFile), readdirSync(f.claimDir).join(",") || "(claim dir empty)");
}

// ======================================= B. THE ROUND ========================================
// The resident entry, the census agreeing, one lane for both roles.
healthMode = "resident";
censusMode = "resident";

const f = fixture("run");
process.env.FADE_ORCHESTRATE_LOCK_DIR = f.claimDir;
const h = makeHost(f.repo);
mod.default(h.pi);
const exec = (phase, payload) => h.tools.fade_phase.execute("id", { phase, payload: JSON.stringify(payload) }, null, null, h.ctx);
let runId = "";
/** The round's own counter: block A3 pays ONE load on purpose, so the round's zero-load thesis is
 *  measured from HERE, at the router, not from the top of the process. */
const roundMark = loads();

await h.hooks.session_start({}, h.ctx);

// 1. THE START. `/orchestrate <goal>` preflights the thinking lane. With one lane the entry it asks
//    for is the resident one, so `loadLane` answers "already resident" and no byte is sent.
{
  const before = loads();
  await h.commands.orchestrate.handler("single lane smoke", h.ctx);
  const s = await readStateWhen(f.stateFile, (x) => x.state === "planning" && x.lane === "flash-next");
  await settleLanding(h, 0);
  runId = s.run_id;
  const act = h.activeTools;
  const claims = existsSync(f.claimFile) ? [readFileSync(f.claimFile, "utf8").trim()] : [];
  const claim = claims.length === 1 ? JSON.parse(claims[0]) : {};
  await sleep(ZERO_WAIT_MS);
  ok("the single-lane start pays ZERO POST /v1/load", loads() === before, `loads=${loads() - before} after a ${ZERO_WAIT_MS} ms wait`);
  ok("state.json reaches planning on the resident lane", s.state === "planning" && s.lane === "flash-next", `${s.state}/${s.lane}`);
  ok("ACTIVE.json exists", existsSync(join(f.runDir, "ACTIVE.json")), join(f.runDir, "ACTIVE.json"));
  ok("the router claim file exists in the lock dir", claims.length === 1 && claim.run_id === s.run_id, `${readdirSync(f.claimDir).join(",")} run_id=${claim.run_id}`);
  ok("the starting landing's page is the PLAN briefing", firstLine(h.sent.at(-1)) === planHeader(s.run_id), firstLine(h.sent.at(-1)));
  ok("the starting landing runs at HIGH thinking", h.thinking.at(-1) === "high", JSON.stringify(h.thinking));
  ok(
    "the starting landing is the THINKING role: read-only, fade_phase kept",
    HOST_WRITERS.every((t) => !act.includes(t)) && MUTATING.every((t) => !act.includes(t)) && act.includes("fade_phase"),
    JSON.stringify(act),
  );
}

// 2. THE PLANNER LANDING, re-armed on the resident entry. The landing's ROLE is the state's, not the
//    lane's: `planning` is the thinking role, so the page is the plan page, the level is `high`, and
//    the writers are off — the same sandbox the two-lane verifier has, at zero loads. `/orchestrate
//    code` is the operator's `[c]`: with no tasks it re-arms `planning` and asks for the code lane,
//    which in this mode IS the resident entry, so the landing is free.
{
  const mark = h.sent.length;
  const before = loads();
  await h.commands.orchestrate.handler("code", h.ctx);
  await settleLanding(h, mark);
  const act = h.activeTools;
  const st = await readStateWhen(f.stateFile, (x) => x.state === "planning");
  ok("the planner landing pays ZERO POST /v1/load", loads() === before, `loads=${loads() - before}`);
  ok("the planner landing is HIGH thinking (the duplicate-key map answers low)", h.thinking.at(-1) === "high", JSON.stringify(h.thinking));
  ok("the planner's active set carries NO mutating tool", MUTATING.every((t) => !act.includes(t)) && HOST_WRITERS.every((t) => !act.includes(t)), JSON.stringify(act));
  ok("the planner keeps fade_phase (a verifier with no phase tool cannot report)", act.includes("fade_phase"), JSON.stringify(act));
  ok("the planner's page is the PLAN briefing", firstLine(h.sent.at(-1)) === planHeader(runId), firstLine(h.sent.at(-1)));
  ok("the planner landing kept the run in planning", st.state === "planning", st.state);
}

// 3. PLANNING_DONE → THE CODER LANDING. The defect: keyed by lane, this landing strips the writers
//    and the run dies with every task `blocked`, and the thinking level is `low` for every role.
//    Keyed by role, the coder keeps its writers, lands at `low`, and gets the CODE page.
{
  await exec("planning_done", { tasks: [task("T1")], checks: [["bash -lc 'echo ok'", "exit 0"]] });
  const planned = await readStateWhen(f.stateFile, (x) => x.state === "coding");
  ok("planning_done moves the run to coding", planned.state === "coding" && planned.tasks.length === 1, `${planned.state} tasks=${planned.tasks.length}`);
  const mark = h.sent.length;
  const before = loads();
  await h.hooks.agent_end({}, h.ctx);
  await settleLanding(h, mark);
  const act = h.activeTools;
  ok("the CODER landing pays ZERO POST /v1/load", loads() === before, `loads=${loads() - before}`);
  ok("the coder lands at LOW thinking", h.thinking.at(-1) === "low", JSON.stringify(h.thinking));
  ok(
    "the coder's active set carries EVERY mutating tool (nothing stripped)",
    HOST_WRITERS.length >= 2 && HOST_WRITERS.every((t) => act.includes(t)) && HOST_TOOLS.every((t) => act.includes(t)),
    `${JSON.stringify(act)} want the host writers ${JSON.stringify(HOST_WRITERS)} of the denylist ${JSON.stringify(MUTATING)}`,
  );
  ok("the coder's page is the CODE briefing, not the verify page", firstLine(h.sent.at(-1)) === codeHeader(runId), firstLine(h.sent.at(-1)));
  ok("the round has paid ZERO POST /v1/load through the coder landing", loads() === roundMark, `round loads=${loads() - roundMark}`);
}

// 4. THE CODER CAN EDIT. The `tool_call` hook is the enforcement layer, and the guard is the
//    verifier's turn (`state: verifying`), never the coder's. A blocked writer here is the exact
//    live failure: a single-lane run whose every task lands `blocked`.
{
  const answer = await h.hooks.tool_call({ type: "tool_call", toolName: "edit", toolCallId: "c1", input: { path: "a.ts" } }, h.ctx);
  ok("the coder's edit is NOT blocked", answer?.block !== true, JSON.stringify(answer));
  // The edit LANDS, over the fast-path threshold (`FASTPATH_LINES`, 15 by default): the gate's green
  // exit codes must NOT be allowed to complete the run on the coder's page. The run has to reach
  // `verifying` and be briefed as a verifier, which is the landing this rig exists to prove.
  writeFileSync(join(f.repo, "a.ts"), "seed\n" + Array.from({ length: 20 }, (_, i) => `// coder line ${i}\n`).join(""));
}

// 5. CODING_DONE → VERIFYING. The gate runs the plan's own checks on the coder (`bash -lc 'echo ok'`
//    exits 0, so it is green, and the tree is over the fast-path threshold), and the boundary lands
//    the verifier: `high`, read-only with `fade_phase`, and the VERIFY page — the branch a
//    lane-keyed briefing gave the coder.
{
  const before = loads();
  await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "bash -lc 'echo ok' → exit 0" }] });
  const gated = await readStateWhen(f.stateFile, (x) => x.state === "verifying");
  ok("a green gate moves the run to verifying", gated.state === "verifying" && gated.gate_last?.passed === true, `${gated.state} gate=${JSON.stringify(gated.gate_last?.passed)}`);
  ok("the green gate paid ZERO POST /v1/load", loads() === before, `loads=${loads() - before}`);
  const mark = h.sent.length;
  await h.hooks.agent_end({}, h.ctx);
  await settleLanding(h, mark);
  const act = h.activeTools;
  ok("the verifier landing pays ZERO POST /v1/load", loads() === before, `loads=${loads() - before} (total ${loads()})`);
  ok("the verifier lands at HIGH thinking", h.thinking.at(-1) === "high", JSON.stringify(h.thinking));
  ok("the verifier's active set is read-only and carries fade_phase", MUTATING.every((t) => !act.includes(t)) && HOST_WRITERS.every((t) => !act.includes(t)) && act.includes("fade_phase"), JSON.stringify(act));
  ok("the verifier's page is the VERIFY briefing, NOT the code page", firstLine(h.sent.at(-1)) === verifyHeader(runId), firstLine(h.sent.at(-1)));
  const blocked = await h.hooks.tool_call({ type: "tool_call", toolName: "edit", toolCallId: "c2", input: { path: "a.ts" } }, h.ctx);
  ok("the verifier's edit IS blocked, by the rule named", blocked?.block === true && /read-only/.test(String(blocked.reason ?? "")), JSON.stringify(blocked));
}

// 6. THE ACCEPTED VERDICT closes the run — and the router's counter answers for the whole round.
{
  const before = loads();
  await exec("verification_done", { verdict: "accepted", checks: [["bash -lc 'echo ok'", "exit 0"]], notes: "single-lane rig: the gate's rows re-ran green", tasks: [] });
  const s = await readStateWhen(f.stateFile, (x) => x.state === "complete");
  ok("the accepted verdict completes the run", s.state === "complete", s.state);
  ok("the WHOLE single-lane round paid ZERO POST /v1/load", loads() === roundMark, `round loads=${loads() - roundMark} of ${reqLog.length} router requests`);
  ok("the completing verdict paid no load at its own boundary", loads() === before, `loads=${loads()}`);
}

// 7. STOP --CLEAR hands the router back: the claim is released and the resident lane stays, still at
//    zero loads. A single-lane run never needed the lane back.
{
  const before = loads();
  await h.commands.orchestrate.handler("stop --clear", h.ctx);
  ok("stop --clear releases the router claim", !existsSync(f.claimFile), readdirSync(f.claimDir).join(",") || "(claim dir empty)");
  ok("stop --clear clears the adoption pointer", !existsSync(join(f.runDir, "ACTIVE.json")), join(f.runDir, "ACTIVE.json"));
  ok("the release paid ZERO POST /v1/load", loads() === before, `loads=${loads() - before}`);
}

await new Promise((resolve) => server.close(resolve));
console.log("single-lane rig: all checks pass");
for (const c of checks) console.log(`  ok ${c}`);
console.log(`  router requests: ${reqLog.length}, POST /v1/load in the round: ${loads() - roundMark}, thinking levels: ${JSON.stringify(h.thinking)}`);
process.exit(0);
