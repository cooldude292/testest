#!/usr/bin/env python3
"""Memory/IO budget model for porting flash-moe to a 100B-class MoE on MacBook Pro M5 / 24GB.

Companion to flash-moe-100b-m5-port.md. The I/O model is calibrated against flash-moe's
published per-layer measurement (27.0 MiB in 2.41 ms at a 71%% page-cache hit rate), then
scaled to M5 memory bandwidth and SSD characteristics. Replace the constants with measured
numbers once you have hardware.
"""

MiB = 1024**2
GiB = 1024**3


def expert_bytes(hidden, moe_inter, bits=4, group=64, scale_bytes=2, bias_bytes=2):
    """One expert = gate[moe_inter,hidden] + up[moe_inter,hidden] + down[hidden,moe_inter]."""
    total = 0
    for rows, cols in ((moe_inter, hidden), (moe_inter, hidden), (hidden, moe_inter)):
        w = rows * cols * bits // 8
        groups = cols // group
        total += w + rows * groups * (scale_bytes + bias_bytes)
    return total


def report(name, hidden, layers, experts, moe_inter, topk, bits=4):
    e = expert_bytes(hidden, moe_inter, bits)
    layer = e * experts
    disk = layer * layers
    per_tok = e * topk * layers
    expert_params = experts * layers * 3 * hidden * moe_inter
    print(f"\n=== {name} (bits={bits}) ===")
    print(f"  expert size      : {e:>13,} B  ({e/MiB:6.3f} MiB)")
    print(f"  per-layer file   : {layer/GiB:6.3f} GiB")
    print(f"  total expert disk: {disk/GiB:6.2f} GiB  ({disk/1e9:6.1f} GB)")
    print(f"  expert params    : {expert_params/1e9:6.1f} B")
    print(f"  per-token I/O @K={topk}: {per_tok/MiB:7.1f} MiB")
    return e, disk, per_tok


# Reference: what flash-moe actually runs today
report("Qwen3.5-397B-A17B  [flash-moe today, M3 Max/48GB]", 4096, 60, 512, 1024, 4)
# Candidate ports
q122 = report("Qwen3.5-122B-A10B  [PORT TARGET]", 3072, 48, 256, 1024, 8)
report("Qwen3.5-122B-A10B  [K=4 speed mode]", 3072, 48, 256, 1024, 4)
report("Qwen3-Next-80B-A3B", 2048, 48, 512, 512, 10)
report("Qwen3.5-35B-A3B (est, fits in RAM)", 2048, 48, 128, 768, 8)

print("\n" + "=" * 68)
print("RAM BUDGET — MacBook Pro M5, 24 GB unified")
print("=" * 68)
# Qwen3.5-122B: 122B total - 116B expert = ~6.1B non-expert
nonexpert_params = 6.1e9
# 4-bit + (2B scale + 2B bias)/64 weights = 0.5 + 0.0625 bytes/param
nonexpert = nonexpert_params * (0.5 + 4 / 64)
kv_per_tok = 2 * 2 * 256 * 2 * 12          # k,v * kv_heads * head_dim * fp16 * 12 full-attn layers
gdn_state = 64 * 128 * 128 * 4 * 36        # v_heads * k_dim * v_dim * fp32 * 36 GDN layers
metal_scratch = 250 * MiB
expert_bufs = q122[0] * 8 * 2              # MAX_K=8, double-buffered
os_reserve = 5.5 * GiB

