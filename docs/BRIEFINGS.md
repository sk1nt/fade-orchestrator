# Briefings

Every message the orchestrator sends a lane — the plan prompt, the coding window, the verifier's
rubric, the repair, the gate's red verdict, the protocol nudge, the halt diagnostic — is rendered by
`briefings` in `src/core.ts`. A lane reads one briefing per turn and answers it, so the shape is
part of the contract: a payload skeleton lost inside a paragraph is a payload the lane invents, and
a wall of single-newline prose is the shape that gets skimmed.

## Structure

Every briefing is one page, in this order:

- **Title line.** Phase, round, run id, and — on the window, the nudge and the halt — the lane. It
  leads the page and is byte-stable across rounds, because it is the start of the prompt prefix the
  conversation cache reuses.
- **`## Goal`.** The operator's goal, verbatim, never re-summarised mid-run.
- **The contract section** (`## Contract`, `## Window contract`, `## Checks to re-run`,
  `## Act on it`). The rules of THIS turn, with the payload skeleton the lane must emit in a fenced
  block. The fenced block is the teaching device: the ids it names are the ids that may be reported,
  the statuses it lists are the statuses that validate.
- **Task cards.** One task per bullet — `- **T1** [status] — objective` — with `files`, `acceptance`
  and `dependencies` as sub-bullets. Cards are UNTRUNCATED: a card a lane cannot read in full is a
  card it implements from imagination.
- **Data sections, omitted when empty.** Blocked tasks, deferred tasks, critiques, rejections, the
  RED gate rows. A section with no data renders no heading, so the page never shows a header over
  emptiness.
- **`## Call`.** The exact `fade_phase` call, phase and payload shape, at the end where the lane is
  when it finishes.

Sections sit a blank line apart. The skeleton is fenced (three backticks) rather than inlined, so a
reader — the model, and the operator reading a transcript — sees the shape as a block.

## The eight briefings

| briefing | sent when | what its fenced skeleton teaches |
|---|---|---|
| `plan` | Phase 0, the planning lane | the plan object, and the check rows as DATA the gate executes |
| `code` | Phase 1, a per-task coding turn | one `coding_done` entry |
| `window` | Phase 1, the batch coding turn | the batch payload: every id of the window, and ONLY those ids |
| `verify` | Phase 2, the verifier lane | the `["cmd","observed"]` row shape, and a repair card |
| `repair` | a `needs_repair` round | the batch `done` payload for the repair tasks |
| `gate` | the pre-swap gate came RED | nothing to emit — it names the defect class and the exit |
| `nudge` | a turn ended with no `fade_phase` call | all three payload schemas, via `SCHEMA_HINT` |
| `stalled` | the circuit breaker tripped | nothing to emit — it is the operator's diagnostic |

`SCHEMA_HINT` is the one text two briefings share: it rides the nudge and the second schema
refusal, and it puts one phase per line inside a single fenced block. The `coding_done` line shows
TWO entries on purpose — the batch shape is what the lane is taught.

## Anchors

The suite in `test/core.test.mjs` pins a set of strings across these briefings: `ONE coding_done`,
`window is EMPTY`, `past the N-task window cap`, `Rejected before`, `Previously rejected`,
`INVALID CHECK (not a command, never executed)`, `PLAN DEFECTS`, `Pre-swap gate RED`,
`UNSPENT`, `stalled_protocol_error`, the `round R/M` budgets, and the `["cmd","observed"]` row
shape. They are the contract the lanes are graded on — the tests assert them as substrings, so the
page layout above is free to move and those words are not.

The structural test asserts the layout side: a title line, `## ` headings a blank line apart, every
skeleton fenced, and tasks rendered as cards with sub-bullets. Prose wording is never re-pinned to
make a formatting change pass.

## Stable prefix

A lane's prompt is prefilled, and the router's conversation cache bills the reused prefix. So the
title line and the goal lead the page and do not change between rounds of a run; the volatile
material — task statuses, the diff stat, the last rejections — goes last. Re-reading a file the lane
already read, and pasting tool logs into `result`, are the two things that break the prefix; every
briefing says so in its own context section.
