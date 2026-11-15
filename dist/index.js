// src/index.ts
import { unlinkSync } from "node:fs";
import { basename, dirname, join as join5 } from "node:path";
import { Type } from "typebox";

// src/router.ts
var ROUTER = process.env.FADE_ORCHESTRATE_ROUTER ?? "http://127.0.0.1:18014";
var PROVIDER = process.env.FADE_ORCHESTRATE_PROVIDER ?? "strata-flash";
var THINK_LANE = process.env.FADE_ORCHESTRATE_THINK_LANE ?? "deepseek";
var CODE_LANE = process.env.FADE_ORCHESTRATE_CODE_LANE ?? "flash-next";
var THINKING = { [THINK_LANE]: "high", [CODE_LANE]: "low" };
var msg = (e) => e instanceof Error ? e.message : String(e);
async function listLanes() {
  try {
    const h = await fetch(`${ROUTER}/health`, { signal: AbortSignal.timeout(4e3) });
    const body = await h.json().catch(() => null);
    const health = h.ok ? String(body?.status ?? "ok") : `http ${h.status}`;
    const r = await fetch(`${ROUTER}/v1/models`, { signal: AbortSignal.timeout(4e3) });
    const listing = await r.json();
    const models = (listing?.data ?? []).map((m) => ({
      id: String(m.id ?? m.model ?? "?"),
      status: String(m.status?.value ?? m.status ?? m.state ?? "?")
    }));
    return { health, models };
  } catch (e) {
    return { health: "unreachable", models: [], error: msg(e) };
  }
}
async function laneHealth() {
  try {
    const r = await fetch(`${ROUTER}/health`, { signal: AbortSignal.timeout(4e3) });
    return await r.json();
  } catch {
    return void 0;
  }
}
var SETTLE_POLL_MS = 2e3;
var SETTLE_MAX_MS = 12e4;
async function loadLane(lane) {
  for (let waited = 0; waited < SETTLE_MAX_MS; waited += SETTLE_POLL_MS) {
    if ((await laneHealth())?.loading !== true) break;
    const { promise: settle, resolve: settleDone } = Promise.withResolvers();
    setTimeout(settleDone, SETTLE_POLL_MS);
    await settle;
  }
  const resident = (await listLanes()).models.find((m) => m.status === "loaded")?.id;
  const flip = flipState(resident, FLIP_WINDOW_MS);
  const guarded = flipGuarded(flip);
  if (resident === lane) return { ok: true, detail: `already resident; no swap issued${flipNote(flip)}`, elapsed_s: 0, guarded, flip };
  const t0 = Date.now();
  try {
    const r = await fetch(`${ROUTER}/v1/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: lane }),
      signal: AbortSignal.timeout(24e4)
    });
    const text = await r.text();
    return { ok: r.ok, detail: `http ${r.status} ${text.length > 300 ? `${text.slice(0, 300)}...` : text}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1e3, guarded, flip };
  } catch (e) {
    return { ok: false, detail: `${msg(e)}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1e3, guarded, flip };
  }
}
var finite = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
async function metricsSnapshot() {
  try {
    const r = await fetch(`${ROUTER}/metrics`, { signal: AbortSignal.timeout(4e3) });
    return r.ok ? await r.json() : void 0;
  } catch {
    return void 0;
  }
}
function prefillRate(r) {
  const pp = finite(r?.pp);
  if (pp !== void 0 && pp > 0) return pp;
  const n = finite(r?.prompt_tokens) ?? finite(r?.prompt_n);
  if (n === void 0 || n <= 0) return void 0;
  const ms = finite(r?.prompt_ms);
  const secs = ms !== void 0 && ms > 0 ? ms / 1e3 : finite(r?.ttft_s);
  return secs !== void 0 && secs > 0 ? n / secs : void 0;
}
function openRequestRow(metrics) {
  const rows = Array.isArray(metrics?.requests) ? metrics.requests : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r) continue;
    if (typeof r.finish === "string" || finite(r.duration_s) !== void 0) continue;
    if (finite(r.decode_tok_s) !== void 0 || finite(r.ttft_s) !== void 0) continue;
    const pp = prefillRate(r);
    if (pp !== void 0 && pp > 0) return r;
  }
  return void 0;
}
async function routerBusy() {
  const [health, metrics] = await Promise.all([laneHealth(), metricsSnapshot()]);
  const live = metrics?.live ?? {};
  const slots = live.slots ?? {};
  const running = finite(slots.active) ?? 0;
  const waiting = finite(live.queued) ?? finite(slots.queue_depth) ?? (Array.isArray(live.queue) ? live.queue.length : 0);
  const counters = `running=${running} waiting=${waiting}`;
  const phase = typeof live.phase === "string" ? ` (${live.phase})` : "";
  if (health === void 0 && metrics === void 0) {
    return { busy: false, running: 0, waiting: 0, reason: `router unreachable at ${ROUTER}: /health and /metrics both refused; a router that cannot answer is never read as a serving lane, so the load is not held` };
  }
  if (health?.loading === true) {
    const sw = health.swap;
    const pct = finite(health.percent);
    return { busy: true, running, waiting, reason: `swap in flight${sw?.from ? ` ${sw.from} -> ${sw.to ?? "?"}` : ""}${pct !== void 0 ? ` at ${Math.round(pct)}%` : ""}${phase}; ${counters}` };
  }
  if (running > 0 || waiting > 0) {
    return { busy: true, running, waiting, reason: `slot busy: ${typeof live.state === "string" ? live.state : "serving"}${phase}; ${counters}` };
  }
  const open = openRequestRow(metrics);
  if (open) {
    const pp = prefillRate(open);
    return { busy: true, running, waiting, reason: `request ${open.id ?? "?"} is prompting (pp=${pp === void 0 ? "?" : Math.round(pp)} tok/s) with no decode_tok_s and no ttft_s yet${phase}; ${counters}` };
  }
  const resident = health?.model ?? (typeof health?.loaded === "string" ? health.loaded : void 0) ?? "?";
  return { busy: false, running, waiting, reason: `idle: ${resident} resident, no swap, no open request${metrics === void 0 ? ", /metrics unread" : ""}; ${counters}` };
}
var FLIP_WINDOW_MS = Number(process.env.FADE_ORCHESTRATE_FLIP_WINDOW_MS ?? 12e4);
var FLIP_MIN_SWAPS = Number(process.env.FADE_ORCHESTRATE_FLIP_MIN_SWAPS ?? 2);
var swapLog = [];
var lastSwapSig = "";
async function residentLane() {
  return (await listLanes()).models.find((m) => m.status === "loaded")?.id;
}
async function observeSwaps(windowMs = FLIP_WINDOW_MS) {
  const h = await laneHealth();
  const s = h?.swap;
  if (s && s.to) {
    const sig = `${s.from ?? "?"}->${s.to}`;
    if (sig !== lastSwapSig) swapLog.push({ from: s.from ?? "?", to: s.to, at: Date.now(), waiting: finite(s.waiting) });
    lastSwapSig = sig;
  } else {
    lastSwapSig = "";
  }
  return flipState(await residentLane(), windowMs);
}
function flipState(resident, windowMs = FLIP_WINDOW_MS) {
  const horizon = Date.now() - windowMs;
  const rows = swapLog.filter((r) => r.at >= horizon);
  while (swapLog.length > 0 && swapLog[0].at < horizon) swapLog.shift();
  while (swapLog.length > 50) swapLog.shift();
  const away = rows.filter((r) => resident === void 0 || r.to !== resident);
  return {
    flips: away.length,
    window_s: Math.round(windowMs / 1e3),
    competing: [...new Set(away.map((r) => r.to))],
    rows
  };
}
var flipGuarded = (f) => f.flips >= FLIP_MIN_SWAPS;
var flipNote = (f) => flipGuarded(f) ? ` \u2014 FLIP GUARD: ${f.flips} swaps in ${f.window_s}s, requests naming ${f.competing.join(", ") || "the other lane"}` : "";

// src/core.ts
import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
var STATE_KEY = "fade.omp_orchestrate.v1";
var ACTIVE_FILENAME = "ACTIVE.json";
var STATE_FILENAME = "state.json";
var DEFAULT_ROUNDS = 6;
var MAX_ROUNDS = 6;
var MAX_TASKS = 6;
var TERMINAL = { complete: true, failed: true, stopped: true };
var PHASE_FOR_STATE = { planning: "planning_done", coding: "coding_done", repair: "coding_done", verifying: "verification_done" };
var MAX_REJECTIONS = 50;
function normalizeRun(st) {
  if (!Array.isArray(st.rejection_history)) st.rejection_history = [];
  if (typeof st.schema_retries !== "number") st.schema_retries = 0;
  if (typeof st.protocol_retries !== "number") st.protocol_retries = 0;
  if (typeof st.stall_count !== "number") st.stall_count = 0;
  if (typeof st.paused !== "boolean") st.paused = false;
  return st;
}
function pushRejection(run, kind, reason, task_id) {
  if (!Array.isArray(run.rejection_history)) run.rejection_history = [];
  run.rejection_history.push({ round: run.round, at: (/* @__PURE__ */ new Date()).toISOString(), kind, reason, task_id });
  if (run.rejection_history.length > MAX_REJECTIONS) run.rejection_history.splice(0, run.rejection_history.length - MAX_REJECTIONS);
}
var STALL_SYNTHESIZE_AT = 2;
var STALL_HALT_AT = 3;
function classifyTurnEnd(run, hadPhase) {
  if (hadPhase) {
    run.stall_count = 0;
    return "phase";
  }
  run.protocol_retries = (run.protocol_retries ?? 0) + 1;
  run.stall_count = (run.stall_count ?? 0) + 1;
  if (run.stall_count >= STALL_HALT_AT) return "stall";
  if (run.stall_count >= STALL_SYNTHESIZE_AT) return "synthesize";
  return "nudge";
}
function isGitRepo(repo) {
  try {
    execFileSync("git", ["-C", repo, "rev-parse", "--git-dir"], { timeout: 5e3, maxBuffer: 1 << 20, encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
var notARepo = (repo) => `(not a git repo: ${repo} \u2014 no git evidence; start the run inside a working tree, or run \`git init\` in it)`;
function porcelain(repo) {
  if (!isGitRepo(repo)) return notARepo(repo);
  try {
    const out = execFileSync("git", ["-C", repo, "status", "--porcelain"], { timeout: 5e3, maxBuffer: 1 << 20, encoding: "utf8" });
    const head = `${out}`.replace(/\n+$/, "").split("\n").slice(0, 200).join("\n");
    return head || "(working tree clean)";
  } catch (e) {
    return `(git status failed: ${msg(e)} in ${repo})`;
  }
}
function adaptiveRounds(nTasks, budget) {
  return Math.min(budget, Math.max(3, 2 + Math.ceil(nTasks / 2)));
}
var SCHEMA_HINT = 'Payload schemas (exact, no extra keys; payload is the JSON object serialized to a string): planning_done {"tasks":[{"id":"T1","objective":"...","files":["a/b.ts"],"acceptance":"one command and what it proves","dependencies":[]}],"checks":[["cmd","expected"]]}; coding_done {"done":[{"id":"T1","status":"passed|failed|blocked","result":"what the acceptance command observed"},{"id":"T2","status":"passed|failed|blocked","result":"what its acceptance command observed"}]} \u2014 ONE coding_done reports EVERY task of the window; verification_done {"verdict":"accepted|needs_repair","checks":[["cmd","observed"]],"notes":"the critique","tasks":[repair tasks, same shape as planning tasks]}.';
function checkParses(cmd) {
  try {
    execFileSync("/bin/bash", ["-n", "-c", cmd], { stdio: "pipe", timeout: 5e3 });
    return { ok: true, detail: "" };
  } catch (e) {
    const err = e;
    return { ok: false, detail: `${err.stderr ?? ""}${err.message ?? String(e)}`.replace(/\s+/g, " ").slice(0, 220) };
  }
}
function runGate(checks, cwd) {
  const results = checks.map(([cmd, expected]) => {
    const parse = checkParses(cmd);
    if (!parse.ok) {
      return {
        cmd,
        expected,
        ok: false,
        invalid: true,
        tail: `not a command \u2014 bash -n: ${parse.detail} | plan defect: re-declare this check (planning_done); no tree state can make it pass`
      };
    }
    try {
      const out = execFileSync("/bin/bash", ["-lc", cmd], { cwd, timeout: 12e4, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
      return { cmd, expected, ok: true, tail: `${out}`.slice(-400) };
    } catch (e) {
      const err = e;
      return { cmd, expected, ok: false, tail: `${err.stdout ?? ""}${err.message ?? String(e)}`.slice(-400) };
    }
  });
  return { at: (/* @__PURE__ */ new Date()).toISOString(), passed: results.every((r) => r.ok), results };
}
function refreshChecks(run, live) {
  const before = run.checks.map((c) => c[0]);
  if (!live || live.run_id !== run.run_id || !Array.isArray(live.checks)) return { changed: false, to: before.length, added: [], removed: [] };
  const isPair = (c) => Array.isArray(c) && c.length === 2 && typeof c[0] === "string" && typeof c[1] === "string";
  const next = live.checks.filter(isPair);
  const after = next.map((c) => c[0]);
  if (JSON.stringify(before) === JSON.stringify(after)) return { changed: false, to: after.length, added: [], removed: [] };
  run.checks = next;
  return { changed: true, to: after.length, added: after.filter((c) => !before.includes(c)), removed: before.filter((c) => !after.includes(c)) };
}
function diffStat(repo) {
  if (!isGitRepo(repo)) return notARepo(repo);
  try {
    const out = execFileSync("git", ["-C", repo, "diff", "--stat"], { timeout: 5e3, maxBuffer: 1 << 20, encoding: "utf8" });
    const tail = `${out}`.trim().split("\n").slice(-6).join("\n");
    return tail || "(working tree clean)";
  } catch (e) {
    return `(git diff failed: ${msg(e)} in ${repo})`;
  }
}
var XY = /^[ MADRCU?!][ MADRCU?!] /;
function porcelainEntries(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!XY.test(line)) continue;
    const status = line.slice(0, 2);
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    out.push({ status, path: path.replace(/^"|"$/g, "") });
  }
  return out;
}
function entryTouches(e, files) {
  return files.some((f) => {
    if (e.path === f) return true;
    const entryDir = e.path.endsWith("/") ? e.path : `${e.path}/`;
    const fileDir = f.endsWith("/") ? f : `${f}/`;
    return f.startsWith(entryDir) || e.path.startsWith(fileDir);
  });
}
function gateSummary(run) {
  const g = run.gate_last;
  if (!g) return "(no pre-swap gate recorded)";
  const parts = g.results.map((r) => `${r.ok ? "ok" : r.invalid ? "INVALID" : "FAIL"} ${r.cmd}${r.ok ? "" : ` -> ${r.tail}`}`);
  return `gate ${g.at} ${g.passed ? "GREEN" : "RED"}: ${parts.join(" | ") || "no checks"}`;
}
function synthesizeCodingDone(run, repo) {
  const raw = porcelain(repo);
  const entries = porcelainEntries(raw);
  const stat = diffStat(repo);
  const gate = gateSummary(run);
  const tasks = run.tasks.length > 0 ? run.tasks : run.repair_tasks;
  const done = tasks.map((t) => {
    const hits = entries.filter((e) => entryTouches(e, t.files));
    if (hits.length === 0) {
      return { id: t.id, status: "blocked", result: `synthesize: no working-tree change matches ${JSON.stringify(t.files)} \u2014 git status --porcelain says [${raw.slice(0, 300)}]` };
    }
    const quoted = hits.slice(0, 8).map((e) => `${e.status} ${e.path}`).join(", ");
    return { id: t.id, status: "passed", result: `synthesize: git status --porcelain shows ${hits.length} ${hits.length === 1 ? "entry" : "entries"} touching this task's declared files [${quoted}]` };
  });
  run.synthesized = { phase: "coding_done", round: run.round, at: (/* @__PURE__ */ new Date()).toISOString() };
  return { done, sources: { porcelain: raw, diffStat: stat, gate } };
}
function checkpointName(run, taskId) {
  return `omp-ckpt/${run.run_id}/${taskId}-passed`;
}
function tagCheckpoint(repo, run, taskId) {
  const tag = checkpointName(run, taskId);
  if (!isGitRepo(repo)) return { tag, ok: false, error: `not a git repo: ${repo} \u2014 no checkpoint tag is possible` };
  try {
    execFileSync("git", ["-C", repo, "tag", "-f", tag], { timeout: 5e3, maxBuffer: 1 << 20, encoding: "utf8" });
    if (typeof run.checkpoints !== "object" || run.checkpoints === null) run.checkpoints = {};
    run.checkpoints[taskId] = tag;
    return { tag, ok: true };
  } catch (e) {
    return { tag, ok: false, error: msg(e) };
  }
}
function handover(run) {
  const stable = [
    `Resume of orchestrated run ${run.run_id} (${run.state}, round ${run.round}/${run.max_rounds}).`,
    `Goal: ${run.goal}`,
    `Phase contract: call the fade_phase tool with ONE validated phase per turn \u2014 planning_done {"tasks":[...],"checks":[["cmd","expected"]]}; coding_done {"done":[{"id","status","result"}]}; verification_done {"verdict":"accepted|needs_repair","checks":[[...]],"notes","tasks"}. Invalid payloads are refused by name.`,
    `Checks the plan declares: ${JSON.stringify(run.checks)}`,
    `Task definitions: ${JSON.stringify(
      run.tasks.map((t) => ({ id: t.id, objective: t.objective, files: t.files, acceptance: t.acceptance, dependencies: t.dependencies }))
    )}`
  ];
  const volatile = [
    `Task state: ${JSON.stringify(run.tasks.map((t) => ({ id: t.id, status: t.status ?? "pending", result: t.result ?? "" })))}`,
    ...run.repair_tasks.length > 0 ? [`In repair: ${JSON.stringify(run.repair_tasks.map((t) => ({ id: t.id, objective: t.objective, acceptance: t.acceptance })))}`] : [],
    ...run.gate_last && run.gate_last.passed === false ? [`Last pre-swap gate FAILED: ${JSON.stringify(run.gate_last.results.filter((r) => !r.ok).map((r) => ({ cmd: r.cmd, tail: r.tail })))}`] : [],
    ...run.rejection_history.length > 0 ? [
      `Rejections so far (do not repeat): ${JSON.stringify(
        run.rejection_history.slice(-5).map((r) => ({ round: r.round, kind: r.kind, task: r.task_id, reason: r.reason }))
      )}`
    ] : [],
    `Working tree: ${diffStat(run.repo)}`
  ];
  return { stable, volatile };
}
function handoverText(run) {
  const h = handover(run);
  return [
    ...h.stable,
    "",
    ...h.volatile,
    "",
    `Continue from here: the resident lane is ${run.lane}. Report the next phase with fade_phase.`
  ].join("\n");
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return void 0;
  }
}
function writeJson(path, value) {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}
`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
  }
}
function isRepoRelative(path) {
  if (typeof path !== "string" || path.trim() === "" || isAbsolute(path)) return false;
  return !path.split(/[\\/]/).includes("..");
}
function validateTasks(raw) {
  if (!Array.isArray(raw)) return { error: "tasks must be an array" };
  if (raw.length > MAX_TASKS) return { error: `at most ${MAX_TASKS} tasks` };
  const seen = /* @__PURE__ */ new Set();
  const tasks = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return { error: "each task must be an object" };
    const t = item;
    const id = t.id;
    if (typeof id !== "string" || !/^T[1-6]$/.test(id)) return { error: `task id ${JSON.stringify(id)} is not T1..T6` };
    if (seen.has(id)) return { error: `duplicate task id ${id}` };
    seen.add(id);
    if (typeof t.objective !== "string" || t.objective.trim() === "") return { error: `${id}: objective is required` };
    if (!Array.isArray(t.files) || t.files.length === 0) return { error: `${id}: files must be a non-empty array` };
    for (const f of t.files) if (!isRepoRelative(f)) return { error: `${id}: file ${JSON.stringify(f)} is not repo-relative` };
    if (typeof t.acceptance !== "string" || t.acceptance.trim() === "") return { error: `${id}: acceptance is required` };
    const deps = t.dependencies ?? [];
    if (!Array.isArray(deps)) return { error: `${id}: dependencies must be an array` };
    for (const d of deps) {
      if (typeof d !== "string" || !seen.has(d)) return { error: `${id}: dependency ${JSON.stringify(d)} must name an earlier task` };
    }
    tasks.push({ id, objective: String(t.objective), files: t.files, acceptance: String(t.acceptance), dependencies: deps, round: 0 });
  }
  return { tasks };
}
function validateChecks(raw) {
  if (!Array.isArray(raw)) return { error: "checks must be an array" };
  const checks = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((x) => typeof x !== "string")) return { error: "each check must be [command, expected]" };
    const cmd = pair[0];
    const parse = checkParses(cmd);
    if (!parse.ok) {
      return {
        error: `check ${checks.length + 1} is not a command \u2014 bash cannot parse it: ${parse.detail} | the command ${JSON.stringify(cmd)} (a <placeholder> in the text is a shell redirect, not an argument); re-declare the check with a runnable command (e.g. the tool's own --ref/--root form)`
      };
    }
    checks.push([cmd, pair[1]]);
  }
  return { checks };
}
var PLAN_ACT_NOTE = "plan act: checks re-declared (the gate proved a check is not a command)";
function sameTaskPlan(a, b) {
  if (!Array.isArray(b) || a.length !== b.length) return false;
  const key = (t) => JSON.stringify([t.id, t.objective, [...t.files].sort(), t.acceptance, [...t.dependencies].sort()]);
  const want = a.map(key).sort();
  const got = b.map(key).sort();
  return want.length === got.length && want.every((k, i) => k === got[i]);
}
var MAX_WINDOW_TASKS = 4;
function windowPool(run) {
  return (run.repair_tasks ?? []).length > 0 ? run.repair_tasks : run.tasks;
}
function roundWindow(run) {
  const pool = windowPool(run);
  const resolved = new Set(pool.filter((t) => t.status === "passed").map((t) => t.id));
  const unmet = (t) => t.dependencies.filter((d) => !resolved.has(d));
  const open = pool.filter((t) => t.status !== "passed");
  const readyNow = open.filter((t) => unmet(t).length === 0).slice(0, MAX_WINDOW_TASKS);
  const taken = new Set(readyNow.map((t) => t.id));
  const blocked = open.filter((t) => !taken.has(t.id)).map((t) => ({ id: t.id, blockedBy: unmet(t) })).filter((b) => b.blockedBy.length > 0);
  return { readyNow, blocked, open };
}
var briefings = {
  plan: (run) => [
    `Phase 0 (planning), round ${run.round} of orchestrated run ${run.run_id}.`,
    `Goal: ${run.goal}`,
    `Produce a plan as a SINGLE object {"tasks":[...],"checks":[...]} with at most ${MAX_TASKS} tasks. Each task: {"id":"T<n>","objective":"...","files":["repo/relative/path"],"acceptance":"one command and what it proves","dependencies":[]}.`,
    `Give dependent tasks earlier ids first. Files are repo-relative and disjoint. Plan only: no edits, no writes.`,
    `Then call the fade_phase tool: phase="planning_done", payload=<that JSON as a string>.`
  ].join("\n"),
  code: (run) => [
    `Phase 1 (coding), round ${run.round} of orchestrated run ${run.run_id}.`,
    `Goal: ${run.goal}`,
    `Tasks: ${JSON.stringify(run.tasks)}`,
    `Implement exactly these tasks in ${run.repo}. After each task run its acceptance command and record what it observed. Do not commit.`,
    `Then call the fade_phase tool: phase="coding_done", payload={"done":[{"id":"T<n>","status":"passed"|"failed"|"blocked","result":"..."}]}`
  ].join("\n"),
  /**
   * Y7: the coder's BATCH briefing — one window, one turn, one `coding_done`. Every task of
   * `roundWindow().readyNow` is spelled out UNTRUNCATED (objective, files, acceptance,
   * dependencies) because a card the lane cannot read in full is a card it implements from
   * imagination; the blocked tasks are listed with the ids that hold them so the lane knows what
   * to leave alone; and the one-payload contract is stated in the turn's own words, which is the
   * half that kills the per-task window (the refusal in `validateDone` is the other half).
   */
  window: (run) => {
    const { readyNow, blocked, open } = roundWindow(run);
    const inWindow = new Set(readyNow.map((t) => t.id));
    const blockedIds = new Set(blocked.map((b) => b.id));
    const deferred = open.filter((t) => !inWindow.has(t.id) && !blockedIds.has(t.id)).map((t) => t.id);
    const entry = (id) => `{"id":"${id}","status":"passed"|"failed"|"blocked","result":"what the acceptance command observed"}`;
    return [
      `Phase 1 (coding) \u2014 ONE WINDOW, round ${run.round}/${run.max_rounds} \xB7 T${readyNow.length}/${open.length} \xB7 lane ${run.lane} \xB7 orchestrated run ${run.run_id}.`,
      `Goal: ${run.goal}`,
      readyNow.length > 0 ? `Window contract: this ONE turn implements EVERY task below in ${run.repo} and reports them ALL in ONE coding_done payload: {"done":[${readyNow.map((t) => entry(t.id)).join(",")}]}. Do not report after one task and do not take a second coding turn for these tasks \u2014 one window, one coding_done, one lane swap.` : `The window is EMPTY: every open task is blocked by an unpassed dependency. There is nothing to implement in this turn \u2014 do not send a coding_done naming a blocked task; report the blockers and end the turn.`,
      readyNow.length > 0 ? `Tasks in this window (${readyNow.length} of ${open.length} open), each card in full:` : `Tasks in this window: none.`,
      ...readyNow.flatMap((t) => [
        `  ${t.id} [${t.status ?? "pending"}] objective: ${t.objective}`,
        `      files: ${t.files.join(", ")}`,
        `      acceptance: ${t.acceptance}`,
        `      dependencies: ${t.dependencies.length > 0 ? t.dependencies.join(", ") : "-"}`
      ]),
      blocked.length > 0 ? `NOT in this window, unmet dependencies \u2014 do not start them and never name one in coding_done: ${blocked.map((b) => `${b.id} blocked by ${b.blockedBy.join(", ")}`).join("; ")}.` : `Nothing is blocked by a dependency.`,
      deferred.length > 0 ? `Ready but past the ${MAX_WINDOW_TASKS}-task window cap (the NEXT window's work, leave it alone now): ${deferred.join(", ")}.` : "",
      `Run each task's acceptance command and put what it printed in that task's "result". Do not commit.`
    ].filter(Boolean).join("\n");
  },
  verify: (run) => [
    `Phase 2 (verification), round ${run.round} of orchestrated run ${run.run_id}.`,
    `Goal: ${run.goal}`,
    `Task results: ${JSON.stringify(run.tasks.map((t) => ({ id: t.id, status: t.status, result: t.result, files: t.files, acceptance: t.acceptance })))}`,
    `Read the diff (run "git diff" in ${run.repo} yourself) and re-run every check: ${JSON.stringify(run.checks)}.`,
    `Then call the fade_phase tool: phase="verification_done", payload={"verdict":"accepted"|"needs_repair","checks":[["cmd","observed"]],"notes":"...","tasks":[...]}; accepted ends the run, needs_repair must name the tasks for round ${run.round + 1}.`
  ].join("\n"),
  repair: (run) => {
    const prior = (run.rejection_history ?? []).slice(-5).map((r) => `round ${r.round} [${r.kind}]${r.task_id ? ` ${r.task_id}:` : ""} ${r.reason}`);
    return [
      `Phase 1 (repair), round ${run.round} of orchestrated run ${run.run_id}.`,
      `Goal: ${run.goal}`,
      `Repair tasks: ${JSON.stringify(run.repair_tasks)}`,
      ...prior.length > 0 ? ["Previously rejected \u2014 fix the cause, do not repeat the attempt:", ...prior.map((p) => `  ${p}`)] : [],
      `Implement the repairs in ${run.repo}, run each acceptance command, do not commit.`,
      `Then call the fade_phase tool: phase="coding_done", payload={"done":[{"id":"T<n>","status":"passed"|"failed"|"blocked","result":"..."}]}`
    ].join("\n");
  },
  gate: (run) => {
    const results = run.gate_last?.results ?? [];
    const invalid = results.filter((r) => r.invalid);
    const failing = results.filter((r) => !r.ok && !r.invalid);
    return [
      `Pre-swap gate RED, round ${run.round} of orchestrated run ${run.run_id} \u2014 the verifier lane was NOT loaded; the swap is only paid for a green tree.`,
      ...invalid.map((f) => `INVALID CHECK (not a command, never executed): ${f.cmd}
  expected: ${f.expected}
  ${f.tail}`),
      ...failing.map((f) => `FAIL: ${f.cmd}
  expected: ${f.expected}
  observed tail: ${f.tail}`),
      ...invalid.length > 0 ? [
        `${invalid.length} of the plan's checks are PLAN DEFECTS: bash refuses to parse them, so no state of ${run.repo} can make them green and no amount of coding will pay the swap. Fixing the tree is not the remedy \u2014 the exit is a plan act: call fade_phase phase="planning_done" with the rows re-declared as runnable commands (the tool's own --ref / --root / absolute-binary forms, no <placeholders>), keeping every task.`
      ] : [],
      `Fix the causes in ${run.repo} (the checks are the plan's own), re-run them yourself until they pass, then call fade_phase phase="coding_done" again.`
    ].join("\n");
  },
  final: (run) => {
    const path = join(run.repo, "var", "omp-orchestrate", STATE_FILENAME);
    if (run.state === "complete") return `Orchestrated run ${run.run_id} completed: verdict accepted after round ${run.round}. State and phase log: ${path}. Resident lane ${run.lane}; nothing is preloaded.`;
    if (run.state === "failed") return `Orchestrated run ${run.run_id} failed at round ${run.round} in state ${run.state}: ${run.reason ?? "unreported"}. State file: ${path}.`;
    return `Orchestrated run ${run.run_id} stopped at round ${run.round}; resident lane left as ${run.lane}.`;
  },
  /**
   * Y1 Tier 1: the lane ended its turn without calling `fade_phase`. No round was spent and no
   * swap happens — the same lane is re-briefed in VRAM with the ONE thing it owes, plus the
   * published schema, and told exactly what the next miss costs.
   */
  nudge: (run) => {
    const phase = PHASE_FOR_STATE[run.state] ?? "coding_done";
    return [
      `Protocol nudge ${run.stall_count ?? 1}/${STALL_SYNTHESIZE_AT} \u2014 orchestrated run ${run.run_id}, state ${run.state}, round ${run.round}/${run.max_rounds} (UNSPENT: the round budget does not move here), lane ${run.lane}.`,
      `Your turn ended with NO fade_phase call. The loop cannot advance without it and will not swap lanes.`,
      `Call the fade_phase tool NOW: phase="${phase}", payload=<the JSON object serialized to a string>.`,
      SCHEMA_HINT,
      `The work is done? Say so with the acceptance command and what it printed in "result". The work is NOT done? Finish it, then report.`,
      `The next miss auto-synthesizes this round's coding_done from git and the gate exit codes; the one after halts the run as stalled_protocol_error.`
    ].join("\n");
  },
  /**
   * Y1 Tier 3: the circuit breaker tripped. The run is paused, the lane is left as it is, and
   * this is the diagnostic an operator acts on: what the machine saw, what is RED, what git
   * says, and the exact files to open.
   */
  stalled: (run) => {
    const path = join(run.repo, "var", "omp-orchestrate", STATE_FILENAME);
    const phases = (run.phases ?? []).slice(-3).map((p) => `${p.phase} round ${p.round} accepted=${p.accepted}${p.notes ? ` notes=${p.notes}` : ""}`);
    const failing = (run.gate_last?.results ?? []).filter((r) => !r.ok).map((r) => `  RED: ${r.cmd}
    expected: ${r.expected}
    observed: ${r.tail}`);
    const rejections = (run.rejection_history ?? []).slice(-5).map((r) => `  round ${r.round} [${r.kind}]${r.task_id ? ` ${r.task_id}:` : ""} ${r.reason}`);
    return [
      `Orchestrated run ${run.run_id} HALTED: stalled_protocol_error \u2014 ${run.protocol_retries ?? 0} turn(s) ended with no fade_phase call (state ${run.state}, round ${run.round}/${run.max_rounds}, lane ${run.lane}). The loop is paused; nothing further is sent to any lane and no lane was swapped.`,
      phases.length > 0 ? `Last phases the machine saw: ${phases.join(" | ")}` : `No phase was ever accepted by this run.`,
      run.synthesized ? `Synthesized coding_done at round ${run.synthesized.round} (${run.synthesized.at}): ${JSON.stringify(run.synthesized)}` : `Nothing was synthesized.`,
      `Deterministic gate: ${gateSummary(run)}`,
      ...failing.length > 0 ? ["Checks that are RED:", ...failing] : [],
      ...rejections.length > 0 ? ["Recent rejections:", ...rejections] : [],
      `Working tree: ${diffStat(run.repo)}`,
      run.operator_note ? `Operator note: ${run.operator_note}` : "",
      `Act on it: read ${path}, run the plan's own checks in ${run.repo}, then /orchestrate pause to unpause in place, /orchestrate code to resume on the code lane, or /orchestrate stop to end the run.`
    ].filter(Boolean).join("\n");
  }
};
var LANES_LABEL = `${THINK_LANE} plans and verifies; ${CODE_LANE} codes.`;

