# The lease lifecycle at a hand-back: a claimed lane defers, it does not fail

Date: 2026-11-27. Repo: `fade-orchestrator` (the live extension is the symlink at
`~/.omp/agent/extensions/fade_orchestrate.ts`, so the fix is in force at the next OMP load;
`fadetheworld/deploy/omp/` carries the byte-identical snapshot).

## 1. What the operator saw

Frontier settled a task and control came back to `fade-orchestrator`:

```
Warning: frontier: task let-s-install-service-onto-a-windows-mac settled unreviewed
Error: fade_orchestrate: loading lane hy4-flash failed (lease mint refused http 409 rule
lease_held: lease held by fade-orchestrator (session 01a21a8e-da8a-748c-bdf2-db2bd2d1f470,
1137 s left): acquire is refused until it is released or expires); briefing not sent
```

Two facts are in that pair of lines and both were actionable:

- the holder named in the refusal is **`fade-orchestrator` itself** — the plugin was refused a
  lease by its own held lease;
- the lane was claimed with **1137 s left on its TTL** — a countdown, not a permanent denial.

The run went to `failed`, its lock and lease were released, and the phase briefing — the page
that tells the advisor lane what round it is answering — was dropped. A lane that was busy for
nineteen minutes ended an orchestration.

## 2. Root cause

### 2.1 The daemon's rule (ground truth)

`fade-supervisor/internal/rules/rules.go`, `AdmitLease`: a lease is keyed by
`(caller, session)`, and only that pair may renew or release it. The cases, and what each one
means for a caller:

| Daemon case | Wire answer | Meaning for the caller |
| --- | --- | --- |
| free | 200 `lease_granted` + token | the lane is yours for the TTL |
| same pair re-acquires | 200 `lease_renewed` | you own it; the ask is a renewal |
| held, **different pair** | **409 `lease_held`**, `lease held by %s (session %s, %d s left): acquire is refused until it is released or expires` | someone holds it, with a countdown |
| token presented is not current | 409 `lease_stale_token` | your capability died; stop swapping |
| release from a non-holder | 409 `lease_not_holder` | not yours to release |
| dev build asks | 409 `dev_build_no_evict` | this caller may never take the lane |

The observed string is the **`lease_held`** case verbatim, so the acquiring `(caller, session)`
pair differed from the holder's pair while the caller was the same. That is an identity defect,
not a contention event.

### 2.2 The identity split (measured in this tree)

`AdmitLease` keys on `(caller, session)`; the plugin presented **three** sessions from one
process:

| Site | Session presented |
| --- | --- |
| `acquireLaneLease(THINK_LANE, runId, ctx)` at the start claim (was `index.ts:2351`) | the **run id** (`20261127T…-abcd`) |
| `loadLane(THINK_LANE, { leaseToken, sessionId: runId })` at the preflight (was `index.ts:2358`) | the run id |
| the review-turn load, `sessionId: leaseToken ? leaseSession \|\| SELF_SESSION : verifyLeaseSession \|\| SELF_SESSION` (`index.ts:1002`) → the mint inside `loadLane` (`router.ts:414`) | **`omp-pid-<pid>`** (`SELF_SESSION`, `index.ts:214`) |
| `moveLane(target, { sessionId: \`omp-pid-${process.pid}\` })` (`index.ts:1908`) | `omp-pid-<pid>` |

A run that acquired the lane under its run id and then asked for a review-lane load presented
`omp-pid-<pid>`: the daemon answered 409 naming the run's own lease as the holder. The minted
token lived only in a process closure (`leaseToken`, `verifyLeaseToken`), so any act without the
closure token minted afresh — the same 409, from the same process.

The holder in the operator's message carries an OMP session UUID (`01a21a8e-…`), which is a
client presenting the host session id — the same collision class, from the other side: Frontier's
lane act and the orchestrator's act are different pairs on one lane.

### 2.3 The outcome defect

`loadLane` answered the mint refusal with `ok: false` (`router.ts:417-425`), and the switch's
only branch for `!loaded.ok` was:

```ts
fail(ctx, `loading lane ${lane} failed (${loaded.detail}); briefing not sent`);
```

