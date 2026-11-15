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
//  12. an accepted verification tags `omp-ckpt/<run>/T<n>-passed` in the repo.
//
// Usage: node test/gate_rig.mjs
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repo = join(tmpdir(), "orch-gate-rig");
rmSync(repo, { recursive: true, force: true });
mkdirSync(join(repo, "var", "omp-orchestrate"), { recursive: true });

// ---- stub router: counts requests, tracks the resident lane ----
const reqLog = [];
let resident = "flash-next";
let metricsOn = true;
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
  if (req.url === "/metrics")
    return send(200, { requests: metricsOn ? [{ pp: 1499, decode_tok_s: 130, ttft_s: 0.4, hit_rate: 0.82 }] : [] });
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
let activeTools = ["read", "bash", "edit", "write", "grep", "task"];
const pi = {
  registerTool: (t) => void (tools[t.name] = t),
  registerCommand: (name, c) => void (commands[name] = c),
  on: (evt, h) => void (hooks[evt] = h),
  registerShortcut: () => {},
  setModel: async () => ({ switched: true }),
  setThinkingLevel: () => {},
  getActiveTools: () => activeTools,
  setActiveTools: (t) => void (activeTools = t),
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

// 9. Tier-1 protocol gate (Y1): a turn that ends with no `fade_phase` is protocol debt. The
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

// 12. Y18 turn ledger: one line per turn from the router's numbers, and NO line without them.
{
	const jsonl = join(repo, "var", "omp-orchestrate", "metrics.jsonl");
	const lines = () => (existsSync(jsonl) ? readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean) : []);
	metricsOn = true;
	await exec("coding_done", { done: [{ id: "T1", status: "passed", result: "rig" }, { id: "T2", status: "passed", result: "rig" }] });
	await hooks.agent_end({}, ctx);
	await new Promise((r) => setTimeout(r, 60));
	const withMetrics = lines();
	const last = JSON.parse(withMetrics[withMetrics.length - 1] ?? "{}");
	ok("the ledger writes one JSONL line per turn from the router's numbers", withMetrics.length >= 1 && last.pp === 1499 && last.tg === 130 && last.phase === "coding_done" && typeof last.swap_ms === "number", JSON.stringify(last));
	metricsOn = false;
	const before = lines().length;
	await exec("verification_done", { verdict: "needs_repair", notes: "rig repair", tasks: [task("T2")] });
	await hooks.agent_end({}, ctx);
	await new Promise((r) => setTimeout(r, 60));
	ok("a router reporting no pp/tg appends NO line (never a fabricated zero)", lines().length === before, `${before} → ${lines().length}`);
}

// 13. Y15 verifier sandbox: the thinking lane has no writers, and the guard enforces it.
{
	activeTools = ["read", "bash", "edit", "write", "grep", "task", "fade_phase"];
	await commands.orchestrate.handler("verify", ctx);
	await new Promise((r) => setTimeout(r, 60));
	ok("the verifier lane's active set carries no writers", !activeTools.includes("edit") && !activeTools.includes("write") && !activeTools.includes("task") && activeTools.includes("fade_phase"), JSON.stringify(activeTools));
	const blocked = await hooks.tool_call({ type: "tool_call", toolName: "edit", toolCallId: "x", input: {} }, ctx);
	ok("a verifier edit is BLOCKED with the rule named", blocked?.block === true && /read-only/.test(blocked.reason ?? ""), JSON.stringify(blocked));
	const spawn = await hooks.tool_call({ type: "tool_call", toolName: "task", toolCallId: "y", input: {} }, ctx);
	ok("a verifier subagent is blocked too (it can edit)", spawn?.block === true, JSON.stringify(spawn));
	const allowed = await hooks.tool_call({ type: "tool_call", toolName: "read", toolCallId: "z", input: {} }, ctx);
	ok("a verifier read is NOT blocked", allowed === undefined, JSON.stringify(allowed));
}

// 14. Y16: every task accepted by the verifier leaves a checkpoint tag the tree rolls back to.
{
	await exec("verification_done", { verdict: "accepted", checks: [["true", "green"]], notes: "rig accepted" });
	const s = readState();
	ok("accepted verification tags one checkpoint per passed task", s.checkpoints?.T1 === "omp-ckpt/GATE1/T1-passed" && s.checkpoints?.T2 === "omp-ckpt/GATE1/T2-passed", JSON.stringify(s.checkpoints));
	const tagList = execFileSync("git", ["-C", repo, "tag", "-l"], { encoding: "utf8" });
	ok("the checkpoint tag exists in the repo", tagList.includes("omp-ckpt/GATE1/T1-passed"), tagList.trim().split("\n").join(","));
	ok("the run completes", s.state === "complete", s.state);
}

// 15. A delegated (subagent) session NEVER drives the loop. It shares the cwd, so an unguarded
//     session_start adopted the operator's run and paid a verifier swap per spin-up (measured:
//     70.1 s of pack swap and 181.7 GiB loaded across two spin-ups, zero tokens served).
{
	const nested = join(repo, "sessions", "2026-11-15T09-11-28-519Z_01a1de79-d407-740b-a74e-ce2c57a1c556", "Worker.jsonl");
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

server.close();
const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ checks, notes, requests: reqLog.length }, null, 1));
if (failed.length > 0) {
  console.error(JSON.stringify({ failed: failed.map((f) => `${f.name} (${f.detail})`) }, null, 1));
  process.exit(1);
}
console.log("gate rig: all checks pass");
process.exit(0);
