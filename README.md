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
- **Phase contract with teeth.** `fade_phase` validates the payload exactly (phase per state,
  allowed keys, task schema, dependency order) and refuses with the rule named. From the second
  refused payload the exact JSON schemas ride back in the tool error (schema auto-repair), and
  every refusal is durable in `rejection_history` — the repair briefing feeds the last five back
  to the model ("do not repeat the attempt").
- **Adaptive round budget.** Planning size sets the reserve: 2 tasks → 3 rounds, 4 → 4, 6 → 5.
  Swaps are the unit of cost; a small plan must not reserve six.
- **Swap history.** Every swap the orchestrator drives is timed (`/health` percent samples,
  first-completion and steady decode tok/s from `/metrics`) into `var/omp-orchestrate/swap_history.json`.
  Cold vs hot is visible in the status pill: the measured deepseek ramp reads ~91 tok/s against a
  ~130 steady (cold), flash-next runs 480–647 (hot).

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
- `/orchestrate status | overlay | skip [Tn] | verify | reset | code | halt | stop [--clear]`
- `/lanes` — live router census (both entries' status + `/health`).
- `Ctrl+O` — the overlay: untruncated task list with acceptances and results, swap-latency
  history, engine/memory tiers (quant, expert slots, spill, decode tok/s), the last verifier
  critique, recent rejections. Keys: `s` skip task, `v` verify now, `r` reset round, `c` code,
  `h` halt, `esc` close.
- Status pill (one footer line): `⚡ <lane> · R<round>/<max> · T<passed>/<total> · [Ctrl+O] · hot 130t/s`.
  The main pane stays clean during long coding runs — the detail view is the overlay.

State lives in `<cwd>/var/omp-orchestrate/`: `ACTIVE.json`, `state.json` (schema v2:
rejection history, tier, schema retries, gate result), `swap_history.json`, `metrics_state.json`.
v1 files are migrated on resume.

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
