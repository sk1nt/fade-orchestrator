# Architecture

The extension coordinates three roles on a router that keeps one model pack
resident at a time. The planning and advisor roles can share a thinking lane.
Coding uses its configured code lane.

## Phase workflow

1. `/orchestrate <goal>` claims the router and establishes planning-lane readiness.
2. The planner defines tasks and executable acceptance checks, then calls
   `fade_phase(planning_done)`.
3. The coder implements the tasks and calls `fade_phase(coding_done)`.
4. The pre-swap gate runs the planned checks on the coding lane. Failed checks
   produce repair instructions. Passing checks allow advisor verification.
5. The advisor reports acceptance or repair tasks through
   `fade_phase(verification_done)`.

Payload validation checks task schemas, dependencies, and phase transitions.
Repeated protocol misses trigger nudges, evidence-based synthesis, and eventually
a paused run. The round budget adapts to plan size. Small gate-green changes can
complete through the configured fast path.

See [briefings](BRIEFINGS.md) for the handover format and phase payload contract.

## Lane ownership and readiness

Lane changes run at turn boundaries. A generation token prevents a superseded
switch from changing the screen or sending a briefing. Router claims coordinate
runs, and supervisor leases authorize swaps. A load using a run's lease leaves
release to the run lifecycle. A single-turn load releases its own lease in a
`finally` block.

Startup checks both supervisor residency and the router's advertised model.
During transitions, model selection follows the lane owed by the session. The
interface retains a holding page while a switch is pending. Repeated competing
swaps can pause the run through the thrash breaker.

See [configuration](CONFIGURATION.md) for readiness windows, lease settings, and
flip controls, and [operations](OPERATIONS.md) for recovery commands.

## Verification and delegation

During the verification phase, the extension restricts writing tools and requires
verification evidence. Accepted tasks receive run-scoped checkpoint tags.

Delegated sessions leave lane control to the owner session. Workers register
verification requests at the desk, which groups them into batches. Verdicts must
cover the claimed batch. A separately configured verifier can answer batches
without loading another router pack.

See [delegation](DELEGATION.md) for the batch schema, closure rules, and tool
contract.

## State and measurements

Run state is stored under `var/omp-orchestrate/` in the session working tree.
State writes use temporary files, syncing, and rename. Finished runs are archived
before the active slot is reused. The turn ledger rotates at its configured cap.

The interface reads router and engine measurements for swap timing, decode,
cache use, and expert placement. Missing measurements carry an explicit missing
state. MoE placement support depends on the engine and pack. Consult the
[quantization study](quant-choice.md) for benchmark methodology and results.

## Source map

| Component | Responsibility |
| --- | --- |
| `src/index.ts` | Extension hooks, tools, commands, and lane transitions |
| `src/core.ts` | Run state, payload validation, briefings, and acceptance gate |
| `src/router.ts`, `src/supervisor.ts`, `src/lane.ts` | Router access, leases, and model identity |
| `src/desk.ts`, `src/subagent.ts` | Verification batches and worker routing |
| `src/ui.ts`, `src/panel.ts`, `src/screendata.ts`, `src/keymap.ts` | Status row, panel, data, and controls |
| `src/history.ts`, `src/runs.ts` | Metrics and archived runs |
| `src/livedata.ts`, `src/moe.ts`, `src/taskmoe.ts` | Live measurements and expert placement |
| `src/thinklane.ts`, `src/triage.ts` | In-process thinking and gate triage |

## Session switchover

`src/lane-session.ts` is the only model and settings switchover implementation.
Both this extension and Frontier import `createLaneSession`. It pins the registered
model, applies the shared thinking policy, retargets roles already using the local
provider, and captures/restores writing tools across advisor and coder phases.
Explicit cloud roles keep their configured models.

Both extensions call its guard at `before_provider_request`, so tool continuations
wait too. The guard uses `router.ts:laneServeHold`; disconnected listeners and
loading entries keep waiting. Only a loaded identity releases a request. Failed
readiness aborts the turn with a warning. No private pin, mode-sync, fallback hold,
or delayed landing implementation remains in either extension.
