# fade-orchestrator

An [OMP](https://github.com/earendil-works) coding-agent extension that runs one session across
**two model lanes**: a thinking lane plans and verifies, a code lane implements, and a hard phase
contract (`fade_phase`) moves between them. It is built for a local
[basalt](https://github.com/sk1nt) router that serves several quantized packs on one GPU and can
only keep one resident — every design decision below is shaped by the 13–25 s it costs to swap a
52 GiB pack.

Extracted from the `fadetheworld` trading desk (2026-11-15); the router URL, provider id, and the
two lane entries are configuration, nothing here is host-specific.

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
  the queued requests name — measured as a 0–2 s ping-pong on 2026-11-14. The orchestrator never
  pays a swap that a resident entry already covers: `loadLane` settles an in-flight swap first
  and refuses to reload the resident pack (52 GiB re-read for nothing).
- **Pre-swap gate.** `coding_done` runs every planned check on the code lane *before* the
  verifier swap is paid. Red keeps the coding lane resident (0 s), records a rejection, and sends
  the failing output back as the next briefing.

- **Protocol gate, three tiers.** A turn that ends with no `fade_phase` call is *protocol debt*,
  not a coding round: **T1** nudge in place (`pi.sendUserMessage`, counters `protocol_retries` /
  `stall_count` — the round budget and the lane swap are untouched, a nudge is free); **T2** after
  two missed nudges the round is **synthesized** from what the machine can prove — `git status
  --porcelain`, `git diff --stat` and the deterministic gate's exit codes — and a RED gate keeps
  the coder resident with zero loads; **T3** the third miss trips the circuit breaker
  (`state: stalled_protocol_error`, paused, ZERO lane loads) and the notify/overlay carry the
  actionable diagnostic: what was seen, what is RED, the git state, and the acts
  (`/orchestrate pause`, `/orchestrate code`, `/orchestrate stop`).
- **Verifier sandbox.** While the **verifier's turn** is live (`state: verifying` on the thinking
  lane), the writing tools (`edit`, `write`, `apply_patch`, `multiedit`, `notebook_edit`) are removed
  from the active set — a denylist, so a host tool this extension has never seen cannot slip a write
  past it — and the `tool_call` guard blocks them with the rule named, so the finding is delegated
  back to the coder. The guard reads the **on-disk** run and enforces only the verifier's turn:
  delegation (`task`) is never blocked (a subagent writes nothing, and its session is inert by the
  rule below), and a session that adopted the thinking lane at start cannot keep refusing the
  operator's editor after the run left `verifying` — that self-lockout was measured live.
- **Checkpoints.** Every task the verifier accepts leaves `omp-ckpt/<run_id>/T<n>-passed` in the
  repo, namespaced per run so two runs on one tree never collide; the tag prints in the overlay.
- **Delegated sessions are inert.** A subagent shares the cwd, so an unguarded `session_start`
  adopts the operator's run and drives the router from a session that does not own it (measured:
  70.1 s of pack swap and 181.7 GiB loaded across two spin-ups, zero verifier tokens).
  `PI_SESSION_FILE` identifies the delegated shape (nested inside a stamped parent-session dir);
  such a session adopts nothing, nudges nothing, loads nothing and cannot start a run.
- **Phase contract with teeth.** `fade_phase` validates the payload exactly (phase per state,
  allowed keys, task schema, dependency order) and refuses with the rule named. From the second
  refused payload the exact JSON schemas ride back in the tool error (schema auto-repair), and
  every refusal is durable in `rejection_history` — the repair briefing feeds the last five back
  to the model ("do not repeat the attempt").
- **Adaptive round budget.** Planning size sets the reserve: 2 tasks → 3 rounds, 4 → 4, 6 → 5.
  Swaps are the unit of cost; a small plan must not reserve six.
- **Swap history.** Every swap the orchestrator drives is timed (`/health` percent samples,
  first-completion and steady decode tok/s from `/metrics`) into `var/omp-orchestrate/swap_history.json`,
  with `elapsed_ms` and a ramp class — `cold_ramp` / `hot_steady` / `map_restored` (threshold 120
  tok/s: the measured deepseek ramp reads ~91 against a ~130 steady, flash-next runs 480–647) —
  rendered in the overlay as `MoE: Cold Ramp` / `MoE: Hot Steady State (130 tok/s)` /
  `MoE Map: Restored`.
