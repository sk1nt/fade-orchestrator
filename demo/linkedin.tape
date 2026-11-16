# linkedin.tape — the screen capture of fade-orchestrator, recorded with vhs.
#
# Run it from the repository root, where the demo's paths resolve:
#
#   npm run demo:record            # needs vhs, tmux, node and omp on PATH
#
# The clip runs in a real project: the driver roots the terminal and the run in FADE_DEMO_REPO
# (default: this repository), so the prompt bar, the panel's run root and the checks all read true.
#
# The keystrokes and the run's phase changes are NOT typed by this tape: the driver
# (`demo/recording.mjs`) owns one clock that injects keys through tmux and mutates the run state, so
# the panel opens, the gate lands and the swap animates at fixed offsets from the driver's start.
# The tape's only job is to start the driver, attach, and stay out of the way long enough.
#
# Every number the clip shows is produced by the shipped code against a router that answers with the
# basalt 0.4.0 payload (engine 0.4.0, best decode 622 tok/s); the RUN on disk is staged, and the
# driver snapshots the project's own run files and restores them by hash on `--stop`.

# Relative to this tape's cwd, which `npm run demo:record` sets to the repository root.
Output demo/out/fade-orchestrator.mp4
Output demo/out/fade-orchestrator.webm
Require omp
Require tmux
Require node
Require vhs

Set Shell "bash"
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 15
Set LineHeight 1.12
# Width/Height are pixels, and the grid they produce is what the panel renders into: 1586x1060 at
# FontSize 15 / LineHeight 1.12 / Padding 26 measures 150x45 cells, the terminal `test/pty_rig.mjs`
# proves the panel in. Measure it with `stty size` before trusting a change here.
Set Width 1586
Set Height 1060
Set Theme "TokyoNight"
Set Padding 26
Set Framerate 30

# Where the work is: a real project, a real CLI, real gates.
Type@22ms "pwd && ls src | head -4 && git status --short | head -4"
Enter
Sleep 1.4s

# Start the scripted run IN THE BACKGROUND (`&`): the driver owns a clock and runs for the whole
# timeline, so a foreground run keeps the shell busy and the attach below would be typed into the
# driver's stdin, not executed. The driver prints its own timeline as narration.
Type@22ms "node demo/recording.mjs &"
Enter
Sleep 4.5s

# Attach to the terminal the loop drives: the status row paints, then the timeline runs.
Type@22ms "tmux -L fade-demo attach -t fade-demo"
Enter

# Driver clock, from its own start: T+17 Alt+F opens the panel · T+23/26 the selection moves
# T+29 Escape · T+32 the pre-swap gate lands GREEN on the code lane · T+34 Alt+F shows it (8s)
# T+42 Escape · T+44 /orchestrate verify pays the swap: the row ramps while the pack loads (13s)
# T+61 Alt+F shows the verifier's view with the measured swap cost (10s) · T+71 Escape
# T+74 /orchestrate halt clears the row. Total clip ~89s.
Sleep 74s

# Detach, then hand the project back: --stop kills the demo processes and restores the run files.
Ctrl+B
Type "d"
Sleep 1.2s
Type@22ms "node demo/recording.mjs --stop"
Enter
Sleep 3s