// src/ui.ts
import { hostname, userInfo } from "node:os";
var OVERLAY_WIDGET_KEY = "fade-overlay";
var TOP_WIDGET_KEY = "fade-top";
function redactOn() {
  return process.env.FADE_ORCHESTRATE_REDACT === "1";
}
var HOME_PATH = /\/home\/[^\s/]+/g;
var HOME_TILDE = /~(?=\/|$)/g;
function account() {
  const env = process.env.USER;
  if (env && env.length > 1) return env;
  try {
    const u = userInfo().username;
    return u && u.length > 1 ? u : "";
  } catch {
    return "";
  }
}
function machine() {
  try {
    return hostname().length > 1 ? hostname() : "";
  } catch {
    return "";
  }
}
function redact(text, on, repo) {
  if (!on) return text;
  let out = text;
  if (repo && repo.length > 1) out = out.split(repo).join("<path>");
  const host = machine();
  if (host) out = out.split(host).join("<host>");
  const user = account();
  if (user) out = out.split(user).join("<user>");
  return out.replace(HOME_PATH, "<path>").replace(HOME_TILDE, "<path>");
}
function shown(text, run) {
  return redact(text, redactOn(), run.repo);
}
function pill(run, suffix) {
  return shown(renderPill(`${run.lane}:${SHORT_STATE[run.state] ?? run.state}`, run, suffix), run);
}
function pillCompact(run, suffix) {
  return shown(renderPill(`${laneTag(run.lane)}:${SHORT_STATE[run.state] ?? run.state}`, run, suffix), run);
}
function renderPill(tag, run, suffix) {
  const total = run.tasks.length;
  const passed = run.tasks.filter((t) => t.status === "passed").length;
  const stall = (run.stall_count ?? 0) > 0 ? ` \xB7 protocol ${run.stall_count}/3` : "";
  const paused = run.paused === true ? " \xB7 paused" : "";
  return `\u26A1 ${tag} \xB7 R${run.round}/${run.max_rounds} \xB7 T${passed}/${total} \xB7 [Ctrl+O]${stall}${paused}${suffix ? ` \xB7 ${suffix}` : ""}`;
}
function topStatus(run, opts = {}) {
  if (!run) return void 0;
  if (TERMINAL[run.state] === true) return void 0;
  if (opts.owned === false) return void 0;
  const narrow = opts.cols !== void 0 && opts.cols < 72;
  const line = narrow ? pillCompact(run, opts.suffix) : pill(run, opts.suffix);
  if (!opts.flip || opts.flip.flips < 1) return [line];
  const who = opts.flip.competing.length > 0 ? opts.flip.competing.join(", ") : "the other lane";
  return [line, `  lane flip: ${opts.flip.flips} swaps in ${opts.flip.window_s}s \u2014 requests naming ${who} (not ${run.lane})`];
}
function laneTag(lane) {
  const m = /^(.*?)-(.*?)(?:-|$)/.exec(lane);
  if (m) return `${m[1][0]}${m[2][0]}`;
  return lane.length > 4 ? lane.slice(0, 2) : lane;
}
var SHORT_STATE = {
  planning: "plan",
  coding: "code",
  verifying: "ver",
  repair: "fix",
  complete: "done",
  failed: "fail",
  stopped: "stop",
  stalled_protocol_error: "stall"
};
function overlayLines(d) {
  const { run } = d;
  const out = [];
  out.push(`fade-orchestrator ${run.run_id} \xB7 ${run.state} \xB7 lane ${run.lane} \xB7 round ${run.round}/${run.max_rounds}${run.tier ? ` \xB7 tier ${run.tier}` : ""}`);
  out.push(`goal: ${run.goal}`);
  if (run.paused === true) out.push(`paused: the loop is stopped for manual edits${run.operator_note ? ` \xB7 operator note: ${run.operator_note}` : ""}`);
  if ((run.protocol_retries ?? 0) > 0) {
    out.push(`protocol: ${run.protocol_retries} turn(s) ended without fade_phase \xB7 consecutive stalls ${run.stall_count ?? 0}/3${run.synthesized ? ` \xB7 auto-synthesized ${run.synthesized.phase} at round ${run.synthesized.round}` : ""}`);
  }
  if (run.state === "stalled_protocol_error") {
    out.push(`PROTOCOL STALL (Tier-3 circuit breaker): the lane ended ${run.stall_count ?? 3} turns in a row without a fade_phase call, so the run is halted and NO lane was loaded.`);
    out.push("  acts: [c] resume on the code lane \xB7 [r] reset the round \xB7 [p] pause for a manual edit \xB7 /orchestrate status reads state.json");
  }
  if (d.flip && d.flip.flips > 0) {
    out.push("");
    out.push(`lane flip: ${d.flip.flips} swaps in ${d.flip.window_s}s \u2014 requests naming ${d.flip.competing.join(", ") || "the other lane"}; the router answers a queued request by swapping to the entry it names, so this churn is NOT the loop's`);
    out.push("  acts: bash scripts/ops/omp_flip_probe.sh names the client; .omp/config.yml pins the utility roles off the swappable lane");
  }
  out.push("");
  out.push("tasks (untruncated):");
  const pool = run.repair_tasks.length > 0 ? run.repair_tasks : run.tasks;
  for (const t of run.tasks) {
    const inRepair = pool.some((r) => r.id === t.id);
    out.push(`  ${t.id} [${t.status ?? "pending"}]${inRepair ? " (in repair)" : ""}  ${t.objective}`);
    out.push(`      files: ${t.files.join(", ")} \xB7 deps: ${t.dependencies.length ? t.dependencies.join(",") : "-"} \xB7 round ${t.round}`);
    out.push(`      acceptance: ${t.acceptance}`);
    if (t.result) out.push(`      result: ${t.result}`);
    if (run.checkpoints?.[t.id]) out.push(`      tag: ${run.checkpoints[t.id]}`);
  }
  out.push("");
  out.push("basalt swap latency (newest first):");
  if (d.swaps.length === 0) out.push("  (no swaps recorded yet)");
  for (const s of d.swaps) {
    const moe = s.moe ? s.moe.state === "unsupported" ? " \xB7 MoE relearned" : s.moe.profile_exists ? " \xB7 MoE warm start" : " \xB7 MoE cold start" : "";
    const ramp = s.ramp === "map_restored" ? " \xB7 MoE Map: Restored" : s.ramp === "hot_steady" ? ` \xB7 MoE: Hot Steady State (${Math.round(s.steady_tg)} tok/s)` : s.ramp === "cold_ramp" ? " \xB7 MoE: Cold Ramp" : "";
    out.push(`  ${s.from} -> ${s.to}  ${s.elapsed_s.toFixed(1)} s \xB7 first tg ${Math.round(s.first_tg)} -> steady ${Math.round(s.steady_tg)}${ramp}${moe} \xB7 ${s.at}`);
  }
  out.push("");
  out.push("memory / engine tiers:");
  for (const t of d.tiers) out.push(`  ${t.label}: ${t.value}`);
  out.push("");
  out.push("last verifier critique:");
  out.push(...d.critique ? d.critique.split("\n").map((l) => `  ${l}`) : ["  (none this round)"]);
  const rej = (run.rejection_history ?? []).slice(-5);
  if (rej.length > 0) {
    out.push("");
    out.push("recent rejections (do not repeat):");
    for (const r of rej) out.push(`  round ${r.round} [${r.kind}]${r.task_id ? ` ${r.task_id}:` : ""} ${r.reason}`);
  }
  out.push("");
  out.push("[s] skip task  [v] verify now  [r] reset round  [p] pause/resume  [c] code  [h] halt  [esc] close");
  return out.map((l) => shown(l, run));
}
async function openOverlay(ctx, data, onAction, widgetOnly = false) {
  if (widgetOnly || ctx.hasUI !== true) {
    ctx.ui.setWidget(OVERLAY_WIDGET_KEY, overlayLines(data));
    return;
  }
  try {
    const action = await ctx.ui.custom((_tui, theme, _kb, done) => new OverlayComponent(data, theme, done), {
      overlay: true,
      overlayOptions: { width: "80%", maxHeight: "80%" }
    });
    if (action && onAction) onAction(action);
  } catch {
    ctx.ui.setWidget(OVERLAY_WIDGET_KEY, overlayLines(data));
  }
}
var OverlayComponent = class {
  body;
  done;
  themeFiller;
  constructor(data, theme, done) {
    this.body = overlayLines(data);
    this.themeFiller = theme;
    this.done = done;
  }
  invalidate() {
  }
  render(width) {
    void this.themeFiller;
    return this.body.map((l) => l.length > width ? l.slice(0, width - 1) + "\u2026" : l);
  }
  handleInput(data) {
    if (data === "\x1B" || data === "q") return this.done("close");
    if (data === "s" || data === "v" || data === "r" || data === "p" || data === "c" || data === "h") return this.done(data);
  }
};

