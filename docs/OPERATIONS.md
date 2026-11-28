# Operations

A live run displays a status row above the editor. **Alt+F** opens the detail
panel. While a lane loads, the row names the incoming pack and displays progress.
Set `FADE_ORCHESTRATE_SURFACE=status` to use the host's status bar.

See [the interface guide](OVERLAY.md) for keyboard controls and panel details.

## Workflow ownership

`/plan <goal>` and `/orchestrate <goal>` start the same workflow. Use either entry
point for the planning, coding, and verification cycle.

A Frontier task owns its lane transitions. The orchestrator yields its automatic
verification and hand-back behavior when Frontier is in control. Starting a second
workflow is refused while the current one is active. Frontier status reads remain
available during an orchestrated run. Finish or stop the current workflow before
switching engines.

## Commands

| Command | Purpose |
| --- | --- |
| `/orchestrate [--rounds N] [--demo-redact] <goal>` | Claim the router, prove planning readiness, and start a run |
| `/orchestrate status` | Show the current run and accumulated swap cost |
| `/orchestrate overlay` | Open the detail panel |
| `/orchestrate runs` | List archived runs, newest first |
| `/orchestrate moe` | Show expert-placement measurements and build information |
| `/orchestrate skip [Tn]` | Skip a task |
| `/orchestrate verify` | Request verification |
| `/orchestrate pause [note]` | Pause with an optional operator note |
| `/orchestrate code` | Return to coding |
| `/orchestrate reset` | Reset the run |
| `/orchestrate lanes reset` | Clear the process's flip ledger and resume the owed lane |
| `/orchestrate halt` or `/orchestrate stop [--clear]` | End the run |
| `/orchestrate handover` | Send the condensed run digest |
| `/lanes` | Show the router census and health |

A router claim records its owner, repository, host, and age. An active claim
prevents a second run from taking the same router. If ownership conflicts, inspect
the named session and end its run there, or configure a separate router and lock
directory. A claim whose owner has died can be reclaimed.

## Persistence and handover

State lives under `<cwd>/var/omp-orchestrate/`. `ACTIVE.json` identifies the active
run. `state.json` carries phase state, tasks, gate results, rejections, protocol
counters, pause information, and checkpoints. Older v1 state is migrated on resume.
State writes use a temporary file, sync, rename, and directory sync.

Starting a new run archives the preceding terminal run under `runs/<run_id>.json`.
Existing archives are preserved. `/orchestrate runs` reads them back.

`swap_history.json` records swap measurements. `metrics_state.json` and
`metrics.jsonl` hold turn metrics. At the configured size cap, the ledger rotates
to `metrics.jsonl.1`, retaining one predecessor. The interface reads the current
ledger. See [configuration](CONFIGURATION.md) for retention settings.

`/orchestrate handover` reconstructs a digest from the goal, phase contract, tasks,
gate output, rejections, and working-tree diff summary. Stable content precedes
changing results to support prompt-cache reuse. Lane-switch briefings include the
previous round's results. Set `FADE_ORCHESTRATE_AUTO_RESUME=1` to queue a handover
when a session restores a matching active run. Busy startup keeps it queued until
the host is idle and its message queue is empty. Temporary read failures are
reported and retried. A repeated startup cancels the earlier pending attempt.
Stopping, replacing the run, or shutting down prevents obsolete delivery.

The startup message distinguishes a queued handover from one actually sent.
Frontier ownership is recovered from its session journal, including slash-command
aborts. Recorded tool results provide a fallback when the journal is unavailable.

## Verification desk

Delegated workers register their objectives, acceptance criteria, and commands
through `fade_verify`. The worker waits for a verdict against its request id.
Workers requiring this path must list the tool in their agent definition.

The desk groups requests into batches and validates verdicts against the claimed
batch. A verdict must cover every request in that batch. Later requests enter the
next batch. During lane churn, the desk routes verification to a separately
configured verifier model.

| Command or tool | Purpose |
| --- | --- |
| `/orchestrate desk` | Show batch state, queue counts, and verifier configuration |
| `/orchestrate verifier install` | Write `.omp/agents/fade-verifier.md` and `.omp/agents/fade-worker.md` |
| `/orchestrate verifier show` | Inspect installed agent definitions |
| `fade_verdicts {batch, verdicts}` | Record a verifier's batch verdicts and release waiting workers |

See [delegation](DELEGATION.md) for schemas, closure rules, and routing behavior.

## In-process thinking

`/orchestrate think [provider/model] <prompt>` sends one completion to the selected
endpoint and reports the answer, endpoint, and elapsed time. A router model must
already be resident. Unavailable residency reports `lane_not_resident`, an
unreachable endpoint reports `endpoint_unreachable`, and an exhausted reasoning
budget can report `no_completion`.

The latest result is recorded in `state.lane_call` and appears in
`/orchestrate status`. Configure its model and budget in the
[configuration reference](CONFIGURATION.md).

## Expert-placement profiles

For engines supporting saved placement, configure the lane's serve entry with
`expert-profile-save` pointing to a persistent profile path and
`expert-profile-save-every` set to the desired interval in minutes. Reload the
lane during an appropriate maintenance window.

Support depends on the engine build and model architecture. The reference
engine's Flash-Next path supports saving adaptive placement. Its DeepSeek path
uses a static profile. The panel distinguishes a configured profile from one used
by the running engine. See the [quantization study](quant-choice.md) for the
reference engine's measurements and reproduction details.
