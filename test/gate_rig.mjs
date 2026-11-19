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
//  14. the THRASH BREAKER: at FADE_ORCHESTRATE_FLIP_BREAKER_AT swaps away from the run's lane the
//      loop pays ZERO `POST /v1/load` and HALTS with the churn in the operator note, and
//      `/orchestrate lanes reset` clears the ledger and lands the owed lane in exactly ONE load;
//      two back-to-back switch requests for one lane pay ONE load (the chain is serialised).
//  15. the state write is async and COALESCED (`writeJsonAsync`/`coalesceWrite`): at the phase
//      boundary the rig reads, `state.json` parses as a whole record and no `.tmp` sibling
//      survives the rename.
//  16. ONE orchestrator per ROUTER: a start on a claimed router is refused, naming the holder's
//      pid, run, repo and host, paying ZERO lane load and writing no state; a free router is
//      claimed at the start, naming this pid and the new run; `stop` releases the claim. The rig
//      isolates the claim plane in `FADE_ORCHESTRATE_LOCK_DIR`, never the operator's.
//  21. THE VERIFICATION DESK: a `task` call's census counts ONLY its verification-carrying workers;
//      one worker's request pays ZERO `POST /v1/load` while its peers are unregistered; a closed
//      batch pays EXACTLY ONE load for the WHOLE batch; a request arriving during a pass lands in
//      the NEXT batch; verdicts fan out BY ID and the claimed batch closes; answering an unclaimed
//      batch, a foreign id, or a partial id set is refused by name.
//      A READY batch is claimed at an OWNER TOOL CALL, not only at a turn boundary: an owner that
//      delegated verifying workers is blocked in `wait` on sessions blocked on its verdict, so no
//      `agent_end` ever comes (the deadlock is measured in a live run); a later boundary pays
//      nothing for a batch already claimed.
//  22. THE CHURN ROUTE: with churn declared a closed batch pays ZERO loads, is claimed once and
//      routed to the verification SUBAGENT on a NON-ROUTER model; the loop is handed the exact
//      `task` call as a command; the route stays for every later batch; `/orchestrate lanes reset`
//      releases it. Block 19b proves the thrash breaker MARKS the desk and routes the batch it halts.
//  17. THE ON-DISK GATE REPAIR: a `state.json` that re-declares a row and re-roots the run is
//      judged AT THE NEW ROOT, both refreshes are announced, and the taken repair is written back
//      as the loop's own record — the live failure it guards is a run rooted at repo A whose tasks
//      and rows name repo B, gate red every round on rows that pass rc=0 at B.
//  29. A FINISHED RUN OWNS NOTHING, AND ITS DESK IS CLOSED AT THE DOOR. `state.json` is ONE slot
//      that keeps naming the last run, so every later session in the repo adopts it. Proved: the
//      adoption is RECORDS-ONLY — no login line, NO metrics poll (the LIVE adoption in the same
//      block is the control that pays the router reads, the finished one pays ZERO), the status row
//      stays cleared — while `/orchestrate status` and the panel keep answering the run. And
//      `fade_verify` answers in the same tick with the cause instead of parking its worker for
//      `DESK_WAIT_MS` on a batch `dispatchDeskBatch` refuses for a terminal run (index.ts:626),
//      `fade_verdicts` writes nothing into a dead desk, no `verify/desk.json` is created, and the
//      block pays ZERO `POST /v1/load`.
//  30. THE HAND-BACK AND THE HOSTILE FLIP: the code lane is the run's worker and the thinking lane
//      a guest, so the session HOLDING THE ROUTER CLAIM keeps authority over the router. A
//      thinking-lane turn that ends with no `fade_phase` call hands the router to the code lane at
//      that boundary in ONE load and carries its protocol page onto the code lane's landing
//      briefing; `verifying` — the one state the thinking lane owns — pays ZERO, a terminal boundary
//      pays ZERO, an outside `POST /v1/load` is classified HOSTILE and the owner lands its
//      authorized lane in ONE load, and a session with NO claim pays ZERO and writes NOTHING.
//
// Usage: node test/gate_rig.mjs
import http from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname, tmpdir, userInfo } from "node:os";

/**
 * The account the REDACTOR masks, resolved the way `ui.ts` `account()` resolves it: `$USER` first,
 * then the passwd entry. Guessing (the old `"someone"` fallback) tested a string the redactor never
 * masks: it is green on a runner whose `$USER` is set and red in the fade-ci container, because
 * that container runs with `--user 1000:1000` and no login name reaches `$USER`. So the fixture
 * resolves the account through the same fallback the redactor uses; it never names one.
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

// ONE fixture per process, the same hygiene `test/pty_rig.mjs` carries (`mkdtempSync`, never a
// fixed name). The fixture root is the plane everything lives under — `state.json`, the ledgers,
// the router claim, the git repo — and the rigs run in parallel. With a fixed name and a
// `rmSync` at entry, the second rig deletes the tree the first is mid-assertion on, and its first
// `git rm -r --cached var` lands in the repo the other rig created seconds earlier (measured as
// `fatal: pathspec 'var' did not match any files`, exit 128, in a rig whose every check had
// printed `ok`).
const repo = mkdtempSync(join(tmpdir(), "fade-gate-rig-"));
// The fixture is unique per process, so nothing sweeps a dead rig's tree at the next entry: this
// hook removes it on the success path, on the `exit(1)` path, and on a throw between them — a rig
// that dies mid-assertion leaves no multi-megabyte tree in /tmp for the next CI run to find.
process.on("exit", () => rmSync(repo, { recursive: true, force: true }));
mkdirSync(join(repo, "var", "omp-orchestrate"), { recursive: true });

// The run root IS a working tree BEFORE the extension loads. `isGitRepo` caches its probe for
// `FADE_ORCHESTRATE_REPO_PROBE_TTL_MS` (15 s, longer than this rig's whole run), so a repo that
// appears mid-rig leaves every later git reader riding a cached `false` — measured as the
// checkpoint tags vanishing from a run that completed. A tag also needs a HEAD, so the tree gets an
// identity and a first commit here, exactly as the operator's run root has one.
const gitAt = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
gitAt("init", "-q");
gitAt("config", "user.email", "rig@localhost");
gitAt("config", "user.name", "fade-orchestrator-rig");
writeFileSync(join(repo, "a.ts"), "seed\n");
// Git tracks files, not directories, and the run plane under `var/` is empty at this instant. The
// fast-path block later runs `git rm -r --cached var` (the real repo gitignores `var/`, so the
// orchestrator's own ledger must not be priced as the coder's diff), which needs `var/` to have
// been tracked once. A seed record makes that true, as the runs' own state files did before.
// The placeholder must carry the fixture's run id: `normalizeRun` MINTS one when the file has
// none, and disk adoption is keyed by `run_id` — a minted id refuses every seeded record, so a
// loop that reads the file at all (the repair sync) would judge a run that never matches it.
writeFileSync(join(repo, "var", "omp-orchestrate", "state.json"), JSON.stringify({ run_id: "GATE1" }) + "\n");
gitAt("add", "-A");
gitAt("commit", "-q", "-m", "rig seed");

// The router claim lives per router under `~/.local/state/fade-orchestrator/<router>` by default.
// The rig owns a fixture plane, so it names its own: a test run must never claim (or refuse on) the
// router the operator is using.
process.env.FADE_ORCHESTRATE_LOCK_DIR = join(repo, "var", "orchestrator-claim");

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

// The idle gate and the THRASH BREAKER are configuration, so the rig runs their windows in
// milliseconds (the convention `test/pty_rig.mjs` carries for the metrics tick). They MUST be set
// BEFORE the extension is imported: `GATE_POLL_MS`/`GATE_BUDGET_MS` (src/index.ts) and
// `FLIP_WINDOW_MS`/`FLIP_BREAKER_AT` (src/router.ts) read the environment at module load.
//  * the gate budget: the stub reports a slot ACTIVE while `metricsOn` is true (the decoding shape
//    the ledger block reads), so the live idle gate holds every swap in blocks 5/9/12 for its whole
//    budget. 15 ms is one poll: the load is paid as over-budget, the counters stay honest, and every
//    swap-count assertion stays about exactly one `POST /v1/load`. From block 12 on `metricsOn` is
//    false, so the router reads idle and the gate costs nothing.
//  * the flip window, and the breaker's count at 3: block 19b drives three swaps AWAY from the run's
//    lane and proves the loop stops paying for them.
process.env.FADE_ORCHESTRATE_GATE_POLL_MS = "5";
process.env.FADE_ORCHESTRATE_GATE_BUDGET_MS = "15";
process.env.FADE_ORCHESTRATE_FLIP_WINDOW_MS = "60000";
process.env.FADE_ORCHESTRATE_FLIP_BREAKER_AT = "3";
// The rigs stub the ROUTER; the off-router verifier lane is out of their scope, so the claim-time
// probe is disabled here. Block 27 turns it back on against its own stub lane server.
process.env.FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS = "0";
// Red-gate triage spawns a CLI; the rig's blocks must not pay for it, and block 28 turns it on
// against a stub script so the contract is proved without a subscription.
process.env.FADE_ORCHESTRATE_GATE_TRIAGE = "0";
// The boundary guard that judges the router's RESIDENT lane against the lane the run authorized
// bills a restore load when it fires, and the live grace window (60 s) covers exactly ONE landing —
// a swap is 13-25 s plus settle. The rig judges EVERY boundary, so a hostile flip is caught on the
// next one. Block 30 is the consumer.
process.env.FADE_ORCHESTRATE_LANE_AUTH_GRACE_MS = "0";
// The RAM floor is a REAL box reading (`/proc/meminfo` MemAvailable) and the rigs run on the
// operator's box, where a 64 GiB floor would refuse the discretionary loads for reasons unrelated
// to the case under test. Disabled rig-wide; block 31 flips it per case, which is the whole point of
// reading the floor at call time.
process.env.FADE_ORCHESTRATE_RAM_MIN_FREE_MIB = "0";

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
/** Every `setWorkingMessage` call, in order: the gate names the row it is RUNNING, so the rig can
 *  prove the operator watches progress instead of a frozen terminal. `null` is the clear. */
const working = [];
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
    },
    setWorkingMessage: (m) => void working.push(m ?? null),
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
/** The state publish is coalesced and asynchronous (scenario 15 bounds-waits for the tmp sibling
 *  for the same reason), so a rig that reads the file the instant a phase returns can read the
 *  PREVIOUS record. A persist that does extra work first — the disk-repair sync — widens that race.
 *  Settle on the field the phase OWNS, then the assertion judges that field's VALUE, never its
 *  presence: a stale record that contradicts the expectation still fails. */
const readStateWhen = async (pred, cap = 4000) => {
	const t0 = Date.now();
	let s = readState();
	while (!pred(s) && Date.now() - t0 < cap) {
		await new Promise((r) => setTimeout(r, 10));
		s = readState();
	}
	return s;
};
const loads = () => reqLog.filter((r) => r === "POST /v1/load").length;
/** The switch is queued on the serial chain, so a load lands a few ticks after the call that asked
 *  for it. A fixed sleep overran on the CI runner — the gate's polls, the stub's HTTP and the gate's
 *  check children share one loop there — and read "0 loads" where the loop paid exactly one. So the
 *  rig settles on the count, bounded. A "ZERO loads" contract keeps its fixed sleep: absence is
 *  proved by waiting, not by settling on a number that never arrives. */