- **Turn ledger.** `var/omp-orchestrate/metrics.jsonl` takes one line per turn
  (`{ts, run_id, turn, round, phase?, pp, tg, ttft, kv_hit_pct, swap_ms, round_outcome}`), built
  **only** from numbers the router reported: with no `pp`+`tg` available the line is not written —
  the ledger never carries a fabricated zero.

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
| `FADE_ORCHESTRATE_KEY` | `alt+shift+f` | the screen's key, chosen by measurement. The host's runtime conflict probe answers **FREE** for `alt+shift+f` (ESC + `F`, byte-distinct from every control code) — and answers `keybinding tui.editor.cursorWordRight` for `alt+f`, which a strings-extracted copy of the host's default-key table had suggested was free (measured 2026-11-15: the pty rig watched ESC `f` move the word, never open a panel). `ctrl+o` is `app.tools.expand` and the host **acts** on its own bindings. The extension registers the chord as a shortcut AND takes the byte at the raw-input layer; it never moves a host binding |
| `FADE_ORCHESTRATE_FALLBACK_KEY` | `alt+shift+i` | the registered companion chord (ESC + uppercase `I`, also probe-reported FREE). Registered only where the host's conflict probe accepts the chord, and it is what opens the screen if `FADE_ORCHESTRATE_KEY` is pointed at a chord the host holds |
| `FADE_ORCHESTRATE_SURFACE` | unset | the status line's surface. Default = the host's **top widget** (`placement: aboveEditor`); `status` opts into the host's status-bar row |
| `FADE_ORCHESTRATE_PANEL_REFRESH_MS` | `2000` | the open screen's refresh tick (floor 500 ms); the tick is `unref`'d and cleared on close |
| `FADE_ORCHESTRATE_GLYPH` | `󰚩` | the status line's leading glyph; an empty value drops it (a terminal without a Nerd Font) |
| `FADE_ORCHESTRATE_REDACT` | unset | `1` strips the repo path, account, `/home/…`, `~` and this hostname from every rendered line, so a screenshot is safe |
| `FADE_ORCHESTRATE_HEADLESS` | unset | `1` renders the screen as a widget (110 columns) instead of an overlay component (RPC/print hosts) |
| `FADE_ORCHESTRATE_BASALT_CONFIG` | unset | the basalt serve config JSON; enables the per-lane MoE placement panel (`expert-profile-save`) |
| `FADE_ORCHESTRATE_GATE_CMD_TIMEOUT_MS` | `300000` | the pre-swap gate's per-command wall budget; the rig class measured 180.8 s (`node test/rpc_rig.mjs`), so a 120 s constant could never leave the round |

## Publish and tree parity

`deploy/omp/` in the fade repo is the split **source**: `scripts/ops/orchestrator_publish.sh` maps
it to this repo with `git subtree split` (history preserved) and, before any push, proves the
split's tree equals `deploy/omp` at HEAD and names the divergence class — a push that would discard
remote commits **refuses** unless `--force` is passed deliberately (measured 2026-11-15: five
commits lived on the clone and were not in the split; the old blind `--force` deleted them).

The clone you install from is a **consumer**: keep it at the split head
(`git fetch && git reset --hard <split>`), and in the fade repo run
`scripts/ops/omp_tree_parity_check.sh` — exit 0 `trees equal` (compared by tree object id), exit 1
`BREAK` naming every differing path, exit 2 a named `SKIP clone_missing`. The clone is the code the
extension **loads** (the `fade_orchestrate.ts` symlink resolves into it); the split is the code that
**ships**; this gate is what stops those from becoming two different programs.

## Surface

