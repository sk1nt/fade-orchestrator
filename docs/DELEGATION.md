# Delegation: the verification desk, and the churn route

A delegated worker (`task`, `scout`, `reviewer`, …) has a real session — a jsonl file, its own
listener, its own model — and until now the plugin treated it as inert: no lane work, no phase, no
screen. It now has exactly one job in the loop: **ask for verification of its own acceptance and
wait for a verdict.** Everything about lanes stays with the owner run.

## The split

| | owner session (the run) | delegated worker |
|---|---|---|
| lane loads, `setModel`, swaps | yes | **never** |
| `fade_phase` | yes | no |
| `fade_verify` | answers with a queue position, **does not block** | **blocks** until its verdict is written |
| who writes verdicts | the verifier round (`verification_done.verdicts`) or `fade_verdicts` | — |

The owner must not block: the session that dispatches the batch is the session that answers it, and
a blocked owner leaves every worker parked.

## The desk

`<run>/verify/desk.json`, schema `fade.orchestrate.verify_desk.v1`, written through the same
temp → `fsync` → rename → directory-`fsync` path as `state.json`, and mutated under a
content-identity compare-and-retry (a worker process writes it too).

```jsonc
{
  "schema": "fade.orchestrate.verify_desk.v1",
  "run_id": "20261117T144924Z-ktvm",
  "epoch": 1,                       // the batch now open
  "open_utc": "…",                  // when this epoch opened
  "expected": 2,                    // workers that must register before the batch closes
  "sealed": "…",                     // set when the launching task call returned
  "agents": ["reviewer", "scout"],  // census: launchers, never counted as registrations
  "churn": true, "churn_utc": "…",  // the churn route is in force for this run
  "requests": [{
    "id": "V1.2",                   // V<batch>.<n> — stable, quoted in every message
    "batch": 1, "agent": "reviewer", "session": "sub-…",
    "objective": "…", "acceptance": "node --test exits 0",
    "checks": [["node --test", "exit 0"]], "files": ["src/desk.ts"],
    "enqueued_utc": "…",
    "claimed_utc": "…", "verdict": { "accepted": true, "notes": "…", "verdict_utc": "…" }
  }],
  "addressed": [{ "batch": 0, "ids": ["V0.1", "V0.2"], "routed": "swap", "at": "…" }],
  "updated_utc": "…"
}
```

Batch labels shown to a human and to the verifier are **1-based** (`batch 1` = epoch 0); the
conversion is at the tool boundary only, and every number in the file is the epoch.

## The batch, not the arrival

The unit of verification is the **batch of workers launched for a round**, because the expensive
thing in this system is a lane load, not a prompt.

1. **Census.** Every `task` call is read at call time: `tasks[]` (parallel) and the single
   `{agent, task}` form are both censused, and a call is **sealed** when it returns. Workers whose
   text carries verification work (a closed verb set: verify/acceptance/gate/audit/test/typecheck/
   lint/playwright/cargo/pytest/prove/parity/score) set `expected`; a plain worker never opens a
   batch.
2. **Register.** A worker calls `fade_verify` → `V<b>.<n>` appended to the current epoch. The answer
   carries its queue position (`1/2 registered`), never a lane.
   The host exposes a tool to a subagent only through the agent's definition, so a verifying worker
   is launched as `fade-worker` — the definition `/orchestrate verifier install` writes, whose
   `tools:` line carries `fade_verify`. It pins NO model: a worker inherits the run's code lane.
3. **Close.** The batch is ready when every expected worker registered, **or** the launching call
   sealed and all expected registered, **or** the epoch is older than
   `FADE_ORCHESTRATE_VERIFY_SETTLE_S` (8 s) with requests in it, **or** every launched worker has
   settled (nothing can arrive).
4. **Claim, once.** A ready batch is claimed atomically, records its ids and route in `addressed`,
   and advances `epoch`. Nothing in a claimed batch is ever answered twice; a request that arrives
   mid-pass lands in the next epoch and its worker is told the batch number.
   The claim fires at the owner's turn boundary **and at any owner tool call**: an owner that
   delegated the workers is blocked in `wait` on sessions that are blocked on its verdict, so no
   turn boundary exists — measured live, the batch sat `registered == expected` with `addressed: []`
   forever. The dispatch self-throttles: an open batch, an empty desk or a claimed batch costs zero
   lane loads, so checking per tool call is cheap.
