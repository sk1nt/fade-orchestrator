// src/router.ts
import { exec } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";
import { promisify } from "node:util";

// src/supervisor.ts
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var CALLER = "fade-orchestrator";
var BUILD_PROD = "prod";
var ROOT_SOCK = "/run/fade/supervisor.sock";
var USER_SOCK = "/tmp/fade-supervisor.sock";
var STATE_DIR = process.env.FADE_ORCHESTRATE_STATE_DIR ?? join(homedir(), ".local", "state", "fade-orchestrator");
var leaseTokenFile = (session, dir = STATE_DIR) => join(dir, "leases", `${CALLER}-${(session || "anon").replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
function readStoredLease(session, dir = STATE_DIR) {
  try {
    const rec = JSON.parse(readFileSync(leaseTokenFile(session, dir), "utf8"));
    return typeof rec?.token === "string" && rec.token.length > 0 && typeof rec.session === "string" ? rec : void 0;
  } catch {
    return void 0;
  }
}
function writeStoredLease(rec, dir = STATE_DIR) {
  try {
    const path = leaseTokenFile(rec.session, dir);
    mkdirSync(dirname(path), { recursive: true, mode: 448 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec), { mode: 384 });
    renameSync(tmp, path);
  } catch {
  }
}
function clearStoredLease(session, dir = STATE_DIR) {
  try {
    rmSync(leaseTokenFile(session, dir), { force: true });
  } catch {
  }
}
async function releaseOwnedLease(token, sessionId, sock) {
  const v = await releaseLease(token, sessionId, sock);
  if (v.ok || v.rule === RULE_LEASE_STALE_TOKEN) clearStoredLease(sessionId);
  return v;
}
var RULE_LEASE_NOT_HOLDER = "lease_not_holder";
var RULE_LEASE_HELD = "lease_held";
var RULE_LEASE_STALE_TOKEN = "lease_stale_token";
var BUILD_DEV = "dev";
function buildFromEnv(env = process.env) {
  return env.FADE_BUILD === BUILD_DEV ? BUILD_DEV : BUILD_PROD;
}
function fadeHeaders(sessionId, build = buildFromEnv()) {
  return {
    "content-type": "application/json",
    "x-fade-caller": CALLER,
    "x-fade-build": build,
    "x-fade-session-id": sessionId
  };
}
var acquireBody = (pack, ttlSec, reason = "plan-authority") => ({
  action: "acquire",
  pack,
  ttl_s: ttlSec,
  reason
});
var renewBody = (token, ttlSec) => ({ action: "renew", token, ttl_s: ttlSec });
var releaseBody = (token, reason = "return-coder") => ({ action: "release", token, reason });
var swapBody = (pack, token, phase = "phase_boundary") => ({
  pack,
  phase_boundary: true,
  phase,
  reason: "orchestrator-phase-boundary",
  lease_token: token
});
var PACK_TO_MODEL = {
  "ds41": "deepseek",
  "hy4": "hy4-flash",
  "ablit": "flash-next-ablit",
  "flash-next": "flash-next",
  "deepseek": "deepseek",
  "hy4-flash": "hy4-flash",
  "flash-next-ablit": "flash-next-ablit",
  "inkling": "inkling-2-mini",
  "inkling-2-mini": "inkling-2-mini"
};
function packToModelId(pack) {
  return PACK_TO_MODEL[pack] ?? pack;
}
function maskToken(token) {
  if (!token) return "";
  return `${token.slice(0, 4)}\u2026(${token.length})`;
}
var asRecord = (v) => v && typeof v === "object" ? v : {};
var asString = (v) => typeof v === "string" ? v : void 0;
var asNumber = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
function postUds(sock, path, body, headers, timeoutMs = 15e3) {
  const { promise, resolve: resolve3, reject } = Promise.withResolvers();
  const payload = JSON.stringify(body);
  const req = request(
    {
      socketPath: sock,
      // No pooled connection: the global agent is keep-alive, and a pooled UDS socket is an
      // open handle that outlives the call. In the TUI that is invisible; in a one-shot host
      // (`omp -p`) the plugin's residency/lease calls keep the event loop alive after the work
      // is done, so the process exits on nothing. `agent: false` is a per-request socket.
      agent: false,
      method: "POST",
      path,
      headers: { ...headers, "content-length": Buffer.byteLength(payload) }
    },
    (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        raw += c;
      });
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = void 0;
        }
        resolve3({ status: res.statusCode ?? 0, body: parsed, raw });
        req.destroy();
      });
    }
  );
  req.setTimeout(timeoutMs, () => req.destroy(new Error(`supervisor ${path}: timed out after ${timeoutMs}ms`)));
  req.on("error", (e) => reject(e));
  req.end(payload);
  return promise;
}
var STATUS_OK = 200;
var SL = String.fromCharCode(47);
var ROUTE_RESIDENCY = SL.concat("v1", SL, "residency");
var ROUTE_HEALTH = SL.concat("v1", SL, "health");
function getUds(sock, path, headers, timeoutMs = 4e3) {
  const { promise, resolve: resolve3, reject } = Promise.withResolvers();
  const req = request({ socketPath: sock, agent: false, method: "GET", path, headers }, (res) => {
    let raw = "";
    res.setEncoding("utf8");
    res.on("data", (c) => {
      raw += c;
    });
    res.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = void 0;
      }
      resolve3({ status: res.statusCode ?? 0, body: parsed, raw });
      req.destroy();
    });
  });
  req.setTimeout(timeoutMs, () => req.destroy(new Error(`supervisor ${path}: timed out after ${timeoutMs}ms`)));
  req.on("error", (e) => reject(e));
  req.end();
  return promise;
}
function residencyVerdict(r) {
  if (r.status !== STATUS_OK) return void 0;
  const b = asRecord(r.body);
  const lane = asRecord(b.lane);
  const state = asString(b.lane_state) ?? asString(lane.state);
  if (!state) return void 0;
  const sup = asRecord(b.supervisor);
  return {
    state,
    pack: asString(b.active_pack) ?? asString(lane.active_pack) ?? "",
    pid: asNumber(b.pid) ?? asNumber(lane.pid) ?? 0,
    active_requests: asNumber(b.active_requests) ?? 0,
    endpoint: asString(b.endpoint) ?? "",
    telemetry_source: asString(asRecord(b.telemetry).source) ?? "none",
    version: asString(sup.version) ?? "",
    sock: asString(sup.sock) ?? ""
  };
}
async function getResidency(sessionId, sock, timeoutMs = 4e3) {
  try {
    const s = sock ?? await discoverSock();
    return residencyVerdict(await getUds(s, ROUTE_RESIDENCY, fadeHeaders(sessionId), timeoutMs));
  } catch {
    return void 0;
  }
}
async function probeHealth(sock, timeoutMs = 1500) {
  try {
    const r = await getUds(sock, ROUTE_HEALTH, fadeHeaders("probe"), timeoutMs);
    return r.status === STATUS_OK && asRecord(r.body).ok === true;
  } catch {
    return false;
  }
}
async function discoverSock(env = process.env, euid = typeof process.geteuid === "function" ? process.geteuid() : 1, probe = probeHealth) {
  const pinned = env.FADE_SUPERVISOR_SOCK;
  if (pinned) return pinned;
  if (await probe(ROOT_SOCK)) return ROOT_SOCK;
  if (await probe(USER_SOCK)) return USER_SOCK;
  return euid === 0 ? ROOT_SOCK : USER_SOCK;
}
function leaseVerdict(r) {
  const b = asRecord(r.body);
  const leaseTop = asRecord(b.lease);
  const leaseLane = asRecord(asRecord(b.lane).lease);
  const str2 = (top, lane) => top && top.length ? top : lane;
  const num2 = (top, lane) => top !== void 0 && top !== 0 ? top : lane;
  return {
    ok: r.status === 200 && b.accepted === true,
    status: r.status,
    decision: asString(b.decision) ?? "",
    rule: asString(b.rule) ?? "",
    reason: asString(b.reason) ?? "",
    token: asString(b.token),
    granted_ttl_s: asNumber(b.granted_ttl_s),
    holder: str2(asString(leaseTop.holder_caller), asString(leaseLane.holder_caller)),
    remaining_s: num2(asNumber(leaseTop.remaining_sec), asNumber(leaseLane.remaining_sec)),
    token_hint: str2(asString(leaseTop.token_hint), asString(leaseLane.token_hint))
  };
}
function swapVerdict(r) {
  const b = asRecord(r.body);
  const lane = asRecord(b.lane);
  const accepted = b.accepted === true && (r.status === 200 || r.status === 202);
  return {
    ok: accepted,
    status: r.status,
    decision: asString(b.decision) ?? "",
    rule: asString(b.rule) ?? "",
    reason: asString(b.reason) ?? "",
    resident: asString(lane.active_pack),
    min_free_mib: asNumber(b.min_free_mib)
  };
}
function leaseLine(v) {
  if (v.ok && v.token) return `lease GRANTED to ${CALLER}, ${v.granted_ttl_s ?? "?"}s TTL`;
  if (v.rule === RULE_LEASE_NOT_HOLDER) return `lane held by ${v.holder ?? "another caller"}${v.remaining_s ? `, ${v.remaining_s}s left` : ""}`;
  if (v.rule === RULE_LEASE_HELD) {
    const hint = v.token_hint ?? maskToken(v.token);
    const tail = v.holder ? "" : v.reason ? `: ${v.reason}` : "";
    return `lease held by ${v.holder ?? "another caller"}${v.remaining_s ? `, ${v.remaining_s}s left` : ""}${hint ? ` (hint ${hint})` : ""}${tail}`;
  }
  return `${v.decision || "REJECT"}: ${v.rule || "refused"}${v.reason ? ` \u2014 ${v.reason}` : ""}`;
}
async function acquireLease(pack, ttlSec, sessionId, sock, timeoutMs = 15e3) {
  const s = sock ?? await discoverSock();
  const r = await postUds(s, "/v1/lease", acquireBody(pack, ttlSec), fadeHeaders(sessionId), timeoutMs);
  return leaseVerdict(r);
}
function shouldRenew(remainingS, ttlSec) {
  const floor = Math.max(60, Math.floor(ttlSec / 3));
  const rem = typeof remainingS === "number" && Number.isFinite(remainingS) ? remainingS : 0;
  return rem <= floor;
}
async function renewLease(token, ttlSec, sessionId, sock, timeoutMs = 15e3) {
  const s = sock ?? await discoverSock();
  const r = await postUds(s, "/v1/lease", renewBody(token, ttlSec), fadeHeaders(sessionId), timeoutMs);
  return leaseVerdict(r);
}
async function releaseLease(token, sessionId, sock, timeoutMs = 1e4) {
  const s = sock ?? await discoverSock();
  const r = await postUds(s, "/v1/lease", releaseBody(token), fadeHeaders(sessionId), timeoutMs);
  return leaseVerdict(r);
}
async function swapLeased(pack, token, sessionId, sock, timeoutMs = 24e4) {
  const s = sock ?? await discoverSock();
  const r = await postUds(s, "/v1/swap", swapBody(pack, token), fadeHeaders(sessionId), timeoutMs);
  return swapVerdict(r);
}

// src/router.ts
var execC = promisify(exec);
var ROUTER = process.env.FADE_ORCHESTRATE_ROUTER ?? "http://127.0.0.1:18014";
var PROVIDER = process.env.FADE_ORCHESTRATE_PROVIDER ?? "basalt";
var ENV_NOTICES = [];
var resolveLane = (name, label2, fallback, forbidden, forbiddenLabel) => {
  const want = (process.env[name] ?? "").trim();
  if (want === "") return fallback;
  if (!forbidden.includes(want)) return want;
  const next = forbidden.includes(fallback) ? want : fallback;
  ENV_NOTICES.push(`${name}="${want}" is ignored: that is the ${forbiddenLabel} lane, and a ${label2} lane equal to it swaps nothing \u2014 ${label2} runs on ${next}.`);
  return next;
};
var CODE_WANT = (process.env.FADE_ORCHESTRATE_CODE_LANE ?? "").trim() || "flash-next";
var CODE_LANE = (() => {
  if (CODE_WANT === "deepseek" || CODE_WANT === "hy4-flash") {
    ENV_NOTICES.push(`FADE_ORCHESTRATE_CODE_LANE="${CODE_WANT}" is ignored: that is a thinking pack, and naming it the code lane collapses every lane to one swap-free coder \u2014 code runs on flash-next.`);
    return "flash-next";
  }
  return CODE_WANT;
})();
var THINK_LANE = resolveLane("FADE_ORCHESTRATE_THINK_LANE", "planning", "deepseek", [CODE_LANE], CODE_LANE);
var VERIFY_LANE = resolveLane("FADE_ORCHESTRATE_VERIFY_LANE", "verification", "hy4-flash", [CODE_LANE], CODE_LANE);
var isThinkingLane = (lane) => lane === THINK_LANE || lane === VERIFY_LANE;
var THINKING = { [THINK_LANE]: "high", [VERIFY_LANE]: "high", [CODE_LANE]: "low" };
var msg = (e) => e instanceof Error ? e.message : String(e);
var SWAP_CMD = process.env.FADE_ORCHESTRATE_SWAP_CMD ?? "";
var SWAP_VIA = process.env.FADE_ORCHESTRATE_SWAP_VIA === "ctl" ? "ctl" : "supervisor";
async function runSwap(command) {
  try {
    const { stdout, stderr } = await execC(command, { timeout: 24e4, maxBuffer: 1 << 20 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err;
    const code = e?.code ?? (e?.killed ? 124 : 1);
    return { code, stdout: e?.stdout ?? "", stderr: e?.stderr ?? "" };
  }
}
async function listLanes() {
  try {
    const h = await fetch(`${process.env.FADE_ORCHESTRATE_ROUTER ?? ROUTER}/health`, { signal: AbortSignal.timeout(4e3) });
    const body = await h.json().catch(() => null);
    const health = h.ok ? String(body?.status ?? "ok") : `http ${h.status}`;
    const r = await fetch(`${process.env.FADE_ORCHESTRATE_ROUTER ?? ROUTER}/v1/models`, { signal: AbortSignal.timeout(4e3) });
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
    const r = await fetch(`${process.env.FADE_ORCHESTRATE_ROUTER ?? ROUTER}/health`, { signal: AbortSignal.timeout(4e3) });
    return await r.json();
  } catch {
    return void 0;
  }
}
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
async function supervisorResident(lane, sessionId = "fade-orchestrator") {
  const sup = await getResidency(sessionId);
  if (!sup) return void 0;
  return {
    resident: sup.state === "RESIDENT" && sup.pack === lane,
    state: sup.state,
    pack: sup.pack,
    pid: sup.pid,
    active_requests: sup.active_requests,
    telemetry_source: sup.telemetry_source,
    detail: `supervisor ${sup.version || "?"} lane ${sup.state} pack=${sup.pack || "none"} pid=${sup.pid} requests=${sup.active_requests} telemetry=${sup.telemetry_source}`
  };
}
async function gateLaneIdle(lane, opts) {
  const budgetMs = opts.budgetMs ?? 6e4;
  const pollMs = opts.pollMs ?? 3e3;
  const sup = opts.residency ? await opts.residency() : void 0;
  if (sup?.resident) {
    return {
      waited_ms: 0,
      polls: 0,
      over_budget: false,
      last: { busy: false, reason: `supervisor: ${sup.detail}; the target is resident, the idle gate is not paid` },
      short: "supervisor-resident"
    };
  }
  return gateBusyLoop(lane, opts, budgetMs, pollMs);
}
async function gateBusyLoop(lane, opts, budgetMs, pollMs) {
  const t0 = Date.now();
  const budget_s = Math.round(budgetMs / 1e3);
  const poll_s = Math.round(pollMs / 1e3);
  let polls = 0;
  let last = await opts.busy();
  while (last.busy) {
    polls += 1;
    const waited = Date.now() - t0;
    if (waited >= budgetMs) return { waited_ms: waited, polls, over_budget: true, last };
    if (polls === 1) opts.deferred?.(`fade_orchestrate: the ${lane} load is DEFERRED \u2014 ${last.reason}; retrying every ${poll_s}s up to ${budget_s}s`);
    opts.progress?.(`fade_orchestrate: ${lane} load deferred ${Math.round(waited / 1e3)}s/${budget_s}s \u2014 ${last.reason}`);
    const { promise: tick, resolve: tickDone } = Promise.withResolvers();
    setTimeout(tickDone, pollMs);
    await tick;
    last = await opts.busy();
  }
  return { waited_ms: Date.now() - t0, polls, over_budget: false, last };
}
async function loadLane(lane, opts = {}) {
  const t0 = Date.now();
  const health = await settleInFlight();
  const resident = (await listLanes()).models.find((m) => m.status === "loaded")?.id;
  const flip = flipState(resident, FLIP_WINDOW_MS);
  const guarded = flipGuarded(flip);
  if (resident === lane) return { ok: true, detail: `already resident; no swap issued${flipNote(flip)}`, elapsed_s: 0, guarded, flip };
  const sup = await supervisorResident(lane, opts.sessionId ?? "fade-orchestrator");
  if (sup?.resident) {
    return { ok: true, detail: `resident per supervisor; no swap issued (${sup.detail})${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1e3, guarded, flip };
  }
  const verdict = serveVerdict(health);
  if (verdict.serve === false) {
    return { ok: false, detail: `refused pre-unload: ${verdict.reason}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1e3, guarded, flip };
  }
  if (SWAP_VIA === "supervisor") {
    const sid = opts.sessionId ?? "fade-orchestrator";
    let token = opts.leaseToken;
    let minted = false;
    if (!token) {
      const stored = readStoredLease(sid);
      if (stored) {
        const rv = await renewLease(stored.token, opts.mintLease?.ttlSec ?? LANE_LEASE_TTL_SEC, sid);
        if (rv.ok) token = stored.token;
        else if (rv.rule === RULE_LEASE_NOT_HOLDER || rv.rule === RULE_LEASE_STALE_TOKEN) clearStoredLease(sid);
      }
    }
    if (!token) {
      if (!opts.mintLease) {
        return {
          ok: false,
          detail: `swap via supervisor refused: no lease token held for ${lane} and no mint requested \u2014 the supervisor plane never falls through to the ctl fleet gate (a ctl load takes no lease)${flipNote(flip)}`,
          elapsed_s: (Date.now() - t0) / 1e3,
          guarded,
          flip
        };
      }
      markOwnSwap(lane);
      const lease = await acquireLease(lane, opts.mintLease.ttlSec, sid);
      clearOwnSwap(lane);
      token = lease.ok ? lease.token : void 0;
      minted = !!token;
      if (token) writeStoredLease({ token, pack: lane, session: sid, granted_utc: (/* @__PURE__ */ new Date()).toISOString() });
      if (!token) {
        const deferrable = lease.rule === RULE_LEASE_HELD || lease.rule === RULE_LEASE_NOT_HOLDER || lease.rule === RULE_LEASE_STALE_TOKEN;
        return {
          ok: false,
          ...deferrable ? { deferred: true } : {},
          leaseRule: lease.rule,
          leaseHolder: lease.holder,
          leaseRemainingS: lease.remaining_s,
          leaseTokenHint: lease.token_hint,
          detail: `lease mint refused http ${lease.status} rule ${lease.rule || "?"}: ${lease.reason || "no reason"}${flipNote(flip)}`,
          elapsed_s: (Date.now() - t0) / 1e3,
          guarded,
          flip
        };
      }
    }
    const v = await swapLeased(lane, token, sid);
    const detail = v.ok ? `swap via supervisor: ${lane}` : `swap supervisor refused http ${v.status} rule ${v.rule || "?"}: ${v.reason || "no reason"}`;
    if (!v.ok && minted) {
      await releaseLease(token, sid).catch(() => void 0);
      clearStoredLease(sid);
      return { ok: false, detail: `${detail}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1e3, guarded, flip };
    }
    return {
      ok: v.ok,
      detail: `${detail}${flipNote(flip)}`,
      elapsed_s: (Date.now() - t0) / 1e3,
      guarded,
      flip,
      ...minted ? { leaseToken: token, leaseSession: sid, minted: true } : {}
    };
  }
  if (!SWAP_CMD) {
    return { ok: false, detail: `swap plane unconfigured: FADE_ORCHESTRATE_SWAP_CMD is unset (the host points it at the fleet gate; no path ships in the plugin)${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1e3, guarded, flip };
  }
  try {
    const dir = await mkdtemp(join2(tmpdir(), "fade-swap-"));
    const jobPath = join2(dir, "job.json");
    await writeFile(jobPath, JSON.stringify({ schema: "farol.job/1", engagement: "ENG-LOCAL-GPU", run: `omp-${Date.now()}`, task: "lane-swap", data_class: "internal", model: lane, swap: true, ...opts.lease ? { lease: true } : {} }));
    markOwnSwap(lane);
    const { code, stdout, stderr } = await runSwap(`${SWAP_CMD} '${jobPath}'`);
    clearOwnSwap(lane);
    const final = stdout.trim().split("\n").pop() ?? "";
    const text = `${stdout}${stderr}`.replace(/\s+/g, " ").trim();
    const ok = code === 0 && final === lane;
    return { ok, detail: ok ? `swap via ctl: ${lane}${flipNote(flip)}` : `swap ctl refused rc=${code}: ${text.length > 300 ? `${text.slice(0, 300)}...` : text}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1e3, guarded, flip };
  } catch (e) {
    return { ok: false, detail: `${msg(e)}${flipNote(flip)}`, elapsed_s: (Date.now() - t0) / 1e3, guarded, flip };
  }
}
var LANE_WAIT_MS = Number(process.env.FADE_ORCHESTRATE_LANE_WAIT_MS ?? 18e4);
var LANE_POLL_MS = Number(process.env.FADE_ORCHESTRATE_LANE_POLL_MS ?? 2e3);
var LANE_LEASE_TTL_SEC = Number(process.env.FADE_ORCHESTRATE_LANE_LEASE_TTL_SEC ?? 1800);
var START_PROOF_WAIT_MS = Number(process.env.FADE_ORCHESTRATE_START_PROOF_WAIT_MS ?? 24e4);
var LANE_KEEPALIVE_MS = Number(process.env.FADE_ORCHESTRATE_KEEPALIVE_MS ?? 1e4);
var SERVE_WAIT_MS = Number(process.env.FADE_ORCHESTRATE_SERVE_WAIT_MS ?? 9e5);
async function proveResident(target, opts = {}) {
  const sid = opts.sessionId ?? "fade-orchestrator";
  const waitMs = opts.waitMs ?? LANE_WAIT_MS;
  const pollMs = opts.pollMs ?? LANE_POLL_MS;
  const t0 = Date.now();
  let state = "unknown";
  let pack;
  let idn;
  for (; ; ) {
    const now = await supervisorResident(target, sid);
    state = now?.state ?? state;
    pack = now?.pack ?? pack;
    idn = await servedIdentity();
    if (now?.resident && idn?.id === target) break;
    if (Date.now() - t0 >= waitMs) break;
    const { promise: tick, resolve: tickDone } = Promise.withResolvers();
    setTimeout(tickDone, pollMs);
    await tick;
  }
  const waited_s = (Date.now() - t0) / 1e3;
  return { ok: state === "RESIDENT" && pack === target && idn?.id === target, state, pack, served_id: idn?.id, n_ctx: idn?.n_ctx, waited_s };
}
async function laneServeHold(wanted, opts = {}) {
  const served = opts.served ?? servedIdentity;
  const health = opts.health ?? laneHealth;
  const pollMs = opts.pollMs ?? Number(process.env.FADE_ORCHESTRATE_LANE_POLL_MS ?? LANE_POLL_MS);
  const waitMs = opts.waitMs ?? Number(process.env.FADE_ORCHESTRATE_SERVE_WAIT_MS ?? SERVE_WAIT_MS);
  const keepAliveMs = opts.keepAliveMs ?? Number(process.env.FADE_ORCHESTRATE_KEEPALIVE_MS ?? LANE_KEEPALIVE_MS);
  const t0 = Date.now();
  let polls = 0;
  let refreshes = 0;
  let nextRefreshAt = t0;
  for (; ; ) {
    if (opts.isCurrent?.() === false) return { ok: false, polls, refreshes, failed: false, waited_s: (Date.now() - t0) / 1e3, reason: "superseded request target" };
    const idn = await served();
    polls += 1;
    if (idn?.id === wanted) {
      return { ok: true, served_id: idn.id, polls, refreshes, failed: false, waited_s: (Date.now() - t0) / 1e3, reason: `${wanted} is the id the lane serves` };
    }
    if (Date.now() - t0 >= waitMs) {
      return {
        ok: false,
        ...idn?.id !== void 0 ? { served_id: idn.id } : {},
        polls,
        refreshes,
        failed: false,
        waited_s: (Date.now() - t0) / 1e3,
        reason: `the lane serves ${idn?.id ?? "nothing"}, not ${wanted}, after ${((Date.now() - t0) / 1e3).toFixed(1)}s`
      };
    }
    if (Date.now() >= nextRefreshAt) {
      const h = await health();
      refreshes += 1;
      nextRefreshAt = Date.now() + keepAliveMs;
      const verdict = serveVerdict(h);
      if (!verdict.serve && h !== void 0 && h.loading !== true) {
        return {
          ok: false,
          ...idn?.id !== void 0 ? { served_id: idn.id } : {},
          polls,
          refreshes,
          failed: true,
          waited_s: (Date.now() - t0) / 1e3,
          reason: `${wanted} did not come up: ${verdict.reason} \u2014 the 503 class, not a slow swap`
        };
      }
      const pct = typeof h?.percent === "number" ? Math.round(h.percent) : void 0;
      opts.progress?.(`fade_orchestrate: ${wanted} is not serving yet (the lane answers ${idn?.id ?? "nothing"})${pct !== void 0 ? ` ${pct}%` : ""} \u2014 this request waits, it does not time out`, pct);
    }
    const { promise: tick, resolve: tickDone } = Promise.withResolvers();
    setTimeout(tickDone, pollMs);
    await tick;
  }
}
function isServedLane(id) {
  return id === CODE_LANE || id === THINK_LANE || id === VERIFY_LANE;
}
var statusOf = (m) => {
  const s = m.status;
  return typeof s === "object" && s !== null ? String(s.value ?? "") : String(s ?? "");
};
async function servedIdentity(timeoutMs = 4e3) {
  try {
    const r = await fetch(`${process.env.FADE_ORCHESTRATE_ROUTER ?? ROUTER}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return void 0;
    const listing = await r.json();
    const rows = listing?.data ?? [];
    const hit = rows.find((m) => statusOf(m) === "loaded") ?? rows.find((m) => statusOf(m) === "");
    if (!hit) return void 0;
    const meta = hit.meta;
    return { id: String(hit.id ?? hit.model ?? "?"), n_ctx: typeof meta?.n_ctx === "number" ? meta.n_ctx : void 0 };
  } catch {
    return void 0;
  }
}
async function moveLane(target, opts = {}) {
  const sid = opts.sessionId ?? "fade-orchestrator";
  const waitMs = opts.waitMs ?? LANE_WAIT_MS;
  const pollMs = opts.pollMs ?? LANE_POLL_MS;
  const flip = await observeSwaps();
  if (flipBreaker(flip)) {
    return {
      ok: false,
      detail: `refused at the churn guard: ${flip.flips} swaps in ${flip.window_s}s, requests naming ${flip.competing.join(", ") || "the other lane"} \u2014 no lease, no swap byte issued; move the lane by hand if that is the plan`,
      waited_s: 0,
      flip
    };
  }
  const t0 = Date.now();
  const sup = await supervisorResident(target, sid);
  if (sup?.resident) {
    const idn = await servedIdentity();
    const ok = idn?.id === target;
    return {
      ok,
      detail: ok ? `${target} resident (${sup.detail}); router id ${idn.id}${idn.n_ctx ? ` n_ctx ${idn.n_ctx}` : ""}` : `daemon says RESIDENT pack=${target} but the router serves ${idn?.id ?? "nothing"} \u2014 the pack did not answer on the lane port`,
      resident: sup.pack,
      served_id: idn?.id,
      n_ctx: idn?.n_ctx,
      waited_s: (Date.now() - t0) / 1e3,
      flip
    };
  }
  const r = await loadLane(target, { mintLease: { ttlSec: LANE_LEASE_TTL_SEC }, sessionId: sid });
  if (!r.ok) return { ok: false, detail: r.detail, waited_s: (Date.now() - t0) / 1e3, flip: r.flip };
  const handBack = async () => {
    if (!r.minted || !r.leaseToken) return false;
    try {
      const rel = await releaseLease(r.leaseToken, r.leaseSession ?? sid);
      return rel.ok;
    } catch {
      return false;
    }
  };
  const proof = await proveResident(target, { sessionId: sid, waitMs, pollMs });
  const returned = await handBack();
  if (proof.ok) {
    return {
      ok: true,
      detail: `${target} resident in ${proof.waited_s.toFixed(1)}s; router id ${proof.served_id}${proof.n_ctx ? ` n_ctx ${proof.n_ctx}` : ""} \u2014 requests naming any other id answer 404 until the roles move${flipNote(flip)}`,
      resident: proof.pack,
      served_id: proof.served_id,
      n_ctx: proof.n_ctx,
      waited_s: proof.waited_s,
      flip,
      ...r.minted ? { lease_returned: returned } : {}
    };
  }
  return {
    ok: false,
    detail: `${target} not proven resident after ${proof.waited_s.toFixed(1)}s: daemon state ${proof.state} pack ${proof.pack ?? "none"}, router id ${proof.served_id ?? "nothing"} \u2014 hand the lane back with \`/lane flash-next\`${flipNote(flip)}`,
    resident: proof.pack,
    served_id: proof.served_id,
    n_ctx: proof.n_ctx,
    waited_s: proof.waited_s,
    flip,
    ...r.minted ? { lease_returned: returned } : {}
  };
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
function switchPlan(resident, lane) {
  if (resident === lane) return { gate: false, load: false, reason: `already resident: ${lane}; no load to gate` };
  return { gate: true, load: true, reason: `${lane} is not resident${resident ? ` (resident: ${resident})` : " (the router names no loaded entry)"}: gate, then swap` };
}
var ownSwapTo = /* @__PURE__ */ new Map();
function markOwnSwap(to) {
  ownSwapTo.set(to, Date.now());
}
function clearOwnSwap(to) {
  ownSwapTo.delete(to);
}
async function observeSwaps(windowMs = FLIP_WINDOW_MS) {
  const h = await laneHealth();
  const s = h?.swap;
  const now = Date.now();
  for (const [k, v] of ownSwapTo) if (v < now - windowMs) ownSwapTo.delete(k);
  if (s && s.to) {
    const sig = `${s.from ?? "?"}->${s.to}`;
    if (sig !== lastSwapSig) {
      if (ownSwapTo.delete(s.to)) {
      } else swapLog.push({ from: s.from ?? "?", to: s.to, at: Date.now(), waiting: finite(s.waiting) });
    }
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
var LANE_ON_VERIFY = process.env.FADE_ORCHESTRATE_LANE_ON_VERIFY !== "off";
var VERIFY_IN_OPS = (process.env.FADE_ORCHESTRATE_VERIFY_IN_OPS ?? "report,review").split(",").map((s) => s.trim()).filter(Boolean);
var VERIFY_OUT_OPS = (process.env.FADE_ORCHESTRATE_VERIFY_OUT_OPS ?? "intake,abort").split(",").map((s) => s.trim()).filter(Boolean);
var VERIFY_AGENTS = (process.env.FADE_ORCHESTRATE_VERIFY_AGENTS ?? "reviewer,frontier-reviewer").split(",").map((s) => s.trim()).filter(Boolean);
function verifyTrigger(toolName, input, verify = VERIFY_LANE, code = CODE_LANE) {
  if (!LANE_ON_VERIFY) return { none: "FADE_ORCHESTRATE_LANE_ON_VERIFY=off" };
  const name = toolName ?? "";
  const op = typeof input?.op === "string" ? input.op : "";
  if (name === "frontier") {
    if (VERIFY_IN_OPS.includes(op)) return { lane: verify, reason: `frontier op=${op} asks for the verdict \u2014 the advisor lane answers it` };
    if (VERIFY_OUT_OPS.includes(op)) return { lane: code, reason: `frontier op=${op} is coding work resuming` };
    return { none: `frontier op=${op || "?"} is not a verdict act` };
  }
  if (name === "task") {
    const kinds = /* @__PURE__ */ new Set();
    const direct = typeof input?.agent === "string" ? input.agent.split(":")[0] : "";
    if (direct) kinds.add(direct);
    for (const key2 of ["items", "list"]) {
      const rows = input?.[key2];
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        if (!r || typeof r !== "object") continue;
        const rec = r;
        const scan = [rec];
        if (Array.isArray(rec.items)) {
          for (const it of rec.items) {
            if (it && typeof it === "object") scan.push(it);
          }
        }
        for (const row of scan) {
          for (const k of ["agent", "kind", "role"]) {
            const v = row[k];
            if (typeof v === "string") kinds.add(v.split(":")[0]);
          }
        }
      }
    }
    const hit = [...kinds].filter((k) => VERIFY_AGENTS.includes(k));
    if (hit.length) return { lane: verify, reason: `task carries ${hit.join(", ")} \u2014 verification runs on the advisor lane` };
    return { none: `task names ${[...kinds].join(", ") || "no agent kind"}: not a verification agent` };
  }
  return { none: `${name || "tool"} is not a verdict surface` };
}

// src/lane-session.ts
var MUTATING_TOOLS = { edit: true, write: true, apply_patch: true, multiedit: true, multi_edit: true, notebook_edit: true };
var key = Symbol.for("fade.lane-session.v1");
var globals = globalThis;
var sessions = globals[key] ??= /* @__PURE__ */ new Map();
function createLaneSession(host, options = {}) {
  const wait = options.wait ?? laneServeHold;
  const local = { generation: 0, serial: Promise.resolve() };
  const stateFor = (ctx) => {
    const id = ctx.sessionManager?.getSessionId?.();
    if (!id) return local;
    let state = sessions.get(id);
    if (!state) {
      state = { generation: 0, serial: Promise.resolve() };
      sessions.set(id, state);
    }
    return state;
  };
  const pin = async (ctx, pack) => {
    const id = packToModelId(pack);
    if (!isServedLane(id)) throw new Error(`unconfigured lane ${id}`);
    const model = ctx.modelRegistry.find(PROVIDER, id);
    if (!model) throw new Error(`model ${PROVIDER}/${id} is not in the registry`);
    const state = stateFor(ctx);
    const generation = ++state.generation;
    const job = state.serial.catch(() => void 0).then(async () => {
      if (generation !== state.generation) return false;
      const switched = await host.setModel(model);
      if (switched !== true && !(typeof switched === "object" && switched !== null && switched.switched === true))
        throw new Error(`setModel(${PROVIDER}/${id}) did not switch`);
      if (generation !== state.generation) return false;
      host.setThinkingLevel(THINKING[id]);
      const settings = host.pi?.settings;
      if (settings) {
        for (const [role, selector] of Object.entries(settings.getModelRoles())) {
          if (typeof selector !== "string" || !selector.startsWith(`${PROVIDER}/`)) continue;
          const current = selector.slice(PROVIDER.length + 1).split(":")[0];
          if (isServedLane(current)) await settings.setModelRole(role, `${PROVIDER}/${id}`);
        }
      }
      if (host.getActiveTools && host.setActiveTools) {
        const active = host.getActiveTools();
        state.phaseTool ??= options.phaseTool;
        let next;
        if (isThinkingLane(id)) {
          state.tools ??= [...active];
          next = active.filter((t) => MUTATING_TOOLS[t] !== true && t !== state.phaseTool);
          if (options.phaseTool) next.push(options.phaseTool);
        } else {
          next = [.../* @__PURE__ */ new Set([...state.tools ?? [], ...active])].filter((t) => !state.phaseTool || t !== state.phaseTool);
        }
        if (next.length !== active.length || next.some((t) => !active.includes(t))) await host.setActiveTools(next);
        if (id === CODE_LANE) {
          state.tools = void 0;
          state.phaseTool = void 0;
        }
      }
      state.target = id;
      state.failure = void 0;
      return true;
    });
    state.serial = job;
    try {
      return await job;
    } catch (error) {
      if (generation === state.generation) {
        state.failure = String(error);
        ctx.abort?.();
      }
      throw error;
    }
  };
  const ready = async (ctx, target, opts = {}) => {
    let painted = false;
    try {
      return await wait(target, { ...opts, progress: (message, percent) => {
        painted = true;
        ctx.ui.setWorkingMessage(message);
        opts.progress?.(message, percent);
      } });
    } finally {
      if (painted) ctx.ui.setWorkingMessage();
    }
  };
  const beforeRequest = async (ctx, event) => {
    if (ctx.model?.provider !== PROVIDER) return;
    const payload = event?.payload;
    const wire = typeof payload?.model === "string" ? packToModelId(payload.model) : ctx.model.id;
    if (!isServedLane(wire)) return;
    const state = stateFor(ctx);
    for (; ; ) {
      await state.serial.catch(() => void 0);
      if (ctx.signal?.aborted) return;
      if (state.failure) {
        ctx.abort?.();
        ctx.ui.notify(`lane settings are unavailable: ${state.failure}; request stopped`, "warning");
        return;
      }
      const generation = state.generation;
      const target = state.target ?? wire;
      const result = await ready(ctx, target, { isCurrent: () => generation === state.generation && !ctx.signal?.aborted });
      if (ctx.signal?.aborted) return;
      if (generation !== state.generation) continue;
      if (!result.ok) {
        ctx.abort?.();
        ctx.ui.notify(`lane ${target} is unavailable: ${result.reason}; request stopped`, "warning");
        return;
      }
      if (payload && target !== wire) return { ...payload, model: target };
      return;
    }
  };
  return { pin, ready, beforeRequest };
}

// src/index.ts
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync as mkdirSync3, readFileSync as readFileSync5, unlinkSync as unlinkSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { basename as basename2, dirname as dirname2, join as join10 } from "node:path";
import { readFile as readFile3, stat as stat3 } from "node:fs/promises";
import { Type } from "typebox";

// src/lane.ts
import { execFile } from "node:child_process";
import { readFileSync as readFileSync2 } from "node:fs";
import { promisify as promisify2 } from "node:util";

// src/subagent.ts
var VERIFIER_AGENT = process.env.FADE_ORCHESTRATE_VERIFIER_AGENT ?? "fade-verifier";
var VERIFIER_MODEL = process.env.FADE_ORCHESTRATE_VERIFIER_MODEL ?? "ninfer-local/coder-gpu1";
var ROUTER_ENTRIES = [CODE_LANE, THINK_LANE, VERIFY_LANE, PROVIDER].map((s) => s.toLowerCase());
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
  return { route: "swap", reason: `no churn: one ${VERIFY_LANE} load addresses the whole batch`, flips: flip.flips };
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
var WORKER_AGENT = process.env.FADE_ORCHESTRATE_WORKER_AGENT ?? "fade-worker";
function workerAgentMd(agent = WORKER_AGENT) {
  return [
    "---",
    `name: ${agent}`,
    "description: A delegated worker of the fade orchestrator: does one slice, then registers its own acceptance on the verification desk and waits for the verdict.",
    "tools: read, grep, glob, bash, ls, write, edit, fade_verify",
    "---",
    "",
    `You are one **worker** of a fade orchestrated run. You own the slice you were handed, and you`,
    "verify your OWN acceptance line \u2014 never another worker's slice, and never the whole run.",
    "",
    "- Do the slice, then run the acceptance commands your task names, in the session cwd.",
    "- Call `fade_verify` ONCE with: `objective` (the slice in one line), `acceptance` (the exact",
    "  command and what it must print), `checks` (rows of [command, expected]), `files` (paths you",
    "  touched), and `task_id` when your task names one.",
    "- The tool answers with a request id (`V<batch>.<n>`). **Quote that id in your final message** \u2014",
    "  it is the handle the verdict comes back on. The tool blocks until the verdict is posted, so",
    "  do not answer before it returns; a `deferred` answer says the batch is still open, so report",
    "  the id and the queue position, not a verdict you invented.",
    "- NEVER call `fade_phase`, switch a model, touch the router (`/v1/load`), or post a verdict:",
    "  the owner run claims the batch and answers it. A worker that certifies its own slice is the",
    "  self-certification this desk exists to prevent.",
    "- Data files (parquets, duckdb, `data/`) are read-only.",
    ""
  ].join("\n");
}
var workerAgentPath = (repo, agent = WORKER_AGENT) => `.omp/agents/${agent}.md`;
function routeLine(route) {
  return route.route === "subagent" ? `verification \u2192 ${VERIFIER_AGENT} on ${VERIFIER_MODEL} \xB7 zero lane loads` : `verification \u2192 ${VERIFY_LANE} lane \xB7 one load (${THINKING[VERIFY_LANE] ?? "high"} thinking)`;
}

// src/lane.ts
var execFileAsync = promisify2(execFile);
var PROBE_TIMEOUT_MS = Number(process.env.FADE_ORCHESTRATE_LANE_PROBE_TIMEOUT_MS ?? 8e3);
var PROBE_CACHE_MS = Number(process.env.FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS ?? 15e3);
var strip = (v) => {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length > 1) return t.slice(1, -1).replace(/\\"/g, '"');
  if (t.startsWith("'") && t.endsWith("'") && t.length > 1) return t.slice(1, -1);
  return t;
};
var unquoteKey = (k) => k.replace(/^["']|["']$/g, "");
function parseProviderBlocks(yml) {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => /^providers:\s*$/.test(l));
  if (start < 0) return [];
  const blocks = [];
  let current;
  let entryIndent = -1;
  let sub;
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*#/.test(raw) || raw.trim() === "") continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) break;
    const body = raw.trim();
    const dash = /^-\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(body);
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(body);
    const bare = /^-\s*(.+)$/.exec(body);
    const key2 = dash ? dash[1] : kv ? kv[1] : "";
    const value = strip(dash ? dash[2] ?? "" : kv ? kv[2] ?? "" : bare ? bare[1] : "");
    const opensProvider = kv && value === "" && key2 !== "models" && key2 !== "headers" && key2 !== "compat" && (entryIndent < 0 || indent <= entryIndent) || dash && key2 === "id" && value !== "" && (entryIndent < 0 || indent <= entryIndent);
    if (opensProvider) {
      entryIndent = indent;
      current = { id: unquoteKey(dash ? value : key2), api: "openai-completions", headers: {}, models: [] };
      blocks.push(current);
      sub = void 0;
      continue;
    }
    if (!current) continue;
    if (sub && indent > sub.indent) {
      if (sub.name === "models") {
        if (bare) {
          const id = unquoteKey(strip(/^-\s*(?:id:\s*)?(.+)$/.exec(body)?.[1] ?? ""));
          if (id && id !== "[]") current.models.push(id);
        }
      } else {
        const hk = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(body.replace(/^-\s*/, ""));
        if (hk) current.headers[unquoteKey(hk[1])] = strip(hk[2] ?? "");
      }
      continue;
    }
    if (!kv) continue;
    sub = void 0;
    if (value === "") {
      const next = lines.slice(i + 1).find((l) => l.trim() !== "" && !/^\s*#/.test(l));
      const nextIndent = next ? next.length - next.trimStart().length : -1;
      if (nextIndent > indent && (key2 === "models" || key2 === "headers")) sub = { name: key2, indent };
      continue;
    }
    if (key2 === "baseUrl") current.baseUrl = value;
    else if (key2 === "api") current.api = value;
    else if (key2 === "apiKey") current.apiKey = value;
    else if (key2 === "authHeader") current.authHeader = value === "true";
  }
  return blocks;
}
function splitSpec(spec) {
  const i = spec.indexOf("/");
  return i < 0 ? { provider: "", model: spec } : { provider: spec.slice(0, i), model: spec.slice(i + 1) };
}
function resolveLaneSpec(spec, yml, env) {
  const { provider, model } = splitSpec(spec);
  const fromEnv = env.FADE_ORCHESTRATE_VERIFIER_BASE_URL?.trim();
  if (fromEnv) {
    return {
      spec: {
        spec,
        provider,
        model,
        baseUrl: fromEnv.replace(/\/$/, ""),
        api: env.FADE_ORCHESTRATE_VERIFIER_API?.trim() || "openai-completions",
        apiKey: env.FADE_ORCHESTRATE_VERIFIER_API_KEY?.trim() || void 0,
        authHeader: true,
        headers: {},
        source: "env"
      }
    };
  }
  if (!yml) return { error: `${spec}: no baseUrl and no ~/.omp/agent/models.yml, so the verifier lane cannot be resolved, let alone proved live (set FADE_ORCHESTRATE_VERIFIER_BASE_URL to a real server)` };
  const want = provider || void 0;
  const blocks = parseProviderBlocks(yml);
  const block = blocks.find((b) => want ? b.id === want : b.models.includes(model));
  if (!block) return { error: `${spec}: provider ${want ?? "(any)"} is not in models.yml` };
  if (!block.baseUrl) return { error: `${spec}: provider ${block.id} declares no baseUrl` };
  if (block.models.length > 0 && !block.models.includes(model)) {
    return { error: `${spec}: provider ${block.id} advertises ${block.models.slice(0, 6).join(", ")}${block.models.length > 6 ? ", \u2026" : ""}, not ${model}` };
  }
  const key2 = block.apiKey ?? "";
  const isCmd = key2.startsWith("!");
  return {
    spec: {
      spec,
      provider: block.id,
      model,
      baseUrl: block.baseUrl.replace(/\/$/, ""),
      api: block.api ?? "openai-completions",
      apiKey: isCmd ? void 0 : key2 || void 0,
      apiKeyCommand: isCmd ? key2.slice(1).trim() : void 0,
      authHeader: block.authHeader === true,
      headers: block.headers,
      source: "models.yml"
    }
  };
}
function substituteEnv(value, env) {
  let missing = false;
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
    const v = env[a ?? b];
    if (v === void 0 || v === "") missing = true;
    return v ?? "";
  });
  return missing ? void 0 : out;
}
function fieldOf(payload, key2) {
  return key2 in payload ? Reflect.get(payload, key2) : void 0;
}
function advertisedIds(payload) {
  if (!payload || typeof payload !== "object") return [];
  const data = fieldOf(payload, "data");
  if (!Array.isArray(data)) return [];
  const ids = [];
  for (const m of data) {
    if (!m || typeof m !== "object") continue;
    const id = fieldOf(m, "id") ?? fieldOf(m, "model");
    if (typeof id === "string" && id !== "") ids.push(id);
  }
  return ids;
}
function answered(status, payload) {
  if (status !== 200 || !payload || typeof payload !== "object") return false;
  for (const key2 of ["choices", "content", "output"]) {
    const v = fieldOf(payload, key2);
    if (v !== void 0) return Array.isArray(v) && v.length > 0;
  }
  return true;
}
var completionRequest = (api, model) => api === "anthropic-messages" ? { path: "/messages", body: { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] } } : { path: "/chat/completions", body: { model, max_tokens: 1, temperature: 0, stream: false, messages: [{ role: "user", content: "ping" }] } };
async function runKeyCommand(command, runShell, timeoutMs) {
  const shell = runShell ?? (async (cmd, ms) => {
    const r = await execFileAsync("/bin/bash", ["-lc", cmd], { timeout: ms, maxBuffer: 1 << 20, encoding: "utf8" });
    return { code: 0, out: r.stdout };
  });
  try {
    const r = await shell(command, timeoutMs);
    const key2 = r.out.trim();
    if (r.code !== 0) return { detail: `the lane's key command exited ${r.code}` };
    if (!key2) return { detail: "the lane's key command printed no key" };
    return { key: key2, detail: "key ok" };
  } catch (e) {
    return { detail: `the lane's key command failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
async function probeLane(spec, deps = {}) {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const t0 = now();
  const timeoutMs = PROBE_TIMEOUT_MS;
  let note = "";
  const fail = (detail) => ({ ok: false, detail: `${detail}${note}`, at: t0, ms: now() - t0 });
  const headers = { "content-type": "application/json" };
  if (spec.apiKeyCommand) {
    const k = await runKeyCommand(spec.apiKeyCommand, deps.runShell, timeoutMs);
    if (!k.key) return fail(k.detail);
    if (spec.authHeader) headers.authorization = `Bearer ${k.key}`;
    else headers["x-api-key"] = k.key;
  } else if (spec.apiKey) {
    if (spec.authHeader) headers.authorization = `Bearer ${spec.apiKey}`;
    else headers["x-api-key"] = spec.apiKey;
  }
  const dropped = [];
  for (const [name, decl] of Object.entries(spec.headers)) {
    const v = substituteEnv(decl, env);
    if (v === void 0) dropped.push(`${name}: ${decl}`);
    else headers[name] = v;
  }
  if (dropped.length > 0) note = `; sent without ${dropped.join(", ")}`;
  try {
    const r = await fetchImpl(`${spec.baseUrl}/models`, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) {
      const ids = advertisedIds(await r.json().catch(() => null));
      if (ids.length > 0 && !ids.includes(spec.model)) return fail(`${spec.baseUrl}/models advertises ${ids.slice(0, 6).join(", ")} \u2014 not ${spec.model}`);
    }
  } catch {
  }
  const { path, body } = completionRequest(spec.api, spec.model);
  let res;
  try {
    res = await fetchImpl(`${spec.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return fail(`${spec.baseUrl}${path} refused: ${e instanceof Error ? e.message : String(e)}`);
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const shown2 = payload !== null ? JSON.stringify(payload).slice(0, 160) : await res.text().then((t) => t.slice(0, 160)).catch(() => "");
    return fail(`${spec.baseUrl}${path} \u2192 http ${res.status} for model ${spec.model}: ${shown2}`);
  }
  if (!answered(res.status, payload)) return fail(`${spec.baseUrl}${path} \u2192 http 200 with no completion for model ${spec.model}`);
  return { ok: true, detail: `${spec.baseUrl}${path} answered model ${spec.model}${note}`, at: t0, ms: now() - t0 };
}
var cache = /* @__PURE__ */ new Map();
function readModelsYml(env = process.env) {
  const home = env.HOME;
  if (!home) return null;
  try {
    return readFileSync2(`${home}/.omp/agent/models.yml`, "utf8");
  } catch {
    return null;
  }
}
async function probeVerifierLane(deps = {}) {
  const env = deps.env ?? process.env;
  const model = env.FADE_ORCHESTRATE_VERIFIER_MODEL ?? "ninfer-local/coder-gpu1";
  const now = deps.now ?? Date.now;
  const ttl = Number(env.FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS ?? PROBE_CACHE_MS);
  if (ttl <= 0) return { ok: true, skipped: true, detail: "probing disabled (FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS=0)", at: now(), ms: 0 };
  const hit = cache.get(model);
  if (hit && now() - hit.at < ttl) return hit;
  if (isRouterModel(model)) return { ok: false, detail: `${model} is a ROUTER entry: probing it pays the very swap the subagent route exists to avoid, so the zero-swap route is refused`, at: now(), ms: 0 };
  const resolved = resolveLaneSpec(model, deps.yml !== void 0 ? deps.yml : readModelsYml(env), env);
  if ("error" in resolved) {
    const miss = { ok: false, detail: resolved.error, at: now(), ms: 0 };
    cache.set(model, miss);
    return miss;
  }
  const r = await probeLane(resolved.spec, { ...deps, env });
  cache.set(model, r);
  return r;
}
function probeLabel(r) {
  const age = Math.round((Date.now() - r.at) / 1e3 * 10) / 10;
  return r.skipped ? r.detail : `${r.detail} (${Math.round(r.ms)}ms, read ${age}s ago)`;
}

// src/thinklane.ts
var THINK_MODEL = process.env.FADE_ORCHESTRATE_THINK_MODEL ?? `${PROVIDER}/${THINK_LANE}`;
var ASK_TIMEOUT_MS = Number(process.env.FADE_ORCHESTRATE_THINK_TIMEOUT_MS ?? 18e4);
var ASK_MAX_TOKENS = Number(process.env.FADE_ORCHESTRATE_THINK_MAX_TOKENS ?? 2048);
var THINK_PROBE_CACHE_MS = Number(process.env.FADE_ORCHESTRATE_THINK_PROBE_CACHE_MS ?? 15e3);
var isRouterEndpoint = (baseUrl) => baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "").toLowerCase() === ROUTER.replace(/\/+$/, "").toLowerCase();
var field = (o, k) => o && typeof o === "object" ? Reflect.get(o, k) : void 0;
var textOfContent = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => typeof field(p, "text") === "string" ? field(p, "text") : "").join("");
  return "";
};
function answerText(api, payload) {
  if (api === "anthropic-messages") {
    const parts = field(payload, "content");
    return { text: Array.isArray(parts) ? textOfContent(parts) : "", reasoning: 0 };
  }
  const choices = field(payload, "choices");
  const first = Array.isArray(choices) && choices.length > 0 ? choices[0] : void 0;
  const message = field(first, "message");
  const content = textOfContent(field(message, "content"));
  const reasoning = field(message, "reasoning_content");
  const finish = field(first, "finish_reason");
  return {
    text: content,
    reasoning: typeof reasoning === "string" ? reasoning.length : 0,
    ...typeof finish === "string" ? { finish } : {}
  };
}
function resolveAskSpec(model, deps = {}) {
  const env = deps.env ?? process.env;
  const { FADE_ORCHESTRATE_VERIFIER_BASE_URL: _b, FADE_ORCHESTRATE_VERIFIER_API: _a, FADE_ORCHESTRATE_VERIFIER_API_KEY: _k, ...rest } = env;
  return resolveLaneSpec(model, deps.yml !== void 0 ? deps.yml : readModelsYml(env), rest);
}
async function authHeaders(spec, env, deps) {
  const headers = { "content-type": "application/json" };
  if (spec.apiKeyCommand) {
    const k = await runKeyCommand(spec.apiKeyCommand, deps.runShell, 8e3);
    if (!k.key) return { headers: {}, note: `the lane's key command refused: ${k.detail}` };
    if (spec.authHeader) headers.authorization = `Bearer ${k.key}`;
    else headers["x-api-key"] = k.key;
  } else if (spec.apiKey) {
    if (spec.authHeader) headers.authorization = `Bearer ${spec.apiKey}`;
    else headers["x-api-key"] = spec.apiKey;
  }
  const dropped = [];
  for (const [name, decl] of Object.entries(spec.headers)) {
    const v = substituteEnv(decl, env);
    if (v === void 0) dropped.push(`${name}: ${decl}`);
    else headers[name] = v;
  }
  return { headers, note: dropped.length > 0 ? `; sent without ${dropped.join(", ")}` : "" };
}
async function askLane(model, prompt, opts = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const t0 = now();
  const timeoutMs = opts.timeoutMs ?? ASK_TIMEOUT_MS;
  const finish = (r) => ({ ...r, ms: now() - t0, at: t0 });
  const resolved = resolveAskSpec(model, deps);
  if ("error" in resolved) {
    return finish({ ok: false, text: "", cls: "spec_unresolved", endpoint: "", model, detail: resolved.error });
  }
  const spec = resolved.spec;
  const endpoint = `${spec.baseUrl}${completionRequest(spec.api, spec.model).path}`;
  if (isRouterEndpoint(spec.baseUrl)) {
    const resident = deps.resident !== void 0 ? deps.resident : await (deps.lanes ?? residentLane)();
    if (resident !== spec.model) {
      return finish({
        ok: false,
        text: "",
        cls: "lane_not_resident",
        endpoint,
        model: spec.model,
        detail: `${spec.model} is NOT the resident lane on the router (${ROUTER}; resident ${resident ?? "unknown"}) \u2014 the router answers a request naming a non-resident model by SWAPPING the lane, so this in-process call sends zero bytes. Point FADE_ORCHESTRATE_THINK_MODEL at the resident entry, at a provider on its own port, or take the swap route the authorized loop pays.`
      });
    }
  }
  const { headers, note } = await authHeaders(spec, env, deps);
  if (spec.apiKeyCommand && !headers.authorization && !headers["x-api-key"]) {
    return finish({ ok: false, text: "", cls: "endpoint_unreachable", endpoint, model: spec.model, detail: `${note.replace(/^; /, "")} \u2014 no request sent to ${endpoint}` });
  }
  const session = opts.role && opts.role !== "" ? opts.role : `role:${spec.model}`;
  headers["x-session-id"] = session;
  const base = completionRequest(spec.api, spec.model).body;
  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });
  const body = {
    ...base,
    model: spec.model,
    session_id: session,
    max_tokens: opts.maxTokens ?? ASK_MAX_TOKENS,
    messages
  };
  if (spec.api === "anthropic-messages") {
    if (opts.system) body.system = opts.system;
  } else {
    body.temperature = opts.temperature ?? 0;
    body.stream = false;
    if (opts.thinking) body.reasoning_effort = opts.thinking;
  }
  let res;
  try {
    res = await fetchImpl(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const line = e instanceof Error ? e.message : String(e);
    if (name === "TimeoutError" || name === "AbortError") {
      return finish({ ok: false, text: "", cls: "timeout", endpoint, model: spec.model, detail: `${endpoint} answered no completion in ${Math.round(timeoutMs / 1e3)}s \u2014 the lane is busy, loading, or wedged; no load and no swap was issued` });
    }
    return finish({ ok: false, text: "", cls: "endpoint_unreachable", endpoint, model: spec.model, detail: `${endpoint} refused: ${line} \u2014 an endpoint on its own port does not move the router's lane; nothing was loaded${note}` });
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const shown2 = payload !== null ? JSON.stringify(payload).slice(0, 200) : await res.text().then((t) => t.slice(0, 200)).catch(() => "");
    return finish({ ok: false, text: "", cls: "http_error", endpoint, model: spec.model, detail: `${endpoint} \u2192 http ${res.status} for model ${spec.model}: ${shown2}${note}` });
  }
  const { text, reasoning, finish: stop } = answerText(spec.api, payload);
  if (text.trim() === "") {
    const why = reasoning > 0 ? `: ${reasoning} chars of REASONING and NO answer text \u2014 the budget was spent inside the thinking channel${stop === "length" ? " (finish_reason length)" : ""}; raise max_tokens (FADE_ORCHESTRATE_THINK_MAX_TOKENS) for this lane` : `: ${payload !== null ? JSON.stringify(payload).slice(0, 200) : "no json"}`;
    return finish({ ok: false, text: "", cls: "no_completion", endpoint, model: spec.model, detail: `${endpoint} \u2192 http 200 with NO completion text for model ${spec.model}${stop ? ` (finish_reason ${stop})` : ""}${why}${note}` });
  }
  return finish({
    ok: true,
    text,
    cls: "ok",
    endpoint,
    model: spec.model,
    detail: `${endpoint} answered model ${spec.model}: ${text.length} chars${reasoning > 0 ? ` (+${reasoning} reasoning)` : ""}${stop === "length" ? " \xB7 TRUNCATED at the token budget (finish_reason length) \u2014 raise max_tokens" : ""}${note}`,
    ...reasoning > 0 ? { reasoning_chars: reasoning } : {}
  });
}
function askLabel(r) {
  return `${r.model} ${r.ok ? `answered ${r.text.length} chars in ${(r.ms / 1e3).toFixed(1)}s` : `REFUSED ${r.cls}`} \xB7 ${r.endpoint || "no endpoint resolved"}`;
}

