# The overlay survives the loading phase, and the switch owns its holding page

## 1. The crash: `extension render failed: undefined is not an object (evaluating 'this.tui.terminal.rows')`

The signature is the host's, not the panel's: the host catches any throw from a mounted
component's render pass and prints `extension render failed: <msg>`. The deref that threw is
`PanelComponent.getHeight()`'s `this.tui.terminal.rows` (the JSC/Safari wording of reading
`.rows` of `undefined`).

Mechanism, measured on this box: the host hands the extension a **loading-phase proxy TUI** —
the `ui` proxy whose action methods throw on the call ("Extension runtime not initialized.
Action methods cannot be called during extension loading.") and whose property reads answer
`undefined`. A panel opened on a `session_start`-time path (the RPC/print mode, and the chord
path while the host is still wiring) receives that proxy. `tui.terminal` is `undefined`,
`.rows` derefs, the host catches the throw **per render pass**, and the panel never paints:
Alt+F appears to do nothing, on every keystroke, forever.

## 2. The wrapper: `terminalSize` is the ONE terminal read

`src/panel.ts` now routes every size read through one exported function:

```ts
export function terminalSize(tui: PanelTui | undefined): { rows: number; columns: number }
```

- The reads sit **inside `try`**: a proxy that throws on the property GET is the same
  non-answer as a missing member, and gets the fallback. This mirrors the guard the wiring
  layer already carries for the host's loading-phase action methods (`hostConflict`,
  `ensurePhaseTool`).
- A size is a size only when it is a **positive finite number**: `0` (a detached TUI),
  `null`, `"40"`, and a stub's `undefined` all mean "not measured" → the panel draws its own
  box at `PANEL_FALLBACK_ROWS = 24` × `PANEL_FALLBACK_COLUMNS = 120`.
- `PanelTui.terminal` is **optional in the contract** (`terminal?`), so the shape the host
  actually hands over type-checks; the compiler is no longer told a lie that the runtime
  proved false.
- `getHeight()` and `render(width)` read **only** through the wrapper — the rig drives each
  non-answer shape (missing, throwing proxy, zero, string) directly
  (`test/panel.test.mjs`, the `terminalSize` cases).

A throw in `getHeight` is not a cosmetic failure: the host asks for the height **before**
`render`, so one unchecked read is a panel that never paints at any size.

## 3. The same wrapper, in orchestration: the switch's holding page

The operator's rule: the same defensive shape the panel obeys must govern the **lane switch**,
so the 13-25 s pack load shows the operator a page that moves, not a blank session.

The switch at the turn boundary (`runSwitchBody`, `src/index.ts`) runs **the same wrapper the
completion runs** — `laneServeHold` — at the act that asked for the lane, not two turns later:

1. **Admit is the act.** `loadLane` (the pack swap) goes out, and `setModel` +
   `setThinkingLevel` + the **tool policy** follow in the same generation, with no residency
   read in front of them. Pin-then-prove was the 404's other half: the pin and the briefing
   named the PREVIOUS pack for the whole load, and the completion answered
   `404 The model 'flash-next' does not exist` (run 20261126T063911Z-m5or).