5. **Answer once.** Route `swap`: **one** `POST /v1/load` for the whole batch, and the verifier's
   briefing is one page (`## VERIFICATION — ONE BATCH, batch N of run <id>`) carrying every
   request's objective, acceptance, checks and files. The round ends with
   `fade_phase("verification_done", {verdict, checks, notes, verdicts:[{id, accepted, notes}]})`.
6. **Fan out.** The verdicts are written onto the requests **by id** — that write, not the prose, is
   what releases the blocked workers — and the claimed batch is cleared from the run state.

Gates, each named in its refusal: answering a batch the desk has not claimed; a verdict for an id
that belongs to another batch (its batch's ids are listed); a `verification_done` whose `verdicts`
omit any id of the claimed batch.

## The worker's `tools:` line is the registration

Measured in a live run (`20261117T165329Z`, one `task` call carrying a gate-rig worker and a
unit-suite worker): the `scout` worker registered, the default `task` agent registered, and the
read-only `reviewer` **ran its checks and never registered** — its definition does not list
`fade_verify`, so the tool is not in its session. The census had counted it, so `expected` included a
worker that could not arrive and the batch closed on the settle window, not on its request.

Three things close that gap: `/orchestrate verifier install` writes `fade-worker` next to
`fade-verifier`; the census at the launch warns, naming any verification-carrying agent that is not
`fade-worker`; and the coder's window page names `fade-worker` as the agent to delegate a verifying
slice to. `verifier show` says which of the two definitions is installed, and why the worker one
matters.

## The churn route

Churn is not retried, it is **routed**. The desk is marked in churn when

- the thrash breaker halts the loop (3 flips in 60 s naming the same lane) — the mark is written
  **before** the batch is routed, so the halted round's own batch takes the route (rig block 19b), and
- every later request: the flip guard's count is reached (`FADE_ORCHESTRATE_FLIP_MIN_SWAPS`, and
  every swap on this box costs 13-25 s of wall clock and tens of GiB).

Under churn a closed batch pays **zero** `POST /v1/load` and is routed to a **verification
subagent**: the loop is handed, as a command, the exact call —

```
task { "agent": "fade-verifier", "model": "ninfer-local/coder-gpu1", "task": "…one page, every
request by id…" } → read the verdicts → fade_verdicts { "batch": N, "verdicts": [ … ] }
```

The model **must not** resolve to the router: a router model is a lane load behind the guard, which
is exactly the cost being avoided. Measured on this box: `ninfer-local/coder-gpu1` →
`ninfer_local.py` serving `:8002` (`Qwen3-Coder-30B-A3B`), a **separate process** from basalt
`serve.server` on `:18014`, so a completion there is not a basalt load — while `@gpu1`, `@slow`,
`@task`, `@judge` in `.omp/config.yml` all resolve to `strata-flash/flash-next`, a router entry, and
NInfer's own `/v1/load` is a cold pack load (the `swap-full` incident: 20.5 s). `isRouterModel`
refuses a router entry for this route, including the aliases, with that reason in the refusal.

The route is durable: it is recorded on the desk batch (`routed: "subagent"`) and in the run's
rejection history, and holds for every later batch until `/orchestrate lanes reset`, which clears
the desk churn with the flip ledger and says so.