const settleLoads = async (from, want = 1, cap = 4000) => {
	const t0 = Date.now();
	while (loads() - from < want && Date.now() - t0 < cap) await new Promise((r) => setTimeout(r, 10));
	return loads() - from;
};
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
  console.error("SC4-PRE", JSON.stringify({ checks: readState().checks, state: readState().state }));
  await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "x" }] });
  // The gate's record is the field this phase owns: settle on it, then judge its value.
  const s = await readStateWhen((x) => x.gate_last && x.run_id === "GATE1");
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
  // The switch is queued on the serial chain (`requestLane`), so the loader runs a few ticks after
  // `agent_end` returns — and with `metricsOn` true the stub reports a slot ACTIVE, so the queued
  // switch first runs the idle gate's whole (millisecond) budget and pays the load as over-budget.
  // The switch is queued on the serial chain, so the load lands a few ticks after `agent_end`
  // returns. The rig WAITS for it, bounded: a fixed 150 ms sleep overran on the CI runner (the
  // gate's polls, the stub's HTTP and the check children share one loop there) and read 0 loads.
  const got = await settleLoads(before, 1);
  await new Promise((r) => setTimeout(r, 200)); // a double-pay, if the chain ever did one, lands here
  const after = loads();
  const s = readState();
  ok("green gate lets agent_end issue exactly one load", got >= 1 && after - before === 1, `${after - before}`);
  ok("green gate reaches verifying", s.state === "verifying", s.state);
  // The async persist: the phase's state reached disk through tmp → fdatasync → rename on
  // `fs.promises`, so the boundary the rig reads shows a WHOLE record — a half file would throw
  // inside `readState`, so reading it IS the proof. No temp file survives the publish; the temp
  // check is a bounded wait (the publish is async) and a leak still fails, naming the file.
  const stateFile = join(repo, "var", "omp-orchestrate", "state.json");
  const tmpAt = () => readdirSync(join(repo, "var", "omp-orchestrate")).filter((n) => n.endsWith(".tmp"));
  let tmpSiblings = tmpAt();
  for (let t0 = Date.now(); tmpSiblings.length > 0 && Date.now() - t0 < 4000; ) {
    await new Promise((r) => setTimeout(r, 10));
    tmpSiblings = tmpAt();
  }
  ok(
	"the async coalesced persist leaves a readable state file and no temp sibling",
	existsSync(stateFile) && tmpSiblings.length === 0 && readState().run_id === "GATE1" && s.state === "verifying",
	`${stateFile} round ${s.round} tmp=[${tmpSiblings.join(",")}]`,
  );
}

// 5b. The on-disk gate repair reaches the GATE (header item 17): the run resumes at repo A, an
// operator patches `state.json` mid-run to re-root to B and re-declare a row that can only pass at
// B, and the gate that follows must run the new row AT B and announce both refreshes. This is the
// live failure: a run rooted at A whose tasks name B, gate red every round on rows that pass rc=0
// at B.
{
  const alt = mkdtempSync(join(tmpdir(), "fade-gate-repair-"));
  execFileSync("git", ["-C", alt, "init", "-q"], { stdio: "pipe" });
  writeFileSync(join(alt, "marker.txt"), "the row can only pass here\n");
  const repaired = [["test -s marker.txt", "exit 0"]];
  // Resume at the fixture root with a row that cannot pass anywhere.
  writeState({ ...seedState("coding", [["false", "exit 0"]]), schema_retries: 0, rejection_history: [] });
  await hooks.session_start({}, ctx);
  // The repair lands on disk AFTER the in-memory run exists — the only form the gate can refresh.
  writeState({ ...readState(), repo: alt, checks: repaired });
  notes.length = 0;
  await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "x" }] });
  const s = readState();
  const rows = s.gate_last?.results ?? [];
  ok(
	"the gate ran the RE-DECLARED row",
	rows.length === 1 && rows[0].cmd === repaired[0][0] && rows[0].ok === true,
	JSON.stringify(rows.map((r) => [r.cmd, r.ok])),
  );
  ok(
	"both refreshes are announced to the operator",
	notes.some((n) => n.includes("re-read the checks from")) && notes.some((n) => n.includes("re-rooted the run")),
	notes.join(" | ").slice(0, 220),
  );
  ok(
	"the gate is GREEN at the repaired root, so the verifier swap is paid for",
	s.gate_last?.passed === true && s.state === "verifying",
	`state=${s.state}`,
  );
  ok(
	"the taken repair is the loop's own record on disk",
	s.repo === alt && JSON.stringify(s.checks) === JSON.stringify(repaired),
	`repo=${s.repo} checks=${JSON.stringify(s.checks)}`,
  );
  rmSync(alt, { recursive: true, force: true });
}
// 5c. The WRITE PATH adopts the repair, not only the gate. The gate re-reads the file at its own
// tick (5b), but the loop writes state for reasons that never touch the gate — a schema refusal, a
// rejection, a lane bookkeeping write — and each of those writes rewrites the whole record. Live
// failure, six rounds: the operator's repair landed on disk, a paint-path write rewrote the
// pre-repair record over it, and the gate judged the OLD rows at the OLD root every round. So the
// adoption lives in `persist`, gated on "the file is newer than the loop's own last publish", and
// a repair must survive every later write and reach the gate that follows.
{
  const alt = mkdtempSync(join(tmpdir(), "fade-gate-adopt-"));
  execFileSync("git", ["-C", alt, "init", "-q"], { stdio: "pipe" });
  writeFileSync(join(alt, "marker.txt"), "the row can only pass here\n");
  const repaired = [["test -s marker.txt", "exit 0"]];
  writeState({ ...seedState("coding", [["false", "exit 0"]]), schema_retries: 0, rejection_history: [] });
  await hooks.session_start({}, ctx);
  writeState({ ...readState(), repo: alt, checks: repaired });
  // A refusal: a phase call the gate NEVER sees, whose persist is the clobber that ate the repair.
  let refused = "";
  try {
    await exec("coding_done", { done: [{ id: "T1", status: "ok" }] });
  } catch (e) {
    refused = e.message;
  }
  const w = readState();
  ok("the refusal is a refusal", /passed\|failed\|blocked/.test(refused), refused.slice(0, 60));
  ok("the refusal's write adopts the on-disk repair", w.repo === alt && JSON.stringify(w.checks) === JSON.stringify(repaired), `repo=${w.repo} checks=${JSON.stringify(w.checks)}`);
  ok("the adoption is journaled, never silent", (w.phases ?? []).some((p) => p.phase === "disk_repair"), JSON.stringify((w.phases ?? []).slice(-1)));
  // And it reaches the gate that follows: the repaired row, run at the repaired root, green.
  const l0 = loads();
  await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "x" }, { id: "T2", status: "passed", result: "x" }] });
  const g = await readStateWhen((x) => Boolean(x.gate_last) && x.repo === alt);
  ok("the gate runs the repaired row at the repaired root", (g.gate_last?.results ?? []).length === 1 && g.gate_last.results[0].ok === true && g.gate_last.passed === true, JSON.stringify(g.gate_last?.results ?? []));
  ok("the repair survives the gate's own write", g.repo === alt && JSON.stringify(g.checks) === JSON.stringify(repaired), `repo=${g.repo}`);
  // The swap itself is 5b's subject; here the gate going GREEN at the repaired root is the point,
  // and it is the state the loader pays from.
  ok("a green gate at the repaired root reaches verifying, so the swap is paid for", g.state === "verifying", g.state);
  // Hand the scenarios below back a run rooted at a directory that EXISTS: `alt` is a tmpdir this
  // block removes, and a run whose root is gone makes every later git reader degrade — measured as
  // the verifier's active tool set arriving with writers on the CI runner.
  writeState({ ...readState(), repo });
  await hooks.session_start({}, ctx);
  rmSync(alt, { recursive: true, force: true });
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
	// The tree, its identity and the seed commit landed at the rig's start (see the note there), so
	// the probe cache cannot miss them. This block measures the coder lane's edit.
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
	await settleLoads(base, 1);
	await new Promise((r) => setTimeout(r, 150)); // the queued switch clears the gate budget, then pays the swap
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
	await new Promise((r) => setTimeout(r, 150)); // as above: gate budget, then the swap, then the ledger line
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
	await settleLoads(base, 1);
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
	// The plan-act phase-log note is the field this act owns: settle on it, then judge the rest.
	const st1 = await readStateWhen((x) => `${x.phases?.at(-1)?.notes ?? ""}`.includes("plan act"));
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
	// Queued on the serial chain, so the loader runs a few ticks after `agent_end` returns.
	await settleLoads(l1, 1);
	await new Promise((r) => setTimeout(r, 60));
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

