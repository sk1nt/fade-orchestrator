# fade-orchestrator

An [OMP](https://github.com/earendil-works) coding-agent extension. One session runs across **three
model lanes**: a planning lane plans, an advisor lane answers the verdict acts, a code lane
implements, and the `fade_phase` tool contract moves the session between them. `/orchestrate <goal>`.

It targets a local [basalt](https://github.com/sk1nt) router that serves several quantized packs on
one GPU and keeps only one resident. Swapping a 52 GiB pack measures 13–25 s, so a lane swap is the
unit of cost. The router URL, provider id, and the three lane entries are configuration; the package
carries no host-specific code. A lane env that collapses the three lanes into two is **refused and
named at login** — the documented lane wins and the refusal rides the status line (`test/lane_identity.test.mjs`).

## How it works

```
/orchestrate <goal>
   │  planning lane (resident)  ── plan tasks+checks ──▶ fade_phase(planning_done)
   │                                                        │ validation, tier, adaptive budget
   │  code lane                 ◀── swap at the turn boundary
   │        implement, run each task's acceptance command
   │        fade_phase(coding_done)
   │        ┌─ pre-swap gate: run the plan's checks HERE, on the code lane
   │        │   red   → no swap paid; gate briefing names each failing command; self-repair
   │        │   green → swap to the advisor lane for verification
   │  advisor lane: reads the diff, re-runs every check
   │        fade_phase(verification_done accepted)  → complete
   │        fade_phase(verification_done needs_repair) → repair tasks, swap back
```

- **One load site.** The lane swap is issued in `agent_end`, after the turn is closed. A load
  issued into a turn whose chat requests are still queued makes the router swap back to the entry
  the queued requests name — measured live as a 0–2 s ping-pong. `loadLane` settles an in-flight
  swap first and returns without reloading the resident pack, so a load the resident entry already
  covers never re-reads 52 GiB.
- **The start is a proof, not a census.** `/orchestrate <goal>` refuses until the planning lane is
  PROVEN: the supervisor daemon's `lane_state` says `RESIDENT` with `active_pack` = the planning
  pack AND the router serves that id on `/v1/models`. The old one-shot census SKIPPED on a census
  error, the session pinned an id the lane did not serve, and the planning briefing answered
  `404 The model 'basalt/deepseek' does not exist` — measured 2026-11-26. A cold load is not refused:
  the proof polls the daemon's readiness window (`FADE_ORCHESTRATE_START_PROOF_WAIT_MS`, default 240 s,
  13–25 s is the measured load) and never kills a swap in flight. The refusal is a line naming the
  daemon state, the pack, the served id and the wait, and it pays no briefing and writes no state
  (`test/preflight_proof.test.mjs`).
- **The screen follows the lane it OWES.** The residency auto-sync pins a screen to the resident
  pack only when that pack is the lane the session's work is owed (the run's pending lane, the run's
  lane, or a plain session's recorded verify act). A swap drains for tens of seconds, and pinning
  the pack that is still resident in that window is the measured defect: the run asks for
  `deepseek`, the sync lands `flash-next`, and the first completion never names the guest. During
  the drain the pin stays and the line says so: `the swap is draining` (`laneSyncTarget`).
- **The overlay owns its keys.** `esc` (in every encoding the host delivers — legacy byte, Kitty
  CSI-u, xterm modifyOtherKeys), `q`, Ctrl+C and Ctrl+D, and the OPEN chord itself, close the panel:
  the chord is the toggle. The first read is bounded (`FADE_ORCHESTRATE_PANEL_FIRST_MS`, default
  3 s) so a provider that never answers cannot strand the overlay flag with no component mounted —
  the keystroke retries (`docs/OVERLAY.md`, `test/panel.test.mjs`).
- **Planning residency, hand-back at the boundary.** `/plan <goal>` (the planning entry, same
  handler as `/orchestrate`) loads the thinking lane (DS4) first, and DS4 stays resident through
  the whole planning turn: the phase state machine authorizes every lane load, and the only
  planning hand-back is the `planning_done` phase act, which lands the code lane. `coding_done`
  pays the advisor load (`FADE_ORCHESTRATE_VERIFY_LANE`, default `hy4-flash`, never the coder's pack)
  for the verification turn and the advisor stays through it. Terminal states hand the
  lane back to the code lane at the turn boundary (a quiet `setModel` + load, no briefing), `/orchestrate
  stop` does the same at the keystroke, and a **non-run session** whose turn ran on the thinking
  lane hands back at its `agent_end`; delegated sessions never touch the lane. Nothing inside this
  plugin swaps the thinking lane out mid-turn: loads ride the single `agent_end` site, after the
  turn is closed.
- **The advisor is pinned OFF the router.** The desk verifier (`FADE_ORCHESTRATE_VERIFIER_MODEL`,
  default `ninfer-local/coder-gpu1`) pays ZERO lane loads; naming a basalt router entry is refused
  twice — `verifier install` refuses to write it, and the claim-time probe (`probeVerifierLane`)
  refuses the route, falling back to the authorized swap path. An advisor never requests a DS4
  load. Red-gate triage is a tool-less external CLI (`grok`) on its own model; it never touches
  the router.

  The plugin's own thinking call is **in process**. One completion the plugin issues itself
  (`thinklane.ts`, `/orchestrate think`) never touches the lane: no `setModel`, no load, no briefing,
  no swap row — its only cost is the decode. The rule that keeps that honest is RESIDENCY: a request
  naming a model the router does NOT hold is answered by the router swapping the lane (13-25 s per
  direction, 52.2 GiB / 242.1 GiB), so `askLane` refuses it as `lane_not_resident` with **zero bytes
  sent**, and `probeThink` refuses to prove such a lane for the same reason. An endpoint on its own
  port is a different server and is always served — and on this box the DeepSeek-V4.1 server
  (`basalt-deepseek`, `:18016`) claims BOTH cards and is systemd `Conflicts=` with the resident
  `:18014` lane, so "its own port" isolates the router, it does not coexist with the Flash-Next pack.
  A `lane_not_resident` or `endpoint_unreachable` line is that topology being named, not a bug to fix
  by loading DS4 mid-session.
- **The pre-unload VRAM floor is retired.** A controlled swap unloads the resident pack FIRST, so
  free VRAM measured with the old pack resident is not the room the next pack gets — the measured
  1.2 GiB line is a health line that SERVES (`test/load_hostile.mjs`), and a floor measured there
  refused every hand-back on a box that had the room. The lever (`FADE_ORCHESTRATE_VRAM_MIN_FREE_MIB`)
  is no longer read at all, and the free reading is reported in the verdict, never gated on it. The
  dead-context classes (unreachable, error state, zero VRAM, loaded-naming-no-model, swap in flight)
  and the idle/busy/flip guards stay.
- **Lane thrash breaker.** Swaps the router reports away from the run's lane are counted in a
  window. Past `FADE_ORCHESTRATE_FLIP_BREAKER_AT` (4) the loop stops paying: no `setModel`, no
  `POST /v1/load`, the run pauses with the flips, the window and the competing entry in its operator
  note, and the owed lane stays recorded. `/orchestrate lanes reset` clears this process's ledger,
  unpauses and lands the owed lane in one swap. Lane switches are serialised behind one generation
  token, so a superseded switch sets no pill, no lane and sends no briefing (`test/gate_rig.mjs`).
- **Pre-swap gate.** `coding_done` runs every planned check on the code lane *before* the verifier
  swap is issued. A red gate keeps the coding lane resident (0 s), records a rejection, and sends
  the failing output back as the next briefing. The checks run as child processes **off the event
  loop**; the synchronous form froze the TUI for the gate's whole duration. Each row is bounded at
  120 s and the whole gate at a total budget. The running row is named on the working message
  (`gate 2/5: npm test`), the verdict prints with its cost, and a row the budget skipped prints
  `NOT RUN … unmeasured`.
- **The role contract rides the briefing.** The planning briefing states the rule the gate enforces:
  each check row is one command bash can parse, and a `<placeholder>` is a plan defect that keeps the
  gate red on a tree that is fine. The verifier's briefing states its own rubric: "accepted" needs
  every check re-run **by the verifier in its turn**, each row reported as `["cmd","observed"]` with
  what that run printed — the pre-swap gate's green row is not its evidence. A `needs_repair` names
  the next round's tasks as full cards, cause first: a task rejected twice has had this exact diff
  tried (`test/core.test.mjs`).
- **The page itself.** Each briefing is one rendered page: a title line, `## ` sections a blank line
  apart, task cards as bullets with sub-bullets, and the payload skeleton fenced so the lane copies a
  shape instead of inventing one. The format, the strings the suite pins as the contract, and the
  stable-prefix rule the cache bills are in `docs/BRIEFINGS.md`.

- **Protocol gate, three tiers.** A turn that ends with no `fade_phase` call is a protocol miss and
  consumes no coding round. **T1** nudge in place (`pi.sendUserMessage`, counters
  `protocol_retries` / `stall_count`); the round budget and the lane swap are untouched, so a nudge
  costs nothing. **T2** after two missed nudges the round is **synthesized** from machine-checkable
  evidence — `git status --porcelain`, `git diff --stat` and the deterministic gate's exit codes —
  and a red gate keeps the coder resident with zero loads. **T3** the third miss trips the circuit
  breaker (`state: stalled_protocol_error`, paused, zero lane loads); the notify and the overlay
  print what was seen, what is red, the git state, and the acts (`/orchestrate pause`,
  `/orchestrate code`, `/orchestrate stop`).
- **Verifier sandbox.** While the **verifier's turn** is live (`state: verifying` on the thinking
  lane), the writing tools (`edit`, `write`, `apply_patch`, `multiedit`, `notebook_edit`) are removed
  from the active set. The list is a denylist, so a host tool this extension has never seen cannot
  add a write path. The `tool_call` guard blocks them with the rule named, so the finding goes back
  to the coder. The guard reads the **on-disk** run and enforces only the verifier's turn: delegation
  (`task`) is never blocked (a subagent writes nothing, and its session is inert by the rule below),
  and once the run leaves `verifying` the guard stops blocking edits — a session that adopted the
  thinking lane at start does not lock the user's editor (the self-lockout was measured live).
- **Checkpoints.** Every task the verifier accepts leaves `omp-ckpt/<run_id>/T<n>-passed` in the
  repo, namespaced per run so two runs on one tree never collide; the tag prints in the overlay.
- **Delegated sessions are inert.** A subagent shares the cwd, so an unguarded `session_start`
  adopts its parent's run and drives the router from a session that does not own it (measured:
  70.1 s of pack swap and 181.7 GiB loaded across two spin-ups, zero verifier tokens).
  `PI_SESSION_FILE` identifies the delegated shape (nested inside a stamped parent-session dir);
  such a session adopts nothing, nudges nothing, loads nothing and cannot start a run.
