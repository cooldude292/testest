# Porting flash-moe to a 100B-class MoE on a MacBook Pro M5 / 24 GB

Feasibility study and port plan for retargeting [danveloper/flash-moe](https://github.com/danveloper/flash-moe)
— which streams Qwen3.5-397B-A17B off SSD at 4.36 tok/s on an M3 Max with 48 GB — to a
~100B-parameter MoE on a base M5 MacBook Pro with 24 GB of unified memory.

**Bottom line:** the port itself is small — Qwen3.5-122B-A10B is the same architecture family as
the model flash-moe already runs, so the engine changes come down to four config constants plus
one class of hardcoded-offset bug. The hard part is the hardware. Expect **~2.4 tok/s** at the
model's native routing and **~3.6 tok/s** in a reduced-routing speed mode. That is slower than
flash-moe's 4.36 tok/s despite the target model being 3.3x smaller, because the base M5 is weaker
than an M3 Max on every axis this engine leans on except the SSD.

All throughput figures below are projections from a model calibrated against flash-moe's own
published per-layer measurements. Nothing here has been run on an M5. The arithmetic is in
`flash-moe-m5-budget.py` in this repo so the assumptions can be checked and replaced with real numbers.

---

## 1. Pick the target model

The single most important finding: **Qwen3.5-122B-A10B is architecturally the same model as
Qwen3.5-397B-A17B, just smaller.** Same hybrid Gated DeltaNet stack, same 3:1 linear-to-full
attention ratio, same head geometry, same RoPE, and — critically — the same 248320-token
vocabulary, so `tokenizer.bin` and `vocab.bin` carry over untouched.

Here is every model constant in `infer.m` against the new target:

| `#define` | 397B-A17B (today) | 122B-A10B (target) | Change |
|---|---|---|---|
| `HIDDEN_DIM` | 4096 | **3072** | yes |
| `NUM_LAYERS` | 60 | **48** | yes |
| `NUM_EXPERTS` | 512 | **256** | yes |
| `NUM_EXPERTS_PER_TOK` | 10 | **8** | yes |
| `MOE_INTERMEDIATE` | 1024 | 1024 | — |
| `SHARED_INTERMEDIATE` | 1024 | 1024 | — |
| `VOCAB_SIZE` | 248320 | 248320 | — |
| `NUM_ATTN_HEADS` / `NUM_KV_HEADS` | 32 / 2 | 32 / 2 | — |
| `HEAD_DIM` | 256 | 256 | — |
| `LINEAR_NUM_V_HEADS` / `LINEAR_NUM_K_HEADS` | 64 / 16 | 64 / 16 | — |
| `LINEAR_KEY_DIM` / `LINEAR_VALUE_DIM` | 128 / 128 | 128 / 128 | — |
| `CONV_KERNEL_SIZE` | 4 | 4 | — |
| `FULL_ATTN_INTERVAL` | 4 | 4 | — |
| `ROPE_THETA` / `PARTIAL_ROTARY` | 1e7 / 0.25 | 1e7 / 0.25 | — |

Four constants. The GatedDeltaNet recurrence, the Accelerate BLAS state update, the RoPE
kernels, the full-attention path, the tokenizer, and the chat/tool-calling layer all work
unmodified. `MAX_K` is already 8, which is exactly the new top-k, so the multi-expert buffer
machinery needs no resizing.

Two things to ignore in the checkpoint: Qwen3.5-122B ships a vision encoder and an MTP
(multi-token prediction) module. Neither is needed for text inference; skip both during weight
extraction.

### Alternatives considered

**Qwen3-Next-80B-A3B** — also same architecture family (hidden 2048, 48 layers, 512 experts,
top-10). Projects to **~5.9 tok/s**, comfortably the fastest of the options, because its experts
are tiny (1.69 MiB each) and its 40.5 GiB expert set has much better cache residency. But it is
80B, not 100B, and it is an older, weaker model than the Qwen3.5 generation. Good fallback if
the 122B turns out too slow to be pleasant.

**gpt-oss-120b** — 117B total, 5.1B active, natively MXFP4 so no requantization quality loss.
Attractive on paper, but it is a *different architecture*: standard GQA with attention sinks and
alternating sliding-window layers, no Gated DeltaNet. You would delete flash-moe's most valuable
and hard-won code (the delta-net path) and write a new attention stack from scratch. Only worth
it if you specifically want that model.

**Qwen3.5-35B-A3B** — worth naming because it changes the problem entirely. Its expert set is
~15.2 GiB, which is *smaller than the page cache budget computed below*. It would sit
essentially resident in RAM with no meaningful SSD streaming, and run at 15–25 tok/s. If the
actual goal is "a good local model on this laptop" rather than "a 100B model on this laptop",
this is the answer and flash-moe's streaming machinery is unnecessary.

---

## 2. The hardware is the real constraint

flash-moe's design is tuned to a specific machine. The base M5 is worse on three of the four
axes that matter:

| | M3 Max (flash-moe) | M5 base (target) | Ratio |
|---|---|---|---|
| Unified memory | 48 GB | 24 GB | 0.50x |
| Memory bandwidth | ~400 GB/s | 153 GB/s | 0.38x |
| GPU cores | 40 | 10 (w/ neural accelerators) | 0.25x |
| SSD sequential read | see below | ~6.3 GB/s measured | ~1.2x |

**The SSD is the one piece of good news, and the README is misleading about it.** flash-moe
claims 17.5 GB/s sequential read. That is not what its own timings show. It reports K=4 experts
at 6.75 MiB each — 27.0 MiB — read in 2.41 ms, which is 11.75 GB/s *blended*, and that blend is
71% memcpy out of page cache plus 29% genuine SSD reads. Solving for the SSD leg (assuming
page-cache memcpy runs ~25 GB/s on a 400 GB/s part) gives **~5.1 GB/s of real random-read
bandwidth**. The M5's SSD benchmarks at ~6.3 GB/s sequential — roughly 2.5x faster than the M4's
— so for the 5 MiB random reads this workload actually issues, the M5 is a wash or slightly
ahead. The SSD is not what will hurt you.

**Memory bandwidth is what will hurt you.** It hits twice: the page-cache half of every expert
fetch is a memcpy, and the GPU's dequant matvec kernels are bandwidth-bound. Both scale with
that 0.38x.

---

## 3. Memory budget on 24 GB

Qwen3.5-122B-A10B at 4-bit with group-64 scales:

- Per expert: 5,308,416 B (5.06 MiB) — gate/up `[1024,3072]` + down `[3072,1024]`, weights plus BF16 scales and biases
- Per layer file: 256 experts x 5.06 MiB = **1.27 GiB**
- Full expert set: 48 layers = **60.75 GiB** (65.2 GB on disk)
- Non-expert weights: ~6.1B params -> **~3.2 GiB** mmap'd

Budget at a 32K context:

| Item | Size |
|---|---|
| Non-expert weights (mmap, read-only) | 3.20 GiB |
| KV cache — only the 12 full-attention layers | 0.75 GiB |
| GatedDeltaNet recurrent state | 0.14 GiB |
| Metal scratch + K=8 double-buffered expert slots | 0.32 GiB |
| macOS reserve | ~5.50 GiB |
| **Left for page cache** | **~14.1 GiB** |

That is 23% of the 61 GiB expert set held in cache.

**This is the quietly encouraging result.** flash-moe holds ~35 GB of a 202 GiB expert set — 17%
— and gets a 71% hit rate off it, because expert routing is heavily skewed toward a hot subset.
At 23% residency the "trust the OS" thesis holds *better* here than on the original machine, not
worse. Halving the RAM is more than compensated by shrinking the model 3.3x. Expect a hit rate
around 78–80%.

Note also that the GatedDeltaNet state is context-independent — 0.14 GiB whether you are at 8K or
1M tokens. Only the 12 full-attention layers carry a growing KV cache, at ~24.6 KB/token. Long
context is cheap on this architecture; even 128K only costs 3 GiB and still leaves ~11.8 GiB of
cache.

---

## 4. Projected throughput

Calibrating the I/O model to flash-moe's measured 11.75 GB/s blend, then scaling the page-cache
leg by memory bandwidth (25 -> 9.6 GB/s) and setting the SSD leg to 4.5 GB/s for random 5 MiB
reads on the M5:

| Configuration | Expert I/O | GPU | Per token | **tok/s** |
|---|---|---|---|---|
| 122B, native K=8, 78% hit | 5.54 ms/layer | 3.01 ms/layer | 410 ms | **2.44** |
| 122B, K=4 speed mode, 80% hit | 2.72 ms/layer | 3.01 ms/layer | 275 ms | **3.64** |
| Qwen3-Next-80B, K=10, 85% hit | 2.16 ms/layer | 1.39 ms/layer | 170 ms | **5.87** |

The GPU estimate scales flash-moe's measured 1.77 ms/layer by ~0.65x work (attention projections
fall with hidden², expert matvecs with hidden x moe_inter) divided by 0.38x bandwidth. It is the
softest number here — decode at batch size 1 is dispatch- and latency-bound rather than purely
bandwidth-bound, and the M5's per-core neural accelerators are a genuine unknown that could beat
this. Treat 3.01 ms/layer as a pessimistic bound.