// 19b. The THRASH BREAKER — the operator's ask. The guard NAMES the churn and refuses to reload the
// resident lane, and the loop kept paying 13-25 s and 52-130 GiB every time a competing client named
// the other entry. Past `FADE_ORCHESTRATE_FLIP_BREAKER_AT` swaps away from the run's lane (3 in this
// rig) the load IS the flip-flop, so `runSwitch` sends NOTHING — no `setModel`, no `POST /v1/load` —
// halts the loop with the evidence in the operator note, keeps the lane owed in `pending`, and names
// the release: `/orchestrate lanes reset` clears the ledger and lands it, ONE load. The serialised
// chain is proved in the same block: two requests for one lane land it ONCE.
{
  resident = "flash-next";
  swapLine = null;
  writeState({ ...seedState("coding", [["true", "green"]]), schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
  await hooks.session_start({}, ctx);
  // The loop's own poll is what watches the router's swap line (the metrics tick; `session_start`
  // starts it). The engine reports the swap, then the reverse, with `resident` naming the lane being
  // unloaded, and the settle between them — `swap` clearing — is what re-arms the recorder, so each
  // cycle is ONE flip AWAY from the run's lane.
  const poll = async () => {
    await hooks.session_start({}, ctx);
    await new Promise((r) => setTimeout(r, 30));
  };
  for (let i = 0; i < 3; i++) {
    resident = "flash-next";
    swapLine = { from: "flash-next", to: "deepseek", phase: "loading", waiting: 1 };
    await poll(); // a queued request names deepseek: the router flips AWAY from the run's lane
    resident = "deepseek";
    swapLine = { from: "deepseek", to: "flash-next", phase: "loading", waiting: 1 };
    await poll(); // and BACK
    swapLine = null;
    resident = "flash-next";
    await poll();
  }
  const row19b = (widgets.get("fade-top")?.lines ?? []).join("\n");
  ok("the row carries the churn the breaker acts on", hasRow(row19b, "lane flip: 3 swaps in 60s"), row19b.slice(0, 240));

  notes.length = 0;
  await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "rig" }, { id: "T2", status: "passed", result: "rig" }] });
  // A worker is waiting on this lane. Halting is necessary and not sufficient: the breaker marks
  // the desk in churn and routes the waiting batch OFF the router (the route itself is block 22).
  const deskFile19b = join(repo, "var", "omp-orchestrate", "verify", "desk.json");
  rmSync(deskFile19b, { force: true });
  sent.length = 0;
  await hooks.tool_call({ toolName: "task", input: { tasks: [{ agent: "reviewer", task: "verify T1: run the gate and report what it printed" }] } }, ctx);
  await tools.fade_verify.execute("w1", { objective: "T1 at the breaker", acceptance: "node --test exits 0", checks: [["node --test test/desk.test.mjs", "exit 0"]] }, null, null, ctx);
  const lTrip = loads();
  await hooks.agent_end({}, ctx); // the green tree owes the verifier swap
  await new Promise((r) => setTimeout(r, 150));
  const sBreak = readState();
  ok("the breaker pays ZERO POST /v1/load", loads() === lTrip, `extra=${loads() - lTrip}`);
  ok("the breaker HALTS the loop: paused, with the thrash named in the operator note", sBreak.paused === true && /lane thrash: 3 swaps in 60s naming deepseek/.test(sBreak.operator_note ?? ""), JSON.stringify({ paused: sBreak.paused, operator_note: sBreak.operator_note }));
  const desk19b = JSON.parse(readFileSync(deskFile19b, "utf8"));
  ok("the breaker MARKS the desk in churn, so every later batch answers off the router", desk19b.churn === true && typeof desk19b.churn_utc === "string", JSON.stringify({ churn: desk19b.churn, churn_utc: desk19b.churn_utc }));
  ok("the breaker routes the waiting batch to the verification subagent, by id", (desk19b.addressed[0]?.routed ?? "") === "subagent" && (desk19b.addressed[0]?.ids ?? []).join(",") === "V1.1", JSON.stringify(desk19b.addressed));
  ok("the verifier call is handed to the loop as a command, naming the off-router model", sent.some((s) => /task \{ "agent": "fade-verifier"/.test(s) && s.includes("ninfer-local/coder-gpu1")), sent.join("\n").slice(0, 240));
  ok("the halt is said ONCE and names the release verb", notes.filter((n) => n.includes("LANE THRASH")).length === 1 && notes.some((n) => n.includes("LANE THRASH") && n.includes("lanes reset") && n.includes("deepseek")), JSON.stringify(notes.filter((n) => n.includes("THRASH"))));
  ok("the refused load is recorded in the run's history", (sBreak.rejection_history ?? []).some((r) => r.reason.includes("LANE THRASH")), JSON.stringify((sBreak.rejection_history ?? []).slice(-1)));
  ok("the verifier lane is still OWED: the note names it and the state waits on it", sBreak.state === "verifying" && (sBreak.operator_note ?? "").includes("deepseek"), `${sBreak.state} · ${JSON.stringify(sBreak.operator_note)}`);

  notes.length = 0;
  const lReset = loads();
  await commands.orchestrate.handler("lanes reset", ctx);
  await settleLoads(lReset, 1);
  await new Promise((r) => setTimeout(r, 200));
  const sReset = readState();
  ok("lanes reset clears the badge: no `lane flip:` row", !hasRow((widgets.get("fade-top")?.lines ?? []).join("\n"), "lane flip:"), (widgets.get("fade-top")?.lines ?? []).join("\n").slice(0, 240));
  ok("lanes reset unpauses and clears the operator note", sReset.paused === false && sReset.operator_note === undefined, JSON.stringify({ paused: sReset.paused, operator_note: sReset.operator_note }));
  ok("lanes reset pays exactly ONE POST /v1/load", loads() - lReset === 1, `extra=${loads() - lReset}`);
  ok("the lane it lands is the owed verifier lane", resident === "deepseek" && notes.some((n) => n.includes("flip ledger cleared; landing deepseek")), `${resident} · ${JSON.stringify(notes.slice(0, 2))}`);

  // The serialised chain: two switches for ONE lane, issued back to back. The chain runs the newest
  // and skips the superseded link outright — it never touches the router — so the lane loads ONCE.
  resident = "deepseek"; // `code` wants the coder lane back
  const lSerial = loads();
  void commands.orchestrate.handler("code", ctx);
  void commands.orchestrate.handler("code", ctx);
  await new Promise((r) => setTimeout(r, 200));
  ok("two back-to-back requests for one lane pay AT MOST ONE POST /v1/load", loads() - lSerial === 1 && resident === "flash-next", `extra=${loads() - lSerial} · resident=${resident}`);
  swapLine = null;
  resident = "flash-next";
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
  const user = account() || "someone";
  const host = hostname();
  writeState({ ...seedState("coding", [["true", "green"]]), goal: `run ${repo} on ${host} by ${user}`, schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
  await hooks.session_start({}, ctx);
  await new Promise((r) => setTimeout(r, 700)); // the login line is deferred past the TUI attach
  // ONE line per login, and it says NOTHING about the key: the row names the chord every round, so
  // a working keyboard is not re-explained per session.
  const loginNotes = notes.filter((n) => /run GATE1 is/.test(n));
  ok("one login line per login: the adopted run, nothing else", loginNotes.length > 0 && !notes.some((n) => /opens the screen|the host binds/.test(n)), JSON.stringify(notes.slice(0, 2)));
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
  ok(
    "the login says no key contract: no fallback, no env var, no raw-byte claim",
    !notes.some((n) => /opens the screen|the host binds|FADE_ORCHESTRATE_KEY|pty_rig/.test(n)),
    JSON.stringify(notes.slice(0, 2)),
  );
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
  await settleLoads(base23, 1);
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
  await settleLoads(base24, 1);
  await new Promise((r) => setTimeout(r, 60));
  ok("a round with a rejection is not a FIRST TRY, so the swap is paid", loads() - base24 === 1 && readState().state === "verifying", `${loads() - base24}/${readState().state}`);
}

// 25. The gate runs OFF the event loop and NAMES the row it is running. The synchronous form
//     (`execFileSync`, 120 s per row, rows back to back) held the loop for the gate's whole
//     duration: no paint, dead keystrokes, starved swap watch — what the operator saw as a freeze.
//     A 300 ms row must leave a 20 ms timer ticking, the working message must name the row, and the
//     verdict must be said out loud with its cost.
{
  resident = "flash-next";
  writeState({ ...seedState("coding", [["sleep 0.3; exit 0", "green"], ["true", "green"]]), schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [], checkpoints: {} });
  await hooks.session_start({}, ctx);
  working.length = 0;
  const notesBefore25 = notes.length;
  let ticks25 = 0;
  const iv25 = setInterval(() => ticks25++, 20);
  const t25 = Date.now();
  await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "rig" }, { id: "T2", status: "passed", result: "rig" }] });
  const spent25 = Date.now() - t25;
  clearInterval(iv25);
  ok("a 300 ms gate row leaves the event loop ticking: the gate is off the loop", ticks25 >= 5, `ticks=${ticks25} in ${spent25}ms`);
  ok("the gate names the row AS IT RUNS", working.some((m) => typeof m === "string" && /^fade_orchestrate: gate 1\/2: sleep 0\.3/.test(m)), JSON.stringify(working.slice(0, 3)));
  ok("the gate clears the working message when it lands", working.at(-1) === null, JSON.stringify(working.slice(-2)));
  ok("the gate verdict is said out loud with its cost", notes.slice(notesBefore25).some((n) => /gate GREEN in \d+\.\ds/.test(n)), JSON.stringify(notes.slice(notesBefore25)));
}

// 26. ONE orchestrator per ROUTER. The router carries one resident lane, one live-turn ledger and
//     one flip guard, so a second session on the same router is a correctness problem, not a
//     concurrency one: each one's pre-swap gate judges the other's working tree. The claim is taken
//     before the pack load, so a refusal is free, and released by the run that held it.
{
  const claimDir = process.env.FADE_ORCHESTRATE_LOCK_DIR;
  const claimFile = join(claimDir, "orchestrator.lock");
  ok("the rig owns its claim plane", claimDir.startsWith(repo), claimDir);
  rmSync(claimFile, { force: true });
  // A FOREIGN live owner: `kill(1, 0)` answers EPERM, which is "this pid exists", so the claim is
  // held, not stale. The rig must refuse, and refuse LEGIBLY.
  mkdirSync(claimDir, { recursive: true });
  const foreign = { pid: 1, run_id: "FOREIGN1", repo: "/home/elsewhere/checkout", started: "2030-01-01T00:00:00.000Z", host: "another-box" };
  writeFileSync(claimFile, `${JSON.stringify(foreign)}\n`);
  const base26 = loads();
  notes.length = 0;
  await commands.orchestrate.handler("a second goal on a claimed router", ctx);
  const refusal = notes.join("\n");
  ok("a start on a claimed router is refused, naming pid, run, repo and host", /is claimed by pid 1/.test(refusal) && refusal.includes("FOREIGN1") && refusal.includes("/home/elsewhere/checkout") && refusal.includes("another-box"), refusal.slice(0, 320));
  ok("the refusal paid NO lane load (the claim is taken before the pack load)", loads() === base26, `${loads() - base26}`);
  ok("the refusal wrote no run: the fixture state is untouched", readState().run_id === "GATE1", readState().run_id);
  ok("the refusal left the foreign claim alone", existsSync(claimFile), claimFile);
  // The owner finishes. The same keystroke now starts, and the claim names THIS process and the run.
  rmSync(claimFile, { force: true });
  resident = "deepseek"; // the start's preflight requires the think lane resident
  notes.length = 0;
  await commands.orchestrate.handler("--rounds 3 a claimable goal", ctx);
  const claim = JSON.parse(readFileSync(claimFile, "utf8"));
  const s26 = readState();
  ok("a free router is claimed at the start, naming this pid, run and repo", claim.pid === process.pid && claim.run_id !== "FOREIGN1" && claim.repo === repo, JSON.stringify(claim));
  ok("the run that claimed is the run on disk", s26.run_id === claim.run_id && s26.max_rounds === 3, `${s26.run_id} rounds ${s26.max_rounds}`);
  // The screen names the holder: the same fields a refused start's notify carries, because the panel
  // is where the operator looks after that refusal.
  inputHandlers[0]("\x1bf");
  await new Promise((r) => setTimeout(r, 300));
  const panel26 = (widgets.get("fade-overlay")?.lines ?? []).join("\n");
  ok("the screen names the claim THIS process holds, with its pid", hasRow(panel26, `router claim this run (pid ${process.pid})`), panel26.split("\n").filter((l) => /claim|engine|resident/.test(l)).join("\n").slice(0, 400));
  notes.length = 0;
  await commands.orchestrate.handler("status", ctx);
  const statusNote = notes.join("\n");
  ok("status names the claim as this process's", statusNote.includes(`router claim this run (pid ${process.pid})`), statusNote.slice(0, 240));
  ok("status names how long the router has been claimed", /router claim this run \(pid \d+\) · held \d+m\d{2}s/.test(statusNote), statusNote.slice(0, 240));
  await commands.orchestrate.handler("stop --clear", ctx);
  ok("`stop` releases the claim, so the next session is not refused", !existsSync(claimFile), claimFile);
}