- **Payload validation.** `fade_phase` validates the payload exactly (phase per state, allowed keys,
  task schema, dependency order) and refuses with the rule named. From the second refused payload
  the exact JSON schemas ride back in the tool error (schema auto-repair), and every refusal is
  durable in `rejection_history` — the repair briefing feeds the last five back to the model
  ("do not repeat the attempt").
- **Adaptive round budget.** Planning size sets the reserve: 2 tasks → 3 rounds, 4 → 4, 6 → 5.
  Swaps are the unit of cost, so a small plan reserves fewer rounds.
- **Swap history.** Every swap the orchestrator issues is timed (`/health` percent samples,
  first-completion and steady decode tok/s from `/metrics`) into `var/omp-orchestrate/swap_history.json`,
  with `elapsed_ms` and a ramp class — `cold_ramp` / `hot_steady` / `map_restored` (threshold 120
  tok/s: the measured deepseek ramp reads ~91 against a ~130 steady, flash-next runs 480–647) —
  rendered in the overlay as `MoE: Cold Ramp` / `MoE: Hot Steady State (130 tok/s)` /
  `MoE Map: Restored`.
- **Turn ledger.** `var/omp-orchestrate/metrics.jsonl` takes one line per turn
  (`{ts, run_id, turn, round, phase?, pp, tg, ttft, kv_hit_pct, swap_ms, round_outcome}`), built
  **only** from numbers the router reported: with no `pp`+`tg` available the line is not written, so
  the ledger records no zero for a number the router never reported.