The operator gets **one line** all day and **one screen** on demand. Both are specified in
[`docs/OVERLAY.md`](docs/OVERLAY.md) — layout, metrics, keys, the surface switch, the measured
reason the screen is on `Alt+Shift+F` and not `Ctrl+O` (nor `Alt+F`), and how the chord is disclosed at startup. The
chord is wired twice on purpose: registered as a shortcut (`pi.registerShortcut(FADE_KEY)`, so the
host parses it) **and** taken at the raw-input layer (`onTerminalInput`, so the byte is consumed
wherever the host's shortcut table declines it).

- `/orchestrate [--rounds N] <goal>` — start a run (preflights the router: think lane must load).
- `/orchestrate status | overlay | skip [Tn] | verify | reset | pause [note] | code | halt | stop [--clear]`
- `/lanes` — live router census (both entries' status + `/health`).
- **The status line** — one row on the top widget, above the editor, only while a run is live:
  `󰚩 Orchestrator: code R1/6 · T2/5 · [Alt+Shift+F]`, with `· protocol <n>/3` while the Tier-1 counter
  runs, `· paused` while the loop is parked and a tok/s suffix when the router reports one. While a
  lane is loading, the state segment becomes the switch and the row turns **multicolored** — a
  per-character hue ramp whose phase rides the load percent, so it visibly moves on every sample:
  `Orchestrator: switching deepseek→flash-next (IQ3_S, dual) 47% · [Alt+Shift+F]`. Color means *working*:
  the steady row ships no escape codes at all. The line is **cleared** — the widget removed — on a
  terminal run (`complete`/`failed`/`stopped`, including a run adopted from disk at `session_start`)
  and when this session does not own the run.
  The bracket names the chord that **opens the screen**: the configured chord while the host's probe
  reports it FREE, the fallback chord when the host holds the configured one — never the held key
  itself.
- **Model names are abbreviated, and named exactly once.** The form is
  `<model> (<QUANT>, <GPU count>)` — `flash-next (IQ3_S, dual)`, `deepseek (IQ1_M, dual)`; version,
  family word and the RAM/SSD tier are dropped, because the quant and the GPU count are the two
  facts that change the loop's economics. The single place the name rides on the screen is the
  engine column's `resident` row; the panel's lane line carries the lane KEYS with the `◆resident`
  marker, and the steady status line names no model at all (the host's model segment is the model's
  surface; the switching row names the incoming lane, because that is what the switch is about).
  Printing the same model twice was the operator's objection, so the surfaces are split:
  one line for the loop's state, one row for the engine's identity.
- **`Alt+Shift+F`** — the orchestration screen, in the shape of the host's own agents panel. The key
  is the chord the host's own conflict probe reports FREE: `ctrl+o` (the operator's first ask) is
  `app.tools.expand`, and a built-in binding is ACTED ON, not skipped — a raw `C-o` printed
  `Tool output expansion: enabled` and never reached the extension (measured); `alt+o` is
  `app.links.hint`; `alt+f` is `tui.editor.cursorWordRight`. `alt+shift+i` is the registered fallback
  and `/orchestrate overlay` the command path. The screen: a header
  (run, state, round, tier, age, refresh clock, the lane KEYS with the `◆resident` fact), a **selectable**
  task list whose selected task carries its files, deps, acceptance, result and checkpoint tag, the
  phase rail with the lane that produced each phase, the engine column (engine version — the router
  publishes no quantization, so the quant rides in the resident row's label — the abbreviated
  resident model, expert slots and spill, decode tok/s, best recent, prefix-cache hit, MoE
  placement, the host's context meter, the last pre-swap gate), the swap ledger with the measured
  cost and ramp, the last verifier critique, recent rejections, the lane-flip guard, and a
  `NOT MEASURED` block naming every number nobody measured. Keys: `↑↓`/`j-k` select, `PgUp/PgDn/g/G`
  scroll, `s` skip, `v` verify, `r` reset, `p` pause, `c` code, `h` halt, `esc` close — the bar
  WRAPS rather than clips, because a key the operator cannot see is a key they will not press. It
  re-reads on a 2 s tick, so the numbers move while you watch. The keystroke is taken at the
  raw-input layer and **no host binding is moved**: the pty rig presses `ctrl+o` and requires the
  host's own toggle to fire (its notify count increasing) while the panel stays closed.

State lives in `<cwd>/var/omp-orchestrate/`: `ACTIVE.json`, `state.json` (schema v2: rejection
history by kind — `verification` / `schema` / `task` / `protocol` — tier, schema retries, gate
result, protocol counters, `paused` + `operator_note`, synthesized-phase marker, checkpoint tags),
`swap_history.json`, `metrics_state.json`, `metrics.jsonl`. v1 files are migrated on resume, and
every write is `.tmp` → `fsync` → rename → `fsync` of the directory, so a `kill -9` mid-write
leaves the previous phase parseable.

## Optimal MoE loading (last known placement between turns)

The engine can persist the **learned expert placement** and re-apply it on the next start — that
is the difference between the measured 91 tok/s cold ramp (experts promoted during the first
~1,200 tokens) and a warm start. `moe.ts` reads it per lane and records it on every swap row.

Measured engine facts (`docs/configuration/index.md` of basalt 0.4.0):

| key | effect |
|---|---|
| `expert-profile-save` | **Flash-Next only.** Saves the adaptive tier's placement on exit and every `expert-profile-save-every` minutes; a start places from it. Needs the adaptive tier. |
| `expert-profile` | Which experts start in VRAM (default `data/profiles/<arch>-<layers>x<experts>.prof`). |

Operator act (per lane, host config, not this package):

1. in the serve config's model entry add
   `"expert-profile-save": "<repo>/var/basalt-profiles/<alias>.prof"` and
   `"expert-profile-save-every": 10`;
2. reload that lane at a quiet moment.

The overlay then shows `MoE <lane>: live · 2.4 h old · warm start`. Three states stay states:

- **configured, NOT live** — the config names the file but the running engine's cmdline does not
  carry the flag (a config edit without a reload is exactly this).
- **unsupported** — DeepSeek-V4.1 has no save path in engine 0.4.0 (only the pack's static
  profile, `src/models/deepseek41/tier.cpp`; `write_expert_profile` is wired only by the qwen4exp
  `--expert-profile-save` path). The verifier pack relearns placement on every swap and cannot be
  made warm by configuration.

## Why the thinking lane pins `IQ1_M` (not `IQ2_XXS`)

Both DeepSeek packs can be served under two aliases; this package defaults the plan/verify lane to
the **IQ1_M** pack because it stays resident where IQ2_XXS spills. On the host that measured this,
the second alias was retired after the decision — the numbers, method and receipts are what is kept. Measured on
one host (122 GiB RAM, 2 × 32.6 GiB VRAM, identical settings both sides):

| | expert slots | spill | decode (warm) | wall, short answer |
|---|---:|---|---:|---:|
| IQ1_M | 2,200 | **none** | 97–189 tok/s | 0.3–0.6 s |
| IQ2_XXS | 1,600 | **2,680 / 15,360 experts · 27.4 GB in the file** | 37–65 tok/s | 1.0–49.1 s |

IQ2 is the accuracy favourite on the KL/top-1 arms (0.2408 / 85.15 % vs 0.2779 / 83.88 %; PPL goes
the other way, 3.1074 vs 3.0456) and a 10-question deterministic spot check tied at 10/10 — so the
choice is throughput, not knowledge. The overlay makes it visible: the **expert slots** row prints
the engine's own `spill`, and `spill.experts > 0` is the signal that the pack is served from disk.
Full numbers, method and the reproduce-anywhere commands: [`docs/quant-choice.md`](docs/quant-choice.md).

An alias costs nothing *while you are deciding*: swaps are `POST /v1/load {"model":"<alias>"}` and
clients wait through them, so an A/B is one request, never a restart. Once decided, drop the alias —
the verified pack, the numbers and the receipts are the record, and the served mapping is the answer.

## Fast handover (getting a fresh lane on topic)

A new lane, and a session that resumes after a restart, both start with no conversation: the
transcript is not a briefing. `core.handover` rebuilds the run as a condensed digest —
goal, phase contract, task definitions, then statuses, gate tails, rejections and the working-tree
diff stat — and orders it **stable first, volatile last**.

Why that order: basalt's conversation cache reuses a request's prefix, and `/metrics` reports it
per request (`hit_rate`, `reused`). Measured on this host: `hit=44.9%` early,
`hit=82.3%` once the prefix settles; a 106k-token prompt prefills in **3.5 s at 1,499 tok/s**
(`pp=111459`), so the same prompt served again with an 82% hit finishes its prefill in 0.5 s.
The orchestrator's handover is 2–6k tokens: tenths of a second, and stable-first keeps the hit
rate climbing instead of resetting it every round.

Ways to load it:

- `/orchestrate handover` — send the condensed digest now (any time, mid-run).
- `FADE_ORCHESTRATE_AUTO_RESUME=1` — on session start, a mid-flight run sends its handover
  automatically once the session is idle.
- every lane-switch briefing already carries the previous round's results, rejections and the
  last verifier critique.

## Tests

```bash
npm test                 # 117 unit tests: keymap, state v2, gate, MoE, history, livedata,
                         # the screen's renderer, the screen's data contract, the status line
npm run test:gate        # fake-pi + stub router: the whole phase protocol, the pre-swap gate
                         # (zero loads on red), the top-widget surface, the Alt+Shift+F listener
npm run test:pty         # the real terminal: tmux + the omp binary + the live extension,
                         # FADE_ORCHESTRATE_LIVE_SMOKE=1 (host-only: it needs omp and tmux)
node test/rpc_rig.mjs    # headless proof through `omp --mode rpc`: the line, the screen's
                         # content, skip/halt persistence (needs the omp CLI; runs ~90 s)
```

The rigs drive the command surface with the router pointed at a closed port: the status line must
render with nothing networked, and the screen must name every number it cannot measure. RPC carries
no raw keystrokes, so the chord itself is proved twice: by the fake-host rig (the chord is registered
as a shortcut and the `ESC F` listener consumes and opens, the fallback chord is the one registered)
and by the pty rig (the bytes sent to a real 150×45 terminal, the panel on screen, Escape closing,
halt clearing, and `ctrl+o` proven to stay the host's).

**Run root = git working tree.** `/orchestrate` roots a run at the session cwd and reads that
directory with git (`status --porcelain`, `diff --stat`, checkpoint tags). Outside a working tree
`git diff` does not fail — git switches to `--no-index` mode and prints its usage page — so every
git reader is gated on one `rev-parse --git-dir` probe (`isGitRepo`) and degrades to the named
sentinel `(not a git repo: <path> …)`: the synthesizer then reports each task `blocked` naming the
missing repo instead of inventing working-tree evidence, and checkpoint tags are refused by name.
Both rigs seed their root with `git init` + a commit for the same reason.

**The rigs strip the caller's session identity.** `isDelegatedSession` treats a session whose jsonl
sits inside a dated parent dir as a delegated subagent — the shape that makes a worker inert on the
operator's run. A rig launched from a `task` agent inherits that agent's `PI_SESSION_FILE`, so every
launched `omp` was classified delegated: the status row suppressed by the `owned` rule and
`/orchestrate plan` refused (measured 2026-11-15 — 17 pty checks failed against a bare TUI frame with
`orchestrate: no run active` as the only extension line, and the rpc stream carried the refusal
verbatim). The rpc rig deletes `PI_SESSION_FILE`/`PI_SESSION_ID` from the child env; the pty rig
launches through `env -u PI_SESSION_FILE -u PI_SESSION_ID`. The child host then owns its session
identity (`--no-session`), which is what the rig is measuring.

## Layout

```
src/index.ts      extension wiring: tool, commands, hooks, lane switching, the panel's key listener
src/core.ts       state machine data half: schema v2, validation, briefings, gate runner
src/router.ts     basalt router client (listLanes/laneHealth/loadLane, lane config from env)
src/ui.ts         the status line, the model label, the ramp, the redactor
src/panel.ts      the Alt+Shift+F screen: layout, scroll, keys, both surfaces
src/screendata.ts the screen's data contract: every row, and the name of every missing number
src/keymap.ts     s/v/r/c/h actions, pure over RunState
src/livedata.ts   /metrics + /health readers, swap watcher, cold/hot
src/history.ts    swap and turn ledger stores
test/             unit tests, the gate rig (fake host), the RPC rig, the pty rig (real terminal)
docs/OVERLAY.md   the surface: layout, metrics, keys, redaction, proof inventory
```

## License

MIT — see `LICENSE`.
