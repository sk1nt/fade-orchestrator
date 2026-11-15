# The status line and the Alt+Shift+F screen

What the operator sees, where it is placed, and why it is placed there. Every statement below is
implemented in `src/ui.ts` (the line), `src/panel.ts` (the screen), `src/screendata.ts` (its data
contract) and `src/index.ts` (the wiring), and each section names the file that proves it.

## The one status line

One line, docked on the host's **top widget** (`setWidget(TOP_WIDGET_KEY, lines, { placement:
"aboveEditor" })`), present only while a run is live:

```
󰚩 Orchestrator: code R1/6 · T2/5 · [Alt+Shift+F]
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
  `󰚩 Orchestrator: switching deepseek→flash-next (IQ3_S, dual) 47% · [Alt+Shift+F]`;
- a lane flip the guard saw adds a second line naming the competing entries.

The line **clears** — the widget is removed, not blanked — when there is no run, when the run is
terminal (`complete` / `failed` / `stopped`, including a run adopted from disk at `session_start`),
and when this session does not own the run. `statusLines()` in `src/ui.ts` is the single place that
rule lives; a steady line carries **no model name** (the host's own model segment is the model's
surface, and printing it twice names the model twice).

**The naming rule.** `modelLabel()` compacts a registry display name to
`<model> (<QUANT>, <GPU count>)` — `flash-next (IQ3_S, dual)`, `deepseek (IQ1_M, dual)`. Version,
family word and the RAM/SSD tier are dropped: the quant and the GPU count are the two facts that
change the loop's economics (decode rate, spill, swap cost), and the row is 100 columns wide. The
name then rides in **exactly one place on the screen** — the engine column's `resident` row, named
by `nameResidentRow()` in `src/screendata.ts`. The panel's lane line carries the lane KEYS with the
`◆resident` marker, and the status line names no model. A name carrying no quant and no GPU count
passes its base segment through, so an unknown model is never masked.

`FADE_ORCHESTRATE_SURFACE=status` opts into the host's status-bar surface (`setStatus`) instead of
the top widget. The default ships the widget: the footer row is the host's and the operator retired
the pill there.

## The panel's key: `alt+shift+f`, the listener, the fallback

The key was chosen by measurement, twice, because the first measurement was not enough.

**`ctrl+o` is out.** The host owns it as the built-in action **`app.tools.expand`**, and a built-in
binding is not merely skipped at registration — the host **acts on it**. Measured in a real 150×45
terminal (2026-11-15): sending `C-o` printed `Tool output expansion: enabled` and the extension's
`onTerminalInput` listener never received `0x0f`; registering the chord is refused with
`Extension shortcut conflicts with built-in shortcut`.

**`alt+f` is out, and that is the instructive one.** A strings-extracted copy of the host's
default-key table (38 actions) does not list `alt+f`, and it looked free. The host's own runtime
answers differently: `getShortcutConflict("alt+f")` → `keybinding tui.editor.cursorWordRight`. The
pty rig then watched `ESC f` move the cursor word in a real terminal and open nothing. The
strings table is a copy; the host's probe is the authority — a chord must be probed at runtime.

**The key is `alt+shift+f`** (ESC + `F`), which the probe answers **FREE**, and `alt+shift+i`
(ESC + `I`) is the registered fallback, also FREE. `alt+<letter>` is **byte-distinct** from every
control code; `ctrl+shift+<letter>` is NOT a distinct keystroke — shift is invisible inside a control
code, measured in the pty rig, where a ctrl+shift+t keystroke ran the host's `ctrl+t` action and the
pane answered `Thinking blocks: visible`. (tmux's `M-S-f` is `1b 66` — ESC + lowercase — never ESC +
`F`; the rigs send `-H 1b 46`, measured to land as one 2-byte read.) The extension moves **no** host
binding, writes no config file, and leaves `ctrl+o` to the host.

The chord's state is disclosed once per session, at the first hook that can answer, in the
extension's own words:

```
orchestrate: Alt+Shift+F opens the orchestration screen; Alt+Shift+I is the registered
fallback and /orchestrate overlay is the command path
```

and when `FADE_ORCHESTRATE_KEY` is pointed at a chord the host holds, the disclosure says so, names
the fallback and names the variable, so a colliding configuration is visible rather than a dead key:

```
orchestrate: Ctrl+O is held by the host (reserved) — the screen opens on Alt+Shift+I.
Point FADE_ORCHESTRATE_KEY at a chord the host's conflict probe reports FREE; the host
holds alt+a/b/d/f/g/h/i/k/l/m/n/o/p/r/y, alt+shift+c/k/l/p/v and ctrl+c/d/g/l/o/r/s/t/y/z
```

`pi.getShortcutConflict(chord)` is **not callable from a hook that can run**: omp 18.20.2's
loading-phase proxy throws for it (and for `setModel`/`getActiveTools`/…), `session_start` fires
inside that window, and an idle TUI session — the pty rig, an operator reading the wall — never fires
`agent_start`. Measured 2026-11-15: with the disclosure tied to the probe alone it reached the screen
in **no** rig state. So the shipped rule is two-tier: `probeHasAnswered` separates "threw" from "free",
the probe's answer is the authority when it answers, and when it never answers the extension's copy of
the host's chord table (`HOST_HELD_CHORDS`, the list quoted above) decides. The chord is always
disclosed, and the table is a fallback, never a claim of freedom the probe refused to prove.