- **Residency before the gate.** The lane question is asked of the
  **fade-supervisor daemon** (`GET /v1/residency` over its Unix socket) before the
  router's slot census is polled and before any swap byte is issued. A daemon that
  reports the lane `RESIDENT` with `active_pack` equal to the target lands the
  request with **zero polls, zero DEFERRED, zero swap** — the census calling the
  lane busy (`running=1`) is basalt serving its concurrent slots, not a lane that
  has to move, and the `flash-next load is DEFERRED — slot busy` warning for a lane
  that was never going to move is the symptom this closes. The read is
  **fail-open**: no answer (no daemon, 503, a body with no lane state) falls into
  the busy loop that has always worked, so a daemon under restart costs a load and
  never a refusal. A NO ANSWER is never read as residency, and a cached residency
  is never used: the reading that stops a 52 GiB load has to be current.
- **The socket is chosen by liveness.** `FADE_SUPERVISOR_SOCK` wins outright and is
  never probed (it is the operator's lever, including for a daemon on a nonstandard
  path); otherwise `/run/fade/supervisor.sock` is taken **only if it answers
  `/v1/health`**, then `/tmp/fade-supervisor.sock` only if it answers, then the
  privilege default. A stopped daemon leaves its socket FILE behind, and the
  failure mode of that shadow is a lease granted to a corpse and a swap that never
  lands.
- **A turn that owns no run lease mints one and returns it.** A swap issued by a
  review, escalation or hand-back turn (the overlay keys, the hand-back) carries no
  run token, so it acquires its own lease and `await`s the release in a `finally`:
  success, refused swap, 503, transport throw, bounded timeout — the lane goes back
  every time, and `:18014` returns to its resident pack owner. Every call presents
  `X-Fade-Build: prod` by default, because on the supervisor path the plugin IS the
  lane authority; `FADE_BUILD=dev` is the explicit opt-out, and the daemon answers a
  dev acquire with `403 dev_build_no_evict`. A run's own token is never released by
  a load: the run lifecycle owns that release.

## Screen capture

