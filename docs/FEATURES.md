# The feature sweep, ranked

What a sweep of this tree found. Each section states the feature, cites the evidence as the quoted
code, prices the cost in files and turns, and names the ONE command that would accept it. Code is
named by file and symbol, never by line number: a line moves the day the file is edited, and the
quote is what survives.

Ranking rule: a proposal whose absence has already cost a measured lane load on the live plane
outranks one that would only be nicer to read. Every proposal below obeys the repo's standing rule
([`OVERLAY.md`](OVERLAY.md)): a number nobody measured is NAMED, never printed as a zero — so
each one states what its row prints when the measurement is missing.

Five proposals are open. Five features the sweep found as gaps are IMPLEMENTED, shipped alongside
this document, and are listed last so the ranking does not read as a wish list that never shipped.

## 1. `/orchestrate gate` — price the tree without paying a lane load

The feature: one verb that runs the plan's own checks on the resident lane, prints the rows, and
changes nothing.

The gap, quoted from the `orchestrate` command's verb list (the `registerCommand` description in
`src/index.ts`):

```
/orchestrate [--rounds N] [--demo-redact] <goal> | status | overlay | runs | skip [Tn] | verify | reset | lanes reset | pause [note] | code | halt | stop [--clear]
```

The gate runs in exactly two places, both inside the loop: the pre-swap gate in `src/index.ts`
(`await gateChecks(ctx); const gate = await runGateLogged(run.checks, run.repo, ctx);`) and the
Tier-2 synthesizer in the same file. The operator's own lever is `verify` (`actVerify` in
`src/keymap.ts`), and it is not this:

```ts
run.state = "verifying";
return { next: VERIFY_LANE, nextState: "verifying", note: "verification requested early; the advisor lane loads at the turn boundary" };
```

`verify` pays 13-25 s of pack load to ask "is the tree green?" — the same question the gate already
answers for free on the resident lane, and the reason the fast path exists at all
(`FASTPATH_LINES` in `src/index.ts`). An operator mid-round, wanting the exit codes before deciding
whether to let the round advance, has no free path to them.

Cost: 1 file (`src/index.ts`, one command branch reusing `runGateLogged`, no state write), +1
gate-rig case. One turn.

Accepted by: `npm run test:gate`, with a case asserting `/orchestrate gate` prints the plan's rows
and leaves `state.json` byte-identical and pays ZERO `POST /v1/load`.

## 2. Per-check timing inside `GateResult`

The feature: each gate row carries the seconds it took, so a red gate names the slow row and the
budget's spend is auditable.

`GateResult`'s row shape (in `src/core.ts`) has a duration for nothing — the fields verbatim, their
doc comments elided:

```ts
	results: {
		cmd: string;
		expected: string;
		ok: boolean;
		invalid?: boolean;
		want?: "exit0" | "nonzero" | "quiet";
		as_expected?: boolean;
		budget?: boolean;
		tail: string;
	}[];
```

