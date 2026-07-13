# Goal #1 — Single-GPU Load Balancing (GPU Arbiter)

**Branch delivery folder.** Nothing here touches the live `dina-server` source tree. Everything
is drop-in ready at its mirrored target path, with an explicit, reviewable wiring guide
(`dina-server/INTEGRATION.md`). This satisfies the "no disruption to the ecosystem" constraint:
you review, then wire, on your schedule.

```
goal-1-gpu-arbitration/
├── README.md                          ← this file: analysis, proofs, design
├── dina-server/
│   ├── src/modules/gpu/               ← the GPU Arbiter module (drop into src/modules/gpu)
│   │   ├── types.ts                   ← public type contract (lease/priority/config/snapshot)
│   │   ├── clock.ts                   ← injectable clock (real + virtual for tests)
│   │   ├── gpuArbiter.ts              ← the scheduler core (pure logic, singleton export)
│   │   ├── engines/ollamaEngine.ts    ← Ollama drain/restore adapter
│   │   └── index.ts                   ← barrel export
│   ├── test/gpu/gpuArbiterTest.ts     ← hermetic proof harness (43 assertions, all green)
│   ├── tsconfig.json                  ← scoped config to type-check/run the package standalone
│   └── INTEGRATION.md                 ← exact non-invasive wiring steps + ComfyUI usage
└── mirror-server/
    └── README.md                      ← (phase 1 requires no mirror-server changes — why)
```

---

## 1. Why this exists — the GPU-contention problem

Goal #1 (from the design conversation) is to build **`dina-visuals`**: a multi-tenant local
image/video generation subsystem (ComfyUI + FLUX/SDXL/Wan/HunyuanVideo + Demucs/WhisperX audio +
LoRA training). It runs on the **same single RTX 3090 Ti (24 GB)** that Ollama already uses for all
LLM work. The explicit sub-goal — *"analyze all other implementations so we're not pushing the
limits of our GPU, and if we are, load balance"* — is the gating risk, not a footnote.

### The measurement

dina-server pins a **warm LLM set resident 24h at a time** (`keep_alive: 24h`,
`OLLAMA_MAX_LOADED_MODELS=4`, `OLLAMA_NUM_PARALLEL=2` — see `ops/ollama.service.d-override.conf`).

| Resident LLM component | VRAM |
|---|---|
| `qwen2.5:3b` (chat)          | ~2.6 GB |
| `mistral:7b` (analysis)      | ~6.1 GB |
| `mxbai-embed-large` (embed)  | ~0.7 GB |
| KV cache (2 slots × 8k ctx, q8_0) | ~1–3 GB |
| **LLM baseline held while warm** | **~10–12 GB** |

Usable budget after the compositor/CUDA reserve + `OLLAMA_GPU_OVERHEAD=1 GB` is **~22 GB**, so a warm
Dina leaves only **~10–12 GB free**. Now overlay the visuals models from the plan:

| Visuals model | VRAM (typical) | Fits beside the warm LLM set? |
|---|---|---|
| SDXL | 7–10 GB | tight, sometimes |
| **FLUX.1 dev (bf16)** | **~23 GB** | ❌ needs the whole card |
| FLUX dev (FP8 / GGUF-Q8) | ~12–13 GB | ❌ not with LLM resident |
| FLUX (GGUF-Q4) | ~7–8 GB | ⚠️ only if LLM trimmed |
| **Wan 2.1 / 2.2** | **~30 GB+** | ❌ offloads even alone |
| **HunyuanVideo** | **~40–60 GB** | ❌ heavy sequential offload |
| LipSync (LatentSync/Hallo2) | 6–10 GB | ⚠️ |
| LoRA training | 10–24 GB | ❌ |

### The proof of risk (from the repo itself)

`ops/GPU_RUNBOOK.md` documents that the **#1 historical outage** was Ollama silently falling back to
**100% CPU** when VRAM was exceeded, and `src/modules/llm/gpuMonitor.ts` exists **solely to detect
that after the fact**. Launching a FLUX-dev job (step 1 of the visuals plan) while the LLM set is
resident forces exactly that state: either ComfyUI OOMs, or Ollama is shoved to CPU and every @Dina
chat / TruthStream call regresses to pre-GPU latency.

> **Conclusion: the card must be _time_-shared, not _space_-shared.** "Load balancing" on one GPU
> means **temporal arbitration** — a visuals job must first free Ollama's resident VRAM, run with the
> whole card, then hand it back — with interactive chat holding priority over background renders.

---

## 2. Inventory of existing GPU consumers ("all other implementations")

Every path that touches the GPU today, verified by reading the source:

| Consumer | File (call site) | Kind | Concurrency risk |
|---|---|---|---|
| Orchestrator LLM route | `core/orchestrator/index.ts:601,614,834` | generate/embed | one per request |
| @Dina chat | `core/orchestrator/index.ts:834` (`processMirrorChat`) | generate | interactive, high value |
| Mirror insights/truthstream/personal | `modules/mirror/index.ts` + processors | generate | user-triggered, can batch |
| Facial analysis | `modules/mirror/.../facialProcessor.ts` | generate | user-triggered |
| DIGIM embeddings | `modules/digim/web/memory/semanticMemory.ts:63,154` | embed | **fan-out** via `embedMany` (`:104`, `Promise.all`, default concurrency 3) |
| DIGIM research synthesis | `modules/digim/web/webResearchOrchestrator.ts` | generate | background pipeline |
| **Raw debug route** | `api/routes/index.ts:1930` | generate | **bypasses `DinaLLMManager` entirely** |