`fail()` sets `state = "failed"`, releases the run lock and the lane lease, and notifies. A
`lease_held` carries a holder and a countdown — a lane state, not a run verdict — and the run's
plan (tasks, checks, round) was untouched by it. The message named neither the review state nor
what had happened to the briefing, which is why it read as a lost round.

## 3. The fix

### 3.1 One lease identity per process

`index.ts`: the start claim, the preflight load and every mint present **`SELF_SESSION`**
(`omp-pid-<pid>`), and `acquireLaneLease(lane, sessionId, ctx)` takes an identity, not a run id.
One process, one lease, one token to renew; `AdmitLease`'s cross-pair refusal has nothing left to
refuse inside a process. A **peer** process is still a different pair, and that refusal is the
serialization the lease exists for — it is unchanged.

### 3.2 The capability is persisted, so a re-entry renews

`supervisor.ts`, the token store:

```
$FADE_ORCHESTRATE_STATE_DIR/leases/<caller>-<sanitized session>.json   0600, dir 0700, temp+rename
```

- written **at the grant** (`acquireLaneLease`) and **at a mint** (`loadLane`);
- `loadLane` reads it **before minting** and presents it as a `renew`; the store is cleared when
  the daemon proves the token dead (`lease_stale_token`, `lease_not_holder`) and on an accepted
  release;
- the session id is sanitized into a filename, so a caller cannot name its way out of `leases/`;
- a write failure is silent by design (the gate rigs `rm -rf` their state dirs): the caller keeps
  the token in memory and the lane act proceeds.

This is what removes the 409 class: the re-entry presents the grant it already owns.

### 3.3 A mint refused over a held lane is a DEFERRAL, not a failure

`router.ts`, `LaneLoad`:

```ts
deferred?: boolean; leaseRule?: string; leaseHolder?: string; leaseRemainingS?: number; leaseTokenHint?: string;
```

`lease_held`, `lease_not_holder` and `lease_stale_token` (a claimed lane, with a countdown)
return `deferred: true`. Refusals with no countdown — `dev_build_no_evict`, `lease_required`, the
VRAM and residency gates, a dead router — stay plain `ok: false`.

`index.ts`, `deferLaneMove`:

1. **the pin does not move.** The pack stays where it is and the session's pin stays on the pack
   the lane **serves**;
2. **the page is queued** — `run.deferred_lane`, `run.deferred_briefing` (a kind, built at the
   landing from the live run state, never frozen at the refusal), `run.briefing_delivery =
   "queued"`;
3. **the retry rides the daemon's countdown** — `remaining_s * 1000 + 3 s`, floored at
   `FADE_ORCHESTRATE_LEASE_RETRY_MIN_MS` (15 s) and capped at `FADE_ORCHESTRATE_LEASE_RETRY_MAX_MS`
   (600 s), recorded as `run.lease_retry_at_utc`;
4. **the retry has a ceiling** — `FADE_ORCHESTRATE_LEASE_RETRY_MAX_TRIES` (3) per queue. A deferral
   re-arms from its own retry, so an unbounded chain is a client hammering the daemon, a row
   repainting forever, and a suite whose process never exits (measured: a full-suite run that ran
   past its fifteen-minute bound on one 3 s loop). At the ceiling the client stops, says so
   (`… is STILL owed after N tries … the client stops re-asking`), and leaves the queue: the row
   keeps naming the owed lane, the appointment is cleared, and the operator's keys re-ask by hand.
   A landing on the owed lane resets the count;
5. **the operator's line names everything**: the rule, the holder, the countdown, what the pin is
   doing, the briefing state, the review state, and the appointment;
6. `state`, `round`, `stall_count` and the protocol counters are untouched — enforced in
   `core.ts:applyLaneDeferral`, the only writer of these fields.

### 3.4 The non-404 while the model has time to switch (the operator's instruction)

The deferral re-uses **the same wrapper the 404 fix built** — `laneServeHold`, run at the switch
boundary and in `before_agent_start` (`holdForServedPin`). Because a deferral never pins a pack
the lane does not serve, the next completion is a completion of the pack that answers
`/v1/models`: one read when the pin already matches, a keep-alive page every 10 s when it does
not, the daemon's readiness window as the ceiling, and never
`404 The model '…' does not exist`. When the retry wins, the load, the pin, the thinking level,
the tool policy and the queued page go out in **one act in one generation**, and that same wrapper
holds the completion after the swap. Background, `docs/prompt-fix-lane-switch-404.md`.