// src/keymap.ts
function actSkip(run, task) {
  const pool = run.repair_tasks.length > 0 ? run.repair_tasks : run.tasks;
  const target = task ? pool.find((t) => t.id === task) ?? run.tasks.find((t) => t.id === task) : pool.find((t) => t.status !== "passed");
  if (!target) return { nextState: run.state, note: task ? `skip: no task ${task} in this run` : "skip: every task already passed" };
  target.status = "passed";
  target.result = `${target.result ? `${target.result} \xB7 ` : ""}manual skip (operator) at ${(/* @__PURE__ */ new Date()).toISOString()}`;
  return { nextState: run.state, note: `skipped ${target.id} (forced passed; recorded as manual skip)` };
}
function actVerify(run) {
  if (run.state !== "coding" && run.state !== "repair") return { nextState: run.state, note: `verify: state ${run.state} is not a coding phase` };
  run.state = "verifying";
  return { next: THINK_LANE, nextState: "verifying", note: "verification requested early; thinking lane loads at the turn boundary" };
}
function actReset(run) {
  run.round = 1;
  run.repair_tasks = [];
  const grew = run.max_rounds < MAX_ROUNDS;
  run.max_rounds = Math.min(MAX_ROUNDS, run.max_rounds + 3);
  return { nextState: run.state, note: `round reset to 1 (tasks and statuses kept)${grew ? ` \xB7 budget +3 \u2192 ${run.max_rounds} rounds` : ` \xB7 budget already at the ${MAX_ROUNDS}-round cap`}` };
}
function actPause(run, note) {
  run.paused = !(run.paused === true);
  run.operator_note = note ?? (run.paused ? `paused at round ${run.round} for a manual edit` : `resumed at round ${run.round}`);
  return { nextState: run.state, note: run.paused ? `paused (round ${run.round}, lane ${run.lane} left resident; [p] resumes)` : `resumed (round ${run.round}; the loop advances again)` };
}
function actHalt(run) {
  run.state = "stopped";
  return { nextState: "stopped", note: `halted; resident lane left as ${run.lane}; state preserved` };
}
function actCode(run) {
  if (run.state === "complete" || run.state === "failed") return { nextState: run.state, note: `code: run is ${run.state}` };
  run.paused = false;
  run.state = run.tasks.length === 0 ? "planning" : "coding";
  return { next: CODE_LANE, nextState: run.state, note: "coding requested from the overlay" };
}

