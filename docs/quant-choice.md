# Why the thinking lane pins IQ1_M, not IQ2_XXS

The plugin's default plan/verify lane is `deepseek` → **`DeepSeek-V4.1-Flash-1017-UD-IQ1_M.basalt`**
(265.9 GiB). The same router also serves **`UD-IQ2_XXS`** (285.5 GiB) under a second alias, and both
entries carry **byte-identical settings** (`kv fp8`, `max-context 1048576`, `draft-experts 32`,
`spec 3`, `pool-workers 8`, `ram-reserve-mib 8192`, `vram-reserve-mib 2048`, `gpu 0,1`) — only the
pack path differs, so the numbers below are the pack's effect, not a config's.

**These are our tuned settings, not basalt's defaults** — the default engine would run `spec 6`,
an auto CPU pool (~23 workers on this host), `ram-reserve-mib 2048`, `vram-reserve-mib 700` and
`max-context 8192`. The tuning, its rationale and its measured effect live with the host project
(`docs/ops/BASALT_SETTINGS_AUDIT_20261115.md`); the short version: `spec 3` + 32 draft experts is
the pack's own measured optimum, the pinned 8-worker pool keeps the host's trading plane off the
expert pool, and the reserve is sized so IQ2's expert tier fits as much of the pack as RAM allows.

Measured on one host: 48-core, **122 GiB RAM**, 2 × 32.6 GiB VRAM, engine basalt 0.4.0, NVMe
storage, router `:18014`, temperature 0, one warm-up request then two passes.

## The finding: IQ2_XXS spills experts and loses ~2.8× decode

`/metrics` is the whole story, because the engine reports its own tier:

| pack | expert slots resident | spill (file tier) | spill bytes | VRAM used | decode (typical) |
|---|---:|---:|---:|---:|---:|
| **IQ1_M** | **2,200** | **none** | 0 | 33.6 / 34.2 GiB | **97–189 tok/s** |
| IQ2_XXS | 1,600 | **2,680 / 15,360 experts** | **27.4 GB** | 33.5 / 34.2 GiB | **37–65 tok/s** |

The two packs fit the *same* cards, but IQ2's expert bodies are bigger, so 27.4 GB of routed experts
land in the file tier and 600 fewer slots stay resident. Every routed expert that misses is an NVMe
read on the generation path — the decode rate collapses.

The table above is the configuration that was served first (`ram-reserve-mib 16384`). The tuned
configuration (`8192`, with the conversation cache halved to match) moved the same pack to **2,000 /
15,360 experts spilled (19.0 GB)**, RAM tier **94.4 → 101.3 GB**, warm code decode **48.7 → 60.0
tok/s** and VRAM **29.4/33.5 → 28.6/31.2 GiB** — a tune, not a pack change, and IQ2 still spills, so
the pin stands; the tier size also changes which experts are resident, so before/after numbers are
`timings`, never token diffs.

Warm-pass measurements (engine `timings`, so queue time is not folded in):

| fixture | decode Q1 | decode Q2 | ratio | prompt Q1 | prompt Q2 | wall Q1 | wall Q2 |
|---|---:|---:|---:|---:|---:|---:|---:|
| conversational (100 tok) | 129.8 | 48.7 | 2.7× | 3,107 tok/s | 1,365 tok/s | 1.0 s | 6.9 s |
| code/structured (100 tok) | 139.9 | 50.5 | 2.8× | 852 tok/s | 1,945 tok/s | 1.0 s | 8.8 s |
| prose (100 tok) | 129.2 | 46.7 | 2.8× | 3,244 tok/s | 1,785 tok/s | 1.0 s | 15.4 s |
| 6,722-token brief (8 out) | 62.2 | 36.5 | 1.7× | 2,887 tok/s | 2,126 tok/s | 2.5 s | 9.9 s |
| 10 short answers (16–56 tok) | 97–189 | 37–65 | 2.5–3.4× | 221–336 tok/s | 86–197 tok/s | 0.3–0.6 s | **1.0–49.1 s** |

The short-answer row is the one that matters to the orchestrator: a spill burst can turn a 0.5 s
answer into 49 s, and a round of six tasks multiplies that. Prompt processing is also 1.4–2× slower,
so the cold ramp after a swap is longer.

Load time is not the discriminator (IQ1 34.4 s vs IQ2 21.0 s warm; 37 s on a cold page cache) — the
**steady state** is.

## Accuracy: IQ2 wins the KL/top-1 arms, IQ1 wins PPL, and the box could not tell them apart

Engine-published arms against the BF16 reference, 25,500 rows each:

| pack | PPL | KLD mean | KLD median | top-1 |
|---|---:|---:|---:|---:|
| UD-IQ1_M | **3.0456** | 0.2779 | 0.0566 | 83.88% |
| UD-IQ2_XXS | 3.1074 | **0.2408** | **0.0408** | **85.15%** |

Q2 is the accuracy favourite where it counts for a coding lane (KL, top-1 agreement) and loses on
perplexity. A box-side 10-question spot check with deterministic answers (arithmetic, bit pattern,
string reversal, JSON lookup) scored **Q1 10/10 and Q2 10/10**, with identical greedy answers on 12
of 15 comparable rows. That is a sanity check, not PPL: a PPL/KLD re-derivation needs a llama.cpp
KLD base file, which is a separate download.

## The rule the plugin encodes

1. **Look at `engine.spill` before choosing a pack.** `spill.experts > 0` means part of the expert
   set is served from disk; on this host that cost 2.8× decode. The overlay's **expert slots** row
   prints exactly these numbers, so the choice is visible in the UI, not folklore.
2. **Pin the fast pack for the thinking lane; keep the accurate pack as a second alias.** The
   plugin swaps by `POST /v1/load {"model":"<alias>"}` and times each swap; a swap is one request
   and clients wait through it, so a second alias costs nothing and makes an A/B one command.
3. **A bigger pack is only a win if it stays resident.** IQ2_XXS earns its accuracy favouritism on
   a host with spare RAM/VRAM headroom (`spill.experts == 0`); at 122 GiB with these settings it is
   the slow lane. Same settings, different host: re-measure, don't assume.

## Reproduce it (any basalt router)

```bash
# tier facts: slots, spill, VRAM
curl -s localhost:18014/metrics | jq '.engine | {quant, expert_slots, spill}'

# resident pack + progress
curl -s localhost:18014/health | jq '{loaded, loading, percent}'

# switch packs (clients wait through the swap; no restart)
curl -s -XPOST -H 'content-type: application/json' -d '{"model":"deepseek-q1"}' localhost:18014/v1/load

# one timed answer: timings.* are the engine's numbers
curl -s -XPOST -H 'content-type: application/json' \
  -d '{"model":"deepseek-q1","temperature":0,"max_tokens":100,
       "messages":[{"role":"user","content":"Explain in two sentences why a parquet footer allows skipping page decodes."}]}' \
  localhost:18014/v1/chat/completions | jq '{tok_s: .timings.predicted_per_second, prompt_tok_s: .timings.prompt_per_second, wall: .timings}'
```

Measured receipts and the longer write-ups live with the host project that produced them; the numbers
above are the ones this package's README and overlay quote.
