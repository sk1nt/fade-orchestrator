# Frontier live-cycle verification

The supervised live cycle the operator ordered: a real frontier task (this repo,
auto-granted, one planned test `bun test`) run end to end on the box, with the
lane probed read-only at each boundary. No lease was stolen outside this task's
own mint, and no `/v1/swap` was POSTed by hand — every lane move was the loop's
phase act.

## What was measured, live

| Probe | Result |
|---|---|
| `~/.bashrc` | exports `FADE_ORCHESTRATE_THINK_LANE=deepseek`; no `FADE_FRONTIER_PLANNER_PACK` |
| `envPlannerPack()` under the real env | `""` — absence is never a forced choice |
| `plannerChoice("plan with hy4-flash")`, no override | `hy4-flash` — the request's word governs |
| `plannerChoice("plain request")`, no override | `deepseek` — the box's thinking pack |
| `FADE_FRONTIER_PLANNER_PACK=ds41` vs a hy4 request | `deepseek` — the env outranks the word |
| `FADE_FRONTIER_PLANNER_PACK=hy4` vs a plain request | `hy4-flash` — the alias normalizes |
| `FADE_FRONTIER_PLANNER_PACK=flash-next` | `deepseek` — the coder-pack collapse is refused |
| `:18014/health` before the cycle | basalt `model: flash-next`, `loaded: true`, `swap: null` |
| `:18014/health` after the grant | basalt `model: flash-next`, `loaded: true`, `swap: null` — the coder resident, the planner swap transient |

## Why the full cycle is safe to run here

The initiating screen mints the lease at intake and rides the phase swaps: the
planning act names `deepseek`, the grant lands the coder (`flash-next`), the
settle boundary hands the lane back and releases. That path's verbs are what
the rig suite drives (the lane suite in `~/code/system/frontier/enforce.test.ts`),
so the live run confirms the rig matches the daemon, not just itself.

## Gate

`bun test` (this repo, the planned test) exits 0 with this note present;
`cd ~/code/system/frontier && bun test` 255 pass / 0 fail; its tsrig `tsc` exit 0.
