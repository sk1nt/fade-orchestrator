// src/index.ts
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync3, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, dirname, join as join7 } from "node:path";
import { readFile as readFile2, stat as stat3 } from "node:fs/promises";
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
var VRAM_MIN_FREE_MIB = Number(process.env.FADE_ORCHESTRATE_VRAM_MIN_FREE_MIB ?? 8192);
var healthStates = (h) => ["status", "state"].map((k) => typeof h[k] === "string" && h[k].length > 0 ? h[k].toLowerCase() : void 0).filter((v) => v !== void 0);
var vramFreeMib = (h) => {
  const direct = finite(h.vram_free_mib) ?? finite(h.free_vram_mib);
  const nested = finite(h.vram?.free_mib);
  return direct ?? nested;
};
function serveVerdict(h) {
  if (h === void 0) return { serve: false, reason: `router unreachable at ${ROUTER}: /health refused; a router that cannot answer is not a context a swap can land in` };
  const bad = healthStates(h).find((s) => s !== "ok" && s !== "ready" && s !== "healthy");
  if (bad !== void 0) {
    return { serve: false, reason: `router health reports "${bad}": a context that stopped saying ok cannot serve the next lane` };
  }
  if (h.loading === true) {
    const sw = h.swap;
    const pct = finite(h.percent);
    return { serve: false, reason: `swap in flight${sw?.from ? ` ${sw.from} -> ${sw.to ?? "?"}` : ""}${pct !== void 0 ? ` at ${Math.round(pct)}%` : ""}: a second load is the queued ping-pong, not a faster lane` };
  }
  const free = vramFreeMib(h);
  if (free !== void 0 && free <= 0) return { serve: false, reason: `zero free VRAM (${free} MiB): the CUDA context is dead \u2014 the recorded half-dead shape` };
  if (free !== void 0 && free < VRAM_MIN_FREE_MIB) return { serve: false, reason: `free VRAM ${free} MiB is under the ${VRAM_MIN_FREE_MIB} MiB pack floor: no lane lands here` };
  const model = typeof h.model === "string" ? h.model.trim() : "";
  if (h.loaded === true || h.loaded === "true") {
    if (model === "") return { serve: false, reason: "health claims a loaded context that names no model: nothing is serving" };
  }
  return { serve: true, reason: `context can serve${model !== "" ? ` (${model}${h.loading === false ? ", idle" : ""})` : ""}${free !== void 0 ? `, ${Math.round(free)} MiB free` : ", VRAM not reported"}` };
}
async function settleInFlight() {
  let health = await laneHealth();
  for (let waited = 0; health?.loading === true && waited < SETTLE_MAX_MS; waited += SETTLE_POLL_MS) {
    const { promise: settle, resolve: settleDone } = Promise.withResolvers();
    setTimeout(settleDone, SETTLE_POLL_MS);
    await settle;
    health = await laneHealth();
  }
  return health;
}
var SETTLE_POLL_MS = Number(process.env.FADE_ORCHESTRATE_SETTLE_POLL_MS ?? 2e3);
var SETTLE_MAX_MS = Number(process.env.FADE_ORCHESTRATE_SETTLE_MAX_MS ?? 12e4);
async function loadLane(lane) {
  const t0 = Date.now();
  const health = await settleInFlight();
  const resident = (await listLanes()).models.find((m) => m.status === "loaded")?.id;
  const flip = flipState(resident, FLIP_WINDOW_MS);
  const guarded = flipGuarded(flip);
  if (resident === lane) return { ok: true, detail: `already resident; no swap issued${flipNote(flip)}`, elapsed_s: 0, guarded, flip };
  const verdict = serveVerdict(health);
  if (verdict.serve === false) {
    return { ok: false, detail: `refused pre-unload: ${verdict.reason}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1e3, guarded, flip };
  }
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
  const open3 = openRequestRow(metrics);
  if (open3) {
    const pp = prefillRate(open3);
    return { busy: true, running, waiting, reason: `request ${open3.id ?? "?"} is prompting (pp=${pp === void 0 ? "?" : Math.round(pp)} tok/s) with no decode_tok_s and no ttft_s yet${phase}; ${counters}` };
  }
  const resident = health?.model ?? (typeof health?.loaded === "string" ? health.loaded : void 0) ?? "?";
  return { busy: false, running, waiting, reason: `idle: ${resident} resident, no swap, no open request${metrics === void 0 ? ", /metrics unread" : ""}; ${counters}` };
}
var FLIP_WINDOW_MS = Number(process.env.FADE_ORCHESTRATE_FLIP_WINDOW_MS ?? 12e4);
var FLIP_MIN_SWAPS = Number(process.env.FADE_ORCHESTRATE_FLIP_MIN_SWAPS ?? 2);
var FLIP_BREAKER_AT = Number(process.env.FADE_ORCHESTRATE_FLIP_BREAKER_AT ?? 4);
var swapLog = [];
var lastSwapSig = "";
function resetFlipLedger() {
  swapLog.length = 0;
  lastSwapSig = "";
}
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
var flipBreaker = (f) => f.flips >= FLIP_BREAKER_AT;
var flipNote = (f) => flipGuarded(f) ? ` \u2014 FLIP GUARD: ${f.flips} swaps in ${f.window_s}s, requests naming ${f.competing.join(", ") || "the other lane"}` : "";

// src/desk.ts
import { join as join2 } from "node:path";

// src/core.ts
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { isAbsolute, join } from "node:path";
var execFileAsync = promisify(execFile);
async function execGitAsync(repo, args, opts = {}) {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    timeout: opts.timeout ?? 5e3,
    maxBuffer: opts.maxBuffer ?? 1 << 20,
    encoding: "utf8"
  });
  return `${stdout}`;
}
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
  if (!Array.isArray(st.tasks)) st.tasks = [];
  if (!Array.isArray(st.repair_tasks)) st.repair_tasks = [];
  if (!Array.isArray(st.phases)) st.phases = [];
  if (!Array.isArray(st.checks)) st.checks = [];
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
var repoProbe;
function isGitRepo(repo) {
  const ttl = Number(process.env.FADE_ORCHESTRATE_REPO_PROBE_TTL_MS ?? 15e3);
  if (repoProbe && repoProbe.repo === repo && (ttl <= 0 || Date.now() - repoProbe.at < ttl)) return repoProbe.answer;
  const answer = execGitAsync(repo, ["rev-parse", "--git-dir"]).then(
    () => true,
    () => false
  );
  repoProbe = { repo, at: Date.now(), answer };
  return answer;
}
var notARepo = (repo) => `(not a git repo: ${repo} \u2014 no git evidence; start the run inside a working tree, or run \`git init\` in it)`;
async function porcelain(repo) {
  if (!await isGitRepo(repo)) return notARepo(repo);
  try {
    const out = await execGitAsync(repo, ["status", "--porcelain"]);
    const head = out.replace(/\n+$/, "").split("\n").slice(0, 200).join("\n");
    return head || "(working tree clean)";
  } catch (e) {
    return `(git status failed: ${msg(e)} in ${repo})`;
  }
}
function adaptiveRounds(nTasks, budget) {
  return Math.min(budget, Math.max(3, 2 + Math.ceil(nTasks / 2)));
}
var TIER_ROUNDS = { trivial: 2, standard: 4, deep: 6 };
var isComplexity = (v) => v === "trivial" || v === "standard" || v === "deep";
function roundsForTasks(tasks, budget) {
  const declared = tasks.map((t) => t.complexity).filter(isComplexity);
  if (declared.length === 0) return adaptiveRounds(tasks.length, budget);
  return Math.min(budget, Math.max(2, ...declared.map((c) => TIER_ROUNDS[c])));
}
var SCHEMA_HINT = [
  "Payload schemas (exact, no extra keys; payload is the JSON object serialized to a string):",
  "```",
  'planning_done    {"tasks":[{"id":"T1","objective":"...","files":["a/b.ts"],"acceptance":"one command and what it proves","dependencies":[]}],"checks":[["cmd","expected"]]}',
  'coding_done      {"done":[{"id":"T1","status":"passed|failed|blocked","result":"what the acceptance command observed"},{"id":"T2","status":"passed|failed|blocked","result":"what its acceptance command observed"}]} \u2014 ONE coding_done reports EVERY task of the window',
  'verification_done {"verdict":"accepted|needs_repair","checks":[["cmd","observed"]],"notes":"the critique","tasks":[repair tasks, same shape as planning tasks]}',
  'verification_done  \xB7  optional "verdicts":[{"id":"V1.1","accepted":true,"notes":"\u2026"}] \u2014 ONLY while a verification batch is open (the desk named its ids in your briefing): one row per id, and that write is what unblocks the workers parked in fade_verify',
  "```",
  `A planning check whose ACCEPTED state is not exit-0 says so in the expected text's first words \u2014 "fails: <why>" (a non-zero exit is the pass) or "no output: <why>" (empty stdout is the pass); anything else is judged on exit 0.`
].join("\n");
function checkParses(cmd) {
  try {
    execFileSync("/bin/bash", ["-n", "-c", cmd], { stdio: "pipe", timeout: 5e3 });
    return { ok: true, detail: "" };
  } catch (e) {
    const err = e;
    return { ok: false, detail: `${err.stderr ?? ""}${err.message ?? String(e)}`.replace(/\s+/g, " ").slice(0, 220) };
  }
}
function expectation(expected) {
  const e = (expected ?? "").trim();
  if (/^(no output|no matches?|empty( |$)|silent)\b/i.test(e)) return "quiet";
  if (/^(fails?|failed|non-?zero|exits? ?[1-9]\d*|exit code [1-9]\d*|[1-9]\d* ?(on exit|exit))\b/i.test(e)) return "nonzero";
  return "exit0";
}
var GATE_TOTAL_BUDGET_DEFAULT_MS = 6e5;
var gateTotalBudgetMs = () => Math.max(1e3, Number(process.env.FADE_ORCHESTRATE_GATE_TOTAL_BUDGET_MS ?? GATE_TOTAL_BUDGET_DEFAULT_MS));
async function runGate(checks, cwd, onCheck) {
  const deadline = Date.now() + gateTotalBudgetMs();
  const results = [];
  for (let i = 0; i < checks.length; i++) {
    const [cmd, expected] = checks[i];
    onCheck?.({ index: i + 1, total: checks.length, cmd });
    const parse = checkParses(cmd);
    if (!parse.ok) {
      results.push({
        cmd,
        expected,
        ok: false,
        invalid: true,
        want: "exit0",
        tail: `not a command \u2014 bash -n: ${parse.detail} | plan defect: re-declare this check (planning_done); no tree state can make it pass`
      });
      continue;
    }
    const want = expectation(expected);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      results.push({
        cmd,
        expected,
        ok: false,
        want,
        budget: true,
        tail: `NOT RUN \u2014 the gate's ${Math.round(gateTotalBudgetMs() / 1e3)} s total budget was spent by the rows before this one; this check is unmeasured (FADE_ORCHESTRATE_GATE_TOTAL_BUDGET_MS)`
      });
      continue;
    }
    let out = "";
    try {
      const r = await execFileAsync("/bin/bash", ["-lc", cmd], { cwd, timeout: Math.min(12e4, remaining), maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
      out = r.stdout;
    } catch (e) {
      const err = e;
      out = `${err.stdout ?? ""}`;
      const code = typeof err.status === "number" ? err.status : typeof err.code === "number" ? err.code : void 0;
      const timedOut = err.killed === true && (err.signal === "SIGTERM" || err.code === "ETIMEDOUT");
      if (want === "nonzero") {
        results.push({ cmd, expected, ok: true, want, as_expected: true, tail: `as expected \u2014 the plan declares this state: ${expected} | exit ${code ?? "non-zero"}: ${`${out}${err.message ?? String(e)}`.slice(-300)}`.slice(-400) });
        continue;
      }
      if (want === "quiet" && out.trim() === "") {
        results.push({ cmd, expected, ok: true, want, as_expected: true, tail: `as expected \u2014 no output, exit ${code ?? "non-zero"}; the plan declares this state: ${expected}` });
        continue;
      }
      const suffix = timedOut ? ` | KILLED at the row's timeout (the command did not finish)` : "";
      results.push({ cmd, expected, ok: false, want, tail: `${out}${err.message ?? String(e)}${suffix}`.slice(-400) });
      continue;
    }
    if (want === "nonzero") {
      results.push({ cmd, expected, ok: false, want, tail: `expected a failure and the command exited 0 \u2014 the plan's declared state is stale, re-declare the check: ${expected} | ${out.slice(-300)}` });
      continue;
    }
    if (want === "quiet" && out.trim() !== "") {
      results.push({ cmd, expected, ok: false, want, tail: `expected no output and the command printed ${out.trim().split("\n").length} line(s): ${out.slice(0, 300)}` });
      continue;
    }
    results.push({ cmd, expected, ok: true, want, tail: `${out}`.slice(-400) });
  }
  return { at: (/* @__PURE__ */ new Date()).toISOString(), passed: results.every((r) => r.ok), results };
}
function refreshChecks(run, live) {
  const before = run.checks;
  const none = { changed: false, to: before.length, added: [], removed: [], redrafted: 0 };
  if (!live || live.run_id !== run.run_id || !Array.isArray(live.checks)) return none;
  const isPair = (c) => Array.isArray(c) && c.length === 2 && typeof c[0] === "string" && typeof c[1] === "string";
  const next = live.checks.filter(isPair);
  if (JSON.stringify(before) === JSON.stringify(next)) return { ...none, to: next.length };
  const redrafted = before.filter((b) => next.some((a) => a[0] === b[0] && a[1] !== b[1])).length;
  run.checks = next;
  return {
    changed: true,
    to: next.length,
    added: next.filter((a) => !before.some((b) => b[0] === a[0])).map((a) => a[0]),
    removed: before.filter((b) => !next.some((a) => a[0] === b[0])).map((b) => b[0]),
    redrafted
  };
}
async function refreshRoot(run, live, probe = isGitRepo) {
  if (!live || live.run_id !== run.run_id || typeof live.repo !== "string" || live.repo === "") return { changed: false, from: run.repo, to: run.repo };
  if (live.repo === run.repo) return { changed: false, from: run.repo, to: run.repo };
  if (!await probe(live.repo)) return { changed: false, from: run.repo, to: run.repo, refused: `${live.repo} is not a git working tree` };
  const from = run.repo;
  run.repo = live.repo;
  return { changed: true, from, to: live.repo };
}
async function diffStat(repo) {
  if (!await isGitRepo(repo)) return notARepo(repo);
  try {
    const out = await execGitAsync(repo, ["diff", "--stat"]);
    const tail = out.trim().split("\n").slice(-6).join("\n");
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
  const parts = g.results.map((r) => `${r.ok ? r.as_expected ? "ok*" : "ok" : r.invalid ? "INVALID" : "FAIL"} ${r.cmd}${r.ok ? "" : ` -> ${r.tail}`}`);
  const asExp = g.results.filter((r) => r.as_expected).length;
  return `gate ${g.at} ${g.passed ? "GREEN" : "RED"}${asExp ? ` (${asExp} as expected)` : ""}: ${parts.join(" | ") || "no checks"}`;
}
async function synthesizeCodingDone(run, repo) {
  const [raw, stat4] = await Promise.all([porcelain(repo), diffStat(repo)]);
  const entries = porcelainEntries(raw);
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
  return { done, sources: { porcelain: raw, diffStat: stat4, gate } };
}
function checkpointName(run, taskId) {
  return `omp-ckpt/${run.run_id}/${taskId}-passed`;
}
async function tagCheckpoint(repo, run, taskId) {
  const tag = checkpointName(run, taskId);
  if (!await isGitRepo(repo)) return { tag, ok: false, error: `not a git repo: ${repo} \u2014 no checkpoint tag is possible` };
  try {
    await execGitAsync(repo, ["tag", "-f", tag]);
    if (typeof run.checkpoints !== "object" || run.checkpoints === null) run.checkpoints = {};
    run.checkpoints[taskId] = tag;
    return { tag, ok: true };
  } catch (e) {
    return { tag, ok: false, error: msg(e) };
  }
}
function critiquesFor(run, ids) {
  const out = [];
  for (const id of ids) {
    const hits = (run.rejection_history ?? []).filter((r) => (r.task_id === id || `${r.reason}`.includes(id)) && (r.kind === "verification" || r.kind === "task"));
    if (hits.length === 0) continue;
    const last = hits[hits.length - 1];
    out.push(`  ${id} \u2014 rejected ${hits.length}\xD7 (latest round ${last.round}, ${last.kind}): ${last.reason}${hits.length > 1 ? "  \u21D0 the same diff was already tried; change the CAUSE, not the wording" : ""}`);
  }
  return out;
}
async function handover(run) {
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
    `Working tree: ${await diffStat(run.repo)}`
  ];
  return { stable, volatile };
}
async function handoverText(run) {
  const h = await handover(run);
  return [
    ...h.stable,
    "",
    ...h.volatile,
    "",
    `Continue from here: the resident lane is ${run.lane}. Report the next phase with fade_phase.`
  ].join("\n");
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
async function readJsonAsync(path) {
  try {
    return parseJson(await readFile(path, "utf8"));
  } catch {
    return void 0;
  }
}
async function writeJsonAsync(path, value) {
  const dir = join(path, "..");
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const h = await open(tmp, "w");
  try {
    await h.writeFile(`${JSON.stringify(value, null, 2)}
`);
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {
    });
    throw e;
  }
  try {
    const d = await open(dir, "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } catch {
  }
}
var coalesced = /* @__PURE__ */ new Map();
function coalesceWrite(path, value) {
  const slot = coalesced.get(path) ?? {
    tail: Promise.resolve(),
    settled: Promise.resolve(),
    pending: void 0
  };
  coalesced.set(path, slot);
  const queued = slot.pending !== void 0;
  slot.pending = { value };
  if (queued) return slot.settled;
  const drain = async () => {
    while (slot.pending) {
      const v = slot.pending.value;
      slot.pending = void 0;
      await writeJsonAsync(path, v);
    }
    if (coalesced.get(path) === slot) coalesced.delete(path);
  };
  const run = slot.tail.then(drain);
  slot.tail = run.catch(() => void 0);
  slot.settled = run;
  return slot.settled;
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
var LOCK_FILENAME = "orchestrator.lock";
function readInstanceLock(dir) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, LOCK_FILENAME), "utf8"));
    return raw && typeof raw === "object" ? raw : void 0;
  } catch {
    return void 0;
  }
}
function holderAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}
function acquireInstanceLock(dir, info) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILENAME);
  const claim = () => {
    const lock = { pid: process.pid, run_id: info.run_id, repo: info.repo, started: (/* @__PURE__ */ new Date()).toISOString(), host: hostname() };
    const fd = openSync(path, "wx");
    try {
      writeFileSync(fd, `${JSON.stringify(lock)}
`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const taken = () => {
    try {
      claim();
      return true;
    } catch (e) {
      if (e.code === "EEXIST") return false;
      throw e;
    }
  };
  if (taken()) return { ok: true };
  const holder = readInstanceLock(dir);
  if (holderAlive(holder?.pid)) return { ok: false, holder, stale: false };
  rmSync(path, { force: true });
  if (taken()) return { ok: true };
  const rival = readInstanceLock(dir) ?? holder ?? { pid: 0, run_id: "unknown", repo: info.repo, started: (/* @__PURE__ */ new Date()).toISOString(), host: hostname() };
  return { ok: false, holder: rival, stale: true };
}
function releaseInstanceLock(dir, pid = process.pid) {
  const holder = readInstanceLock(dir);
  if (!holder || holder.pid !== pid) return;
  try {
    unlinkSync(join(dir, LOCK_FILENAME));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
function instanceLockDir(router = process.env.FADE_ORCHESTRATE_ROUTER ?? "http://127.0.0.1:18014") {
  if (process.env.FADE_ORCHESTRATE_LOCK_DIR) return process.env.FADE_ORCHESTRATE_LOCK_DIR;
  const slug = router.replace(/^[a-z]+:\/\//i, "").replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "") || "router";
  return join(homedir(), ".local", "state", "fade-orchestrator", slug);
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
    if (t.complexity !== void 0 && !isComplexity(t.complexity)) return { error: `${id}: complexity must be trivial|standard|deep (got ${JSON.stringify(t.complexity)})` };
    const deps = t.dependencies ?? [];
    if (!Array.isArray(deps)) return { error: `${id}: dependencies must be an array` };
    for (const d of deps) {
      if (typeof d !== "string" || !seen.has(d)) return { error: `${id}: dependency ${JSON.stringify(d)} must name an earlier task` };
    }
    tasks.push({ id, objective: String(t.objective), files: t.files, acceptance: String(t.acceptance), dependencies: deps, round: 0, ...isComplexity(t.complexity) ? { complexity: t.complexity } : {} });
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
  const open3 = pool.filter((t) => t.status !== "passed");
  const readyNow = open3.filter((t) => unmet(t).length === 0).slice(0, MAX_WINDOW_TASKS);
  const taken = new Set(readyNow.map((t) => t.id));
  const blocked = open3.filter((t) => !taken.has(t.id)).map((t) => ({ id: t.id, blockedBy: unmet(t) })).filter((b) => b.blockedBy.length > 0);
  return { readyNow, blocked, open: open3 };
}
var gitCaveat = async (repo) => await isGitRepo(repo) ? "" : [
  "The run root " + repo + " is NOT a git repo: git status/git diff evidence does not exist here, so the phase synthesizer names every task blocked and the checkpoint tags are unavailable.",
  "The act is `git init " + repo + "` (or start the run inside a working tree)."
].join(" ");
function section(title, ...body) {
  const lines = body.filter((v) => v !== "" && v !== void 0 && v !== null && v !== false);
  return lines.length === 0 ? "" : [`## ${title}`, ...lines].join("\n");
}
function page(...parts) {
  return parts.filter((v) => v !== "" && v !== void 0 && v !== null && v !== false).join("\n\n");
}
function fence(body) {
  return "```\n" + body + "\n```";
}
function card(t, extra = []) {
  return [
    `- **${t.id}**${t.status ? ` [${t.status}]` : ""} \u2014 ${t.objective}`,
    `  - files: ${t.files.length > 0 ? t.files.join(", ") : "-"}`,
    `  - acceptance: ${t.acceptance}`,
    `  - dependencies: ${t.dependencies.length > 0 ? t.dependencies.join(", ") : "none"}`,
    ...extra
  ].join("\n");
}
var briefings = {
  plan: async (run) => page(
    `Phase 0 (planning), round ${run.round} of orchestrated run ${run.run_id}.`,
    section("Goal", run.goal),
    section(
      "Output \u2014 a plan is ONE object",
      `At most ${MAX_TASKS} tasks, and the checks that prove the goal:`,
      fence('{"tasks":[{"id":"T1","objective":"...","files":["repo/relative/path"],"acceptance":"one command and what it proves","dependencies":[]}],"checks":[["cmd","the observation that counts as green"]]}'),
      "Every task carries an id, an objective, repo-relative files, an acceptance that is ONE command plus what it proves, and its dependencies."
    ),
    section(
      "Checks are DATA the pre-swap gate runs through bash",
      fence(JSON.stringify(run.checks.length ? run.checks : [["<the command that proves the goal>", "<the observation that counts as green>"]])),
      "Each row is ONE command bash can parse. A row with a <placeholder>, an ellipsis or prose is a PLAN DEFECT: bash refuses it, it is never executed, and the gate stays red no matter what the tree does \u2014 so name commands this repo actually has, with real flags."
    ),
    section("Rules", "- Give dependent tasks earlier ids first.", "- Files are repo-relative and disjoint.", "- Plan only: no edits, no writes."),
    await gitCaveat(run.repo),
    section("Call", 'fade_phase phase="planning_done", payload=<that JSON as a string>.')
  ),
  code: async (run) => page(
    `Phase 1 (coding), round ${run.round} of orchestrated run ${run.run_id}.`,
    section("Goal", run.goal),
    section("Tasks", ...run.tasks.map((t) => card(t))),
    section("Contract", `Implement exactly these tasks in ${run.repo}. After each task run its acceptance command and record what it observed. Do not commit.`),
    await gitCaveat(run.repo),
    section("Call", 'fade_phase phase="coding_done", payload:', fence('{"done":[{"id":"T1","status":"passed|failed|blocked","result":"what the acceptance command observed"}]}'))
  ),
  /**
   * The coder's BATCH briefing — one window, one turn, one `coding_done`. Every task of
   * `roundWindow().readyNow` is spelled out UNTRUNCATED (objective, files, acceptance,
   * dependencies) because a card the lane cannot read in full is a card it implements from
   * imagination; the blocked tasks are listed with the ids that hold them so the lane knows
   * what to leave alone; and the one-payload contract is stated in the turn's own words, which
   * is the half that kills the per-task window (the refusal in `validateDone` is the other
   * half). The fenced payload IS the window: the ids it names are the ids that may be reported.
   */
  window: async (run) => {
    const { readyNow, blocked, open: open3 } = roundWindow(run);
    const inWindow = new Set(readyNow.map((t) => t.id));
    const blockedIds = new Set(blocked.map((b) => b.id));
    const deferred = open3.filter((t) => !inWindow.has(t.id) && !blockedIds.has(t.id)).map((t) => t.id);
    const critiques = run.round > 1 ? critiquesFor(run, readyNow.map((t) => t.id)) : [];
    const entry = (id) => `{"id":"${id}","status":"passed|failed|blocked","result":"what the acceptance command observed"}`;
    return page(
      `Phase 1 (coding) \u2014 ONE WINDOW, round ${run.round}/${run.max_rounds} \xB7 T${readyNow.length}/${open3.length} \xB7 lane ${run.lane} \xB7 orchestrated run ${run.run_id}.`,
      section("Goal", run.goal),
      section(
        "Window contract",
        readyNow.length > 0 ? `This ONE turn implements EVERY task below in ${run.repo} and reports them ALL in ONE coding_done payload:` : "The window is EMPTY: every open task is blocked by an unpassed dependency. There is nothing to implement in this turn \u2014 do not send a coding_done naming a blocked task; report the blockers and end the turn.",
        readyNow.length > 0 ? fence(`{"done":[${readyNow.map((t) => entry(t.id)).join(",")}]}`) : "",
        readyNow.length > 0 ? "Do not report after one task and do not take a second coding turn for these tasks \u2014 one window, one coding_done, one lane swap." : ""
      ),
      section(`Tasks in this window (${readyNow.length} of ${open3.length} open)`, readyNow.length > 0 ? "each card in full:" : "none.", ...readyNow.map((t) => card(t))),
      section(
        "Not in this window",
        blocked.length > 0 ? "Unmet dependencies \u2014 do not start them and never name one in coding_done:" : "",
        ...blocked.map((b) => `- ${b.id} blocked by ${b.blockedBy.join(", ")}`)
      ),
      deferred.length > 0 ? section("Deferred", `Ready but past the ${MAX_WINDOW_TASKS}-task window cap (the NEXT window's work, leave it alone now): ${deferred.join(", ")}.`) : "",
      critiques.length > 0 ? section("Rejected before \u2014 the verifier's critique", "for the tasks of THIS window, by task id; a task rejected twice has already had this diff tried, so change the cause:", ...critiques) : "",
      section(
        "Context",
        'this prompt carries the goal, the phase contract, the task definitions, the diff stat, the gate and the last rejections \u2014 nothing else. Re-reading a file you read this round, and pasting tool logs into "result", are what break the stable prefix the conversation cache reuses.',
        `Run each task's acceptance command and put what it printed in that task's "result". Do not commit.`
      ),
      await gitCaveat(run.repo)
    );
  },
  verify: (run) => page(
    `Phase 2 (verification), round ${run.round} of orchestrated run ${run.run_id}.`,
    section("Goal", run.goal),
    section("Task results", ...run.tasks.map((t) => card(t, [`  - result: ${t.result ?? "unreported"}`]))),
    section(
      "Checks to re-run",
      `Read the diff (run "git diff" in ${run.repo} yourself) and re-run every check:`,
      fence(JSON.stringify(run.checks)),
      `Verdict rule: "accepted" needs EVERY check re-run BY YOU in this turn, each row reported as ["cmd","observed"] with what THAT run printed. The pre-swap gate already ran them green on the coding lane and its row is in the state file; a row copied from the gate's result is not a re-run, and a check you did not run cannot be accepted.`
    ),
    section(
      "needs_repair",
      `"needs_repair" ends the round and must name the tasks for round ${run.round + 1} as full cards:`,
      fence('{"id":"R1","objective":"the CAUSE, not the same attempt","files":["repo/relative/path"],"acceptance":"one command and what it proves","dependencies":[]}'),
      "A task rejected twice has had this exact diff tried: name the cause the next round can act on."
    )
  ),
  /**
   * The BATCH verification briefing: one lane load, every worker's request in it, judged once.
   *
   * The window is the point of the page. The lane is told the ids are the whole universe of this
   * pass — a verifier that wanders onto a slice another worker is still holding starts a second
   * pass over the same tree, which is the churn the desk batches away — and that its verdicts land
   * on the desk BY ID (`fade_verdicts`), because that is the only path that unblocks a worker
   * parked in `fade_verify`. The round's own verdict is the aggregate of the batch.
   */
  verifyBatch: (run, batch) => page(
    `Phase 2 (verification) \u2014 ONE BATCH, batch ${batch.batch + 1} of orchestrated run ${run.run_id}, round ${run.round}/${run.max_rounds}, routed ${batch.routed}.`,
    section("Goal", run.goal),
    section(
      "Batch contract",
      `${batch.ids.length} delegated worker request${batch.ids.length === 1 ? "" : "s"} landed on the verification desk while the code lane worked. This ONE turn judges ALL of them and posts ALL of the verdicts. Do not verify anything outside these ids, and do not take a second verification turn for them \u2014 one batch, one pass, one lane swap.`
    ),
    section(
      `Requests (${batch.ids.length})`,
      ...batch.requests.map(
        (r) => [
          `- ${r.id} \u2014 worker \`${r.agent}\`${r.task_id ? ` (task ${r.task_id})` : ""}: ${r.objective}`,
          r.acceptance ? `    acceptance: ${r.acceptance}` : "",
          r.checks.length > 0 ? `    run yourself:
${r.checks.map(([cmd, expected]) => `      - \`${cmd}\` (expected ${expected})`).join("\n")}` : "    no commands named: judge from the diff and the named acceptance."
        ].filter(Boolean).join("\n")
      )
    ),
    section(
      "Post the verdicts BY ID",
      `Call the \`fade_verdicts\` tool ONCE with \`batch: ${batch.batch + 1}\` (the batch number in this page's heading) and one row per id. That write is what unblocks each worker parked in \`fade_verify\`; a verdict in prose alone leaves every worker waiting.`,
      fence(`{"batch":${batch.batch + 1},"verdicts":[{"id":"${batch.ids[0] ?? "V1.1"}","accepted":true,"notes":"the command you ran and what it printed, or the cause to fix"}]}`)
    ),
    section(
      "Then the round's verdict",
      `Call fade_phase phase="verification_done" with the AGGREGATE: "accepted" only when EVERY id above passed on checks YOU re-ran this turn; "needs_repair" naming the repair tasks the batch implies. Pass the per-id rows in \`verdicts\` too, so the desk record and the round record cannot diverge.`,
      fence('{"verdict":"accepted|needs_repair","checks":[["cmd","observed"]],"notes":"the batch verdict","tasks":[],"verdicts":[{"id":"V1.1","accepted":true,"notes":"\u2026"}]}')
    ),
    section(
      "Verdict rule",
      `"accepted" needs every command above re-run BY YOU in this turn, in ${run.repo}, with what THAT run printed. A check you did not run cannot be accepted, and a request you did not judge is a defect, not a pass.`
    )
  ),
  repair: async (run) => {
    const prior = (run.rejection_history ?? []).slice(-5).map((r) => `- round ${r.round} [${r.kind}]${r.task_id ? ` ${r.task_id}:` : ""} ${r.reason}`);
    const ids = (run.repair_tasks ?? []).map((t) => t.id);
    const critiques = critiquesFor(run, ids);
    const checklist = (run.repair_tasks ?? []).map((t) => `${t.id}: ${t.acceptance}`);
    return page(
      `Phase 1 (repair), round ${run.round} of orchestrated run ${run.run_id}.`,
      section("Goal", run.goal),
      section("Repair tasks", ...(run.repair_tasks ?? []).map((t) => card(t))),
      // The critique the task itself earned, with its count — the anti-oscillation line.
      critiques.length > 0 ? section("Rejected before \u2014 the verifier's words, BY TASK:", ...critiques) : "",
      prior.length > 0 ? section("Previously rejected \u2014 fix the cause, do not repeat the attempt", ...prior) : "",
      // Compaction: the diff and the checklist answer "where am I"; no prior-round logs ride.
      section("Tree", `Working tree: ${await diffStat(run.repo)}`, checklist.length > 0 ? `Checklist: ${checklist.join(" | ")}` : ""),
      section(
        "Context",
        "this prompt carries the task definitions, the diff stat, the checklist and the last rejections \u2014 no prior-round tool logs. Re-running the acceptance command is the only re-read this round needs.",
        `Implement the repairs in ${run.repo}, run each acceptance command, do not commit.`
      ),
      await gitCaveat(run.repo),
      section("Call", 'fade_phase phase="coding_done", payload:', fence('{"done":[{"id":"T1","status":"passed|failed|blocked","result":"what the acceptance command observed"}]}'))
    );
  },
  gate: (run) => {
    const results = run.gate_last?.results ?? [];
    const invalid = results.filter((r) => r.invalid);
    const failing = results.filter((r) => !r.ok && !r.invalid);
    return page(
      `Pre-swap gate RED, round ${run.round} of orchestrated run ${run.run_id} \u2014 the verifier lane was NOT loaded; the swap is only paid for a green tree.`,
      section("Plan defects (never executed)", ...invalid.map((f) => [`- INVALID CHECK (not a command, never executed): ${f.cmd}`, `  - expected: ${f.expected}`, `  - observed: ${f.tail}`].join("\n"))),
      section("Checks that ran and failed", ...failing.map((f) => [`- FAIL: ${f.cmd}`, `  - expected: ${f.expected}`, `  - observed tail: ${f.tail}`].join("\n"))),
      invalid.length > 0 ? section(
        "The exit is a plan act",
        `${invalid.length} of the plan's checks are PLAN DEFECTS: bash refuses to parse them, so no state of ${run.repo} can make them green and no amount of coding will pay the swap. Fixing the tree is not the remedy \u2014 the exit is a plan act: call fade_phase phase="planning_done" with the rows re-declared as runnable commands (the tool's own --ref / --root / absolute-binary forms, no <placeholders>), keeping every task.`
      ) : "",
      section("Fix", `Fix the causes in ${run.repo} (the checks are the plan's own), re-run them yourself until they pass, then call fade_phase phase="coding_done" again.`)
    );
  },
  final: (run) => {
    const path = join(run.repo, "var", "omp-orchestrate", STATE_FILENAME);
    if (run.state === "complete") return `Orchestrated run ${run.run_id} completed: verdict accepted after round ${run.round}. State and phase log: ${path}. Resident lane ${run.lane}; nothing is preloaded.`;
    if (run.state === "failed") return `Orchestrated run ${run.run_id} failed at round ${run.round} in state ${run.state}: ${run.reason ?? "unreported"}. State file: ${path}.`;
    return `Orchestrated run ${run.run_id} stopped at round ${run.round}; resident lane left as ${run.lane}.`;
  },
  /**
   * Tier 1 of the protocol ladder: the lane ended its turn without calling `fade_phase`. No
   * round was spent and no swap happens — the same lane is re-briefed in VRAM with the ONE
   * thing it owes, plus the published schema, and told exactly what the next miss costs.
   */
  nudge: (run) => {
    const phase = PHASE_FOR_STATE[run.state] ?? "coding_done";
    return page(
      `Protocol nudge ${run.stall_count ?? 1}/${STALL_SYNTHESIZE_AT} \u2014 orchestrated run ${run.run_id}, state ${run.state}, round ${run.round}/${run.max_rounds} (UNSPENT: the round budget does not move here), lane ${run.lane}.`,
      section("What is missing", "Your turn ended with NO fade_phase call. The loop cannot advance without it and will not swap lanes."),
      section("Call it now", `Call the fade_phase tool NOW: phase="${phase}", payload=<the JSON object serialized to a string>.`),
      SCHEMA_HINT,
      section("Answer", 'The work is done? Say so with the acceptance command and what it printed in "result". The work is NOT done? Finish it, then report.'),
      section("Cost of the next miss", "The next miss auto-synthesizes this round's coding_done from git and the gate exit codes; the one after halts the run as stalled_protocol_error.")
    );
  },
  /**
   * Tier 3 of the protocol ladder: the circuit breaker tripped. The run is paused, the lane is
   * left as it is, and this is the diagnostic an operator acts on: what the machine saw, what
   * is RED, what git says, and the exact files to open.
   */
  stalled: async (run) => {
    const path = join(run.repo, "var", "omp-orchestrate", STATE_FILENAME);
    const phases = (run.phases ?? []).slice(-3).map((p) => `${p.phase} round ${p.round} accepted=${p.accepted}${p.notes ? ` notes=${p.notes}` : ""}`);
    const failing = (run.gate_last?.results ?? []).filter((r) => !r.ok).map((r) => [`- RED: ${r.cmd}`, `  - expected: ${r.expected}`, `  - observed: ${r.tail}`].join("\n"));
    const rejections = (run.rejection_history ?? []).slice(-5).map((r) => `- round ${r.round} [${r.kind}]${r.task_id ? ` ${r.task_id}:` : ""} ${r.reason}`);
    return page(
      `Orchestrated run ${run.run_id} HALTED: stalled_protocol_error \u2014 ${run.protocol_retries ?? 0} turn(s) ended with no fade_phase call (state ${run.state}, round ${run.round}/${run.max_rounds}, lane ${run.lane}). The loop is paused; nothing further is sent to any lane and no lane was swapped.`,
      section("Phases the machine saw", phases.length > 0 ? phases.join("\n") : "No phase was ever accepted by this run."),
      section("Synthesis", run.synthesized ? `Synthesized coding_done at round ${run.synthesized.round} (${run.synthesized.at}): ${JSON.stringify(run.synthesized)}` : "Nothing was synthesized."),
      section("Deterministic gate", gateSummary(run)),
      failing.length > 0 ? section("Checks that are RED", ...failing) : "",
      rejections.length > 0 ? section("Recent rejections", ...rejections) : "",
      section("Tree", `Working tree: ${await diffStat(run.repo)}`, run.operator_note ? `Operator note: ${run.operator_note}` : ""),
      section("Act on it", `read ${path}, run the plan's own checks in ${run.repo}, then /orchestrate pause to unpause in place, /orchestrate code to resume on the code lane, or /orchestrate stop to end the run.`)
    );
  }
};

// src/desk.ts
var DESK_SCHEMA = "fade.orchestrate.verify_desk.v1";
var DESK_DIRNAME = "verify";
var DESK_FILENAME = "desk.json";
var DESK_SETTLE_MS = Number(process.env.FADE_ORCHESTRATE_DESK_SETTLE_MS ?? 8e3);
var DESK_DEADLINE_MS = Number(process.env.FADE_ORCHESTRATE_DESK_DEADLINE_MS ?? 12e4);
var DESK_WAIT_MS = Number(process.env.FADE_ORCHESTRATE_DESK_WAIT_MS ?? 24e4);
var DESK_POLL_MS = Number(process.env.FADE_ORCHESTRATE_DESK_POLL_MS ?? 1e3);
var deskPath = (dir) => join2(dir, DESK_DIRNAME, DESK_FILENAME);
function emptyDesk(runId, at = (/* @__PURE__ */ new Date()).toISOString()) {
  return {
    schema: DESK_SCHEMA,
    run_id: runId,
    epoch: 0,
    open_utc: at,
    expected: 0,
    agents: [],
    churn: false,
    requests: [],
    addressed: [],
    updated_utc: at
  };
}
var asRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : void 0;
var num = (v, dflt) => typeof v === "number" && Number.isFinite(v) ? v : dflt;
var str = (v, dflt = "") => typeof v === "string" ? v : dflt;
var bool = (v) => v === true;
var isoMs = (v, fallback) => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : fallback;
};
function checkRows(v) {
  if (!Array.isArray(v)) return [];
  const rows = [];
  for (const row of v) {
    if (Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "string") rows.push([row[0], row[1]]);
    else {
      const o = asRecord(row);
      if (o && typeof o.cmd === "string") rows.push([o.cmd, str(o.expected, "exit 0")]);
    }
  }
  return rows;
}
function readRequest(v, batch) {
  const o = asRecord(v);
  if (!o) return void 0;
  const id = str(o.id);
  if (id === "") return void 0;
  const req = {
    id,
    batch: num(o.batch, batch),
    agent: str(o.agent, "task"),
    session: str(o.session),
    objective: str(o.objective),
    checks: checkRows(o.checks),
    enqueued_utc: str(o.enqueued_utc, (/* @__PURE__ */ new Date(0)).toISOString())
  };
  if (typeof o.task_id === "string" && o.task_id !== "") req.task_id = o.task_id;
  if (typeof o.acceptance === "string" && o.acceptance !== "") req.acceptance = o.acceptance;
  if (typeof o.claimed_batch === "number" && Number.isFinite(o.claimed_batch)) req.claimed_batch = o.claimed_batch;
  const verdict = asRecord(o.verdict);
  if (verdict) req.verdict = { accepted: bool(verdict.accepted), notes: str(verdict.notes), at: str(verdict.at) };
  return req;
}
function parseDesk(v, runId) {
  const o = asRecord(v);
  if (!o || o.schema !== DESK_SCHEMA) return void 0;
  if (runId !== void 0 && typeof o.run_id === "string" && o.run_id !== "" && o.run_id !== runId) return void 0;
  const epoch = num(o.epoch, 0);
  const desk = {
    schema: DESK_SCHEMA,
    run_id: str(o.run_id, runId ?? ""),
    epoch,
    open_utc: str(o.open_utc, (/* @__PURE__ */ new Date(0)).toISOString()),
    expected: num(o.expected, 0),
    agents: Array.isArray(o.agents) ? o.agents.filter((a) => typeof a === "string") : [],
    churn: bool(o.churn),
    requests: Array.isArray(o.requests) ? o.requests.map((r) => readRequest(r, epoch)).filter((r) => r !== void 0) : [],
    addressed: [],
    updated_utc: str(o.updated_utc, (/* @__PURE__ */ new Date(0)).toISOString())
  };
  if (typeof o.sealed_utc === "string" && o.sealed_utc !== "") desk.sealed_utc = o.sealed_utc;
  if (typeof o.churn_utc === "string" && o.churn_utc !== "") desk.churn_utc = o.churn_utc;
  if (Array.isArray(o.addressed)) {
    for (const a of o.addressed) {
      const row = asRecord(a);
      if (!row) continue;
      desk.addressed.push({
        batch: num(row.batch, 0),
        ids: Array.isArray(row.ids) ? row.ids.filter((i) => typeof i === "string") : [],
        routed: row.routed === "subagent" ? "subagent" : "swap",
        at: str(row.at)
      });
    }
  }
  return desk;
}
function openRequests(desk) {
  return desk.requests.filter((r) => r.batch === desk.epoch && r.claimed_batch === void 0 && r.verdict === void 0);
}
function readyToAddress(desk, nowMs, opts = {}) {
  const settleMs = opts.settleMs ?? DESK_SETTLE_MS;
  const deadlineMs = opts.deadlineMs ?? DESK_DEADLINE_MS;
  const live = openRequests(desk);
  const base = { open: live.length, registered: live.length, expected: desk.expected, churn: desk.churn };
  if (live.length === 0) return { ready: false, reason: "desk_empty", oldest_ms: -1, ...base };
  const oldestMs = nowMs - Math.min(...live.map((r) => isoMs(r.enqueued_utc, nowMs)));
  const oldest = { oldest_ms: oldestMs };
  if (desk.sealed_utc !== void 0) return { ready: true, reason: "sealed", ...oldest, ...base };
  if (desk.expected > 0 && live.length >= desk.expected) return { ready: true, reason: "all_registered", ...oldest, ...base };
  if (nowMs - isoMs(desk.open_utc, nowMs) >= deadlineMs) return { ready: true, reason: "deadline", ...oldest, ...base };
  if (oldestMs >= settleMs) return { ready: true, reason: "settled", ...oldest, ...base };
  return { ready: false, reason: `waiting for the batch to close: ${live.length}/${desk.expected > 0 ? desk.expected : "?"} workers registered`, ...oldest, ...base };
}
function claimBatch(desk, routed, at = (/* @__PURE__ */ new Date()).toISOString()) {
  const live = openRequests(desk);
  const batch = desk.epoch;
  for (const r of live) r.claimed_batch = batch;
  const ids = live.map((r) => r.id);
  const next = {
    ...desk,
    epoch: batch + 1,
    open_utc: at,
    expected: 0,
    agents: [],
    addressed: [...desk.addressed, { batch, ids, routed, at }],
    updated_utc: at
  };
  delete next.sealed_utc;
  return { desk: next, batch, ids };
}
function enqueueRequest(desk, req, at = (/* @__PURE__ */ new Date()).toISOString()) {
  const existing = desk.requests.find((r) => r.batch === desk.epoch && r.agent === req.agent && r.claimed_batch === void 0 && r.objective === req.objective);
  if (existing) return { desk, request: existing, deduped: true };
  const n = desk.requests.filter((r) => r.batch === desk.epoch).length + 1;
  const request = {
    id: `V${desk.epoch + 1}.${n}`,
    batch: desk.epoch,
    agent: req.agent,
    session: req.session,
    objective: req.objective,
    checks: checkRows(req.checks),
    enqueued_utc: at
  };
  if (req.task_id) request.task_id = req.task_id;
  if (req.acceptance) request.acceptance = req.acceptance;
  return {
    desk: { ...desk, requests: [...desk.requests, request], agents: desk.agents.includes(req.agent) ? desk.agents : [...desk.agents, req.agent], updated_utc: at },
    request,
    deduped: false
  };
}
function noteTaskBatch(desk, batch, at = (/* @__PURE__ */ new Date()).toISOString()) {
  const agents = [...desk.agents];
  for (const a of batch.agents) if (!agents.includes(a)) agents.push(a);
  return { ...desk, expected: Math.max(desk.expected, Math.max(0, batch.count)), agents, updated_utc: at };
}
function sealBatch(desk, at = (/* @__PURE__ */ new Date()).toISOString()) {
  if (desk.sealed_utc !== void 0) return desk;
  return { ...desk, sealed_utc: at, updated_utc: at };
}
function setChurn(desk, on, at = (/* @__PURE__ */ new Date()).toISOString()) {
  if (desk.churn === on) return desk;
  if (on) return { ...desk, churn: true, churn_utc: at, updated_utc: at };
  delete desk.churn_utc;
  return { ...desk, churn: false, updated_utc: at };
}
function attachVerdicts(desk, verdicts, at = (/* @__PURE__ */ new Date()).toISOString()) {
  const attached = [];
  const unknown = [];
  for (const v of verdicts) {
    const hit = desk.requests.find((r) => r.id === v.id);
    if (!hit) {
      unknown.push(v.id);
      continue;
    }
    hit.verdict = { accepted: v.accepted === true, notes: v.notes, at };
    attached.push(v.id);
  }
  return { desk: { ...desk, requests: desk.requests, updated_utc: at }, attached, unknown };
}
var requestById = (desk, id) => desk.requests.find((r) => r.id === id);
function deskCensus(desk) {
  return {
    open: openRequests(desk).length,
    owed: desk.requests.filter((r) => r.claimed_batch !== void 0 && r.verdict === void 0).length,
    answered: desk.requests.filter((r) => r.verdict !== void 0).length,
    batches: desk.addressed.length,
    churn: desk.churn
  };
}
function deskLine(desk) {
  const c = deskCensus(desk);
  return `desk batch ${desk.epoch + 1}: ${c.open} open, ${c.owed} awaiting verdict, ${c.answered} answered, ${c.batches} addressed${desk.churn ? " \xB7 CHURN ROUTE (subagent verification)" : ""}`;
}
async function readDesk(dir, runId) {
  return parseDesk(await readJsonAsync(deskPath(dir)), runId);
}
async function mutateDesk(dir, runId, fn, tries = 4) {
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const current = await readDesk(dir, runId) ?? emptyDesk(runId);
    const next = fn(current);
    next.updated_utc = (/* @__PURE__ */ new Date()).toISOString();
    await writeJsonAsync(deskPath(dir), next);
    const back = await readDesk(dir, runId);
    if (back && JSON.stringify(back) === JSON.stringify(next)) return next;
    last = back ?? next;
  }
  return last ?? emptyDesk(runId);
}
var sleep = (ms) => {
  const { promise, resolve: resolve2 } = Promise.withResolvers();
  setTimeout(resolve2, ms);
  return promise;
};
async function awaitVerdict(dir, runId, id, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DESK_WAIT_MS;
  const pollMs = opts.pollMs ?? DESK_POLL_MS;
  const t0 = Date.now();
  let polls = 0;
  for (; ; ) {
    polls += 1;
    if (opts.signal?.aborted === true) {
      return { state: "cancelled", note: `${id}: the wait was cancelled; the request stays on the desk and the next verification pass answers it`, polls, waited_ms: Date.now() - t0 };
    }
    const desk = await readDesk(dir, runId);
    const req = desk ? requestById(desk, id) : void 0;
    if (req?.verdict) return { state: "answered", request: req, note: `${id} ${req.verdict.accepted ? "ACCEPTED" : "needs_repair"}: ${req.verdict.notes}`, polls, waited_ms: Date.now() - t0 };
    if (Date.now() - t0 >= timeoutMs) {
      return {
        state: "deferred",
        request: req,
        note: `${id} is queued in batch ${(desk?.epoch ?? 0) + 1} with no verdict after ${Math.round((Date.now() - t0) / 1e3)}s (${polls} polls): the batch is owed its verification pass \u2014 report your result and end, do not re-register`,
        polls,
        waited_ms: Date.now() - t0
      };
    }
    await sleep(pollMs);
  }
}

// src/subagent.ts
var VERIFIER_AGENT = process.env.FADE_ORCHESTRATE_VERIFIER_AGENT ?? "fade-verifier";
var VERIFIER_MODEL = process.env.FADE_ORCHESTRATE_VERIFIER_MODEL ?? "ninfer-local/coder-gpu1";
var ROUTER_ENTRIES = [CODE_LANE, THINK_LANE, PROVIDER].map((s) => s.toLowerCase());
function isRouterModel(model) {
  const m = model.toLowerCase();
  return ROUTER_ENTRIES.some((entry) => m === entry || m.startsWith(`${entry}/`) || m.includes(`/${entry}`) || m.startsWith(`${entry}:`));
}
var textOf = (v) => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join("\n");
  return "";
};
function carriesVerification(body) {
  if (/\bverif(y|ication|ied)\b/i.test(body)) return true;
  if (/\bacceptance\b|\bgate\b|\baudit\b|promotion gate/i.test(body)) return true;
  if (/\b(cargo (test|clippy)|pytest|node --test|npm (run )?test|playwright|tsc|typecheck|lint)\b/i.test(body)) return true;
  return /\bverify\b|\bverify that\b|\bprove\b|\bscore\b|\bparit(?:y|es)\b/i.test(body);
}
function taskBatchOf(input) {
  const items = [];
  const list = Array.isArray(input?.tasks) ? input.tasks : [];
  for (const item of list) {
    const o = item !== null && typeof item === "object" && !Array.isArray(item) ? item : { task: String(item) };
    items.push(o);
  }
  if (items.length === 0) {
    const single = input?.task !== void 0 || input?.agent !== void 0;
    if (single) items.push(input);
  }
  const kinds = items.map((o) => {
    const agent = textOf(o.agent).trim() || textOf(o.name).trim() || "task";
    const body = `${textOf(o.task)}
${textOf(o.target)}
${textOf(o.acceptance)}
${textOf(o.solutionSpace)}`;
    return { agent, verification: carriesVerification(body) };
  });
  const agents = kinds.map((k) => k.agent);
  const verifyAgents = kinds.filter((k) => k.verification).map((k) => k.agent);
  return {
    count: Math.max(1, kinds.length),
    agents: agents.length > 0 ? agents : ["task"],
    verifyAgents,
    carriesVerification: verifyAgents.length > 0,
    kinds: kinds.length > 0 ? kinds : [{ agent: "task", verification: false }]
  };
}
function routeFor(desk, flip, opts = {}) {
  const guardAt = opts.guardAt ?? FLIP_MIN_SWAPS;
  if (desk.churn) return { route: "subagent", reason: `the desk has churn declared${desk.churn_utc ? ` since ${desk.churn_utc}` : ""}: batches are answered by a verification subagent on ${VERIFIER_MODEL}, and no lane load is paid`, flips: flip.flips };
  if (flip.flips >= guardAt) return { route: "subagent", reason: `lane churn began: ${flip.flips} swaps away from the run's lane in the guard window \u2014 the verification goes to a subagent on ${VERIFIER_MODEL} (zero router swaps) instead of a lane load`, flips: flip.flips };
  return { route: "swap", reason: `no churn: one ${THINK_LANE} load addresses the whole batch`, flips: flip.flips };
}
function verifierTaskCall(batch, ids, requests = []) {
  return `task { "agent": "${VERIFIER_AGENT}", "name": "Verify${batch + 1}", "solutionSpace": "one batched verification pass, verdicts posted by id", "task": ${JSON.stringify(verifierTaskBody(batch, ids, requests))} }`;
}
function verifierTaskBody(batch, ids, requests = []) {
  const rows = requests.map((r) => {
    const checks = r.checks.map(([cmd, expected]) => `    - \`${cmd}\` (expected ${expected})`).join("\n");
    return [`  - ${r.id} (worker ${r.agent}${r.task_id ? `, task ${r.task_id}` : ""}): ${r.objective}`, r.acceptance ? `    acceptance: ${r.acceptance}` : "", checks ? `  checks:
${checks}` : ""].filter(Boolean).join("\n");
  });
  return [
    `# Verification batch ${batch + 1}`,
    "",
    "You are the verification lane for this batch. You run on a non-router model, so you cost the",
    "orchestrator ZERO lane swaps. Do NOT touch the basalt router (`/v1/load`, `setModel`), do NOT",
    "edit any file, and do NOT verify anything outside the ids below \u2014 every other slice is in",
    "another agent's hands and a second pass over it is the churn this route exists to avoid.",
    "",
    "Rules:",
    "1. Run each check command yourself, in the session cwd, and judge the request on what it",
    "   printed. A check you did not run cannot be accepted.",
    "2. Read the diff (`git status --porcelain`, `git diff`) for the files each id names.",
    "3. Post exactly one verdict per id with the `fade_verdicts` tool: `batch` is the number in",
    `   the heading above (${batch + 1}), and \`verdicts: [{id, accepted, notes}]\`. \`notes\` names the`,
    "   command and what it printed, or the cause the coder must fix. An id you did not judge is a",
    "   defect, not a pass.",
    "4. Report the verdicts verbatim in your final message; the desk is the durable record.",
    "",
    ids.length > 0 ? `Ids to judge: ${ids.join(", ")}` : "Ids to judge: (none \u2014 the batch was claimed empty; post nothing and end)",
    rows.length > 0 ? `
Requests:
${rows.join("\n")}` : ""
  ].join("\n");
}
function verifierDirective(batch, ids, reason, requests = []) {
  return [
    `Verification batch ${batch + 1} (${ids.length} worker request${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}) is READY, and the loop will NOT pay a lane load for it.`,
    `Reason: ${reason}`,
    "",
    "Do exactly this, once, in this turn:",
    "1. Call the `task` tool with the verifier agent \u2014",
    verifierTaskCall(batch, ids, requests),
    `   (agent definition \`${VERIFIER_AGENT}\`, model \`${VERIFIER_MODEL}\`, off the router: no pack is loaded and no swap is paid).`,
    "2. When it returns, the verdicts are already on the desk (`fade_verdicts` posted them), so the",
    "   waiting workers unblock on their own. Do not re-run the checks in this session.",
    "3. Do not call `fade_phase verification_done` for these ids from the code lane; the batch's",
    "   verdicts are the worker-scoped answer. Act on a `needs_repair` verdict by fixing the cause.",
    "",
    "Do not load the thinking lane for this batch, and do not delegate the same ids twice."
  ].join("\n");
}
function verifierAgentMd(model = VERIFIER_MODEL, agent = VERIFIER_AGENT) {
  const offRouter = !isRouterModel(model);
  const routerWarning = offRouter ? "" : `
  # WARNING: ${model} IS a basalt ROUTER entry \u2014 a subagent on it pays the 13-25 s
  # pack swap this agent exists to avoid, which is the churn the route was
  # built to escape. Point FADE_ORCHESTRATE_VERIFIER_MODEL at a non-router
  # model (e.g. ninfer-local/coder-gpu1) and re-run /orchestrate verifier install.
`;
  return [
    "---",
    `name: ${agent}`,
    `description: Batched verification lane for the fade orchestrator: judges every request of one verification batch by id and posts the verdicts. Runs on ${model}${offRouter ? ", off the basalt router, so it costs zero lane swaps" : " \u2014 WARNING: a ROUTER entry, which pays the pack swap"}.`,
    `model: "${model}"`,
    "tools: read, grep, glob, bash, ls, fade_verdicts",
    "---",
    "",
    `You are the fade orchestrator's **verification lane** for ONE batch.`,
    routerWarning,
    "You are handed a batch of worker requests, each with an id, an objective, an acceptance line",
    "and check commands. Your job is to judge each of them, exactly once, and post the verdicts.",
    "",
    "- Run every check command yourself, in the session cwd, and judge on what it printed. A check",
    "  you did not run cannot be accepted.",
    "- Inspect the diff for the files a request names. `git status --porcelain`, `git diff`.",
    "- You are READ-ONLY on the tree. Never edit, write, patch, commit, restart a service, touch the",
    "  basalt router (`/v1/load`), or start a long-running process. Report the cause; the coder fixes it.",
    "- Judge ONLY the ids in your batch. Verifying another agent's live slice is the churn this lane",
    "  exists to prevent.",
    "- Post exactly one verdict per id with the `fade_verdicts` tool: `{batch, verdicts:[{id,",
    "  accepted, notes}]}`. In `notes`, name the command and what it printed, or the cause the coder",
    "  must fix. Then print the verdicts verbatim as your final message.",
    "- Data files (parquets, duckdb, `data/`) are read-only. Do not query a locked DuckDB writer.",
    ""
  ].join("\n");
}
var verifierAgentPath = (repo, agent = VERIFIER_AGENT) => `.omp/agents/${agent}.md`;
function routeLine(route) {
  return route.route === "subagent" ? `verification \u2192 ${VERIFIER_AGENT} on ${VERIFIER_MODEL} \xB7 zero lane loads` : `verification \u2192 ${THINK_LANE} lane \xB7 one load (${THINKING[THINK_LANE] ?? "high"} thinking)`;
}

// src/ui.ts
import { hostname as hostname2, userInfo } from "node:os";
var OVERLAY_WIDGET_KEY = "fade-overlay";
var TOP_WIDGET_KEY = "fade-top";
var ORCH_STATUS_KEY = "fade-orch";
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
    return hostname2().length > 1 ? hostname2() : "";
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
function orchGlyph() {
  return process.env.FADE_ORCHESTRATE_GLYPH ?? "\u{F06A9}";
}
function switchGlyph() {
  return process.env.FADE_ORCHESTRATE_SWITCH_GLYPH ?? "\u{F051F}";
}
function chordBytes(key) {
  const k = key.trim().toLowerCase();
  const ctrl = /^ctrl\+([a-z])$/.exec(k);
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  const altShift = /^alt\+shift\+([a-z])$/.exec(k);
  if (altShift) return `\x1B${altShift[1].toUpperCase()}`;
  const alt = /^alt\+([a-z])$/.exec(k);
  if (alt) return `\x1B${alt[1]}`;
  return void 0;
}
function keyLabel(key) {
  return key.trim().toLowerCase().split("+").map((part) => part === "ctrl" ? "Ctrl" : part === "alt" ? "Alt" : part === "shift" ? "Shift" : part.toUpperCase()).join("+");
}
function modelLabel(name) {
  const paren = name.indexOf("(");
  if (paren < 0) return name.trim();
  const base = name.slice(0, paren).trim();
  if (base === "") return name.trim();
  const quant = /(IQ\d+[A-Za-z0-9_]*|Q[0-8]_[A-Za-z0-9]+)/i.exec(name);
  const hw = /\b(dual|tri|quad|single)\b/i.exec(name);
  const bits = [quant ? quant[1] : "", hw ? hw[1].toLowerCase() : ""].filter(Boolean);
  return bits.length > 0 ? `${base} (${bits.join(", ")})` : base;
}
function ramp(text, phase = 0) {
  const chars = [...text];
  if (chars.length === 0) return text;
  const hslRgb = (h, s, l) => {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
  };
  return chars.map((c, i) => {
    const [r, g, b] = hslRgb((i / Math.max(1, chars.length) * 300 + phase * 12) % 360, 0.85, 0.62);
    return `\x1B[38;2;${r};${g};${b}m${c}\x1B[0m`;
  }).join("");
}
function statusLines(run, opts = {}) {
  if (!run) return void 0;
  if (TERMINAL[run.state] === true) return void 0;
  if (opts.owned === false) return void 0;
  const tasks = Array.isArray(run.tasks) ? run.tasks : [];
  const total = tasks.length;
  const passed = tasks.filter((t) => t.status === "passed").length;
  const stall = (run.stall_count ?? 0) > 0 ? ` \xB7 protocol ${run.stall_count}/3` : "";
  const paused = run.paused === true ? " \xB7 paused" : "";
  const glyph = orchGlyph();
  const head = glyph === "" ? "" : `${glyph} `;
  const hint = `[${opts.key ?? "Alt+F"}]`;
  if (opts.swap) {
    const pct = opts.swap.percent != null ? ` ${Math.round(opts.swap.percent)}%` : "";
    const sg = switchGlyph() === "" ? "" : `${switchGlyph()} `;
    const line2 = `${head}Orchestrator: ${sg}switching ${opts.swap.from}\u2192${opts.swap.to}${pct} \xB7 ${hint}${stall}${paused}`;
    return [shown(ramp(line2, opts.swap.percent ?? 0), run)];
  }
  const line = `${head}Orchestrator: ${shortState(run.state)} R${run.round}/${run.max_rounds} \xB7 T${passed}/${total} \xB7 ${hint}${stall}${paused}${opts.suffix ? ` \xB7 ${opts.suffix}` : ""}`;
  if (!opts.flip || opts.flip.flips < 1) return [shown(line, run)];
  const who = opts.flip.competing.length > 0 ? opts.flip.competing.join(", ") : "the other lane";
  return [shown(line, run), shown(`  lane flip: ${opts.flip.flips} swaps in ${opts.flip.window_s}s \u2014 requests naming ${who} (not ${run.lane})`, run)];
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
function shortState(state) {
  return SHORT_STATE[state] ?? state;
}

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
import { join as join3 } from "node:path";
import { appendFile, mkdir as mkdir2, open as open2, rename as rename2, stat } from "node:fs/promises";
var HISTORY_FILENAME = "swap_history.json";
var METRICS_JSONL_FILENAME = "metrics.jsonl";
var HOT_STEADY_TPS = 120;
var MAX_ROWS = 200;
async function readSwaps(dir) {
  const rows = await readJsonAsync(join3(dir, HISTORY_FILENAME));
  return Array.isArray(rows?.rows) ? rows.rows : [];
}
async function appendSwap(dir, row) {
  const rows = await readSwaps(dir);
  rows.unshift(row);
  if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
  await writeJsonAsync(join3(dir, HISTORY_FILENAME), { key: "fade.omp_orchestrate.swaps.v1", rows });
}
function rampClass(decodeTps, mapRestored, threshold = HOT_STEADY_TPS) {
  if (mapRestored) return "map_restored";
  return decodeTps !== void 0 && decodeTps >= threshold ? "hot_steady" : "cold_ramp";
}
function summarizeSwaps(rows, runId) {
  const mine = rows.filter((r) => r.run_id === runId);
  const total = mine.reduce((s, r) => s + (typeof r.elapsed_s === "number" ? r.elapsed_s : 0), 0);
  return { count: mine.length, total_elapsed_s: Math.round(total * 10) / 10 };
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
var LEDGER_MAX_BYTES_DEFAULT = 8388608;
var ledgerMaxBytes = () => {
  const raw = process.env.FADE_ORCHESTRATE_LEDGER_MAX_BYTES;
  if (raw === void 0 || raw === "") return LEDGER_MAX_BYTES_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : LEDGER_MAX_BYTES_DEFAULT;
};
async function appendTurn(dir, rec) {
  await mkdir2(dir, { recursive: true });
  const path = join3(dir, METRICS_JSONL_FILENAME);
  const cap = ledgerMaxBytes();
  if (cap > 0) {
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch {
      size = 0;
    }
    if (size > cap) {
      try {
        await rename2(path, `${path}.1`);
      } catch {
      }
    }
  }
  await appendFile(path, `${JSON.stringify(rec)}
`);
}
var TURN_TAIL_DEFAULT = 500;
var turnTail = () => Math.max(1, Number(process.env.FADE_ORCHESTRATE_TURN_TAIL ?? TURN_TAIL_DEFAULT));
var TURN_RECORD_BYTES = 4096;
async function readTurns(dir, n = turnTail()) {
  const limit = Math.max(1, Math.floor(n));
  let fh;
  try {
    fh = await open2(join3(dir, METRICS_JSONL_FILENAME), "r");
  } catch {
    return [];
  }
  let text = "";
  let partial = false;
  try {
    const size = (await fh.stat()).size;
    if (size === 0) return [];
    const start = Math.max(0, size - limit * TURN_RECORD_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    text = buf.toString("utf8");
    partial = start > 0;
  } finally {
    await fh.close();
  }
  const recs = [];
  const lines = text.split("\n");
  if (partial) lines.shift();
  for (const line of lines) {
    const s = line.trim();
    if (s === "") continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec === "object" && typeof rec.pp === "number" && typeof rec.tg === "number") recs.push(rec);
    } catch {
    }
  }
  return recs.slice(Math.max(0, recs.length - limit));
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
  const laneKey = (v) => typeof v === "string" && v.length > 0 ? v : void 0;
  const eng = mm.engine ?? {};
  const spill = eng.spill ?? mm.spill;
  const bytes = typeof spill?.bytes === "number" ? spill.bytes : void 0;
  const slots = typeof eng.expert_slots === "number" ? eng.expert_slots : mm.expert_slots?.total;
  const liveQueued = mm.live?.queued ?? mm.live?.slots?.queue_depth;
  const lane = laneKey(hh.model) ?? laneKey(eng.model) ?? laneKey(mm.model);
  const quant = [eng.quant, mm.quant].find((q) => typeof q === "string" && q.length > 0 && q !== lane);
  const bestDecode = typeof mm.best?.decode?.tok_s === "number" ? mm.best.decode.tok_s : void 0;
  const snap = {
    quant: typeof quant === "string" ? quant : void 0,
    engine_version: eng.version ?? mm.engine_version,
    slots,
    spill_experts: spill?.experts,
    spill_total: spill?.total ?? eng.expert_total,
    spill_bytes_gb: typeof spill?.bytes_gb === "number" ? spill.bytes_gb : bytes !== void 0 ? bytes / 1e9 : void 0,
    live_state: mm.live?.state,
    live_slots: mm.live?.slots?.active,
    queue: typeof liveQueued === "number" ? liveQueued : Array.isArray(mm.queue) ? mm.queue.length : mm.queue,
    tok_s: mm.live?.tok_s,
    best_decode: bestDecode,
    loaded: lane,
    packLoaded: typeof hh.loaded === "boolean" ? hh.loaded : void 0,
    loading: hh.loading === true,
    percent: typeof hh.percent === "number" ? hh.percent : null,
    requests: Array.isArray(mm.requests) ? mm.requests : void 0,
    at_utc: (/* @__PURE__ */ new Date()).toISOString()
  };
  return snap;
}
function tiersFromMetrics(s) {
  if (!s) return [{ label: "router", value: `${ROUTER} unreachable` }];
  const rates = (s.requests ?? []).map(rateFromRequest).filter((r) => r !== void 0);
  const bestRate = Math.max(s.best_decode ?? -Infinity, ...rates.length > 0 ? rates : [-Infinity]);
  const best = Number.isFinite(bestRate) ? bestRate : void 0;
  return [
    { label: "engine", value: `${s.engine_version ?? "?"}${s.quant ? ` quant ${s.quant}` : ""}` },
    { label: "resident", value: `${s.loaded ?? (s.packLoaded === true ? "pack (lane unnamed)" : "?")}${s.loading ? " (loading)" : ""}${s.percent != null ? ` ${s.percent}%` : ""}` },
    { label: "expert slots", value: `${s.slots ?? "?"} \xB7 spill ${s.spill_experts ?? "?"}/${s.spill_total ?? "?"}${s.spill_bytes_gb !== void 0 ? ` \xB7 ${s.spill_bytes_gb.toFixed(1)} GB` : ""}` },
    { label: "decode now", value: s.tok_s ? `${Math.round(s.tok_s)} tok/s (queue ${s.queue ?? 0}, ${s.live_state ?? "?"})` : "idle" },
    { label: "best recent", value: best !== void 0 ? `${Math.round(best)} tok/s` : "no completed requests" },
    moeCacheRow(s.requests)
  ];
}
function coldHot(tok_s, laneBest) {
  if (tok_s === void 0 || laneBest === void 0 || laneBest <= 0) return { label: "idle" };
  if (tok_s < 0.5) return { label: "idle" };
  return { label: tok_s >= 0.8 * laneBest ? "hot" : "cold", rate: tok_s };
}
function startSwapWatch(to, moe, onSample) {
  const t0 = Date.now();
  const percentPath = [];
  let sawSwap = false;
  let stopped = false;
  const sample = async () => {
    while (!stopped && Date.now() - t0 < 12e4) {
      const h = await fetchJson(`${ROUTER}/health?phase=load:${to.replace(/[^a-z0-9]+/gi, "_")}`, 2e3);
      if (h?.swap) sawSwap = true;
      const pct = typeof h?.percent === "number" ? h.percent : void 0;
      if (pct !== void 0) percentPath.push(pct);
      onSample?.(pct);
      const resident = typeof h?.model === "string" ? h.model : typeof h?.loaded === "string" ? h.loaded : void 0;
      if (resident !== void 0 && resident === to && (h?.loading === false || h?.loaded === true)) break;
      await new Promise((r) => setTimeout(r, 2e3));
    }
    stopped = true;
  };
  void sample();
  return {
    cancel() {
      stopped = true;
    },
    async finish(from, toLane, elapsed_s, dir, runId, taskClass) {
      stopped = true;
      if (!sawSwap && from === toLane) return void 0;
      const m = await fetchJson(`${ROUTER}/metrics`);
      const reqs = (Array.isArray(m?.requests) ? m.requests : []).filter((r) => typeof r.model !== "string" || r.model.replace(":", "") === toLane.replace(":", "")).map((r) => ({ model: r.model, prompt_n: r.prompt_n ?? r.prompt_tokens ?? 0, durations: r.durations ?? [], decode_tok_s: r.decode_tok_s, ttft_s: r.ttft_s })).filter((r) => r.durations.length > 3 || typeof r.decode_tok_s === "number" && r.decode_tok_s > 0).sort((a, b) => a.prompt_n - b.prompt_n);
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
        ...runId ? { run_id: runId } : {},
        ...taskClass ? { task_class: taskClass } : {},
        at: (/* @__PURE__ */ new Date()).toISOString()
      };
      await appendSwap(dir, row);
      return row;
    }
  };
}
function moeCacheRow(requests) {
  const withHit = (requests ?? []).filter((r) => typeof r.hit_rate === "number");
  if (withHit.length === 0) return { label: "prefix cache", value: "no hit_rate reported" };
  const last = withHit[0];
  const n = Math.min(withHit.length, 8);
  const recent = withHit.slice(0, n);
  const mean = recent.reduce((s, r) => s + (r.hit_rate ?? 0), 0) / recent.length;
  const share = (key) => {
    const vals = recent.filter((r) => typeof r[key] === "number").map((r) => r[key]);
    return vals.length === 0 ? `${key === "ssd_share" ? "ssd" : "pcie"} not reported` : `${key === "ssd_share" ? "ssd" : "pcie"} ${(vals.reduce((s, v) => s + v, 0) / vals.length * 100).toFixed(1)}%`;
  };
  return {
    label: "prefix cache",
    value: `${(mean * 100).toFixed(1)}% hit over ${n} req \xB7 last ${((last.hit_rate ?? 0) * 100).toFixed(1)}% (${last.reused ?? 0} tok reused) \xB7 ${share("pcie_share")} \xB7 ${share("ssd_share")}`
  };
}
function laneBestRate(s, lane) {
  const slug = lane.replace(":", "");
  const rates = (s.requests ?? []).filter((r) => typeof r.model !== "string" || r.model.replace(":", "") === slug).map(rateFromRequest).filter((r) => r !== void 0);
  return rates.length > 0 ? Math.max(...rates) : void 0;
}
async function persistMetrics(dir, snap) {
  await writeJsonAsync(join4(dir, METRICS_FILENAME), { key: "fade.omp_orchestrate.metrics.v1", ...snap });
}

// src/moe.ts
import { closeSync as closeSync2, openSync as openSync2, readdirSync, readFileSync as readFileSync2, readSync, statSync } from "node:fs";
import { join as join5, resolve } from "node:path";
var FLASH_NEXT_SAVE_CAPABLE = /flash.?next|qwen/i;
function readServeConfig(path) {
  if (!path) return void 0;
  try {
    const raw = JSON.parse(readFileSync2(path, "utf8"));
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
function engineProof() {
  const out = {};
  try {
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      let cmd;
      try {
        cmd = readFileSync2(join5("/proc", pid, "cmdline"), "utf8");
      } catch {
        continue;
      }
      const flat = cmd.split("\0").join(" ");
      if (!out.engineCmdline && /\/basalt\b/.test(flat) && /--serve/.test(flat) && !/\bpython\b/.test(flat.split(" ")[0] ?? "")) {
        out.engineCmdline = flat;
        out.enginePid = Number(pid);
        out.engineStartEpoch = processStartEpoch(Number(pid));
      }
      if (!out.routerCmdline && /serve\.server/.test(flat)) {
        out.routerCmdline = flat;
        const cfg = /--config[= ](\S+)/.exec(flat)?.[1];
        if (cfg) out.routerConfigPath = cfg;
      }
      if (out.engineCmdline && out.routerCmdline) break;
    }
  } catch {
  }
  return out;
}
var PROOF_TTL_MS = Number(process.env.FADE_ORCHESTRATE_PROOF_TTL_MS ?? 1e4);
var proofCache;
function engineProofCached() {
  const ttl = Number(process.env.FADE_ORCHESTRATE_PROOF_TTL_MS ?? PROOF_TTL_MS);
  if (ttl > 0 && proofCache && Date.now() - proofCache.at < ttl) return proofCache.proof;
  proofCache = { proof: engineProof(), at: Date.now() };
  return proofCache.proof;
}
function engineProofInvalidate() {
  proofCache = void 0;
}
function processStartEpoch(pid) {
  try {
    const stat4 = readFileSync2(`/proc/${pid}/stat`, "utf8");
    const fields = stat4.slice(stat4.lastIndexOf(")") + 2).split(" ");
    const starttime = Number(fields[19]);
    const uptime = Number(readFileSync2("/proc/uptime", "utf8").split(" ")[0]);
    if (!Number.isFinite(starttime) || !Number.isFinite(uptime)) return void 0;
    return Math.floor(Date.now() / 1e3 - (uptime - starttime / 100));
  } catch {
    return void 0;
  }
}
var sameFile = (a, b) => {
  const na = resolve(a);
  const nb = resolve(b);
  return na === nb || na.replace(/\/+$/, "") === nb.replace(/\/+$/, "");
};
function laneMoe(lane, opts = {}) {
  const proof = opts.proof ?? engineProof();
  const configPath = opts.configPath ?? proof.routerConfigPath;
  const configDerived = opts.configPath === void 0 && configPath !== void 0;
  const cfg = readServeConfig(configPath);
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
  const argvLive = opts.liveCmdline !== void 0 && opts.liveCmdline.includes("--expert-profile-save") && opts.liveCmdline.includes(savePath);
  const configIsRunning = configPath !== void 0 && proof.routerConfigPath !== void 0 && sameFile(proof.routerConfigPath, configPath);
  const isLive = opts.liveCmdline !== void 0 ? argvLive : argvLive || configIsRunning;
  let exists = false;
  let age_s;
  let writtenByEngine;
  try {
    const st = statSync(savePath);
    exists = st.isFile();
    age_s = (Date.now() - st.mtimeMs) / 1e3;
    if (proof.engineStartEpoch !== void 0) writtenByEngine = st.mtimeMs / 1e3 >= proof.engineStartEpoch;
  } catch {
    exists = false;
  }
  const note = isLive ? exists && writtenByEngine === false ? "live: the running router serves this config; the profile PREDATES this engine \u2014 placing from it needs the lane (re)load, and the engine rewrites it every expert-profile-save-every minutes" : configDerived ? `live: read from the router's own --config (${configPath}); FADE_ORCHESTRATE_BASALT_CONFIG is unset` : void 0 : `configured, NOT live: the running router serves ${proof.routerConfigPath ?? "no config path (a direct engine launch)"}, not ${configPath ?? "the configured path"} (reload the lane/router to apply)`;
  return {
    lane,
    state: isLive ? "live" : "configured",
    profile_path: savePath,
    profile_exists: exists,
    ...age_s !== void 0 ? { profile_age_s: age_s } : {},
    config_is_running: configIsRunning,
    ...writtenByEngine !== void 0 ? { written_by_running_engine: writtenByEngine } : {},
    ...note !== void 0 ? { note } : {}
  };
}
function moeRows(lanes, opts = {}) {
  const proof = opts.proof ?? engineProofCached();
  return lanes.map((lane) => {
    const m = laneMoe(lane, { ...opts, proof });
    const age = m.profile_age_s !== void 0 ? `${(m.profile_age_s / 3600).toFixed(1)} h old` : "no file";
    const value = m.state === "unsupported" ? "unsupported (Flash-Next only; relearned per swap)" : m.state === "configured" && !m.profile_path ? "not configured (add expert-profile-save, reload lane)" : m.state === "configured" ? `configured, NOT live \xB7 ${m.profile_exists ? age : "no profile yet"}` : `${m.state} \xB7 ${m.profile_exists ? age : "no profile yet"} \xB7 ${m.written_by_running_engine === true ? "written by this engine \xB7 warm start" : m.profile_exists ? "earlier engine's file \xB7 warm on reload" : "nothing learned yet"}`;
    return { label: `MoE ${lane}`, value };
  });
}
var gpuDevices = (gpu) => {
  if (typeof gpu === "string") {
    const cards = gpu.split(/[\s,]+/).filter(Boolean);
    return cards.length ? { verbatim: gpu, devices: cards.length } : void 0;
  }
  if (Array.isArray(gpu)) {
    const cards = gpu.map(String).filter((c) => c !== "" && c !== "undefined" && c !== "null");
    return cards.length ? { verbatim: cards.join(","), devices: cards.length } : void 0;
  }
  if (typeof gpu === "number" && Number.isFinite(gpu)) return { verbatim: String(gpu), devices: 1 };
  return void 0;
};
var reserveClause = (model, devices) => {
  const raw = model["vram-reserve-mib"];
  const vram = typeof raw === "number" ? raw : void 0;
  if (vram === void 0) return "";
  const gib2 = (mib) => `${+(mib / 1024).toFixed(2)} GiB`;
  return `; "vram-reserve-mib": ${vram} is per card \u2014 ${gib2(vram)} on each of the ${devices} cards, ${gib2(vram * devices)} held off the pair, not ${gib2(vram)} total`;
};
var stalePlacementClause = (model, engineStartEpoch) => {
  const savePath = typeof model["expert-profile-save"] === "string" ? String(model["expert-profile-save"]) : void 0;
  if (!savePath) return "";
  const start = engineStartEpoch();
  if (start === void 0) return "";
  let mtime_s;
  try {
    mtime_s = statSync(savePath).mtimeMs / 1e3;
  } catch {
    return "";
  }
  if (mtime_s >= start) return "";
  return `; its profile PREDATES this engine's start, so placement is restored from the PREVIOUS run's map (reload the lane to relearn it)`;
};
var placementBalance = (lane, opts, engineStartEpoch) => {
  const cfg = readServeConfig(opts.configPath);
  if (!cfg) {
    return { lane, verdict: "unknown", note: `no serve config to read${opts.configPath ? ` at ${opts.configPath}` : " (no config path configured)"} \u2014 placement is unjudged` };
  }
  const model = cfg.models[lane];
  if (!model) {
    return { lane, verdict: "unknown", note: `lane "${lane}" is not in ${opts.configPath} \u2014 no "gpu" / "*-reserve-mib" keys to judge` };
  }
  const gpu = gpuDevices(model.gpu);
  if (!gpu) {
    return { lane, verdict: "unknown", note: `the alias carries no "gpu" key (or an empty one): add "gpu": "0,1" to split the expert tier across the cards` };
  }
  const { verbatim, devices } = gpu;
  const health = opts.health;
  if (!health) {
    return { lane, verdict: "unknown", gpu: verbatim, devices, note: `no health reading supplied for ${lane}: spill is unmeasured, so the placement is unjudged` };
  }
  const spill = typeof health.spill_experts === "number" ? health.spill_experts : void 0;
  const reserve = reserveClause(model, devices);
  const spillTotal = health.spill_total;
  if (spill !== void 0 && spill > 0) {
    return {
      lane,
      verdict: "spilled",
      gpu: verbatim,
      devices,
      spill_experts: spill,
      ...spillTotal !== void 0 ? { spill_total: spillTotal } : {},
      note: `${spill}/${spillTotal ?? "?"} experts are on the file tier${health.spill_bytes_gb !== void 0 ? ` (${health.spill_bytes_gb} GB)` : ""} \u2014 experts outside VRAM are PCIe/NVMe reads per generated token, on the generation path; fit the tier to the ${devices} card(s) with "ram-reserve-mib" / "vram-reserve-mib" at the alias and the pack quant, then re-save the profile \u2014 never a bigger pack${reserve}`
    };
  }
  const measured = { ...spill !== void 0 ? { spill_experts: spill } : {}, ...spillTotal !== void 0 ? { spill_total: spillTotal } : {} };
  if (devices === 1) {
    return {
      lane,
      verdict: "single-gpu",
      gpu: verbatim,
      devices,
      ...measured,
      note: `one card carries the whole expert tier and the second is idle for this lane: the alias sets "gpu": "${verbatim}" \u2014 widen it to "gpu": "0,1" so both cards split the tier${reserve}`
    };
  }
  return {
    lane,
    verdict: "balanced",
    gpu: verbatim,
    devices,
    ...measured,
    note: `${devices} cards carry the expert tier ("gpu": "${verbatim}") and ${spill === 0 ? `the health reading shows 0/${spillTotal ?? "?"} experts on the file tier` : "the file tier is UNMEASURED: the router reported no spill line, so nothing here proves the tier fits in VRAM"}${reserve}${stalePlacementClause(model, engineStartEpoch)}`
  };
};
function moeBalanceRows(lanes, opts = {}) {
  const proof = engineProofCached();
  return lanes.map((lane) => {
    const b = placementBalance(lane, { configPath: opts.configPath ?? proof.routerConfigPath, health: opts.healthByLane?.[lane] }, () => proof.engineStartEpoch);
    const tail = b.verdict === "spilled" ? `${b.spill_experts ?? "?"}/${b.spill_total ?? "?"} experts on the file tier` : b.verdict === "single-gpu" ? "second card idle" : b.verdict === "balanced" ? b.spill_experts === void 0 ? "file tier UNMEASURED (router reported no spill line)" : "no file-tier experts" : b.note;
    const value = b.verdict === "unknown" ? `${b.verdict} \xB7 ${b.note}` : `${b.verdict} \xB7 gpu ${b.gpu ?? "?"} \xB7 ${b.devices ?? "?"} devices \xB7 ${tail}`;
    return { label: `MoE balance ${lane}`, value };
  });
}
var PACK_MAGIC = "BASALTMF";
var PACK_HEADER_BYTES = 64;
var PACK_SECTION_BYTES = 128;
var packDrafterCache = /* @__PURE__ */ new Map();
function packDrafter(packPath) {
  if (!packPath) return { kind: "unknown" };
  let key;
  try {
    const st = statSync(packPath);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return { kind: "unknown" };
  }
  const hit = packDrafterCache.get(packPath);
  if (hit && hit.key === key) return hit.drafter;
  let drafter = { kind: "unknown" };
  try {
    const fd = openSync2(packPath, "r");
    try {
      const head = Buffer.alloc(PACK_HEADER_BYTES + 512 * PACK_SECTION_BYTES);
      const nread = readSync(fd, head, 0, head.length, 0);
      if (nread >= PACK_HEADER_BYTES && head.toString("latin1", 0, 8) === PACK_MAGIC) {
        const n = Math.min(head.readUInt32LE(12), 511);
        let dspark;
        let mtpBytes = 0;
        for (let i = 0; i < n; i++) {
          const base = PACK_HEADER_BYTES + i * PACK_SECTION_BYTES;
          if (base + 80 > nread) break;
          const name = head.toString("latin1", base, base + 64).replace(/\0.*$/, "");
          const bytes = Number(head.readBigUInt64LE(base + 72));
          if (name === "dspark/gguf" && bytes > 0) dspark = bytes;
          else if (name.startsWith("mtp/") && bytes > 0) mtpBytes += bytes;
        }
        drafter = dspark !== void 0 ? { kind: "dspark", bytes: dspark } : mtpBytes > 0 ? { kind: "mtp", bytes: mtpBytes } : { kind: "none" };
      }
    } finally {
      closeSync2(fd);
    }
  } catch {
    drafter = { kind: "unknown" };
  }
  packDrafterCache.set(packPath, { key, drafter });
  return drafter;
}
var gib = (bytes) => bytes === void 0 ? "?" : `${+(bytes / 2 ** 30).toFixed(2)} GiB`;
function drafterRow(lanes, opts = {}) {
  const proof = opts.proof ?? engineProofCached();
  const cfg = readServeConfig(opts.configPath ?? proof.routerConfigPath);
  const segments = lanes.map((lane) => {
    const model = cfg?.models?.[lane];
    const packPath = typeof model?.model === "string" ? String(model.model) : void 0;
    const pack = packDrafter(packPath);
    const spec = model?.spec;
    const experts = model?.["draft-experts"];
    const what = pack.kind === "dspark" ? `DSpark ${gib(pack.bytes)} pack` : pack.kind === "mtp" ? `MTP ${gib(pack.bytes)} pack` : pack.kind === "none" ? "no drafter in pack" : "pack not read";
    const knobs = [
      typeof spec === "number" ? `win \u2264${spec}` : "spec engine-default",
      typeof experts === "number" ? `${experts}/stage` : "draft-experts default"
    ].join(" \xB7 ");
    return `${lane} ${what} \xB7 ${knobs}`;
  });
  return { label: "MoE drafter", value: segments.length > 0 ? segments.join("; ") : "no lanes" };
}

// src/taskmoe.ts
var TASK_CLASSES = ["ci", "tests", "docs", "code"];
var PIPELINE = /\bci\b|\bworkflows?\b|pipeline|\bgh run\b|\.github\/workflows/i;
var RUNNER = /node --test|\bnpm (?:--no-install )?(?:run )?test\b|\brig\b|node test\//i;
var PROSE = /\bREADME\b|\bdocs?\b|documentation/i;
function classOf(task) {
  const files = Array.isArray(task.files) ? task.files : [];
  const text = `${task.objective ?? ""} ${task.acceptance ?? ""} ${files.join(" ")}`;
  if (PIPELINE.test(text)) return "ci";
  if (RUNNER.test(task.acceptance ?? "") || files.some((f) => f.endsWith(".test.mjs"))) return "tests";
  if (files.length > 0 && files.every((f) => f.endsWith(".md")) || PROSE.test(task.objective ?? "")) return "docs";
  return "code";
}
function classWarmth(swaps) {
  return TASK_CLASSES.map((cls) => {
    const rows = swaps.filter((r) => r.task_class === cls);
    const warm = rows.filter((r) => r.moe?.state === "live" && r.moe.written_by_running_engine === true && r.moe.profile_exists === true).length;
    const newest = rows.find((r) => typeof r.moe?.profile_path === "string");
    return { cls, swaps: rows.length, warm, ...newest?.moe?.profile_path ? { profile: newest.moe.profile_path } : {} };
  });
}
function versionLine(engineVersion, pkgVersion, bundleHash) {
  const engine = engineVersion ? `engine ${engineVersion}` : "engine version not reported";
  const ext = pkgVersion ? `ext ${pkgVersion}` : "ext version not read";
  const bundle = bundleHash ? `bundle ${bundleHash.slice(0, 8)}` : "bundle not built";
  return `${engine} \xB7 ${ext} \xB7 ${bundle}`;
}

// src/screendata.ts
var SCREEN_TURNS = 12;
var SCREEN_SWAPS = 6;
function compactNumber(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}
function sparkline(values) {
  const BARS = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
  const nums = values.filter((v) => Number.isFinite(v) && v > 0);
  if (nums.length < 2) return "";
  const max = Math.max(...nums);
  if (max <= 0) return "";
  return nums.map((v) => {
    const i = Math.min(BARS.length - 1, Math.floor(v / max * (BARS.length - 1)));
    return BARS[i] ?? "\u2581";
  }).join("");
}
function laneRows(src, metrics) {
  const resident = metrics?.loaded;
  const spec = [
    { lane: src.lanes.think, role: "think" },
    { lane: src.lanes.code, role: "code" }
  ];
  return spec.map((s) => ({
    lane: s.lane,
    role: s.role,
    model: s.lane,
    resident: resident !== void 0 && resident === s.lane
  }));
}
function turnRows(turns) {
  if (turns.length === 0) return [];
  const rows = [];
  const spark = sparkline(turns.map((t) => t.tg));
  if (spark !== "") rows.push({ label: "tok/s by turn", value: spark, tone: "dim" });
  for (const t of turns.slice(-4).reverse()) {
    const bits = [`pp ${compactNumber(t.pp)}`, `tg ${t.tg}`, ...t.ttft !== void 0 ? [`ttft ${t.ttft.toFixed(2)}s`] : [], ...t.kv_hit_pct !== void 0 ? [`kv ${t.kv_hit_pct}%`] : [], `swap ${Math.round(t.swap_ms / 100) / 10}s`];
    rows.push({ label: `#${t.turn} R${t.round}${t.phase ? ` ${t.phase}` : ""}`, value: bits.join(" \xB7 ") });
  }
  return rows;
}
function swapRows(swaps) {
  return swaps.slice(0, SCREEN_SWAPS).map((s) => {
    const ramp2 = s.ramp === "map_restored" ? "MoE restored" : s.ramp === "hot_steady" ? "hot steady" : s.ramp === "cold_ramp" ? "cold ramp" : "ramp ?";
    return {
      label: `${s.from} \u2192 ${s.to}`,
      value: `${s.elapsed_s.toFixed(1)}s \xB7 ${Math.round(s.first_tg)}\u2192${Math.round(s.steady_tg)} tok/s \xB7 ${ramp2} \xB7 ${clockOf(s.at)}`
    };
  });
}
function swapSummaryRow(swaps, runId) {
  const { count, total_elapsed_s } = summarizeSwaps(swaps, runId);
  if (count > 0) return { label: "swaps this run", value: `${count} \xB7 ${total_elapsed_s.toFixed(1)}s paid`, tone: "ok" };
  return { label: "swaps this run", value: swaps.length === 0 ? "0 \xB7 no swaps measured" : "0 \xB7 older runs only", tone: "dim" };
}
function gateRows(gate) {
  if (!gate) return [{ label: "gate", value: "no gate run this round", tone: "dim" }];
  const bad = gate.results.filter((r) => !r.ok);
  const asExpected = gate.results.filter((r) => r.as_expected);
  const rows = [
    {
      label: "gate",
      value: `${gate.passed ? "GREEN" : "RED"} ${bad.length}/${gate.results.length} failing${asExpected.length ? ` \xB7 ${asExpected.length} as expected` : ""} \xB7 ${clockOf(gate.at)}`,
      tone: gate.passed ? "ok" : "bad"
    }
  ];
  for (const f of bad) rows.push({ label: "  red", value: `${f.cmd} \u2192 ${f.expected}`, tone: "bad" });
  for (const a of asExpected) rows.push({ label: "  ok*", value: `${a.cmd} \u2192 ${a.expected}`, tone: "dim" });
  return rows;
}
function clockOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad2 = (n) => `${n}`.padStart(2, "0");
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function elapsedSince(startedUtc, now) {
  if (!startedUtc) return void 0;
  const t = new Date(startedUtc).getTime();
  if (Number.isNaN(t)) return void 0;
  return Math.max(0, Math.round((now.getTime() - t) / 1e3));
}
function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m${`${Math.round(seconds % 60)}`.padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${`${m % 60}`.padStart(2, "0")}m`;
}
function nameResidentRow(tiers, metrics, names) {
  const loaded = typeof metrics?.loaded === "string" ? metrics.loaded : void 0;
  if (!loaded) return tiers;
  const label2 = modelLabel(names?.[loaded] ?? loaded);
  const state = metrics?.loading === true ? " loading" : "";
  return tiers.map((r) => r.label === "resident" ? { ...r, value: `${label2}${state}`.trim() } : r);
}
async function collectScreen(src) {
  const now = (src.now ?? (() => /* @__PURE__ */ new Date()))();
  const [metrics, swaps, turns] = await Promise.all([
    src.metrics ?? fetchMetrics(),
    src.swaps ?? readSwaps(src.runDir),
    src.turns ?? readTurns(src.runDir, SCREEN_TURNS)
  ]);
  const moe = [
    ...moeRows([src.lanes.think, src.lanes.code], { configPath: src.moeConfigPath }),
    // GPU placement: the serve config names each alias's `gpu` and reserves, so the row exists for
    // BOTH lanes; the file-tier spill is only measurable on the RESIDENT engine, so the other
    // lane's row says spill is unmeasured rather than claiming zero.
    ...moeBalanceRows([src.lanes.think, src.lanes.code], {
      configPath: src.moeConfigPath,
      healthByLane: metrics?.loaded ? { [metrics.loaded]: { spill_experts: metrics.spill_experts, spill_total: metrics.spill_total, spill_bytes_gb: metrics.spill_bytes_gb, slots: metrics.slots } } : {}
    }),
    // What drafts each lane: the pack's own drafter section (DSpark / MTP) and the config's
    // knobs. One row for both lanes — the drafter is a load-time fact, not a tuning lever.
    drafterRow([src.lanes.think, src.lanes.code], { configPath: src.moeConfigPath })
  ];
  const classes = classWarmth(swaps).map((c) => ({
    label: `MoE class ${c.cls}`,
    value: c.swaps === 0 ? "no swap ran this class" : `${c.warm}/${c.swaps} warm \xB7 ${c.profile ?? "profile not named"}`,
    ...c.swaps === 0 ? { tone: "dim" } : c.warm === 0 ? { tone: "warn" } : { tone: "ok" }
  }));
  const tiers = [...nameResidentRow(tiersFromMetrics(metrics), metrics, src.names), claimRow(src)];
  const missing = [];
  if (!metrics) missing.push(`router ${ROUTER} unreachable \u2014 engine, decode and queue are not measured`);
  if (swaps.length === 0) missing.push("no swaps recorded");
  if (turns.length === 0) missing.push("no turn telemetry (the router reported no pp/tg)");
  const elapsed_s = elapsedSince(src.run.started_utc, now);
  if (elapsed_s === void 0) missing.push("no run start in the state file");
  const context = src.context && typeof src.context.tokens === "number" && src.context.percent !== null ? { tokens: src.context.tokens, window: src.context.contextWindow, percent: src.context.percent } : void 0;
  if (!context) missing.push("no context meter");
  let critique;
  const phases = Array.isArray(src.run.phases) ? src.run.phases : [];
  for (let i = phases.length - 1; i >= 0; i--) {
    const p = phases[i];
    if (p?.phase === "verification_done" && typeof p.notes === "string") {
      critique = p.notes;
      break;
    }
  }
  return {
    run: src.run,
    refreshed_utc: now.toISOString(),
    elapsed_s,
    lanes: laneRows(src, metrics),
    tiers,
    moe,
    classes,
    turns,
    swaps,
    context,
    gate: src.run.gate_last,
    critique,
    flip: src.flip,
    claim: src.claim ?? null,
    missing
  };
}
function claimRow(src) {
  if (src.claim === void 0) return { label: "router claim", value: "not measured" };
  if (src.claim === null) return { label: "router claim", value: "free \u2014 no run holds this router" };
  const started = Number.isFinite(Date.parse(src.claim.started)) ? Date.parse(src.claim.started) : NaN;
  const held = Number.isFinite(started) ? ` \xB7 held ${formatElapsed(Math.max(0, ((src.now?.() ?? /* @__PURE__ */ new Date()).getTime() - started) / 1e3))}` : "";
  return src.claim.run_id === src.run.run_id ? { label: "router claim", value: `this run (pid ${src.claim.pid})${held}` } : { label: "router claim", value: `HELD BY pid ${src.claim.pid}: run ${src.claim.run_id} in ${src.claim.repo} on ${src.claim.host}${held}` };
}

// src/panel.ts
var PANEL_REFRESH_MS = Math.max(500, Number(process.env.FADE_ORCHESTRATE_PANEL_REFRESH_MS ?? 2e3));
var WIDGET_WIDTH = 110;
var TWO_COLUMN_MIN_WIDTH = 100;
var STATUS_GLYPH = {
  passed: "\u2713",
  failed: "\u2717",
  blocked: "\u2298",
  pending: "\xB7",
  started: "\u2026"
};
var TONE = { ok: "success", warn: "warning", bad: "error", dim: "dim" };
function visibleWidth(s) {
  return [...s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, "")].length;
}
function fit(s, width) {
  if (width <= 0) return "";
  if (visibleWidth(s) <= width) return s;
  const plain = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  return `${[...plain].slice(0, Math.max(0, width - 1)).join("")}\u2026`;
}
function pad(s, width) {
  const w = visibleWidth(s);
  return w >= width ? s : `${s}${" ".repeat(width - w)}`;
}
var KEY_BAR = ["[\u2191\u2193/j-k] select", "[PgUp/PgDn] scroll", "[s] skip selected", "[v] verify", "[r] reset", "[p] pause", "[c] code", "[h] halt", "[esc] close"];
function keyBarLines(width) {
  if (width <= 1) return [""];
  const lines = [];
  let line = "";
  for (const item of KEY_BAR) {
    const candidate = line.length === 0 ? item : `${line}  ${item}`;
    if (visibleWidth(candidate) > width) {
      if (line.length > 0) lines.push(line);
      line = visibleWidth(item) > width ? fit(item, width) : item;
    } else {
      line = candidate;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [""];
}
function label(theme, text, color = "accent") {
  return theme ? theme.fg(color, theme.bold ? theme.bold(text) : text) : text;
}
function metricLines(rows, theme, width, maxLabel = 18) {
  const labelW = Math.min(maxLabel, Math.max(6, Math.max(...rows.map((r) => visibleWidth(r.label)), 1) + 1));
  return rows.map((r) => {
    const value = fit(r.value, Math.max(4, width - labelW));
    const l = theme && r.tone ? theme.fg(TONE[r.tone] ?? "text", r.label) : r.label;
    return `  ${pad(fit(l, labelW - 1), labelW)} ${value}`;
  });
}
var arr = (v) => Array.isArray(v) ? v : [];
function taskBlock(d, view, theme, width) {
  const run = d.run;
  const tasks = arr(run.tasks);
  const repair = arr(run.repair_tasks);
  const repairing = repair.length > 0;
  const lines = [];
  const taskRows = [];
  const total = tasks.length;
  const passed = tasks.filter((t) => t.status === "passed").length;
  lines.push(label(theme, `TASKS ${passed}/${total} passed${repairing ? " \xB7 repair queue active" : ""}`));
  tasks.forEach((t, i) => {
    const sel = i === view.sel;
    const glyph = STATUS_GLYPH[t.status ?? "pending"] ?? "\xB7";
    const inRepair = repairing && repair.some((r) => r.id === t.id);
    const head = `${sel ? "\u25B6" : " "} ${glyph} ${t.id}${inRepair ? " (repair)" : ""}`;
    const tone = t.status === "passed" ? "success" : t.status === "failed" || t.status === "blocked" ? "error" : inRepair ? "warning" : "text";
    const row = `${pad(fit(head, 18), 18)} ${fit(t.objective, Math.max(4, width - 19))}`;
    taskRows[i] = lines.length;
    lines.push(theme ? theme.fg(tone, row) : row);
    if (!sel) return;
    const meta = `files: ${(t.files ?? []).join(", ") || "-"} \xB7 deps: ${(t.dependencies ?? []).length ? (t.dependencies ?? []).join(",") : "-"} \xB7 round ${t.round ?? 1}`;
    lines.push(`    ${fit(meta, Math.max(4, width - 4))}`);
    lines.push(`    acceptance: ${fit(t.acceptance, Math.max(4, width - 16))}`);
    if (t.result) lines.push(`    result: ${fit(t.result, Math.max(4, width - 11))}`);
    const tag = run.checkpoints?.[t.id];
    if (tag) lines.push(`    tag: ${tag}`);
  });
  if (tasks.length === 0) lines.push("  (no plan yet: the loop is still planning)");
  return { lines, taskRows };
}
function phaseBlock(d, theme, width) {
  const phases = arr(d.run.phases).slice(-6);
  const lines = [label(theme, "PHASES")];
  if (phases.length === 0) return [...lines, "  (none accepted yet)"];
  for (const p of phases) {
    const row = `  R${p.round} ${p.phase}${p.accepted ? "" : " REFUSED"}  ${p.lane}  ${clockOf(p.at)}`;
    lines.push(fit(row, width));
  }
  return lines;
}
function metricBlock(d, theme, width) {
  const rows = [...d.tiers, ...d.moe, ...d.classes ?? []];
  if (d.context) rows.push({ label: "context", value: `${compactNumber(d.context.tokens)} / ${compactNumber(d.context.window)} (${d.context.percent.toFixed(1)}%)` });
  rows.push(...gateRows(d.gate));
  rows.push(...turnRows(d.turns));
  return [label(theme, "ENGINE / ROUTER"), ...metricLines(rows, theme, width)];
}
function swapBlock(d, theme, width) {
  const rows = swapRows(d.swaps);
  const lines = [label(theme, "LANE SWAPS")];
  const summary = metricLines([swapSummaryRow(d.swaps, d.run.run_id)], theme, width);
  if (rows.length === 0) return [...lines, ...summary, "  (no swaps recorded yet)"];
  return [...lines, ...summary, ...metricLines(rows, theme, width, 22)];
}
function tailBlocks(d, theme, width) {
  const lines = [];
  lines.push(label(theme, "LAST VERIFIER CRITIQUE"));
  lines.push(...d.critique ? d.critique.split("\n").map((l) => `  ${fit(l, Math.max(4, width - 2))}`) : ["  (none this round)"]);
  const rej = (d.run.rejection_history ?? []).slice(-5);
  if (rej.length > 0) {
    lines.push(label(theme, "RECENT REJECTIONS (do not repeat)", "warning"));
    for (const r of rej) lines.push(fit(`  R${r.round} [${r.kind}]${r.task_id ? ` ${r.task_id}:` : ""} ${r.reason}`, width));
  }
  if (d.flip && d.flip.flips > 0) {
    lines.push(label(theme, "LANE FLIP (not the loop's)", "warning"));
    lines.push(fit(`  ${d.flip.flips} swaps in ${d.flip.window_s}s \u2014 requests naming ${d.flip.competing.join(", ") || "the other lane"}`, width));
  }
  if (d.missing.length > 0) {
    lines.push(label(theme, "NOT MEASURED", "dim"));
    for (const m of d.missing) lines.push(fit(`  ${m}`, width));
  }
  return lines;
}
function headerBlock(d, theme, width) {
  const run = d.run;
  const resident = d.lanes.find((l) => l.resident);
  const head = `fade-orchestrator ${run.run_id} \xB7 ${shortState(run.state)} \xB7 round ${run.round}/${run.max_rounds}${run.tier ? ` \xB7 tier ${run.tier}` : ""}${d.elapsed_s !== void 0 ? ` \xB7 ${formatElapsed(d.elapsed_s)}` : ""} \xB7 ${d.refreshed_utc.slice(11, 19)}Z`;
  const lines = [label(theme, fit(head, width))];
  lines.push(fit(`goal: ${run.goal}`, width));
  if (run.paused === true) {
    lines.push(theme ? theme.fg("warning", fit(`paused: the loop is stopped for manual edits${run.operator_note ? ` \xB7 note: ${run.operator_note}` : ""}`, width)) : fit(`paused: the loop is stopped for manual edits${run.operator_note ? ` \xB7 note: ${run.operator_note}` : ""}`, width));
  }
  if (run.state === "stalled_protocol_error") {
    lines.push(theme ? theme.fg("error", fit(`PROTOCOL STALL: the lane ended ${run.stall_count ?? 3} turns in a row without a fade_phase call; the run is halted and NO lane was loaded \u2014 [c] resume on the code lane, [r] reset the round`, width)) : fit(`PROTOCOL STALL: the lane ended ${run.stall_count ?? 3} turns in a row without a fade_phase call; the run is halted and NO lane was loaded \u2014 [c] resume on the code lane, [r] reset the round`, width));
  }
  const laneRow = d.lanes.map((l) => `${l.model}=${l.role}${l.resident ? " \u25C6resident" : ""}`).join(" \xB7 ");
  lines.push(fit(`lanes: ${laneRow}`, width));
  if ((run.protocol_retries ?? 0) > 0) {
    lines.push(fit(`protocol: ${run.protocol_retries} turn(s) ended without fade_phase \xB7 consecutive stalls ${run.stall_count ?? 0}/3${run.synthesized ? ` \xB7 auto-synthesized ${run.synthesized.phase} at round ${run.synthesized.round}` : ""}`, width));
  }
  return lines;
}
function panelLines(d, width, view = { sel: 0 }, theme) {
  const w = Math.max(40, Math.floor(width));
  const inner = w - 4;
  const header = headerBlock(d, theme, inner);
  const tasks = taskBlock(d, { sel: Math.max(0, Math.min(view.sel, Math.max(0, arr(d.run.tasks).length - 1))) }, theme, inner);
  const phases = phaseBlock(d, theme, inner);
  const metrics = metricBlock(d, theme, inner);
  const swaps = swapBlock(d, theme, inner);
  const tail = tailBlocks(d, theme, inner);
  const left = [...tasks.lines, "", ...phases];
  const lines = [];
  const row = (text) => `\u2502 ${pad(fit(text, inner), inner)} \u2502`;
  lines.push(`\u250C${"\u2500".repeat(w - 2)}\u2510`);
  for (const h of header) lines.push(row(h));
  lines.push(`\u251C${"\u2500".repeat(w - 2)}\u2524`);
  const taskRowOffset = lines.length;
  if (w >= TWO_COLUMN_MIN_WIDTH) {
    const leftW = Math.max(40, Math.floor((w - 4) * 0.56));
    const rightW = w - 4 - leftW - 2;
    const right = metrics;
    const rows = Math.max(left.length, right.length);
    for (let i = 0; i < rows; i++) {
      const l = pad(fit(left[i] ?? "", leftW), leftW);
      const r = fit(right[i] ?? "", rightW);
      lines.push(`\u2502 ${l}  ${r}${" ".repeat(Math.max(0, rightW - visibleWidth(r)))} \u2502`);
    }
  } else {
    for (const l of left) lines.push(row(l));
    lines.push(row(""));
    for (const m of metrics) lines.push(row(m));
  }
  lines.push(`\u251C${"\u2500".repeat(w - 2)}\u2524`);
  for (const s of swaps) lines.push(row(s));
  for (const t of tail) lines.push(row(t));
  lines.push(`\u251C${"\u2500".repeat(w - 2)}\u2524`);
  for (const k of keyBarLines(inner)) lines.push(row(k));
  lines.push(`\u2514${"\u2500".repeat(w - 2)}\u2518`);
  const taskRows = tasks.taskRows.map((i) => taskRowOffset + i);
  const out = lines.map((l) => redact(l, redactOn(), d.run.repo));
  return { lines: out, taskRows };
}
var KITTY_CSI_U = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
var MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;
function isEscape(data) {
  if (data === "\x1B") return true;
  const kitty = KITTY_CSI_U.exec(data);
  if (kitty) {
    return Number(kitty[1]) === 27 && (kitty[4] === void 0 ? 1 : Number(kitty[4])) === 1 && (kitty[5] === void 0 ? 1 : Number(kitty[5])) !== 3;
  }
  const mok = MODIFY_OTHER_KEYS.exec(data);
  if (mok) return Number(mok[2]) === 27 && Number(mok[1]) === 1;
  return false;
}
var CLOSE_KEYS = { q: true, "": true };
var ACTION_KEYS = { s: true, v: true, r: true, p: true, c: true, h: true };
var PanelComponent = class {
  data;
  provider;
  theme;
  tui;
  done;
  sel = 0;
  offset = 0;
  timer;
  rendering = false;
  body = [];
  taskRows = [];
  /** The next render must bring the SELECTED task on screen (j/k and a refresh set it; g/G/PgUp/PgDn clear it). */
  follow = true;
  constructor(data, provider, theme, tui, done, refreshMs = PANEL_REFRESH_MS) {
    this.data = data;
    this.provider = provider;
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    this.timer = setInterval(() => void this.refresh(), refreshMs);
    this.timer.unref?.();
  }
  /** The provider is the router read; never let a slow tick overlap the next one. */
  async refresh() {
    if (this.rendering) return;
    this.rendering = true;
    try {
      const next = await this.provider();
      if (next.run.run_id === this.data.run.run_id) this.data = next;
      this.follow = true;
      this.tui.requestRender();
    } catch {
    } finally {
      this.rendering = false;
    }
  }
  invalidate() {
    this.body = [];
  }
  getHeight() {
    return Math.max(8, (this.tui.terminal.rows || 24) - 2);
  }
  render(width) {
    const r = panelLines(this.data, width, { sel: this.sel }, this.theme);
    this.body = r.lines;
    this.taskRows = r.taskRows;
    const h = this.getHeight();
    const row = this.taskRows[this.sel];
    if (this.follow && row !== void 0) {
      if (row < this.offset) this.offset = row;
      else if (row >= this.offset + h) this.offset = row - h + 1;
    }
    this.follow = false;
    const maxOffset = Math.max(0, this.body.length - h);
    if (this.offset > maxOffset) this.offset = maxOffset;
    return this.body.slice(this.offset, this.offset + h);
  }
  handleInput(data) {
    const all = arr(this.data.run.tasks);
    const tasks = all.length;
    const h = this.getHeight();
    if (isEscape(data) || CLOSE_KEYS[data] === true) return this.done(JSON.stringify({ key: "close" }));
    if (ACTION_KEYS[data] === true) {
      const t = all[this.sel];
      return this.done(JSON.stringify({ key: data, ...t ? { taskId: t.id } : {} }));
    }
    if (data === "j" || data === "\x1B[B") {
      this.sel = Math.min(Math.max(0, tasks - 1), this.sel + 1);
      this.follow = true;
      return;
    }
    if (data === "k" || data === "\x1B[A") {
      this.sel = Math.max(0, this.sel - 1);
      this.follow = true;
      return;
    }
    if (data === "\x1B[6~") this.offset = Math.min(Math.max(0, this.body.length - h), this.offset + h);
    else if (data === "\x1B[5~") this.offset = Math.max(0, this.offset - h);
    else if (data === "G") this.offset = Math.max(0, this.body.length - h);
    else if (data === "g") this.offset = 0;
  }
  dispose() {
    if (this.timer !== void 0) clearInterval(this.timer);
    this.timer = void 0;
  }
};
async function openPanel(ctx, provider, onAction, headless = process.env.FADE_ORCHESTRATE_HEADLESS === "1") {
  const initial = await provider();
  if (ctx.hasUI !== true || headless) {
    ctx.ui.setWidget(OVERLAY_WIDGET_KEY, panelLines(initial, WIDGET_WIDTH, { sel: 0 }).lines, { placement: "aboveEditor" });
    return;
  }
  const raw = await ctx.ui.custom(
    (tui, theme, _kb, done) => new PanelComponent(initial, provider, theme, tui, done),
    {
      overlay: true,
      // Near-full-screen, like the host's own panels; a function so a resize re-resolves.
      overlayOptions: () => ({ width: "96%", maxHeight: "94%", anchor: "top-center", margin: { top: 1, left: 1, right: 1, bottom: 1 } })
    }
  );
  if (!raw) return;
  let action;
  try {
    action = JSON.parse(raw);
  } catch {
    action = void 0;
  }
  if (action && action.key !== "close" && onAction) onAction(action);
}

// src/runs.ts
import { join as join6 } from "node:path";
import { readdir, stat as stat2 } from "node:fs/promises";
var RUNS_DIRNAME = "runs";
var runsDir = (dir) => join6(dir, RUNS_DIRNAME);
var runArchivePath = (dir, runId) => join6(runsDir(dir), `${runId}.json`);
async function archiveRun(dir, state) {
  if (TERMINAL[state.state] !== true) return void 0;
  const path = runArchivePath(dir, state.run_id);
  try {
    await stat2(path);
    return void 0;
  } catch {
  }
  await writeJsonAsync(path, { ...state, ended_utc: (/* @__PURE__ */ new Date()).toISOString() });
  return path;
}
var stampOf = (r) => {
  const t = Date.parse(r.ended_utc ?? r.started_utc ?? "");
  return Number.isFinite(t) ? t : 0;
};
async function listRuns(dir) {
  const shelf = runsDir(dir);
  let names;
  try {
    names = await readdir(shelf);
  } catch {
    return [];
  }
  const summaries = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const rec = await readJsonAsync(join6(shelf, name));
    if (typeof rec?.goal !== "string") continue;
    const tasks = Array.isArray(rec.tasks) ? rec.tasks : [];
    const runId = typeof rec.run_id === "string" ? rec.run_id : name.replace(/\.json$/, "");
    summaries.push({
      run_id: runId,
      state: typeof rec.state === "string" ? rec.state : "unknown",
      goal: rec.goal,
      ...typeof rec.started_utc === "string" ? { started_utc: rec.started_utc } : {},
      ...typeof rec.ended_utc === "string" ? { ended_utc: rec.ended_utc } : {},
      rounds: typeof rec.round === "number" ? rec.round : 0,
      tasks_total: tasks.length,
      tasks_passed: tasks.filter((t) => t?.status === "passed").length
    });
  }
  summaries.sort((a, b) => stampOf(b) - stampOf(a));
  return summaries;
}

// src/index.ts
var GATE_POLL_MS = Number(process.env.FADE_ORCHESTRATE_GATE_POLL_MS ?? 3e3);
var GATE_BUDGET_MS = Number(process.env.FADE_ORCHESTRATE_GATE_BUDGET_MS ?? 6e4);
var FADE_KEY = process.env.FADE_ORCHESTRATE_KEY ?? "alt+f";
var FASTPATH_LINES = Number(process.env.FADE_ORCHESTRATE_FASTPATH_LINES ?? 15);
var FASTPATH_FILES = Number(process.env.FADE_ORCHESTRATE_FASTPATH_FILES ?? 1);
var SURFACE = process.env.FADE_ORCHESTRATE_SURFACE === "status" ? "status" : "widget";
var MUTATING_TOOLS = { edit: true, write: true, apply_patch: true, multiedit: true, multi_edit: true, notebook_edit: true };
var MAIN_SESSION_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;
var isDelegatedSession = () => {
  const f = process.env.PI_SESSION_FILE ?? "";
  if (f === "") return false;
  const parent = basename(dirname(f));
  return MAIN_SESSION_DIR.test(parent) && !f.endsWith(`${parent}.jsonl`);
};
var hostAgent = (ctx) => {
  const c = ctx !== null && typeof ctx === "object" && !Array.isArray(ctx) ? ctx : void 0;
  const a = c?.agent;
  const rec = a !== null && a !== void 0 && typeof a === "object" && !Array.isArray(a) ? a : void 0;
  if (!rec) return void 0;
  return { kind: typeof rec.kind === "string" ? rec.kind : "", name: typeof rec.name === "string" ? rec.name : "" };
};
var isWorkerSession = (ctx) => hostAgent(ctx)?.kind === "sub" || isDelegatedSession();
var workerName = (ctx) => hostAgent(ctx)?.name || basename(process.env.PI_SESSION_FILE ?? "").replace(/\.jsonl$/, "") || "worker";
var deskDirFor = (ctx) => join7(ctx.cwd, "var", "omp-orchestrate");
function fadeOrchestrate(pi) {
  let run;
  let runDir;
  let lockDir;
  let pending;
  let deskBatch;
  let deskAnnounced = -1;
  let deskBriefing = false;
  let settledNotified = false;
  let metrics;
  let laneBest = 0;
  let metricsTimer;
  let inputUnsub;
  let panelOpen = false;
  let conflictReported = false;
  let chordResolved = false;
  let probeHasAnswered = false;
  let turnSeq = 0;
  let turnPhase;
  let turnSwapMs = 0;
  let verifierTools;
  let flipBadge;
  let swapPill;
  const refreshMetrics = async () => {
    const s = await fetchMetrics();
    if (!s) return;
    metrics = s;
    if (runDir) await persistMetrics(runDir, s);
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
    if (rec) await appendTurn(runDir, rec);
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
    try {
      const active = pi.getActiveTools();
      if (active.includes("fade_phase")) return true;
      await pi.setActiveTools([...active, "fade_phase"]);
      return true;
    } catch {
      return false;
    }
  };
  const statePath = () => runDir ? join7(runDir, STATE_FILENAME) : "<unset>";
  let publishedAtUs = 0;
  const syncFromDisk = async () => {
    if (!run || !runDir) return false;
    let mtimeUs = 0;
    try {
      mtimeUs = Math.round((await stat3(statePath())).mtimeMs * 1e3);
    } catch {
      return false;
    }
    if (publishedAtUs === 0 || mtimeUs <= publishedAtUs) return false;
    const live = await liveState();
    if (!live || live.run_id !== run.run_id) return false;
    const checks = refreshChecks(run, live);
    const root = await refreshRoot(run, live);
    if (!checks.changed && !root.changed) return false;
    (run.phases ??= []).push({
      phase: "disk_repair",
      lane: run.lane,
      accepted: true,
      round: run.round,
      at: (/* @__PURE__ */ new Date()).toISOString(),
      notes: `adopted from disk: checks ${checks.to} rows${checks.added.length ? ` (+${checks.added.join(",")})` : ""}${checks.removed.length ? ` (-${checks.removed.length})` : ""}${checks.redrafted ? ` redrafted ${checks.redrafted}` : ""}${root.changed ? `; repo -> ${root.to}` : root.refused ? `; repo refused: ${root.refused}` : ""}`
    });
    return true;
  };
  const persist = async () => {
    if (!run || !runDir) return;
    await syncFromDisk();
    await coalesceWrite(statePath(), run);
    try {
      publishedAtUs = Math.round((await stat3(statePath())).mtimeMs * 1e3);
    } catch {
      publishedAtUs = 0;
    }
  };
  let lastWriteWarn = "";
  const warnWrite = (ctx, what) => (e) => {
    const msg2 = `${what}: ${e instanceof Error ? e.message : String(e)}`;
    if (msg2 === lastWriteWarn) return;
    lastWriteWarn = msg2;
    ctx.ui.notify(`orchestrate: the state write failed \u2014 ${msg2}`, "warning");
  };
  const releaseLock = () => {
    if (!lockDir) return;
    releaseInstanceLock(lockDir);
    lockDir = void 0;
  };
  let liveCache;
  const liveState = async () => {
    if (!runDir) return void 0;
    const path = join7(runDir, STATE_FILENAME);
    try {
      const s = await stat3(path);
      const key = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
      if (liveCache && liveCache.key === key) return liveCache.state;
      const state = parseJson(await readFile2(path, "utf8"));
      liveCache = { key, state };
      return state;
    } catch {
      liveCache = void 0;
      return void 0;
    }
  };
  const gateChecks = async (ctx) => {
    if (!run) return;
    const live = await liveState();
    const r = refreshChecks(run, live);
    if (r.changed) ctx.ui.notify(`orchestrate: the pre-swap gate re-read the checks from ${statePath()} \u2014 ${r.removed.length} replaced, ${r.added.length} added, ${r.redrafted} re-declared, ${r.to} total`, "info");
    const root = await refreshRoot(run, live);
    if (root.changed) ctx.ui.notify(`orchestrate: the pre-swap gate re-rooted the run \u2014 ${root.to} (was ${root.from})`, "info");
    if (root.refused) ctx.ui.notify(`orchestrate: ${statePath()} asked to re-root the run \u2014 refused: ${root.refused}`, "warning");
    if (r.changed || root.changed) await persist();
  };
  const runGateLogged = async (checks, repo, ctx) => {
    const t0 = Date.now();
    const gate = await runGate(checks, repo, (row) => ctx.ui.setWorkingMessage(`fade_orchestrate: gate ${row.index}/${row.total}: ${row.cmd}`));
    ctx.ui.setWorkingMessage();
    const s = ((Date.now() - t0) / 1e3).toFixed(1);
    const failing = gate.results.filter((r) => !r.ok);
    const unmeasured = gate.results.filter((r) => r.budget === true).length;
    ctx.ui.notify(
      `fade_orchestrate: gate ${gate.passed ? "GREEN" : `RED ${failing.length}/${gate.results.length}`} in ${s}s${failing.length > 0 ? ` \u2014 ${failing.map((f) => f.cmd).join(" | ")}` : ""}${unmeasured > 0 ? ` \u2014 ${unmeasured} row(s) NEVER RAN (gate total budget)` : ""}`,
      gate.passed ? "info" : "warning"
    );
    return gate;
  };
  const fastPathDiff = async (repo) => {
    try {
      const [numstat, untracked] = await Promise.all([
        execGitAsync(repo, ["diff", "--numstat", "HEAD"]),
        execGitAsync(repo, ["ls-files", "--others", "--exclude-standard"])
      ]);
      let lines = 0;
      let files = 0;
      for (const row of numstat.split("\n")) {
        if (row.trim() === "") continue;
        const [add, del] = row.split("	");
        files += 1;
        lines += (add === "-" ? 0 : Number(add) || 0) + (del === "-" ? 0 : Number(del) || 0);
      }
      files += untracked.split("\n").filter((s) => s.trim() !== "").length;
      return { files, lines };
    } catch {
      return { files: -1, lines: -1 };
    }
  };
  let statusWritten = false;
  const clearSurface = (ctx) => {
    ctx.ui.setWidget(TOP_WIDGET_KEY, void 0, { placement: "aboveEditor" });
    if (statusWritten) {
      statusWritten = false;
      ctx.ui.setStatus(ORCH_STATUS_KEY, void 0);
    }
  };
  const paint = (ctx) => {
    if (!run) {
      clearSurface(ctx);
      ctx.ui.setWidget(OVERLAY_WIDGET_KEY, void 0);
      return;
    }
    const lines = statusLines(run, { suffix: pillSuffix(), flip: flipBadge, owned: !isDelegatedSession(), swap: swapPill, key: keyLabel(DELIVERED_KEY) });
    if (!lines) {
      clearSurface(ctx);
      return;
    }
    if (SURFACE === "status") {
      statusWritten = true;
      ctx.ui.setStatus(ORCH_STATUS_KEY, lines.map((l) => l.trim()).join(" \xB7 "));
    } else ctx.ui.setWidget(TOP_WIDGET_KEY, lines, { placement: "aboveEditor" });
  };
  const fail = (ctx, reason) => {
    if (run) {
      run.state = "failed";
      run.reason = reason;
      releaseLock();
      void persist().catch(warnWrite(ctx, "fail"));
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
  let switchGen = 0;
  let switchChain = Promise.resolve();
  const requestLane = (lane, ctx) => {
    const gen = ++switchGen;
    switchChain = switchChain.then(() => gen === switchGen ? runSwitch(lane, ctx, gen) : void 0).catch(() => void 0);
  };
  const dispatchDeskBatch = async (ctx) => {
    if (!run || !runDir || TERMINAL[run.state] === true) return false;
    const desk = await readDesk(runDir, run.run_id);
    if (!desk) return false;
    const live = openRequests(desk);
    if (live.length === 0) return false;
    const ready = readyToAddress(desk, Date.now(), { settleMs: DESK_SETTLE_MS, deadlineMs: DESK_DEADLINE_MS });
    if (!ready.ready) {
      if (deskAnnounced !== desk.epoch) {
        deskAnnounced = desk.epoch;
        ctx.ui.notify(`orchestrate: the verification desk holds ${ready.open} request(s) \u2014 ${ready.reason}; no lane is loaded until the batch closes`, "info");
      }
      return false;
    }
    await observeSwaps();
    const route = routeFor(desk, flipState(run.lane, FLIP_WINDOW_MS));
    const claimed = claimBatch(desk, route.route);
    const requests = desk.requests.filter((r) => claimed.ids.includes(r.id));
    deskBatch = { batch: claimed.batch, ids: claimed.ids, routed: route.route };
    run.verify_batch = { batch: claimed.batch, ids: claimed.ids, routed: route.route, at: (/* @__PURE__ */ new Date()).toISOString() };
    pushRejection(run, "task", `verification batch ${claimed.batch + 1} (${claimed.ids.join(", ")}) addressed AT ONCE, routed ${route.route}: ${route.reason}`);
    if (route.route === "subagent") {
      await writeJsonAsync(deskPath(runDir), setChurn(claimed.desk, true));
      await persist();
      paint(ctx);
      ctx.ui.notify(`orchestrate: verification batch ${claimed.batch + 1} \xB7 ${claimed.ids.length} worker request(s) \u2192 ${routeLine(route)}`, "warning");
      await ensurePhaseTool();
      pi.sendUserMessage(verifierDirective(claimed.batch, claimed.ids, route.reason, requests));
      return true;
    }
    await writeJsonAsync(deskPath(runDir), claimed.desk);
    run.state = "verifying";
    pending = { lane: THINK_LANE, phase: "verification_batch" };
    deskBriefing = true;
    settledNotified = false;
    await persist();
    paint(ctx);
    ctx.ui.notify(`orchestrate: ${deskLine(desk)} \u2014 one ${THINK_LANE} load answers the whole batch`, "info");
    requestLane(THINK_LANE, ctx);
    return true;
  };
  const runSwitch = async (lane, ctx, gen) => {
    const model = ctx.modelRegistry.find(PROVIDER, lane);
    if (!model) {
      fail(ctx, `model ${PROVIDER}/${lane} is not in the registry`);
      return;
    }
    const gate = await gateRouterIdle(lane, ctx);
    if (gate.over_budget && run) {
      pushRejection(run, "task", `the ${lane} load was paid after the idle gate ran its full ${Math.round(GATE_BUDGET_MS / 1e3)}s: ${gate.polls} polls, ${gate.last.reason}`);
      await persist();
    }
    await observeSwaps();
    const flip = flipState(run?.lane ?? lane, FLIP_WINDOW_MS);
    if (flipBreaker(flip)) {
      const who = flip.competing.join(", ") || "the other lane";
      if (run) {
        run.paused = true;
        run.operator_note = `lane thrash: ${flip.flips} swaps in ${flip.window_s}s naming ${who}; the loop is HALTED and paid no ${lane} load \u2014 /orchestrate lanes reset clears the ledger and lands it`;
        pushRejection(run, "task", `LANE THRASH: ${flip.flips} swaps in ${flip.window_s}s naming ${who}; ${lane} refused, loop halted, ZERO load paid`);
        pending = { lane, phase: turnPhase ?? "lane" };
      }
      if (run && runDir) {
        const d = await readDesk(runDir, run.run_id);
        if (d) {
          const churned = setChurn(d, true);
          const live = openRequests(churned);
          if (live.length > 0) {
            const claimed = claimBatch(churned, "subagent");
            deskBatch = { batch: claimed.batch, ids: claimed.ids, routed: "subagent" };
            run.verify_batch = { batch: claimed.batch, ids: claimed.ids, routed: "subagent", at: (/* @__PURE__ */ new Date()).toISOString() };
            await writeJsonAsync(deskPath(runDir), claimed.desk);
            pushRejection(run, "task", `LANE THRASH routed verification batch ${claimed.batch + 1} (${claimed.ids.join(", ")}) to the ${VERIFIER_AGENT} subagent on ${VERIFIER_MODEL}: zero lane loads paid`);
            await ensurePhaseTool();
            pi.sendUserMessage(verifierDirective(claimed.batch, claimed.ids, `lane thrash: ${flip.flips} swaps in ${flip.window_s}s naming ${who}; the loop is HALTED and pays no load, so this batch is answered off the router`, churned.requests.filter((r) => claimed.ids.includes(r.id))));
          } else {
            await writeJsonAsync(deskPath(runDir), churned);
          }
        }
      }
      await persist();
      paint(ctx);
      ctx.ui.notify(`orchestrate: LANE THRASH \u2014 ${flip.flips} swaps in ${flip.window_s}s naming ${who}: the loop is HALTED and paid no load. /orchestrate lanes reset clears the ledger and lands ${lane}.`, "error");
      return;
    }
    const switched = await pi.setModel(model);
    if (gen !== switchGen) return;
    if (switched !== true && switched?.switched !== true) {
      fail(ctx, `setModel(${PROVIDER}/${lane}) did not switch: ${JSON.stringify(switched)}`);
      return;
    }
    pi.setThinkingLevel(THINKING[lane]);
    const from = run?.lane ?? "";
    swapPill = { from, to: modelLabel(model.name ?? lane) };
    paint(ctx);
    engineProofInvalidate();
    const moe = laneMoe(lane, { configPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG });
    const watch = startSwapWatch(lane, moe, (percent) => {
      if (gen !== switchGen || !swapPill) return;
      swapPill = { ...swapPill, percent };
      paint(ctx);
    });
    ctx.ui.setWorkingMessage(`fade_orchestrate: loading ${lane} on the router\u2026`);
    const loaded = await loadLane(lane);
    if (gen !== switchGen) {
      watch.cancel();
      return;
    }
    ctx.ui.setWorkingMessage();
    swapPill = void 0;
    if (!loaded.ok) {
      watch.cancel();
      fail(ctx, `loading lane ${lane} failed (${loaded.detail}); briefing not sent`);
      return;
    }
    if (from && runDir && from !== lane) {
      turnSwapMs += Math.round(loaded.elapsed_s * 1e3);
      void watch.finish(from, lane, loaded.elapsed_s, runDir, run?.run_id, windowClass(run)).then(() => paint(ctx));
    }
    if (run) run.lane = lane;
    await persist();
    paint(ctx);
    await applyToolPolicy(lane);
    if (gen !== switchGen) return;
    setTimeout(async () => {
      if (gen !== switchGen) return;
      await ensurePhaseTool();
      const owed = deskBriefing && lane === THINK_LANE && run?.verify_batch;
      deskBriefing = false;
      if (owed && runDir && run) {
        const st = run;
        const ids = st.verify_batch?.ids ?? [];
        const d = await readDesk(runDir, st.run_id);
        if (d) {
          pi.sendUserMessage(
            briefings.verifyBatch(st, {
              batch: st.verify_batch?.batch ?? d.epoch,
              ids,
              routed: st.verify_batch?.routed ?? "swap",
              requests: d.requests.filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id, agent: r.agent, ...r.task_id ? { task_id: r.task_id } : {}, objective: r.objective, ...r.acceptance ? { acceptance: r.acceptance } : {}, checks: r.checks }))
            })
          );
          return;
        }
      }
      const text = await (run.state === "repair" ? briefings.repair(run) : lane === CODE_LANE && run.gate_last && run.gate_last.passed === false ? briefings.gate(run) : lane === CODE_LANE ? briefings.code(run) : briefings.verify(run));
      pi.sendUserMessage(text);
    }, 0);
  };
  const panelProvider = (ctx) => {
    if (!run || !runDir) return void 0;
    const state = run;
    const dir = runDir;
    return async () => {
      const s = await fetchMetrics();
      if (s) {
        metrics = s;
        void persistMetrics(dir, s).catch(warnWrite(ctx, "metrics tick"));
      }
      return collectScreen({
        run: state,
        runDir: dir,
        lanes: { think: THINK_LANE, code: CODE_LANE },
        names: { [THINK_LANE]: ctx.modelRegistry.find(PROVIDER, THINK_LANE)?.name, [CODE_LANE]: ctx.modelRegistry.find(PROVIDER, CODE_LANE)?.name },
        context: ctx.getContextUsage(),
        metrics,
        flip: flipBadge,
        // The panel names who holds the router. `readInstanceLock` is a 400-byte read of the
        // claim file, and `null` (absent/parsable-free) is a real answer, not a missing row.
        claim: readInstanceLock(instanceLockDir(ROUTER)) ?? null,
        ...process.env.FADE_ORCHESTRATE_BASALT_CONFIG ? { moeConfigPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG } : {}
      });
    };
  };
  const packageVersion = async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const p of [join7(here, "..", "package.json"), join7(here, "package.json")]) {
      try {
        const raw = JSON.parse(await readFile2(p, "utf8"));
        if (raw && typeof raw === "object" && "version" in raw && typeof raw.version === "string" && raw.version !== "") return raw.version;
      } catch {
      }
    }
    return void 0;
  };
  const bundleHash = async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const p of [join7(here, "index.js"), join7(here, "..", "dist", "index.js")]) {
      try {
        return createHash("sha256").update(await readFile2(p)).digest("hex");
      } catch {
      }
    }
    return void 0;
  };
  const windowClass = (r) => {
    if (!r) return void 0;
    const w = roundWindow(r);
    const t = w.readyNow[0] ?? w.open[0] ?? (r.tasks ?? [])[0];
    return t ? classOf(t) : void 0;
  };
  const actOnPanel = (ctx, a) => {
    if (!run) return;
    const dir = a.key === "s" ? actSkip(run, a.taskId) : a.key === "v" ? actVerify(run) : a.key === "r" ? actReset(run) : a.key === "p" ? actPause(run) : a.key === "c" ? actCode(run) : a.key === "h" ? actHalt(run) : void 0;
    if (!dir) return;
    void persist().catch(warnWrite(ctx, "panel key"));
    paint(ctx);
    ctx.ui.notify(`orchestrate: ${dir.note}`, "info");
    if (!run.paused && pending) {
      const deferred = pending;
      pending = void 0;
      requestLane(deferred.lane, ctx);
    }
    if (dir.next) requestLane(dir.next, ctx);
  };
  const showPanel = async (ctx) => {
    const provider = panelProvider(ctx);
    if (!provider) {
      ctx.ui.notify("orchestrate: no run active", "info");
      return;
    }
    try {
      await openPanel(ctx, provider, (a) => actOnPanel(ctx, a), process.env.FADE_ORCHESTRATE_HEADLESS === "1");
    } catch (e) {
      const where = e instanceof Error && typeof e.stack === "string" ? ` @ ${e.stack.split("\n").slice(1, 4).map((l) => l.trim()).join(" | ")}` : "";
      ctx.ui.notify(`orchestrate: panel failed: ${String(e instanceof Error ? e.message : e)}${where}`, "error");
    }
  };
  let conflictProbe;
  try {
    conflictProbe = Reflect.get(pi, "getShortcutConflict");
  } catch {
    conflictProbe = void 0;
  }
  const hostConflict = (key) => {
    if (typeof conflictProbe !== "function") return void 0;
    try {
      const answer = conflictProbe.call(pi, key);
      probeHasAnswered = true;
      return answer;
    } catch {
      return void 0;
    }
  };
  const CHORD = chordBytes(FADE_KEY);
  const FALLBACK_KEY = process.env.FADE_ORCHESTRATE_FALLBACK_KEY ?? "alt+shift+i";
  const RAW_DELIVERABLE = CHORD !== void 0 && CHORD.startsWith("\x1B");
  const DELIVERED_KEY = RAW_DELIVERABLE ? FADE_KEY : FALLBACK_KEY;
  const openPanelGuarded = async (ctx) => {
    if (panelOpen) return;
    panelOpen = true;
    try {
      await showPanel(ctx);
    } finally {
      panelOpen = false;
    }
  };
  const HOST_HELD_CHORDS = {
    "ctrl+c": true,
    "ctrl+d": true,
    "ctrl+g": true,
    "ctrl+l": true,
    "ctrl+o": true,
    "ctrl+r": true,
    "ctrl+s": true,
    "ctrl+t": true,
    "ctrl+y": true,
    "ctrl+z": true,
    "ctrl+.": true,
    "alt+a": true,
    "alt+b": true,
    "alt+d": true,
    "alt+f": true,
    "alt+g": true,
    "alt+h": true,
    "alt+i": true,
    "alt+k": true,
    "alt+l": true,
    "alt+m": true,
    "alt+n": true,
    "alt+o": true,
    "alt+p": true,
    "alt+r": true,
    "alt+y": true,
    "alt+shift+c": true,
    "alt+shift+k": true,
    "alt+shift+l": true,
    "alt+shift+p": true,
    "alt+shift+v": true
  };
  const resolveChord = () => {
    if (!CHORD || chordResolved || RAW_DELIVERABLE) return void 0;
    const conflict = hostConflict(FADE_KEY);
    const owner = conflict?.keybindings?.[0] ?? conflict?.owner;
    const held = conflict !== void 0 || !probeHasAnswered && HOST_HELD_CHORDS[FADE_KEY] === true;
    chordResolved = true;
    if (conflictReported) return void 0;
    conflictReported = true;
    if (!held) return void 0;
    const who = conflict ? `${conflict.kind}${owner ? ` ${owner}` : ""}` : "its key table";
    return `the host binds ${keyLabel(FADE_KEY)} (${who}): the screen opens on ${keyLabel(FALLBACK_KEY)} (FADE_ORCHESTRATE_KEY picks a chord the probe reports FREE)`;
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
      st.max_rounds = roundsForTasks(st.tasks, st.max_rounds);
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
          verification_done: /* @__PURE__ */ new Set(["verdict", "checks", "notes", "tasks", "verdicts"])
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
          if (payload.verdicts !== void 0) {
            const open3 = run.verify_batch;
            if (!open3) throw new Error(`fade_phase: "verdicts" is the verification DESK's fan-out, and no batch is claimed for this run (the desk names its ids in your briefing) \u2014 drop the key`);
            if (!Array.isArray(payload.verdicts) || payload.verdicts.length === 0) throw new Error("fade_phase: verdicts must be a non-empty array of {id, accepted, notes} \u2014 one row per id of the claimed batch");
            const ids = new Set(open3.ids);
            const rows = payload.verdicts;
            for (const row of rows) {
              if (typeof row.id !== "string" || !ids.has(row.id)) throw new Error(`fade_phase: verdicts row ${JSON.stringify(row.id)} is not an id of claimed batch ${open3.batch + 1} (${open3.ids.join(", ")})`);
              if (typeof row.accepted !== "boolean") throw new Error(`fade_phase: verdicts row ${row.id} needs a boolean "accepted"`);
              if (typeof row.notes !== "string" || row.notes.trim() === "") throw new Error(`fade_phase: verdicts row ${row.id} needs "notes" naming the command run and what it printed, or the cause to fix`);
            }
            const silent = open3.ids.filter((id) => !rows.some((row) => row.id === id));
            if (silent.length > 0) throw new Error(`fade_phase: claimed batch ${open3.batch + 1} is answered by EVERY id \u2014 ${silent.join(", ")} has no verdict row, and a request with no verdict leaves its worker parked in fade_verify`);
          }
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
          await persist();
          throw new Error(run.schema_retries >= 2 ? `${text}
${SCHEMA_HINT}` : text);
        }
        throw new Error(text);
      }
      const applied = applyPhase(params.phase, payload);
      turnPhase = params.phase;
      let verdictNote = "";
      const claimed = run.verify_batch;
      if (params.phase === "verification_done" && claimed && runDir) {
        const st3 = run;
        const rows = Array.isArray(payload.verdicts) ? payload.verdicts : [];
        const aggregate = String(payload.verdict) === "accepted";
        const fan = rows.length > 0 ? rows.map((r) => ({ id: String(r.id), accepted: r.accepted === true, notes: String(r.notes) })) : claimed.ids.map((id) => ({ id, accepted: aggregate, notes: typeof payload.notes === "string" ? payload.notes : `round verdict: ${String(payload.verdict)}` }));
        await mutateDesk(runDir, st3.run_id, (d) => attachVerdicts(d, fan).desk);
        st3.verify_batch = void 0;
        deskBatch = void 0;
        verdictNote = `; desk batch ${claimed.batch + 1} answered for ${fan.length} worker request(s) (${fan.filter((f) => f.accepted).length} accepted)`;
      }
      classifyTurnEnd(run, true);
      if (applied.nextState === "complete" || applied.nextState === "failed") releaseLock();
      let checkpointNote = "";
      if (params.phase === "verification_done" && applied.nextState === "complete") {
        const st = run;
        const tags = await Promise.all(st.tasks.filter((t) => t.status === "passed").map((t) => tagCheckpoint(st.repo, st, t.id)));
        const ok = tags.filter((t) => t.ok).map((t) => t.tag);
        if (ok.length > 0) checkpointNote = `; checkpoints ${ok.join(", ")}`;
        const refused = tags.filter((t) => !t.ok);
        if (refused.length > 0) checkpointNote += `; checkpoint FAILED ${refused.map((t) => `${t.tag}: ${t.error}`).join(", ")}`;
      }
      if (params.phase === "coding_done" && applied.nextState === "verifying" && run.checks.length > 0) {
        await gateChecks(ctx);
        const gate = await runGateLogged(run.checks, run.repo, ctx);
        run.gate_last = gate;
        if (!gate.passed) {
          const failing = gate.results.filter((r) => !r.ok);
          pushRejection(run, "task", `pre-swap gate red: ${failing.map((f) => f.cmd).join(" | ")}`);
          run.state = "coding";
          await persist();
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
      if (params.phase === "coding_done" && applied.nextState === "verifying" && run.gate_last?.passed === true) {
        const st2 = run;
        const firstTry = !(st2.rejection_history ?? []).some((r) => r.round === st2.round && (r.kind === "task" || r.kind === "verification"));
        const allPassed = st2.tasks.length > 0 && st2.tasks.every((t) => t.status === "passed");
        const diff = firstTry && allPassed ? await fastPathDiff(st2.repo) : void 0;
        if (diff && diff.files >= 1 && diff.files <= FASTPATH_FILES && diff.lines < FASTPATH_LINES) {
          st2.phases.push({ phase: "verification_done", lane: st2.lane, accepted: true, round: st2.round, at: (/* @__PURE__ */ new Date()).toISOString(), notes: `fast path: ${diff.files} file(s), ${diff.lines} changed lines < ${FASTPATH_LINES}, gate green on the first try \u2014 the verifier swap was not paid` });
          st2.state = "complete";
          const tags2 = await Promise.all(st2.tasks.filter((t) => t.status === "passed").map((t) => tagCheckpoint(st2.repo, st2, t.id)));
          const ok2 = tags2.filter((t) => t.ok).map((t) => t.tag);
          const refused2 = tags2.filter((t) => !t.ok);
          checkpointNote = ok2.length > 0 ? `; checkpoints ${ok2.join(", ")}` : "";
          if (refused2.length > 0) checkpointNote += `; checkpoint FAILED ${refused2.map((t) => `${t.tag}: ${t.error}`).join(", ")}`;
          turnPhase = "verification_done";
          await persist();
          paint(ctx);
          pending = void 0;
          settledNotified = false;
          ctx.abort();
          return {
            content: [{ type: "text", text: `fast path: gate green on the first try, ${diff.lines} changed lines in ${diff.files} file(s) under the ${FASTPATH_LINES}-line threshold; the run is complete on the ${st2.lane} lane and the verifier swap was not paid${checkpointNote}` }],
            details: { phase: "coding_done", state: "complete", fast_path: true, files: diff.files, lines: diff.lines, threshold_lines: FASTPATH_LINES, threshold_files: FASTPATH_FILES, next_lane: null, checkpoints: st2.checkpoints ?? {} }
          };
        }
      }
      await persist();
      paint(ctx);
      pending = applied.nextState === "failed" || applied.nextState === "complete" ? void 0 : { lane: applied.next, phase: params.phase };
      settledNotified = false;
      ctx.abort();
      return {
        content: [{ type: "text", text: `phase ${params.phase} recorded; state ${applied.nextState}${checkpointNote}${verdictNote}${pending ? `, ${pending.lane} loads at the turn boundary` : "; run terminal, lane left resident"}` }],
        details: { phase: params.phase, state: applied.nextState, next_lane: pending?.lane ?? null, checkpoints: run.checkpoints ?? {} }
      };
    }
  });
  pi.registerTool({
    name: "fade_verify",
    label: "fade verify",
    description: "Register THIS session's verification request with the run's verification desk, then wait for the batched verdict. The orchestrator answers every request of one batch in a SINGLE verification pass and never loads a lane per arrival, so a worker that finishes early waits for its peers by design. Call it ONCE per slice: a second call for the same objective returns the same request. params: objective (what must be judged), acceptance (the command that proves it and what it must print), checks [[cmd, expected]], task_id.",
    parameters: Type.Object({
      objective: Type.String({ description: "what must be judged, in one sentence" }),
      acceptance: Type.Optional(Type.String({ description: "one command and what it must print" })),
      checks: Type.Optional(Type.Array(Type.Any(), { description: '[["cmd","expected"]] rows the verifier must run; {"cmd","expected"} objects are accepted too' })),
      task_id: Type.Optional(Type.String({ description: "the run task this slice belongs to, when one was named" }))
    }),
    // @ts-expect-error loadMode is accepted at runtime (essential = shipped in the catalog).
    loadMode: "essential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const objective = String(params.objective ?? "").trim();
      if (objective === "") throw new Error('fade_verify: "objective" is the thing to judge \u2014 name it in one sentence');
      const dir = deskDirFor(ctx);
      const state = await readJsonAsync(join7(dir, STATE_FILENAME));
      const active = await readJsonAsync(join7(dir, ACTIVE_FILENAME));
      const runId = typeof state?.run_id === "string" ? state.run_id : typeof active?.run_id === "string" ? active.run_id : void 0;
      if (!runId) throw new Error(`fade_verify: ${dir} carries no orchestrated run (no state.json), so there is no desk to register against \u2014 nothing was written`);
      const rows = Array.isArray(params.checks) ? params.checks : [];
      const agent = isWorkerSession(ctx) ? workerName(ctx) : "owner";
      let captured;
      const after = await mutateDesk(dir, runId, (d) => {
        const enq = enqueueRequest(d, {
          agent,
          session: process.env.PI_SESSION_FILE ?? "",
          ...typeof params.task_id === "string" && params.task_id.trim() !== "" ? { task_id: params.task_id.trim() } : {},
          objective,
          ...typeof params.acceptance === "string" && params.acceptance.trim() !== "" ? { acceptance: params.acceptance.trim() } : {},
          checks: rows
        });
        captured = { request: enq.request, deduped: enq.deduped };
        return enq.desk;
      });
      const request = captured?.request;
      if (!request) throw new Error(`fade_verify: the desk at ${dir} did not accept the registration (concurrent writers exhausted the retry budget); nothing was queued`);
      const ready = readyToAddress(after, Date.now());
      const queue = `request ${request.id} of batch ${after.epoch + 1} \xB7 ${ready.open} registered, ${ready.expected > 0 ? `${ready.registered}/${ready.expected} of the launching task call` : "the launching task call named no count"}`;
      if (agent === "owner") {
        return {
          content: [{ type: "text", text: `${queue}. Registered; NOT blocked here \u2014 this session dispatches the batch, so blocking it would stall the pass. The batch is answered at the turn boundary when it closes (${ready.reason}). Do not call fade_verify twice for this slice.` }],
          details: { desk: { run_id: runId, id: request.id, batch: after.epoch + 1, deduped: captured?.deduped === true, ready: ready.ready, reason: ready.reason, owner: true } }
        };
      }
      const wait = await awaitVerdict(dir, runId, request.id, { timeoutMs: DESK_WAIT_MS, signal });
      if (wait.state === "answered") {
        const v = wait.request?.verdict;
        return {
          content: [{ type: "text", text: `${request.id} ${v?.accepted === true ? "ACCEPTED" : "NEEDS REPAIR"} after ${Math.round(wait.waited_ms / 1e3)}s in the batched pass: ${v?.notes ?? "no notes posted"}` }],
          details: { desk: { run_id: runId, id: request.id, batch: after.epoch + 1, state: "answered", accepted: v?.accepted === true, notes: v?.notes, polls: wait.polls, waited_ms: wait.waited_ms } }
        };
      }
      throw new Error(`${queue} \xB7 ${wait.state}: ${wait.note}`);
    }
  });
  pi.registerTool({
    name: "fade_verdicts",
    label: "fade verdicts",
    description: 'Post the verdicts of ONE claimed verification batch, by id. Call ONCE per batch \u2014 the write unblocks every worker parked in fade_verify. batch is the batch number the briefing names; verdicts is [{"id","accepted","notes"}] with one row per id of that batch, and `notes` naming the command run and what it printed (or the cause to fix).',
    parameters: Type.Object({
      batch: Type.Number({ description: "the batch number from the briefing (the number after `batch`)" }),
      verdicts: Type.Array(Type.Object({ id: Type.String({ description: "the request id, e.g. V2.1" }), accepted: Type.Boolean(), notes: Type.String({ description: "the command run and what it printed, or the cause to fix" }) }))
    }),
    // @ts-expect-error loadMode is accepted at runtime (essential = shipped in the catalog).
    loadMode: "essential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const dir = deskDirFor(ctx);
      const state = await readJsonAsync(join7(dir, STATE_FILENAME));
      const active = await readJsonAsync(join7(dir, ACTIVE_FILENAME));
      const runId = typeof state?.run_id === "string" ? state.run_id : typeof active?.run_id === "string" ? active.run_id : void 0;
      if (!runId) throw new Error(`fade_verdicts: ${dir} carries no orchestrated run, so there is no desk to answer`);
      const label2 = Number(params.batch);
      const epoch = label2 - 1;
      const rows = Array.isArray(params.verdicts) ? params.verdicts : [];
      if (rows.length === 0) throw new Error("fade_verdicts: verdicts[] is empty \u2014 a batch is answered by one row per id, never by silence");
      const desk = await readDesk(dir, runId);
      if (!desk) throw new Error(`fade_verdicts: no desk file at ${dir} yet \u2014 nothing has been claimed, so nothing can be answered`);
      const claim = desk.addressed.find((a) => a.batch === epoch);
      if (!claim) {
        throw new Error(
          `fade_verdicts: batch ${label2} was never claimed by the desk${desk.addressed.length > 0 ? ` (claimed: ${desk.addressed.map((a) => `batch ${a.batch + 1} [${a.ids.join(",")}]`).join(" \xB7 ")})` : " (nothing has been claimed)"}; batch ${desk.epoch + 1} is the OPEN one, still being COLLECTED, and answering it early is the double pass this gate exists to stop`
        );
      }
      const want = new Set(claim.ids);
      const strays = rows.map((r) => String(r.id)).filter((id) => !want.has(id));
      if (strays.length > 0) throw new Error(`fade_verdicts: ${strays.join(", ")} ${strays.length === 1 ? "is" : "are"} not part of batch ${label2} (its ids: ${claim.ids.join(", ")}) \u2014 judge only your batch`);
      const missing = claim.ids.filter((id) => !rows.some((r) => String(r.id) === id));
      const verdicts = rows.map((r) => ({ id: String(r.id), accepted: r.accepted === true, notes: typeof r.notes === "string" ? r.notes : "no notes" }));
      const res = await mutateDesk(dir, runId, (d) => attachVerdicts(d, verdicts).desk);
      const accepted = verdicts.filter((v) => v.accepted).length;
      return {
        content: [{ type: "text", text: `batch ${label2} answered: ${accepted} accepted, ${verdicts.length - accepted} needs_repair; ${verdicts.length} worker${verdicts.length === 1 ? "" : "s"} unblocked${missing.length > 0 ? `; STILL UNANSWERED in this batch: ${missing.join(", ")} \u2014 an id you did not judge is a defect, not a pass` : ""}` }],
        details: { desk: { run_id: runId, batch: label2, attached: res.requests.filter((r) => verdicts.some((v) => v.id === r.id)).length, missing, routed: claim.routed, churn: desk.churn } }
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
  const registerChord = (key, description) => {
    try {
      pi.registerShortcut(key, {
        description,
        handler: async (ctx) => {
          await openPanelGuarded(ctx);
        }
      });
    } catch {
    }
  };
  registerChord(FADE_KEY, `fade orchestrator panel: tasks, phases, engine metrics, swap history (s/v/r/p/c/h) [${keyLabel(FADE_KEY)}]`);
  if (!hostConflict(FALLBACK_KEY)) {
    registerChord(FALLBACK_KEY, "fade orchestrator panel: tasks, phases, engine metrics, swap history (s/v/r/p/c/h)");
  }
  pi.registerCommand("orchestrate", {
    description: `One session, two basalt lanes: ${THINK_LANE} plans/verifies, ${CODE_LANE} codes. /orchestrate [--rounds N] [--demo-redact] <goal> | status | overlay | runs | moe | desk | verifier [install] | skip [Tn] | verify | reset | lanes reset | pause [note] | code | halt | stop [--clear]`,
    handler: async (args, ctx) => {
      let raw = args.trim();
      const demo = /(?:^|\s)--demo-redact(?:=(on|off|1|0))?(?=\s|$)/.exec(raw);
      if (demo) {
        const off = demo[1] === "off" || demo[1] === "0";
        if (off) delete process.env.FADE_ORCHESTRATE_REDACT;
        else process.env.FADE_ORCHESTRATE_REDACT = "1";
        raw = raw.replace(demo[0], " ").replace(/\s+/g, " ").trim();
        paint(ctx);
        ctx.ui.notify(`orchestrate: demo redaction ${off ? "OFF" : "ON"} \u2014 the row, pill and panel mask the account, host, home and repo path (display only)`, "info");
        if (raw === "") return;
      }
      const first = raw.split(/\s+/)[0] ?? "";
      if (first === "status") {
        if (!run) {
          ctx.ui.notify("orchestrate: no run active", "info");
          return;
        }
        const done = run.tasks.filter((t) => t.status === "passed").length;
        const claim2 = readInstanceLock(instanceLockDir(ROUTER));
        const started = claim2 && Number.isFinite(Date.parse(claim2.started)) ? Date.parse(claim2.started) : NaN;
        const held = Number.isFinite(started) ? ` \xB7 held ${formatElapsed(Math.max(0, (Date.now() - started) / 1e3))}` : "";
        const cost = runDir ? summarizeSwaps(await readSwaps(runDir), run.run_id) : { count: 0, total_elapsed_s: 0 };
        const paid = cost.count > 0 ? `swaps ${cost.count} \xB7 ${cost.total_elapsed_s.toFixed(1)}s paid` : "0 swaps";
        const d = runDir ? await readDesk(runDir, run.run_id) : void 0;
        const deskPart = d ? ` \xB7 ${deskLine(d)}` : "";
        ctx.ui.notify(
          `orchestrate ${run.run_id}: ${run.state} \xB7 lane ${run.lane} \xB7 round ${run.round}/${run.max_rounds} \xB7 tasks ${done}/${run.tasks.length} \xB7 phases ${run.phases.length} \xB7 router claim ${lockDir ? `this run (pid ${process.pid})` : claim2 ? `pid ${claim2.pid} \xB7 ${claim2.run_id} \xB7 ${claim2.repo} \xB7 ${claim2.host}` : "free"}${held} \xB7 ${paid}${deskPart} \xB7 ${statePath()}`,
          "info"
        );
        paint(ctx);
        return;
      }
      if (first === "runs") {
        const dir = runDir ?? join7(ctx.cwd, "var", "omp-orchestrate");
        const archived = await listRuns(dir);
        if (archived.length === 0) {
          ctx.ui.notify(`orchestrate: no archived runs in ${join7(dir, RUNS_DIRNAME)}`, "info");
          return;
        }
        for (const r of archived.slice(0, 5)) {
          ctx.ui.notify(`run ${r.run_id}: ${r.state} \xB7 ${r.rounds} rounds \xB7 ${r.tasks_passed}/${r.tasks_total} tasks \xB7 ${r.goal.replace(/\s+/g, " ").slice(0, 60)}`, "info");
        }
        if (archived.length > 5) ctx.ui.notify(`orchestrate: ${archived.length - 5} more archived runs in ${join7(dir, RUNS_DIRNAME)}`, "info");
        return;
      }
      if (first === "moe") {
        const dir = runDir ?? join7(ctx.cwd, "var", "omp-orchestrate");
        for (const c of classWarmth(await readSwaps(dir))) {
          ctx.ui.notify(`orchestrate: ${c.cls}: ${c.swaps} swaps \xB7 ${c.warm}/${c.swaps} warm \xB7 profile ${c.profile ?? "none named"}`, "info");
        }
        const snap = await fetchMetrics() ?? metrics;
        if (snap) metrics = snap;
        for (const r of moeBalanceRows([THINK_LANE, CODE_LANE], {
          ...process.env.FADE_ORCHESTRATE_BASALT_CONFIG ? { configPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG } : {},
          healthByLane: snap?.loaded ? { [snap.loaded]: { spill_experts: snap.spill_experts, spill_total: snap.spill_total, spill_bytes_gb: snap.spill_bytes_gb, slots: snap.slots } } : {}
        })) {
          ctx.ui.notify(`orchestrate: ${r.label} \xB7 ${r.value}`, "info");
        }
        ctx.ui.notify(`orchestrate: ${versionLine(snap?.engine_version, await packageVersion(), await bundleHash())}`, "info");
        return;
      }
      if (first === "desk") {
        const dir = runDir ?? join7(ctx.cwd, "var", "omp-orchestrate");
        const st = run ?? await readJsonAsync(join7(dir, STATE_FILENAME));
        if (!st) {
          ctx.ui.notify(`orchestrate: no run in ${dir}, so there is no desk`, "info");
          return;
        }
        const d = await readDesk(dir, st.run_id);
        if (!d) {
          ctx.ui.notify(`orchestrate: no desk file at ${deskPath(dir)} \u2014 no worker has registered a verification request for ${st.run_id}`, "info");
          return;
        }
        const ready = readyToAddress(d, Date.now(), { settleMs: DESK_SETTLE_MS, deadlineMs: DESK_DEADLINE_MS });
        ctx.ui.notify(`orchestrate: ${deskLine(d)} \xB7 batch ${d.epoch + 1} open since ${d.open_utc}${d.sealed_utc ? ` \xB7 sealed ${d.sealed_utc}` : " \xB7 NOT sealed"} \xB7 ${ready.reason}`, "info");
        for (const r of d.requests.slice(-8)) {
          ctx.ui.notify(`  ${r.id} [batch ${r.batch + 1}] ${r.agent}${r.task_id ? `/${r.task_id}` : ""}: ${r.objective.slice(0, 70)} \u2192 ${r.verdict ? r.verdict.accepted ? "ACCEPTED" : "needs_repair" : r.claimed_batch !== void 0 ? "claimed, verdict owed" : "collecting"}`, "info");
        }
        for (const a of d.addressed.slice(-4)) ctx.ui.notify(`  batch ${a.batch + 1} addressed ${a.at} routed ${a.routed}: ${a.ids.join(", ")}`, "info");
        if (d.churn) ctx.ui.notify(`orchestrate: CHURN ROUTE in force${d.churn_utc ? ` since ${d.churn_utc}` : ""} \u2014 batches go to the ${VERIFIER_AGENT} subagent on ${VERIFIER_MODEL}; /orchestrate lanes reset hands them back to the lane`, "warning");
        return;
      }
      if (first === "verifier") {
        const sub = (raw.split(/\s+/)[1] ?? "show").toLowerCase();
        const abs = join7(ctx.cwd, verifierAgentPath(ctx.cwd));
        if (sub === "install") {
          try {
            mkdirSync2(join7(ctx.cwd, ".omp", "agents"), { recursive: true });
            writeFileSync2(abs, verifierAgentMd());
          } catch (e) {
            ctx.ui.notify(`orchestrate: verifier install FAILED at ${abs}: ${e instanceof Error ? e.message : String(e)}`, "error");
            return;
          }
          const warn = isRouterModel(VERIFIER_MODEL) ? ` WARNING: ${VERIFIER_MODEL} is a ROUTER entry \u2014 a subagent on it pays the very swap this agent exists to avoid; point FADE_ORCHESTRATE_VERIFIER_MODEL at a non-router model (e.g. ninfer-local/coder-gpu1)` : "";
          ctx.ui.notify(`orchestrate: wrote ${verifierAgentPath(ctx.cwd)} (model ${VERIFIER_MODEL}) \u2014 the host discovers agent definitions per session, so a live session needs /new to see it${warn}`, warn === "" ? "info" : "warning");
          return;
        }
        const installed = existsSync(abs);
        ctx.ui.notify(`orchestrate: verifier agent ${VERIFIER_AGENT} \xB7 model ${VERIFIER_MODEL} \xB7 ${abs} ${installed ? "installed" : "NOT installed (/orchestrate verifier install)"}`, installed ? "info" : "warning");
        if (installed) ctx.ui.notify(`orchestrate: ${readFileSync3(abs, "utf8").split("\n").slice(0, 6).join("\n")}`, "info");
        return;
      }
      if (first === "overlay") {
        await openPanelGuarded(ctx);
        return;
      }
      if (first === "handover") {
        if (!run) {
          ctx.ui.notify("orchestrate: no run active", "info");
          return;
        }
        pi.sendUserMessage(await handoverText(run));
        ctx.ui.notify("orchestrate: condensed handover sent", "info");
        return;
      }
      if (first === "lanes" || first === "lane") {
        if ((raw.split(/\s+/)[1] ?? "") !== "reset") {
          ctx.ui.notify("orchestrate: `/orchestrate lanes reset` clears the flip ledger and lands the owed lane", "warning");
          return;
        }
        if (!run) {
          ctx.ui.notify("orchestrate: no run active", "info");
          return;
        }
        const owed = pending;
        pending = void 0;
        resetFlipLedger();
        flipBadge = void 0;
        if (run?.run_id && runDir) {
          const d = await readDesk(runDir, run.run_id);
          if (d?.churn) {
            await writeJsonAsync(deskPath(runDir), setChurn(d, false));
            ctx.ui.notify(`orchestrate: churn route cleared \u2014 verification batches answer on the ${THINK_LANE} lane again`, "info");
          }
        }
        run.paused = false;
        run.operator_note = void 0;
        const wanted = owed?.lane ?? run.lane;
        ctx.ui.notify(`orchestrate: flip ledger cleared; landing ${wanted}`, "info");
        await persist();
        paint(ctx);
        void requestLane(wanted, ctx);
        return;
      }
      if (first === "skip" || first === "verify" || first === "reset" || first === "pause" || first === "halt" || first === "code") {
        if (!run) {
          ctx.ui.notify("orchestrate: no run active", "info");
          return;
        }
        const dir = first === "skip" ? actSkip(run, raw.split(/\s+/)[1]) : first === "verify" ? actVerify(run) : first === "reset" ? actReset(run) : first === "pause" ? actPause(run, raw.split(/\s+/).slice(1).join(" ") || void 0) : first === "halt" ? actHalt(run) : actCode(run);
        await persist();
        paint(ctx);
        ctx.ui.notify(`orchestrate: ${dir.note}`, "info");
        if (!run.paused && pending) {
          const deferred = pending;
          pending = void 0;
          requestLane(deferred.lane, ctx);
        }
        if (dir.next) requestLane(dir.next, ctx);
        return;
      }
      if (first === "stop") {
        if (!run) {
          ctx.ui.notify("orchestrate: no run active", "info");
          return;
        }
        if (TERMINAL[run.state] !== true) {
          run.state = "stopped";
          if (runDir) writeJson(statePath(), run);
        }
        releaseLock();
        pending = void 0;
        clearSurface(ctx);
        ctx.ui.notify(`orchestrate: stopped; resident lane left as ${run.lane}; state ${statePath()}`, "info");
        if (raw.includes("--clear")) {
          try {
            unlinkSync2(join7(runDir, ACTIVE_FILENAME));
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
      const runId = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z").replace("T", "T")}-${Math.random().toString(36).slice(2, 6)}`;
      const repo = ctx.cwd;
      const claimDir = instanceLockDir(ROUTER);
      const claim = acquireInstanceLock(claimDir, { run_id: runId, repo });
      if (!claim.ok) {
        ctx.ui.notify(
          `orchestrate: the router ${ROUTER} is claimed by pid ${claim.holder.pid} \u2014 run ${claim.holder.run_id} in ${claim.holder.repo} on ${claim.holder.host}${claim.stale ? "; its owner died in the same instant as the reclaim, so that instance holds the router" : ""}. End that run (\`/orchestrate stop\` there) or point this session at another router (FADE_ORCHESTRATE_ROUTER / FADE_ORCHESTRATE_LOCK_DIR). Nothing was written.`,
          "error"
        );
        return;
      }
      lockDir = claimDir;
      if (!await isGitRepo(repo)) ctx.ui.notify(`orchestrate: ${await gitCaveat(repo)}`, "warning");
      ctx.ui.setWorkingMessage(`fade_orchestrate: loading ${THINK_LANE} on the router\u2026`);
      engineProofInvalidate();
      const loaded = await loadLane(THINK_LANE);
      ctx.ui.setWorkingMessage();
      if (!loaded.ok) {
        releaseLock();
        ctx.ui.notify(`orchestrate: preflight failed loading ${THINK_LANE} (${loaded.detail}); nothing written`, "error");
        return;
      }
      const census = await listLanes();
      const resident = census.models.find((m) => m.status === "loaded");
      if (!census.error && resident?.id !== THINK_LANE) {
        releaseLock();
        ctx.ui.notify(`orchestrate: preflight expected ${THINK_LANE} loaded, router reports ${resident ? resident.id : "none"}; nothing written`, "error");
        return;
      }
      const previous = run;
      runDir = join7(repo, "var", "omp-orchestrate");
      if (previous && TERMINAL[previous.state] === true) {
        const archived = await archiveRun(join7(previous.repo || repo, "var", "omp-orchestrate"), previous);
        if (archived) ctx.ui.notify(`orchestrate: the finished run ${previous.run_id} is archived at ${archived}`, "info");
      }
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
      await writeJsonAsync(join7(runDir, ACTIVE_FILENAME), { run_id: runId, repo, goal, started_utc: run.started_utc, max_rounds: rounds });
      await persist();
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
      pi.sendUserMessage(await briefings.plan(run));
    }
  });
  pi.on("session_start", async (_event, ctx) => {
    if (isDelegatedSession()) return;
    await ensurePhaseTool();
    if (RAW_DELIVERABLE && !inputUnsub) {
      inputUnsub = ctx.ui.onTerminalInput((data) => {
        if (data !== CHORD || panelOpen) return void 0;
        void openPanelGuarded(ctx);
        return { consume: true };
      });
    }
    const chordNote = resolveChord();
    const repo = ctx.cwd;
    const active = await readJsonAsync(join7(repo, "var", "omp-orchestrate", ACTIVE_FILENAME));
    const state = await readJsonAsync(join7(repo, "var", "omp-orchestrate", STATE_FILENAME));
    let runNote;
    if (active && state) {
      runDir = join7(repo, "var", "omp-orchestrate");
      run = normalizeRun(state);
      settledNotified = false;
      paint(ctx);
      startMetricsTimer();
      if (TERMINAL[state.state] === true) {
        runNote = `run ${state.run_id} is ${state.state} (${statePath()})`;
      } else if (process.env.FADE_ORCHESTRATE_AUTO_RESUME === "1") {
        setTimeout(async () => {
          const idle = typeof ctx.hasPendingMessages === "function" ? !ctx.hasPendingMessages() : true;
          if (idle && ctx.isIdle()) pi.sendUserMessage(await handoverText(state));
        }, 250);
        runNote = `run ${state.run_id} is ${state.state} \u2014 condensed handover sent (FADE_ORCHESTRATE_AUTO_RESUME=1)`;
      } else {
        runNote = `run ${state.run_id} is ${state.state} \u2014 /orchestrate handover sends the condensed state`;
      }
    }
    const line = [chordNote, runNote].filter((n) => n !== void 0).join(" \xB7 ");
    if (line !== "") {
      const at = setTimeout(() => ctx.ui.notify(`orchestrate: ${line}`, "info"), 500);
      at.unref?.();
    }
  });
  pi.on("agent_start", async (_event, ctx) => {
    if (!await ensurePhaseTool()) setTimeout(() => void ensurePhaseTool(), 500);
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
      if (await dispatchDeskBatch(ctx)) {
        void recordTurn("verification_batch");
        return;
      }
      const tier = classifyTurnEnd(run, false);
      if (tier === "nudge") {
        pushRejection(run, "protocol", `turn ended in state ${run.state} with no fade_phase call (nudge ${run.stall_count}/${STALL_SYNTHESIZE_AT})`);
        await persist();
        paint(ctx);
        ctx.ui.notify(`orchestrate: protocol nudge ${run.stall_count}/${STALL_SYNTHESIZE_AT} \u2014 round ${run.round} unspent, no swap paid`, "warning");
        await ensurePhaseTool();
        pi.sendUserMessage(briefings.nudge(run));
        void recordTurn("nudge");
        return;
      }
      if (tier === "synthesize" && (run.state === "coding" || run.state === "repair")) {
        await gateChecks(ctx);
        const gate = run.checks.length > 0 ? await runGateLogged(run.checks, run.repo, ctx) : void 0;
        if (gate) run.gate_last = gate;
        if (gate && !gate.passed) {
          const failing = gate.results.filter((r) => !r.ok);
          pushRejection(run, "task", `synthesized round refused: pre-swap gate red: ${failing.map((f) => f.cmd).join(" | ")}`);
          await persist();
          paint(ctx);
          pending = { lane: CODE_LANE, phase: "gate" };
          settledNotified = false;
          await ensurePhaseTool();
          pi.sendUserMessage(briefings.gate(run));
          void recordTurn("gate_red");
          return;
        }
        const syn = await synthesizeCodingDone(run, run.repo);
        pushRejection(run, "protocol", `coding_done SYNTHESIZED from git status/diff + gate exit codes after ${run.stall_count} phase-less turns`);
        const applied = applyPhase("coding_done", { done: syn.done });
        await persist();
        paint(ctx);
        ctx.ui.notify(`orchestrate: coding_done synthesized from git + gate (round ${run.round}); the verifier swap is paid once`, "warning");
        void recordTurn("synthesized");
        settledNotified = false;
        requestLane(applied.next, ctx);
        return;
      }
      if (tier === "stall") {
        const stalledFrom = run.state;
        run.state = "stalled_protocol_error";
        run.paused = true;
        run.reason = `${run.protocol_retries ?? 0} turn(s) ended with no fade_phase call from state ${stalledFrom}`;
        pushRejection(run, "protocol", `circuit breaker: ${run.reason}`);
        await persist();
        paint(ctx);
        ctx.ui.notify(await briefings.stalled(run), "error");
        void recordTurn("stalled_protocol_error");
        return;
      }
      pushRejection(run, "protocol", `turn ended in state ${run.state} with no fade_phase call (tier ${tier})`);
      await persist();
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
    requestLane(next.lane, ctx);
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!run || !runDir || isDelegatedSession()) return void 0;
    if (event.toolName === "task") {
      const batch = taskBatchOf(event.input);
      if (batch.carriesVerification) {
        await mutateDesk(runDir, run.run_id, (d) => noteTaskBatch(d, { count: batch.verifyAgents.length, agents: batch.verifyAgents }));
        ctx.ui.notify(`orchestrate: task call carries ${batch.count} worker(s), ${batch.verifyAgents.length} with verification work \u2014 the desk batch closes at ${batch.verifyAgents.length} registration(s)`, "info");
      }
      return void 0;
    }
    const live = await liveState();
    if (!live || live.state !== "verifying" || live.lane !== THINK_LANE) return void 0;
    const name = event.toolName ?? "";
    if (MUTATING_TOOLS[name] !== true) return void 0;
    pushRejection(run, "task", `verifier sandbox: ${name} refused on the thinking lane (read-only); the fix is delegated to the coder`);
    await persist();
    return { block: true, reason: `fade_orchestrate: the verifier lane is read-only \u2014 ${name} is refused. Report the finding with fade_phase; the coder lane applies it.` };
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "task" || !run || !runDir || isDelegatedSession()) return void 0;
    const desk = await readDesk(runDir, run.run_id);
    if (!desk || openRequests(desk).length === 0) return void 0;
    const sealed = sealBatch(desk);
    await writeJsonAsync(deskPath(runDir), sealed);
    const ready = readyToAddress(sealed, Date.now(), { settleMs: DESK_SETTLE_MS, deadlineMs: DESK_DEADLINE_MS });
    ctx.ui.notify(`orchestrate: task call settled \u2014 desk batch ${sealed.epoch + 1} sealed with ${openRequests(sealed).length} request(s): ${ready.reason}`, "info");
    return void 0;
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    clearSurface(ctx);
    stopMetricsTimer();
    if (inputUnsub) {
      inputUnsub();
      inputUnsub = void 0;
    }
  });
}
export {
  fadeOrchestrate as default
};