// src/history.ts
import { join as join2 } from "node:path";
import { appendFileSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2 } from "node:fs";
var HISTORY_FILENAME = "swap_history.json";
var METRICS_JSONL_FILENAME = "metrics.jsonl";
var HOT_STEADY_TPS = 120;
var MAX_ROWS = 200;
function readSwaps(dir) {
  const rows = readJson(join2(dir, HISTORY_FILENAME));
  return Array.isArray(rows?.rows) ? rows.rows : [];
}
function appendSwap(dir, row) {
  const rows = readSwaps(dir);
  rows.unshift(row);
  if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
  writeJson(join2(dir, HISTORY_FILENAME), { key: "fade.omp_orchestrate.swaps.v1", rows });
}
function rampClass(decodeTps, mapRestored, threshold = HOT_STEADY_TPS) {
  if (mapRestored) return "map_restored";
  return decodeTps !== void 0 && decodeTps >= threshold ? "hot_steady" : "cold_ramp";
}
function turnRecordOrNull(m, id) {
  if (typeof m?.pp !== "number" || typeof m?.tg !== "number") return void 0;
  return {
    ts: id.ts ?? (/* @__PURE__ */ new Date()).toISOString(),
    run_id: id.run_id,
    turn: id.turn,
    round: id.round,
    ...id.phase !== void 0 ? { phase: id.phase } : {},
    pp: m.pp,
    tg: m.tg,
    ...typeof m.ttft === "number" ? { ttft: m.ttft } : {},
    ...typeof m.kv_hit_pct === "number" ? { kv_hit_pct: m.kv_hit_pct } : {},
    swap_ms: id.swap_ms,
    round_outcome: id.round_outcome
  };
}
function appendTurn(dir, rec) {
  mkdirSync2(dir, { recursive: true });
  appendFileSync(join2(dir, METRICS_JSONL_FILENAME), `${JSON.stringify(rec)}
`);
}

