# Fix fade-orchestrator: guest packs never load, Alt+F traps the TUI, drop the pre-unload VRAM floor

You are working in `/home/rwest/projects/fade-orchestrator` (git `main`, live extension is the symlink `~/.omp/agent/extensions/fade_orchestrate.ts` → `src/index.ts`). OMP loads the TypeScript source; `dist/index.js` is the bundled form. Tests import `.test-build/` via `npm test` / `node test/build.mjs`.

Do the work in this tree. Use the supervisor/router stubs and existing rigs. Do **not** steal the live `:18014` lease, do **not** `POST /v1/swap` against the live lane, do **not** kill the live `fade-orchestrator` holder (`20261126T063911Z-m5or` on `grade-forge`, pack `flash-next`). Prove swaps with `test/swap_stub.mjs` / `test/resident_gate.test.mjs` / `test/load_hostile.mjs`.

Two files already have a **partial** start (`git diff`): `src/panel.ts` (close encodings) and `src/router.ts` (floor branch removed from `serveVerdict`). Finish those, wire tests and docs, then fix the lane routing. Do not revert the floor removal.

---

## 1. Symptom: `/orchestrate` never calls `deepseek` or `hy4-flash`

**Measured.**

Live `:18014` health: `model: flash-next`, `loaded: true`. Supervisor residency: `lane_state=RESIDENT`, `active_pack=flash-next`. Lease held by `fade-orchestrator` session `20261126T063911Z-m5or`.

Live run `/home/rwest/projects/grade-forge/var/omp-orchestrate/state.json`:
- `run_id=20261126T063911Z-m5or`, `state=coding`, `lane=flash-next`
- phases: `planning_done` on **flash-next**, `coding_done` on **flash-next**
- zero swaps to `deepseek` or `hy4-flash`

OMP `modelRoles` (`~/.omp/agent/config.yml`): `default/smol/vision = basalt/flash-next`, `advisor = basalt/hy4-flash`, `plan/slow/web = basalt/deepseek`. `~/.omp/agent/models.yml` `basalt` provider already declares `hy4-flash`, `deepseek`, `flash-next` on `http://127.0.0.1:18014/v1`. The router advertises **only the loaded id**; a completion naming `deepseek` while flash-next is resident is `404 model_not_found`. Guest packs exist in `/etc/fade/supervisor.yaml` (`deepseek`, `hy4-flash`) and swap by tearing the resident pack down then spawning.

### Root cause A — think lane collapsed onto the coder pack

`src/router.ts` reads at **import**:

```ts
export const THINK_LANE = process.env.FADE_ORCHESTRATE_THINK_LANE ?? "deepseek";
export const CODE_LANE  = process.env.FADE_ORCHESTRATE_CODE_LANE  ?? "flash-next";
```

`~/.config/inference-keys.env` (sourced from `.bashrc` with `set -a`) still has the single-lane poison:

```
export FADE_ORCHESTRATE_THINK_LANE="flash-next"
```

`.bashrc` later sets `FADE_ORCHESTRATE_THINK_LANE=deepseek`, but every **live OMP process** was launched with the keys file: pid `2705644` `omp`, worker daemons, this box’s grok children all have `FADE_ORCHESTRATE_THINK_LANE=flash-next`. `test/env.mjs` already documents this: *“this box runs FADE_ORCHESTRATE_THINK_LANE=flash-next for single-lane mode”*. README line 210 names the exact failure: a session launched with think=`flash-next` re-loads that entry at every `fade_phase` boundary.

`/orchestrate <goal>` in `src/index.ts` then `loadLane(THINK_LANE)` + `setModel(PROVIDER/THINK_LANE)`. When THINK_LANE === CODE_LANE === flash-next, residency short-circuits, **no swap**, planning runs on flash-next. That is the grade-forge run.

`hy4-flash` is never a plugin lane. Pack maps exist in `src/supervisor.ts` (`hy4` → `hy4-flash`). The plugin only has THINK_LANE and CODE_LANE. Verification uses THINK_LANE. OMP `advisor` is hy4-flash and is never `setModel`/`loadLane`’d.

### Root cause B — start does not prove the guest id the way `/lane` does