The disclosure is **deferred 500 ms**, not fired inline: the FIRST notify of a session is swallowed by
the host's TUI attach (measured 2026-11-15 in the pty rig — the disclosure fired at `session_start` and
never reached the scrollback, while the notify ~20 lines later in the same hook rendered every time).
The one-shot flags are set synchronously, so the deferral cannot double-print, and the rig reads it
from the scrollback with a bounded wait rather than one snapshot at the row.

The pty rig proves both states in an isolated agent dir (every entry of `~/.omp/agent` symlinked
except `keybindings.*`, so the desk's own config cannot leak in) and on a **private tmux server**
(`-L fade-pty-<pid>`): two rigs against `/tmp/tmux-1000/default` kill each other, measured 2026-11-15
— one rig's cleanup took the shared server, the other's session died mid-run at `send-keys` and its log
opened with `no server running`. A per-rig session name does not isolate; the **server** is shared.

- **DEFAULT** — nothing configured: the disclosure names `Alt+Shift+F` and the fallback; `ESC F` opens
  the screen; `ctrl+o` opens **nothing** — the extension never takes the host's chord. Which action the
  host runs there is the host's (this build's pane hint names `Ctrl+⇧O`), so the rig asserts only what
  the extension controls and keeps the toggle count as an observation.
- **HELD** — `FADE_ORCHESTRATE_KEY=ctrl+o`: the disclosure names the conflict, the fallback and the
  variable; `C-o` opens no screen; `ESC I` (alt+shift+i) opens the panel.

Run 1 runs on this desk's own state and asserts the bytes reach the extension (the host prints no
`Tool output expansion:` for `ESC F`), that the panel opens, that it is bounded by the terminal width,
that its clock moves on the refresh tick while open, and that `halt` clears the row.

The wiring is:

- `pi.registerShortcut(FADE_KEY)` lets the HOST parse the chord — the robust route for ESC + letter,
  whose two bytes a pty can split; the host refuses a chord its table holds, and that refusal is the
  disclosure's trigger;
- `ctx.ui.onTerminalInput(handler)` receives `ESC F`, returns `{ consume: true }` and opens the
  screen; every other keystroke returns `undefined`, so an unrelated key is never swallowed. Both
  routes go through the same guarded open, so one keystroke yields one panel;
- `alt+shift+i` is the registered fallback chord, in the table the host accepts, and is the key that
  opens the screen when the configured chord collides;
- `/orchestrate overlay` is the command path, and the only path that works over RPC (RPC frames
  carry no raw keystrokes).