// src/moe.ts
import { readdirSync, readFileSync as readFileSync3, statSync } from "node:fs";
import { join as join3 } from "node:path";
var FLASH_NEXT_SAVE_CAPABLE = /flash.?next|qwen/i;
function readServeConfig(path) {
  if (!path) return void 0;
  try {
    const raw = JSON.parse(readFileSync3(path, "utf8"));
    const models = {};
    for (const m of raw.models ?? []) {
      const alias = String(m.alias ?? m.model ?? "");
      if (alias) models[alias] = m;
    }
    return { models };
  } catch {
    return void 0;
  }
}
function runningEngineArgs() {
  try {
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      let cmd;
      try {
        cmd = readFileSync3(join3("/proc", pid, "cmdline"), "utf8");
      } catch {
        continue;
      }
      if (/\bbasalt\b/.test(cmd) && /--serve|serve\b/.test(cmd)) return cmd.split("\0").join(" ");
    }
  } catch {
  }
  return void 0;
}
function laneMoe(lane, opts = {}) {
  const cfg = readServeConfig(opts.configPath);
  const model = cfg?.models?.[lane];
  const savePath = model && typeof model["expert-profile-save"] === "string" ? String(model["expert-profile-save"]) : void 0;
  const saveCapable = FLASH_NEXT_SAVE_CAPABLE.test(lane) || model && String(model.model ?? "").toLowerCase().includes("qwen");
  if (!savePath && !saveCapable) {
    return { lane, state: "unsupported", profile_exists: false, note: "engine has no save path for this pack (Flash-Next only); placement is relearned every swap" };
  }
  if (!savePath) {
    return {
      lane,
      state: "configured",
      profile_exists: false,
      note: 'save-capable pack: the serve config does not set "expert-profile-save" (operator act: add it at the model alias, then reload the lane)'
    };
  }
  const live = opts.liveCmdline;
  const isLive = live === void 0 ? true : live.includes("--expert-profile-save") && live.includes(savePath);
  let exists = false;
  let age_s;
  try {
    const st = statSync(savePath);
    exists = st.isFile();
    age_s = (Date.now() - st.mtimeMs) / 1e3;
  } catch {
    exists = false;
  }
  return {
    lane,
    state: isLive ? "live" : "configured",
    profile_path: savePath,
    profile_exists: exists,
    ...age_s !== void 0 ? { profile_age_s: age_s } : {},
    note: isLive ? void 0 : "configured, NOT live: the running engine was started before the flag existed (reload the lane to apply)"
  };
}
function moeRows(lanes, opts = {}) {
  const live = opts.liveCmdline ?? runningEngineArgs();
  return lanes.map((lane) => {
    const m = laneMoe(lane, { ...opts, liveCmdline: live });
    const age = m.profile_age_s !== void 0 ? `${(m.profile_age_s / 3600).toFixed(1)} h old` : "no file";
    const value = m.state === "unsupported" ? "unsupported (Flash-Next only; relearned per swap)" : m.state === "configured" && !m.profile_path ? "not configured (add expert-profile-save, reload lane)" : `${m.state} \xB7 ${m.profile_exists ? age : "no profile yet"}${m.profile_exists ? " \xB7 warm start" : ""}`;
    return { label: `MoE ${lane}`, value };
  });
}

// src/livedata.ts
import { join as join4 } from "node:path";
var METRICS_FILENAME = "metrics_state.json";
async function fetchJson(url, timeoutMs = 1500) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return void 0;
    return await res.json();
  } catch {
    return void 0;
  } finally {
    clearTimeout(timer);
  }
}
function rateFromRequest(r) {
  if (!r) return void 0;
  if (typeof r.decode_tok_s === "number" && r.decode_tok_s > 0) return r.decode_tok_s;
  if (!Array.isArray(r.durations)) return void 0;
  const perToken = (r.durations ?? []).slice(1).filter((d) => typeof d === "number" && d > 0);
  if (perToken.length < 3) return void 0;
  perToken.sort((a, b) => a - b);
  const med = perToken[Math.floor(perToken.length / 2)];
  return med > 0 ? 1 / med : void 0;
}
function ttftOf(r) {
  if (!r) return void 0;
  if (typeof r.ttft_s === "number" && r.ttft_s > 0) return r.ttft_s;
  const d = Array.isArray(r.durations) ? r.durations[0] : void 0;
  return typeof d === "number" && d > 0 ? d : void 0;
}
function promptRateOf(r) {
  if (!r) return void 0;
  if (typeof r.pp === "number" && r.pp > 0) return r.pp;
  const n = typeof r.prompt_tokens === "number" ? r.prompt_tokens : r.prompt_n;
  if (typeof n !== "number" || n <= 0) return void 0;
  const secs = typeof r.prompt_ms === "number" && r.prompt_ms > 0 ? r.prompt_ms / 1e3 : ttftOf(r);
  return secs !== void 0 && secs > 0 ? n / secs : void 0;
}
function turnMetricsFrom(requests) {
  const reqs = requests ?? [];
  const last = reqs[reqs.length - 1];
  const out = {};
  const pp = promptRateOf(last);
  if (pp !== void 0) out.pp = Math.round(pp);
  const tg = rateFromRequest(last);
  if (tg !== void 0) out.tg = Math.round(tg);
  const ttft = ttftOf(last);
  if (ttft !== void 0) out.ttft = Math.round(ttft * 1e3) / 1e3;
  const withHit = reqs.filter((r) => typeof r.hit_rate === "number");
  const hit = withHit[withHit.length - 1];
  if (hit) out.kv_hit_pct = Math.round((hit.hit_rate ?? 0) * 1e3) / 10;
  return out;
}
async function fetchTurnMetrics() {
  const m = await fetchJson(`${ROUTER}/metrics`);
  return turnMetricsFrom(Array.isArray(m?.requests) ? m.requests : void 0);
}
async function fetchMetrics() {
  const [m, h] = await Promise.all([
    fetchJson(`${ROUTER}/metrics`),
    fetchJson(`${ROUTER}/health?phase=display`)
  ]);
  if (!m && !h) return void 0;
  const mm = m ?? {};
  const hh = h ?? {};
  const eng = mm.engine ?? {};
  const spill = eng.spill ?? mm.spill;
  const bytes = typeof spill?.bytes === "number" ? spill.bytes : void 0;
  const slots = typeof eng.expert_slots === "number" ? eng.expert_slots : mm.expert_slots?.total;
  const liveQueued = mm.live?.queued ?? mm.live?.slots?.queue_depth;
  const snap = {
    quant: eng.quant ?? mm.quant,
    engine_version: eng.version ?? mm.engine_version,
    slots,
    spill_experts: spill?.experts,
    spill_total: spill?.total ?? eng.expert_total,
    spill_bytes_gb: typeof spill?.bytes_gb === "number" ? spill.bytes_gb : bytes !== void 0 ? bytes / 1e9 : void 0,
    live_state: mm.live?.state,
    live_slots: mm.live?.slots?.active,
    queue: typeof liveQueued === "number" ? liveQueued : Array.isArray(mm.queue) ? mm.queue.length : mm.queue,
    tok_s: mm.live?.tok_s,
    loaded: hh.loaded,
    loading: hh.loading,
    percent: hh.percent ?? null,
    requests: Array.isArray(mm.requests) ? mm.requests : void 0,
    at_utc: (/* @__PURE__ */ new Date()).toISOString()
  };
  return snap;
}
function tiersFromMetrics(s) {
  if (!s) return [{ label: "router", value: `${ROUTER} unreachable` }];
  const rates = (s.requests ?? []).map(rateFromRequest).filter((r) => r !== void 0);
  const best = rates.length > 0 ? Math.max(...rates) : void 0;
  return [
    { label: "engine", value: `${s.engine_version ?? "?"} quant ${s.quant ?? "?"}` },
    { label: "resident", value: `${s.loaded ?? "?"}${s.loading ? " (loading)" : ""}${s.percent != null ? ` ${s.percent}%` : ""}` },
    { label: "expert slots", value: `${s.slots ?? "?"} \xB7 spill ${s.spill_experts ?? "?"}/${s.spill_total ?? "?"}${s.spill_bytes_gb !== void 0 ? ` \xB7 ${s.spill_bytes_gb.toFixed(1)} GB` : ""}` },
    { label: "decode now", value: s.tok_s ? `${Math.round(s.tok_s)} tok/s (queue ${s.queue ?? 0}, ${s.live_state ?? "?"})` : "idle" },
    { label: "best recent", value: best ? `${Math.round(best)} tok/s` : "no completed requests" },
    moeCacheRow(s.requests)
  ];
}
function coldHot(tok_s, laneBest) {
  if (tok_s === void 0 || laneBest === void 0 || laneBest <= 0) return { label: "idle" };
  if (tok_s < 0.5) return { label: "idle" };
  return { label: tok_s >= 0.8 * laneBest ? "hot" : "cold", rate: tok_s };
}
function startSwapWatch(to, moe) {
  const t0 = Date.now();
  const percentPath = [];
  let sawSwap = false;
  let stopped = false;
  const sample = async () => {
    while (!stopped && Date.now() - t0 < 12e4) {
      const h = await fetchJson(`${ROUTER}/health?phase=load:${to.replace(/[^a-z0-9]+/gi, "_")}`, 2e3);
      if (h?.swap) sawSwap = true;
      if (typeof h?.percent === "number") percentPath.push(h.percent);
      if (h?.loaded === to && h?.loading === false) break;
      await new Promise((r) => setTimeout(r, 2e3));
    }
    stopped = true;
  };
  void sample();
  return {
    cancel() {
      stopped = true;
    },
    async finish(from, toLane, elapsed_s, dir) {
      stopped = true;
      if (!sawSwap && from === toLane) return void 0;
      const m = await fetchJson(`${ROUTER}/metrics`);
      const reqs = (Array.isArray(m?.requests) ? m.requests : []).filter((r) => typeof r.model === "string" && r.model.replace(":", "") === toLane.replace(":", "")).map((r) => ({ model: r.model, prompt_n: r.prompt_n ?? r.prompt_tokens ?? 0, durations: r.durations ?? [] })).filter((r) => r.durations.length > 3).sort((a, b) => a.prompt_n - b.prompt_n);
      const big = reqs.filter((r) => r.prompt_n >= 500);
      const first = rateFromRequest(big.length > 0 ? big[0] : reqs[0]);
      const steady = rateFromRequest(reqs[reqs.length - 1]);
      const mapRestored = moe?.state === "live" && moe.profile_exists === true;
      const row = {
        from,
        to: toLane,
        elapsed_s,
        first_tg: first ?? 0,
        steady_tg: steady ?? 0,
        elapsed_ms: Math.round(elapsed_s * 1e3),
        ramp: rampClass(first, mapRestored),
        percent_path: percentPath.slice(0, 60),
        ...moe ? { moe } : {},
        at: (/* @__PURE__ */ new Date()).toISOString()
      };
      appendSwap(dir, row);
      return row;
    }
  };
}
function moeCacheRow(requests) {
  const withHit = (requests ?? []).filter((r) => typeof r.hit_rate === "number");
  if (withHit.length === 0) return { label: "prefix cache", value: "no hit_rate reported" };
  const last = withHit[withHit.length - 1];
  const n = Math.min(withHit.length, 8);
  const recent = withHit.slice(-n);
  const mean = recent.reduce((s, r) => s + (r.hit_rate ?? 0), 0) / recent.length;
  const ssd = recent.filter((r) => typeof r.ssd_share === "number");
  const ssdText = ssd.length > 0 ? ` \xB7 ssd ${(ssd.reduce((s, r) => s + (r.ssd_share ?? 0), 0) / ssd.length * 100).toFixed(1)}%` : "";
  return {
    label: "prefix cache",
    value: `${(mean * 100).toFixed(1)}% hit over ${n} req \xB7 last ${((last.hit_rate ?? 0) * 100).toFixed(1)}% (${last.reused ?? 0} tok reused)${ssdText}`
  };
}
function laneBestRate(s, lane) {
  const slug = lane.replace(":", "");
  const rates = (s.requests ?? []).filter((r) => typeof r.model !== "string" || r.model.replace(":", "") === slug).map(rateFromRequest).filter((r) => r !== void 0);
  return rates.length > 0 ? Math.max(...rates) : void 0;
}
function persistMetrics(dir, snap) {
  writeJson(join4(dir, METRICS_FILENAME), { key: "fade.omp_orchestrate.metrics.v1", ...snap });
}

