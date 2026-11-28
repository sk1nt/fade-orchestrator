# fade-orchestrator

An [OMP](https://github.com/earendil-works) extension that coordinates planning,
coding, and verification across model lanes on a local basalt router.

Start a run with `/orchestrate <goal>`. The planner defines tasks and acceptance
checks, the coder implements them, and the advisor reviews the result. Failed
checks return to the coder with repair instructions. A session arms lane control
with `/orchestrate resume`; a plain session — no run adopted — never moves the
lane. `/plan` is a separate handler from `/orchestrate`: `/plan` asks for a plan
on the selected model; `/orchestrate` starts the model-switching workflow.

## Requirements

- Node.js 22 or newer and npm.
- OMP with extension support.
- A basalt router and a reachable fade-supervisor daemon for managed lane changes.
- OMP provider entries matching the configured planning, coding, and advisor lanes.
- A Git working tree for run evidence and checkpoint tags.

The default provider is `basalt`, with `deepseek` for planning, `flash-next` for
coding, and `hy4-flash` for the advisor. Configure these for your installation
before starting OMP. The verification subagent uses a separately configured model
endpoint.

## Install

From the repository root, build and link the extension into OMP.

```bash
npm ci
npm run build
mkdir -p ~/.omp/agent/extensions
ln -s "$PWD/src/index.ts" ~/.omp/agent/extensions/fade_orchestrate.ts
```

If that extension path already exists, inspect it before replacing it. OMP loads
the TypeScript source directly. `dist/index.js` provides a bundled single-file
installation form.

See [configuration](docs/CONFIGURATION.md) for router, provider, lane, supervisor,
and interface settings. Environment changes to lane configuration require a new
OMP process.

## Use

In OMP, start a run and inspect its progress.

```text
/orchestrate Implement the feature and run its acceptance checks
/orchestrate status
```

Open the detail panel with **Alt+F**. Use `/orchestrate pause` to pause a run,
`/orchestrate resume` to arm its lane control and continue it, `/orchestrate handover`
to request a condensed digest, and `/orchestrate stop` to end it. `/lanes` displays
the router census.

The workflow runs acceptance checks before switching from coding to verification.
A failed gate keeps the coding lane available for repairs. Lane changes occur at
turn boundaries and coordinate ownership through the supervisor. A plain session
never moves the lane: the completion holds until the lane serves the pin, the
one load site is `agent_end`, and the run is adopted and resumed only by the
session that owns it.

Run state and metrics live under the session working directory in
`var/omp-orchestrate/`. Display redaction is available for demonstrations.

See [operations](docs/OPERATIONS.md) for commands, persistence, recovery controls,
and the verification desk.

## How it works

- **One load site.** The lane swap is issued in `agent_end`, after the turn is
  closed. A load issued into a turn whose chat requests are still queued makes
  the router swap back to the entry the queued requests name — measured live as a
  0–2 s ping-pong. `loadLane` settles an in-flight swap first and returns without
  reloading the resident pack, so a load the resident entry already covers never
  re-reads 52 GiB.
- **The start is a proof, not a census.** `/orchestrate <goal>` refuses until the
  planning lane is PROVEN: the supervisor daemon's `lane_state` says `RESIDENT`
  with `active_pack` = the planning pack AND the router serves that id on
  `/v1/models`. A cold load is not refused: the proof polls the daemon's
  readiness window (`FADE_ORCHESTRATE_START_PROOF_WAIT_MS`, default 240 s,
  13–25 s is the measured load) and never kills a swap in flight.
- **The completion is what waits.** `before_provider_request` — the last hook
  before the host posts — holds the turn until the lane serves the pin, the way
  basalt's router holds a client through a swap: one `/v1/models` read when the
  pin already matches, a keep-alive page every 10 s when it does not, and never a
  `404` for a configured lane. The pack load and the session pin go out together:
  the pin lands with the load, never after a residency proof.
- **Frontier owns its own lifecycle.** A frontier tool call in a run-owning
  session is refused by name — the run owns the workflow. A non-run session
  observes Frontier without minting another lease: no pin, no swap, no hand-back.
- **Lane control is armed, never default.** `session_start` starts with lane
  control OFF. `/orchestrate resume` resets the pause flag and queues ONE
  condensed handover (deferred until the session is idle); a repeat cancels the
  older attempt. The panel's Esc/q keys are unchanged.

## Tests

```bash
npm run typecheck    # tsc -p tsconfig.json
npm test             # unit tests: keymap, state v2, gate, MoE, history, livedata,
                     # the screen, the desk's batch rules, the verifier's routing
npm run test:gate    # the gate rig — a host-less CI gate (fake pi + stub router): the whole
                     # phase protocol, the pre-swap gate, the pin and the serve-hold, the
                     # verification desk (zero loads while a batch is open, ONE load per closed
                     # batch), the churn route, and Frontier ownership
node test/load_hostile.mjs
npm run test:pty     # host-only, needs the omp CLI and tmux
```

`dist/index.js` is a generated bundle — the esbuild output of `src/*.ts`, committed
so the tree carries a loadable single file. The unit tests and rigs import the
bundle `test/build.mjs` writes into `.test-build/`, not `dist/`.

**Run root = git working tree.** `/orchestrate` roots a run at the session cwd and
reads that directory with git. Outside a working tree git does not fail cleanly —
it switches to `--no-index` mode and prints its usage page — so every git reader
is gated on one `rev-parse --git-dir` probe and degrades to the named sentinel
`(not a git repo: <path> …)`. Both rigs seed their root with `git init` + a commit.

**The rigs strip the caller's session identity.** `isDelegatedSession` treats a
session whose jsonl sits inside a dated parent dir as a delegated subagent — the
shape that makes a worker inert on its parent's run. A rig launched from a `task`
agent inherits that agent's `PI_SESSION_FILE`, so every launched `omp` was
classified delegated. The rpc rig deletes `PI_SESSION_FILE`/`PI_SESSION_ID` from
the child env; the pty rig launches through `env -u PI_SESSION_FILE -u
PI_SESSION_ID`.

## Layout

```text
src/index.ts      extension wiring: tool, commands, hooks, lane switching, the panel's raw-key listener
src/core.ts       state machine data half: schema v2, validation, briefings, the gate runner, the task window
src/router.ts     basalt router client: listLanes/laneHealth/loadLane + the pre-unload gate
src/lane-session.ts  one session switchover path for Frontier and the orchestrator
src/recovery.ts   Frontier-phase tracking + the queued handover
src/desk.ts       the verification desk: batched worker requests, claims, verdicts, churn state
src/subagent.ts   the churn route: the off-router verifier, its task call, its agent definition
src/ui.ts         the status line, the model label, the ramp, the redactor
src/panel.ts      the Alt+F screen: layout, scroll, keys
src/screendata.ts the screen's data contract: every row, and the name of every missing number
src/keymap.ts     s/v/r/c/h actions, pure over RunState
src/livedata.ts   /metrics + /health readers, swap watcher, cold/hot
src/history.ts    swap and turn ledger stores
src/moe.ts        per-lane MoE placement: the serve config, the live/unsupported states
test/             unit tests, the gate rig (fake host), the RPC rig, the pty rig (real terminal)
docs/OVERLAY.md   the surface: layout, metrics, keys, redaction, proof inventory
```

## Documentation

- [Configuration](docs/CONFIGURATION.md) covers environment variables and defaults.
- [Architecture](docs/ARCHITECTURE.md) explains phases, lane ownership, and verification.
- [Interface](docs/OVERLAY.md) documents the status row, panel, and keyboard controls.
- [Delegation](docs/DELEGATION.md) describes worker batches and verifier routing.
- [Development](docs/DEVELOPMENT.md) covers builds, checks, and demo recording.
- [Operations](docs/OPERATIONS.md) covers commands, persistence, recovery controls.
- [Documentation index](docs/README.md) includes design references and investigation records.
- [Contributing](CONTRIBUTING.md) describes change and documentation conventions.

## License

[MIT](LICENSE).