// 17. `/orchestrate moe`: the per-class warm-start census, the card split and the build line, over
//     a ledger the rig injects — and it pays ZERO `POST /v1/load`, because a read-only verb must
//     never touch the router's load path. The screen bills the same census.
{
  writeState(seedState("coding", []));
  await hooks.session_start({}, ctx);
  writeFileSync(
    join(repo, "var", "omp-orchestrate", "swap_history.json"),
    JSON.stringify({
      key: "fade.omp_orchestrate.swaps.v1",
      rows: [
        { from: "deepseek", to: "flash-next", elapsed_s: 14.2, first_tg: 31, steady_tg: 480, percent_path: [], at: "2030-01-01T12:10:00.000Z", run_id: "GATE1", task_class: "ci", moe: { lane: "flash-next", state: "live", profile_path: "/var/basalt-profiles/flash-next.prof", profile_exists: true, written_by_running_engine: true } },
        { from: "flash-next", to: "deepseek", elapsed_s: 22.0, first_tg: 91, steady_tg: 130, percent_path: [], at: "2030-01-01T12:40:00.000Z", run_id: "GATE1", task_class: "code", moe: { lane: "deepseek", state: "unsupported", profile_exists: false } },
      ],
    }),
  );
  const loadsBefore = reqLog.filter((r) => r.startsWith("POST /v1/load")).length;
  notes.length = 0;
  await commands.orchestrate.handler("moe", ctx);
  const moeNote = notes.join("\n");
  ok("/orchestrate moe bills the CI class by the warm start it measured", hasRow(moeNote, "ci: 1 swaps · 1/1 warm · profile /var/basalt-profiles/flash-next.prof"), moeNote.slice(0, 700));
  ok("/orchestrate moe counts the verifier pack's swap as not warm", hasRow(moeNote, "code: 1 swaps · 0/1 warm · profile none named"), moeNote.slice(0, 700));
  ok("/orchestrate moe prints a class the ledger never ran, at 0 swaps", hasRow(moeNote, "tests: 0 swaps · 0/0 warm"), moeNote.slice(0, 700));
  ok("/orchestrate moe names the card split for both lanes", hasRow(moeNote, "MoE balance flash-next") && hasRow(moeNote, "MoE balance deepseek"), moeNote.slice(0, 700));
  ok("/orchestrate moe names the engine version the router reports", hasRow(moeNote, "engine 0.4.0 · ext"), moeNote.slice(0, 700));
  ok("/orchestrate moe names a bundle it cannot read rather than inventing a hash", /bundle (not built|[0-9a-f]{8})/.test(moeNote), moeNote.slice(0, 700));
  ok("/orchestrate moe pays ZERO lane load", reqLog.filter((r) => r.startsWith("POST /v1/load")).length === loadsBefore, reqLog.filter((r) => r.startsWith("POST /v1/load")).join(","));
  inputHandlers[0]("\x1bf");
  await new Promise((r) => setTimeout(r, 300));
  const panel17 = (widgets.get("fade-overlay")?.lines ?? []).join("\n");
  const moeRows17 = panel17.split("\n").filter((l) => /MoE/.test(l)).join("\n");
  ok("the screen bills the CI class's warm start", hasRow(panel17, "MoE class ci 1/1 warm"), moeRows17.slice(0, 600));
  ok("the screen names a class the ledger never ran, never a green zero", hasRow(panel17, "MoE class tests no swap ran this class"), moeRows17.slice(0, 600));
}