// src/recovery.ts
import { readdir, readFile } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { basename, join as join3, resolve } from "node:path";
async function readFrontierPhase(sessionId, root) {
  if (!sessionId || basename(sessionId) !== sessionId) return void 0;
  const override = process.env.OMP_FRONTIER_ROOT?.trim();
  const directory = join3(root ?? (override ? resolve(override) : join3(homedir2(), ".omp", "frontier")), sessionId);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    return error.code === "ENOENT" ? "none" : void 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const task = JSON.parse(await readFile(join3(directory, entry.name, "task.json"), "utf8"));
      if (typeof task?.taskId === "string" && typeof task.rounds === "number" && typeof task.phase === "string" && frontierIsActive(task.phase)) return task.phase;
    } catch {
    }
  }
  return "none";
}
function frontierPhase(details) {
  const frontier = details && typeof details === "object" && "frontier" in details ? details.frontier : void 0;
  const phase = frontier && typeof frontier === "object" && "phase" in frontier ? frontier.phase : void 0;
  return typeof phase === "string" ? phase : void 0;
}
function frontierPhaseFromHistory(entries) {
  for (const entry of [...entries].reverse()) {
    if (!entry || typeof entry !== "object" || !("message" in entry)) continue;
    const message = entry.message;
    if (!message || typeof message !== "object" || !("toolName" in message) || message.toolName !== "frontier") continue;
    const phase = frontierPhase("details" in message ? message.details : void 0);
    if (phase !== void 0) return phase;
  }
  return void 0;
}
function frontierIsActive(phase) {
  return phase !== void 0 && !["none", "done", "denied", "aborted"].includes(phase);
}
function queueHandover(options) {
  let canceled = false;
  let timer;
  let reportedError = false;
  const current = () => !canceled && options.isCurrent();
  const schedule = () => {
    if (!current()) return;
    timer = setTimeout(() => void attempt(), options.delayMs ?? 250);
    timer.unref();
  };
  const attempt = async () => {
    if (!current()) return;
    try {
      if (!options.isIdle()) {
        schedule();
        return;
      }
      const message = await options.build();
      if (!current()) return;
      if (!options.isIdle()) {
        schedule();
        return;
      }
      options.deliver(message);
    } catch (error) {
      if (!current()) return;
      if (!reportedError) {
        reportedError = true;
        options.onError(error);
      }
      schedule();
      return;
    }
    canceled = true;
    options.onDelivered();
  };
  schedule();
  return () => {
    canceled = true;
    clearTimeout(timer);
  };
}

