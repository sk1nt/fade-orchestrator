# Prompt: switch the pack and the prompt in the same act

Paste everything below the line into a new session whose cwd is
`/home/rwest/projects/fade-orchestrator`. The live extension is the symlink
into `src/index.ts`. Do the work. Reload the OMP session when the tests are
green so the live loop picks up the source.

---

Fix the halt that fires when the loop switches packs. The pack swap and the
session pin / phase prompt are **two calls that both already work**. Whatever
issues the model switch must issue the prompt change **in the same act**.
The **completion** then waits the way Basalt's router already waits: the
client is told to wait, the connection stays open, nothing times out, and a
known lane is never a 404.

Work in `/home/rwest/projects/fade-orchestrator`. Do **not** steal the live
`:18014` lease, do **not** `POST /v1/swap` against the live lane, do **not**
`systemctl` the supervisor. Prove with the existing fake-router rigs
(`test/gate_rig.mjs`, `test/preflight_proof.test.mjs`, `test/verify_lease.test.mjs`).
Host smokes (`test:rpc`, `test:pty`) only if you must, and only with
`FADE_ORCHESTRATE_LIVE_SMOKE=1` after the operator agrees.

## The stop, measured live

```
Warning: frontier: task go-with-157-land-the-module-rename-farol-2 settled unreviewed

lane on verification: hy4-flash — the verdict act lands at the turn boundary

GradeForge: cycle 9 composite 0.9250 actions []

frontier: review round 2 opens on the planner that did not write this plan: :18014 → hy4-flash (model hy4-flash)

✘ 404 The model 'flash-next' does not exist
  (type=invalid_request_error param=model code=model_not_found)
```

The lane moved to `hy4-flash`. The next completion still named `flash-next`.
The router serves **one** id. That is the 404. The switch caller moved the
pack (or frontier announced the new model) and **did not** change the
session pin and the phase prompt in the same act.

The same class in the other direction: a hand-back starts loading
`flash-next` while the session pin and the verify briefing are still on
`hy4-flash`.

## The contract (this is the whole fix)

Two layers, both copied from Basalt. Verified in
`/home/rwest/projects/basalt/docs/configuration/models.md` and
`docs/running.md` / `docs/changelog/0.3.0.md`:

> Clients wait through a swap; they do not get a 503 for it. A streamed
> response sends keep-alive comments every 10 s while it waits.
> A request for the loaded model runs at once. A wrong name is a 404.
> A failed load answers its batch with a 503 naming the model.

On this box a supervisor swap **replaces the process** on `:18014`, so that
Basalt instance only knows the resident pack. `flash-next` while
`hy4-flash` is loaded is a 404 here, because the name is not in that
server's `models` list. The plugin has to give the client the same wait
the multi-model Basalt router would have given.

### 1. Same act: switch the pack and the prompt (do not wait to *issue*)

One function, one generation, two calls together:

1. the pack switch (`loadLane` / swap) toward `lane`
2. the prompt change: `pi.setModel(PROVIDER/lane)` + `setThinkingLevel` +
   `applyToolPolicy` + the phase briefing (`briefings.verify` /
   `briefings.code` / `briefings.verifyBatch` / …)

Issue them in the same `runSwitch` / `requestLane` body, on the same turn
boundary, **without waiting** for `proveResident` or `/v1/models` before
the pin and the briefing go out.

The host defers `setModel` while a turn is still streaming. That is why
the act belongs at `agent_end` (turn already closed), issued together,
not deferred to the next `before_agent_start`.

### 2. Hold the completion like Basalt (the client waits; nothing times out)

After the pin is `hy4-flash`, the next turn's HTTP call must **not** hit
`:18014` until that id is served. Replicate Basalt's wait, not a timeout
and not a 404:

- `before_agent_start` (the last hook before the host posts) **holds**
  until `servedIdentity().id === ctx.model.id` for a configured lane, or
  until the load itself fails. It does not return and let the host 404.