// 21. THE VERIFICATION DESK — the operator's batching rule, on the real hooks. One `task` call
//     carries four workers, TWO of them verification work. A worker's request never buys a lane
//     load: the batch closes when the launching call's own census has registered (or when the call
//     settles), and then exactly ONE verifier load answers EVERY request of the batch. A request
//     that arrives during the pass lands in the NEXT batch, and the claimed batch is answered once.
{
  resident = "flash-next";
  swapLine = null;
  writeState({ ...seedState("coding", [["true", "green"]]), schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
  await hooks.session_start({}, ctx);
  const deskFile = join(repo, "var", "omp-orchestrate", "verify", "desk.json");
  rmSync(deskFile, { force: true });
  const readDeskFile = () => JSON.parse(readFileSync(deskFile, "utf8"));
  const base21 = loads();
  notes.length = 0;
  sent.length = 0;
  await hooks.tool_call({ toolName: "task", input: { tasks: [
    { agent: "scout", task: "map the crate inventory and report the module list" },
    { agent: "task", task: "implement T1 in src/a.ts" },
    { agent: "reviewer", task: "verify T1: run node --test test/desk.test.mjs and report what it printed" },
    { agent: "security-reviewer", task: "verify T2 against the acceptance line" },
  ] } }, ctx);
  const census21 = notes.join("\n");
  ok("the task census counts ONLY the verification-carrying workers", hasRow(census21, "4 worker(s), 2 with verification work — the desk batch closes at 2 registration(s)"), census21.slice(0, 300));
  ok("the census names the launch that CANNOT register and the agent that can", /reviewer, security-reviewer do not carry `fade_verify` by definition/.test(census21) && /launch verification workers as "fade-worker"/.test(census21), census21.slice(0, 420));
  // Worker one registers. Its peer is unregistered, so the batch is OPEN: the boundary pays nothing.
  const w1 = await tools.fade_verify.execute("w1", { objective: "T1: the batch closes at 2 registrations", acceptance: "node --test test/desk.test.mjs exits 0", checks: [["node --test test/desk.test.mjs", "exit 0"]] }, null, null, ctx);
  await hooks.agent_end({}, ctx);
  await new Promise((r) => setTimeout(r, 150));
  ok("ONE registration of two pays ZERO POST /v1/load — the batch waits for its peers", loads() === base21, `extra=${loads() - base21}`);
  ok("the registration names its queue position and why the batch is open", /request V1.1 of batch 1/.test(w1.content[0].text) && /1\/2 of the launching task call/.test(w1.content[0].text), w1.content[0].text.slice(0, 220));
  ok("the queue is announced once, with its reason, and the reason is NOT a swap", notes.filter((n) => n.includes("verification desk holds")).length === 1 && notes.some((n) => n.includes("no lane is loaded until the batch closes")), JSON.stringify(notes.filter((n) => n.includes("desk"))));
  // Worker two registers: the census is complete, so ONE pass answers BOTH.
  const l21ready = loads();
  await tools.fade_verify.execute("w2", { objective: "T2: the acceptance line", checks: [["bash -lc 'echo ok'", "exit 0"]] }, null, null, ctx);
  // THE DEADLOCK PATH, measured live: the owner DELEGATED these workers, so it is blocked in `wait`
  // on sessions that are blocked on its verdict — there is NO `agent_end` boundary to claim a ready
  // batch. An owner tool call must claim it, or the loop deadlocks on its own verification.
  await hooks.tool_call({ toolName: "wait", input: { jobs: [] } }, ctx);
  const landed21 = await settleLoads(l21ready, 1);
  await new Promise((r) => setTimeout(r, 200));
  ok("a READY batch is claimed at an owner `wait` call, where no `agent_end` will ever come", loads() - l21ready === 1, `extra=${loads() - l21ready}`);
  // The turn boundary may arrive later; it must NEVER pay a second load for the claimed batch.
  const l21after = loads();
  await hooks.agent_end({}, ctx);
  await new Promise((r) => setTimeout(r, 150));
  ok("the turn boundary claims an already-claimed batch NEVER: zero extra load", loads() === l21after, `extra=${loads() - l21after}`);
  const s21 = readState();
  const desk21 = readDeskFile();
  ok("a closed batch pays EXACTLY ONE POST /v1/load for the WHOLE batch", landed21 === 1, `extra=${landed21}`);
  ok("the batch is claimed with both ids, routed to the lane", desk21.addressed.length === 1 && desk21.addressed[0].routed === "swap" && desk21.addressed[0].ids.join(",") === "V1.1,V1.2", JSON.stringify(desk21.addressed));
  ok("the desk advanced to the NEXT batch, so nothing is answered twice", desk21.epoch === 1, `epoch=${desk21.epoch}`);
  ok("the run records the claimed batch it is answering", (s21.verify_batch?.ids ?? []).join(",") === "V1.1,V1.2" && s21.verify_batch?.routed === "swap", JSON.stringify(s21.verify_batch));
  ok("the boundary moved the round into verification, ONCE", s21.state === "verifying", s21.state);
  const brief21 = sent.join("\n");
  ok("the verifier's briefing is the BATCH page: one turn, every request, by id", hasRow(brief21, "ONE BATCH, batch 1 of orchestrated run GATE1") && brief21.includes("V1.1") && brief21.includes("V1.2"), brief21.slice(0, 260));
  ok("the briefing carries BOTH workers' check commands, so one pass sees the whole batch", brief21.includes("node --test test/desk.test.mjs") && brief21.includes("bash -lc"), brief21.slice(0, 400));
  // A worker that registers during the pass: the NEXT batch, not a second swap.
  const w3 = await tools.fade_verify.execute("w3", { objective: "T3: the late slice", checks: [] }, null, null, ctx);
  ok("a request arriving during verification lands in the NEXT batch", /of batch 2/.test(w3.content[0].text), w3.content[0].text.slice(0, 200));
  const l21b = loads();
  await hooks.agent_end({}, ctx);
  await new Promise((r) => setTimeout(r, 150));
  ok("the open second batch pays ZERO POST /v1/load while the first is owed its verdict", loads() === l21b, `extra=${loads() - l21b}`);
  // The partial answer, gated while the batch is OPEN: a batch is answered by every id or not at
  // all, because a request with no verdict leaves its worker parked in `fade_verify`.
  let gate3 = "";
  try {
    await exec("verification_done", { verdict: "needs_repair", checks: [], notes: "x", tasks: [], verdicts: [{ id: "V1.1", accepted: true, notes: "ok" }] });
  } catch (e) {
    gate3 = e.message;
  }
  ok("the round's `verdicts` must cover EVERY id of the claimed batch, named", /V1\.2 has no verdict row/.test(gate3), gate3.slice(0, 300));
  // The gates on the verifier's answer.
  let gate1 = "";
  try {
    await tools.fade_verdicts.execute("v1", { batch: 2, verdicts: [{ id: "V2.1", accepted: true, notes: "answered an OPEN batch" }] }, null, null, ctx);
  } catch (e) {
    gate1 = e.message;
  }
  ok("answering a batch the desk has NOT claimed is refused, naming the claimed ones", /batch 2 was never claimed by the desk/.test(gate1) && /batch 1 \[V1\.1,V1\.2\]/.test(gate1), gate1.slice(0, 300));
  let gate2 = "";
  try {
    await tools.fade_verdicts.execute("v2", { batch: 1, verdicts: [{ id: "V9.9", accepted: true, notes: "invented id" }] }, null, null, ctx);
  } catch (e) {
    gate2 = e.message;
  }
  ok("a verdict for an id outside the claimed batch is refused with that batch's ids", /V9\.9 is not part of batch 1 \(its ids: V1\.1, V1\.2\)/.test(gate2), gate2.slice(0, 260));
  // The verifier answers the claimed batch BY ID; that write is what unblocks the workers.
  const vd = await exec("verification_done", { verdict: "accepted", checks: [["node --test test/desk.test.mjs", "rc 0"], ["bash -lc 'echo ok'", "rc 0"]], notes: "both checks re-run this turn", tasks: [], verdicts: [{ id: "V1.1", accepted: true, notes: "node --test: 234 pass" }, { id: "V1.2", accepted: true, notes: "bash echo ok: rc 0" }] });
  const deskAfter = readDeskFile();
  ok("the verdicts fanned onto the requests by id, so the blocked workers return", deskAfter.requests.filter((r) => r.verdict?.accepted === true).map((r) => r.id).join(",") === "V1.1,V1.2", JSON.stringify(deskAfter.requests.map((r) => [r.id, r.verdict])));
  ok("the phase result names the batch it answered", /desk batch 1 answered for 2 worker request\(s\) \(2 accepted\)/.test(vd.content[0].text), vd.content[0].text.slice(0, 220));
  ok("the claimed batch is closed in the run state, so it cannot be answered again", readState().verify_batch === undefined, JSON.stringify(readState().verify_batch));
  notes.length = 0;
  await commands.orchestrate.handler("desk", ctx);
  const deskNote = notes.join("\n");
  ok("`/orchestrate desk` prints the census, the batch state and the collecting request", hasRow(deskNote, "desk batch 2: 1 open, 0 awaiting verdict, 2 answered, 1 addressed") && deskNote.includes("V2.1") && /collecting/.test(deskNote), deskNote.slice(0, 500));
  notes.length = 0;
  await commands.orchestrate.handler("status", ctx);
  ok("the status row carries the desk census, so the queue is visible without a verb", hasRow(notes.join("\n"), "desk batch 2: 1 open, 0 awaiting verdict, 2 answered, 1 addressed"), notes.join("\n").slice(0, 300));
}

// 22. THE CHURN ROUTE. The rule the operator set: once lane churn begins, a verification batch is
//     NOT answered by another 13-25 s lane load — continuing to pay loads into a churning window is
//     the failure. The desk is marked in churn, the closed batch is claimed ONCE and handed to the
//     verification SUBAGENT on a NON-ROUTER model (zero swaps), the loop is handed the exact `task`
//     call as a command, and the route STAYS for every later batch until `/orchestrate lanes reset`
//     releases it with the flip ledger. (The breaker that MARKS churn, and the halt that comes with
//     it, are block 19b's contract.)
{
  resident = "flash-next";
  swapLine = null;
  writeState({ ...seedState("coding", [["true", "green"]]), schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
  await hooks.session_start({}, ctx);
  const deskFile22 = join(repo, "var", "omp-orchestrate", "verify", "desk.json");
  const readDesk22 = () => JSON.parse(readFileSync(deskFile22, "utf8"));
  const now22 = new Date().toISOString();
  // The state the churn route reads: the desk declared, one worker registered, and its launching
  // task call censused — so the batch is CLOSED and the next boundary owes an answer.
  writeFileSync(deskFile22, JSON.stringify({
    schema: "fade.orchestrate.verify_desk.v1",
    run_id: "GATE1",
    epoch: 0,
    open_utc: now22,
    expected: 1,
    agents: ["reviewer"],
    churn: true,
    churn_utc: now22,
    requests: [{ id: "V1.1", batch: 0, agent: "reviewer", session: "sub-1", objective: "T1 under churn", acceptance: "node --test exits 0", checks: [["node --test test/desk.test.mjs", "exit 0"]], enqueued_utc: now22 }],
    addressed: [],
    updated_utc: now22,
  }));
  const l22 = loads();
  notes.length = 0;
  sent.length = 0;
  await hooks.agent_end({}, ctx);
  await new Promise((r) => setTimeout(r, 200));
  const d22 = readDesk22();
  const s22 = readState();
  const directive22 = sent.join("\n");
  ok("a churned run's batch pays ZERO POST /v1/load — the lane is not loaded again", loads() === l22, `extra=${loads() - l22}`);
  ok("the closed batch is claimed ONCE, routed to the subagent", d22.addressed.length === 1 && d22.addressed[0].routed === "subagent" && d22.addressed[0].ids.join(",") === "V1.1", JSON.stringify(d22.addressed));
  ok("the desk advanced to the next epoch, so the batch cannot be answered twice", d22.epoch === 1 && d22.churn === true, `epoch=${d22.epoch} churn=${d22.churn}`);
  ok("the loop is handed the verifier call as a command, naming the agent and the off-router model", /task \{ "agent": "fade-verifier"/.test(directive22) && directive22.includes("ninfer-local/coder-gpu1") && /will NOT pay a lane load/.test(directive22), directive22.slice(0, 340));
  ok("the directive carries the worker's own check command, so the verifier needs no desk read", directive22.includes("node --test test/desk.test.mjs") && /Ids to judge: V1\.1/.test(directive22), directive22.slice(0, 420));
  ok("the reason names the churn the route is escaping", /churn declared/.test(directive22), directive22.slice(0, 200));
  ok("the route is recorded in the run's history with its zero cost", (s22.rejection_history ?? []).some((r) => r.reason.includes("addressed AT ONCE") && r.reason.includes("routed subagent")), JSON.stringify((s22.rejection_history ?? []).slice(-1)));
  ok("the operator is told the batch and its cost", notes.some((n) => /verification batch 1 · 1 worker request/.test(n) && /zero lane loads/.test(n)), JSON.stringify(notes.slice(0, 4)));
  ok("the run state carries the batch it handed off", (s22.verify_batch?.ids ?? []).join(",") === "V1.1" && s22.verify_batch?.routed === "subagent", JSON.stringify(s22.verify_batch));
  // The route STAYS: a later batch of the same churning run routes off the router too.
  // The launching call is censused, so the second batch CLOSES on its own registration: `expected`
  // is the number the batch waits for, and with no call named it stays open to the settle window.
  await hooks.tool_call({ toolName: "task", input: { tasks: [{ agent: "task", task: "verify T2 against its acceptance line" }] } }, ctx);
  await tools.fade_verify.execute("w2", { objective: "T2 under churn", acceptance: "bash -lc true", checks: [["bash -lc true", "exit 0"]] }, null, null, ctx);
  const l22b = loads();
  notes.length = 0;
  sent.length = 0;
  await hooks.agent_end({}, ctx);
  await new Promise((r) => setTimeout(r, 200));
  const d22b = readDesk22();
  ok("a later batch of a churning run ALSO routes off the router, at zero loads", loads() === l22b && (d22b.addressed.at(-1)?.routed ?? "") === "subagent" && d22b.epoch === 2, `${loads() - l22b} · ${JSON.stringify(d22b.addressed.map((a) => a.routed))} · epoch=${d22b.epoch}`);
  ok("the second batch's directive names the churn it is escaping", /churn/.test(sent.join("\n")) && /V2\.1/.test(sent.join("\n")), sent.join("\n").slice(0, 260));
  notes.length = 0;
  await commands.orchestrate.handler("desk", ctx);
  ok("the desk census says the churn route is in force and names the release verb", hasRow(notes.join("\n"), "CHURN ROUTE (subagent verification)") && notes.join("\n").includes("lanes reset"), notes.join("\n").slice(0, 400));
  // The release: the operator dealt with the competing client, so batches go back to the lane.
  const lReset22 = loads();
  notes.length = 0;
  await commands.orchestrate.handler("lanes reset", ctx);
  await new Promise((r) => setTimeout(r, 250));
  const dReset = readDesk22();
  ok("`lanes reset` releases the churn route with the flip ledger", dReset.churn === false && dReset.churn_utc === undefined, JSON.stringify({ churn: dReset.churn, churn_utc: dReset.churn_utc }));
  ok("the release names the lane that takes batches back", notes.some((n) => n.includes("churn route cleared") && n.includes("deepseek")), JSON.stringify(notes.slice(0, 4)));
  ok("the release pays AT MOST one lane load (only a lane the loop owes)", loads() - lReset22 <= 1, `extra=${loads() - lReset22}`);
  swapLine = null;
  resident = "flash-next";
}

// 27. THE CLAIM-TIME LANE GUARD. A claimed batch has NO reclaim path: `claimBatch` stamps the live
// requests (desk.ts:264), `openRequests` drops the stamped ones (desk.ts:214), and nothing clears
// the stamp. So a batch handed to a verifier lane that cannot answer is not stalled — it is OWED
// for the whole run, every worker in it exits `fade_verify` deferred, and a worker that
// re-registers its objective adds a FRESH owed request (desk.ts:285 dedupes only UNCLAIMED ones),
// so the owed count grows and each duplicate is priced. The zero-swap route therefore requires
// PROOF: one 1-token completion, through the lane's own auth path (`apiKey: "!bash -lc …'"` means a
// 200 on `/v1/models` can coexist with a 401 at generate time). A lane that refuses sends the batch
// to the swap route — the route with recovery — loudly; a lane that answers keeps the zero-swap
// route and pays nothing.
{
  resident = "flash-next";
  swapLine = null;
  let laneMode = "refuse";
  const laneCalls = [];
  const lane = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    laneCalls.push({ url: req.url, auth: String(req.headers.authorization ?? ""), body });
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url === "/v1/models") return json(200, { data: [{ id: "probe-model" }] });
    if (req.url === "/v1/chat/completions") {
      if (laneMode === "refuse") return json(401, { error: { message: "missing api key" } });
      return json(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });
    }
    return json(404, { error: { message: "no route" } });
  });
  await new Promise((r) => lane.listen(0, "127.0.0.1", r));
  process.env.FADE_ORCHESTRATE_VERIFIER_MODEL = "probe-lane/probe-model";
  process.env.FADE_ORCHESTRATE_VERIFIER_BASE_URL = `http://127.0.0.1:${lane.address().port}/v1`;
  process.env.FADE_ORCHESTRATE_VERIFIER_API_KEY = "rig-probe-key";
  process.env.FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS = "1"; // a fresh probe per case, never a cached pass
  const deskFile27 = join(repo, "var", "omp-orchestrate", "verify", "desk.json");
  const readDesk27 = () => JSON.parse(readFileSync(deskFile27, "utf8"));
  const request27 = (id) => ({ id, batch: 0, agent: "reviewer", session: "sub-1", objective: "T1 with an unproven lane", acceptance: "node --test exits 0", checks: [["node --test test/desk.test.mjs", "exit 0"]], enqueued_utc: new Date().toISOString() });
  const seed27 = (requests, epoch, addressed) => {
    const at = new Date().toISOString();
    writeState({ ...seedState("coding", [["true", "green"]]), schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
    writeFileSync(deskFile27, JSON.stringify({
      schema: "fade.orchestrate.verify_desk.v1", run_id: "GATE1", epoch, open_utc: at, expected: requests.length, agents: ["reviewer"],
      churn: true, churn_utc: at, requests, addressed: addressed ?? [], updated_utc: at,
    }));
  };

  // A. The lane answers `/v1/models` and REFUSES the completion: the batch is not claimed for the
  // zero-swap route, because that claim is the unrecoverable act.
  seed27([request27("V1.1")], 0);
  await hooks.session_start({}, ctx);
  const l27 = loads();
  notes.length = 0;
  sent.length = 0;
  laneCalls.length = 0;
  await hooks.agent_end({}, ctx);
  await new Promise((r) => setTimeout(r, 250));
  const d27 = readDesk27();
  const s27 = readState();
  ok("the guard probes a COMPLETION through the lane's own auth path", laneCalls.some((c) => c.url === "/v1/chat/completions" && /^Bearer /.test(c.auth)), JSON.stringify(laneCalls.map((c) => c.url)));
  ok("a lane that refuses the completion routes the batch to the swap route", d27.addressed.length === 1 && d27.addressed[0].routed === "swap" && d27.addressed[0].ids.join(",") === "V1.1", JSON.stringify(d27.addressed));
  ok("the refusal is said, naming the lane, the http status and the model", notes.some((n) => n.includes("verifier lane UNPROVEN") && n.includes("http 401") && n.includes("probe-model")), JSON.stringify(notes.slice(0, 4)));
  ok("the refusal is in the run's history and names the reclaim rule", (s27.rejection_history ?? []).some((r) => r.reason.includes("REFUSED before the claim") && r.reason.includes("desk.ts:214")), JSON.stringify((s27.rejection_history ?? []).slice(-1)));
  ok("the probe rides the run state, so the panel and `verifier` print it", s27.lane_probe?.ok === false && /http 401/.test(String(s27.lane_probe?.detail)), JSON.stringify(s27.lane_probe));
  ok("the batch is answered by the one load the swap route pays", loads() - l27 === 1 && readState().state === "verifying", `extra=${loads() - l27} state=${readState().state}`);
  ok("no verifier directive is handed out for a lane that cannot be proved", !/fade-verifier/.test(sent.join("\n")), sent.join("\n").slice(0, 200));

  // B. The lane answers a 1-token completion: the zero-swap route stands, at zero loads.
  laneMode = "answer";
  // Case A left the loop OWING the swap route's lane, and `agent_end` pays an owed lane BEFORE it
  // dispatches a batch, so the debt is settled first. It comes BEFORE the seed because
  // `lanes reset` also releases the desk's churn mark — seeded first, the desk would be reset out
  // of churn and this case would measure the swap route it is meant to rule out.
  await commands.orchestrate.handler("lanes reset", ctx);
  await new Promise((r) => setTimeout(r, 250));
  seed27([request27("V1.1")], 0);
  await hooks.session_start({}, ctx);
  const l27b = loads();
  notes.length = 0;
  sent.length = 0;
  laneCalls.length = 0;
  await hooks.agent_end({}, ctx);
  await new Promise((r) => setTimeout(r, 250));
  const d27b = readDesk27();
  const s27b = readState();
  ok("a lane that answers keeps the zero-swap route at ZERO loads", d27b.addressed.length === 1 && d27b.addressed[0].routed === "subagent" && loads() === l27b, `${JSON.stringify(d27b.addressed.map((a) => a.routed))} extra=${loads() - l27b}`);
  // The directive's model text comes from `VERIFIER_MODEL`, read at import; the probe reads the env
  // at call time. In production both are the process's own value, so the check names the ACT.
  ok("the proved route hands the loop the verifier call, by id, promising zero loads", /task \{ "agent": "fade-verifier"/.test(sent.join("\n")) && /V1\.1/.test(sent.join("\n")) && /will NOT pay a lane load/.test(sent.join("\n")), sent.join("\n").slice(0, 240));
  ok("the proved probe rides the run state", s27b.lane_probe?.ok === true && /answered model probe-model/.test(String(s27b.lane_probe?.detail)), JSON.stringify(s27b.lane_probe));

  // C. The census NAMES what is owed: claimed, no verdict, and nothing re-opens it.
  seed27([{ ...request27("V1.1"), claimed_batch: 0 }, { ...request27("V1.2"), claimed_batch: 0, verdict: { accepted: true, notes: "node --test: 12 pass" } }], 1, [{ batch: 0, ids: ["V1.1", "V1.2"], routed: "subagent", at: new Date().toISOString() }]);
  notes.length = 0;
  await commands.orchestrate.handler("desk", ctx);
  const census27 = notes.join("\n");
  ok("the desk census calls an unjudged claim OWED, by id", /CLAIMED with NO verdict — owed: V1\.1/.test(census27) && census27.includes("UNVERIFIED"), census27.slice(0, 400));
  ok("a judged request is not counted as owed", !/owed: V1\.2/.test(census27), census27.slice(0, 400));

  delete process.env.FADE_ORCHESTRATE_VERIFIER_MODEL;
  delete process.env.FADE_ORCHESTRATE_VERIFIER_BASE_URL;
  delete process.env.FADE_ORCHESTRATE_VERIFIER_API_KEY;
  process.env.FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS = "0";
  lane.close();
}

// 28. RED-GATE TRIAGE. A red gate already says WHAT failed — the exit codes are the verdict — and
// the triage call says WHY, as one ADVISORY line in the briefing and the tool's answer. The contract
// is its boundaries: ZERO authority (the gate stays RED and pays zero lane loads, whatever the
// triage claims), NO tools (the prompt carries the gate's own rows, so the advisory agent cannot
// touch the tree the coder is repairing), and SILENCE on failure (a CLI that answers nothing leaves
// the briefing exactly as it was before this feature existed).
{
  const stub = join(repo, "stub-triage.sh");
  const stubLog = join(repo, "triage-prompt.txt");
  const argsLog = join(repo, "triage-args.txt");
  writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$2" >> "$STUB_PROMPT_LOG"\nprintf \'%s\\n\' "$@" >> "$STUB_ARGS_LOG"\nprintf \'%s\' \'{"text":"probable cause: the stub read the tails","stopReason":"end_turn"}\'\n');
  chmodSync(stub, 0o755);
  process.env.FADE_ORCHESTRATE_GATE_TRIAGE = "1";
  process.env.FADE_ORCHESTRATE_GATE_TRIAGE_BIN = stub;
  process.env.STUB_PROMPT_LOG = stubLog;
  process.env.STUB_ARGS_LOG = argsLog;
  rmSync(stubLog, { force: true });
  rmSync(argsLog, { force: true });
  writeState({ ...seedState("coding", [["false", "green"]]), schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
  await hooks.session_start({}, ctx);
  const l28 = loads();
  notes.length = 0;
  const r28 = await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "rig" }, { id: "T2", status: "passed", result: "rig" }] });
  const text28 = r28?.content?.[0]?.text ?? "";
  ok("a red gate carries the ADVISORY cause line", /probable cause \(advisory/.test(text28) && text28.includes("the stub read the tails"), text28.slice(0, 260));
  ok("the line names the verdict as the exit codes, not itself", text28.includes("exit codes decide"), text28.slice(0, 260));
  ok("the gate verdict is UNCHANGED by the triage: RED, and the swap is not paid", /pre-swap gate RED \(1\/1 failing\)/.test(text28) && loads() === l28, `${text28.slice(0, 90)} extra=${loads() - l28}`);
  const s28 = readState();
  ok("gate_last carries the triage, stays red, and the lane is owed the repair", (s28.gate_last?.triage ?? "").includes("stub read the tails") && s28.gate_last?.passed === false && s28.state === "coding", JSON.stringify({ triage: s28.gate_last?.triage, passed: s28.gate_last?.passed, state: s28.state }));
  const prompt28 = existsSync(stubLog) ? readFileSync(stubLog, "utf8") : "";
  const args28 = existsSync(argsLog) ? readFileSync(argsLog, "utf8") : "";
  ok("the prompt carries the gate's OWN rows — command, expectation, tail", prompt28.includes("false") && /expected: green/i.test(prompt28) && prompt28.includes("RED"), prompt28.slice(0, 300));
  ok("the prompt forbids guessing and demands one confirming command", /cause not determinable/.test(prompt28) && /ONE command/.test(prompt28), prompt28.slice(-300));
  ok("the call is tool-less, one turn, bounded", args28.includes("--disallowed-tools") && args28.includes("*") && args28.includes("--max-turns") && args28.includes("--output-format"), args28.slice(0, 300));

  // The failure path: a CLI that answers nothing must change NOTHING.
  const silent = join(repo, "stub-silent.sh");
  writeFileSync(silent, "#!/bin/sh\nprintf '%s' '{\"stopReason\":\"cancelled\"}'\n");
  chmodSync(silent, 0o755);
  process.env.FADE_ORCHESTRATE_GATE_TRIAGE_BIN = silent;
  writeState({ ...seedState("coding", [["false", "green"]]), schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
  await hooks.session_start({}, ctx);
  const l28b = loads();
  notes.length = 0;
  const r28b = await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "rig" }, { id: "T2", status: "passed", result: "rig" }] });
  const text28b = r28b?.content?.[0]?.text ?? "";
  ok("a triage that answers nothing changes nothing: same red briefing, zero loads", !/probable cause/.test(text28b) && /pre-swap gate RED \(1\/1 failing\)/.test(text28b) && loads() === l28b, `${text28b.slice(0, 90)} extra=${loads() - l28b}`);
  ok("the operator is told WHY there is no line, naming the CLI's stopReason", notes.some((n) => n.includes("gate triage produced nothing") && n.includes("cancelled")), JSON.stringify(notes.slice(0, 4)));
  const s28b = readState();
  ok("no triage is recorded when there is no answer", s28b.gate_last?.triage === undefined && s28b.gate_last?.passed === false, JSON.stringify(s28b.gate_last?.triage));

  process.env.FADE_ORCHESTRATE_GATE_TRIAGE = "0";
  delete process.env.FADE_ORCHESTRATE_GATE_TRIAGE_BIN;
  delete process.env.STUB_PROMPT_LOG;
  delete process.env.STUB_ARGS_LOG;
}

// 29. A FINISHED RUN OWNS NOTHING, AND ITS DESK IS CLOSED AT THE DOOR. See the header.
{
  resident = "flash-next";
  swapLine = null;
  const deskFile29 = join(repo, "var", "omp-orchestrate", "verify", "desk.json");
  rmSync(deskFile29, { force: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // THE CONTROL. A run that can still act starts its metrics poll at `session_start`, and that poll
  // reads the router immediately. Without this row the finished run's zero-read assertion is
  // vacuous: a router nobody polls answers zero reads whether the timer exists or not.
  writeState({ ...seedState("coding", [["true", "green"]]), schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [] });
  const rLive = reqLog.length;
  await hooks.session_start({}, ctx);
  await sleep(120);
  const liveReads = reqLog.length - rLive;
  ok("a LIVE run's adoption reads the router: the control a zero-read proof needs", liveReads >= 1, `reads=${liveReads}`);
  // The login notify is DEFERRED 500 ms (it is scheduled past the host's TUI attach), and every
  // earlier block's `session_start` scheduled one of its own. Drain them FIRST, then open the
  // window: from here, what `notes` carries is ONLY what a finished run's adoption says.
  await sleep(600);
  ok("a live run's adoption DOES print its line: the silence below is specific to a finished run", notes.some((n) => /run GATE1 is coding/.test(n)), JSON.stringify(notes.slice(-2)));

  // The FINISHED run, adopted as the repo's last record.
  writeState({
    ...seedState("complete", [["true", "green"]]),
    tasks: [{ ...task("T1"), status: "passed" }, { ...task("T2"), status: "passed" }],
    schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [],
  });
  notes.length = 0;
  sent.length = 0;
  const base29 = loads();
  const r29 = reqLog.length;
  await hooks.session_start({}, ctx);
  await sleep(700); // the login notify is deferred 500 ms; silence is only proved past it
  ok("a finished run reads the router ZERO times at login: no metrics poll for a dead lane", reqLog.length - r29 === 0, `reads=${reqLog.length - r29}`);
  ok("a finished run says NOTHING at login", notes.length === 0, JSON.stringify(notes));
  ok("the finished run's status row stays cleared", !widgets.has("fade-top"), JSON.stringify([...widgets.keys()]));

  // The desk, closed at the door. A terminal run is refused by `dispatchDeskBatch` (index.ts:626),
  // so a request registered here is not late — it is unanswerable, and the worker pays the whole
  // DESK_WAIT_MS for nothing. The refusal must be same-tick and must write nothing.
  const t29 = Date.now();
  let refuseV = "";
  try {
    await tools.fade_verify.execute("w1", { objective: "T1 after the run ended", acceptance: "node --test exits 0", checks: [["node --test test/desk.test.mjs", "exit 0"]] }, null, null, ctx);
  } catch (e) {
    refuseV = e.message;
  }
  const refuseMs = Date.now() - t29;
  ok("fade_verify refuses a finished run's desk, naming the run, its state and that nothing was written", /run GATE1 is complete/.test(refuseV) && /Nothing was written/.test(refuseV), refuseV.slice(0, 240));
  ok("the refusal is INSTANT: no DESK_WAIT_MS park on a batch nobody will ever claim", refuseMs < 1000, `${refuseMs}ms`);
  let refuseD = "";
  try {
    await tools.fade_verdicts.execute("v1", { batch: 1, verdicts: [{ id: "V1.1", accepted: true, notes: "answered a dead run" }] }, null, null, ctx);
  } catch (e) {
    refuseD = e.message;
  }
  ok("fade_verdicts refuses to answer a finished run's desk, by name", /run GATE1 is complete/.test(refuseD) && /Nothing was written/.test(refuseD), refuseD.slice(0, 240));
  ok("the refusal wrote NO desk file: a finished run never gains a batch it cannot answer", !existsSync(deskFile29), deskFile29);

  // The records survive: the finished run stays readable to the operator, which is why it is adopted.
  notes.length = 0;
  await commands.orchestrate.handler("status", ctx);
  ok("the finished run is kept for its RECORDS: /orchestrate status answers it", notes.some((n) => /orchestrate GATE1: complete/.test(n)), JSON.stringify(notes));
  const open29 = inputHandlers[inputHandlers.length - 1]?.("\x1bf");
  await sleep(300);
  const panel29 = (widgets.get("fade-overlay")?.lines ?? []).join("\n");
  ok("the Alt+F screen still opens over the finished run (engine columns, swaps, claim)", open29?.consume === true && panel29.includes("fade-orchestrator GATE1"), panel29.slice(0, 200));
  ok("a finished run pays ZERO POST /v1/load across the whole block", loads() === base29, `extra=${loads() - base29}`);
}

// 30. THE HAND-BACK AND THE HOSTILE FLIP. The code lane is the run's worker and the thinking lane a
//     guest, so the session that HOLDS THE ROUTER CLAIM keeps authority over the router. On a run
//     this rig starts and owns: (a) a deepseek turn that COMPLETED (a tool ANSWERED) and ends with NO
//     `fade_phase` call in a state the coder owns pays EXACTLY ONE flash-next load at the boundary,
//     the miss rides the ledger as a protocol debt, the round stays UNSPENT, and the protocol page
//     arrives on the code lane's LANDING briefing — never on the thinking lane, where a nudge keeps
//     paying deepseek; (b) the same turn in `verifying`, the ONE state the thinking lane owns, pays
//     ZERO loads and keeps deepseek resident: handing that boundary to the coder would put the round's
//     verdict in the hands of the lane that wrote the diff; (c) a terminal boundary pays ZERO loads; (d)
//     an OUTSIDE `POST /v1/load` naming the other lane is classified HOSTILE — the owner names it in
//     the ledger, the notify and `/orchestrate status`, and lands the lane it authorized in ONE load,
//     so the flip never sticks; (e) a session with NO router claim that sees the same flip pays ZERO
//     loads and writes NOTHING: it has no authority over the router.
{
  const sleep30 = (ms) => new Promise((r) => setTimeout(r, ms));
  const sentWhen = async (re, cap = 4000) => {
    const t0 = Date.now();
    while (!sent.some((s) => re.test(s)) && Date.now() - t0 < cap) await sleep30(10);
    return sent.find((s) => re.test(s)) ?? "";
  };
  const claim30 = join(process.env.FADE_ORCHESTRATE_LOCK_DIR, "orchestrator.lock");
  rmSync(claim30, { force: true });
  // An earlier block can leave a lane QUEUED on this session (`pending`), and the boundary spends
  // it before measuring anything: a queued load would otherwise be billed to the hand-back.
  const base30drain = loads();
  await hooks.agent_end({}, ctx);
  await settleLoads(base30drain, 1, 1500);
  resident = "deepseek"; // the start's preflight requires the think lane resident
  notes.length = 0;
  sent.length = 0;
  const baseStart30 = loads();
  await commands.orchestrate.handler("--rounds 3 a hand-back goal", ctx);
  const s30 = readState();
  ok("block 30 starts a run THIS process owns", existsSync(claim30) && JSON.parse(readFileSync(claim30, "utf8")).run_id === s30.run_id, s30.run_id);
  ok("the start pays NO lane load: deepseek was already resident", loads() === baseStart30, String(loads() - baseStart30));
  ok("an owned run starts on the thinking lane in planning", s30.state === "planning" && s30.lane === "deepseek", s30.state + " " + s30.lane);

  // (a) THE HAND-BACK: the thinking lane's phase-less turn hands the router to the coder.
  const base30a = loads();
  // The turn COMPLETED: a tool answered, so the lane finished its work and the hand-back is owed.
  await hooks.tool_result({ toolName: "read", isError: false }, ctx);
  await hooks.agent_end({}, ctx);
  const paid30a = await settleLoads(base30a, 1);
  const sa = await readStateWhen((x) => x.lane === "flash-next");
  ok("a COMPLETED deepseek turn with no fade_phase call pays EXACTLY ONE flash-next load", paid30a === 1, "loads=" + paid30a);
  ok("the hand-back lands the code lane on the router too", sa.lane === "flash-next" && resident === "flash-next", sa.lane + " resident=" + resident);
  ok("the hand-back names itself to the operator", notes.some((n) => /HAND-BACK/.test(n)), JSON.stringify(notes.slice(-3)));
  ok("the miss is a protocol debt naming the hand-back, and the round is UNSPENT", (sa.rejection_history ?? []).some((r) => r.kind === "protocol" && /hand-back is owed/.test(r.reason)) && sa.round === 1, JSON.stringify((sa.rejection_history ?? []).slice(-2)));
  const land30 = await sentWhen(/Protocol nudge/);
  ok("the protocol page rides the CODE lane's landing briefing", /Protocol nudge/.test(land30), land30.slice(0, 150));

  // (b) `verifying`: the thinking lane owns this state, so its boundary pays NOTHING.
  notes.length = 0;
  sent.length = 0;
  await exec("planning_done", { tasks: [task("T1"), task("T2")], checks: [["true", "green"]] });
  const base30plan = loads();
  await hooks.agent_end({}, ctx);
  await sleep30(250);
  ok("a phase boundary onto an already-resident lane pays ZERO loads", loads() === base30plan, String(loads() - base30plan));
  await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "x" }, { id: "T2", status: "passed", result: "x" }] });
  const sb0 = await readStateWhen((x) => x.state === "verifying");
  ok("coding_done's green gate reaches verifying", sb0.state === "verifying", sb0.state);
  const base30v = loads();
  await hooks.agent_end({}, ctx);
  const paid30v = await settleLoads(base30v, 1);
  ok("coding_done's verifier swap pays EXACTLY ONE deepseek load", paid30v === 1 && resident === "deepseek", "loads=" + paid30v + " resident=" + resident);
  const base30b = loads();
  notes.length = 0;
  await hooks.agent_end({}, ctx);
  await sleep30(300);
  const sb = readState();
  ok("a phase-less turn in `verifying` pays ZERO loads", loads() === base30b, String(loads() - base30b));
  ok("`verifying` keeps the verifier's lane: no hand-back to the lane that wrote the diff", sb.state === "verifying" && sb.lane === "deepseek" && resident === "deepseek", sb.state + " " + sb.lane + " resident=" + resident);

  // (c) a terminal boundary leaves the lane resident and pays nothing.
  const base30c = loads();
  await exec("verification_done", { verdict: "accepted", checks: [["true", "green"]], notes: "all green" });
  const sc = await readStateWhen((x) => x.state === "complete");
  ok("the accepted verdict completes the run", sc.state === "complete", sc.state);
  await hooks.agent_end({}, ctx);
  await sleep30(250);
  ok("a terminal boundary pays ZERO loads and leaves the thinking lane resident", loads() === base30c && resident === "deepseek", "loads=" + (loads() - base30c) + " resident=" + resident);
  await commands.orchestrate.handler("stop --clear", ctx);

  // (d) the HOSTILE FLIP: an outside process loads the other lane under the owner's feet.
  rmSync(claim30, { force: true });
  resident = "deepseek";
  notes.length = 0;
  sent.length = 0;
  await commands.orchestrate.handler("--rounds 3 a hostile-flip goal", ctx);
  const sd0 = readState();
  ok("a fresh owned run starts on the thinking lane", sd0.state === "planning" && sd0.lane === "deepseek", sd0.state + " " + sd0.lane);
  const base30d1 = loads();
  await hooks.tool_result({ toolName: "grep", isError: false }, ctx); // the turn completed
  await hooks.agent_end({}, ctx); // the hand-back lands the code lane
  const paid30d1 = await settleLoads(base30d1, 1);
  await readStateWhen((x) => x.lane === "flash-next");
  ok("the owned run's thinking-lane turn hands the router to the code lane", paid30d1 === 1 && resident === "flash-next", "loads=" + paid30d1 + " resident=" + resident);
  await fetch((process.env.FADE_ORCHESTRATE_ROUTER ?? "") + "/v1/load", { method: "POST", body: JSON.stringify({ model: "deepseek" }) });
  ok("an outside POST /v1/load moved the router off the authorized lane", resident === "deepseek", resident);
  const base30d = loads();
  notes.length = 0;
  await hooks.agent_end({}, ctx);
  const paid30d = await settleLoads(base30d, 1);
  const sd = await readStateWhen((x) => x.lane_hostile && x.lane === "flash-next");
  ok("the hostile flip is answered in ONE load, landing the authorized lane", paid30d === 1 && resident === "flash-next", "loads=" + paid30d + " resident=" + resident);
  ok("the hostile flip is named to the operator", notes.some((n) => /HOSTILE LANE FLIP/.test(n)), JSON.stringify(notes));
  ok("the hostile flip is in the run's ledger", (sd.rejection_history ?? []).some((r) => /HOSTILE LANE FLIP/.test(r.reason)), JSON.stringify((sd.rejection_history ?? []).slice(-2)));
  ok("the run records the flip it judged", sd.lane_hostile?.resident === "deepseek" && sd.lane_hostile?.authorized === "flash-next", JSON.stringify(sd.lane_hostile));
  notes.length = 0;
  await commands.orchestrate.handler("status", ctx);
  ok("/orchestrate status names the flip the boundary classified", notes.some((n) => /last hostile flip: router deepseek vs authorized flash-next/.test(n)), notes.join(" | ").slice(0, 220));

  // (e) a session WITHOUT the router claim sees the same flip and acts on none of it.
  await commands.orchestrate.handler("stop --clear", ctx);
  writeState({
    ...seedState("coding", [["true", "green"]]),
    lane: "flash-next",
    schema_retries: 0, protocol_retries: 0, stall_count: 0, paused: false, rejection_history: [],
  });
  await hooks.session_start({}, ctx);
  resident = "deepseek"; // an outside process loaded the other lane under a session that holds NO claim
  notes.length = 0;
  const base30e = loads();
  await hooks.agent_end({}, ctx);
  await sleep30(300);
  const se = readState();
  ok("a session with NO router claim pays ZERO loads for the same flip", loads() === base30e, String(loads() - base30e));
  ok("a session with no claim records NOTHING: it has no authority over the router", !("lane_hostile" in se) && !(se.rejection_history ?? []).some((r) => /HOSTILE/.test(r.reason)), JSON.stringify(Object.keys(se)));
  ok("a session with no claim says NOTHING about the router", !notes.some((n) => /HOSTILE/.test(n)), JSON.stringify(notes));
  await commands.orchestrate.handler("stop --clear", ctx);
}

