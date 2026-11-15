#!/usr/bin/env node
// rpc_rig.mjs — prove the extension's UI frames through `omp --mode rpc` (skill
// omp-extension-rpc-verify: extension load is proved by available_commands_update; every ctx.ui
// call arrives as an extension_ui_request frame; RPC cannot carry raw keystrokes, so the
// Ctrl+O binding itself is a TUI check and the overlay CONTENT + actions run here through the
// shared code paths: `/orchestrate overlay` renders the same lines as the component, and
// skip/halt execute the same keymap functions the overlay keys call).
//
// It seeds <repo>/var/omp-orchestrate/{ACTIVE.json,state.json} with a deterministic run, drives
// the command surface with the router pointed at a CLOSED port (the pill must render without
// touching the network, and metrics fetches must degrade to no suffix), and asserts:
//   1. the pill: one setStatus `⚡ flash-next:code · R1/6 · T3/6 · [Ctrl+O]` — the FULL lane name,
//      because the host renders extension statuses on the footer's own full-width row, directly
//      under the stats row whose right side carries the model identifier (operator order 2026-11-15),
//   2. the multi-line dump is GONE: no setWidget frame carries lines under the status key,
//   3. the overlay: full untruncated objectives + swap-history section + tier labels + key legend,
//   4. skip: state.json records T4 passed with a manual-skip note,
//   5. halt: notify + state.json stopped.
// Usage: node test/rpc_rig.mjs [--repo DIR] [--timeout MS]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const repo = arg("repo", "/tmp/orch-rig-v2");
const timeoutMs = Number(arg("timeout", "90000"));

const objective = "T1 objective: split the 601-line monolith into modules without changing behavior — router client, state machine, wiring, packaging, and delete the old file. ".padEnd(240, "z");
const task = (id, extra = {}) => ({ id, objective: `${id} objective`, files: ["a.ts"], acceptance: "echo ok", dependencies: [], round: 1, ...extra });
const state = {
  key: "fade.omp_orchestrate.run.v1",
  run_id: "RIG2",
  goal: "rig goal",
  lane: "flash-next",
  round: 1,
  max_rounds: 6,
  state: "coding",
  tasks: [
    task("T1", { objective, status: "passed", result: "did it" }),
    task("T2", { status: "passed", result: "ok" }),
    task("T3", { status: "passed", result: "ok" }),
    task("T4"),
    task("T5"),
    task("T6"),
  ],
  repair_tasks: [],
  rejection_history: [{ round: 1, at: "2026-11-15T00:10:00.000Z", kind: "verification", task_id: "T2", reason: "T2 acceptance under-specified" }],
  schema_retries: 1,
  tier: "M",
  phases: [
    { phase: "planning_done", lane: "deepseek", accepted: true, round: 1, at: "2026-11-15T00:00:00.000Z" },
    { phase: "verification_done", lane: "deepseek", accepted: false, round: 1, at: "2026-11-15T00:10:00.000Z", notes: "verifier critique: T2 acceptance under-specified" },
  ],
  started_utc: "2026-11-15T00:00:00.000Z",
};
rmSync(repo, { recursive: true, force: true });
mkdirSync(join(repo, "var", "omp-orchestrate"), { recursive: true });
writeFileSync(join(repo, "var", "omp-orchestrate", "ACTIVE.json"), JSON.stringify({ run_id: "RIG2", repo, goal: "rig goal", started_utc: state.started_utc, max_rounds: 6 }, null, 2) + "\n");
writeFileSync(join(repo, "var", "omp-orchestrate", "state.json"), JSON.stringify(state, null, 2) + "\n");

