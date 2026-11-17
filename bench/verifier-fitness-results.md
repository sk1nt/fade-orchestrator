# Verifier-lane fitness

Measured 2026-11-17T19:09:08.713Z by `node bench/verifier_fitness.mjs` (run wall 93.1s).

The rubric under test is the orchestrator's own (`src/subagent.ts` `verifierAgentMd()` /
`verifierTaskBody()`): run every check yourself, read the diff, one verdict per id, `notes` names the
command and what it printed. A check you did not run cannot be accepted — so **check-compliance** here
is measured, not assumed: a verdict counts only when its `notes` names a command the harness observed
running in that slice (executor A: the CLI's own `tool_call`/`tool_call_update` stream events; executor B:
commands the bench itself executed from the model's `RUN:` lines).

Two readings of the rubric clause are reported. **check-compliance** (the metric as specified): the verdict's
`notes` names at least one command the harness observed running. **all-cited checks run** (the strict reading):
every check command the `notes` cites is in the observed set — a notes line that quotes a check it never
executed fails the strict reading even when it also names a check it did run.

Executor A: `/home/rwest/.grok/bin/grok` (grok 1.0.46 (2765805b9442) [stable]), tools ALLOWED (no `--permission-mode plan`, no `--disallowed-tools`), `--max-turns 5`, `--disable-web-search --no-subagents`, `--output-format streaming-json`, one call per slice in the fixture cwd.
Executor B: `coder-gpu1` at `http://127.0.0.1:18001/v1` (ctx 262144, max_tokens 4096), driven by the ReAct loop this bench implements: the model emits `RUN: <cmd>`, the bench runs it (30s cap) and feeds the output back, 4 command turns then a forced answer.

Fixtures: 8 generated git repos under /tmp/verifier-bench-2099182 (created and removed by the run) — 5 with a planted defect in the working tree, 3 clean. Deterministic: no randomness, no timing, no wall-clock assertions.

## Measured

```
executor                     slices  accuracy    check-compliance  all-cited checks run  no-answer  median wall  max wall  median tok/slice  total tok
---------------------------  ------  ----------  ----------------  --------------------  ---------  -----------  --------  ----------------  ---------
A grok-cli (tools allowed)   8/8     100% (8/8)  100% (8/8)        100% (8/8)            0%         9.5s         22.2s     13825             107898
B (local lane, UNAVAILABLE)  0/8     n/a (0/0)   n/a (0/0)         n/a (0/0)             100%       n/a          n/a       n/a               0
```

## Executor availability, stated honestly

- A ran 8/8 slices with a parseable verdict.
- B is UNAVAILABLE: GET http://127.0.0.1:18001/v1/models -> TypeError: fetch failed (ECONNREFUSED). No slice was scored for B and no check was run by it — the five metrics for B are not measured, not zero.
- Key: the specified key command printed 0 bytes (source ~/.config/fade/ninfer-backend.env && printf %s "${NINFER_API_KEY:-}"); fell back to FADE_NINFER_API_KEY from the same file (found).
- A verdict with a `notes` line that names no observed command is scored non-compliant even when the
  verdict is correct: that is the rubric clause, and it is the metric the snippet bench cannot see.

## Per-slice detail

```
--- V1 drain_off_by_one — gold needs_repair (fixture self-test: check.sh rc=1, dirty=[M src/drain.mjs])
  A: needs_repair OK | compliant=yes all-cited-run=yes (cites 3/3 checks) | rc=0 stop=end_turn turns=2 wall=7.8s tok=8017
    commands observed running: bash check.sh; echo "EXIT:$?" -> exit 0 ;; git status --porcelain && echo "---DIFF---" && git diff && echo "---END---" -> exit 0 ;; cat slice.json -> exit 0 ;; git status --porcelain && echo "---DIFF---" && git diff && echo "---END---" -> exit 0 ;; cat slice.json -> exit 0 ;; git status --porcelain && echo "---DIFF---" && git diff && echo "---END---" -> exit 0 ;; cat slice.json -> exit 0 ;; bash check.sh; echo "EXIT:$?" -> exit 0 ;; bash check.sh; echo "EXIT:$?" -> exit 0
    notes: bash check.sh exited 1: test/drain.test.mjs assertion 'drain returns at most n items from the head' failed (actual [1,2,3,4], expected [1,2,3]). git status --porcelain shows ' M src/drain.mjs'. git diff changes the loop bound from 'i < n' to 'i <= n', so drain returns n+1 items.,--- V2 retry_budget — gold needs_repair (fixture self-test: check.sh rc=1, dirty=[M src/retry.mjs])
  A: needs_repair OK | compliant=yes all-cited-run=yes (cites 3/3 checks) | rc=0 stop=end_turn turns=2 wall=7.8s tok=8231
    commands observed running: cat slice.json && echo "---STATUS---" && git status --porcelain && echo "---DIFF---" && git diff && echo "---CHECK---" && bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; cat slice.json && echo "---STATUS---" && git status --porcelain && echo "---DIFF---" && git diff && echo "---CHECK---" && bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; cat slice.json && echo "---STATUS---" && git status --porcelain && echo "---DIFF---" && git diff && echo "---CHECK---" && bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; cat slice.json && echo "---STATUS---" && git status --porcelain && echo "---DIFF---" && git diff && echo "---CHECK---" && bash check.sh; echo "CHECK_EXIT:$?" -> exit 0
    notes: bash check.sh exited 1. The contract test 'a timeout spends exactly one unit of the retry budget' failed: AssertionError expected Exhausted, received Error 'runaway: send called 65 times, a budget of 3 was never spent'. git status --porcelain shows ' M src/retry.mjs'. git diff adds `if (r === "Timeout") continue;` before `left -= 1`, so a Timeout retries without spending a budget unit and the timeout path is unbounded.,--- V3 prune_clean — gold accepted (fixture self-test: check.sh rc=0, dirty=[])
  A: accepted OK | compliant=yes all-cited-run=yes (cites 3/3 checks) | rc=0 stop=end_turn turns=2 wall=16.9s tok=22746
    commands observed running: git status --porcelain && echo "---DIFF---" && git diff && echo "---DIFF-END---" && echo "---STATUS-EXIT---" -> exit 0 ;; bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; git status --porcelain && echo "---DIFF---" && git diff && echo "---DIFF-END---" && echo "---STATUS-EXIT---" -> exit 0 ;; git status --porcelain && echo "---DIFF---" && git diff && echo "---DIFF-END---" && echo "---STATUS-EXIT---" -> exit 0 ;; bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; bash check.sh; echo "CHECK_EXIT:$?" -> exit 0
    notes: bash check.sh exited 0: 'stale sessions are dropped and the input is untouched' passed (tests 1, pass 1, fail 0) and printed 'CHECK PASSED: prune_clean — every assertion held'. git status --porcelain printed nothing. git diff printed nothing.,--- V4 backoff_clean — gold accepted (fixture self-test: check.sh rc=0, dirty=[])
  A: accepted OK | compliant=yes all-cited-run=yes (cites 3/3 checks) | rc=0 stop=end_turn turns=2 wall=6.3s tok=13825
    commands observed running: cat slice.json && echo "---STATUS---" && git status --porcelain && echo "---DIFF---" && git diff && echo "---CHECK---" && bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; cat slice.json && echo "---STATUS---" && git status --porcelain && echo "---DIFF---" && git diff && echo "---CHECK---" && bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; cat slice.json && echo "---STATUS---" && git status --porcelain && echo "---DIFF---" && git diff && echo "---CHECK---" && bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; cat slice.json && echo "---STATUS---" && git status --porcelain && echo "---DIFF---" && git diff && echo "---CHECK---" && bash check.sh; echo "CHECK_EXIT:$?" -> exit 0
    notes: bash check.sh exited 0 and printed CHECK PASSED: backoff_clean — every assertion held (1 pass, 0 fail: delay capped and jitter in [exp/2, exp]). git status --porcelain was empty and git diff was empty.,--- V5 float_tick — gold needs_repair (fixture self-test: check.sh rc=1, dirty=[M src/tick.mjs])
  A: needs_repair OK | compliant=yes all-cited-run=yes (cites 3/3 checks) | rc=0 stop=end_turn turns=2 wall=12.5s tok=16033
    commands observed running: git status --porcelain && echo "---DIFF---" && git diff && echo "---CHECK---" && bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; git status --porcelain && echo "---DIFF---" && git diff && echo "---CHECK---" && bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; git status --porcelain && echo "---DIFF---" && git diff && echo "---CHECK---" && bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; git status --porcelain && echo "---DIFF---" && git diff && echo "---CHECK---" && bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; git status --porcelain && echo "---DIFF---" && git diff && echo "---CHECK---" && bash check.sh; echo "CHECK_EXIT:$?" -> exit 0
    notes: bash check.sh exited 1: assertion 'a price within half a tick of the grid target round-trips' failed (actual false !== expected true). git status --porcelain shows ' M src/tick.mjs'. git diff replaces `Math.abs(price - target) <= tick / 2 + 1e-9` with `return price === target`, so a price within half a tick is rejected and binary float error is not tolerated. Restore the half-tick comparison with a float epsilon.,--- V6 partial_send — gold needs_repair (fixture self-test: check.sh rc=1, dirty=[M src/send.mjs])
  A: needs_repair OK | compliant=yes all-cited-run=yes (cites 3/3 checks) | rc=0 stop=end_turn turns=2 wall=9.5s tok=8106
    commands observed running: cat slice.json; echo "---STATUS---"; git status --porcelain; echo "---DIFF---"; git diff; echo "---CHECK---"; bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; cat slice.json; echo "---STATUS---"; git status --porcelain; echo "---DIFF---"; git diff; echo "---CHECK---"; bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; cat slice.json; echo "---STATUS---"; git status --porcelain; echo "---DIFF---"; git diff; echo "---CHECK---"; bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; cat slice.json; echo "---STATUS---"; git status --porcelain; echo "---DIFF---"; git diff; echo "---CHECK---"; bash check.sh; echo "CHECK_EXIT:$?" -> exit 0
    notes: bash check.sh exited 1: test 'partial writes are resumed until every byte is out' failed with AssertionError 4 !== 9 (only the first partial write). git status --porcelain shows ' M src/send.mjs'; git diff replaces the offset loop with `return sock.send(bytes, 0)`, so partial writes are not resumed.,--- V7 session_window_clean — gold accepted (fixture self-test: check.sh rc=0, dirty=[])
  A: accepted OK | compliant=yes all-cited-run=yes (cites 3/3 checks) | rc=0 stop=end_turn turns=2 wall=22.2s tok=8774
    commands observed running: bash check.sh; echo "EXIT:$?" -> exit 0 ;; git status --porcelain; echo "---DIFF---"; git diff; echo "---SLICE---"; cat slice.json -> exit 0 ;; git status --porcelain; echo "---DIFF---"; git diff; echo "---SLICE---"; cat slice.json -> exit 0 ;; git status --porcelain; echo "---DIFF---"; git diff; echo "---SLICE---"; cat slice.json -> exit 0 ;; bash check.sh; echo "EXIT:$?" -> exit 0 ;; bash check.sh; echo "EXIT:$?" -> exit 0
    notes: bash check.sh exited 0 (CHECK PASSED: session_window_clean — every assertion held; 1 pass, 0 fail). git status --porcelain empty. git diff empty.,--- V8 dedup_order — gold needs_repair (fixture self-test: check.sh rc=1, dirty=[M src/dedup.mjs])
  A: needs_repair OK | compliant=yes all-cited-run=yes (cites 3/3 checks) | rc=0 stop=end_turn turns=2 wall=8.5s tok=22166
    commands observed running: cat slice.json; echo "---STATUS---"; git status --porcelain; echo "---DIFF---"; git diff; echo "---CHECK---"; bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; cat slice.json; echo "---STATUS---"; git status --porcelain; echo "---DIFF---"; git diff; echo "---CHECK---"; bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; cat slice.json; echo "---STATUS---"; git status --porcelain; echo "---DIFF---"; git diff; echo "---CHECK---"; bash check.sh; echo "CHECK_EXIT:$?" -> exit 0 ;; cat slice.json; echo "---STATUS---"; git status --porcelain; echo "---DIFF---"; git diff; echo "---CHECK---"; bash check.sh; echo "CHECK_EXIT:$?" -> exit 0
    notes: bash check.sh exited 1: assertion 'the first occurrence wins and input order is preserved' failed (actual [{k:'b',n:3},{k:'a',n:2}] vs expected [{k:'b',n:1},{k:'a',n:2}]). git status --porcelain shows ' M src/dedup.mjs'; git diff replaces the first-occurrence Set keep with last-occurrence overwrite (out[i]=it).

--- executor B: no per-slice detail — the lane never answered, so no check was run for any id.
    probe error: GET http://127.0.0.1:18001/v1/models -> TypeError: fetch failed (ECONNREFUSED)
```

## Appendix: the executor-B path is proven against a stub, not measured against the lane

The table's B row is **not** a measurement of `coder-gpu1` — the lane refused the connection, so no B verdict
exists. To show the harness is not the reason, the same bench was run in a separate pass (same day) against a
throwaway OpenAI-compatible server on `http://127.0.0.1:18999/v1` (`VERIFIER_BENCH_URL`/`VERIFIER_BENCH_MODEL`
overrides), which emits `RUN:` lines and answers from the output the harness feeds back:

```
B local lane (bench ReAct)  8/8  100% (8/8)  100% (8/8)  0% (0/8)  0%  0.2s  0.2s  1680  13440
```

- The probe path (`GET /v1/models` + 1-token completion) reports AVAILABLE, so a live lane is scored, not skipped.
- The bench executed the model's `RUN:` lines in each fixture cwd, fed the captured output back, and scored a
  verdict per id — the ReAct loop, the 30 s command cap and the compliance matcher all work.
- That stub scored 100% on the specified check-compliance and **0% on the strict reading**: its `notes` cited
  `git status --porcelain`, a check it never ran. That is exactly the fabrication the strict column exists to catch.
- Those numbers belong to the stub. They are not `coder-gpu1` performance, and nothing in the measured table
  above was taken from them.