A delegated session (a subagent's own session file) binds **no extra** listener: one listener per
process, proved by `test/gate_rig.mjs` and `test/rpc_rig.mjs`.

## The screen

`Alt+Shift+F` opens a near-full-screen overlay (96 % × 94 %, top-center) in the shape of the host's own
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
│ [r] reset  [p] pause  [c] code  [h] halt  [esc] close                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

Layout rules, all proved in `test/panel.test.mjs`:

- **Every row is flush with the frame** at 60, 100, 110 and 120 columns: content is padded to the
  inner width, so the right border is a line and not a ragged edge.
- **Two columns from 100 columns** (list + phase rail left, engine numbers right); below that the
  metrics stack under the list, because a 40-column metrics column is unreadable.
- **The key bar never loses a key.** It is packed as items, so a narrow panel wraps between keys;
  a word wrap of the bar as prose split `[esc] close` across rows, which is how the close key
  disappeared from the 110-column surface.
- **The selected task carries its details** (files, deps, round, acceptance, result, checkpoint
  tag); every other task stays one line.
- **Scroll follows the selection, and only the selection.** `j`/`k` and the refresh tick bring the
  selected task on screen; `g`, `G`, `PgUp`, `PgDn` are the operator moving the view, and a frame
  does not snap back under them.

## The metrics, and the rule about numbers

The engine column reads the router, the run's durable records and the host's context meter. The
rule is the ledger's: **a number nobody measured is NAMED, never printed as a zero.**

| row | source | named state when absent |
| --- | --- | --- |
| `engine` | `/metrics` `engine.version` — the router publishes **no quantization**: measured, `engine.quant` carries the *lane name*, so the row prints the version alone and the quant rides in the resident row's abbreviated label | `?` |
| `resident` | `/health?phase=display` `model` (the lane key; `loaded` is a **boolean** there) + the registry display name, abbreviated | `?` (and `pack (lane unnamed)` when a pack is resident with no name), and ` loading` while the swap runs |
| `expert slots`, spill | `engine.expert_slots`, `engine.spill` | `? · spill ?/?` |
| `decode now` | `live.tok_s`, `live.state`, queue | `idle` |
| `best recent` | `/metrics` `best.decode.tok_s` (the strongest rate the router publishes), else the per-request window | `no completed requests` |
| `prefix cache` | per-request `hit_rate`, `reused`, `ssd_share` | `no hit_rate reported` |
| MoE placement | `FADE_ORCHESTRATE_BASALT_CONFIG` (`moe.ts`) | named per lane, cold/warm/unknown |
| `context` | the host's `getContextUsage()` | `no context meter` |
| `gate` | the run's last pre-swap gate | `no gate run this round`; a red gate prints every failing command under `  red` |
| turn rows | `metrics.jsonl`, one line per turn | `no turn telemetry (the router reported no pp/tg)` |
| swap rows | `swap_history.json` | `(no swaps recorded yet)` + a `NOT MEASURED` entry |

**The fixture speaks the measured payload, not an invented one.** basalt 0.4.0 nests the tier fields
under `engine`, answers `/health` `loaded` as a boolean with the lane under `model`, leaves
`live.tok_s` null at idle and publishes NO `model` field per request. The rig's stub router used a
flat payload with `loaded: <lane key>` — a contract the live router never answered — and that is how
a crash on the real payload passed the rig: the reader took `true` for a lane name, the renderer
threw on `name.indexOf`, and Ctrl+O opened nothing at the desk. The stub now mirrors the capture
field for field, and the panel asserts the numbers that capture contains.

The panel never dies on a shape it did not predict: every router field is type-guarded on the way in
(`laneKey`, `typeof … === "number"`), and `nameResidentRow` returns the rows unchanged when the
resident fact is not a lane key.

The router's own unreachability is a row of its own: `router http://127.0.0.1:18014 unreachable —
engine, decode and queue are not measured`. A dead wire reading as a quiet market is the defect
class this screen exists to prevent.

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
| `esc` `q` `ctrl+c` | close, touching no loop control |

The bar **wraps**; it never clips. It is 120 visible columns, so on the 110-column default surface a
single-line bar lost its tail — the key the operator needs most, `[esc] close`, was not on screen.
`wrapText()` in `src/panel.ts` folds it onto as many rows as the width needs, at every width the
panel supports.

The panel is **live**: it re-reads on a 2 s tick (`FADE_ORCHESTRATE_PANEL_REFRESH_MS`, floor 500 ms)
and calls `tui.requestRender()`, so the numbers move while you watch. The tick is `unref`'d and
`dispose()` clears it — a closed panel never polls the router again, and an open one never holds
the process open.

## Redaction

`FADE_ORCHESTRATE_REDACT=1` strips the repo path, the OS account, `/home/<someone>`, `~` and this
machine's hostname from **every** line, so a screenshot is safe to paste. Off by default: the
operator's own truth stays on the screen.

## Proof surface

| file | what it proves |
| --- | --- |
| `test/panel.test.mjs` | the renderer: fits 40→120 columns, flush frame, the key bar keeps every key, selection details, scroll rules, live tick, both open surfaces |
| `test/panel_data.test.mjs` (guard) | a run state written mid-plan can lack `phases`; the screen reads it as no critique and renders — measured as a throw in the rpc rig (`undefined is not an object (evaluating 'src.run.phases.length')`), which turned the panel into an error notify |
| `test/panel_data.test.mjs` | the data contract: rows from a real-shaped `/metrics` snapshot, the named-absent states, the abbreviated model named once |
| `test/ui_status.test.mjs` | the status line: the operator's grammar, the terminal/no-run clear rule, the swap pill, the flip line, the chord bytes (`ESC F`, `ESC I`, why `alt+f` is never the key, and why `ctrl+shift+<letter>` has no byte form), the key label, the row's key hint |
| `test/gate_rig.mjs` | the whole protocol against a fake host and a stub router: the row is docked `aboveEditor`, no status-bar row ships by default, the chord is registered as a shortcut AND bound at the raw-input layer, `ESC F` opens the screen, the fallback chord is the one registered, a terminal run clears the row |
| `test/pty_rig.mjs` | the real terminal: tmux + the `omp` binary + the live extension, the row on screen, the `ESC F` bytes (`-H 1b 46`, measured as one 2-byte read) opening the panel, the keys, Escape closing, halt clearing, and both chord states (DEFAULT: `ctrl+o` stays the host's, its toggle count increasing, no panel; HELD: the disclosure names the conflict and `ESC I` opens) (`FADE_ORCHESTRATE_LIVE_SMOKE=1`) |

**The fake host cannot see the loading-phase guard.** omp's extension runtime answers
`getActiveTools`, `setModel`, `getShortcutConflict` and friends with
`Extension runtime not initialized. Action methods cannot be called during extension loading.`
while the extension is loading, and the host dispatches `session_start` inside that window; an
uncaught throw there does not print a stack — it **disables the extension**, so every downstream
assertion fails behind `Failed to load extension`. The gate rig's host defines those methods, so it
passes while the real host rejects the same code. That class is proved only by the live rigs
(`pty_rig`, `rpc_rig`) and, at the desk, by the extension actually loading; the wiring swallows the
probe (`shortcutConflict`) and defers the phase-tool activation to `agent_start`, where the runtime
is live.