### 3.5 Release ownership

`releaseOwnedLease(token, sessionId)` is the release path for both capabilities. It retires the
**presenting pair's** stored token with an accepted release, clears it on `lease_stale_token`, and
leaves every other pair's file exactly where it is. A refused release is written to stderr naming
the rule. The daemon remains the arbiter: a non-holder's release is `lease_not_holder`, and a
caller that wants the lane back goes through the holder.

### 3.6 The line the operator reads

`markBriefing` records `briefing_delivery` (`sent` / `queued` / `quiet` / `not-sent`) and
`briefing_sent_at_utc` **at the send**; the status row's suffix names the deferral
(`owed hy4-flash · lease fade-orchestrator · retry 14:16Z · briefing queued · review verdicts
open (round 2, batch 2)`) and outranks the decode-rate chip, because an owed lane is the fact the
row exists to carry. A hard failure's line now names the review state, the briefing state and the
pin's fate, where the old line said only `briefing not sent`. A quiet hand-back ships no page by
design and records `quiet` — and clears the queue, because a lane that landed quietly is not owed.

`core.ts` exports `applyLaneDeferral`, `clearLaneDeferral` and `reviewStateLabel` so the state
transition and its wording are one rule, read by the row, the deferral line and the suite.
Frontier's `settled unreviewed` warning is the frontier surface's own line; this is the
orchestrate side of the same fact.

## 4. Recovery act for a live `lease_held`

For the observed state (holder `fade-orchestrator`, session `01a21a8e-…`, 1137 s):

1. read it: `fade-supervisor lease status` (or the `/lanes` census) — it names the holder pair and
   the remaining seconds;
2. the holder **releases** it: `/orchestrate stop` in the holding session, which runs
   `releaseLaneLease` on its own token. Only that pair can release it — the daemon refuses anyone
   else with `lease_not_holder`, and the client now refuses to delete a capability it does not own;
3. if the holder's process is gone, the lease **expires on its TTL** and the lane is free; the
   deferring side re-asks on `lease_retry_at_utc` and lands;
4. never release a foreign token: it is refused on the wire, and it is not the way to free the lane.

Measured at the time of this fix: `fade-supervisor lease status` reported **free** and
`:18014 RESIDENT pack=flash-next … lease=free` — the 1137 s claim had already expired, so nothing
was released by hand and no live lane was touched by the repair.

## 5. Verification

- `npm run typecheck` (`tsc -p tsconfig.json`): clean.
- **The failure reproduced on demand.** Against the pre-fix build (a `git worktree` at HEAD), a stub
  daemon answering 409 `lease_held` printed the operator's line verbatim —
  `loading lane hy4-flash failed (lease mint refused http 409 rule lease_held: lease held by
  fade-orchestrator (session …, 1137 s left): acquire is refused until it is released or expires);
  briefing not sent` — on the plain-session verification boundary. The probe (`~/scratch/ldb-probe.mjs`,
  throwaway, deleted after the proof) is that reproduction; the same run exposed the tree finding in §7.
- `test/lease_defer_briefing.test.mjs` (new, 6 tests) runs the mechanism where the 409 is answered:
  the built `loadLane` against a stub supervisor on a Unix socket, the token store, and the state
  transition. Stub pair only — no live `:18014`, no lease taken on the box, no systemctl.
  1. a mint refused over a HELD lane answers `deferred: true` with the daemon's rule, holder,
     countdown and masked hint, the operator's string intact in `detail`, and **zero packs admitted**;
  2. a floor with no countdown (`dev_build_no_evict`) is a hard failure with **no** `deferred`: the
     deferral class is exactly the claim class, so a caller that may never take the lane is not
     queued behind it;
  3. the minted token is **durable** (0600, names the pack), and **a re-entry mints nothing**: a lane
     act carrying no in-memory token moves the lane on a `renew` of the stored grant — `acquire`
     stays at zero for that act, which is the 409 class removed;
  4. a token the daemon proves dead is **tried first, then dropped**: the act renews, takes the named
     refusal rather than swapping unleased, leaves nothing pinned to the dead capability, and the
     next act that asks for a mint gets a fresh grant in exactly one acquire;
  5. a foreign release is refused and named `lease_not_holder`, the holder's stored capability
     survives it, and an accepted release retires the store with it;
  6. the deferral's state contract: lane / page / queue / appointment / review label; the token never
     reaches the rendered state; `state`/`round`/`tasks`/`checks` byte-identical across the deferral;
     and the clear-on-landing rules (`sent`, `quiet`, and a landing on a lane that did not answer the
     queue leaves it owed).