// 31. THE HAND-BACK'S GATES. A hand-back is a 13-25 s, 52-130 GiB PACK SWAP, and the recorded
//     incident is the box running OUT OF RAM because every phase-less thinking-lane turn forced one.
//     So it is owed only by a turn that COMPLETED, and only into a box that can take it. Each case
//     runs on a fresh owned run (the router starts with deepseek resident, so the start pays nothing):
//     (a) a phase-less turn with NO tool answered — the lane is still thinking — pays ZERO loads and
//     keeps the free in-place nudge; (b) the same turn after a tool ANSWERED hands the router to the
//     coder in ONE load, round unspent; (c) with the router BUSY the hand-back is HELD at ZERO loads
//     and the cause is named; (d) with the RAM floor above the box's `MemAvailable` it is HELD at ZERO
//     loads, and the SAME turn lands it once the floor is let back down; (e) with flips already in the
//     window it is HELD at ZERO loads, and `/orchestrate lanes reset` (the ledger release) lets the
//     next completed turn land it in ONE load; (f) a HOSTILE outside flip whose restore cannot be paid
//     is HELD, not forced: the run PAUSES with the lane OWED, ZERO loads, the cause named in the
//     ledger, the notify and `/orchestrate status`, and the release verb lands it in ONE load.
{
  const sleep31 = (ms) => new Promise((r) => setTimeout(r, ms));
  const claim31 = join(process.env.FADE_ORCHESTRATE_LOCK_DIR, "orchestrator.lock");
  const start31 = async (goal) => {
    await commands.orchestrate.handler("stop --clear", ctx);
    rmSync(claim31, { force: true });
    swapLine = null;
    metricsOn = false;
    resident = "deepseek";
    notes.length = 0;
    sent.length = 0;
    const base = loads();
    await commands.orchestrate.handler(`--rounds 3 ${goal}`, ctx);
    const st = readState();
    ok(`the fresh run starts owned, on the thinking lane, at ZERO loads (${goal})`, st.state === "planning" && st.lane === "deepseek" && resident === "deepseek" && loads() === base, `${st.state} ${st.lane} resident=${resident} loads=${loads() - base}`);
    return st;
  };
  const s31 = await start31("a gated hand-back goal");

  // (a) mid-thinking: the turn ANSWERED no tool, so the lane is still working. The old behaviour:
  // the free nudge, in place, ZERO loads. This is the case the hand-back must never buy.
  notes.length = 0;
  const base31a = loads();
  await hooks.agent_end({}, ctx);
  await sleep31(300);
  ok("a phase-less turn with NO tool answered pays ZERO loads", loads() === base31a, String(loads() - base31a));
  ok("mid-thinking keeps deepseek resident and is nudged in place", resident === "deepseek" && readState().lane === "deepseek" && !notes.some((n) => /HAND-BACK/.test(n)), JSON.stringify(notes.slice(-2)));

  // (b) the turn COMPLETED (a tool answered) into an idle router, a healthy context and a quiet
  // window: the hand-back is owed and paid, ONE load, and the round stays unspent.
  notes.length = 0;
  const base31b = loads();
  await hooks.tool_result({ toolName: "read", isError: false }, ctx);
  await hooks.agent_end({}, ctx);
  const paid31b = await settleLoads(base31b, 1);
  const sb31 = await readStateWhen((x) => x.lane === "flash-next");
  ok("a COMPLETED thinking-lane turn hands the router to the code lane in ONE load", paid31b === 1 && resident === "flash-next", "loads=" + paid31b + " resident=" + resident);
  ok("the hand-back names itself, and says no hold", notes.some((n) => /HAND-BACK —/.test(n)) && !notes.some((n) => /HELD/.test(n)), JSON.stringify(notes.slice(-2)));
  ok("the hand-back spends no coding round", sb31.round === 1, String(sb31.round));

  // (c) the router is SERVING (`slots.active` = 1): a hand-back issued into that is the queue the
  // router answers by swapping BACK, so it is HELD — the load is never issued.
  await start31("a busy-router hand-back");
  metricsOn = true;
  notes.length = 0;
  const base31c = loads();
  await hooks.tool_result({ toolName: "read", isError: false }, ctx);
  await hooks.agent_end({}, ctx);
  await sleep31(300);
  const sc31 = readState();
  ok("a COMPLETED turn against a BUSY router pays ZERO loads", loads() === base31c, String(loads() - base31c));
  ok("the busy router HELD the hand-back, cause named", notes.some((n) => /HAND-BACK HELD/.test(n) && /router busy/.test(n)), JSON.stringify(notes.slice(-2)));
  ok("the hold is a protocol debt and the lane stays put", (sc31.rejection_history ?? []).some((r) => r.kind === "protocol" && /hand-back was HELD/.test(r.reason)) && sc31.lane === "deepseek" && resident === "deepseek" && sc31.round === 1, JSON.stringify((sc31.rejection_history ?? []).slice(-1)));
  metricsOn = false;

  // (d) host RAM under the pack floor: a 52-130 GiB swap issued here is the recorded exhaustion, so
  // the hand-back is HELD at zero cost, and the SAME turn lands it once the floor is let down.
  await start31("a low-RAM hand-back");
  process.env.FADE_ORCHESTRATE_RAM_MIN_FREE_MIB = "8388608"; // 8 TiB in MiB: above any box
  notes.length = 0;
  const base31d = loads();
  await hooks.tool_result({ toolName: "read", isError: false }, ctx);
  await hooks.agent_end({}, ctx);
  await sleep31(300);
  ok("a COMPLETED turn under the RAM floor pays ZERO loads", loads() === base31d, String(loads() - base31d));
  ok("the RAM floor HELD the hand-back, cause named", notes.some((n) => /HAND-BACK HELD/.test(n) && /MemAvailable \d+ GiB is under the 8192 GiB pack floor/.test(n)), JSON.stringify(notes.slice(-2)));
  process.env.FADE_ORCHESTRATE_RAM_MIN_FREE_MIB = "0";
  notes.length = 0;
  const base31d2 = loads();
  await hooks.tool_result({ toolName: "read", isError: false }, ctx);
  await hooks.agent_end({}, ctx);
  const paid31d2 = await settleLoads(base31d2, 1);
  await readStateWhen((x) => x.lane === "flash-next");
  ok("with the floor let down the same turn hands back in ONE load", paid31d2 === 1 && resident === "flash-next", "loads=" + paid31d2 + " resident=" + resident);

  // (e) flips ALREADY in the window (the badge's count, one below the breaker): the loop adds no load
  // to a churning window. `/orchestrate lanes reset` is the release the halt names.
  await start31("a churning-window hand-back");
  const poll31 = async () => {
    await hooks.session_start({}, ctx); // the loop's poll is what watches the router's swap line
    await sleep31(30);
  };
  swapLine = { from: "deepseek", to: "flash-next", phase: "loading", waiting: 1 };
  await poll31();
  swapLine = null;
  await poll31();
  swapLine = { from: "deepseek", to: "flash-next", phase: "loading", waiting: 3 };
  await poll31();
  swapLine = null;
  await poll31();
  notes.length = 0;
  const base31e = loads();
  await hooks.tool_result({ toolName: "read", isError: false }, ctx);
  await hooks.agent_end({}, ctx);
  await sleep31(300);
  ok("a COMPLETED turn inside a churning window pays ZERO loads", loads() === base31e, String(loads() - base31e));
  ok("the flip guard HELD the hand-back, count named", notes.some((n) => /HAND-BACK HELD/.test(n) && /FLIP GUARD: 2 swaps in 60s/.test(n)), JSON.stringify(notes.slice(-2)));
  notes.length = 0;
  await commands.orchestrate.handler("lanes reset", ctx); // clears the ledger, lands the owed lane
  await sleep31(200);
  const base31e2 = loads();
  notes.length = 0;
  await hooks.tool_result({ toolName: "read", isError: false }, ctx);
  await hooks.agent_end({}, ctx);
  const paid31e2 = await settleLoads(base31e2, 1);
  await readStateWhen((x) => x.lane === "flash-next");
  ok("a quiet window lets the next completed turn hand back in ONE load", paid31e2 === 1 && resident === "flash-next", "loads=" + paid31e2 + " resident=" + resident);

  // (f) the HOSTILE restore is a pack swap too. When it cannot be paid the run PAUSES with the lane
  // owed and the cause surfaced — it does not force the swap the RAM floor named.
  await start31("a hostile restore under the RAM floor");
  notes.length = 0;
  const base31f0 = loads();
  await hooks.tool_result({ toolName: "read", isError: false }, ctx);
  await hooks.agent_end({}, ctx); // the hand-back lands the code lane: the authorized lane is flash-next
  await settleLoads(base31f0, 1);
  await readStateWhen((x) => x.lane === "flash-next");
  process.env.FADE_ORCHESTRATE_RAM_MIN_FREE_MIB = "8388608"; // the restore is a pack swap too
  await fetch((process.env.FADE_ORCHESTRATE_ROUTER ?? "") + "/v1/load", { method: "POST", body: JSON.stringify({ model: "deepseek" }) });
  notes.length = 0;
  const base31f = loads();
  await hooks.agent_end({}, ctx);
  await sleep31(300);
  const sf31 = readState();
  ok("a hostile flip the RAM floor refuses pays ZERO loads", loads() === base31f && resident === "deepseek", "loads=" + (loads() - base31f) + " resident=" + resident);
  ok("the unpayable restore PAUSES the run with the lane owed", sf31.paused === true && sf31.lane === "flash-next" && sf31.lane_hostile?.resident === "deepseek", JSON.stringify({ paused: sf31.paused, lane: sf31.lane, hostile: sf31.lane_hostile }));
  ok("the hold names the cause and the release", notes.some((n) => /HOSTILE LANE FLIP/.test(n) && /restore HELD/.test(n) && /MemAvailable/.test(n) && /lanes reset/.test(n)), JSON.stringify(notes.slice(-2)));
  ok("the ledger carries the held restore", (sf31.rejection_history ?? []).some((r) => /HOSTILE LANE FLIP/.test(r.reason) && /restore is HELD/.test(r.reason)), JSON.stringify((sf31.rejection_history ?? []).slice(-1)));
  notes.length = 0;
  await commands.orchestrate.handler("status", ctx);
  ok("/orchestrate status names the flip the boundary classified", notes.some((n) => /last hostile flip: router deepseek vs authorized flash-next/.test(n)), notes.join(" | ").slice(0, 220));
  process.env.FADE_ORCHESTRATE_RAM_MIN_FREE_MIB = "0";
  notes.length = 0;
  const base31f2 = loads();
  await commands.orchestrate.handler("lanes reset", ctx);
  const paid31f2 = await settleLoads(base31f2, 1);
  const sf31b = await readStateWhen((x) => x.lane === "flash-next" && x.paused !== true);
  ok("the release lands the owed restore in ONE load, unpaused", paid31f2 === 1 && resident === "flash-next" && sf31b.paused !== true, "loads=" + paid31f2 + " resident=" + resident + " paused=" + String(sf31b.paused));
  process.env.FADE_ORCHESTRATE_RAM_MIN_FREE_MIB = "0";
  await commands.orchestrate.handler("stop --clear", ctx);
}
const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ checks, notes, requests: reqLog.length }, null, 1));
if (failed.length > 0) {
  console.error(JSON.stringify({ failed: failed.map((f) => `${f.name} (${f.detail})`) }, null, 1));
  process.exit(1);
}
console.log("gate rig: all checks pass");
process.exit(0);