Worth noticing: at K=8 the split is roughly 65% I/O, 35% GPU — the same shape as flash-moe. The
pipeline stays I/O-dominated, so the existing architecture remains the right one.

---

## 5. Port plan

### Step 1 — the hardcoded expert offsets (the actual bug risk)

This is the one trap. The 4-bit expert component offsets are written as **raw decimal literals**,
not derived from the config. In `infer.m` they appear at lines 1515–1517, 1611–1613, 1711–1713,
1797–1804, 1920–1922, and again around 2759 and 5484:

```c
gate_w_off = 0;        gate_s_off = 2097152;  gate_b_off = 2228224;
up_w_off   = 2359296;  up_s_off   = 4456448;  up_b_off   = 4587520;
down_w_off = 4718592;  down_s_off = 6815744;  down_b_off = 6946816;
```

Only the 2-bit path uses named constants (`GATE_W_OFF_2` and friends). Every one of those
literals is wrong for hidden=3072 and must become a derived constant. Do this **first**, as a
pure refactor against the 397B model, and verify output is bit-identical before changing any
dimension. The new values:

```c
#define EXPERT_GATE_W   0
#define EXPERT_GATE_S   (MOE_INTERMEDIATE * HIDDEN_DIM / 2)                    // 1572864
#define EXPERT_GATE_B   (EXPERT_GATE_S + MOE_INTERMEDIATE*(HIDDEN_DIM/GROUP_SIZE)*2)
#define EXPERT_UP_W     (EXPERT_GATE_B + MOE_INTERMEDIATE*(HIDDEN_DIM/GROUP_SIZE)*2)
/* ... same pattern for up_*, then down_* with rows/cols swapped ... */
#define EXPERT_SIZE     5308416
```