`moveLane` (`src/router.ts`) waits until supervisor `RESIDENT pack=target` **and** `GET /v1/models` serves that id. `/orchestrate` start calls `loadLane` (admit is not loaded) then a one-shot census that **skips the check on `census.error`**. Auto-sync on `before_agent_start` (`src/index.ts`, commit `bdc6fd6`) does `getResidency` and `setModel` to **whatever pack is currently resident**. If the swap is still draining, that snaps the session back to `flash-next` and the first completion never names the guest.

Supervisor `POST /v1/resolve` **absorbs** a non-resident model into the resident pack (`rules.Resolve`, `RuleResidentFallback`, test `TestResolveAbsorbsDeepseekWithZeroSwap`). Resolve is not Swap. The plugin must `POST /v1/swap` at a phase boundary under a prod lease, then prove the served id. Never treat resolve/ROUTED as “deepseek is running”.

### Required behavior

Lanes (basalt provider, pack key = OMP model id):

| Role | Pack | When |
|---|---|---|
| plan / think | `deepseek` | `/orchestrate` start, planning, `fade_phase` planning_* |
| advisor / verify | `hy4-flash` | verification (`actVerify`, `verifyTrigger`, verifying state, report/review) |
| code | `flash-next` | coding / repair |

Rules:

1. **Refuse think-lane collapse.** If `FADE_ORCHESTRATE_THINK_LANE` is unset, empty, or equal to `CODE_LANE`, THINK_LANE is `deepseek`. Log/notify once that the env was ignored. Same for a verify/advisor lane: default `hy4-flash`, never flash-next. Tests in `test/env.mjs` currently *delete* the env so defaults win; add a test that **sets** `FADE_ORCHESTRATE_THINK_LANE=flash-next` and still resolves think=`deepseek`.
2. **Start path = `moveLane` proof.** After acquire, wait until supervisor pack === think lane **and** `servedIdentity().id` === think lane. Census error is not a skip. If the swap is refused, fail the start with the supervisor rule in the notify; do not silently plan on flash-next.
3. **Auto-sync follows the run’s owed lane**, not a stale resident pack. `before_agent_start` must not undo a think/verify pin because flash-next is still draining. If a run is live, target is `run.lane` / `pending.lane`. If no run, following residency is fine.
4. **Verification moves to hy4-flash**, coding back to flash-next, planning stays on deepseek until `planning_done`. `THINKING` map: deepseek/hy4-flash `high`, flash-next `low`.
5. `PROVIDER` default is already `basalt` (needed so `modelRegistry.find("basalt", "deepseek")` resolves). Keep it. `strata-flash` only names flash-next.
6. Do not edit `~/.config/inference-keys.env` as the fix. The plugin must be correct when that file still exports think=`flash-next`. You may note it in README.

---

## 2. Symptom: Alt+F overlay freezes the harness; hard kill required

Chord is **Alt+F** (`ESC f` / `\x1bf`), claimed in `onTerminalInput`. Host table binds `alt+f` to `tui.editor.cursorWordRight`; registration is refused; the raw listener consumes the bytes. Fallback `alt+shift+i`. `/orchestrate overlay` is the RPC path.

`node_modules/@mariozechner/pi-tui/dist/tui.js` `handleInput`: input listeners run first; if they `{consume:true}` the overlay never sees the byte. While the overlay is focused, **Ctrl+C is given to the component**, not SIGINT. If `done()` is never called, the session is trapped.

`src/panel.ts` previously closed only on `isEscape` (legacy `\x1b`, a subset of CSI-u ESC, modifyOtherKeys ESC) plus `q` and `\x03`. That misses:

- Kitty/wezterm/ghostty **Ctrl+C** as `\x1b[99;5u` (and modifyOtherKeys `\x1b[27;5;99~`)
- **Alt+F** while open as `\x1bf` or `\x1b[102;3u` (listener returns undefined when `panelOpen`, so the overlay receives the chord and ignored it)
- Ctrl+D `\x04` / `\x1b[100;5u`

Partial work already in `src/panel.ts`: `isClose()`, Kitty/MOK encodings for Esc/q/Ctrl+C/Ctrl+D/Alt+F, `dispose()` before `done()`, key bar `[esc/q/Alt+F] close`. Finish it:

