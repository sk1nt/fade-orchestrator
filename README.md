# fade-orchestrator

An [OMP](https://github.com/earendil-works) coding-agent extension. One session runs across **two
model lanes**: a thinking lane plans and verifies, a code lane implements, and the `fade_phase` tool
contract moves the session between them. The command that runs it is `/orchestrate <goal>`.

It targets a local [basalt](https://github.com/sk1nt) router that serves several quantized packs on
one GPU and keeps only one resident. Swapping a 52 GiB pack measures 13–25 s, so a lane swap is the
unit of cost. The router URL, provider id, and the two lane entries are configuration; the package
carries no host-specific code.

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
   │        │   green → swap to the thinking lane for verification
   │  planning lane: reads the diff, re-runs every check
   │        fade_phase(verification_done accepted)  → complete
   │        fade_phase(verification_done needs_repair) → repair tasks, swap back
```

- **One load site.** The lane swap is issued in `agent_end`, after the turn is closed. A load
  issued into a turn whose chat requests are still queued makes the router swap back to the entry
  the queued requests name — measured live as a 0–2 s ping-pong. `loadLane` settles an in-flight
  swap first and returns without reloading the resident pack, so a load the resident entry already
  covers never re-reads 52 GiB.
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
| `FADE_ORCHESTRATE_PROVIDER` | `strata-flash` | OMP provider id the lanes live under |
| `FADE_ORCHESTRATE_THINK_LANE` | `deepseek` | entry that plans/verifies (thinking lane) |
| `FADE_ORCHESTRATE_CODE_LANE` | `flash-next` | entry that implements |
| `FADE_ORCHESTRATE_KEY` | `alt+f` | the screen's key. The host's key table **binds** `alt+f` (`tui.editor.cursorWordRight`), so `registerShortcut` is **refused** for it and the extension claims the **raw byte**: `onTerminalInput` consumes `ESC f` (`1b 66`) before the host's binding runs, and the pty rig opens the panel while `cursorWordRight` does not. `ctrl+o` is `app.tools.expand` and the host acts on its own bindings; the pty rig presses `C-o` and the extension opens nothing. Free single-alt chords in the host's 38-action table: `alt+c/e/j/q/s/t/u/v/w/x/z`. No host binding is moved; [`docs/OVERLAY.md`](docs/OVERLAY.md) carries the chord history |
| `FADE_ORCHESTRATE_FALLBACK_KEY` | `alt+shift+i` | the registered companion chord (ESC + uppercase `I`, probe-reported FREE). Registered as a shortcut where the host's probe accepts it, and taken at the raw-input layer like the primary chord. It opens the screen when `FADE_ORCHESTRATE_KEY` points at a chord the host holds |
| `FADE_ORCHESTRATE_SURFACE` | unset | the status line's surface. Default = the host's **top widget** (`placement: aboveEditor`); `status` selects the host's status-bar row |
| `FADE_ORCHESTRATE_PANEL_REFRESH_MS` | `2000` | the open screen's refresh tick (floor 500 ms); the tick is `unref`'d and cleared on close |
| `FADE_ORCHESTRATE_GLYPH` | `󰚩` | the status line's leading glyph; an empty value removes it (a terminal without a Nerd Font) |
| `FADE_ORCHESTRATE_REDACT` | unset | `1` — or `/orchestrate --demo-redact`, `--demo-redact=off` to turn it off again — strips the repo path, account, `/home/…`, `~` and this hostname from every rendered **line**. **Display-only**: `state.json`, `metrics.jsonl` and `swap_history.json` are written verbatim, and a fresh session starts unredacted (`test/gate_rig.mjs`, `test/panel.test.mjs`, `test/rpc_rig.mjs`) |
| `FADE_ORCHESTRATE_HEADLESS` | unset | `1` renders the screen as a widget (110 columns) instead of an overlay component (RPC/print hosts) |
| `FADE_ORCHESTRATE_BASALT_CONFIG` | unset | the basalt serve config JSON; enables the per-lane MoE placement panel (`expert-profile-save`) |
| `FADE_ORCHESTRATE_GATE_POLL_MS` / `_GATE_BUDGET_MS` | `3000` / `60000` | the pre-unload **router-idle** gate: a `POST /v1/load` is deferred while `/health` reports the router busy, one poll every `_GATE_POLL_MS` for up to `_GATE_BUDGET_MS`, then paid anyway; a gate that expires without loading the lane leaves the run stalled. The rigs shrink both so a whole budget runs in milliseconds |
| `FADE_ORCHESTRATE_GATE_TOTAL_BUDGET_MS` | `600000` | the pre-swap gate's **total** wall budget across every check (each check keeps its own 120 s timeout). A row that starts with the budget spent is never spawned and prints `NOT RUN … unmeasured`; `test/core.test.mjs` proves the bound in 1 s |
| `FADE_ORCHESTRATE_FASTPATH_FILES` / `_LINES` | `1` / `15` | the fast path's bound — a gate-green round that touched ≤ 1 file and < 15 changed lines on the FIRST try completes with zero lane loads; the same round on a 20-line diff takes exactly one swap (`test/gate_rig.mjs` measures both sides) |
| `FADE_ORCHESTRATE_VRAM_MIN_FREE_MIB` | `8192` | the pre-unload floor. A router that reports free VRAM under it — or zero/negative, an error state, a loaded context that names no model, a swap still in flight, or no answer at all — **refuses** the lane load with the class named, and `POST /v1/load` is never sent (`node test/load_hostile.mjs`) |
| `FADE_ORCHESTRATE_SETTLE_POLL_MS` / `_MAX_MS` | `2000` / `120000` | the pre-unload settle window: an in-flight swap is waited out first, and the gate reports the health line observed when the window ends. The rigs shrink it so the hung-context class is proved in milliseconds |
| `FADE_ORCHESTRATE_FLIP_WINDOW_MS` / `_FLIP_MIN_SWAPS` / `_FLIP_BREAKER_AT` | `120000` / `2` / `4` | the flip guard's window, the count that badges it, and the count that HALTS the loop: at the breaker a switch issues no `setModel` and no `POST /v1/load`, the run pauses with the flips named, and `/orchestrate lanes reset` clears this process's ledger and lands the owed lane (`test/gate_rig.mjs` proves both sides in milliseconds) |
| `FADE_ORCHESTRATE_SWITCH_GLYPH` | U+F051F | the icon on the model-switch row, in the same Nerd Font private-use family as the status glyph; an empty value removes it and its space (`test/ui_status.test.mjs`) |
| `FADE_ORCHESTRATE_PROOF_TTL_MS` | `10000` | how long the MoE engine proof (the `/proc` scan for the running engine and router) is reused, so a panel keystroke and the 2 s refresh tick do not re-walk `/proc`; `0` re-scans every call. A lane load drops the cache |

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

- `/orchestrate [--rounds N] [--demo-redact] <goal>` — start a run (preflights the router: think lane must load).
- `/orchestrate status | overlay | skip [Tn] | verify | reset | lanes reset | pause [note] | code | halt | stop [--clear]`
- `/orchestrate handover` — send the condensed digest now (any time, mid-run).
- `/lanes` — live router census (both entries' status + `/health`).

State lives in `<cwd>/var/omp-orchestrate/`: `ACTIVE.json`, `state.json` (schema v2: rejection
history by kind — `verification` / `schema` / `task` / `protocol` — tier, schema retries, gate
result, protocol counters, `paused` + `operator_note`, synthesized-phase marker, checkpoint tags),
`swap_history.json`, `metrics_state.json`, `metrics.jsonl`. v1 files are migrated on resume. Every
write is `.tmp` → `fsync` → rename → `fsync` of the directory, so a `kill -9` mid-write leaves the
previous phase parseable.

## MoE expert placement (last known placement between turns)

The engine can persist the expert placement it derives at runtime and re-apply it on the next start.
The measured difference is a 91 tok/s cold ramp (experts promoted during the first ~1,200 tokens)
against a warm start. `moe.ts` reads it per lane and records it on every swap row.

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
                        # status line
npm run test:gate        # the gate rig — a host-less CI gate (fake pi + stub router): the whole
                         # phase protocol, the pre-swap gate (zero loads on red, the row named as
                         # it runs), the Alt+F raw listener, the login line that names only the
                         # run, the fast path, the
                         # --demo-redact surface, the top-widget surface
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
sent to a real 150×45 terminal, the panel on screen, `ESC f` opening, the legacy Escape and the
injected Kitty CSI-u escape closing, halt clearing, and `ctrl+o` staying the host's).

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
                  compact repair), the gate runner, the task window
src/router.ts     basalt router client: listLanes/laneHealth/loadLane + the pre-unload gate
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
```

## License

MIT — see `LICENSE`.