// src/index.ts
var GATE_POLL_MS = Number(process.env.FADE_ORCHESTRATE_GATE_POLL_MS ?? 3e3);
var GATE_BUDGET_MS = Number(process.env.FADE_ORCHESTRATE_GATE_BUDGET_MS ?? 6e4);
var FADE_KEY = process.env.FADE_ORCHESTRATE_KEY ?? "ctrl+o";
var MUTATING_TOOLS = { edit: true, write: true, apply_patch: true, multiedit: true, multi_edit: true, notebook_edit: true };
var MAIN_SESSION_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;
var isDelegatedSession = () => {
  const f = process.env.PI_SESSION_FILE ?? "";
  if (f === "") return false;
  const parent = basename(dirname(f));
  return MAIN_SESSION_DIR.test(parent) && !f.endsWith(`${parent}.jsonl`);
};
function fadeOrchestrate(pi) {
  let run;
  let runDir;
  let pending;
  let switching;
  let settledNotified = false;
  let metrics;
  let laneBest = 0;
  let metricsTimer;
  let turnSeq = 0;
  let turnPhase;
  let turnSwapMs = 0;
  let verifierTools;
  let flipBadge;
  const refreshMetrics = async () => {
    const s = await fetchMetrics();
    if (!s) return;
    metrics = s;
    if (runDir) persistMetrics(runDir, s);
    if (run) {
      const b = laneBestRate(s, run.lane);
      if (b && b > laneBest) laneBest = b;
    }
  };
  const stopMetricsTimer = () => {
    if (metricsTimer !== void 0) {
      clearInterval(metricsTimer);
      metricsTimer = void 0;
    }
  };
  const METRICS_INTERVAL_MS = Math.max(250, Number(process.env.FADE_ORCHESTRATE_METRICS_INTERVAL_MS ?? 3e4));
  const startMetricsTimer = () => {
    stopMetricsTimer();
    metricsTimer = setInterval(() => {
      void refreshMetrics();
      void watchFlips();
    }, METRICS_INTERVAL_MS);
    void refreshMetrics();
    void watchFlips();
  };
  const watchFlips = async () => {
    await observeSwaps();
    const f = flipState(run?.lane, FLIP_WINDOW_MS);
    const next = flipGuarded(f) ? { flips: f.flips, window_s: f.window_s, competing: f.competing } : void 0;
    if ((next?.flips ?? 0) === (flipBadge?.flips ?? 0)) return;
    flipBadge = next;
  };
  const pillSuffix = () => {
    if (!metrics) return void 0;
    const ch = coldHot(metrics.tok_s, laneBest);
    if (ch.label === "idle" || ch.rate === void 0) return void 0;
    return `${ch.label} ${Math.round(ch.rate)}t/s`;
  };
  const recordTurn = async (outcome) => {
    if (!run || !runDir) return;
    const m = await fetchTurnMetrics();
    const rec = turnRecordOrNull(m, {
      run_id: run.run_id,
      turn: ++turnSeq,
      round: run.round,
      swap_ms: turnSwapMs,
      round_outcome: outcome,
      ...turnPhase !== void 0 ? { phase: turnPhase } : {}
    });
    turnPhase = void 0;
    turnSwapMs = 0;
    if (rec) appendTurn(runDir, rec);
  };
  const applyToolPolicy = async (lane) => {
    const active = pi.getActiveTools();
    if (lane === THINK_LANE) {
      verifierTools = active;
      const readOnly = active.filter((t) => MUTATING_TOOLS[t] !== true);
      if (!readOnly.includes("fade_phase")) readOnly.push("fade_phase");
      if (readOnly.length !== active.length) await pi.setActiveTools(readOnly);
      return;
    }
    if (verifierTools && verifierTools.length > 0) {
      if (verifierTools.some((t) => !active.includes(t))) await pi.setActiveTools(verifierTools);
      verifierTools = void 0;
    }
  };
  const ensurePhaseTool = async () => {
    const active = pi.getActiveTools();
    if (!active.includes("fade_phase")) await pi.setActiveTools([...active, "fade_phase"]);
  };
  const statePath = () => runDir ? join5(runDir, STATE_FILENAME) : "<unset>";
  const persist = () => {
    if (run && runDir) writeJson(statePath(), run);
  };
  const gateChecks = (ctx) => {
    if (!run) return;
    const live = runDir ? readJson(join5(runDir, STATE_FILENAME)) : void 0;
    const r = refreshChecks(run, live);
    if (r.changed) ctx.ui.notify(`orchestrate: the pre-swap gate re-read the checks from ${statePath()} \u2014 ${r.removed.length} replaced, ${r.added.length} added, ${r.to} total`, "info");
  };
  const paint = (ctx) => {
    if (!run) {
      ctx.ui.setWidget(TOP_WIDGET_KEY, void 0);
      ctx.ui.setWidget(OVERLAY_WIDGET_KEY, void 0);
      return;
    }
    const cols = typeof process.stdout.columns === "number" ? process.stdout.columns : void 0;
    const lines = topStatus(run, { suffix: pillSuffix(), flip: flipBadge, owned: !isDelegatedSession(), cols });
    ctx.ui.setWidget(TOP_WIDGET_KEY, lines);
  };
  const fail = (ctx, reason) => {
    if (run) {
      run.state = "failed";
      run.reason = reason;
      persist();
      paint(ctx);
    }
    ctx.ui.notify(`fade_orchestrate: ${reason}`, "error");
  };
  const gateRouterIdle = async (lane, ctx) => {
    const t0 = Date.now();
    const budget_s = Math.round(GATE_BUDGET_MS / 1e3);
    const poll_s = Math.round(GATE_POLL_MS / 1e3);
    let polls = 0;
    let last = await routerBusy();
    while (last.busy) {
      polls += 1;
      const waited = Date.now() - t0;
      if (waited >= GATE_BUDGET_MS) return { waited_ms: waited, polls, over_budget: true, last };
      if (polls === 1) ctx.ui.notify(`fade_orchestrate: the ${lane} load is DEFERRED \u2014 ${last.reason}; retrying every ${poll_s}s up to ${budget_s}s`, "warning");
      ctx.ui.setWorkingMessage(`fade_orchestrate: ${lane} load deferred ${Math.round(waited / 1e3)}s/${budget_s}s \u2014 ${last.reason}`);
      await new Promise((r) => setTimeout(r, GATE_POLL_MS));
      last = await routerBusy();
    }
    return { waited_ms: Date.now() - t0, polls, over_budget: false, last };
  };
  const switchLane = async (lane, ctx) => {
    const model = ctx.modelRegistry.find(PROVIDER, lane);
    if (!model) {
      fail(ctx, `model ${PROVIDER}/${lane} is not in the registry`);
      return;
    }
    const switched = await pi.setModel(model);
    if (switched !== true && switched?.switched !== true) {
      fail(ctx, `setModel(${PROVIDER}/${lane}) did not switch: ${JSON.stringify(switched)}`);
      return;
    }
    pi.setThinkingLevel(THINKING[lane]);
    const from = run?.lane ?? "";
    const moe = laneMoe(lane, { configPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG });
    const watch = startSwapWatch(lane, moe);
    ctx.ui.setWorkingMessage(`fade_orchestrate: loading ${lane} on the router\u2026`);
    const loaded = await loadLane(lane);
    ctx.ui.setWorkingMessage();
    if (!loaded.ok) {
      watch.cancel();
      fail(ctx, `loading lane ${lane} failed (${loaded.detail}); briefing not sent`);
      return;
    }
    if (from && runDir && from !== lane) {
      turnSwapMs += Math.round(loaded.elapsed_s * 1e3);
      void watch.finish(from, lane, loaded.elapsed_s, runDir).then(() => paint(ctx));
    }
    if (run) run.lane = lane;
    persist();
    paint(ctx);
    await applyToolPolicy(lane);
    setTimeout(async () => {
      await ensurePhaseTool();
      const text = run.state === "repair" ? briefings.repair(run) : lane === CODE_LANE && run.gate_last && run.gate_last.passed === false ? briefings.gate(run) : lane === CODE_LANE ? briefings.code(run) : briefings.verify(run);
      pi.sendUserMessage(text);
    }, 0);
  };
  const lastCritique = () => {
    const phases = run?.phases ?? [];
    for (let i = phases.length - 1; i >= 0; i--) if (phases[i].phase === "verification_done") return phases[i].notes;
    return void 0;
  };
  const showOverlay = async (ctx) => {
    if (!run || !runDir) {
      ctx.ui.notify("orchestrate: no run active", "info");
      return;
    }
    try {
      const s = await fetchMetrics();
      if (s) {
        metrics = s;
        if (runDir) persistMetrics(runDir, s);
      }
      const tiers = [...tiersFromMetrics(metrics), ...moeRows([THINK_LANE, CODE_LANE], { configPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG })];
      const data = { run, swaps: readSwaps(runDir), tiers, critique: lastCritique(), flip: flipBadge };
      await openOverlay(ctx, data, (key) => {
        if (!run) return;
        const dir = key === "s" ? actSkip(run) : key === "v" ? actVerify(run) : key === "r" ? actReset(run) : key === "p" ? actPause(run) : key === "c" ? actCode(run) : key === "h" ? actHalt(run) : void 0;
        if (!dir) return;
        persist();
        paint(ctx);
        ctx.ui.notify(`orchestrate: ${dir.note}`, "info");
        if (!run.paused && pending) {
          const deferred = pending;
          pending = void 0;
          void switchLane(deferred.lane, ctx);
        }
        if (dir.next) void switchLane(dir.next, ctx);
      }, process.env.FADE_ORCHESTRATE_HEADLESS === "1");
    } catch (e) {
      ctx.ui.notify(`orchestrate: overlay failed: ${String(e instanceof Error ? e.message : e)}`, "error");
    }
  };
  const applyPhase = (phase, payload) => {
    if (!run) throw new Error("unreachable: no run");
    const st = run;
    st.phases.push({ phase, lane: st.lane, accepted: true, round: st.round, at: (/* @__PURE__ */ new Date()).toISOString(), notes: typeof payload.notes === "string" ? payload.notes : void 0 });
    if (phase === "planning_done") {
      if (st.state === "coding") {
        st.checks = payload.checks;
        st.phases[st.phases.length - 1].notes = PLAN_ACT_NOTE;
        return { next: CODE_LANE, nextState: "coding" };
      }
      st.tasks = payload.tasks.map((t) => ({ ...t, round: st.round }));
      st.checks = payload.checks;
      st.tier = st.tasks.length <= 2 ? "S" : st.tasks.length <= 4 ? "M" : "L";
      st.max_rounds = adaptiveRounds(st.tasks.length, st.max_rounds);
      st.repair_tasks = [];
      st.state = "coding";
      return { next: CODE_LANE, nextState: "coding" };
    }
    if (phase === "coding_done") {
      for (const d of payload.done) {
        const task = st.tasks.find((t) => t.id === d.id) ?? st.repair_tasks.find((t) => t.id === d.id);
        if (task) {
          task.status = d.status;
          task.result = d.result;
        }
      }
      st.state = "verifying";
      return { next: THINK_LANE, nextState: "verifying" };
    }
    const accepted = String(payload.verdict) === "accepted";
    st.phases[st.phases.length - 1].accepted = accepted;
    if (accepted) {
      st.state = "complete";
      return { next: THINK_LANE, nextState: "complete" };
    }
    pushRejection(
      st,
      "verification",
      typeof payload.notes === "string" ? payload.notes : "needs_repair",
      Array.isArray(payload.tasks) ? payload.tasks.map((t) => t.id).join(",") : void 0
    );
    if (st.round + 1 > st.max_rounds) {
      st.state = "failed";
      st.reason = `round budget exhausted (${st.max_rounds}) with verdict needs_repair`;
      return { next: THINK_LANE, nextState: "failed" };
    }
    st.round += 1;
    st.repair_tasks = payload.tasks.map((t) => ({ ...t, round: st.round, status: void 0, result: void 0 }));
    st.state = "repair";
    return { next: CODE_LANE, nextState: "repair" };
  };
  pi.registerTool({
    name: "fade_phase",
    label: "fade phase",
    description: 'Report one completed orchestration phase and end the turn so the orchestrator can switch lanes. phase=planning_done payload={"tasks":[{"id","objective","files","acceptance","dependencies"}],"checks":[["cmd","expected"]]}; phase=coding_done payload={"done":[{"id","status","result"}]}; phase=verification_done payload={"verdict":"accepted"|"needs_repair","checks":[["cmd","observed"]],"notes":"...","tasks":[...]}. payload is that JSON object serialized to a string. Invalid phase, payload or ordering is refused with the rule named.',
    parameters: Type.Object({
      phase: Type.String({ description: "planning_done | coding_done | verification_done" }),
      payload: Type.String({ description: "the phase JSON object, as a string" })
    }),
    // `essential` ships the schema in the request catalog; `discoverable` (the default) is
    // mounted behind xd:// and the phase contract cannot be answered that way.
    // omp 18.20's registerTool takes `loadMode`; the 0.73.1 peer types predate it.
    // @ts-expect-error loadMode is accepted at runtime (essential = shipped in the catalog).
    loadMode: "essential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let payload;
      try {
        if (!run) throw new Error("fade_phase: no orchestrated run is active (start one with /orchestrate <goal>)");
        if (TERMINAL[run.state] === true) throw new Error(`fade_phase: run ${run.run_id} is already ${run.state}`);
        if (run.round > run.max_rounds) throw new Error(`fade_phase: round ${run.round} exceeds max_rounds ${run.max_rounds}`);
        const allowed = PHASE_FOR_STATE[run.state];
        if (!allowed) throw new Error(`fade_phase: state ${run.state} takes no phase`);
        const gatePlanDefect = (run.gate_last?.results ?? []).some((r) => r.invalid);
        if (params.phase !== allowed) {
          if (!(params.phase === "planning_done" && run.state === "coding" && gatePlanDefect)) {
            throw new Error(
              `fade_phase: state ${run.state} takes phase ${allowed}, not ${params.phase}` + (gatePlanDefect ? " \u2014 the gate recorded a check that is not a command, so a planning_done that keeps every task and re-declares the checks IS accepted from this state" : "")
            );
          }
        }
        try {
          payload = JSON.parse(params.payload);
        } catch {
          throw new Error("fade_phase: payload is not valid JSON");
        }
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("fade_phase: payload must be a JSON object");
        const allowedKeys = {
          planning_done: /* @__PURE__ */ new Set(["tasks", "checks"]),
          coding_done: /* @__PURE__ */ new Set(["done"]),
          verification_done: /* @__PURE__ */ new Set(["verdict", "checks", "notes", "tasks"])
        };
        for (const key of Object.keys(payload)) {
          if (!allowedKeys[params.phase].has(key)) throw new Error(`fade_phase: ${params.phase} does not take key "${key}"`);
        }
        if (params.phase === "planning_done") {
          const tasks = validateTasks(payload.tasks);
          if (tasks.error) throw new Error(`fade_phase: ${tasks.error}`);
          const checks = validateChecks(payload.checks);
          if (checks.error) throw new Error(`fade_phase: ${checks.error}`);
          if (run.state === "coding") {
            const st = run;
            if (!sameTaskPlan(st.tasks, payload.tasks)) {
              throw new Error("fade_phase: a plan act from `coding` must carry the plan's tasks UNCHANGED (same ids, objectives, files, acceptance, dependencies) \u2014 only the checks may be re-declared");
            }
            const acts = st.phases.filter((p) => p.phase === "planning_done" && p.round === st.round && p.notes === PLAN_ACT_NOTE).length;
            if (acts >= 1) {
              throw new Error(`fade_phase: this round already spent its one plan act (round ${st.round}) \u2014 the checks are now the plan; make the tree satisfy them, halt, or let the verifier judge them`);
            }
          }
        }
        if (params.phase === "coding_done") {
          if (!Array.isArray(payload.done) || payload.done.length === 0) throw new Error("fade_phase: coding_done needs a non-empty done[]");
          const ids = new Set(run.tasks.concat(run.repair_tasks).map((t) => t.id));
          for (const entry of payload.done) {
            if (typeof entry.id !== "string" || !ids.has(entry.id)) throw new Error(`fade_phase: done entry ${JSON.stringify(entry.id)} is not a task of this run`);
            if (!["passed", "failed", "blocked"].includes(String(entry.status))) throw new Error(`fade_phase: ${entry.id} status must be passed|failed|blocked`);
          }
        }
        if (params.phase === "verification_done") {
          if (!["accepted", "needs_repair"].includes(String(payload.verdict))) throw new Error("fade_phase: verdict must be accepted or needs_repair");
          if (payload.checks !== void 0) {
            const checks = validateChecks(payload.checks);
            if (checks.error) throw new Error(`fade_phase: ${checks.error}`);
          }
          if (String(payload.verdict) === "needs_repair") {
            if (!Array.isArray(payload.tasks) || payload.tasks.length === 0) throw new Error("fade_phase: needs_repair requires a non-empty tasks[]");
            const tasks = validateTasks(payload.tasks);
            if (tasks.error) throw new Error(`fade_phase: ${tasks.error}`);
          }
        }
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        if (run) {
          run.schema_retries += 1;
          pushRejection(run, "schema", text);
          persist();
          throw new Error(run.schema_retries >= 2 ? `${text}
${SCHEMA_HINT}` : text);
        }
        throw new Error(text);
      }
      const applied = applyPhase(params.phase, payload);
      turnPhase = params.phase;
      classifyTurnEnd(run, true);
      let checkpointNote = "";
      if (params.phase === "verification_done" && applied.nextState === "complete") {
        const st = run;
        const tags = st.tasks.filter((t) => t.status === "passed").map((t) => tagCheckpoint(st.repo, st, t.id));
        const ok = tags.filter((t) => t.ok).map((t) => t.tag);
        if (ok.length > 0) checkpointNote = `; checkpoints ${ok.join(", ")}`;
        const refused = tags.filter((t) => !t.ok);
        if (refused.length > 0) checkpointNote += `; checkpoint FAILED ${refused.map((t) => `${t.tag}: ${t.error}`).join(", ")}`;
      }
      if (params.phase === "coding_done" && applied.nextState === "verifying" && run.checks.length > 0) {
        gateChecks(ctx);
        const gate = runGate(run.checks, run.repo);
        run.gate_last = gate;
        if (!gate.passed) {
          const failing = gate.results.filter((r) => !r.ok);
          pushRejection(run, "task", `pre-swap gate red: ${failing.map((f) => f.cmd).join(" | ")}`);
          run.state = "coding";
          persist();
          paint(ctx);
          pending = { lane: CODE_LANE, phase: "gate" };
          settledNotified = false;
          ctx.abort();
          return {
            content: [{ type: "text", text: `pre-swap gate RED (${failing.length}/${gate.results.length} failing); the verifier swap was not paid; fix and re-report coding_done` }],
            details: { gate: "red", failing: failing.map((f) => f.cmd) }
          };
        }
      }
      persist();
      paint(ctx);
      pending = applied.nextState === "failed" || applied.nextState === "complete" ? void 0 : { lane: applied.next, phase: params.phase };
      settledNotified = false;
      ctx.abort();
      return {
        content: [{ type: "text", text: `phase ${params.phase} recorded; state ${applied.nextState}${checkpointNote}${pending ? `, ${pending.lane} loads at the turn boundary` : "; run terminal, lane left resident"}` }],
        details: { phase: params.phase, state: applied.nextState, next_lane: pending?.lane ?? null, checkpoints: run.checkpoints ?? {} }
      };
    }
  });
  pi.registerCommand("lanes", {
    description: `Live basalt router census on ${ROUTER}: both entries' load state and /health`,
    handler: async (_args, ctx) => {
      const st = await listLanes();
      if (st.error) {
        ctx.ui.notify(`lanes: router unreachable at ${ROUTER}: ${st.error}`, "error");
        ctx.ui.setWidget("lanes", [`router: ${ROUTER} unreachable`, st.error]);
        return;
      }
      const rows = st.models.map((m) => `${m.id} ${m.status}`);
      ctx.ui.setWidget("lanes", [`router: ${ROUTER} \xB7 health ${st.health}`, ...rows]);
      ctx.ui.notify(`lanes: ${st.health} \xB7 ${rows.join(" \xB7 ")}`, "info");
    }
  });
  pi.registerShortcut(FADE_KEY, {
    description: "fade orchestrator overlay: tasks, swap history, tiers, critique (s/v/r/c/h)",
    handler: async (ctx) => {
      await showOverlay(ctx);
    }
  });
  pi.registerCommand("orchestrate", {
    description: `One session, two basalt lanes: ${THINK_LANE} plans/verifies, ${CODE_LANE} codes. /orchestrate [--rounds N] <goal> | status | overlay | skip [Tn] | verify | reset | pause [note] | code | halt | stop [--clear]`,
    handler: async (args, ctx) => {
      const raw = args.trim();
      const first = raw.split(/\s+/)[0] ?? "";
      if (first === "status") {
        if (!run) {
          ctx.ui.notify("orchestrate: no run active", "info");
          return;
        }
        const done = run.tasks.filter((t) => t.status === "passed").length;
        ctx.ui.notify(
          `orchestrate ${run.run_id}: ${run.state} \xB7 lane ${run.lane} \xB7 round ${run.round}/${run.max_rounds} \xB7 tasks ${done}/${run.tasks.length} \xB7 phases ${run.phases.length} \xB7 ${statePath()}`,
          "info"
        );
        paint(ctx);
        return;
      }
      if (first === "overlay") {
        await showOverlay(ctx);
        return;
      }
      if (first === "handover") {
        if (!run) {
          ctx.ui.notify("orchestrate: no run active", "info");
          return;
        }
        pi.sendUserMessage(handoverText(run));
        ctx.ui.notify("orchestrate: condensed handover sent", "info");
        return;
      }
      if (first === "skip" || first === "verify" || first === "reset" || first === "pause" || first === "halt" || first === "code") {
        if (!run) {
          ctx.ui.notify("orchestrate: no run active", "info");
          return;
        }
        const dir = first === "skip" ? actSkip(run, raw.split(/\s+/)[1]) : first === "verify" ? actVerify(run) : first === "reset" ? actReset(run) : first === "pause" ? actPause(run, raw.split(/\s+/).slice(1).join(" ") || void 0) : first === "halt" ? actHalt(run) : actCode(run);
        persist();
        paint(ctx);
        ctx.ui.notify(`orchestrate: ${dir.note}`, "info");
        if (!run.paused && pending) {
          const deferred = pending;
          pending = void 0;
          await switchLane(deferred.lane, ctx);
        }
        if (dir.next) await switchLane(dir.next, ctx);
        return;
      }
      if (first === "stop") {
        if (!run) {
          ctx.ui.notify("orchestrate: no run active", "info");
          return;
        }
        if (TERMINAL[run.state] !== true) {
          run.state = "stopped";
          persist();
        }
        pending = void 0;
        ctx.ui.setWidget(TOP_WIDGET_KEY, void 0);
        ctx.ui.notify(`orchestrate: stopped; resident lane left as ${run.lane}; state ${statePath()}`, "info");
        if (raw.includes("--clear")) {
          try {
            unlinkSync(join5(runDir, ACTIVE_FILENAME));
          } catch {
          }
          run = void 0;
        }
        return;
      }
      if (isDelegatedSession()) {
        ctx.ui.notify("orchestrate: this is a delegated (subagent) session \u2014 the run belongs to the session that started it, so /orchestrate <goal> is refused here", "warning");
        return;
      }
      if (run && TERMINAL[run.state] !== true) {
        ctx.ui.notify(`orchestrate: run ${run.run_id} is still ${run.state}; /orchestrate stop first`, "warning");
        return;
      }
      let rounds = DEFAULT_ROUNDS;
      let goal = raw;
      const roundsMatch = /^--rounds\s+(\S+)\s*/.exec(raw);
      if (roundsMatch) {
        rounds = Number(roundsMatch[1]);
        if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) {
          ctx.ui.notify(`orchestrate: --rounds takes a whole number 1..${MAX_ROUNDS}`, "warning");
          return;
        }
        goal = raw.slice(roundsMatch[0].length).trim();
      }
      if (goal === "" || goal.startsWith("--")) {
        ctx.ui.notify("orchestrate: usage /orchestrate [--rounds N] <goal>", "warning");
        return;
      }
      ctx.ui.setWorkingMessage(`fade_orchestrate: loading ${THINK_LANE} on the router\u2026`);
      const loaded = await loadLane(THINK_LANE);
      ctx.ui.setWorkingMessage();
      if (!loaded.ok) {
        ctx.ui.notify(`orchestrate: preflight failed loading ${THINK_LANE} (${loaded.detail}); nothing written`, "error");
        return;
      }
      const census = await listLanes();
      const resident = census.models.find((m) => m.status === "loaded");
      if (!census.error && resident?.id !== THINK_LANE) {
        ctx.ui.notify(`orchestrate: preflight expected ${THINK_LANE} loaded, router reports ${resident ? resident.id : "none"}; nothing written`, "error");
        return;
      }
      const runId = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z").replace("T", "T")}-${Math.random().toString(36).slice(2, 6)}`;
      const repo = ctx.cwd;
      runDir = join5(repo, "var", "omp-orchestrate");
      run = {
        key: STATE_KEY,
        run_id: runId,
        goal,
        repo,
        max_rounds: rounds,
        round: 1,
        state: "planning",
        lane: THINK_LANE,
        checks: [],
        tasks: [],
        phases: [],
        repair_tasks: [],
        rejection_history: [],
        schema_retries: 0,
        started_utc: (/* @__PURE__ */ new Date()).toISOString()
      };
      settledNotified = false;
      writeJson(join5(runDir, ACTIVE_FILENAME), { run_id: runId, repo, goal, started_utc: run.started_utc, max_rounds: rounds });
      persist();
      const model = ctx.modelRegistry.find(PROVIDER, THINK_LANE);
      if (!model) {
        fail(ctx, `model ${PROVIDER}/${THINK_LANE} is not in the registry; run written but not started`);
        return;
      }
      const switched = await pi.setModel(model);
      if (switched !== true && switched?.switched !== true) {
        fail(ctx, `setModel(${PROVIDER}/${THINK_LANE}) did not switch: ${JSON.stringify(switched)}`);
        return;
      }
      pi.setThinkingLevel(THINKING[THINK_LANE]);
      paint(ctx);
      startMetricsTimer();
      await ensurePhaseTool();
      pi.sendUserMessage(briefings.plan(run));
    }
  });
  pi.on("session_start", async (_event, ctx) => {
    if (isDelegatedSession()) return;
    await ensurePhaseTool();
    const repo = ctx.cwd;
    const active = readJson(join5(repo, "var", "omp-orchestrate", ACTIVE_FILENAME));
    const state = readJson(join5(repo, "var", "omp-orchestrate", STATE_FILENAME));
    if (!active || !state) return;
    runDir = join5(repo, "var", "omp-orchestrate");
    run = normalizeRun(state);
    settledNotified = false;
    paint(ctx);
    startMetricsTimer();
    if (TERMINAL[state.state] === true) {
      ctx.ui.notify(`orchestrate: run ${state.run_id} is ${state.state} (${statePath()})`, "info");
    } else if (process.env.FADE_ORCHESTRATE_AUTO_RESUME === "1") {
      setTimeout(() => {
        const idle = typeof ctx.hasPendingMessages === "function" ? !ctx.hasPendingMessages() : true;
        if (idle && ctx.isIdle()) pi.sendUserMessage(handoverText(state));
      }, 250);
      ctx.ui.notify("orchestrate: resumed with the condensed handover (FADE_ORCHESTRATE_AUTO_RESUME=1)", "info");
    } else {
      ctx.ui.notify("orchestrate: run mid-flight \u2014 /orchestrate handover sends the condensed state", "info");
    }
  });
  pi.on("agent_start", async (_event, ctx) => {
    paint(ctx);
    void refreshMetrics().then(() => paint(ctx));
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (!run) return;
    const next = pending;
    pending = void 0;
    if (!next) {
      paint(ctx);
      if (TERMINAL[run.state] === true) {
        if (!settledNotified) {
          settledNotified = true;
          ctx.ui.notify(briefings.final(run), "info");
        }
        void recordTurn(run.state);
        return;
      }
      if (run.paused === true) {
        ctx.ui.notify(`orchestrate: paused at round ${run.round} \u2014 no nudge sent, no lane loaded; [p] resumes`, "info");
        void recordTurn("paused");
        return;
      }
      const tier = classifyTurnEnd(run, false);
      if (tier === "nudge") {
        pushRejection(run, "protocol", `turn ended in state ${run.state} with no fade_phase call (nudge ${run.stall_count}/${STALL_SYNTHESIZE_AT})`);
        persist();
        paint(ctx);
        ctx.ui.notify(`orchestrate: protocol nudge ${run.stall_count}/${STALL_SYNTHESIZE_AT} \u2014 round ${run.round} unspent, no swap paid`, "warning");
        await ensurePhaseTool();
        pi.sendUserMessage(briefings.nudge(run));
        void recordTurn("nudge");
        return;
      }
      if (tier === "synthesize" && (run.state === "coding" || run.state === "repair")) {
        gateChecks(ctx);
        const gate = run.checks.length > 0 ? runGate(run.checks, run.repo) : void 0;
        if (gate) run.gate_last = gate;
        if (gate && !gate.passed) {
          const failing = gate.results.filter((r) => !r.ok);
          pushRejection(run, "task", `synthesized round refused: pre-swap gate red: ${failing.map((f) => f.cmd).join(" | ")}`);
          persist();
          paint(ctx);
          pending = { lane: CODE_LANE, phase: "gate" };
          settledNotified = false;
          await ensurePhaseTool();
          pi.sendUserMessage(briefings.gate(run));
          void recordTurn("gate_red");
          return;
        }
        const syn = synthesizeCodingDone(run, run.repo);
        pushRejection(run, "protocol", `coding_done SYNTHESIZED from git status/diff + gate exit codes after ${run.stall_count} phase-less turns`);
        const applied = applyPhase("coding_done", { done: syn.done });
        persist();
        paint(ctx);
        ctx.ui.notify(`orchestrate: coding_done synthesized from git + gate (round ${run.round}); the verifier swap is paid once`, "warning");
        void recordTurn("synthesized");
        settledNotified = false;
        await switchLane(applied.next, ctx);
        return;
      }
      if (tier === "stall") {
        const stalledFrom = run.state;
        run.state = "stalled_protocol_error";
        run.paused = true;
        run.reason = `${run.protocol_retries ?? 0} turn(s) ended with no fade_phase call from state ${stalledFrom}`;
        pushRejection(run, "protocol", `circuit breaker: ${run.reason}`);
        persist();
        paint(ctx);
        ctx.ui.notify(briefings.stalled(run), "error");
        void recordTurn("stalled_protocol_error");
        return;
      }
      pushRejection(run, "protocol", `turn ended in state ${run.state} with no fade_phase call (tier ${tier})`);
      persist();
      paint(ctx);
      await ensurePhaseTool();
      pi.sendUserMessage(`${briefings.nudge(run)}
${SCHEMA_HINT}`);
      void recordTurn("nudge");
      return;
    }
    if (run.paused === true) {
      pending = next;
      paint(ctx);
      ctx.ui.notify(`orchestrate: paused \u2014 the ${next.lane} load is deferred until [p]/[c] resumes`, "info");
      void recordTurn("paused");
      return;
    }
    classifyTurnEnd(run, true);
    void recordTurn(turnPhase ?? next.phase);
    await switchLane(next.lane, ctx);
  });
  pi.on("tool_call", (event) => {
    if (!run || isDelegatedSession()) return void 0;
    const live = runDir ? readJson(join5(runDir, STATE_FILENAME)) : void 0;
    if (!live || live.state !== "verifying" || live.lane !== THINK_LANE) return void 0;
    const name = event.toolName ?? "";
    if (MUTATING_TOOLS[name] !== true) return void 0;
    pushRejection(run, "task", `verifier sandbox: ${name} refused on the thinking lane (read-only); the fix is delegated to the coder`);
    persist();
    return { block: true, reason: `fade_orchestrate: the verifier lane is read-only \u2014 ${name} is refused. Report the finding with fade_phase; the coder lane applies it.` };
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setWidget(TOP_WIDGET_KEY, void 0);
    stopMetricsTimer();
  });
}
export {
  fadeOrchestrate as default
};
