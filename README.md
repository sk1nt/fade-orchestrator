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
- **Verifier sandbox.** While the thinking lane holds the run, the mutating tools
  (`edit`, `write`, `apply_patch`, `multiedit`, `notebook_edit`, `task`) are removed from the
  active set — a denylist, so a host tool this extension has never seen cannot slip a write past
  it — and the `tool_call` guard blocks them with the rule named, delegating the fix to the coder.
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
| `FADE_ORCHESTRATE_THINK_LANE` | `deepseek:high` | entry that plans/verifies (thinking lane) |
| `FADE_ORCHESTRATE_CODE_LANE` | `flash-next` | entry that implements |
| `FADE_ORCHESTRATE_KEY` | `ctrl+o` | overlay key. **Ctrl+O is the app's "toggle tool output" binding** — the takeover is disclosed; set e.g. `ctrl+g` to keep the built-in |
| `FADE_ORCHESTRATE_HEADLESS` | unset | `1` renders the overlay as a widget instead of an overlay component (RPC/print hosts) |
| `FADE_ORCHESTRATE_BASALT_CONFIG` | unset | the basalt serve config JSON; enables the per-lane MoE placement panel (`expert-profile-save`) |

## Surface

- `/orchestrate [--rounds N] <goal>` — start a run (preflights the router: think lane must load).
- `/orchestrate status | overlay | skip [Tn] | verify | reset | pause [note] | code | halt | stop [--clear]`
- `/lanes` — live router census (both entries' status + `/health`).
- `Ctrl+O` — the overlay: untruncated task list with acceptances and results (plus each task's
  checkpoint tag), swap-latency history with the MoE ramp badge, engine/memory tiers (quant, expert
  slots, spill, decode tok/s), the last verifier critique, recent rejections, the protocol counters
  and — when the circuit breaker tripped — the stall diagnostic. Keys: `s` skip task, `v` verify
  now, `r` reset round (+3 to the cap), `p` pause/resume, `c` code, `h` halt, `esc` close.
- Status pill (one footer line): `⚡ <lane>:<state> · R<round>/<max> · T<passed>/<total> · [Ctrl+O] · hot 130t/s`,
  with `· protocol <n>/3` while the Tier-1 counter runs and `· paused` while the loop is parked.
  The **full lane name** is the default (operator order 2026-11-15: put the status where the model
  identifier is — "it should fit fine"): the host renders extension statuses on the footer's own
  full-width row (`getExtensionStatuses()`, `footer.js`), immediately under the stats row whose
  right side carries the model identifier, and that identifier is longer than this pill. The
  2-character tag (`flash-next` → `fn`, `deepseek` → `de`) with the short state (`plan`, `code`,
  `ver`, `fix`, `done`, `fail`, `stop`, `stall`) is the **narrow-terminal fallback** only
  (`cols < 72`), where the host truncates the row with `…`. `/orchestrate status` and the overlay
  always print the full lane name. The main pane stays clean during long coding runs.

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
npm test                 # 25 unit tests: keymap, overlay data, history, state v2, gate, MoE
node test/rpc_rig.mjs    # headless proof through `omp --mode rpc`: pill, overlay content,
                         # skip/halt persistence (needs the omp CLI; runs ~90 s)
node test/gate_rig.mjs   # fake-pi harness: phase tool, pre-swap gate (zero loads on red),
                         # state v2 migration, rejection memory, adaptive budget
```

The rig drives the command surface with the router pointed at a closed port: the pill must render
with nothing networked, and metrics must degrade to no suffix. RPC cannot carry raw keystrokes,
so the `Ctrl+O` binding itself is a TUI check; the overlay's content and every key's action run
through the same code paths the component calls.

## Layout

```
src/index.ts     extension wiring: tool, commands, hooks, lane switching
src/core.ts      state machine data half: schema v2, validation, briefings, gate runner
src/router.ts    basalt router client (listLanes/laneHealth/loadLane, lane config from env)
src/ui.ts        pill + overlay component
src/keymap.ts    s/v/r/c/h actions, pure over RunState
src/livedata.ts  /metrics + /health readers, swap watcher, cold/hot
src/history.ts   swap history store
test/            unit tests + the RPC rig
```

## License

MIT — see `LICENSE`.