- `test/env.mjs` deletes `FADE_ORCHESTRATE_STATE_DIR`, `FADE_ORCHESTRATE_LEASE_RETRY_MIN_MS`,
  `FADE_ORCHESTRATE_LEASE_RETRY_MAX_MS` and `FADE_ORCHESTRATE_LEASE_RETRY_MAX_TRIES`, **and points
  `FADE_ORCHESTRATE_STATE_DIR` at a scratch store of its own** (one directory per process, made at
  import, removed at exit). Deleting the key is not enough: `STATE_DIR` resolves at module import, so
  a rig that only deletes it mints into the **operator's real state directory**, and a file left there
  makes a later suite renew a lease it never asked for. Measured on this fix's first full-suite run:
  `resident_gate` gained a `renew token=T-OK` wire line out of a neighbour's mint.
- `test/resident_gate.test.mjs` mints under **per-test session ids** (`sess-refused`, `sess-kept`,
  `sess-mintrefused`) where three tests shared `sess-turn`. With a durable store, a shared id is one
  test renewing the lease a neighbour left — precisely the production behaviour the store exists to
  provide, and never the rig's intent. The file's own convention (`sess-verify`, `run-9`) already
  isolates its other tests, so this aligns with it rather than adding a rule.
- This suite builds its stub pair, its lease store, its environment and its bundle import **per
  test**, and hands the environment back at the end of the test. Three shapes were measured and two
  of them are traps with no compiler behind them:
  1. **file-top environment export** (the first cut): 6 of 6 alone, and it froze this suite's stub
     router URL and daemon socket into every later suite's singleton — the runner evaluates every
     file in one process, and those suites import their bundle in a test body. Measured: a 28-file
     run that reached 121 of 352 tests and died at its fifteen-minute bound;
  2. **shared module-top stub servers with per-test imports** (the second cut): the run stalls with
     the last foreign test as its final line — 121 `ok`, then silence — alone (`exit 124` at 60 s)
     and beside a sibling file alike;
  3. **per-test everything** (the shape now, and the shape `resident_gate` already uses): 246 tests
     across 10 files in 6.7 s, no stall.
- The supervisor socket resolves at **call** time, not at import (`supervisor.ts:resolveSock`,
  `pinned = env.FADE_SUPERVISOR_SOCK`, which "wins outright and is never probed"). Handing the
  environment back at the import — `env.mjs` mechanism 2 read too early — made `loadLane` resolve the
  real `/tmp/fade-supervisor.sock`, and the **live** daemon answered a real 409 `lease_held` (session
  `01a21b7c-…`, 887 s left) inside a suite whose whole contract is that it never touches the box. The
  rig therefore keeps its environment for the act and restores it in `close()`.
- The rig's stub pair is **coupled**: an admitted swap moves the daemon's residency **and** the
  router's `/v1/models` census, as it does on the box. A daemon-only update leaves the census naming
  the old pack, and `loadLane`'s census short-circuit (`already resident; no swap issued`) then
  answers the next act with `ok: true` and **zero** supervisor wire — measured as a renew assertion
  reading an empty wire, which is the silent-pass shape this rig must never have.
- The scoped gate — every `test/*.test.mjs` except `lane_switch_404.test.mjs`, **one** `node --test`
  process, 28 files, the same command `npm test` runs minus the file named in §7:
  **358 tests, 357 passed, 1 failed in 16.2 s**, and that one failure is `verify_lease` test 352,
  attributed in §7.4 (green at HEAD, red on this tree by the same recorder gate). `resident_gate` is
  green in the same process, and `test/lease_defer_briefing.test.mjs` is **6 of 6**, alone and in
  company. `npm test` itself still hangs on this tree, on `lane_switch_404.test.mjs` alone (§7.1).
- `npm run typecheck` clean after the last edit; the snapshot in `fadetheworld/deploy/omp/` is
  byte-identical for every touched file (`cmp` on each).