1. Export `isClose` and test every encoding in `test/panel.test.mjs` (mirror the existing `isEscape` table). Include `\x1bf`, `\x1b[102;3u`, `\x1b[99;5u`, `\x1b[27;5;99~`, `q`, `\x03`. Releases (`:3u`) must not close.
2. Alt+F is a **toggle**: open via the listener; same chord on the focused panel calls `done({key:"close"})`.
3. `dispose()` the refresh timer **before** `done()`, and keep `dispose()` idempotent. An undisposed `setInterval` holds `node --test` and a live host.
4. `openPanel` must not hang forever on `provider()`: bound the first fetch (a few seconds). On timeout, still mount with last-known/empty screen plus a missing-row, or notify and return so `panelOpen` is cleared by `openPanelGuarded`’s `finally`. A hung `fetchMetrics` with `panelOpen=true` and `custom()` never mounted is a second trap.
5. Do not import `@mariozechner/pi-tui` from the extension (OMP loads `src/index.ts` directly; pi-tui is not a declared dependency). Keep local CSI-u parsing.
6. `test/pty_rig.mjs` already measures keystroke freeze. If you touch overlay open/close, keep that bound green.

---

## 3. Symptom: VRAM “floor” refuses a swap while the current pack is still resident

Operator: the next pack loads fine; the current pack must be unloaded first; **do not want a pre-unload VRAM floor**.

Plugin `serveVerdict` (`src/router.ts`) had `free < VRAM_MIN_FREE_MIB` as a refusal. README table still says default `8192`. Code default was already `0`, but `test/load_hostile.mjs` sets `4096` and asserts `low_vram` (1200 MiB) is refused. That is the feature. **Remove it.**

Partial work: the `< VRAM_MIN_FREE_MIB` branch is gone; comments say the env is retired and unread by the verdict. Finish:

1. Keep refusing **dead** context only: unreachable, non-ok status/state, `loading: true`, `vram <= 0`, loaded-with-no-model.
2. A **low positive** free reading (flash-next still mapped, GPU0 ~701 MiB live) **must serve**. `test/load_hostile.mjs`: drop `low_vram` from `HOSTILE`; assert `serveVerdict(HEALTH.low_vram).serve === true` even with `FADE_ORCHESTRATE_VRAM_MIN_FREE_MIB=4096`. Keep `zero_vram` / `negative_vram` as refuse.
3. README configuration table: `FADE_ORCHESTRATE_VRAM_MIN_FREE_MIB` is retired, ignored, swap unloads first. Align FEATURES.md / OVERLAY.md if they still sell the floor.
4. Supervisor `AdmitVRAMFloorMiB=8192` in `/home/rwest/projects/fade-supervisor` is **post-teardown** (`AdmitSpawn` after the old process group is gone; `AdmitSwap` does not gate VRAM). Do **not** change fade-supervisor unless a plugin test proves the daemon is refusing **before** unload. This ticket is the plugin pre-unload lever.

---

## Tests and docs

- `npm test` (build + `test/*.test.mjs`)
- `npm run typecheck`
- `node test/load_hostile.mjs`
- panel close encodings in `test/panel.test.mjs`
- new identity test: env `THINK_LANE=flash-next` still yields think=`deepseek`, verify=`hy4-flash`, code=`flash-next`
- start/preflight test: `loadLane`/`moveLane` stub that admits but serves flash-next until polled must **not** send a planning briefing until served id is the think pack (or must fail loud)
- auto-sync test: resident flash-next + run.lane deepseek must **not** `setModel(flash-next)`
- Update README env table (THINK_LANE poison, retired VRAM floor, hy4-flash verify lane)
- Do not commit secrets. Do not push. Conventional commits if you commit: one concern per commit (overlay close, floor retirement, lane identity).

## Done when

1. A new `/orchestrate` with `FADE_ORCHESTRATE_THINK_LANE=flash-next` in the process env still plans on `deepseek` (swap + `setModel(basalt/deepseek)` + briefing only after the router id is `deepseek`).
2. Verification uses `hy4-flash`; coding uses `flash-next`.
3. Alt+F opens the overlay; Esc, q, Ctrl+C (legacy and CSI-u), and Alt+F close it; `dispose()` runs; no hard kill.
4. Low positive free VRAM never blocks a load; zero/dead CUDA still does.
5. Live GPU is untouched by the suite.

That is the whole job: guest packs actually load, Alt+F can be left, and the pre-unload VRAM floor is gone.
