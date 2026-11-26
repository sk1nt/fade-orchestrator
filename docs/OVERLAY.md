# The status line and the Alt+F screen

Placement, content, and the measurements behind each choice. Every statement below is implemented
in `src/ui.ts` (the line), `src/panel.ts` (the screen), `src/screendata.ts` (its data contract) and
`src/index.ts` (the wiring); each section names the file that proves it.

## The one status line

One line, docked on the host's **top widget** (`setWidget(TOP_WIDGET_KEY, lines, { placement:
"aboveEditor" })`), present only while a run is live:

```
󰚩 Orchestrator: code R1/6 · T2/5 · [Alt+F]
```

- `<glyph>` is a Nerd Font private-use codepoint, overridable with `FADE_ORCHESTRATE_GLYPH`
  (an empty value drops it and the space, for a terminal without the font).
- the state is the short form (`plan` `code` `ver` `fix` `done` `fail` `stop` `stall`);
- `T<passed>/<total>` counts the run's own tasks;
- `· protocol <n>/3` rides while the Tier-1 protocol counter runs, `· paused` while the loop is
  parked, and a tok/s suffix rides when the router reports a decode rate;
- while a lane is **loading**, the state segment is replaced by the switch, and the row turns
  **multicolored** — a per-character hue ramp (`ramp()` in `src/ui.ts`) whose phase rides the load
  percent, so each /health sample repaints a moving row. Color means *working*: the steady line
  ships no escape codes. The incoming model is named exactly once, abbreviated:
  `󰚩 Orchestrator: <switch icon> switching deepseek→flash-next (IQ3_S, dual) 47% · [Alt+F]`. The
  switch icon is a second private-use codepoint (U+F051F), overridable with
  `FADE_ORCHESTRATE_SWITCH_GLYPH`; an empty value removes it and its space;
- a lane flip the guard saw adds a second line naming the competing entries. Past
  `FADE_ORCHESTRATE_FLIP_BREAKER_AT` flips in the window the loop stops paying: no `setModel`, no
  `POST /v1/load`, the run pauses with the flips, the window and the competing entry in its operator
  note, and `/orchestrate lanes reset` clears this process's ledger and lands the owed lane
  (`test/gate_rig.mjs` drives both sides).

The line **clears** — the widget is removed, not blanked — when there is no run, when the run is
terminal (`complete` / `failed` / `stopped`, including a run adopted from disk at `session_start`),
and when this session does not own the run. `statusLines()` in `src/ui.ts` is the single place that
rule lives; a steady line carries **no model name** (the host's own model segment is the model's
surface, and printing it twice names the model twice).

**The naming rule.** `modelLabel()` compacts a registry display name to
`<model> (<QUANT>, <GPU count>)` — `flash-next (IQ3_S, dual)`, `deepseek (IQ1_M, dual)`. Version,
family word and the RAM/SSD tier are dropped: the quant and the GPU count are the two facts that
change the loop's economics (decode rate, spill, swap cost), and the row is 100 columns wide. The
name then rides in **one place per surface**: on the panel it is the engine column's `resident` row,
named by `nameResidentRow()` in `src/screendata.ts`; on the status line it appears **only while a
lane is loading**, as the subject of the switch (`switching deepseek→flash-next (IQ3_S, dual) 47%`),
and the steady line names no model at all — so a surface never repeats the name, and the transient
row and the durable engine column are different surfaces. The panel's lane line carries the lane
KEYS with the `◆resident` marker. A name carrying no quant and no GPU count passes its base segment
through, so an unknown model is never masked.

`FADE_ORCHESTRATE_SURFACE=status` opts into the host's status-bar surface (`setStatus`) instead of
the top widget. The default ships the widget: the footer row is the host's own surface.

**The row names the chord it honors.** The key hint is `keyLabel(chordHeld ? FALLBACK_KEY :
FADE_KEY)` (`src/index.ts`): the configured chord when the host's probe reports it FREE, the
fallback chord when the host holds the configured one. An earlier build printed `[Ctrl+O]` in the
held state: the row named a chord that opened nothing while the pty rig's assertion in that same
state read "ctrl+o opens nothing" — the row and the key disagreeing on one screen. The pty rig now
asserts the label in BOTH states (`[Alt+F]` delivered, `[Alt+Shift+I]` held), and `statusLines()`
defaults to the delivered chord, never to `Ctrl+O`.

**`/orchestrate status` is the line this row answers.** It prints the run id, state, lane, round,
task count, phase count, the router claim with its age, and the swap cost the run paid — `swaps 3 ·
41.2s paid`, summed by `summarizeSwaps` over the `swap_history.json` rows stamped with this run's
`run_id`. A run that paid no swap prints `0 swaps`, never a `0s` that reads as a measured zero.
`/orchestrate runs` reads the shelf a start writes: `<dir>/runs/<run_id>.json` for each finished
run, newest first, five lines. `state.json` is one slot, so a start archives the TERMINAL run it is
about to overwrite and leaves a run that is not terminal untouched.

## The panel's key: `alt+f` at the raw-input layer, the fallback, the escape encodings

The key was chosen by two measurements; the first was insufficient.

**`ctrl+o` is out.** The host owns it as the built-in action **`app.tools.expand`**, and a built-in
binding is not merely skipped at registration — the host **acts on it**. Measured in a real 150×45
terminal: sending `C-o` printed `Tool output expansion: enabled` and the extension's
`onTerminalInput` listener never received `0x0f`; registering the chord is refused with
`Extension shortcut conflicts with built-in shortcut`.

**`alt+f` is DELIVERED, at the raw-input layer.** A strings-extracted copy of the host's
default-key table (38 actions) does not list `alt+f`. The host's runtime answers differently:
`getShortcutConflict("alt+f")` → `keybinding tui.editor.cursorWordRight` — the host **binds** it, so
`registerShortcut("alt+f")` is **refused**. The chord is therefore claimed at the byte level:
`ctx.ui.onTerminalInput` consumes `ESC f` (`1b 66`) before the host's binding acts, and the pty rig
proves BOTH halves — the panel opens, and the host's word-move does not run. (The rig's first
measurement: `ESC f` moved the cursor word and opened nothing.) The strings table is a copy; the
host's probe is the authority. When the host holds a chord, the extension takes the byte and never
moves the host's binding.

**The key is `alt+f`** (ESC + `f`) and `alt+shift+i` (ESC + `I`) is the registered fallback,
probe-reported FREE. `alt+<letter>` is **byte-distinct** from every control code;
`ctrl+shift+<letter>` is NOT a distinct keystroke — shift is invisible inside a control code,
measured in the pty rig, where a ctrl+shift+t keystroke ran the host's `ctrl+t` action and the pane
answered `Thinking blocks: visible`. (tmux's `M-f` is exactly `1b 66`, the chord's own two bytes;
the rigs send `-H 1b 66`, measured to land as one 2-byte read.) The single-alt chords the measured
table leaves free are `alt+c/e/j/q/s/t/u/v/w/x/z` — `FADE_ORCHESTRATE_KEY` accepts any of them. The
extension moves **no** host binding, writes no config file, and leaves `ctrl+o` to the host.

The login says **at most one line, and it is about the run**. A delivered chord is never explained:
the row above the editor names the key every round, `/orchestrate status` answers the run, and this
file carries the contract. With no run the login says nothing at all:

```
orchestrate: run 20261116T022111Z-hbdy is coding — /orchestrate handover sends the condensed state
```

Only a chord that cannot work adds a clause. With `FADE_ORCHESTRATE_KEY` pointed at a chord the host
holds and cannot deliver (a control code is the host's alone), the same single line names the
conflict, the fallback and the variable, so a colliding configuration is visible and not a dead key:

```
orchestrate: the host binds Ctrl+O (reserved): the screen opens on Alt+Shift+I
(FADE_ORCHESTRATE_KEY picks a chord the probe reports FREE) · run … is coding …
```

`pi.getShortcutConflict(chord)` is **not callable from a hook that can run**: omp 18.20.2's
loading-phase proxy throws for it (and for `setModel`/`getActiveTools`/…), `session_start` fires
inside that window, and an idle TUI session (the pty rig) never fires `agent_start` to retry on. So
that one verdict is reached in two tiers: `probeHasAnswered` separates "threw" from "free"; the
probe's answer is the authority when it answers, and when it never answers the extension's copy of
the host's chord table (`HOST_HELD_CHORDS`) decides. A control chord neither source names stays
unannounced — the extension never reports a conflict that no source reported.

The login line is **deferred 500 ms**, not fired inline: the FIRST notify of a session is swallowed by
the host's TUI attach (measured in the pty rig — a notify fired inline at `session_start` never
reached the scrollback, while the notify ~20 lines later in the same hook rendered every time).
The one-shot flags are set synchronously, so the deferral cannot double-print, and the rig reads it
from the scrollback with a bounded wait rather than one snapshot at the row.

The pty rig proves both states in an isolated agent dir (every entry of `~/.omp/agent` symlinked
except `keybindings.*`, so the user's own keybinding config cannot leak in) and on a **private tmux
server** (`-L fade-pty-<pid>`): two rigs against `/tmp/tmux-1000/default` kill each other, measured
— one rig's cleanup took the shared server, the other's session died mid-run at `send-keys` and its
log opened with `no server running`. A per-rig session name does not isolate; the **server** is shared.

- **DEFAULT** — nothing configured: the host's table BINDS `alt+f`, so the login says the adopted
  run and nothing about the key; the row names `Alt+F` and the docs carry the contract.
  `ESC f` opens the panel; `ctrl+o` opens **nothing** —
  the extension never takes the host's chord. Which action the host runs there is the host's (this
  build's pane hint names `Ctrl+⇧O`), so the rig asserts only what the extension controls and keeps
  the toggle count as an observation.
- **HELD** — `FADE_ORCHESTRATE_KEY=ctrl+o`: the ONE login line names the conflict, the fallback and the
  variable, riding on the adopted run's own line; `C-o` opens no screen; `ESC I` (alt+shift+i) opens the panel.

Run 1 runs on the host's own config and asserts the `ESC f` bytes reach the extension (the host prints
no `Tool output expansion:` for them), that the panel opens, that it is bounded by the terminal width,
that its clock moves on the refresh tick while open, that ESC closes in **both** encodings, that
`q` closes, that the chord closes an OPEN panel and re-opens it after any close (the toggle), and
that `halt` clears the row.

The wiring is:

- `pi.registerShortcut(FADE_KEY)` is attempted first, so the HOST parses the chord wherever it can;
  for `alt+f` the host's table holds it and the registration is **refused** — that refusal is why
  the fallback chord is the one registered, and the fake-host rig models it, so a "not registered"
  assertion in `test/gate_rig.mjs` checks a real refusal and not a tautology;
- `ctx.ui.onTerminalInput(handler)` receives `ESC f`, returns `{ consume: true }` and opens the
  screen; every other keystroke returns `undefined`, so an unrelated key is never swallowed. Both
  routes go through the same guarded open, so one keystroke yields one panel;
- `alt+shift+i` is the registered fallback chord, in the table the host accepts, and is the key that
  opens the screen when the configured chord collides;
- `/orchestrate overlay` is the command path, and the only path that works over RPC (RPC frames
  carry no raw keystrokes).

**Closing the screen is a parse, not a byte.** The host hands the focused component RAW bytes
(`pi-tui`'s input dispatch calls `focusedComponent.handleInput(data)`), and its own escape matcher
(`matchesKey(data, "escape")`, built on `matchesKittySequence` and `matchesModifyOtherKeys`)
recognizes three forms: the legacy `\x1b`, the Kitty keyboard-protocol CSI-u
sequence (`\x1b[27u`, `\x1b[27;<mod>u`) and xterm's `modifyOtherKeys` (`\x1b[27;<mod>;27~`). The
panel compared only the legacy byte, so on a terminal that enables the Kitty protocol — kitty,
wezterm, ghostty, foot — ESC did nothing while `q` closed.
`isEscape()` in `src/panel.ts` matches all three and ignores the Kitty RELEASE form (`...:3u`) so
one press is one close. `isClose()` is the full set the overlay honors: `isEscape`, `q`/`Q`,
Ctrl+C and Ctrl+D **in every encoding** (the host focuses the overlay and hands IT Ctrl+C — a
matcher that only sees the legacy `\x03` traps the session with nothing left to press), and the
panel's own OPEN chord, in its raw and CSI-u spellings: the overlay is keystroke-owned, so the
chord that opened it closes it, and after any close the same chord re-opens it. ESC + any OTHER
letter stays the raw listener's and the host's — never close. `test/panel.test.mjs` drives the
whole encoding table through `isClose`/`handleInput`, including the moved chord
(`FADE_ORCHESTRATE_KEY=alt+shift+i` closes on `ESC I`, not on `ESC f`); the pty rig closes the
panel with the legacy Escape, the injected CSI-u sequence (`send-keys -H 1b 5b 32 37 75`), `q`,
and the chord, and re-opens it after each — tmux's `screen` terminal has no Kitty protocol and
cannot produce it unaided, which is exactly why the rig passed for weeks with ESC dead.

The keystroke can also never be **stranded**: the overlay flag is set before the panel's FIRST
read (the router plus the run's ledgers), and a provider that never answers used to leave the
flag set with no component mounted — no key closed a panel that was never drawn, and the chord
was dead for the session. `FADE_ORCHESTRATE_PANEL_FIRST_MS` (default 3 s) bounds that first read:
the open returns with a named warning, the guard's `finally` clears the flag, and the keystroke
retries (`test/panel.test.mjs`).

A delegated session (a subagent's own session file) binds **no extra** listener: one listener per
process, proved by `test/gate_rig.mjs` and `test/rpc_rig.mjs`. A delegated session is not inert: it
is a desk client. It calls `fade_verify`, which files a request in `<run>/verify/desk.json` and
blocks until a verdict is written by id — it never switches a lane, never pays a `POST /v1/load`,
and never renders a screen. [`docs/DELEGATION.md`](DELEGATION.md) is the authority for the desk and
for the churn route that answers a batch on a **non-router** model.

## The screen

`Alt+F` opens a near-full-screen overlay (96 % × 94 %, top-center) in the shape of the host's own
agents panel. In an RPC/print host the **same lines** go to the top widget at 110 columns, so the
headless rigs assert the delivered text.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ fade-orchestrator <run_id> · code · round 2/6 · tier hot · 14m02s · 12:14:02Z│
│ goal: …                                                                      │
│ lanes: deepseek=think · flash-next=code ◆resident                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ TASKS 2/5 passed                    │ ENGINE / ROUTER                        │
│ ▶ ✓ T1 wire the panel               │   engine      0.4.0                   │
│     files: …  acceptance: …         │   resident    deepseek (IQ1_M, dual)   │
│                                     │   router claim  this run (pid 4242)   │
│   · T2 …                            │   decode now  131 tok/s (queue 0, …)   │
│ PHASES                              │   prefix cache 82.3 % hit over …       │
│   R1 planning_done  deepseek 19:00  │   context     41.2k / 1.05M (3.9 %)    │
│                                     │   gate        RED 1/2 failing · 20:19  │
├──────────────────────────────────────────────────────────────────────────────┤
│ LANE SWAPS                                                                   │
│   deepseek → flash-next  14.2s · 91→130 tok/s · cold ramp · 12:10:00         │
│ LAST VERIFIER CRITIQUE / RECENT REJECTIONS / LANE FLIP / NOT MEASURED        │
├──────────────────────────────────────────────────────────────────────────────┤
│ [↑↓/j-k] select  [PgUp/PgDn] scroll  [s] skip selected  [v] verify         │
│ [r] reset  [p] pause  [c] code  [h] halt  [esc/q/Alt+F] close               │
└──────────────────────────────────────────────────────────────────────────────┘
```

Layout rules, all proved in `test/panel.test.mjs`:

- **Every row is flush with the frame** at 60, 100, 110 and 120 columns: content is padded to the
  inner width, so the right border is a line and not a ragged edge.
- **Two columns from 100 columns** (list + phase rail left, engine numbers right); below that the
  metrics stack under the list; a 40-column metrics column is not usable at that width.
- **The key bar never loses a key.** It is packed as items, so a narrow panel wraps between keys;
  a word wrap of the bar as prose split `[esc] close` across rows, which is how the close key
  disappeared from the 110-column surface.
- **The selected task carries its details** (files, deps, round, acceptance, result, checkpoint
  tag); every other task stays one line.
- **Scroll follows the selection, and only the selection.** `j`/`k` and the refresh tick bring the
  selected task on screen; `g`, `G`, `PgUp`, `PgDn` are the user moving the view, and a frame
  does not snap back under them.

## The metrics, and the rule about numbers

The engine column reads the router, the run's durable records and the host's context meter. The rule
is the ledger's, and it holds repo-wide: **an absent reading is named, never rendered as a zero.**

| row | source | named state when absent |
| --- | --- | --- |
| `engine` | `/metrics` `engine.version` — the router publishes **no quantization**: measured, `engine.quant` carries the *lane name*, so the row prints the version alone and the quant rides in the resident row's abbreviated label | `?` |
| `resident` | `/health?phase=display` `model` (the lane key; `loaded` is a **boolean** there) + the registry display name, abbreviated | `?` (and `pack (lane unnamed)` when a pack is resident with no name), and ` loading` while the swap runs |
| `router claim` | the claim file `<FADE_ORCHESTRATE_LOCK_DIR>/<router-slug>/orchestrator.lock`, read by `core.ts:readInstanceLock` on every refresh: who holds the router's lane-switching right now, and for how long (`started` in the file, through the screen's own clock) | `this run (pid N) · held 12h00m` when the run drawn on the screen owns it; `HELD BY pid N: run R in <repo> on <host> · held …` for a foreign owner — the same fields a refused start's notify names, because the screen is where the operator looks after that refusal, and the age is the "is this abandoned?" reading; `free — no run holds this router` when no claim file exists; `not measured` when the caller never read it (never a guessed `free`); an unparseable `started` prints no age |
| `expert slots`, spill | `engine.expert_slots`, `engine.spill` | `? · spill ?/?` |
| `decode now` | `live.tok_s`, `live.state`, queue | `idle` |
| `best recent` | `/metrics` `best.decode.tok_s` (the strongest rate the router publishes), else the per-request window | `no completed requests` |
| `prefix cache` | per-request `hit_rate`, `reused`, `ssd_share` | `no hit_rate reported` |
| MoE placement (`MoE <lane>`) | the serve config the **running router names in its own argv** (`--config`, from the `/proc` proof); `FADE_ORCHESTRATE_BASALT_CONFIG` overrides it (`moe.ts`). The row reads the config the engine serves, because a config it does not serve answers a question nobody asked: the live alias carries `expert-profile-save` and a stale prod alias does not | `unsupported (Flash-Next only; relearned per swap)`; `configured, NOT live · …` naming both config paths; `not configured (add expert-profile-save, reload lane)`; a profile older than the running engine says **PREDATES** |
| MoE balance (`MoE balance <lane>`) | the alias's `gpu` / `vram-reserve-mib` / `ram-reserve-mib`, and the resident engine's `spill` line for the file tier | `unknown · no health reading supplied …` for the non-resident lane; `balanced · gpu 0,1 · 2 devices · file tier UNMEASURED (router reported no spill line)` when the config proves the split and the router publishes no spill count |
| MoE drafter (`MoE drafter`) | the pack's own 64 KiB header (`BASALTMF` v2 section table, `moe.ts` `packDrafter`): `dspark/gguf` = DeepSeek's DSpark block drafter, `mtp/*` = Flash-Next's MTP drafter; plus the config's `spec` / `draft-experts`, an absent key named "engine default", never filled with a number | `deepseek DSpark 7.43 GiB pack · win ≤3 · 32/stage; flash-next MTP 0.77 GiB pack · spec engine-default · draft-experts default`; a pack with neither section reads `no drafter in pack`; an unreadable one `pack not read` — both named states |
| MoE class (`MoE class <cls>`) | `classWarmth` over the `swap_history.json` rows stamped `task_class` (`taskmoe.ts`): the swaps that class paid, and how many landed on a lane whose saved placement was live AND written by the running engine | `no swap ran this class` (dim) when the ledger names none; `0/3 warm · profile not named` for a class that ran cold every time; the verifier pack's class can never read warm (no save path), and that is the named state, not a green zero |
| `context` | the host's `getContextUsage()` | `no context meter` |
| `gate` | the run's last pre-swap gate | `no gate run this round`; a red gate prints every failing command under `  red` |
| turn rows | `metrics.jsonl`, one line per turn | `no turn telemetry (the router reported no pp/tg)` |
| swap rows | `swap_history.json` | `(no swaps recorded yet)` + a `NOT MEASURED` entry |
| `swaps this run` | `summarizeSwaps` over `swap_history.json` rows whose `run_id` is this run's | `0 · no swaps measured` when the ledger is empty; `0 · older runs only` when every row predates this run — a cost is never charged to a run that paid none, and never read off another run's rows |

**The fixture speaks the measured payload, not an invented one.** basalt 0.4.0 nests the tier fields
under `engine`, answers `/health` `loaded` as a boolean with the lane under `model`, leaves
`live.tok_s` null at idle and publishes NO `model` field per request. The rig's stub router used a
flat payload with `loaded: <lane key>` — a contract the live router never answered — and that is how
a crash on the real payload passed the rig: the reader took `true` for a lane name, the renderer
threw on `name.indexOf`, and the panel opened nothing on the real host. The stub now mirrors the capture
field for field, and the panel asserts the numbers that capture contains.

An unpredicted router shape does not close the panel: every router field is type-guarded on the way
in (`laneKey`, `typeof … === "number"`), and `nameResidentRow` returns the rows unchanged when the
resident fact is not a lane key.

Router unreachability has a row of its own: `router http://127.0.0.1:18014 unreachable — engine,
decode and queue are not measured`. A dead wire renders the named absent state and never a zero: the
absent-reading rule covers the wire itself.

## Keys

| key | action |
| --- | --- |
| `↑` `↓` `j` `k` | move the selection (clamped to the task list) |
| `PgUp` `PgDn` `g` `G` | scroll the view by a page, jump to the top, jump to the end |
| `s` | skip the selected task |
| `v` | verify now |
| `r` | reset the round |
| `p` | pause / resume |
| `c` | code (load the code lane) |
| `h` | halt the run |
| `esc` `q` `ctrl+c` `ctrl+d` `Alt+F` | close, touching no loop control — `esc` in every encoding the host delivers (see above), Ctrl+C/D in every encoding too, and the OPEN chord: the panel is keystroke-owned, so the chord toggles, and after any close the same chord re-opens it |

The bar **wraps**; it never clips. It is 129 visible columns, so on the 110-column default surface
a single-line bar loses its tail — that is how `[esc] close` once vanished from the screen.
`wrapText()` in `src/panel.ts` folds it onto as many rows as the width needs, at every width the
panel supports.

The panel is **live**: it re-reads on a 2 s tick (`FADE_ORCHESTRATE_PANEL_REFRESH_MS`, floor 500 ms)
and calls `tui.requestRender()`, so the numbers move between repaints. The tick is `unref`'d and
`dispose()` clears it — a closed panel never polls the router again, and an open one never holds
the process open.

## Redaction

`FADE_ORCHESTRATE_REDACT=1` — or `/orchestrate --demo-redact`, put back with `--demo-redact=off` —
strips the repo path, the OS account, `/home/<someone>`, `~` and this machine's hostname from
**every** rendered line, so a screenshot is safe to paste. **Display-only**: `state.json`,
`metrics.jsonl` and `swap_history.json` keep the values verbatim, and a fresh session starts
unredacted. Off by default: the screen shows the unmodified record.

## The pre-swap gate runs off the event loop

The gate runs the plan's own checks, and a check is an arbitrary command. The synchronous form
(`execFileSync`, 120 s per row, rows run back to back) held the event loop for the gate's whole
duration: the TUI stopped painting, keystrokes went dead and the swap watch's polls starved — a
`npm test` row froze the session, the class reported as freezing. Each row is
now a child process awaited off the loop (`execFile`), and the gate is bounded TWICE: 120 s for one
row, and a **total budget** across every check (`FADE_ORCHESTRATE_GATE_TOTAL_BUDGET_MS`, default
600 s). A row that starts with the budget spent is never spawned and lands as `NOT RUN … unmeasured`,
so a red gate names which checks were measured and which were not — the absent-reading rule, applied
to the gate. The gate's row count never shrinks silently. The row that is RUNNING is named as it
starts (`fade_orchestrate: gate 2/5: npm test` on the working message) and the verdict prints with its cost
(`fade_orchestrate: gate RED 1/5 in 41.2s — npm test`). Proved by `test/core.test.mjs` (a 300 ms row
leaves a 20 ms timer ticking, where the synchronous form measured zero ticks; the budget kills a hung
row in ~1 s and marks the rows behind it) and `test/gate_rig.mjs` (the working message names the row,
and the login emits one line).

## Proof surface

| file | what it proves |
| --- | --- |
| `test/panel.test.mjs` | the renderer: fits 40→120 columns, flush frame, the key bar keeps every key, selection details, scroll rules, live tick, both open surfaces, and **every ESC encoding** closing (`\x1b`, `\x1b[27u`, `\x1b[27;1u`, `\x1b[27;1;27~`; the release form and ESC+modifier NOT closing; `q` closing) |
| `test/panel_data.test.mjs` (guard) | a run state written mid-plan can lack `phases`; the screen reads it as no critique and renders — measured as a throw in the rpc rig (`undefined is not an object (evaluating 'src.run.phases.length')`), which turned the panel into an error notify |
| `test/panel_data.test.mjs` | the data contract: rows from a real-shaped `/metrics` snapshot, the named-absent states, the abbreviated model named once, and the **claim row's four states** (this run / a named foreign holder / free / not measured), including the dead-router case, where the tier set is exactly the router's own line plus an unread claim — never a fabricated engine row, never a guessed `free` |
| `test/core.test.mjs` | the deterministic layer: plan parsing and tiers, the protocol classifier, the gate's **off-event-loop** form (a 300 ms row leaves a 20 ms timer ticking; the synchronous form measured zero ticks), the total budget killing a hung row and marking the rows behind it, a re-declared accepted state refreshing, and the **single-instance lock** (free → acquired; a live foreign holder refuses and reclaims a stale one; the holder's own re-acquire succeeds; owner-less → take; a corrupt owner → take; releasing the fd closes the claim) |
| the **router claim** (`test/core.test.mjs`, `test/gate_rig.mjs`, `test/panel_data.test.mjs`) | the claim's directory is keyed on the **router**, not the checkout (so two checkouts of one router meet at one file), and `FADE_ORCHESTRATE_LOCK_DIR` moves the whole plane; a claim held by a live foreign pid refuses a start — naming pid, run, repo and host — with **zero** `POST /v1/load` and **no** state written, because the claim is taken before the pack load; a free router is claimed at the start, naming this pid, run and repo; `stop` releases it, and a release is not undone by a state write still in flight; the **screen** carries the same fields, so the notify that refused a start and the row the operator reads next agree |
| `test/moe.test.mjs` | the MoE placement contract: the config parse and the per-lane profile table (cold/warm/unknown), the **drafter row** (a v2 pack header is built byte-for-byte: `dspark/gguf` names DSpark with its GiB and the config's `spec`/`draft-experts`; `mtp/*` names MTP with an unset spec said as engine-default; neither section, and an unreadable pack, are named states), the **GPU-balance verdict** (both engines on one GPU, including one with no `gpu` field, names it; profiles spread over ≥ 2 GPUs is `balanced`; a single-GPU router is `single-gpu`), and the engine-proof **cache** (one `/proc` walk per TTL, `engineProofRefresh` forces one, a lane load's `engineProofInvalidate` forces the next) |
| `test/ui_status.test.mjs` | the status line: the row's grammar, the terminal/no-run clear rule, the swap pill, the flip line, the chord bytes (`ESC f` is the delivered chord, `ESC I` the fallback, and why `ctrl+shift+<letter>` has no byte form), the key label, the row's key hint, and the **switch row's glyph** (`FADE_ORCHESTRATE_SWITCH_GLYPH` in front of the incoming model; an empty value drops it and its space, and the glyph never rides the steady line) |
| `test/gate_rig.mjs` | the whole protocol against a fake host and a stub router: the row is docked `aboveEditor`, no status-bar row ships by default, the host's table **refuses** the `alt+f` registration and the `ESC f` raw listener consumes and opens, the fallback chord is the one registered, a RED gate issues zero `POST /v1/load`, the fast path pays zero loads and its threshold pays one swap, `--demo-redact` masks the panel and leaves `state.json` verbatim, a terminal run clears the row, **the gate runs off the event loop** (a 300 ms row leaves the rig's 20 ms timer ticking) and names the row on the working message, a login emits **one** line naming only the run, N rapid switches pay **one** `POST /v1/load` and the pill/lane/briefing of a superseded switch never land, past the breaker a switch pays **zero** loads and pauses the run, and `/orchestrate lanes reset` clears the ledger and lands the owed lane in exactly one load |
| `test/load_hostile.mjs` | the pre-unload gate against a hostile `/health`: an `error` state, a `cuda_fatal` state, zero VRAM, VRAM under the floor, a negative nested reading, a loaded context naming no model, and a swap in flight each issue **zero** `POST /v1/load` with the class named; the measured healthy line loads exactly once; a closed server is refused as `unreachable` |
| `test/pty_rig.mjs` | the real terminal: tmux + the `omp` binary + the live extension, the row on screen, the `ESC f` bytes (`-H 1b 66`, measured as one 2-byte read) opening the panel, the keys, the legacy Escape **and** the injected Kitty CSI-u escape closing, halt clearing, both chord states (DEFAULT: the **one** login line names only the run — no chord, no fallback, no env var — sliced from the pane GRID between the notify's own start and the widget's `Orchestrator:` marker, because the row's contract is to advertise `· [Alt+F]` and a pane-wide grep reads that hint as login text; HELD: that line names the conflict, the fallback and the way to move the key, and `ESC I` opens while `ctrl+o` stays the host's), and the **keystroke latency** in the two states that matter: one editor keystroke into the idle prompt, and `ESC f` pressed while the command handler, the metrics sampler and the panel tick are already in flight — measured against a 500 ms bound and printed pass or fail (this box, four runs: 6-15 ms idle, 25-30 ms busy) (`FADE_ORCHESTRATE_LIVE_SMOKE=1`) |
| `test/rpc_rig.mjs` | the headless surface through `omp --mode rpc`: the row's pill (`[Alt+F]`), the overlay's panel frames, the redaction-OFF half (the seeded file name rides unmasked), skip/halt persistence, the clear on halt |

**The fake host cannot see the loading-phase guard.** omp's extension runtime answers
`getActiveTools`, `setModel`, `getShortcutConflict` and friends with
`Extension runtime not initialized. Action methods cannot be called during extension loading.`
while the extension is loading, and the host dispatches `session_start` inside that window; an
uncaught throw there does not print a stack — it **disables the extension**, so every downstream
assertion fails behind `Failed to load extension`. The gate rig's host defines those methods, so it
passes while the real host rejects the same code. That class is proved only by the live rigs
(`pty_rig`, `rpc_rig`) and, in the field, by the extension loading; the wiring swallows the
probe (`shortcutConflict`) and defers the phase-tool activation to `agent_start`, where the runtime
is live.