No clip is stored in the repo. The capture is regenerated from `demo/linkedin.tape` with
[vhs](https://github.com/charmbracelet/vhs) in a real terminal:

```bash
npm run demo:record    # needs vhs, tmux and the omp CLI on PATH, and FADE_DEMO_REPO pointing
                       # at the project the clip shows (default: this package's root)
```

`demo/recording.mjs` seeds a run in that project's `var/omp-orchestrate/`, starts `omp` with the live
extension in a 150x45 tmux terminal rooted there, and drives one clock: `Alt+F` opens the panel, the
selection moves, the pre-swap gate lands GREEN on the code lane, `/orchestrate verify` issues a lane
swap while the status row ramps, the verifier's view carries the measured swap cost, `halt` clears
the row. The clip lands in `demo/out/`; it is generated at record time and is not committed.

Shipped and staged:

- **Shipped code, running, measured:** the real `omp` binary, the real extension, the panel renderer,
  the raw-byte `Alt+F` chord, the act behind `[v]` / `/orchestrate verify`, `POST /v1/load`, the swap
  watcher and the `swap_history.json` row it writes, the turn ledger, the status row's colour ramp.
- **Staged:** the run on disk (goal, tasks, phases, gate) and the router. The stub answers with the
  payload captured from a live lane (`engine 0.4.0`, 13112/24576 expert slots, best decode
  622 tok/s) and holds the `/v1/load` response until the pack is resident, as the live router does.
  It binds its own port (18199), so recording cannot swap the pack a live session is decoding on.
- **The project the clip shows is left intact.** Every run file the demo writes is snapshotted first;
  `npm run demo:stop` kills the demo's processes, restores the snapshot and prints a per-file hash
  comparison. A live run that is in `var/omp-orchestrate/` is preserved like any other file.
- The grid size is measured: 1586x1060 at `FontSize 15` / `LineHeight 1.12` / `Padding 26` is
  150x45 cells, the terminal `test/pty_rig.mjs` proves the panel in. Check it with `stty size`.

## Install

```bash
npm ci && npm run build          # esbuild → dist/index.js
ln -sf "$PWD/src/index.ts" ~/.omp/agent/extensions/fade_orchestrate.ts
```

OMP loads the TypeScript source directly; `dist/index.js` is the bundled single-file form.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `FADE_ORCHESTRATE_ROUTER` | `http://127.0.0.1:18014` | basalt router base URL |
| `FADE_ORCHESTRATE_LOCK_DIR` | `~/.local/state/fade-orchestrator` | the base of the **router claim**: one file per router (`<router-slug>/orchestrator.lock`), holding the owning pid, run id, repo, host and start time. A run claims its router at the keystroke and releases it at `halt`/`stop`/completion/preflight failure; a second session on the same router is refused before any lane load or state write, and the refusal, `/orchestrate status` and the screen all name the holder **with the age of the claim** (`· held 12h00m`), which is the "is this a session that never ended?" reading. Set it to move the whole plane (rigs, containers, a read-only home) |
| `FADE_ORCHESTRATE_PROVIDER` | `basalt` | OMP provider id the lanes live under. `basalt` is the provider that declares every alias of the single `:18014` lane; the live `modelRoles` are all `basalt/*`. `strata-flash` names only `flash-next`, so a thinking-lane `setModel` there cannot resolve and every lane move dies at the registry lookup (measured 2026-11-25) |
| `FADE_ORCHESTRATE_THINK_LANE` | `deepseek` | the **planning** lane. **Read from `process.env` at import** (`src/router.ts`), so `.bashrc` setting it means nothing: a live session cannot be repointed — relaunch with the lane on the launch line. A value equal to the code lane is **refused and named** (the box's `inference-keys.env` exports `flash-next`; honored, that made planning and coding run on the coder's pack with zero swaps, measured 2026-11-26) and the documented lane wins |
| `FADE_ORCHESTRATE_CODE_LANE` | `flash-next` | the coder's pack; the same import-time read, so the boundary hands back to whatever this names. Naming a documented thinking pack here (`deepseek`, `hy4-flash`) is refused the same way: it collapses every lane onto one swap-free coder |
| `FADE_ORCHESTRATE_VERIFY_LANE` | `hy4-flash` | the **advisor** lane: every verdict act (`frontier report`/`review`, a `task` carrying a verification agent, `/orchestrate verify`, `coding_done`'s verification leg) lands here, never on the coder. Equal to the coder is refused (named); equal to the planning lane is honored (one thinking pack for both acts is a lane-economy choice, not a collapse) |
| `FADE_ORCHESTRATE_KEY` | `alt+f` | the screen's key. The host binds `alt+f` to `tui.editor.cursorWordRight`, so `registerShortcut` is **refused** for it and the extension takes the raw byte: `onTerminalInput` consumes `ESC f` (`1b 66`). No host binding is moved; [`docs/OVERLAY.md`](docs/OVERLAY.md) carries the chord history and the list of free single-alt chords |
| `FADE_ORCHESTRATE_FALLBACK_KEY` | `alt+shift+i` | the companion chord (ESC + uppercase `I`), registered where the host's probe reports it free. It opens the screen when `FADE_ORCHESTRATE_KEY` names a chord the host holds |
| `FADE_ORCHESTRATE_SURFACE` | unset | the status line's surface. Default = the host's **top widget** (`placement: aboveEditor`); `status` selects the host's status-bar row |
| `FADE_ORCHESTRATE_PANEL_REFRESH_MS` | `2000` | the open screen's refresh tick (floor 500 ms); the tick is `unref`'d and cleared on close |
| `FADE_ORCHESTRATE_PANEL_FIRST_MS` | `3000` | the bound on the panel's FIRST read: a provider that never answers returns with a named warning and clears the overlay flag, so the chord is never stranded with no component mounted; the keystroke retries |
| `FADE_ORCHESTRATE_GLYPH` | `󰚩` | the status line's leading glyph; an empty value removes it (a terminal without a Nerd Font) |
| `FADE_ORCHESTRATE_REDACT` | unset | `1`, or `/orchestrate --demo-redact` (`--demo-redact=off` to clear), strips the repo path, account, `/home/…`, `~` and the hostname from every rendered line. Display-only: `state.json`, `metrics.jsonl` and `swap_history.json` stay verbatim, and a fresh session starts unredacted |
| `FADE_ORCHESTRATE_HEADLESS` | unset | `1` renders the screen as a widget (110 columns) instead of an overlay component (RPC/print hosts) |
| `FADE_ORCHESTRATE_BASALT_CONFIG` | unset | overrides which basalt serve config the MoE rows read. Unset, the panel reads the config the **running router names in its own `--config`** (from the `/proc` proof), so the rows describe the engine that is serving: the lane's `expert-profile-save`, its profile's age against the engine start, and the GPU placement. Pointing it at a config the router does not serve is answered honestly — the row says `configured, NOT live` and names both paths |
| `FADE_ORCHESTRATE_GATE_POLL_MS` / `_GATE_BUDGET_MS` | `3000` / `60000` | the pre-unload router-idle gate: a `POST /v1/load` is deferred while `/health` reports the router busy, polled every `_GATE_POLL_MS` for up to `_GATE_BUDGET_MS`, then paid anyway. A gate that expires without loading the lane leaves the run stalled |
| `FADE_ORCHESTRATE_GATE_TOTAL_BUDGET_MS` | `600000` | the pre-swap gate's total wall budget across every check; each check keeps its own 120 s timeout. A row that starts with the budget spent is never spawned and prints `NOT RUN … unmeasured` |
| `FADE_ORCHESTRATE_FASTPATH_FILES` / `_LINES` | `1` / `15` | the fast path's bound: a gate-green round that touched ≤ 1 file and < 15 changed lines on the first try completes with zero lane loads |
| `FADE_ORCHESTRATE_SETTLE_POLL_MS` / `_MAX_MS` | `2000` / `120000` | the pre-unload settle window: an in-flight swap is waited out first, and the gate reports the health line seen when the window ends |
| `FADE_ORCHESTRATE_START_PROOF_WAIT_MS` | `240000` | the start preflight's proof window: the planning lane must become PROVEN (daemon `RESIDENT` for the pack AND the router serving its id) before the planning briefing is sent. The window is a fuse for a cold load, never a lever: the proof polls, it does not kill a swap in flight, and a miss is a refusal naming the daemon state, pack, served id and the wait |
| `FADE_ORCHESTRATE_FLIP_WINDOW_MS` / `_FLIP_MIN_SWAPS` / `_FLIP_BREAKER_AT` | `120000` / `2` / `4` | the flip window, the count that badges it, and the count that halts the loop. At the breaker a switch issues no `setModel` and no `POST /v1/load`, the run pauses with the flips named, and `/orchestrate lanes reset` clears the ledger and lands the owed lane |
| `FADE_ORCHESTRATE_SWITCH_GLYPH` | U+F051F | the icon on the model-switch row, in the same Nerd Font private-use family as the status glyph; an empty value removes it and its space (`test/ui_status.test.mjs`) |
| `FADE_ORCHESTRATE_PROOF_TTL_MS` | `10000` | how long the MoE engine proof (the `/proc` scan for the running engine and router) is reused, so the keystroke and the 2 s refresh tick do not re-walk `/proc`; `0` re-scans every call, and a lane load drops the cache. Measured on this box (1103 processes): one walk 2-4 ms, so the TTL is what keeps that out of the panel's refresh path |
| `FADE_ORCHESTRATE_LEDGER_MAX_BYTES` | `8388608` | the turn ledger's size cap: past it, `metrics.jsonl` rotates to `metrics.jsonl.1` (the older `.1` is replaced) and the append starts a fresh file. `0` disables rotation; `readTurns` reads the current file only, so the rotated-out tail is a postmortem file (`node --test test/history.test.mjs`) |
| `FADE_ORCHESTRATE_VERIFY_SETTLE_S` | `8` | the desk's batch window: a batch closes when every censused worker has registered; if some launch and never register (they died, or they verify inline), the batch closes after this many seconds, so the queue never sits on a worker that is never coming |
| `FADE_ORCHESTRATE_VERIFIER_MODEL` | `ninfer-local/coder-gpu1` | the churn route's model. It **must not** resolve to the router: a router entry is a lane load behind the guard, which is the cost the route exists to pay zero of. On this box `@gpu1`, `@slow`, `@task` and `@judge` all resolve to the router entry, so a bare alias is a refusal, not a preference |
| `FADE_ORCHESTRATE_LANE_PROBE_TIMEOUT_MS` / `_LANE_PROBE_CACHE_MS` | `8000` / `15000` | the **claim-time verifier-lane probe**. Before the desk claims a batch for the zero-swap `subagent` route, the lane must answer ONE 1-token completion through its own auth path: its provider key is a command, so a reachable port and a 200 on `/v1/models` can coexist with a generate-time 401, and a claimed batch has **no reclaim path** (`desk.ts:214`) — the batch is owed for the whole run, and each re-registering worker adds another owed request (`desk.ts:285` dedupes only unclaimed ones). A refusal does not claim: the batch takes the `swap` route, the probe is in the operator line, the rejection history and `state.lane_probe`. The reading is cached for `_CACHE_MS`; `0` disables probing (the rigs) and is reported as `skipped`, never as a pass. A **router entry is never probed**: a completion to it pays the swap the route exists to avoid |
| `FADE_ORCHESTRATE_VERIFIER_BASE_URL` / `_VERIFIER_API_KEY` / `_VERIFIER_API` | unset | point the probe at an explicit endpoint — a rig's stub lane, or a host with no `~/.omp/agent/models.yml`. When set, the spec's provider part is ignored and the scan is skipped |
| `FADE_ORCHESTRATE_THINK_MODEL` | `strata-flash/deepseek` | the lane `/orchestrate think` calls by default. A **router** entry is served only while it IS the resident lane (else `lane_not_resident`, zero bytes sent); a provider on its own port is always served. The `FADE_ORCHESTRATE_VERIFIER_*` overrides deliberately do NOT move this lane — one lever per lane, so a reading names the server that answered |
| `FADE_ORCHESTRATE_THINK_TIMEOUT_MS` / `_THINK_MAX_TOKENS` | `180000` / `2048` | one in-process request's window and budget: the window is the 13-25 s swap the call replaces, with slack for a 60-90 tok/s SSD-tier decode. A budget spent inside the thinking channel answers with a **null content** and `finish_reason: length` (measured at 24 tokens on the live lane) — the refusal names the reasoning length and points at this lever, never a silent empty success |
| `FADE_ORCHESTRATE_THINK_PROBE_CACHE_MS` | `15000` | the in-process lane probe's cache window; `0` disables probing and that answer carries `skipped`, so a disabled probe is never read as a proved lane |
| `FADE_ORCHESTRATE_GATE_TRIAGE` / `_GATE_TRIAGE_BIN` / `_GATE_TRIAGE_TIMEOUT_MS` | set / `grok` / `45000` | red-gate **triage**: after a red pre-swap gate, ONE bounded `--disallowed-tools '*'` CLI call names the probable cause from the tails the gate already captured, as one advisory line on the briefing and the tool's answer. Zero authority: the verdict stays the checks' exit codes, no lane load is paid, the advisory agent cannot touch the tree, and a timeout / missing binary / cancelled turn ships the briefing unchanged (`0` disables) |
| `FADE_ORCHESTRATE_VERIFIER_AGENT` | `fade-verifier` | the verification subagent's name: the `task` call's `agent`, and the file `/orchestrate verifier install` writes at `.omp/agents/<name>.md` |
| `FADE_SUPERVISOR_SOCK` | unset | the fade-supervisor daemon's Unix socket. Pinned, it is used outright and never probed; unset, the daemon that ANSWERS `/v1/health` is chosen, `/run/fade/supervisor.sock` before `/tmp/fade-supervisor.sock` |
| `FADE_ORCHESTRATE_LEASE_MINT_TTL_S` | `300` | the lease length a single-turn load asks for when it carries no run token. The daemon clamps it to `lease.max_ttl_s`; the `finally` release is the guarantee, the TTL is the backstop for a caller that dies mid-swap |
| `FADE_BUILD` | `prod` | the build claim in `X-Fade-Build`. `prod` carries eviction authority (acquire + swap under the lease); `dev` is refused the acquire, so a coding session resolves onto whatever is resident and moves nothing |

## Surface and commands

The loop shows **one status line** — one row on the top widget, above the editor, only while a run
is live; while a lane is loading the row turns **multicolored** (a per-character hue ramp whose
phase rides the load percent) and names the incoming pack — and **one screen** on `Alt+F`, laid out
like the host's agents panel. The surface is an env switch: `FADE_ORCHESTRATE_SURFACE=status`
selects the host's status-bar row. [`docs/OVERLAY.md`](docs/OVERLAY.md) is the single authority for
the surface: the status line's format, the ramp, the model-naming rule, the chord's measured history,
the panel's rows and keys, redaction, and the proof inventory.

**A login says at most one line, and it is about the run.** With no run it says nothing: the row
above the editor names the key every round, and `/orchestrate status` answers the run. A delivered
chord is never explained at login; the key contract (fallback chord, `FADE_ORCHESTRATE_KEY`, the
raw-byte claim) is in the docs. Only a configured control chord that the host acts on before any
listener sees the byte gets a login clause: once per process, on the run's own line, so the row
never prints a key that opens nothing.

- `/orchestrate [--rounds N] [--demo-redact] <goal>` — start a run. It claims the router first (one orchestrator per router: the router carries one resident lane, one live-turn ledger and one flip guard, so two runs on one router would each gate the other's working tree). A claim held by a live pid refuses, naming the pid, run, repo and host; a claim whose owner died is reclaimed. Then it preflights the router: the think lane must load.
- `/orchestrate status | overlay | runs | moe | skip [Tn] | verify | reset | lanes reset | pause [note] | code | halt | stop [--clear]` — `status` ends with the swap cost this run paid (`swaps 3 · 41.2s paid`, or `0 swaps`); `runs` prints the archived finished runs, newest first; `moe` prints the per-class record (`ci: 3 swaps · 2/3 warm · profile /var/basalt-profiles/flash-next.prof`), the `gpu` split for both lanes, and the build line (`engine 0.4.0 · ext 0.1.0 · bundle 1a2b3c4d`, every missing piece named)
- `/orchestrate handover` — send the condensed digest now (any time, mid-run).
- `/lanes` — live router census (both entries' status + `/health`).

State lives in `<cwd>/var/omp-orchestrate/`: `ACTIVE.json`, `state.json` (schema v2: rejection
history by kind — `verification` / `schema` / `task` / `protocol` — tier, schema retries, gate
result, protocol counters, `paused` + `operator_note`, synthesized-phase marker, checkpoint tags),
`swap_history.json`, `metrics_state.json`, `metrics.jsonl`. v1 files are migrated on resume. Every
write is `.tmp` → `fsync` → rename → `fsync` of the directory, so a `kill -9` mid-write leaves the
previous phase parseable.

**A finished run stays readable.** `state.json` is one slot, so a start archives the TERMINAL run it
is about to overwrite into `runs/<run_id>.json` (a run that is not terminal is left alone, and an
archive already on the shelf is never rewritten); `/orchestrate runs` reads the shelf back.
`metrics.jsonl` is append-only, so past `FADE_ORCHESTRATE_LEDGER_MAX_BYTES` it rotates to
`metrics.jsonl.1`, one predecessor kept — the screen reads the current file, so a rotated-out tail is
a postmortem file, not a panel row.

## Subagents and the verification desk

A delegated worker verifies **its own** acceptance and **never switches a lane** — lane control is the
owner run's. It calls `fade_verify` with its objective, acceptance line and commands; the plugin
files that as a request (`V<batch>.<n>`) in `<run>/verify/desk.json` and **blocks the worker** until
a verdict is written against its id.

**The batch, not the arrival, is answered.** A `task` call is censused when it launches and sealed
when it returns: `expected` is the number of workers in flight that **carry verification work** (a
plain worker opens no batch), and the batch closes when every one of them has registered. While a
batch is open, a request pays **zero** `POST /v1/load` — one worker registering while its peers have
not is a queue position, not a lane. A closed batch is claimed **once**, and N requests in it are
answered by **one** lane load: the verifier's briefing is a single page carrying every request's
objective, acceptance, checks and files, and the round answers with
`verdicts: [{id, accepted, notes}]` covering every id. A verdict for an id outside the claimed
batch, a batch the desk never claimed, and a partial id set are each refused by name; a claimed
batch is never claimed again, so a request that arrives mid-pass lands in the **next** batch and is
told which one.

**Churn is a route, not a retry.** When the churn has begun — the thrash breaker halted the loop, or
the flip guard was reached — the desk is marked and every batch answers on the **verification
subagent** at **zero lane loads**: `task { "agent": "fade-verifier" }` on a **non-router** model
(`ninfer-local/coder-gpu1`, the NInfer coding server on `:8002`, a separate process from the router;
NInfer's own `/v1/load` is a cold pack load, so paying it is the thing to avoid). The route is
recorded on the desk batch and in the run's rejection history, holds for every later batch of the
run, and is released by `/orchestrate lanes reset`.

- `/orchestrate desk` — the queue: batch epoch, open / awaiting-verdict / answered counts, churn state, verifier model.
- `/orchestrate think [provider/model] <prompt>` — ONE in-process completion: the plugin's own request to the endpoint the provider plane resolves, the answer printed, the endpoint and elapsed named. No `setModel`, no `POST /v1/load`, no lane change in any branch; naming a non-resident router entry refuses as `lane_not_resident`, a dead endpoint names `endpoint_unreachable`, a budget spent thinking names `no_completion` with the reasoning length. The last call lands on `state.lane_call` and `/orchestrate status` prints it, in words (`no in-process call`) when there was none. Measured on the live box, three runs: the resident lane answered in **0.1-1.0 s** (5 answer chars + 109-118 reasoning; the slow run queued behind the session's own traffic on the lane), the owed DS lane refused in **4-5 ms** with zero bytes sent, `:18016` down as `endpoint_unreachable`, the router's resident entry identical before and after — `node test/build.mjs && node test/thinklane_live.mjs` prints `PROOF PASS`.
- `/orchestrate verifier install` — write TWO definitions in one act: `.omp/agents/fade-verifier.md` (the batch judge, pinned to a non-router model) and `.omp/agents/fade-worker.md` (the worker, whose `tools:` line carries `fade_verify`). `verifier show` prints both and says which are installed.
- `fade_verdicts {batch, verdicts}` — the desk write for a verifier that runs **outside** the phase protocol (the subagent): post the verdicts by id, fan them out, unblock the workers.

A prose answer never unblocks a worker: only a verdict written to the desk does. A worker that
cannot reach the desk **refuses** — it never answers optimistically on the router's state.

**A worker registers only if its agent definition lists the tool.** Measured in a live run: a `scout`
worker registered, and a read-only `reviewer` ran its checks and never did — so the census counted a
worker that could not arrive and the batch closed on the settle window instead of on its request. The
census says that at the launch, naming the agent, and the coder's window page names `fade-worker` as
the agent to delegate a verifying slice to.

The desk's schema, closure rules and measured invariants: [`docs/DELEGATION.md`](docs/DELEGATION.md).

## MoE expert placement (last known placement between turns)

The engine can persist the expert placement it derives at runtime and re-apply it on the next start.
The measured difference is a 91 tok/s cold ramp (experts promoted during the first ~1,200 tokens)
against a warm start. `moe.ts` reads it per lane and records it on every swap row.

**The per-class record.** One pack carries one placement profile, so the actionable question is which CLASS of work lands on which lane, and whether that lane came in warm. `taskmoe.ts` classifies each task from the plan's own words (`ci` / `tests` / `docs` / `code`, priority in that order), the swap row carries the class of the window it opened (`task_class`), and `/orchestrate moe` prints the census: swaps per class, how many landed on a lane whose saved placement was live AND written by the running engine, the profile path, the card split, and the build line. CI work runs on the code lane — the only save-capable alias — so its warm share is the number that answers "will the CI job start on hot experts?" The verifier pack has no save path in this engine release, so its class can never read warm: named, not counted as a failure.

Measured engine facts (`docs/configuration/index.md` of basalt 0.4.0):

| key | effect |
|---|---|
| `expert-profile-save` | **Flash-Next only.** Saves the adaptive tier's placement on exit and every `expert-profile-save-every` minutes; a start places from it. Needs the adaptive tier. |
| `expert-profile` | Which experts start in VRAM (default `data/profiles/<arch>-<layers>x<experts>.prof`). |

Setup (per lane, host config, not this package):

1. in the serve config's model entry add
   `"expert-profile-save": "<repo>/var/basalt-profiles/<alias>.prof"` and
   `"expert-profile-save-every": 10`;
2. reload that lane at a quiet moment.

The overlay then shows `MoE <lane>: live · 2.4 h old · warm start`. The states are:

- **configured, NOT live** — the config names the file and the running engine's cmdline does not
  carry the flag (a config edit without a reload reports this state).
- **unsupported** — DeepSeek-V4.1 has no save path in engine 0.4.0 (only the pack's static
  profile, `src/models/deepseek41/tier.cpp`; `write_expert_profile` is wired only by the qwen4exp
  `--expert-profile-save` path). The thinking lane's pack rebuilds placement on every swap and
  stays cold; configuration cannot make it warm.

## Why the thinking lane defaults to `IQ1_M`

Both DeepSeek packs can be served under two aliases; this package defaults the plan/verify lane to
the **IQ1_M** pack: it stays resident where IQ2_XXS spills, and IQ2's spill costs ~2.8× decode.
Measured on a reference host (122 GiB RAM, 2 × 32.6 GiB VRAM, identical settings both sides):

| | expert slots | spill | decode (warm) | wall, short answer |
|---|---:|---|---:|---:|
| IQ1_M | 2,200 | **none** | 97–189 tok/s | 0.3–0.6 s |
| IQ2_XXS | 1,600 | **2,680 / 15,360 experts · 27.4 GB in the file** | 37–65 tok/s | 1.0–49.1 s |

IQ2 scores better on the KL/top-1 arms (0.2408 / 85.15 % vs 0.2779 / 83.88 %); PPL is lower on
IQ1_M (3.1074 vs 3.0456); a 10-question deterministic spot check tied at 10/10. The default is a
throughput decision. The **expert slots** row prints the engine's own `spill`, and
`spill.experts > 0` means the pack is served from disk. Swaps are
`POST /v1/load {"model":"<alias>"}` and clients wait through them, so an A/B is one request, not a
restart. Full numbers, method and the reproduce commands: [`docs/quant-choice.md`](docs/quant-choice.md).

## Fast handover

A new lane, and a session that resumes after a restart, both start with no conversation: the
transcript carries nothing over. `core.handover` rebuilds the run as a condensed digest — goal,
phase contract, task definitions, then statuses, gate tails, rejections and the working-tree diff
stat — ordered **stable first, volatile last**.

The order is for basalt's conversation cache: it reuses a request's prefix, and `/metrics` reports it
per request (`hit_rate`, `reused`). Measured on a reference host: `hit=44.9%` early,
`hit=82.3%` once the prefix settles; a 106k-token prompt prefills in **3.5 s at 1,499 tok/s**
(`pp=111459`), so the same prompt served again with an 82% hit finishes its prefill in 0.5 s. The
handover is 2–6k tokens: tenths of a second, and stable-first keeps the hit rate rising across
rounds.

Ways to load it:

- `/orchestrate handover` — send the condensed digest now (any time, mid-run).
- `FADE_ORCHESTRATE_AUTO_RESUME=1` — on session start, a mid-flight run sends its handover
  automatically once the session is idle.
- every lane-switch briefing already carries the previous round's results, rejections and the
  last verifier critique.

## Tests

```bash
npm test                 # unit tests: keymap, state v2, gate (off the event loop, and its
                        # total budget kills a hung row), MoE, history, livedata, the screen's
                        # renderer (every ESC encoding closes), the screen's data contract, the
                        # status line, the desk's batch rules, the verifier's routing
npm run test:gate        # the gate rig — a host-less CI gate (fake pi + stub router): the whole
                         # phase protocol, the pre-swap gate (zero loads on red, the row named as
                         # it runs), the Alt+F raw listener, the login line that names only the
                         # run, the fast path, the
                         # --demo-redact surface, the top-widget surface, the verification desk
                         # (zero loads while a batch is open, ONE load per closed batch, verdicts
                         # by id), and the churn route to a non-router model at zero loads
node test/load_hostile.mjs # the pre-unload gate against a hostile /health (error state,
                         # zero/low VRAM, no model, swap in flight, unreachable): ZERO
                         # POST /v1/load with the class named
npm run test:pty         # the pty rig — host-only, needs the omp CLI and tmux: the real
                         # terminal, the live extension, FADE_ORCHESTRATE_LIVE_SMOKE=1
node test/rpc_rig.mjs    # the rpc rig — host-only, needs the omp CLI: headless proof through
                         # `omp --mode rpc`: the line, the screen's content, the redaction OFF
                         # half, skip/halt persistence (runs ~90 s)
```

`dist/index.js` is a **generated bundle** — the esbuild output of `src/*.ts`, committed so the
tree carries a loadable single file; the unit tests and rigs import the bundle
`test/build.mjs` writes into `.test-build/`, not `dist/`. `demo/out/` screen captures are
generated by `npm run demo:record` and are not shipped.

The rigs drive the command surface with the router pointed at a closed port: the status line
renders with nothing networked, and the screen prints the name of every number it cannot measure.
RPC carries no raw keystrokes, so the chord is proved twice: by the fake-host rig (the host's table
refuses an `alt+f` registration — the rig models that refusal — and the `ESC f` listener consumes
the byte and opens, while the fallback chord is the registered one) and by the pty rig (the bytes
sent to a real 150×45 terminal, the panel on screen, `ESC f` opening, the legacy Escape, the
injected Kitty CSI-u escape, `q` and the chord itself all closing, the chord re-opening after any
close (the toggle), halt clearing, and `ctrl+o` staying the host's).

**Run root = git working tree.** `/orchestrate` roots a run at the session cwd and reads that
directory with git (`status --porcelain`, `diff --stat`, checkpoint tags). Outside a working tree
`git diff` does not fail — git switches to `--no-index` mode and prints its usage page — so every
git reader is gated on one `rev-parse --git-dir` probe (`isGitRepo`) and degrades to the named
sentinel `(not a git repo: <path> …)`: the synthesizer then reports each task `blocked` naming the
missing repo and writes no working-tree evidence, and checkpoint tags are refused by name. Both rigs
seed their root with `git init` + a commit for the same reason.

**The rigs strip the caller's session identity.** `isDelegatedSession` treats a session whose jsonl
sits inside a dated parent dir as a delegated subagent — the shape that makes a worker inert on its
parent's run. A rig launched from a `task` agent inherits that agent's `PI_SESSION_FILE`, so every
launched `omp` was classified delegated: the status row suppressed by the `owned` rule and
`/orchestrate plan` refused (17 pty checks failed against a bare TUI frame with
`orchestrate: no run active` as the only extension line, and the rpc stream carried the refusal
verbatim). The rpc rig deletes `PI_SESSION_FILE`/`PI_SESSION_ID` from the child env; the pty rig
launches through `env -u PI_SESSION_FILE -u PI_SESSION_ID`. The child host then owns its session
identity (`--no-session`).

## Layout

```
src/index.ts      extension wiring: tool, commands, hooks, lane switching, the panel's raw-key listener
src/core.ts       state machine data half: schema v2, validation, briefings (per-task critique,
                  compact repair, the ONE verification-batch page), the gate runner, the task window
src/router.ts     basalt router client: listLanes/laneHealth/loadLane + the pre-unload gate
src/desk.ts       the verification desk: batched worker requests, claims, verdicts, churn state
src/subagent.ts   the churn route: the off-router verifier, its task call, its agent definition
src/ui.ts         the status line, the model label, the ramp, the redactor
src/panel.ts      the Alt+F screen: layout, scroll, keys (every ESC encoding), both surfaces
src/screendata.ts the screen's data contract: every row, and the name of every missing number
src/keymap.ts     s/v/r/c/h actions, pure over RunState
src/livedata.ts   /metrics + /health readers, swap watcher, cold/hot
src/history.ts    swap and turn ledger stores
src/moe.ts        per-lane MoE placement: the serve config, the live/unsupported states
test/             unit tests, the gate rig (fake host), the RPC rig, the pty rig (real terminal)
docs/OVERLAY.md   the surface: layout, metrics, keys, redaction, proof inventory
docs/quant-choice.md the IQ1_M pin: the measurement, the method, the reproduce commands
docs/FEATURES.md  the feature sweep: each proposal, the code that shows the gap, its cost, the command that accepts it
docs/DELEGATION.md the verification desk: schema, closure rules, the churn route, the invariants
docs/overlay-holding-page-2026-11-26.md the loading-phase proxy TUI, the `terminalSize` wrapper, and the switch's holding page
```

## License

MIT — see `LICENSE`.