const frames = [
  { id: "c1", type: "prompt", message: "/orchestrate status" },
  { id: "c2", type: "prompt", message: "/orchestrate overlay" },
  { id: "c3", type: "prompt", message: "/orchestrate skip T4" },
  { id: "c4", type: "prompt", message: "/orchestrate halt" },
  { id: "c5", type: "prompt", message: "/lanes" },
];
// stdin stays OPEN while the prompts run: the overlay awaits a router fetch, and EOF-shutdown
// cancels it mid-await (measured: sync-command frames arrive, the overlay's never do).
const child = spawn("omp", ["--mode", "rpc"], {
  cwd: repo,
  env: { ...process.env, FADE_ORCHESTRATE_ROUTER: "http://127.0.0.1:9", FADE_ORCHESTRATE_HEADLESS: "1" },
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
for (const f of frames) child.stdin.write(JSON.stringify(f) + "\n");
const exited = new Promise((resolve) => child.on("exit", resolve));
setTimeout(() => child.stdin.end(), 12000);
const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
await Promise.race([exited, new Promise((r) => setTimeout(r, timeoutMs))]);
clearTimeout(killer);
const run = { stdout, stderr };
const ui = [];
let commands = [];
for (const line of `${run.stdout ?? ""}`.split("\n")) {
  if (!line.startsWith("{")) continue;
  let f;
  try {
    f = JSON.parse(line);
  } catch {
    continue;
  }
  if (f.type === "extension_ui_request") ui.push(f);
  if (f.type === "available_commands_update") commands = (f.commands ?? f.commandsUpdate ?? []).map((c) => (typeof c === "string" ? c : c.name));
}

const pill = ui.find((u) => u.method === "setStatus" && String(u.statusText ?? "").startsWith("⚡ flash-next:code · R1/6 · T3/6 · [Ctrl+O]"));
// Operator placement order (2026-11-15): the pill carries the FULL lane name. The benchmark for
// "it fits" is the model identifier on the row above it (`deepseek-v4.1-flash …`), which is itself
// ~20 characters of model name plus the token stats, so a ~45-character pill sits under it.
const pillText = String(pill?.statusText ?? "");
const MODEL_ID_ROW_CHARS = 20; // the model-name part of the row above, at minimum
const pillCaps = [
  ["pill carries the FULL lane name, not a 2-char tag", pill !== undefined && pillText.includes("flash-next:code")],
  ["pill fits under the model-identifier row", pillText.length > 0 && pillText.length < MODEL_ID_ROW_CHARS + 30],
  ["a clean run advertises no protocol stall", !pillText.includes("protocol")],
];
const dump = ui.filter((u) => u.method === "setWidget" && (u.key ?? u.widgetKey) === "fade" && Array.isArray(u.widgetLines ?? u.lines));
const overlay = ui.filter((u) => u.method === "setWidget" && (u.key === "fade-overlay" || u.widgetKey === "fade-overlay")).map((u) => u.widgetLines ?? u.lines ?? []);
const overlayLines = overlay.flat();
const notifySkip = ui.filter((u) => JSON.stringify(u).includes("skipped T4"));
const notifyHalt = ui.filter((u) => JSON.stringify(u).includes("halted"));
const finalState = JSON.parse(readFileSync(join(repo, "var", "omp-orchestrate", "state.json"), "utf8"));

const checks = [
  ["commands registered", commands.includes("orchestrate") && commands.includes("lanes")],
  ["pill rendered", pill !== undefined],
  ...pillCaps,
  ["no multi-line dump under the status key", dump.length === 0],
  ["overlay rendered", overlayLines.length > 10],
  ["overlay untruncated objective", overlayLines.some((l) => l.includes("z".repeat(20)))],
  ["overlay shows swap history section", overlayLines.some((l) => l.includes("basalt swap latency"))],
  ["overlay shows tiers", overlayLines.some((l) => l.includes("memory / engine tiers"))],
  ["overlay shows last critique", overlayLines.some((l) => l.includes("verifier critique: T2 acceptance under-specified"))],
  ["overlay key legend", overlayLines.some((l) => l.includes("[s] skip task"))],
  ["overlay offers the pause key", overlayLines.some((l) => l.includes("[p] pause/resume"))],
  ["overlay shows tier", overlayLines.some((l) => l.includes("tier M"))],
  ["overlay shows rejections", overlayLines.some((l) => l.includes("round 1 [verification] T2: T2 acceptance under-specified"))],
  ["skip notified", notifySkip.length >= 1],
  ["skip persisted (T4 passed, manual-skip note)", finalState.tasks[3].status === "passed" && /manual skip \(operator\)/.test(finalState.tasks[3].result ?? "")],
  ["halt notified", notifyHalt.length >= 1],
  ["halt persisted (state stopped)", finalState.state === "stopped"],
];
const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({ checks: Object.fromEntries(checks.map(([n, ok]) => [n, ok ? "ok" : "FAIL"])), frames: ui.length, overlay_lines: overlayLines.length }, null, 1));
if (failed.length > 0) {
  console.error(JSON.stringify({ failed: failed.map(([n]) => n), stderr: (run.stderr ?? "").slice(0, 800) }, null, 1));
  process.exit(1);
}
console.log("rpc rig: all checks pass");