// src/desk.ts
import { join as join5 } from "node:path";

// src/core.ts
import { execFile as execFile2, execFileSync } from "node:child_process";
import { promisify as promisify3 } from "node:util";
import { closeSync, fsyncSync, mkdirSync as mkdirSync2, openSync, readFileSync as readFileSync3, renameSync as renameSync2, rmSync as rmSync2, unlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
import { mkdir, open, readFile as readFile2, rename, unlink } from "node:fs/promises";
import { homedir as homedir3, hostname } from "node:os";
import { isAbsolute, join as join4 } from "node:path";
var execFileAsync2 = promisify3(execFile2);
async function execGitAsync(repo, args, opts = {}) {
  const { stdout } = await execFileAsync2("git", ["-C", repo, ...args], {
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
      const r = await execFileAsync2("/bin/bash", ["-lc", cmd], { cwd, timeout: Math.min(12e4, remaining), maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
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
    ...run.gate_last?.triage ? [`Gate triage (ADVISORY, no authority \u2014 the gate's exit codes are the verdict; name the cause you actually confirm): ${run.gate_last.triage}`] : [],
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
function applyLaneDeferral(st, d, at = (/* @__PURE__ */ new Date()).toISOString()) {
  st.deferred_lane = d.lane;
  st.deferred_briefing = d.kind;
  st.deferred_since_utc = at;
  st.briefing_delivery = d.quiet ? "quiet" : "queued";
  st.lease_state = "deferred";
  st.lease_holder = d.holder;
  if (d.token_hint) st.lease_hint = d.token_hint;
  st.lease_retry_at_utc = new Date(Date.parse(at) + d.retry_delay_ms).toISOString();
  st.review_state = reviewStateLabel(st);
}
function clearLaneDeferral(st, lane, delivery, at = (/* @__PURE__ */ new Date()).toISOString()) {
  st.briefing_delivery = delivery;
  if (delivery === "sent") st.briefing_sent_at_utc = at;
  if (st.deferred_lane === lane) {
    st.deferred_lane = void 0;
    st.deferred_briefing = void 0;
    st.deferred_since_utc = void 0;
    st.lease_retry_at_utc = void 0;
  }
}
function reviewStateLabel(st) {
  if (st.state === "complete") return `accepted (round ${st.round})`;
  if (st.state === "verifying") return `verdicts open (round ${st.round}${st.verify_batch ? `, batch ${st.verify_batch.batch + 1}` : ""})`;
  if (st.state === "repair") return `repair owed (round ${st.round})`;
  if (st.state === "failed") return `FAILED: ${st.reason ?? "no reason recorded"}`;
  return `${st.state} (round ${st.round})`;
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
    return parseJson(await readFile2(path, "utf8"));
  } catch {
    return void 0;
  }
}
async function writeJsonAsync(path, value) {
  const dir = join4(path, "..");
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
  const dir = join4(path, "..");
  mkdirSync2(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync2(fd, `${JSON.stringify(value, null, 2)}
`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync2(tmp, path);
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
    const raw = JSON.parse(readFileSync3(join4(dir, LOCK_FILENAME), "utf8"));
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
  mkdirSync2(dir, { recursive: true });
  const path = join4(dir, LOCK_FILENAME);
  const claim = () => {
    const lock = { pid: process.pid, run_id: info.run_id, repo: info.repo, started: (/* @__PURE__ */ new Date()).toISOString(), host: hostname() };
    const fd = openSync(path, "wx");
    try {
      writeFileSync2(fd, `${JSON.stringify(lock)}
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
  rmSync2(path, { force: true });
  if (taken()) return { ok: true };
  const rival = readInstanceLock(dir) ?? holder ?? { pid: 0, run_id: "unknown", repo: info.repo, started: (/* @__PURE__ */ new Date()).toISOString(), host: hostname() };
  return { ok: false, holder: rival, stale: true };
}
function releaseInstanceLock(dir, pid = process.pid) {
  const holder = readInstanceLock(dir);
  if (!holder || holder.pid !== pid) return;
  try {
    unlinkSync(join4(dir, LOCK_FILENAME));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
function instanceLockDir(router = process.env.FADE_ORCHESTRATE_ROUTER ?? "http://127.0.0.1:18014") {
  if (process.env.FADE_ORCHESTRATE_LOCK_DIR) return process.env.FADE_ORCHESTRATE_LOCK_DIR;
  const slug = router.replace(/^[a-z]+:\/\//i, "").replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "") || "router";
  return join4(homedir3(), ".local", "state", "fade-orchestrator", slug);
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
  const key2 = (t) => JSON.stringify([t.id, t.objective, [...t.files].sort(), t.acceptance, [...t.dependencies].sort()]);
  const want = a.map(key2).sort();
  const got = b.map(key2).sort();
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
      section(
        "Delegated verification",
        `A slice handed to a \`task\` worker can verify ITSELF: launch it as agent "${WORKER_AGENT}", whose definition carries the \`fade_verify\` tool. Its request joins the desk, the batch closes when every worker the round launched has registered, and ONE verification pass answers the whole batch by id.`,
        `A worker launched on an agent whose tools do NOT carry \`fade_verify\` (a read-only reviewer, for example) runs its checks and cannot register; the census counted it, so the batch closes on the settle window instead of on its request \u2014 install the definition with \`/orchestrate verifier install\`.`
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
    const path = join4(run.repo, "var", "omp-orchestrate", STATE_FILENAME);
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
    const path = join4(run.repo, "var", "omp-orchestrate", STATE_FILENAME);
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
var deskPath = (dir) => join5(dir, DESK_DIRNAME, DESK_FILENAME);
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
var asRecord2 = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : void 0;
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
      const o = asRecord2(row);
      if (o && typeof o.cmd === "string") rows.push([o.cmd, str(o.expected, "exit 0")]);
    }
  }
  return rows;
}
function readRequest(v, batch) {
  const o = asRecord2(v);
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
  const verdict = asRecord2(o.verdict);
  if (verdict) req.verdict = { accepted: bool(verdict.accepted), notes: str(verdict.notes), at: str(verdict.at) };
  return req;
}
function parseDesk(v, runId) {
  const o = asRecord2(v);
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
      const row = asRecord2(a);
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
  const request2 = {
    id: `V${desk.epoch + 1}.${n}`,
    batch: desk.epoch,
    agent: req.agent,
    session: req.session,
    objective: req.objective,
    checks: checkRows(req.checks),
    enqueued_utc: at
  };
  if (req.task_id) request2.task_id = req.task_id;
  if (req.acceptance) request2.acceptance = req.acceptance;
  return {
    desk: { ...desk, requests: [...desk.requests, request2], agents: desk.agents.includes(req.agent) ? desk.agents : [...desk.agents, req.agent], updated_utc: at },
    request: request2,
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
function owedRequests(desk) {
  return desk.requests.filter((r) => r.claimed_batch !== void 0 && r.verdict === void 0);
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
  const { promise, resolve: resolve3 } = Promise.withResolvers();
  setTimeout(resolve3, ms);
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

// src/triage.ts
import { spawn } from "node:child_process";
var TRIAGE_BIN = process.env.FADE_ORCHESTRATE_GATE_TRIAGE_BIN ?? "grok";
var TRIAGE_TIMEOUT_MS = Number(process.env.FADE_ORCHESTRATE_GATE_TRIAGE_TIMEOUT_MS ?? 45e3);
var triageEnabled = (env = process.env) => env.FADE_ORCHESTRATE_GATE_TRIAGE !== "0";
var TAIL_CHARS = 900;
function triagePrompt(failing) {
  const rows = failing.map((r, i) => {
    const want = r.want && r.want !== "exit0" ? ` (declared: ${r.want})` : "";
    const tail = (r.tail ?? "").slice(0, TAIL_CHARS);
    return `${i + 1}. cmd: ${r.cmd}
   expected: ${r.expected}${want}
   tail:
${tail}`;
  });
  return [
    `A pre-swap verification gate is RED. These are its failing rows \u2014 the command, the plan's expectation, and the captured tail. Nothing here is invented and you have no tools: answer from this text alone.`,
    ``,
    rows.join("\n\n"),
    ``,
    `Answer in AT MOST two sentences, plain text, no markdown, no plan, no code block:`,
    `- the single most probable ROOT CAUSE, named concretely (the file/symbol/flag/config the tail points at), and`,
    `- the ONE command the coder should run first to confirm it.`,
    `If the tails do not identify a cause, say exactly: "cause not determinable from the tails". Do not guess.`
  ].join("\n");
}
function decodeAnswer(out) {
  const s = out.trim();
  if (s === "") return { why: "the CLI printed nothing" };
  let env;
  try {
    env = JSON.parse(s);
  } catch {
    const i = s.indexOf("{");
    if (i < 0) return { why: "the CLI did not answer JSON" };
    try {
      env = JSON.parse(s.slice(i));
    } catch {
      return { why: "the CLI did not answer JSON" };
    }
  }
  if (!env || typeof env !== "object") return { why: "the CLI did not answer JSON" };
  const stop = "stopReason" in env ? Reflect.get(env, "stopReason") : void 0;
  const text = "text" in env ? Reflect.get(env, "text") : void 0;
  if (typeof stop === "string" && stop !== "end_turn") return { stopReason: stop, why: `the CLI turn ended with stopReason ${stop}` };
  if (typeof text !== "string" || text.trim() === "") return { stopReason: typeof stop === "string" ? stop : void 0, why: "the CLI's answer carried no text" };
  return { text: text.trim().replace(/\s+/g, " ").slice(0, 400) };
}
async function defaultRunCli(args, cwd, timeoutMs) {
  const { promise, resolve: resolve3, reject } = Promise.withResolvers();
  const child = spawn(args[0], args.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let out = "";
  const kill = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`the triage call exceeded its ${Math.round(timeoutMs / 1e3)} s cap`));
  }, timeoutMs);
  child.stdout.on("data", (b) => out += String(b));
  child.stderr.on("data", () => void 0);
  child.on("error", (e) => {
    clearTimeout(kill);
    reject(e);
  });
  child.on("close", (code) => {
    clearTimeout(kill);
    resolve3({ code: code ?? 1, out });
  });
  return promise;
}
async function gateTriage(failing, repo, deps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const t0 = now();
  const timeoutMs = Number(env.FADE_ORCHESTRATE_GATE_TRIAGE_TIMEOUT_MS ?? TRIAGE_TIMEOUT_MS);
  const bin = env.FADE_ORCHESTRATE_GATE_TRIAGE_BIN ?? TRIAGE_BIN;
  if (!triageEnabled(env)) return { note: "", ms: 0, skipped: true, why: "triage disabled (FADE_ORCHESTRATE_GATE_TRIAGE=0)" };
  if (failing.length === 0) return { note: "", ms: now() - t0, why: "no failing rows" };
  const args = [
    "-p",
    triagePrompt(failing),
    "--cwd",
    repo,
    "--output-format",
    "json",
    "--max-turns",
    "1",
    "--no-subagents",
    "--disable-web-search",
    "--disallowed-tools",
    "*"
  ];
  try {
    const r = await (deps.runCli ?? defaultRunCli)([bin, ...args], repo, timeoutMs);
    const d = decodeAnswer(r.out);
    if (!d.text) return { note: "", ms: now() - t0, why: d.why ?? `the CLI exited ${r.code} with no answer` };
    return { note: d.text, ms: now() - t0 };
  } catch (e) {
    return { note: "", ms: now() - t0, why: e instanceof Error ? e.message : String(e) };
  }
}
function triageLine(r) {
  if (r.note === "") return "";
  return `probable cause (advisory, ${Math.round(r.ms / 100) / 10}s, no authority \u2014 the gate's exit codes decide): ${r.note}`;
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
function chordBytes(key2) {
  const k = key2.trim().toLowerCase();
  const ctrl = /^ctrl\+([a-z])$/.exec(k);
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  const altShift = /^alt\+shift\+([a-z])$/.exec(k);
  if (altShift) return `\x1B${altShift[1].toUpperCase()}`;
  const alt = /^alt\+([a-z])$/.exec(k);
  if (alt) return `\x1B${alt[1]}`;
  return void 0;
}
function keyLabel(key2) {
  return key2.trim().toLowerCase().split("+").map((part) => part === "ctrl" ? "Ctrl" : part === "alt" ? "Alt" : part === "shift" ? "Shift" : part.toUpperCase()).join("+");
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
  return { next: VERIFY_LANE, nextState: "verifying", note: "verification requested early; the advisor lane loads at the turn boundary" };
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
import { join as join6 } from "node:path";
import { appendFile, mkdir as mkdir2, open as open2, rename as rename2, stat } from "node:fs/promises";
var HISTORY_FILENAME = "swap_history.json";
var METRICS_JSONL_FILENAME = "metrics.jsonl";
var HOT_STEADY_TPS = 120;
var MAX_ROWS = 200;
async function readSwaps(dir) {
  const rows = await readJsonAsync(join6(dir, HISTORY_FILENAME));
  return Array.isArray(rows?.rows) ? rows.rows : [];
}
async function appendSwap(dir, row) {
  const rows = await readSwaps(dir);
  rows.unshift(row);
  if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
  await writeJsonAsync(join6(dir, HISTORY_FILENAME), { key: "fade.omp_orchestrate.swaps.v1", rows });
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
  const path = join6(dir, METRICS_JSONL_FILENAME);
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
    fh = await open2(join6(dir, METRICS_JSONL_FILENAME), "r");
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
import { join as join7 } from "node:path";
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
  const share = (key2) => {
    const vals = recent.filter((r) => typeof r[key2] === "number").map((r) => r[key2]);
    return vals.length === 0 ? `${key2 === "ssd_share" ? "ssd" : "pcie"} not reported` : `${key2 === "ssd_share" ? "ssd" : "pcie"} ${(vals.reduce((s, v) => s + v, 0) / vals.length * 100).toFixed(1)}%`;
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
  await writeJsonAsync(join7(dir, METRICS_FILENAME), { key: "fade.omp_orchestrate.metrics.v1", ...snap });
}

// src/moe.ts
import { closeSync as closeSync2, openSync as openSync2, readdirSync, readFileSync as readFileSync4, readSync, statSync } from "node:fs";
import { join as join8, resolve as resolve2 } from "node:path";
var FLASH_NEXT_SAVE_CAPABLE = /flash.?next|qwen/i;
function readServeConfig(path) {
  if (!path) return void 0;
  try {
    const raw = JSON.parse(readFileSync4(path, "utf8"));
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
        cmd = readFileSync4(join8("/proc", pid, "cmdline"), "utf8");
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
    const stat4 = readFileSync4(`/proc/${pid}/stat`, "utf8");
    const fields = stat4.slice(stat4.lastIndexOf(")") + 2).split(" ");
    const starttime = Number(fields[19]);
    const uptime = Number(readFileSync4("/proc/uptime", "utf8").split(" ")[0]);
    if (!Number.isFinite(starttime) || !Number.isFinite(uptime)) return void 0;
    return Math.floor(Date.now() / 1e3 - (uptime - starttime / 100));
  } catch {
    return void 0;
  }
}
var sameFile = (a, b) => {
  const na = resolve2(a);
  const nb = resolve2(b);
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
  let key2;
  try {
    const st = statSync(packPath);
    key2 = `${st.mtimeMs}:${st.size}`;
  } catch {
    return { kind: "unknown" };
  }
  const hit = packDrafterCache.get(packPath);
  if (hit && hit.key === key2) return hit.drafter;
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
  packDrafterCache.set(packPath, { key: key2, drafter });
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
function assembleScreen(src) {
  const now = (src.now ?? (() => /* @__PURE__ */ new Date()))();
  const metrics = src.metrics;
  const swaps = src.swaps ?? [];
  const turns = src.turns ?? [];
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
    // The load in flight rides through to the header's holding-page row.
    swap: src.swap,
    claim: src.claim ?? null,
    missing
  };
}
async function collectScreen(src) {
  const [metrics, swaps, turns] = await Promise.all([
    src.metrics ?? fetchMetrics(),
    src.swaps ?? readSwaps(src.runDir),
    src.turns ?? readTurns(src.runDir, SCREEN_TURNS)
  ]);
  return assembleScreen({ ...src, metrics, swaps, turns });
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
var KEY_BAR = ["[\u2191\u2193/j-k] select", "[PgUp/PgDn] scroll", "[s] skip selected", "[v] verify", "[r] reset", "[p] pause", "[c] code", "[h] halt", "[esc/q/Alt+F] close"];
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
  if (d.swap) {
    const pct = d.swap.percent != null ? ` ${Math.round(d.swap.percent)}%` : "";
    const text = `switching ${d.swap.from} \u2192 ${d.swap.to}${pct} \u2014 HOLDING PAGE: the pack is loading, and the loop's completion waits it out (no client timeout, no 404). The numbers below are the last measured.`;
    lines.push(theme ? theme.fg("warning", fit(text, width)) : fit(text, width));
  }
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
  const modsOk = (mod1) => (mod1 - 1 & 2) === 0;
  if (data === "\x1B") return true;
  const kitty = kittyParts(data);
  if (kitty) return kitty.code === 27 && kitty.event !== 3 && modsOk(kitty.mod);
  const mok = MODIFY_OTHER_KEYS.exec(data);
  if (mok) return Number(mok[2]) === 27 && modsOk(Number(mok[1]));
  return false;
}
function kittyParts(data) {
  const kitty = KITTY_CSI_U.exec(data);
  if (!kitty) return void 0;
  return {
    code: Number(kitty[1]),
    mod: kitty[4] === void 0 ? 1 : Number(kitty[4]),
    // The release event arrives TWO ways: `27;5:3u` (semicolon mod, colon event — group 5)
    // and the bare `27:3u` (colon event right after the codepoint — group 2). A matcher
    // that reads only the first lets a RELEASE close the panel: two closes for one press.
    event: kitty[2] !== void 0 && kitty[2] !== "" ? Number(kitty[2]) : kitty[5] === void 0 ? 1 : Number(kitty[5])
  };
}
var OPEN_CHORD = chordBytes(process.env.FADE_ORCHESTRATE_KEY ?? "alt+f");
var CLOSE_KEYS = { q: true, Q: true, "": true, "": true };
var ACTION_KEYS = { s: true, v: true, r: true, p: true, c: true, h: true };
function isClose(data) {
  if (isEscape(data) || CLOSE_KEYS[data] === true) return true;
  if (OPEN_CHORD && data === OPEN_CHORD) return true;
  const kitty = kittyParts(data);
  if (kitty && kitty.event !== 3) {
    if (kitty.code === 99 && kitty.mod === 5) return true;
    if (kitty.code === 100 && kitty.mod === 5) return true;
    if (kitty.code === 113 && (kitty.mod === 1 || kitty.mod === 2)) return true;
    if (kitty.code === 102 && kitty.mod === 3) return true;
  }
  const mok = MODIFY_OTHER_KEYS.exec(data);
  if (mok) {
    const mod = Number(mok[1]);
    const key2 = Number(mok[2]);
    if (key2 === 99 && mod === 5) return true;
    if (key2 === 100 && mod === 5) return true;
    if (key2 === 113 && (mod === 1 || mod === 2)) return true;
    if (key2 === 102 && mod === 3) return true;
  }
  return false;
}
var PANEL_FALLBACK_ROWS = 24;
var PANEL_FALLBACK_COLUMNS = 120;
function terminalSize(tui) {
  let rows;
  let columns;
  try {
    const t = tui?.terminal;
    rows = t?.rows;
    columns = t?.columns;
  } catch {
    rows = void 0;
    columns = void 0;
  }
  const size = (v, fallback) => typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  return { rows: size(rows, PANEL_FALLBACK_ROWS), columns: size(columns, PANEL_FALLBACK_COLUMNS) };
}
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
    return Math.max(8, terminalSize(this.tui).rows - 2);
  }
  render(width) {
    const r = panelLines(this.data, Math.min(width, terminalSize(this.tui).columns), { sel: this.sel }, this.theme);
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
    if (isClose(data)) {
      this.dispose();
      return this.done(JSON.stringify({ key: "close" }));
    }
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
async function openPanel(ctx, provider, onAction, headless = process.env.FADE_ORCHESTRATE_HEADLESS === "1", holding) {
  const firstFetchMs = Number(process.env.FADE_ORCHESTRATE_PANEL_FIRST_MS ?? 3e3);
  const { promise: firstTimeout, resolve: firstTimedOut } = Promise.withResolvers();
  const firstTimer = setTimeout(() => firstTimedOut(void 0), firstFetchMs);
  let initial = await Promise.race([provider(), firstTimeout]);
  clearTimeout(firstTimer);
  if (initial === void 0 && holding) {
    const page2 = holding();
    initial = { ...page2, missing: [...arr(page2.missing), `the live read did not answer in ${firstFetchMs / 1e3}s \u2014 this page is the state in hand${page2.swap ? `, and ${page2.swap.from} \u2192 ${page2.swap.to} is loading` : ""}; the screen replaces itself when the read answers`] };
  }
  if (initial === void 0) {
    ctx.ui.notify(`panel: the first read did not answer in ${firstFetchMs / 1e3}s \u2014 the screen did not open; the keystroke retries`, "warning");
    return;
  }
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
import { join as join9 } from "node:path";
import { readdir as readdir2, stat as stat2 } from "node:fs/promises";
var RUNS_DIRNAME = "runs";
var runsDir = (dir) => join9(dir, RUNS_DIRNAME);
var runArchivePath = (dir, runId) => join9(runsDir(dir), `${runId}.json`);
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
    names = await readdir2(shelf);
  } catch {
    return [];
  }
  const summaries = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const rec = await readJsonAsync(join9(shelf, name));
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
var latestSwitchGen = 0;
var currentSwitchGen = () => latestSwitchGen;
var GATE_POLL_MS = Number(process.env.FADE_ORCHESTRATE_GATE_POLL_MS ?? 3e3);
var GATE_BUDGET_MS = Number(process.env.FADE_ORCHESTRATE_GATE_BUDGET_MS ?? 6e4);
var FADE_KEY = process.env.FADE_ORCHESTRATE_KEY ?? "alt+f";
var FASTPATH_LINES = Number(process.env.FADE_ORCHESTRATE_FASTPATH_LINES ?? 15);
var FASTPATH_FILES = Number(process.env.FADE_ORCHESTRATE_FASTPATH_FILES ?? 1);
var SURFACE = process.env.FADE_ORCHESTRATE_SURFACE === "status" ? "status" : "widget";
var MAIN_SESSION_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;
var isDelegatedSession = () => {
  const f = process.env.PI_SESSION_FILE ?? "";
  if (f === "") return false;
  const parent = basename2(dirname2(f));
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
var workerName = (ctx) => hostAgent(ctx)?.name || basename2(process.env.PI_SESSION_FILE ?? "").replace(/\.jsonl$/, "") || "worker";
var deskDirFor = (ctx) => join10(ctx.cwd, "var", "omp-orchestrate");
function fadeOrchestrate(pi) {
  let run;
  let runDir;
  let lockDir;
  let leaseToken;
  let leaseSession = "";
  let verifyLeaseToken;
  let verifyLeaseSession = "";
  let verifyLeaseRemainingS = 0;
  const LEASE_MINT_TTL_S = Number(process.env.FADE_ORCHESTRATE_LEASE_MINT_TTL_S ?? 300);
  const SELF_SESSION = `omp-pid-${process.pid}`;
  const LEASE_TTL_S = Number(process.env.FADE_ORCHESTRATE_LEASE_TTL_S ?? 1800);
  let leaseRemainingS = 0;
  let pending;
  let cancelHandover;
  let laneControlEnabled = false;
  let frontierOwnsLane = false;
  let frontierTaskActive = false;
  const refreshFrontierOwnership = async (ctx) => {
    const phase = await readFrontierPhase(ctx.sessionManager?.getSessionId?.()) ?? frontierPhaseFromHistory(ctx.sessionManager?.getBranch?.() ?? []);
    if (phase !== void 0) {
      frontierTaskActive = frontierIsActive(phase);
      frontierOwnsLane = frontierTaskActive;
    }
  };
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
  const laneSession = createLaneSession(pi, { phaseTool: "fade_phase" });
  let flipBadge;
  let swapPill;
  const refreshMetrics = async () => {
    void renewLaneLease();
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
    metricsTimer.unref?.();
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
    if (run?.deferred_lane) {
      const held = run.lease_holder ?? "held";
      const retry = run.lease_retry_at_utc ? ` \xB7 retry ${run.lease_retry_at_utc.slice(11, 16)}Z` : "";
      return `owed ${run.deferred_lane} \xB7 lease ${held}${retry} \xB7 briefing ${run.briefing_delivery ?? "queued"} \xB7 review ${run.review_state ?? "unknown"}`;
    }
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
  const ensurePhaseTool = async () => {
    if (!run || TERMINAL[run.state] === true) return false;
    try {
      const active = pi.getActiveTools();
      if (active.includes("fade_phase")) return true;
      await pi.setActiveTools([...active, "fade_phase"]);
      return true;
    } catch {
      return false;
    }
  };
  const statePath = () => runDir ? join10(runDir, STATE_FILENAME) : "<unset>";
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
  const returnVerifyLease = async () => {
    const tok = verifyLeaseToken;
    const sid = verifyLeaseSession || SELF_SESSION;
    verifyLeaseToken = void 0;
    verifyLeaseRemainingS = 0;
    verifyLeaseSession = "";
    if (!tok) return;
    if (!run && !leaseToken) stopMetricsTimer();
    try {
      const v = await releaseOwnedLease(tok, sid);
      if (!v.ok) process.stderr.write(`orchestrate: verify lease release refused (${v.rule || v.status}); it expires on its TTL \u2014 a release is admitted for the (caller, session) pair that holds the lease
`);
    } catch (e) {
      process.stderr.write(`orchestrate: verify lease release failed: ${msg(e)}; it expires on its TTL
`);
    }
  };
  const releaseLaneLease = () => {
    const tok = leaseToken;
    const sid = leaseSession;
    leaseToken = void 0;
    leaseRemainingS = 0;
    leaseSession = "";
    if (run) run.lease_state = "released";
    if (!tok) return;
    void releaseOwnedLease(tok, sid).then((v) => {
      if (run) run.lease_hint = v.token_hint ?? run.lease_hint;
      if (!v.ok) process.stderr.write(`orchestrate: lane lease release refused (${v.rule || v.status}); the lane stays claimed to its TTL \u2014 a release is admitted for the (caller, session) pair that holds it
`);
    }).catch(() => void 0);
  };
  const acquireLaneLease = async (lane, sessionId, ctx) => {
    leaseSession = sessionId;
    try {
      const v = await acquireLease(lane, LEASE_TTL_S, sessionId);
      if (run) {
        run.lease_holder = v.holder;
        run.lease_hint = v.token_hint;
      }
      if (v.ok && v.token) {
        leaseToken = v.token;
        leaseRemainingS = v.remaining_s ?? v.granted_ttl_s ?? LEASE_TTL_S;
        writeStoredLease({ token: v.token, pack: lane, session: sessionId, granted_utc: (/* @__PURE__ */ new Date()).toISOString() });
        if (run) {
          run.lease_state = "held";
          run.lease_token = v.token;
          run.lease_granted_ttl_s = v.granted_ttl_s;
        }
        return { ok: true, line: leaseLine(v) };
      }
      if (run) run.lease_state = v.rule === RULE_LEASE_STALE_TOKEN ? "refused" : "deferred";
      return { ok: false, line: leaseLine(v) };
    } catch (e) {
      if (run) run.lease_state = "refused";
      return { ok: false, line: `supervisor lease unreachable: ${msg(e)}` };
    }
  };
  const renewLaneLease = async () => {
    if (verifyLeaseToken && shouldRenew(verifyLeaseRemainingS, LEASE_MINT_TTL_S)) {
      try {
        const v = await renewLease(verifyLeaseToken, LEASE_MINT_TTL_S, verifyLeaseSession || SELF_SESSION);
        verifyLeaseRemainingS = v.remaining_s ?? v.granted_ttl_s ?? LEASE_MINT_TTL_S;
        if (v.rule === RULE_LEASE_STALE_TOKEN || v.rule === RULE_LEASE_NOT_HOLDER) verifyLeaseToken = void 0;
      } catch {
      }
    } else if (verifyLeaseToken) {
      verifyLeaseRemainingS = Math.max(0, verifyLeaseRemainingS - METRICS_INTERVAL_MS / 1e3);
    }
    if (!leaseToken) return;
    if (!shouldRenew(leaseRemainingS, LEASE_TTL_S)) {
      leaseRemainingS = Math.max(0, leaseRemainingS - METRICS_INTERVAL_MS / 1e3);
      return;
    }
    try {
      const v = await renewLease(leaseToken, LEASE_TTL_S, leaseSession);
      if (run) run.lease_hint = v.token_hint ?? run.lease_hint;
      leaseRemainingS = v.remaining_s ?? v.granted_ttl_s ?? LEASE_TTL_S;
      if (v.rule === RULE_LEASE_STALE_TOKEN || v.rule === RULE_LEASE_NOT_HOLDER) leaseToken = void 0;
    } catch {
    }
  };
  let liveCache;
  const liveState = async () => {
    if (!runDir) return void 0;
    const path = join10(runDir, STATE_FILENAME);
    try {
      const s = await stat3(path);
      const key2 = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
      if (liveCache && liveCache.key === key2) return liveCache.state;
      const state = parseJson(await readFile3(path, "utf8"));
      liveCache = { key: key2, state };
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
      releaseLaneLease();
      void returnVerifyLease();
      void persist().catch(warnWrite(ctx, "fail"));
      paint(ctx);
    }
    ctx.ui.notify(`fade_orchestrate: ${reason}`, "error");
  };
  const gateRouterIdle = (lane, ctx) => gateLaneIdle(lane, {
    busy: routerBusy,
    residency: () => supervisorResident(lane, leaseSession || SELF_SESSION),
    deferred: (m) => ctx.ui.notify(m, "warning"),
    progress: (m) => ctx.ui.setWorkingMessage(m),
    budgetMs: GATE_BUDGET_MS,
    pollMs: GATE_POLL_MS
  });
  let switchGen = 0;
  let switchChain = Promise.resolve();
  const LEASE_RETRY_MIN_MS = Number(process.env.FADE_ORCHESTRATE_LEASE_RETRY_MIN_MS ?? 15e3);
  const LEASE_RETRY_MAX_MS = Number(process.env.FADE_ORCHESTRATE_LEASE_RETRY_MAX_MS ?? 6e5);
  const LEASE_RETRY_MAX_TRIES = Number(process.env.FADE_ORCHESTRATE_LEASE_RETRY_MAX_TRIES ?? 3);
  const leaseRetryDelayMs = (remainingS) => {
    const held = (typeof remainingS === "number" && Number.isFinite(remainingS) && remainingS > 0 ? remainingS : 30) * 1e3 + 3e3;
    return Math.min(Math.max(held, LEASE_RETRY_MIN_MS), LEASE_RETRY_MAX_MS);
  };
  let leaseRetryTimer;
  let leaseRetryTries = 0;
  let leaseRetryLane = "";
  let closed = false;
  const reviewLabel = () => run ? reviewStateLabel(run) : "no run";
  const briefKindFor = (lane, st) => st.verify_batch && isThinkingLane(lane) ? "verifyBatch" : st.state === "repair" ? "repair" : lane === CODE_LANE && st.gate_last && st.gate_last.passed === false ? "gate" : lane === CODE_LANE ? "code" : "verify";
  const markBriefing = (delivery, lane) => {
    leaseRetryTries = 0;
    leaseRetryLane = "";
    if (!run) return;
    clearLaneDeferral(run, lane, delivery);
    void persist().catch(() => void 0);
  };
  const deferLaneMove = (lane, loaded, ctx, quiet, handBack) => {
    clearTimeout(leaseRetryTimer);
    leaseRetryTimer = void 0;
    if (leaseRetryLane !== lane) {
      leaseRetryLane = lane;
      leaseRetryTries = 0;
    }
    const heldS = loaded.leaseRemainingS;
    const holder = loaded.leaseHolder ?? "a peer pair";
    const delayMs = leaseRetryDelayMs(heldS);
    const exhausted = leaseRetryTries >= LEASE_RETRY_MAX_TRIES;
    if (run) {
      applyLaneDeferral(run, { lane, kind: briefKindFor(lane, run), rule: loaded.leaseRule, holder: loaded.leaseHolder, remaining_s: loaded.leaseRemainingS, token_hint: loaded.leaseTokenHint, retry_delay_ms: exhausted ? 0 : delayMs, quiet }, (/* @__PURE__ */ new Date()).toISOString());
      if (exhausted) run.lease_retry_at_utc = void 0;
    }
    void persist().catch(warnWrite(ctx, "defer"));
    paint(ctx);
    if (exhausted) {
      ctx.ui.notify(
        `fade_orchestrate: ${lane} is STILL owed after ${leaseRetryTries} tries \u2014 the lease is held by ${holder}${heldS !== void 0 ? ` (${heldS}s left)` : ""} and the client stops re-asking. The queue stays: briefing ${run?.briefing_delivery ?? "queued"}, review ${reviewLabel()}, pin ${ctx.model?.id ?? "the served pack"} (held, never 404'd). End the holding run, or re-ask with the panel's v/c keys. (${loaded.detail})`,
        "warning"
      );
      return;
    }
    leaseRetryTries += 1;
    leaseRetryTimer = setTimeout(() => {
      leaseRetryTimer = void 0;
      if (closed) return;
      void requestLane(lane, ctx, quiet, handBack);
    }, delayMs);
    ctx.ui.notify(
      `fade_orchestrate: ${lane} DEFERRED \u2014 lease ${loaded.leaseRule ?? "held"}, held by ${holder}${heldS !== void 0 ? `, ${heldS}s left` : ""}. The pin stays on ${ctx.model?.id ?? "the served pack"}: the completion is HELD through the swap, not 404'd. Briefing: ${quiet ? "quiet hand-back, no page owed" : "QUEUED \u2014 sent the moment the lane lands"}. Review: ${reviewLabel()}. Retry ${leaseRetryTries}/${LEASE_RETRY_MAX_TRIES} in ${Math.round(delayMs / 1e3)}s. (${loaded.detail})`,
      "warning"
    );
  };
  let switchingTo;
  const requestLane = (lane, ctx, quiet = false, handBack = false) => {
    if (!laneControlEnabled) return;
    if (frontierOwnsLane) {
      ctx.ui.notify("orchestrate: Frontier owns this workflow's lane transitions", "info");
      return;
    }
    const gen = ++switchGen;
    latestSwitchGen = gen;
    switchChain = switchChain.then(() => gen === switchGen ? runSwitch(lane, ctx, gen, quiet, handBack) : void 0).catch((e) => {
      ctx.ui.notify(`fade_orchestrate: the ${lane} switch failed: ${msg(e)} \u2014 the lane it was owed did NOT land`, "error");
    });
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
    let route = routeFor(desk, flipState(run.lane, FLIP_WINDOW_MS));
    if (route.route === "subagent") {
      const probe = await probeVerifierLane();
      run.lane_probe = { ok: probe.ok, detail: probe.detail, at: (/* @__PURE__ */ new Date()).toISOString(), ms: probe.ms, skipped: probe.skipped };
      if (!probe.ok && probe.skipped !== true) {
        route = { route: "swap", reason: `the ${VERIFIER_MODEL} verifier lane failed its claim-time probe: ${probe.detail}`, flips: route.flips };
        pushRejection(run, "task", `the zero-swap subagent verification route was REFUSED before the claim: ${probeLabel(probe)}. A claimed batch cannot be reclaimed (desk.ts:214), so an unproven lane leaves the batch owed for the whole run; paid the ${VERIFY_LANE} swap instead, the route with recovery`);
        ctx.ui.notify(`orchestrate: verifier lane UNPROVEN \u2014 ${probeLabel(probe)}; the batch goes to one ${VERIFY_LANE} swap, not the zero-swap subagent route`, "warning");
      }
    }
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
    pending = { lane: VERIFY_LANE, phase: "verification_batch" };
    deskBriefing = true;
    settledNotified = false;
    await persist();
    paint(ctx);
    ctx.ui.notify(`orchestrate: ${deskLine(desk)} \u2014 one ${VERIFY_LANE} load answers the whole batch`, "info");
    requestLane(VERIFY_LANE, ctx);
    return true;
  };
  const auditOwedOnComplete = async (st, ctx) => {
    if (!runDir) return "";
    const d = await readDesk(runDir, st.run_id);
    if (!d) return "";
    const owed = owedRequests(d);
    if (owed.length === 0) return "";
    const ids = owed.map((r) => r.id).join(", ");
    pushRejection(st, "task", `the run completed with ${owed.length} verification request(s) CLAIMED and NEVER judged: ${ids} \u2014 a claimed batch has no reclaim path (desk.ts:214), so the slices behind them are unverified`);
    ctx.ui.notify(`orchestrate: run COMPLETE with ${owed.length} OWED verification request(s): ${ids} \u2014 treat those slices as unverified`, "error");
    return `; OWED ${owed.length} unjudged verification request(s): ${ids} \u2014 those slices are UNVERIFIED`;
  };
  const runSwitch = async (lane, ctx, gen, quiet = false, handBack = false) => {
    switchingTo = lane;
    try {
      await runSwitchBody(lane, ctx, gen, quiet, handBack);
    } finally {
      if (gen === switchGen) switchingTo = void 0;
    }
  };
  const runSwitchBody = async (lane, ctx, gen, quiet = false, handBack = false) => {
    const model = ctx.modelRegistry.find(PROVIDER, lane);
    if (!model) {
      fail(ctx, `model ${PROVIDER}/${lane} is not in the registry`);
      return;
    }
    const plan = switchPlan(await residentLane(), lane);
    if (!plan.load) ctx.ui.notify(`fade_orchestrate: ${plan.reason}`, "info");
    const gate = plan.gate ? await gateRouterIdle(lane, ctx) : { waited_ms: 0, polls: 0, over_budget: false, last: { busy: false, reason: plan.reason } };
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
    const from = run?.lane ?? "";
    swapPill = { from, to: modelLabel(model.name ?? lane) };
    paint(ctx);
    engineProofInvalidate();
    const moe = laneMoe(lane, { configPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG });
    const watch = plan.load ? startSwapWatch(lane, moe, (percent) => {
      if (gen !== switchGen || !swapPill) return;
      swapPill = { ...swapPill, percent };
      paint(ctx);
    }) : void 0;
    ctx.ui.setWorkingMessage(`fade_orchestrate: loading ${lane} on the router\u2026`);
    const presentToken = leaseToken ?? verifyLeaseToken;
    const loaded = await loadLane(lane, {
      ...presentToken ? { leaseToken: presentToken } : { mintLease: { ttlSec: LEASE_MINT_TTL_S } },
      sessionId: leaseToken ? leaseSession || SELF_SESSION : verifyLeaseSession || SELF_SESSION
    });
    if (loaded.minted && loaded.leaseToken) {
      verifyLeaseToken = loaded.leaseToken;
      verifyLeaseSession = loaded.leaseSession ?? SELF_SESSION;
      verifyLeaseRemainingS = LEASE_MINT_TTL_S;
      if (!run) startMetricsTimer();
    }
    if (gen !== switchGen) {
      watch?.cancel();
      return;
    }
    if (!loaded.ok) {
      watch?.cancel();
      ctx.ui.setWorkingMessage();
      swapPill = void 0;
      if (loaded.deferred) {
        deferLaneMove(lane, loaded, ctx, quiet, handBack);
        return;
      }
      fail(ctx, `loading lane ${lane} failed (${loaded.detail}) \xB7 review: ${reviewLabel()} \xB7 briefing: not sent \xB7 the pin stays on ${ctx.model?.id ?? "the served pack"}`);
      return;
    }
    if (!await laneSession.pin(ctx, lane)) return;
    if (gen !== switchGen) return;
    const hold = await laneSession.ready(ctx, lane, {
      pollMs: LANE_POLL_MS,
      // The daemon's readiness window is the ceiling — the same fuse the start's proof uses,
      // never a client timeout.
      waitMs: START_PROOF_WAIT_MS,
      progress: (m, percent) => {
        if (gen !== switchGen) return;
        ctx.ui.setWorkingMessage(m);
        if (swapPill) swapPill = { ...swapPill, ...percent !== void 0 ? { percent } : {} };
        paint(ctx);
      }
    });
    ctx.ui.setWorkingMessage();
    swapPill = void 0;
    if (from && runDir && from !== lane) {
      turnSwapMs += Math.round(loaded.elapsed_s * 1e3);
      void watch?.finish(from, lane, loaded.elapsed_s, runDir, run?.run_id, windowClass(run)).then(() => paint(ctx));
    }
    if (gen !== switchGen) {
      watch?.cancel();
      return;
    }
    if (!hold.ok) {
      const fall = hold.served_id !== void 0 && isServedLane(hold.served_id) ? hold.served_id : void 0;
      if (fall) {
        const fm = ctx.modelRegistry.find(PROVIDER, fall);
        if (fm) await laneSession.pin(ctx, fall);
      }
      fail(ctx, `lane ${lane} was admitted and pinned, but does not serve: ${hold.reason}${fall ? ` \u2014 the screen follows ${fall}, and ${lane} stays owed` : " \u2014 no briefing sent"}`);
      return;
    }
    if (handBack && verifyLeaseToken && !leaseToken) await returnVerifyLease();
    if (run) run.lane = lane;
    await persist();
    paint(ctx);
    if (gen !== switchGen) return;
    setTimeout(async () => {
      if (gen !== switchGen) return;
      if (quiet) {
        markBriefing("quiet", lane);
        return;
      }
      if (!run) {
        if (isThinkingLane(lane)) {
          pi.sendUserMessage(
            `fade_orchestrate: the advisor lane (${lane}) is loaded and serving, and this session has no run. Answer the verification acts this session delegated \u2014 the reviewer rounds it started, the verdicts it owes \u2014 from this pack. End the turn when they are answered; the code lane returns at the next boundary.`
          );
        }
        return;
      }
      await ensurePhaseTool();
      const owed = deskBriefing && isThinkingLane(lane) && run?.verify_batch;
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
          markBriefing("sent", lane);
          return;
        }
      }
      const text = await (run.state === "repair" ? briefings.repair(run) : lane === CODE_LANE && run.gate_last && run.gate_last.passed === false ? briefings.gate(run) : lane === CODE_LANE ? briefings.code(run) : briefings.verify(run));
      pi.sendUserMessage(text);
      markBriefing("sent", lane);
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
        // The load in flight, so the screen paints its holding page: the chord pressed
        // mid-swap is the keystroke that needs a screen, and the panel is where the operator
        // reads what the 13-25 s load is doing.
        swap: swapPill,
        // The panel names who holds the router. `readInstanceLock` is a 400-byte read of the
        // claim file, and `null` (absent/parsable-free) is a real answer, not a missing row.
        claim: readInstanceLock(instanceLockDir(ROUTER)) ?? null,
        ...process.env.FADE_ORCHESTRATE_BASALT_CONFIG ? { moeConfigPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG } : {}
      });
    };
  };
  const panelHolding = (ctx) => {
    if (!run || !runDir) return void 0;
    const state = run;
    const dir = runDir;
    return () => assembleScreen({
      run: state,
      runDir: dir,
      lanes: { think: THINK_LANE, code: CODE_LANE },
      names: { [THINK_LANE]: ctx.modelRegistry.find(PROVIDER, THINK_LANE)?.name, [CODE_LANE]: ctx.modelRegistry.find(PROVIDER, CODE_LANE)?.name },
      context: ctx.getContextUsage(),
      metrics,
      swaps: [],
      turns: [],
      flip: flipBadge,
      swap: swapPill,
      ...process.env.FADE_ORCHESTRATE_BASALT_CONFIG ? { moeConfigPath: process.env.FADE_ORCHESTRATE_BASALT_CONFIG } : {}
    });
  };
  const packageVersion = async () => {
    const here = dirname2(fileURLToPath(import.meta.url));
    for (const p of [join10(here, "..", "package.json"), join10(here, "package.json")]) {
      try {
        const raw = JSON.parse(await readFile3(p, "utf8"));
        if (raw && typeof raw === "object" && "version" in raw && typeof raw.version === "string" && raw.version !== "") return raw.version;
      } catch {
      }
    }
    return void 0;
  };
  const bundleHash = async () => {
    const here = dirname2(fileURLToPath(import.meta.url));
    for (const p of [join10(here, "index.js"), join10(here, "..", "dist", "index.js")]) {
      try {
        return createHash("sha256").update(await readFile3(p)).digest("hex");
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
    if (!laneControlEnabled) {
      ctx.ui.notify("orchestrate: saved run is inactive; /orchestrate resume enables workflow controls", "info");
      return;
    }
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
      await openPanel(ctx, provider, (a) => actOnPanel(ctx, a), process.env.FADE_ORCHESTRATE_HEADLESS === "1", panelHolding(ctx));
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
  const hostConflict = (key2) => {
    if (typeof conflictProbe !== "function") return void 0;
    try {
      const answer = conflictProbe.call(pi, key2);
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
      return { next: VERIFY_LANE, nextState: "verifying" };
    }
    const accepted = String(payload.verdict) === "accepted";
    st.phases[st.phases.length - 1].accepted = accepted;
    if (accepted) {
      st.state = "complete";
      return { next: VERIFY_LANE, nextState: "complete" };
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
      return { next: VERIFY_LANE, nextState: "failed" };
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
        for (const key2 of Object.keys(payload)) {
          if (!allowedKeys[params.phase].has(key2)) throw new Error(`fade_phase: ${params.phase} does not take key "${key2}"`);
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
      if (applied.nextState === "complete" || applied.nextState === "failed") {
        releaseLock();
        releaseLaneLease();
      }
      let checkpointNote = "";
      if (params.phase === "verification_done" && applied.nextState === "complete") {
        const st = run;
        const tags = await Promise.all(st.tasks.filter((t) => t.status === "passed").map((t) => tagCheckpoint(st.repo, st, t.id)));
        const ok = tags.filter((t) => t.ok).map((t) => t.tag);
        if (ok.length > 0) checkpointNote = `; checkpoints ${ok.join(", ")}`;
        const refused = tags.filter((t) => !t.ok);
        if (refused.length > 0) checkpointNote += `; checkpoint FAILED ${refused.map((t) => `${t.tag}: ${t.error}`).join(", ")}`;
        checkpointNote += await auditOwedOnComplete(st, ctx);
      }
      if (params.phase === "coding_done" && applied.nextState === "verifying" && run.checks.length > 0) {
        await gateChecks(ctx);
        const gate = await runGateLogged(run.checks, run.repo, ctx);
        run.gate_last = gate;
        if (!gate.passed) {
          const failing = gate.results.filter((r) => !r.ok);
          const triage = await gateTriage(failing, run.repo);
          const triageNote = triageLine(triage);
          if (triage.note !== "") run.gate_last = { ...gate, triage: triage.note };
          if (triage.note === "" && triage.skipped !== true) ctx.ui.notify(`orchestrate: gate triage produced nothing (${triage.why})`, "info");
          pushRejection(run, "task", `pre-swap gate red: ${failing.map((f) => f.cmd).join(" | ")}`);
          run.state = "coding";
          await persist();
          paint(ctx);
          pending = { lane: CODE_LANE, phase: "gate" };
          settledNotified = false;
          ctx.abort();
          return {
            content: [{ type: "text", text: `pre-swap gate RED (${failing.length}/${gate.results.length} failing); the verifier swap was not paid; fix and re-report coding_done${triageNote !== "" ? `; ${triageNote}` : ""}` }],
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
          checkpointNote += await auditOwedOnComplete(st2, ctx);
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
      const state = await readJsonAsync(join10(dir, STATE_FILENAME));
      const active = await readJsonAsync(join10(dir, ACTIVE_FILENAME));
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
      const request2 = captured?.request;
      if (!request2) throw new Error(`fade_verify: the desk at ${dir} did not accept the registration (concurrent writers exhausted the retry budget); nothing was queued`);
      const ready = readyToAddress(after, Date.now());
      const queue = `request ${request2.id} of batch ${after.epoch + 1} \xB7 ${ready.open} registered, ${ready.expected > 0 ? `${ready.registered}/${ready.expected} of the launching task call` : "the launching task call named no count"}`;
      if (agent === "owner") {
        return {
          content: [{ type: "text", text: `${queue}. Registered; NOT blocked here \u2014 this session dispatches the batch, so blocking it would stall the pass. The batch is answered at the turn boundary when it closes (${ready.reason}). Do not call fade_verify twice for this slice.` }],
          details: { desk: { run_id: runId, id: request2.id, batch: after.epoch + 1, deduped: captured?.deduped === true, ready: ready.ready, reason: ready.reason, owner: true } }
        };
      }
      const wait = await awaitVerdict(dir, runId, request2.id, { timeoutMs: DESK_WAIT_MS, signal });
      if (wait.state === "answered") {
        const v = wait.request?.verdict;
        return {
          content: [{ type: "text", text: `${request2.id} ${v?.accepted === true ? "ACCEPTED" : "NEEDS REPAIR"} after ${Math.round(wait.waited_ms / 1e3)}s in the batched pass: ${v?.notes ?? "no notes posted"}` }],
          details: { desk: { run_id: runId, id: request2.id, batch: after.epoch + 1, state: "answered", accepted: v?.accepted === true, notes: v?.notes, polls: wait.polls, waited_ms: wait.waited_ms } }
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
      const state = await readJsonAsync(join10(dir, STATE_FILENAME));
      const active = await readJsonAsync(join10(dir, ACTIVE_FILENAME));
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
    description: `Live basalt router census on ${ROUTER}: every lane entry's load state and /health`,
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
  pi.registerCommand("lane", {
    description: `Move the :18014 pack: /lane (who is resident) \xB7 /lane <model-id> (swap, wait to RESIDENT, prove the served id)`,
    handler: async (args, ctx) => {
      const target = args.trim().split(/\s+/)[0] ?? "";
      if (!target) {
        const sup = await getResidency("fade-orchestrator");
        const st = await listLanes();
        const idn = await servedIdentity();
        const line = sup ? `daemon lane ${sup.state} pack=${sup.pack || "none"} pid=${sup.pid} requests=${sup.active_requests} \xB7 router id ${idn?.id ?? "none"}${idn?.n_ctx ? ` n_ctx ${idn.n_ctx}` : ""}` : `no daemon answer \xB7 router ${st.health}`;
        ctx.ui.setWidget("lanes", [`router: ${ROUTER}`, ...st.models.map((m) => `${m.id} ${m.status}`)]);
        ctx.ui.notify(`lane: ${line}`, "info");
        return;
      }
      if (!laneControlEnabled) {
        ctx.ui.notify("lane: model switching is disabled; start /orchestrate to enable lane control", "info");
        return;
      }
      ctx.ui.notify(`lane: moving :18014 to ${target} (teardown, spawn, readiness) \u2026`, "info");
      await returnVerifyLease();
      const mv = await moveLane(target, { sessionId: `omp-pid-${process.pid}` });
      ctx.ui.setWidget("lanes", [`lane ${target}: ${mv.ok ? "resident, id proven" : "NOT proven resident"}`, mv.detail]);
      ctx.ui.notify(`lane ${target}: ${mv.detail}`, mv.ok ? "info" : "warning");
    }
  });
  const registerChord = (key2, description) => {
    try {
      pi.registerShortcut(key2, {
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
  const orchestrateCommand = async (args, ctx) => {
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
      const call = run.lane_call ? ` \xB7 in-process ${run.lane_call.model} ${run.lane_call.ok ? `answered ${run.lane_call.chars} chars` : `refused ${run.lane_call.cls}`} \xB7 ${(run.lane_call.ms / 1e3).toFixed(1)}s` : " \xB7 no in-process call";
      ctx.ui.notify(
        `orchestrate ${run.run_id}: ${run.state} \xB7 lane ${run.lane} \xB7 round ${run.round}/${run.max_rounds} \xB7 tasks ${done}/${run.tasks.length} \xB7 phases ${run.phases.length} \xB7 router claim ${lockDir ? `this run (pid ${process.pid})` : claim2 ? `pid ${claim2.pid} \xB7 ${claim2.run_id} \xB7 ${claim2.repo} \xB7 ${claim2.host}` : "free"}${held} \xB7 lease ${run.lease_state ?? "none"}${run.lease_holder && run.lease_state !== "held" ? `(${run.lease_holder})` : run.lease_granted_ttl_s ? `(${run.lease_granted_ttl_s}s)` : ""}${paid}${deskPart}${call} \xB7 ${statePath()}`,
        "info"
      );
      paint(ctx);
      return;
    }
    if (first === "runs") {
      const dir = runDir ?? join10(ctx.cwd, "var", "omp-orchestrate");
      const archived = await listRuns(dir);
      if (archived.length === 0) {
        ctx.ui.notify(`orchestrate: no archived runs in ${join10(dir, RUNS_DIRNAME)}`, "info");
        return;
      }
      for (const r of archived.slice(0, 5)) {
        ctx.ui.notify(`run ${r.run_id}: ${r.state} \xB7 ${r.rounds} rounds \xB7 ${r.tasks_passed}/${r.tasks_total} tasks \xB7 ${r.goal.replace(/\s+/g, " ").slice(0, 60)}`, "info");
      }
      if (archived.length > 5) ctx.ui.notify(`orchestrate: ${archived.length - 5} more archived runs in ${join10(dir, RUNS_DIRNAME)}`, "info");
      return;
    }
    if (first === "moe") {
      const dir = runDir ?? join10(ctx.cwd, "var", "omp-orchestrate");
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
      const dir = runDir ?? join10(ctx.cwd, "var", "omp-orchestrate");
      const st = run ?? await readJsonAsync(join10(dir, STATE_FILENAME));
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
      const owed = owedRequests(d);
      if (owed.length > 0) ctx.ui.notify(`orchestrate: ${owed.length} request(s) CLAIMED with NO verdict \u2014 owed: ${owed.map((r) => r.id).join(", ")}. Nothing re-opens a claimed batch (desk.ts:214), so the run completes over them and the slices behind them are UNVERIFIED; answer them with fade_verdicts`, "error");
      for (const r of d.requests.slice(-8)) {
        ctx.ui.notify(`  ${r.id} [batch ${r.batch + 1}] ${r.agent}${r.task_id ? `/${r.task_id}` : ""}: ${r.objective.slice(0, 70)} \u2192 ${r.verdict ? r.verdict.accepted ? "ACCEPTED" : "needs_repair" : r.claimed_batch !== void 0 ? "claimed, verdict owed" : "collecting"}`, "info");
      }
      for (const a of d.addressed.slice(-4)) ctx.ui.notify(`  batch ${a.batch + 1} addressed ${a.at} routed ${a.routed}: ${a.ids.join(", ")}`, "info");
      if (d.churn) ctx.ui.notify(`orchestrate: CHURN ROUTE in force${d.churn_utc ? ` since ${d.churn_utc}` : ""} \u2014 batches go to the ${VERIFIER_AGENT} subagent on ${VERIFIER_MODEL}; /orchestrate lanes reset hands them back to the lane`, "warning");
      return;
    }
    if (first === "think") {
      const parts = raw.split(/\s+/);
      const named = parts[1]?.includes("/") === true;
      const target = named ? parts[1] : THINK_MODEL;
      const prompt = (named ? parts.slice(2) : parts.slice(1)).join(" ").trim();
      if (!prompt) {
        ctx.ui.notify(`orchestrate: usage /orchestrate think [provider/model] <prompt> \u2014 one completion, in process, on the resident lane (default ${THINK_MODEL}); no load, no swap, no lane change`, "info");
        return;
      }
      ctx.ui.setWorkingMessage(`fade_orchestrate: one in-process completion from ${target}\u2026`);
      const called = await askLane(target, prompt, { role: "role:advisor" });
      ctx.ui.setWorkingMessage();
      if (run) {
        run.lane_call = { ok: called.ok, cls: called.cls, model: called.model, endpoint: called.endpoint, ms: called.ms, at: (/* @__PURE__ */ new Date()).toISOString(), chars: called.text.length, detail: called.detail };
        await persist();
      }
      if (!called.ok) {
        ctx.ui.notify(`orchestrate: in-process ${called.cls} \u2014 ${called.detail}`, "error");
        paint(ctx);
        return;
      }
      const shown2 = called.text.split(/\r?\n/);
      for (const line of shown2.slice(0, 12)) ctx.ui.notify(`  ${line}`, "info");
      if (shown2.length > 12) ctx.ui.notify(`  \u2026 ${shown2.length - 12} more line(s) of the answer elided`, "info");
      ctx.ui.notify(`orchestrate: ${askLabel(called)}`, "info");
      paint(ctx);
      return;
    }
    if (first === "verifier") {
      const sub = (raw.split(/\s+/)[1] ?? "show").toLowerCase();
      const abs = join10(ctx.cwd, verifierAgentPath(ctx.cwd));
      const absWorker = join10(ctx.cwd, workerAgentPath(ctx.cwd));
      if (sub === "install") {
        if (isRouterModel(VERIFIER_MODEL)) {
          ctx.ui.notify(`orchestrate: verifier install REFUSED: ${VERIFIER_MODEL} is a basalt ROUTER entry \u2014 the advisor is pinned OFF the router. Point FADE_ORCHESTRATE_VERIFIER_MODEL at a non-router model (e.g. ninfer-local/coder-gpu1) and re-run.`, "error");
          return;
        }
        try {
          mkdirSync3(join10(ctx.cwd, ".omp", "agents"), { recursive: true });
          writeFileSync3(abs, verifierAgentMd());
          writeFileSync3(absWorker, workerAgentMd());
        } catch (e) {
          ctx.ui.notify(`orchestrate: verifier install FAILED at ${abs}: ${e instanceof Error ? e.message : String(e)}`, "error");
          return;
        }
        ctx.ui.notify(`orchestrate: wrote ${verifierAgentPath(ctx.cwd)} (model ${VERIFIER_MODEL}, pinned off the router) and ${workerAgentPath(ctx.cwd)} (inherits the code lane; its tools carry fade_verify) \u2014 the host discovers agent definitions per session, so a live session needs /new to see it`, "info");
        return;
      }
      const installed = existsSync(abs);
      const installedWorker = existsSync(absWorker);
      ctx.ui.notify(`orchestrate: verifier agent ${VERIFIER_AGENT} \xB7 model ${VERIFIER_MODEL} \xB7 ${abs} ${installed ? "installed" : "NOT installed (/orchestrate verifier install)"}`, installed ? "info" : "warning");
      ctx.ui.notify(`orchestrate: worker agent ${WORKER_AGENT} \xB7 inherits the code lane \xB7 ${absWorker} ${installedWorker ? "installed" : "NOT installed (/orchestrate verifier install)"} \u2014 a worker on an agent whose tools lack fade_verify CANNOT register, so the census waits for a worker that can never arrive`, installedWorker ? "info" : "warning");
      if (installed) ctx.ui.notify(`orchestrate: ${readFileSync5(abs, "utf8").split("\n").slice(0, 6).join("\n")}`, "info");
      const probe = await probeVerifierLane();
      ctx.ui.notify(`orchestrate: verifier lane ${VERIFIER_MODEL} claim-time probe: ${probeLabel(probe)}`, probe.ok ? "info" : "error");
      return;
    }
    if (first === "overlay") {
      await openPanelGuarded(ctx);
      return;
    }
    if (first === "resume") {
      await refreshFrontierOwnership(ctx);
      if (frontierTaskActive) {
        ctx.ui.notify("orchestrate: finish or abort the active Frontier task before resuming this run", "warning");
        return;
      }
      if (!run || TERMINAL[run.state] === true) {
        ctx.ui.notify("orchestrate: no unfinished run to resume", "info");
        return;
      }
      laneControlEnabled = true;
      run.paused = false;
      await persist();
      const resumed = run;
      cancelHandover?.();
      cancelHandover = queueHandover({
        isCurrent: () => laneControlEnabled && run === resumed && !run.paused && TERMINAL[run.state] !== true && !frontierOwnsLane,
        isIdle: () => ctx.isIdle() && (typeof ctx.hasPendingMessages !== "function" || !ctx.hasPendingMessages()),
        build: () => handoverText(resumed),
        deliver: (message) => pi.sendUserMessage(message),
        onDelivered: () => ctx.ui.notify(`orchestrate: condensed handover sent for ${resumed.run_id}`, "info"),
        onError: (error) => ctx.ui.notify(`orchestrate: handover pending; retrying after ${msg(error)}`, "warning")
      });
      ctx.ui.notify(`orchestrate: run ${run.run_id} resume queued until idle`, "info");
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
          ctx.ui.notify(`orchestrate: churn route cleared \u2014 verification batches answer on the ${VERIFY_LANE} lane again`, "info");
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
      if (first === "verify" || first === "code" || first === "reset") laneControlEnabled = true;
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
      releaseLaneLease();
      pending = void 0;
      const handBack = run.lane !== CODE_LANE;
      if (handBack) requestLane(CODE_LANE, ctx, true, true);
      laneControlEnabled = false;
      cancelHandover?.();
      ctx.ui.notify(`orchestrate: stopped; ${handBack ? `handing the lane back to ${CODE_LANE}` : `resident lane left as ${run.lane}`}; state ${statePath()}`, "info");
      if (raw.includes("--clear")) {
        try {
          unlinkSync2(join10(runDir, ACTIVE_FILENAME));
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
    await refreshFrontierOwnership(ctx);
    if (frontierTaskActive) {
      ctx.ui.notify("orchestrate: finish or abort the active Frontier task before starting an orchestrated run", "warning");
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
    laneControlEnabled = true;
    frontierOwnsLane = false;
    cancelHandover?.();
    if (!await isGitRepo(repo)) ctx.ui.notify(`orchestrate: ${await gitCaveat(repo)}`, "warning");
    ctx.ui.setWorkingMessage(`fade_orchestrate: loading ${THINK_LANE} on the router\u2026`);
    await returnVerifyLease();
    const lease = await acquireLaneLease(THINK_LANE, SELF_SESSION, ctx);
    if (!lease.ok) {
      releaseLock();
      ctx.ui.notify(`orchestrate: the :18014 lane lease is held \u2014 ${lease.line}. End the holding run there, then start here. Nothing was written.`, "error");
      return;
    }
    const loaded = await loadLane(THINK_LANE, { leaseToken, sessionId: SELF_SESSION });
    if (!loaded.ok) {
      releaseLock();
      releaseLaneLease();
      ctx.ui.notify(`orchestrate: preflight failed loading ${THINK_LANE} (${loaded.detail}); nothing written`, "error");
      return;
    }
    let burstLive = false;
    const previous = run;
    runDir = join10(repo, "var", "omp-orchestrate");
    if (previous && TERMINAL[previous.state] === true) {
      const archived = await archiveRun(join10(previous.repo || repo, "var", "omp-orchestrate"), previous);
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
    burstLive = true;
    settledNotified = false;
    await writeJsonAsync(join10(runDir, ACTIVE_FILENAME), { run_id: runId, repo, goal, started_utc: run.started_utc, max_rounds: rounds });
    await persist();
    const model = ctx.modelRegistry.find(PROVIDER, THINK_LANE);
    if (!model) {
      fail(ctx, `model ${PROVIDER}/${THINK_LANE} is not in the registry; run written but not started`);
      return;
    }
    if (!await laneSession.pin(ctx, THINK_LANE)) return;
    paint(ctx);
    startMetricsTimer();
    await ensurePhaseTool();
    pi.sendUserMessage(await briefings.plan(run));
  };
  pi.registerCommand("orchestrate", {
    description: `One session, three basalt lanes: ${THINK_LANE} plans, ${VERIFY_LANE} verifies, ${CODE_LANE} codes. /orchestrate [--rounds N] [--demo-redact] <goal> | status | overlay | runs | moe | desk | think [model] <prompt> | verifier [install] | skip [Tn] | verify | reset | lanes reset | pause [note] | code | halt | stop [--clear]`,
    handler: orchestrateCommand
  });
  pi.registerCommand("plan", {
    description: "/plan <goal> \u2014 plan on the selected model. /orchestrate starts the model-switching workflow.",
    handler: async (args, ctx) => {
      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify("usage: /plan <goal>", "info");
        return;
      }
      pi.sendUserMessage(`Create a plan for the following request.

${goal}`);
    }
  });
  pi.on("session_start", async (_event, ctx) => {
    laneControlEnabled = false;
    switchGen++;
    cancelHandover?.();
    cancelHandover = void 0;
    if (isDelegatedSession()) return;
    await ensurePhaseTool();
    await refreshFrontierOwnership(ctx);
    if (RAW_DELIVERABLE && !inputUnsub && run) {
      inputUnsub = ctx.ui.onTerminalInput((data) => {
        if (data !== CHORD || panelOpen) return void 0;
        void openPanelGuarded(ctx);
        return { consume: true };
      });
    }
    const chordNote = run ? resolveChord() : void 0;
    const repo = ctx.cwd;
    const active = await readJsonAsync(join10(repo, "var", "omp-orchestrate", ACTIVE_FILENAME));
    const state = await readJsonAsync(join10(repo, "var", "omp-orchestrate", STATE_FILENAME));
    let runNote;
    if (active?.run_id && state && active.run_id === state.run_id && state.repo === repo) {
      runDir = join10(repo, "var", "omp-orchestrate");
      run = normalizeRun(state);
      settledNotified = false;
      paint(ctx);
      startMetricsTimer();
      if (TERMINAL[state.state] === true) {
        runNote = `run ${state.run_id} is ${state.state} (${statePath()})`;
      } else {
        runNote = `run ${state.run_id} is ${state.state} \u2014 model switching disabled; /orchestrate resume continues it`;
      }
    }
    const line = [chordNote, ...ENV_NOTICES.map((n) => `lanes: ${n}`), runNote].filter((n) => n !== void 0).join(" \xB7 ");
    if (run && line !== "") {
      const at = setTimeout(() => ctx.ui.notify(`orchestrate: ${line}`, "info"), 500);
      at.unref?.();
    }
  });
  pi.on("agent_start", async (_event, ctx) => {
    if (run && TERMINAL[run.state] !== true) {
      if (!await ensurePhaseTool()) setTimeout(() => void ensurePhaseTool(), 500);
      paint(ctx);
      void refreshMetrics().then(() => paint(ctx));
    } else {
      paint(ctx);
    }
  });
  pi.on("before_provider_request", async (event, ctx) => {
    return await laneSession.beforeRequest(ctx, event);
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (isDelegatedSession()) return;
    if (!laneControlEnabled) return;
    if (frontierOwnsLane) return;
    if (!run) {
      if (!isDelegatedSession() && pendingVerifyLane) {
        const want = pendingVerifyLane;
        pendingVerifyLane = void 0;
        traceTrigger("paid", want, void 0, ctx);
        ctx.ui.notify(`lane on verification: ${want} \u2014 the verdict act lands at the turn boundary`, "info");
        const briefs = ctx.model?.provider === PROVIDER && !isThinkingLane(ctx.model.id);
        requestLane(want, ctx, !briefs);
        return;
      }
      if (!isDelegatedSession() && ctx.model?.provider === PROVIDER && isThinkingLane(ctx.model.id)) requestLane(CODE_LANE, ctx, true, true);
      return;
    }
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
        if (run.lane !== CODE_LANE) requestLane(CODE_LANE, ctx, true, true);
        laneControlEnabled = false;
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
  let pendingVerifyLane;
  const traceTrigger = (phase, lane, tool, context) => {
    const dir = join10(process.env.HOME ?? "/tmp", "var", "fade-orchestrate");
    void writeJsonAsync(join10(dir, "lane-trigger.json"), {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      phase,
      lane,
      tool,
      pid: process.pid,
      model: context.model ? `${context.model.provider}/${context.model.id}` : void 0
    }).catch(() => void 0);
  };
  pi.on("tool_call", async (event, ctx) => {
    if (!isDelegatedSession() && event.toolName === "frontier") {
      if (run && TERMINAL[run.state] !== true && event.input?.op !== "status") {
        return { block: true, reason: "fade_orchestrate: this run owns the workflow. Use fade_phase, or stop the run before starting a Frontier task." };
      }
      if (!run || TERMINAL[run.state] === true) {
        frontierOwnsLane = true;
        if (event.input?.op === "intake") frontierTaskActive = true;
        switchGen++;
        pendingVerifyLane = void 0;
        cancelHandover?.();
        await returnVerifyLease();
      }
      return void 0;
    }
    if (laneControlEnabled && !isDelegatedSession() && !frontierOwnsLane) {
      const trig = verifyTrigger(event.toolName, event.input);
      const trigLane = "lane" in trig ? trig.lane : void 0;
      if (trigLane) pendingVerifyLane = trigLane;
      traceTrigger("recorded", trigLane, event.toolName, ctx);
    }
    if (!run || !runDir || isDelegatedSession()) return void 0;
    if (await dispatchDeskBatch(ctx)) return void 0;
    if (event.toolName === "task") {
      const batch = taskBatchOf(event.input);
      if (batch.carriesVerification) {
        await mutateDesk(runDir, run.run_id, (d) => noteTaskBatch(d, { count: batch.verifyAgents.length, agents: batch.verifyAgents }));
        const notWorker = batch.verifyAgents.filter((a) => a !== WORKER_AGENT);
        ctx.ui.notify(
          `orchestrate: task call carries ${batch.count} worker(s), ${batch.verifyAgents.length} with verification work \u2014 the desk batch closes at ${batch.verifyAgents.length} registration(s)${notWorker.length > 0 ? `; ${notWorker.join(", ")} ${notWorker.length > 1 ? "do" : "does"} not carry \`fade_verify\` by definition, so ${notWorker.length > 1 ? "they may" : "it may"} run the checks and never register \u2014 launch verification workers as "${WORKER_AGENT}" (/orchestrate verifier install)` : ""}`,
          notWorker.length > 0 ? "warning" : "info"
        );
      }
      return void 0;
    }
    const live = await liveState();
    if (!live || live.state !== "verifying" || !isThinkingLane(live.lane)) return void 0;
    const name = event.toolName ?? "";
    if (MUTATING_TOOLS[name] !== true) return void 0;
    pushRejection(run, "task", `verifier sandbox: ${name} refused on the thinking lane (read-only); the fix is delegated to the coder`);
    await persist();
    return { block: true, reason: `fade_orchestrate: the verifier lane is read-only \u2014 ${name} is refused. Report the finding with fade_phase; the coder lane applies it.` };
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "frontier" && frontierOwnsLane && !isDelegatedSession()) {
      const phase = frontierPhase(event.details);
      if (phase !== void 0) {
        frontierTaskActive = frontierIsActive(phase);
        if (phase === "none") frontierOwnsLane = false;
      }
      return void 0;
    }
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
    closed = true;
    if (leaseRetryTimer) {
      clearTimeout(leaseRetryTimer);
      leaseRetryTimer = void 0;
    }
    cancelHandover?.();
    clearSurface(ctx);
    stopMetricsTimer();
    await returnVerifyLease();
    if (inputUnsub) {
      inputUnsub();
      inputUnsub = void 0;
    }
  });
}
export {
  currentSwitchGen,
  fadeOrchestrate as default,
  resetFlipLedger
};
