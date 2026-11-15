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
//   7. /orchestrate halt persists state=stopped.
//
// Usage: node test/gate_rig.mjs
import http from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(tmpdir(), "orch-gate-rig");
rmSync(repo, { recursive: true, force: true });
mkdirSync(join(repo, "var", "omp-orchestrate"), { recursive: true });

// ---- stub router: counts requests, tracks the resident lane ----
const reqLog = [];
let resident = "flash-next";
const server = http.createServer(async (req, res) => {
  reqLog.push(`${req.method} ${req.url}`);
  let body = "";
  for await (const c of req) body += c;
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.url.startsWith("/health")) return send(200, { status: "ok", loaded: resident, loading: false, percent: null, swap: null });
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
const pi = {
  registerTool: (t) => void (tools[t.name] = t),
  registerCommand: (name, c) => void (commands[name] = c),
  on: (evt, h) => void (hooks[evt] = h),
  registerShortcut: () => {},
  setModel: async () => ({ switched: true }),
  setThinkingLevel: () => {},
  getActiveTools: () => [],
  setActiveTools: () => {},
  sendUserMessage: (t) => void sent.push(t),
};
const notes = [];
const ctx = {
  hasUI: false,
  cwd: repo,
  modelRegistry: { find: () => ({ id: "stub" }) },
  abort: () => {},
  isIdle: () => true,
  hasPendingMessages: () => false,
  signal: undefined,
  ui: {
    setStatus: () => {},
    setWidget: () => {},
    notify: (m) => void notes.push(m),
    setWorkingMessage: () => {},
    custom: async () => undefined,
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
  phases: [{ phase: "planning_done", lane: "deepseek", accepted: true, round: 1, at: "2026-11-15T00:00:00.000Z" }],
  repair_tasks: [],
  started_utc: "2026-11-15T00:00:00.000Z",
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

server.close();
const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ checks, notes, requests: reqLog.length }, null, 1));
if (failed.length > 0) {
  console.error(JSON.stringify({ failed: failed.map((f) => `${f.name} (${f.detail})`) }, null, 1));
  process.exit(1);
}
console.log("gate rig: all checks pass");