The gate knows the clock — `runGate` in `src/core.ts` opens `const deadline = Date.now() +
gateTotalBudgetMs();` and bounds each spawn with `timeout: Math.min(120_000, remaining)` — and then
throws the measurement away, so the only timing fact the screen has is the `at` stamp on the result
and the row `budget` prints when the 600 s cap (`GATE_TOTAL_BUDGET_DEFAULT_MS = 600_000` in
`src/core.ts`) is spent by the rows before it (`runGate`'s `NOT RUN … unmeasured` tail). The measured
shape of the loss: a gate that ran 9 minutes and a gate that ran 9 seconds print identically
(`gateRows` in `src/screendata.ts`), and a plan whose checks should be trimmed is invisible until the
budget kills a row.

Cost: 3 files (`src/core.ts` stamps `elapsed_ms` per row from the same clock; `src/screendata.ts`
prints it in the gate block; `src/panel.ts` unchanged if the row is a `MetricRow`),
`test/core.test.mjs`, `test/panel_data.test.mjs`. One turn.

Accepted by: `node --test test/core.test.mjs`, asserting every spawned row carries `elapsed_ms`,
that a `budget` row carries none — named, never zero — and that the sum of rows never exceeds
`gateTotalBudgetMs()`.

## 3. Lane residency share from `swap_history`

The feature: one row saying how long each lane held the GPU, over the ledger's window.

The rows already carry every input. `SwapRow` (in `src/history.ts`) has `from`, `to`, `elapsed_s`,
`first_tg`, `steady_tg` and `at`, and the ledger is newest-first (`readSwaps`, same module). What the
screen does with them is the last six swaps, one row each (`swapRows` in `src/screendata.ts`):

```ts
export function swapRows(swaps: SwapRow[]): MetricRow[] {
	return swaps.slice(0, SCREEN_SWAPS).map((s) => {
```

so the screen answers "what were the last swaps" and never the question an operator actually asks
after a thrash halt: how much of the last hour did the code lane own the card, and what did the
thinking lanes (planning, advisor) cost. `summarizeSwaps` is the same shape per run, not per lane.

Cost: 2 files (`src/screendata.ts` gains a pure share function; `src/panel.ts` renders it inside
the LANE SWAPS block), `test/panel_data.test.mjs`. One turn.

Accepted by: `node --test test/panel_data.test.mjs`, with a fixture whose rows sum to a named
per-lane share, and an empty ledger whose row reads `no swaps measured` — a share of nothing is
named, never `0%`.

## 4. Handover diff preview

The feature: the handover a new lane receives names the files the coder left, not just the state.

The handover is prose over state alone (`handoverText` in `src/core.ts`):

```ts
export async function handoverText(run: RunState): Promise<string> {
	const h = await handover(run);
	return [
		...h.stable,
		"",
		...h.volatile,
		"",
		`Continue from here: the resident lane is ${run.lane}. Report the next phase with fade_phase.`,
	].join("\n");
}
```

The tree facts are cheap and already collected for a different purpose: `fastPathDiff` in
`src/index.ts` prices a working tree as changed paths and changed lines, and `gitCaveat` /
`execGitAsync` in `src/core.ts` are the async readers. A verifier that lands on a tree with eight
dirty files learns that from its own `git status`, at the price of a turn, and a verifier landing on
a clean tree cannot tell a finished task from an untouched one.

Cost: 2 files (`src/core.ts` takes an optional `diff` block into `handoverText`; `src/index.ts`
collects it with the existing async reader at handover time), 1 gate-rig case. One turn.

Accepted by: `npm run test:gate`, with a case asserting the handover names the changed paths and
prints `tree clean` when `git status --porcelain` is empty.

## 5. Per-run cost rows in `metrics.jsonl`

The feature: the turn ledger attributes tokens to the task that spent them.

`TurnRecord` (in `src/history.ts`) is per-turn and per-round, with no task identity:

```ts
export interface TurnRecord {
	ts: string;
	run_id: string;
	turn: number;
	round: number;
	phase?: string;
	pp: number;
	tg: number;
	ttft?: number;
	kv_hit_pct?: number;
	swap_ms: number;
	round_outcome: string;
}
```

`run_id` and `round` are there, so a run's total token bill is a sum — and a run with six tasks in a
window has no way to say which task cost what, which is the number a plan's size (`roundsForTasks`,
the `tier` pricing in `src/core.ts`) should be judged against.

Cost: 2 files (`src/history.ts` widens the record with the task ids in the window at write time;
`src/index.ts` passes the window into `recordTurn`), `test/history.test.mjs`. One turn.

Accepted by: `node --test test/history.test.mjs`, asserting a written row names the task ids of its
window, and that a turn with no open window carries none — the field is absent, never `[]` read as
"nothing was spent".

---

The four features below were gaps when the sweep was written and are shipped with this document.
Their acceptance commands are the plan's own.

## 6. Per-run swap attribution — IMPLEMENTED

`SwapRow` carries the payer (in `src/history.ts`):

```ts
	/** The run that PAID this swap. A row written before the field existed has none, and
	 *  `summarizeSwaps` never charges such a row to the run asking — the panel's `swaps this run`
	 *  row names that gap instead of reading another run's cost as this run's. */
	run_id?: string;
```

`summarizeSwaps(rows, runId)` filters on it, and the swap watcher stamps the payer at the write site
(`SwapWatchHandle.finish(from, toLane, elapsed_s, dir, runId?)` in `src/livedata.ts`).
Accepted by: `node --test test/history.test.mjs test/swap_rate.test.mjs`.

## 7. The ledger's size cap and rotation — IMPLEMENTED

`appendTurn` was append-only, so a long-lived plane grew `metrics.jsonl` without bound. It rotates
first (in `src/history.ts`), under a cap read at call time (`LEDGER_MAX_BYTES_DEFAULT = 8_388_608`,
`FADE_ORCHESTRATE_LEDGER_MAX_BYTES` moves it, `0` disables):

