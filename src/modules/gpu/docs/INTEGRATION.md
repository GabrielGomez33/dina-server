# Wiring the GPU Arbiter into dina-server (non-invasive)

Every step is additive and reversible. Nothing here changes request/response shapes or protocol.
Apply in order; each is independently safe.

> **Feature flag / instant rollback:** the arbiter is bypassable. If `DINA_GPU_ARBITER=off`, the
> wrapper helper (Step 3) calls straight through — behavior is byte-for-byte identical to today. Ship
> with it off, turn it on once you've watched one deploy.

---

## Step 0 — copy the module

Copy `src/modules/gpu/` → `src/modules/gpu/`
and `.../src/modules/gpu/tests/gpuArbiterTest.ts` → `src/modules/gpu/tests/gpuArbiterTest.ts`.

The module has **zero new dependencies** (only Node built-ins + `crypto.randomUUID`-free id counter).
It compiles under the existing root `tsconfig.json` once it lives under `src/`.

Add a test script to `package.json` (matches the existing `test:*` convention):

```json
"test:gpu": "ts-node src/modules/gpu/tests/gpuArbiterTest.ts",
```

---

## Step 1 — configure + register the Ollama engine at startup

In `src/core/orchestrator/index.ts`, inside `DinaCore.initialize()` **after** the LLM system is up
(right after `await this.llmManager.initialize()`), register the engine so exclusive visuals jobs can
drain Ollama:

```ts
import { gpuArbiter, OllamaEngineAdapter } from '../../modules/gpu';
import { getLlmConfig } from '../../modules/llm/llmConfig';

// ...in initialize(), Phase 2:
const cfg = getLlmConfig();
gpuArbiter.configure({
  budgetMb: cfg.vramBudgetMb,                                  // agree with the LLM budget
  reserveMb: parseInt(process.env.DINA_GPU_RESERVE_MB || '512', 10),
});
gpuArbiter.registerEngine(new OllamaEngineAdapter({ baseUrl: cfg.ollamaBaseUrl }));
```

That's the only startup change. LLM behavior is unaffected until Step 3.

---

## Step 2 — expose arbiter state on the diagnostics endpoint

In `DinaLLMManager.getDiagnostics()` (or the orchestrator status handler), add:

```ts
import { gpuArbiter } from '../gpu';
// ...
return { /* ...existing fields... */, gpuArbiter: gpuArbiter.snapshot() };
```

Operators now see live lease/queue/budget state next to the existing `gpu` residency block.

---

## Step 3 — funnel LLM calls through the arbiter (the one real wiring point)

All six `DinaLLMManager` instances share one `OllamaClient` class, so wrapping the **three**
`OllamaClient` methods covers every LLM path at once. Add a tiny private helper and wrap each method
body. Example for `generate()` in `src/modules/llm/manager.ts`:

```ts
import { gpuArbiter } from '../gpu';
import { estimateTotalVramMb } from './llmConfig';

// helper on OllamaClient
private lease(model: string, priority: 'interactive' | 'normal' | 'background') {
  return {
    label: `llm.generate:${model}`,
    engine: 'ollama',
    estVramMb: estimateTotalVramMb(model),   // reuse the existing footprint estimator
    mode: 'shared' as const,
    priority,
  };
}

async generate(prompt: string, model: string, opts?: OllamaGenerateOptions): Promise<OllamaResponse> {
  if (process.env.DINA_GPU_ARBITER === 'off') return this._generate(prompt, model, opts); // bypass
  return gpuArbiter.run(this.lease(model, opts?.priority ?? 'normal'), () => this._generate(prompt, model, opts));
}
```

(Rename the current body to `_generate` and leave it untouched.) Do the same for `embed`
(`priority: 'background'`, `mode: 'shared'`) and `generateStream` (`priority: 'interactive'`).

**Priority mapping** (pass `priority` down from callers, or default by method):
| Call path | priority |
|---|---|
| `processMirrorChat` / streaming chat | `interactive` |
| `llm_generate` / analysis / insights | `normal` |
| DIGIM `embedMany` / backfill / research synthesis | `background` |

Thread `priority` through `DinaLLMManager.generate(query, options)` by reading
`options.priority` (add it to the options type) — chat sets `interactive`, digim sets `background`.

---

## Step 4 — route the raw debug endpoint through the arbiter

`src/api/routes/index.ts:1930` (`POST /debug/ollama-raw`) bypasses the manager. Wrap its raw `fetch`
so it can't collide with a visuals render:

```ts
import { gpuArbiter } from '../../modules/gpu';
const generateResponse = await gpuArbiter.run(
  { label: 'debug.ollama-raw', engine: 'ollama', estVramMb: 7000, mode: 'shared', priority: 'normal' },
  () => fetch('http://localhost:11434/api/generate', { /* ...unchanged... */ }),
);
```

---

## Step 5 — (phase 2) the ComfyUI side

The visuals worker takes an **exclusive** lease per GPU job. No engine adapter is required for ComfyUI
to *acquire* (it's the consumer); optionally register a `ComfyEngineAdapter` later if you ever want
LLM jobs to be able to drain a paused ComfyUI.

```ts
await gpuArbiter.run(
  { label: `saga.${jobKind}:${jobId}`, engine: 'comfyui', estVramMb: cfg.budgetMb,
    mode: 'exclusive', priority: tenantPriority, maxHoldMs: 30 * 60_000 },
  async () => comfy.runWorkflow(workflow),   // Ollama already drained; whole card is ours
);
```

`maxHoldMs` should exceed your longest legitimate render (e.g. a HunyuanVideo clip) but stay finite so
a hung ComfyUI can't own the GPU forever — the watchdog reclaims it.

---

## Verification after wiring

1. `npm run test:gpu` — 43/43 green.
2. `npm run build` — compiles clean under the root tsconfig.
3. Smoke: with `DINA_GPU_ARBITER=on`, send an @Dina chat while a fake exclusive lease is held
   (`gpuArbiter.acquire({mode:'exclusive',...})` from a REPL) — the chat should queue, then complete
   the instant you release. Watch `getDiagnostics().gpuArbiter` for the queue depth.
4. Confirm `ollama ps` shows the warm set unload when an exclusive lease is taken, and re-warm after
   release.

## Rollback

Set `DINA_GPU_ARBITER=off` and redeploy — all wrapped calls pass straight through. Remove `src/modules/gpu`
only after confirming no import remains.