Silent corruption is the failure mode if you skip this — the reads succeed, they just land on the
wrong bytes.

### Step 2 — repack the experts

`repack_experts.py` has its own copy of the layout in the `COMPONENTS` table plus
`EXPERT_SIZE` / `NUM_EXPERTS` / `NUM_LAYERS`. Update shapes to gate/up `[1024, 3072]` and down
`[3072, 1024]`, sizes to 1572864 for weights and 98304 for each scale/bias block. Regenerate
`expert_index.json` from the new checkpoint.

Disk: ~65 GB of packed experts plus ~70 GB of source safetensors during conversion, so ~135 GB
peak. Fine on a 512 GB machine, but do not run it on a nearly-full disk.

### Step 3 — flip the four constants, extract weights, run

Update `extract_weights.py` for the new tensor names and layer count, then change the four
`#define`s. Validate against a reference implementation on a fixed prompt with greedy sampling
before trusting any timing.

### Step 4 — retune for the M5

Several of flash-moe's 58 discarded experiments were rejected for reasons that are specific to
the M3 Max and worth re-testing here:

- **`F_RDADVISE` prefetch** was rejected because SSD DMA slowed the GPU by 73% — the GPU was
  saturating a 400 GB/s memory controller and any background DMA caused arbitration stalls. The
  M5's balance between GPU demand and I/O demand is different enough that this deserves a fresh
  measurement rather than inheriting the conclusion.
- **Reducing K from 8 to 4** buys ~50% throughput and is the single biggest lever. But flash-moe
  cut 10 -> 4 out of *512* experts; cutting 8 -> 4 out of *256* discards a much larger share of
  the routing mass. Evaluate quality carefully — especially tool calling, which is what broke
  under 2-bit — before treating K=4 as usable.
- **2-bit quantization is off the table.** It already broke JSON and tool calling on the 397B; a
  122B model has less redundancy to absorb the error. If anything this port wants *more*
  precision, not less.
- **Thermals.** A fanless-budget 14" chassis under sustained GPU plus SSD load will throttle in a
  way the M3 Max did not. flash-moe already found CPU spin-polling cost 23% through thermal
  competition; expect that effect to be larger here.

---

## 6. Recommendation

Port to **Qwen3.5-122B-A10B**. It is the same architecture flash-moe already implements, it
reuses the tokenizer verbatim, and the engine work is four constants plus fixing the hardcoded
offsets into derived ones. Budget most of the effort for the repack pipeline and validation
rather than the inference engine.

Go in expecting **2–4 tok/s**, not flash-moe's 4.36. That is usable for batch and agentic work
where you are not watching tokens stream, and slow for interactive chat. If it lands at the
bottom of that range, Qwen3-Next-80B-A3B is a drop-in-shaped fallback at roughly 6 tok/s, and
Qwen3.5-35B-A3B abandons streaming entirely for 15–25 tok/s.

The thing to check before writing any code: run a Blackmagic-style random-read benchmark at
5 MiB block size on the actual machine. The entire projection rests on the SSD leg being ~4.5 GB/s,
and that number is inferred rather than measured.