```ts
		if (size > cap) {
			try {
				await rename(path, `${path}.1`);
			} catch {
				/* a rotation race loses to the winner: the append below still lands, in one file */
			}
		}
```

One predecessor, and `readTurns` reads the current file only — the rotated tail is a postmortem
file, not a screen row. Accepted by: `node --test test/history.test.mjs`.

## 8. The shelf of finished runs — IMPLEMENTED

`state.json` is ONE slot, so a start erased the run it adopted. `src/runs.ts` is the shelf:
`archiveRun` writes a TERMINAL run to `<dir>/runs/<run_id>.json` through the same tmp → fsync →
rename ordering, refuses a non-terminal run, and never overwrites the first record; `listRuns` reads
it newest-first, skipping an unparseable file. A start archives the previous finished run before
writing its own record (the start path in `src/index.ts`), and `/orchestrate runs` prints the shelf.
Accepted by: `node --test test/runs.test.mjs`.

## 9. The panel's per-run swap total — IMPLEMENTED

The screen said what the last swaps cost and never what THIS run paid. `swapSummaryRow` (in
`src/screendata.ts`) is the row:

```ts
	if (count > 0) return { label: "swaps this run", value: `${count} · ${total_elapsed_s.toFixed(1)}s paid`, tone: "ok" };
	return { label: "swaps this run", value: swaps.length === 0 ? "0 · no swaps measured" : "0 · older runs only", tone: "dim" };
```

and it rides as the first row of the LANE SWAPS block (the `swapBlock` in `src/panel.ts`), above the
per-swap rows, which are unchanged. Accepted by: `node --test test/panel_data.test.mjs`.

## 10. The in-process lane call — IMPLEMENTED

The gap: every thinking act the session took was a lane BOUNDARY — `setModel` plus `POST /v1/load`,
13-25 s per direction, the flip guard halting the loop at `FLIP_BREAKER_AT` swaps inside
`FLIP_WINDOW_MS`. The plugin had no way to ask a model ONE question: every completion it wanted was
a lane load. `src/thinklane.ts` is that client — one completion the plugin issues itself, resolved
from the provider plane exactly the way the claim-time probe resolves it (`resolveLaneSpec`,
`runKeyCommand`, `completionRequest` in `src/lane.ts`), with no load call and no `setModel` anywhere
in the file. The rule that keeps that honest:

```ts
	if (isRouterEndpoint(spec.baseUrl)) {
		const resident = deps.resident !== undefined ? deps.resident : await (deps.lanes ?? residentLane)();
		if (resident !== spec.model) {
			return finish({ ok: false, text: "", cls: "lane_not_resident", endpoint, model: spec.model, detail: … });
```

…because the router answers a request naming a model it does not hold by SWAPPING the lane, so the
refusal sends ZERO bytes and names the way out. An endpoint on its own port is a different server and
is always served; on this box `basalt-deepseek` (`:18016`, the 242.1 GiB pack, both cards, systemd
`Conflicts=` with the resident `:18014`) cannot coexist with the Flash-Next pack, so a
`lane_not_resident` / `endpoint_unreachable` line IS the topology, named. The classes are closed:
`lane_not_resident`, `endpoint_unreachable`, `timeout`, `http_error`, `no_completion`,
`spec_unresolved`. A token budget spent inside the thinking channel answers with a NULL `content` and
`finish_reason: length` (measured on the live lane at 24 tokens) — the refusal names the reasoning
length and the lever to raise, never a silent empty success.

The operator surface is `/orchestrate think [provider/model] <prompt>`: the answer printed with the
endpoint and the elapsed, `state.lane_call` as the record, and the `status` line naming it — in words
(`no in-process call`) when none happened, because a measurement-free zero is never printed.

Accepted by: `node --test test/thinklane.test.mjs` (19 cases, every path asserting no `/v1/load` byte
reached the seam) and the live rig `node test/build.mjs && node test/thinklane_live.mjs`, which on
this box printed `PROOF PASS · in-process ok in 1.0s, owed lane refused as lane_not_resident, own
port endpoint_unreachable, lane flash-next unmoved` (the resident call measured 0.1-1.0 s and the
refusal 4-5 ms across three runs; the lane was `flash-next` before and after every one, with
`loading: false` and no `swap` in the health line).