**Two structural facts that shape the design:**

1. There are **six independent `new DinaLLMManager()` instances** (orchestrator `:201`, WSS `:45`,
   mirror `:139`, mirror contextManager `:62`, digim webResearchOrchestrator `:108`, mirror
   dataProcessor), each with **its own `OllamaClient`**. A gate bolted onto one manager would miss
   the other five.
2. One route (`api/routes/index.ts:1930`) hits Ollama with a **raw `fetch`**, bypassing the manager
   layer completely.

→ The arbiter must therefore be a **true process-wide singleton** that *every* path funnels through
(it is — `export const gpuArbiter`), and the raw route must be routed through it too (see
`INTEGRATION.md`).

DIGIM's `embedMany` already does bounded fan-out (`Promise.all`, concurrency 3) — those calls will
funnel through the arbiter as low-priority `background` shared leases, so a research backfill can
never starve an interactive @Dina message or collide with a visuals render.

---

## 3. The design — `GpuArbiter`

A process-wide, cross-engine **VRAM-lease scheduler**. Its core is **pure scheduling logic**;
engine-specific behavior (freeing/re-warming VRAM) is **injected** via `EngineAdapter`, and time is
**injected** via `Clock`. This keeps concerns fully separated (no HTTP/DB/LLM knowledge in the
scheduler) and makes every timing path a deterministic proof.

```
   interactive chat ─┐
   analysis / embed ─┤                         ┌── drain() ──▶ Ollama (unload warm set)
   digim research  ──┼──▶  gpuArbiter.run(req) ─┤
   image / video   ──┤     (priority queue,     └── restore() ▶ Ollama (re-warm chat)
   LoRA training   ──┘      budget + leases)
                                │
                         one RTX 3090 Ti
```

**Lease model.** A caller requests a lease `{ label, engine, estVramMb, mode, priority }`:
- `mode: 'shared'` — coexists with other shared leases while the summed VRAM estimate stays within
  budget (LLM calls). `mode: 'exclusive'` — waits for the card to empty, drains competing engines,
  then owns the whole budget (image/video/LoRA).
- `priority: interactive | normal | background` — strict priority with **aging** so nothing starves.

**Safety properties (all proven — see §4):**
1. Budget is never over-subscribed by shared leases.
2. An exclusive lease never overlaps any other lease.
3. Strict priority (head-of-line) — interactive is served before background.
4. Competing engines are drained before, and restored after, an exclusive lease.
5. No starvation — a waiting request ages upward until it reaches the head.
6. Backpressure — a request that waits too long rejects (`GpuAcquireTimeoutError`) instead of hanging.
7. No deadlock — a crashed holder is force-released by a watchdog.
8. Idempotent release, abortable acquire, atomic grant decisions, graceful shutdown.

**Why injected drain/restore (not hard-coded):** the scheduler stays a single-concern unit that can
be reasoned about and tested in isolation; Ollama specifics live in `engines/ollamaEngine.ts`, and
ComfyUI/other engines register the same way without touching the core.

---

## 4. Proof — run it yourself

```bash
cd goal-1-gpu-arbitration/dina-server
# (one-time, if not already present) npm i --no-save typescript ts-node @types/node
npx tsc --noEmit -p tsconfig.json          # strict type-check — clean
npx ts-node test/gpu/gpuArbiterTest.ts     # behavioral proof
```

Result on this branch:

```
   DINA GPU ARBITER — PROOF HARNESS
▶ 1. Budget is never over-subscribed by shared leases
▶ 2. Exclusive lease never overlaps a shared lease
▶ 3. Drain competing engines before exclusive, restore after
▶ 4. Strict priority — interactive jumps a queued background exclusive
▶ 5. No starvation — an aged background job beats newer interactive work
▶ 6. Backpressure — acquire times out instead of hanging
▶ 7a. Watchdog force-releases a leaked lease (no deadlock)
▶ 7b. Idempotent release + abort
▶ 8. Auto-promotion, run() cleanup on throw, shutdown
▶ 9. Drain failure is survivable — exclusive still runs
   RESULTS: 43 passed, 0 failed
```

The harness is hermetic (no DB/Redis/LLM/GPU/network) and deterministic (a `VirtualClock` drives all
timeouts/watchdog/aging), so it runs in milliseconds and cannot flake.

---

## 5. How this plugs into `dina-visuals` (next phase)

The visuals worker wraps each GPU job in an **exclusive** lease:

```ts
await gpuArbiter.run(
  { label: `visuals.video:${jobId}`, engine: 'comfyui', estVramMb: 22000,
    mode: 'exclusive', priority: 'background', maxHoldMs: 30 * 60_000 },
  async () => comfy.runWorkflow(workflow),   // Ollama is already drained; full card is ours
);
```

- Interactive @Dina chat keeps priority; a queued render waits (and ages, so it can't be starved
  forever by a chatty group).
- On acquire, Ollama's warm set is unloaded automatically; on release, the chat model is re-warmed.
- The existing `gpuMonitor` remains the independent safety net that detects any residual CPU offload.

LLM calls, in turn, become **shared** leases (see `INTEGRATION.md`) — a one-line wrap in
`OllamaClient` covers all six manager instances at once.

---

## 6. Scope boundary for Goal #1

This folder delivers **only** the arbiter (the load-balancing foundation) plus its proofs and wiring
guide — deliberately, per the "handle one goal, test every edge case, ensure no disruption, then move
to the next" principle. The `dina-visuals` schema + module scaffold is the **next** goal and builds
directly on this. Nothing here is wired into the live tree until you approve `INTEGRATION.md`.