`/orchestrate verifier install` writes `.omp/agents/<FADE_ORCHESTRATE_VERIFIER_AGENT>.md` — the
definition the host's `task` tool resolves (`Fade verification subagent. Model: <id> — off the
router.` plus the procedure). `verifier show` prints it and whether it is installed, and warns when
its model resolves to the router.

### The claim-time lane guard, and what OWED means

A claim is the **unrecoverable act**. `claimBatch` stamps `claimed_batch` on every live request
(`desk.ts:264`), `openRequests` drops stamped requests from the live set (`desk.ts:214`), and nothing
in `desk.ts` clears the stamp. So a batch handed to a verifier lane that cannot answer is not stalled
and does not get re-issued: it is **owed for the whole run**. Every worker in it exits `fade_verify`
at `DESK_WAIT_MS` (240 s) with "the batch is owed its verification pass — report your result and end,
do not re-register", and a worker that re-registers its objective gets a FRESH request, because
`enqueueRequest` dedupes only UNCLAIMED ones (`desk.ts:285`). The owed count therefore grows
monotonically across a run, each duplicate priced at its own verification pass, and the run completes
reading unverified slices as reported.

So the lane is proved **before the claim** (`src/lane.ts`): one 1-token completion, through the same
auth path the lane declares — its provider key is a command (`apiKey: "!bash -lc 'source … && printf
%s \"$FADE_NINFER_API_KEY\"'"`), so a reachable port and a 200 on `/v1/models` can coexist with a
generate-time 401, which is why a `GET`-shaped probe is not accepted. The reading is cached for
`FADE_ORCHESTRATE_LANE_PROBE_CACHE_MS`. Consequences, all rig-proved (block 27):

- a lane that **refuses** the completion: no claim, the batch goes to the `swap` route (the route
  with recovery) at one load, the probe is in the operator line and the rejection history, and
  `state.lane_probe` carries the reading;
- a lane that **answers**: the zero-swap route stands, at zero loads;
- a **router entry** is refused without any request — a completion to the router unloads the resident
  lane, so proving the "zero-swap" lane would pay the swap the lane exists to avoid;
- `/orchestrate desk` names the owed ids and calls the slices behind them UNVERIFIED, and a run that
  reaches `complete` with owed requests says so in the `fade_phase` answer itself.

## Refusals, deliberate

- `fade_verify` **refuses** when no orchestrated run is bound (a subagent's cwd is the parent's, so
  the run is found by walking up for `var/omp-orchestrate/state.json`): a worker must never answer
  optimistically from the router's state.
- A worker blocks for at most `timeout_s` (default 600, cap 1800). It returns `deferred` with the
  batch and queue position; the verdict, whenever it lands, is what unblocks the next round.
- A plain worker's request is not awaited by the batch census; the batch never waits on a worker
  that has no verification to ask for.

## What proves it

| Command | Proves |
|---|---|
| `node --test test/desk.test.mjs` | the desk over a temp tree: closure rules, one-use claims, verdict fan-out, churn marking, the 1-based label at the boundary |
| `node --test test/subagent.test.mjs` | the census of both `task` forms, the verification-verb set, the route decision, the refusal for a router model, the verifier's front matter, and the worker definition's `tools:` carrying `fade_verify` while posting no verdict |
| `node test/gate_rig.mjs` (block 21) | one worker registering pays **zero** loads while its peer is unregistered; a closed batch pays **exactly one** load for both requests; the briefing carries both check commands; a mid-pass arrival is batch 2; verdicts fan out by id; the three gates refuse by name |
| `node test/gate_rig.mjs` (block 19b) | the thrash breaker **marks the desk** and routes the batch it halts, at zero loads |
| `node test/gate_rig.mjs` (block 22) | under churn: zero loads, one claim routed `subagent`, the directive carries the off-router model and every worker's check command, the route **stays** for the next batch, `lanes reset` releases it |
| `node --test test/lane.test.mjs` | the provider scan in BOTH `models.yml` forms (the operator's file is the mapping form — a scan that reads only sequences reports every provider missing and prices a swap on every churn batch), the spec resolution, the completion probe through the lane's own auth path, the unset-header rule, the cache window, the disabled state, and the router-entry refusal at ZERO requests |
| `node --test test/triage.test.mjs` | the triage prompt carries the gate's own rows, the CLI call is tool-less/one-turn/bounded, every failure path returns an empty note, and a banner before the JSON still decodes |
| `node test/gate_rig.mjs` (block 27) | claim-time guard: a lane that refuses the completion routes `swap` at ONE load with the probe named in the history; a lane that answers keeps `subagent` at ZERO loads; the owed census names ids and does NOT count judged ones |
| `node test/gate_rig.mjs` (block 28) | red-gate triage: the advisory line rides the briefing, the gate stays **RED** at zero loads (the exit codes are still the verdict), and a CLI that answers nothing changes nothing |
| live `/orchestrate` run over `omp --mode rpc` | run 1: `scout` registered `V1.1`, the default `task` agent `V1.2`, the read-only `reviewer` registered NOTHING (the gap `fade-worker` closes); run 2: both `fade-worker` workers registered (`registered == expected`) and the ready batch sat unclaimed while the owner blocked in `wait` — the deadlock the tool-call claim closes |