2. **The page.** While the pack loads, the progress callback paints
   `setWorkingMessage` and the multicolored pill (the router's **own** percent from `/health`)
   on the keep-alive clock. A superseded generation paints nothing — the row and the pill
   belong to the switch that replaced it.
3. **The gate.** The briefing and the first completion issue only once the lane **serves the
   pack the pin names**. `before_agent_start` holds the host's completion the same way.
   Basalt's contract, copied from `configuration/models.md` / `running.md`: the loaded model
   runs at once (normal case = **one** `/v1/models` read, says nothing, proceeds as before);
   a client waits through a swap and is never 503'd for it; a name the server does not carry
   is a 404; a failed load is the 503 class — and the switch STOPS there: no briefing, the
   screen follows the lane that does serve, and the owed lane stays named.
4. **The page clears** the moment the lane serves, on the success path and the failure path.

The plain session (no run) that lands the advisor lane for its own verdict act now gets its
fixed page — the model is told it answers from the advisor pack. A plain CODE landing and a
quiet hand-back stay silent: nothing in the session is waiting on them.

## 4. Proved by

- `test/panel.test.mjs` — the `terminalSize` non-answer shapes; the chord-follows-config test
  (the wrapper is per-import, and the suite owns its env).
- `test/lane_switch_404.test.mjs` — the pin/policy at admit while the swap is **in flight**;
  the page repaints on the keep-alive clock and carries the percent; the briefing waits for
  the pack; admits-never-serves briefs NOTHING and stays owed; the loaded lane costs exactly
  one census read.
- Gate: `npm test` (`node --test`) exit 0.

## 5. The hermeticity rule this work exposed

The suites run in ONE process and the bundles resolve endpoints, sockets and windows at
module IMPORT. Four leaks made a green tree read red, none of them the plugin:

1. **A rig's stub URL frozen into the singleton** — the first importer of a bundle file wins,
   so a later suite's proof polled a stub server that suite never started
   (`served_id: undefined`) and the thinklane residency gate stopped firing (the router
   endpoint no longer matched). Fix: every rig/suite that names its own endpoints imports a
   fresh instance (`?case=`): `gate_rig.mjs`, `preflight_proof.test.mjs`, and the suites that
   already carried a `fresh()` helper kept it.
2. **`env.mjs` is a CACHE KEY** — a bare `import "./env.mjs"` evaluates ONCE for the run, at
   the FIRST suite's graph position, so every suite after it inherits whatever the rigs in
   between exported: a rig's `FADE_ORCHESTRATE_KEY` frozen into `panel.mjs` (the default chord
   stops closing the panel), a rig's `FLIP_WINDOW_MS=0` frozen into a lease suite (the breaker
   refuses the swap and the test dies at its deadline), a rig's 3 s mint TTL frozen into the
   next importer. Fix, both in `test/env.mjs`: import with a **per-suite query**
   (`import "./env.mjs?suite=panel"` — each file gets its own instance, deletes at its own
   position), and `resetLaneEnv()` for imports that happen in a **test body**, after every
   file has run (`lane_identity`, `verify_lease`).
3. **The box's own `PI_SESSION_FILE`** — every agent shell exports it, and
   `isDelegatedSession()` reads it at CALL time: a rig that inherits it is a delegated
   session, the verify act is never recorded, and the lane machinery silently stops (an empty
   tool-policy capture is that, not a policy bug). `env.mjs` deletes it.
4. **A prior test's in-flight serve-hold** outlives that test's `close()` and bills its
   keep-alive polls to whichever test counts `/v1/models` next (the one-read contract answered
   `2 !== 1`). Count from a quiet wire (`quietModels`).
5. **bun normalizes a `file:` URL by dropping its query.** A rig that cache-busts with
   `${built.href}?case=` (an absolute file URL built from `import.meta.url`) silently shares
   ONE module instance with the first importer — measured: the lease fixture's factory carried
   a donor rig's frozen `ROUTER` (36817) while its own env named 20000, and the pre-unload
   gate refused 15 s on the donor's dead port against a live stub. The cache-bust must ride a
   RELATIVE specifier (`../.test-build/index.mjs?case=`), which keeps the query —
   `test/panel.test.mjs`'s chord test is the working precedent, and `lane_switch_404` and
   `verify_lease` now import that way.

Gate for both runners, because their module graphs differ and the leaks were runner-specific:
`npm test` (`node --test`, 357 tests) and `bun test` (27 files, one process) both exit 0.

## 6. Round-1 findings: the equal-length tool policy, and the stale-bundle trap

**The verifier tool strip compared LENGTHS, not contents** (`applyToolPolicy`): the read-only
set removes the writers and adds `fade_phase`, and a tool set like `[read, bash, edit, task]`
maps to `[read, bash, task, fade_phase]` at the SAME length — the old `length !==` test skipped
`setActiveTools`, so `edit` stayed live on the thinking lane and `fade_phase` never arrived:
the strip is part of what "on the advisor pack" MEANS, and it silently meant nothing. The set
is compared by membership now, and `test/lane_switch_404.test.mjs` pins the equal-length case
by name.

**`bun test` does not run `pretest`,** so it grades the bundle in `.test-build/` AS IT LAST
BUILT: the regression above read "fails" against a stale bundle that predated the fix — the
test was right and the artifact was old. Rebuild with `node test/build.mjs` before grading a
source change with `bun test`; `npm test` builds on its own.

**Gate-rig blocks share one clock.** Block 13's transit dial and its settles set the schedule
the flip-window ledger in block 19b counts inside (a 60 s window over a ~140 s run). Moving
block 13's dial ahead of the boundary broke 19b's expected swap census. The block's only safe
change is the one that adds no clock: capture the baselines before the trigger, keep the
schedule after it byte-identical.