for ctx in (8192, 32768, 131072):
    kv = kv_per_tok * ctx
    used = nonexpert + kv + gdn_state + metal_scratch + expert_bufs + os_reserve
    cache = 24 * GiB - used
    print(f"\n  context {ctx:>7,} tokens")
    print(f"    non-expert weights (mmap) : {nonexpert/GiB:6.2f} GiB")
    print(f"    KV cache (12 full-attn)   : {kv/GiB:6.2f} GiB")
    print(f"    GDN recurrent state       : {gdn_state/GiB:6.2f} GiB  (context-independent)")
    print(f"    Metal scratch + expert buf: {(metal_scratch+expert_bufs)/GiB:6.2f} GiB")
    print(f"    macOS reserve             : {os_reserve/GiB:6.2f} GiB")
    print(f"    -> page cache for experts : {cache/GiB:6.2f} GiB "
          f"({100*cache/q122[1]:.1f}% of the {q122[1]/GiB:.0f} GiB expert set)")

print("\n" + "=" * 68)
print("THROUGHPUT MODEL")
print("=" * 68)
M3_BW, M5_BW = 400.0, 153.0       # GB/s unified memory bandwidth

# --- Step 1: calibrate the I/O model against flash-moe's OWN measurement ---
# Measured: K=4 * 6.75 MiB = 27.0 MiB/layer in 2.41 ms  =>  11.75 GB/s blended, at 71% hit.
# That blend = 71% memcpy out of page cache + 29% genuine SSD reads. Solve for the SSD leg,
# assuming page-cache memcpy runs at ~6% of peak unified bandwidth (25 GB/s on a 400 GB/s part).
meas_rate = (4 * 6.75 * MiB) / 1e9 / (2.41 / 1000)   # GB/s
C_m3 = 25.0
S_m3 = 0.29 / (1 / meas_rate - 0.71 / C_m3)
print(f"flash-moe measured: 27.0 MiB/layer in 2.41 ms = {meas_rate:.2f} GB/s blended @ 71% hit")
print(f"  => implied page-cache leg {C_m3:.1f} GB/s, true SSD leg {S_m3:.2f} GB/s")
print(f"  NOTE: the README's '17.5 GB/s sequential' is not what random 6.75 MiB reads deliver.")

# --- Step 2: scale each leg to the M5 ---
C_m5 = C_m3 * (M5_BW / M3_BW)     # memcpy scales with unified memory bandwidth
S_m5 = 4.5                        # M5 measures 6.3 GB/s sequential; derate for random 5 MiB reads
print(f"\nM5 legs: page-cache memcpy {C_m5:.1f} GB/s, SSD random {S_m5:.1f} GB/s")

# GPU: flash-moe 1.77 ms/layer. Ours has 0.75x hidden (attn projections ~0.5625x,
# expert matvecs ~0.75x -> call it 0.65x work) on 0.38x the memory bandwidth.
GPU_MS = 1.77 * 0.65 / (M5_BW / M3_BW)


def project(label, e_bytes, layers, K, hit, gpu_ms):
    rate = 1.0 / (hit / C_m5 + (1 - hit) / S_m5)
    io_mib = e_bytes * K / MiB
    io_ms = (io_mib * MiB) / (rate * 1e9) * 1000
    total = (io_ms + gpu_ms) * layers
    print(f"\n  {label}: K={K}, cache hit {hit:.0%}")
    print(f"    expert I/O : {io_mib:5.2f} MiB/layer @ {rate:4.2f} GB/s blended = {io_ms:5.2f} ms")
    print(f"    GPU        : {gpu_ms:5.2f} ms/layer")
    print(f"    per token  : {total:6.1f} ms  ->  {1000/total:5.2f} tok/s")


project("Qwen3.5-122B-A10B, full routing", q122[0], 48, 8, 0.78, GPU_MS)
project("Qwen3.5-122B-A10B, speed mode  ", q122[0], 48, 4, 0.80, GPU_MS)
# Qwen3-Next-80B: 40.5 GiB expert set vs ~14.6 GiB cache = 36% residency -> better hit rate.
# hidden 2048 & moe_inter 512 => ~0.3x the per-layer work of flash-moe.
project("Qwen3-Next-80B-A3B            ", 1769472, 48, 10, 0.85, 1.77 * 0.30 / (M5_BW / M3_BW))
