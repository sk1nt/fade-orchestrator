# Configuration

Set environment variables before launching OMP. Lane aliases must match the router and OMP provider registry.

| Variable | Default | Meaning |
|---|---|---|
| `FADE_ORCHESTRATE_ROUTER` | `http://127.0.0.1:18014` | basalt router base URL |
| `FADE_ORCHESTRATE_AUTO_RESUME` | unset | Set `1` to queue a restored run's handover until the host is idle. Temporary failures retry, and shutdown or a superseding startup cancels pending delivery. |
| `FADE_ORCHESTRATE_LOCK_DIR` | `~/.local/state/fade-orchestrator` | Router claim directory. Each router has an ownership file containing pid, run id, repository, host, and start time. Claims are released on halt, stop, completion, or preflight failure. |
| `FADE_ORCHESTRATE_PROVIDER` | `basalt` | OMP provider id containing the configured lane model entries. Register all lane aliases under this provider. |
| `FADE_ORCHESTRATE_THINK_LANE` | `deepseek` | Planning lane. Read at module import, so restart OMP after changing it. A value that collapses planning onto the code lane is refused and the documented default is used. |
| `FADE_ORCHESTRATE_CODE_LANE` | `flash-next` | Coding lane and terminal-state hand-back target. Read at module import. A documented thinking pack used here is refused. |
| `FADE_ORCHESTRATE_VERIFY_LANE` | `hy4-flash` | Advisor lane for phase verification and verdict acts. It may share the planning lane. A value equal to the code lane is refused. |
| `FADE_ORCHESTRATE_KEY` | `alt+f` | Panel shortcut. The default uses the raw `ESC f` terminal sequence. See [interface controls](OVERLAY.md) for host key handling. |
| `FADE_ORCHESTRATE_FALLBACK_KEY` | `alt+shift+i` | the companion chord (ESC + uppercase `I`), registered where the host's probe reports it free. It opens the screen when `FADE_ORCHESTRATE_KEY` names a chord the host holds |
| `FADE_ORCHESTRATE_SURFACE` | unset | Status row placement. The default uses the top widget above the editor. Set `status` for the status bar. |
| `FADE_ORCHESTRATE_PANEL_REFRESH_MS` | `2000` | Panel refresh interval, with a 500 ms minimum. Closing the panel clears its timer. |
| `FADE_ORCHESTRATE_PANEL_FIRST_MS` | `3000` | Deadline for the first panel read. A timeout clears the opening state and reports a warning so the operator can retry. |
| `FADE_ORCHESTRATE_GLYPH` | `󰚩` | Leading status glyph. An empty value removes it for terminals without a Nerd Font. |
| `FADE_ORCHESTRATE_REDACT` | unset | `1`, or `/orchestrate --demo-redact` (`--demo-redact=off` to clear), strips the repo path, account, `/home/…`, `~` and the hostname from every rendered line. Display-only: `state.json`, `metrics.jsonl` and `swap_history.json` stay verbatim, and a fresh session starts unredacted |
| `FADE_ORCHESTRATE_HEADLESS` | unset | `1` renders the screen as a widget (110 columns) instead of an overlay component (RPC/print hosts) |
| `FADE_ORCHESTRATE_BASALT_CONFIG` | unset | overrides which basalt serve config the MoE rows read. Unset, the panel reads the config the **running router names in its own `--config`** (from the `/proc` proof), so the rows describe the engine that is serving: the lane's `expert-profile-save`, its profile's age against the engine start, and the GPU placement. Pointing it at a config the router does not serve is answered honestly — the row says `configured, NOT live` and names both paths |
| `FADE_ORCHESTRATE_GATE_POLL_MS` / `_GATE_BUDGET_MS` | `3000` / `60000` | the pre-unload router-idle gate: a `POST /v1/load` is deferred while `/health` reports the router busy, polled every `_GATE_POLL_MS` for up to `_GATE_BUDGET_MS`, then paid anyway. A gate that expires without loading the lane leaves the run stalled |
| `FADE_ORCHESTRATE_GATE_TOTAL_BUDGET_MS` | `600000` | Total wall-clock budget for acceptance checks. Each check also has a 120 s timeout. Checks beyond the remaining budget are reported as unmeasured. |
| `FADE_ORCHESTRATE_FASTPATH_FILES` / `_LINES` | `1` / `15` | the fast path's bound: a gate-green round that touched ≤ 1 file and < 15 changed lines on the first try completes with zero lane loads |
| `FADE_ORCHESTRATE_SETTLE_POLL_MS` / `_MAX_MS` | `2000` / `120000` | the pre-unload settle window: an in-flight swap is waited out first, and the gate reports the health line seen when the window ends |
| `FADE_ORCHESTRATE_START_PROOF_WAIT_MS` | `240000` | Startup readiness deadline. Both supervisor residency and the router model listing must confirm the planning lane before its briefing is sent. Failure reports the observed state. |
| `FADE_ORCHESTRATE_FLIP_WINDOW_MS` / `_FLIP_MIN_SWAPS` / `_FLIP_BREAKER_AT` | `120000` / `2` / `4` | the flip window, the count that badges it, and the count that halts the loop. At the breaker a switch issues no `setModel` and no `POST /v1/load`, the run pauses with the flips named, and `/orchestrate lanes reset` clears the ledger and lands the owed lane |
| `FADE_ORCHESTRATE_SWITCH_GLYPH` | U+F051F | Model-switch icon. An empty value removes the icon and its space. |
| `FADE_ORCHESTRATE_PROOF_TTL_MS` | `10000` | Cache duration for the running-engine proof used by the MoE display. Set `0` to rescan on every read. Lane loads invalidate the cache. |
| `FADE_ORCHESTRATE_LEDGER_MAX_BYTES` | `8388608` | Turn ledger rotation threshold. Retains one predecessor at `metrics.jsonl.1`. Set `0` to disable rotation. The panel reads the current file. |
| `FADE_ORCHESTRATE_VERIFY_SETTLE_S` | `8` | Batch settle window when some launched workers have yet to register. A batch also closes when every expected worker has registered. |
| `FADE_ORCHESTRATE_VERIFIER_MODEL` | `ninfer-local/coder-gpu1` | Verification subagent model. Configure a reachable endpoint separate from the router. Router entries are refused by installation and claim-time probes. |
| `FADE_ORCHESTRATE_LANE_PROBE_TIMEOUT_MS` / `_LANE_PROBE_CACHE_MS` | `8000` / `15000` | Verifier probe timeout and cache duration. The probe checks an authenticated completion before claiming a subagent batch. A failed probe uses the swap route. Set cache duration to `0` to disable probing and report it as skipped. |
| `FADE_ORCHESTRATE_VERIFIER_BASE_URL` / `_VERIFIER_API_KEY` / `_VERIFIER_API` | unset | point the probe at an explicit endpoint — a rig's stub lane, or a host with no `~/.omp/agent/models.yml`. When set, the spec's provider part is ignored and the scan is skipped |
| `FADE_ORCHESTRATE_THINK_MODEL` | `strata-flash/deepseek` | Default model for `/orchestrate think`. A router entry must already be resident. A separate endpoint must be reachable and have the resources to serve its model. |
| `FADE_ORCHESTRATE_THINK_TIMEOUT_MS` / `_THINK_MAX_TOKENS` | `180000` / `2048` | Time and token budget for one in-process thinking request. If reasoning consumes the token budget without an answer, the command reports `no_completion`. |
| `FADE_ORCHESTRATE_THINK_PROBE_CACHE_MS` | `15000` | the in-process lane probe's cache window. `0` disables probing and that answer carries `skipped`, so a disabled probe is never read as a proved lane |
| `FADE_ORCHESTRATE_GATE_TRIAGE` / `_GATE_TRIAGE_BIN` / `_GATE_TRIAGE_TIMEOUT_MS` | set / `grok` / `45000` | red-gate **triage**: after a red pre-swap gate, ONE bounded `--disallowed-tools '*'` CLI call names the probable cause from the tails the gate already captured, as one advisory line on the briefing and the tool's answer. Zero authority: the verdict stays the checks' exit codes, no lane load is paid, the advisory agent cannot touch the tree, and a timeout / missing binary / cancelled turn ships the briefing unchanged (`0` disables) |
| `FADE_ORCHESTRATE_VERIFIER_AGENT` | `fade-verifier` | the verification subagent's name: the `task` call's `agent`, and the file `/orchestrate verifier install` writes at `.omp/agents/<name>.md` |
| `FADE_SUPERVISOR_SOCK` | unset | Explicit supervisor socket path. Otherwise, discover a live daemon through `/v1/health`, trying `/run/fade/supervisor.sock` before `/tmp/fade-supervisor.sock`. |
| `FADE_ORCHESTRATE_LEASE_MINT_TTL_S` | `300` | the lease length a single-turn load asks for when it carries no run token. The daemon clamps it to `lease.max_ttl_s`. the `finally` release is the guarantee, the TTL is the backstop for a caller that dies mid-swap |
| `FADE_BUILD` | `prod` | Build claim sent through `X-Fade-Build`. `prod` requests lane eviction authority. The daemon refuses that authority for `dev`. |