- While holding: `ctx.ui.setWorkingMessage` with the swap percent from
  `/health` (Basalt's header reads `Loading` with the percent). Refresh
  at least every **10 s** — that is Basalt's keep-alive cadence for a
  streamed wait. Do not drop the working indicator. Do not let the host
  client timeout (the wait is the swap: tens of seconds, up to the
  daemon's 900 s readiness window).
- A request that already names the **served** id runs at once (Basalt:
  loaded model, nothing waiting).
- A name that is **not** a configured lane (`CODE_LANE` / `THINK_LANE` /
  `VERIFY_LANE`) is a 404. That is Basalt's "any other name".
- A **failed** load is the 503 class: notify naming the model, do not pin
  a pack that never came up, do not brief. The loop does not die on
  `flash-next does not exist`.

Do **not**:

- wait to *issue* `setModel` / the briefing until residency (today's
  prove-then-pin). The pin goes out with the swap; the **HTTP
  completion** is what waits.
- skip auto-sync and leave `ctx.model.id` on the old pack
- let frontier open a review round that names `hy4-flash` while this
  session's pin is still `flash-next`
- fail the run because the router 404'd an id mid-swap. That 404 is the
  plugin posting too soon. Hold instead.

`requestLane` may stay serialized on `switchChain` so two switches do not
ping-pong. Serialization is not a substitute for the hold: the next
turn's `before_agent_start` still waits until the served id matches the
pin.

## What is already in the dirty tree

Uncommitted on `main`: `src/index.ts`, `src/router.ts`,
`test/gate_rig.mjs`, `test/preflight_proof.test.mjs`,
`test/verify_lease.test.mjs`. That diff **waits** (`proveResident` before
`setModel`, `switchingTo` so auto-sync skips during drain). That wait is
the wrong shape for this halt. Rework it:

- Keep `proveResident` as the **hold** inside `before_agent_start` (and
  any path that is about to post a completion). It is not a gate in
  front of `setModel` or the briefing. The pin is already the new id;
  the proof is "has `:18014` caught up", which is Basalt holding the
  request.
- Keep `switchingTo` only if it still helps auto-sync. Auto-sync must not
  be the thing that changes the prompt; the switch caller does that.
- Quiet / hand-back still skips the *user-visible* briefing page (a
  hand-back is not a phase). It still **pins** `CODE_LANE` in the same act
  as the load. A quiet switch that loads `flash-next` and leaves the pin
  on `hy4-flash` is this 404 inverted.
- On a load that itself fails (`loaded.ok === false`), do not pin and do
  not brief. A failed swap is not a prompt change.

## Call sites that must fire both

Every path that today calls `requestLane` / `runSwitch` / `loadLane` toward
a new id:

| Caller | Pack | Prompt in the same act |
| --- | --- | --- |
| `agent_end` paying `pendingVerifyLane` | `VERIFY_LANE` (`hy4-flash`) | pin `hy4-flash`, thinking high, verify / verifyBatch briefing |
| `agent_end` hand-back from a thinking lane | `CODE_LANE` (`flash-next`) | pin `flash-next`, thinking low, no phase page (quiet) |
| desk dispatch `requestLane(VERIFY_LANE)` | same | same as verify |
| overlay v/c keys | the key's lane | pin + that lane's briefing |
| `/orchestrate` start preflight | `THINK_LANE` | pin `deepseek` + planning briefing together (today it proves, then pins, then briefs — join the last two with the load, drop the prove-as-gate) |
| pause-resume landing the owed lane | owed | pin + that phase's briefing |

Frontier's "review round 2 opens … model hy4-flash" is not a substitute
for this session's `setModel` + briefing. If frontier is a second caller,
it must pin and prompt too, or this plugin must have already done it at
the verification boundary that printed `lane on verification: hy4-flash`.

## Tests (mandatory)

Fake router only. Do not talk to live `:18014`.

1. **Same-act pin (this transcript).** `requestLane("hy4-flash")` /
   `runSwitch`: `setModel` for `hy4-flash` is invoked in the same switch
   generation as `loadLane`, **before** any residency wait returns, and
   the verify briefing is queued in that generation. Session model after
   the act is `hy4-flash`. A completion that still names `flash-next`
   fails the test.
2. **Basalt wait.** Stub `/v1/models` still listing `flash-next` after
   the pin is `hy4-flash`. `before_agent_start` (or the helper the rig
   uses) does **not** return until the stub lists `hy4-flash`. Working
   message is set and refreshed. No 404 body. When the stub flips to
   `hy4-flash`, the hook returns and a completion would name
   `hy4-flash`.
3. **Loaded id runs at once.** Pin already matches served id → the hold
   is a no-op (zero extra polls beyond one read).
4. **Failed load is 503-class.** `loadLane` not ok → no pin, no
   briefing, notify names the model, loop does not 404 `flash-next`.
5. **Quiet hand-back.** `requestLane(CODE_LANE, quiet, true)` pins
   `flash-next` in the same act. No verify briefing. Next turn holds
   until `flash-next` is served.
6. **Superseded generation.** `gen !== switchGen` still cancels pin and
   briefing for the dead switch.
7. `npm run typecheck`, `npm test`, `npm run test:gate` — all green.

If existing tests assert "no `setModel` until `/v1/models` lists the id",
**change those tests**. Pin and load in one generation; the hold is on
the completion, not on the pin. A 404 on the *old* id must not happen
because the pin already names the new one, and the host must not post
until the new one is served.

`LANE_POLL_MS` overrides in the rigs stay for any status polling you keep.
Do not sleep the live 900 s window in CI.

## Live session after the tests

OMP loads `src/*.ts` through the extension symlink. A green suite does
not change a running process. After the tests pass, tell the operator to
**reload the OMP session** that printed this 404. Do not cutover the
supervisor. Do not swap packs yourself. Do not commit unless asked.

## Done when

- The call that switches the pack also pins the session and sends (or
  quietly applies) the prompt in that same act.
- The next completion is held until `:18014` serves that pin: working
  message + 10 s keep-alive cadence, no client timeout, no 404 on a
  configured lane.
- The transcript's sequence cannot 404 `flash-next` after announcing
  `hy4-flash`.
- `npm test` and `npm run test:gate` pass.

## Report back

Files changed, how `runSwitchBody` fires load + `setModel` + briefing
together, where the Basalt-style hold lives (`before_agent_start` /
helper), the 10 s keep-alive, which tests you rewrote, suite counts, and
that the live session still needs a reload.