## 6. Deliberate limits

- A **quiet** hand-back ships no briefing page; it records `quiet` and clears the queue. Sending a
  page for a lane the operator did not ask about would queue a request naming the lane just left.
- The retry is bounded by the cap. Past the cap the row keeps naming the owed lane, the queue
  stays in `state.json`, and the operator's `/orchestrate` keys re-ask by hand — a lane pinned by
  a holder that died outside its TTL is an operator call, not a client hammering the daemon.
- `session_shutdown` clears the retry timer: a lane request fired into a closed host is a notify
  nobody reads and a mint nobody owns. The queue is durable and the next session's boundary
  re-asks, where the completion of the serving pack is held by `laneServeHold` — a resumed session
  cannot 404 on an unanswered queue.
- Frontier's own loop cannot host this repair: `frontier` resolves planned edits and tests against
  the **session repo** (`fadetheworld`), so a plan naming plugin paths is refused
  (`… is not under any access:"write" directory`) and `npm test` would run in the wrong tree. The
  repair was made with plain tools in the plugin repo; the loop's limitation is on the record.

## 7. A finding about this working tree (not this fix)

The tree carries uncommitted work: a `frontier` tool-call guard that sets `frontierOwnsLane`, a
delegation-recorder gate on `laneControlEnabled`, and an untracked `src/recovery.ts`. The recorder
gate moves the surface that produced the operator's 409:

```ts
// HEAD                                  // this tree
if (!isDelegatedSession()) {             if (laneControlEnabled && !isDelegatedSession() && !frontierOwnsLane) {
   … verifyTrigger … pendingVerifyLane …     … verifyTrigger … pendingVerifyLane …
```

`laneControlEnabled` starts `false` (`index.ts:225`), is set `false` again at `session_start`, and
turns `true` only at an `/orchestrate` act that owns a run (`:2324` resume, `:2407`
`verify|code|reset`, `:2494` the start claim). So on this tree:

1. **`test/lane_switch_404.test.mjs` is red and its process stops exiting** — 9 of 12 tests, every
   one of them a plain-session boundary that no longer moves a lane. Proof it is not this fix: the
   same file at HEAD with this fix's `router.ts`/`supervisor.ts`/`core.ts` applied is **12 passed,
   0 failed, 123 s** (a linked worktree, measured 2026-11-27). The probe above shows why: the
   pre-fix build prints `lane on verification: hy4-flash …` on a plain boundary; this tree prints
   nothing.
2. A plain OMP session takes **no advisor lane at all** for a delegated verdict act. That is a
   design question for the operator, not a defect in the lease path: either a plain session may move
   the lane (then the 404 suite is right and the gate is the bug), or it may not (then the suite's
   rigs must arm lane control the way a real session does, by an `/orchestrate` act).
3. The same gate is why the deferral's **extension-level** line (`deferLaneMove`: the notify, the
   queue, the retry ceiling, the shutdown clear) has no rig here — reaching it needs a run-owning
   session, which is `preflight_proof`'s harness. Its state contract, its wire contract and its
   classification are covered by `test/lease_defer_briefing.test.mjs`; the line itself is verified
   by reading, and will be covered when a run-owning rig drives a held lease.
4. **`test/verify_lease.test.mjs` is red on this tree for the same gate, proven by A/B.** On the
   tree: 1 test, 0 passed, 15 s timeout, and the wire is **empty** — `no match in 15000 ms — wire:
   the plugin said:` with nothing after it, i.e. the recorded act never reached the lane machinery.
   At HEAD (its own committed `src/index.ts`, no `laneControlEnabled` gate, same rig, same build
   script, shared `node_modules`): **1 passed, 0 failed, exit 0** — linked worktree `~/wt/vl-head`,
   measured 2026-11-27, 121 s. So the extension-level record the lease suites drive is gated off
   exactly as the 404 suite's plain boundaries are; neither red is the lease path.

This fix does not touch that gate. `lane_switch_404.test.mjs` (9 of 12, process stops exiting) and
`verify_lease.test.mjs` (1 of 1, empty wire) are left red and named, not re-pinned: both are green at
HEAD by the A/B above, so the repair belongs to the gate's author, not to the lease path.
