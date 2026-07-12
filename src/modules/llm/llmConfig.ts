// File: src/modules/llm/llmConfig.ts
// ============================================================================
// DINA LLM RUNTIME CONFIGURATION (single source of truth)
// ============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// Before this module, model selection, warmup lists, keep-alive, and GPU
// behaviour were scattered as hard-coded literals across manager.ts,
// intelligence.ts and the orchestrator. A single stray edit could silently
// (a) route a request to a model that does not fit the GPU, or (b) drop the
// keep-alive that holds models in VRAM — both of which crater latency.
//
// Everything that governs *which* model runs and *how* it touches the GPU now
// lives here, is driven by environment variables, and ships with safe defaults
// that match the currently-installed models on the 24 GB RTX 3090 Ti box. You
// can re-tune the whole system from the PM2 env block without recompiling.
//
// ENTERPRISE NOTES
// ----------------
// * Defaults are conservative and fit-on-GPU by design (no CPU offload).
// * Large models (codellama:34b, llama2:70b, …) are NEVER auto-selected.
//   They run only when explicitly requested AND oversized execution is opted
//   into (DINA_ALLOW_OVERSIZED=true or a per-request allow_oversized flag).
// * Nothing here performs I/O; it is pure configuration so it is safe to import
//   from anywhere without side effects.
// ============================================================================

export interface LlmRuntimeConfig {
  /** Base URL of the local Ollama daemon. */
  ollamaBaseUrl: string;

  // ---- Model tiers (the workhorses) ----
  /** Fast model for interactive chat / low-complexity work. */
  chatModel: string;
  /** Stronger model for analysis / synthesis / structured JSON. */
  analysisModel: string;
  /** Embedding model. */
  embedModel: string;

  // ---- Auto-selection governance ----
  /**
   * The ONLY models the complexity analyzer is allowed to choose from when no
   * explicit model_preference is supplied. Keeps automatic routing inside the
   * set of models that are known to fit the GPU.
   */
  autoModels: string[];
  /** Models pre-loaded into VRAM on startup (cold-start prevention). */
  warmupModels: string[];

  // ---- VRAM governance (the "no CPU offload" guarantee) ----
  /** Usable VRAM budget in MB (total card minus a safety reserve). */
  vramBudgetMb: number;
  /**
   * When false (default) a model whose estimated footprint exceeds the budget
   * is refused and a fitting fallback is used instead — this is what prevents
   * Ollama from silently spilling layers onto the CPU. Set true only if you
   * deliberately want to run oversized models and accept partial CPU execution.
   */
  allowOversized: boolean;
  /** Approximate loaded VRAM footprint per model, in MB (Q4-ish, conservative). */
  modelFootprints: Record<string, number>;

  // ---- Ollama runtime options ----
  /** Layers to force onto the GPU. 999 == "offload everything that fits". */
  numGpu: number;
  /** Context window (tokens). Larger = more KV-cache VRAM but fewer truncations. */
  numCtx: number;
  /** keep_alive passed to Ollama so warm models stay resident in VRAM. */
  keepAlive: string;

  // ---- GPU residency monitor ----
  monitorEnabled: boolean;
  monitorIntervalMs: number;

  // ---- Timeouts ----
  /** Timeout for lightweight Ollama calls (list/embed). */
  requestTimeoutMs: number;
  /** Timeout for generation calls (large analyses can be slow even on GPU). */
  generateTimeoutMs: number;
}

// ----------------------------------------------------------------------------
// ENV PARSING HELPERS (defensive — never throw on bad input)
// ----------------------------------------------------------------------------

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.trim().length > 0 ? v.trim() : fallback;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Parse a comma-separated env var into a de-duplicated, trimmed string list. */
function envCsv(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return dedupe(fallback);
  const parts = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? dedupe(parts) : dedupe(fallback);
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list));
}

// ----------------------------------------------------------------------------
// DEFAULT MODEL FOOTPRINTS (MB) — conservative loaded-in-VRAM estimates.
// These intentionally run a little high (weights + runtime overhead) so the
// budget check errs on the side of NOT offloading to CPU. Override or extend
// with DINA_MODEL_VRAM_JSON (a JSON object of { "model:tag": MB }).
// ----------------------------------------------------------------------------

const DEFAULT_FOOTPRINTS_MB: Record<string, number> = {
  // Embedding
  'mxbai-embed-large': 1000,
  // Small / fast
  'qwen2.5:3b': 3000,
  'qwen3:4b': 4200,
  'llama3.2:3b': 3200,
  // 7-8B class
  'mistral:7b': 6500,
  mistral: 6500,
  'llama3.1:8b': 6800,
  'qwen2.5:7b': 6500,
  'qwen3:8b': 6800,
  // 12-14B class
  'phi4:14b': 10500,
  phi4: 10500,
  'gemma3:12b': 9500,
  'qwen2.5:14b': 11000,
  'qwen3:14b': 11000,
  // 24-32B class (tight on 24 GB)
  'mistral-small3.1:24b': 16500,
  'mistral-small3.1': 16500,
  'gemma3:27b': 19000,
  'qwen3:30b-a3b': 20000,
  'qwen3:32b': 21000,
  // Large (do NOT fit a 24 GB card alongside anything)
  'codellama:34b': 21000,
  'llama2:70b': 42000,
  // Vision-language models (DINA Vision / DIVIS). Weights + vision encoder.
  moondream: 1900,
  'llava:7b': 5500,
  llava: 5500,
  'llava:13b': 9000,
  'llava-llama3': 6500,
  'llava-llama3:8b': 6500,
  'bakllava:7b': 5500,
  'llama3.2-vision': 9500,
  'llama3.2-vision:11b': 9500,
  'minicpm-v': 6000,
  'minicpm-v:8b': 6000,
  'qwen2.5vl:7b': 7000,
  'qwen2-vl:7b': 7000,
  'llava:34b': 21000,
  'llama3.2-vision:90b': 55000,
};

function parseFootprintOverrides(): Record<string, number> {
  const raw = process.env.DINA_MODEL_VRAM_JSON;
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = typeof v === 'number' ? v : parseInt(String(v), 10);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return out;
  } catch (err) {
    console.warn(`⚠️ [llmConfig] Ignoring invalid DINA_MODEL_VRAM_JSON: ${(err as Error).message}`);
    return {};
  }
}

// ----------------------------------------------------------------------------
// CONFIG SINGLETON (frozen) — built once at module load.
// ----------------------------------------------------------------------------

function buildConfig(): LlmRuntimeConfig {
  const chatModel = envStr('DINA_CHAT_MODEL', 'qwen2.5:3b');
  const analysisModel = envStr('DINA_ANALYSIS_MODEL', 'mistral:7b');
  const embedModel = envStr('DINA_EMBED_MODEL', 'mxbai-embed-large');

  const autoModels = envCsv('DINA_AUTO_MODELS', [chatModel, analysisModel]);
  const warmupModels = envCsv('DINA_WARMUP_MODELS', [chatModel, analysisModel, embedModel]);

  const modelFootprints: Record<string, number> = {
    ...DEFAULT_FOOTPRINTS_MB,
    ...parseFootprintOverrides(),
  };

  return Object.freeze({
    ollamaBaseUrl: envStr('OLLAMA_BASE_URL', 'http://localhost:11434'),

    chatModel,
    analysisModel,
    embedModel,

    autoModels,
    warmupModels,

    // RTX 3090 Ti = 24 GB. Reserve ~2 GB for display/CUDA context → 22 GB budget.
    vramBudgetMb: envInt('DINA_VRAM_BUDGET_MB', 22000),
    allowOversized: envBool('DINA_ALLOW_OVERSIZED', false),
    modelFootprints,

    numGpu: envInt('DINA_NUM_GPU', 999),
    numCtx: envInt('DINA_NUM_CTX', 8192),
    keepAlive: envStr('DINA_KEEP_ALIVE', '24h'),

    monitorEnabled: envBool('DINA_GPU_MONITOR', true),
    monitorIntervalMs: envInt('DINA_GPU_MONITOR_INTERVAL_MS', 60000),

    requestTimeoutMs: envInt('OLLAMA_TIMEOUT_MS', 60000),
    generateTimeoutMs: envInt('OLLAMA_GENERATE_TIMEOUT_MS', 600000),
  });
}

let _config: LlmRuntimeConfig | null = null;

/** Returns the process-wide, immutable LLM runtime config. */
export function getLlmConfig(): LlmRuntimeConfig {
  if (!_config) {
    _config = buildConfig();
    logConfigOnce(_config);
  }
  return _config;
}

let _logged = false;
function logConfigOnce(cfg: LlmRuntimeConfig): void {
  if (_logged) return;
  _logged = true;
  console.log('🧩 [llmConfig] LLM runtime configuration loaded:');
  console.log(`   • chat=${cfg.chatModel}  analysis=${cfg.analysisModel}  embed=${cfg.embedModel}`);
  console.log(`   • autoModels=[${cfg.autoModels.join(', ')}]`);
  console.log(`   • warmup=[${cfg.warmupModels.join(', ')}]`);
  console.log(`   • vramBudget=${cfg.vramBudgetMb}MB  allowOversized=${cfg.allowOversized}  numCtx=${cfg.numCtx}  numGpu=${cfg.numGpu}  keepAlive=${cfg.keepAlive}`);
}

// ----------------------------------------------------------------------------
// FOOTPRINT / FIT HELPERS
// ----------------------------------------------------------------------------

/** Strip an Ollama tag: "qwen2.5:3b" -> "qwen2.5". */
function baseName(model: string): string {
  const i = model.indexOf(':');
  return i === -1 ? model : model.slice(0, i);
}

/**
 * Best-effort estimate of a model's loaded VRAM footprint in MB.
 * Resolution order: exact tag → base name → "<N>b" heuristic → safe default.
 */
export function estimateModelVramMb(model: string, cfg: LlmRuntimeConfig = getLlmConfig()): number {
  if (!model) return 8000;
  const table = cfg.modelFootprints;

  if (table[model] !== undefined) return table[model];

  const base = baseName(model);
  if (table[base] !== undefined) return table[base];

  // Heuristic: pull the parameter count out of the name (e.g. "...:14b", "30b-a3b").
  const m = model.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (m) {
    const billions = parseFloat(m[1]);
    if (Number.isFinite(billions) && billions > 0) {
      // ~0.7 GB per B (Q4 weights) + ~1.5 GB runtime/KV headroom.
      return Math.round(billions * 700 + 1500);
    }
  }

  // Unknown model → assume mid-size so the budget check stays conservative.
  return 8000;
}

/**
 * Rough KV-cache cost (MB) for a given context window. Scales linearly; kept
 * deliberately conservative so the fit check leaves CPU-offload headroom.
 */
export function estimateKvCacheMb(numCtx: number): number {
  const ctx = Number.isFinite(numCtx) && numCtx > 0 ? numCtx : 4096;
  return Math.round((ctx / 1024) * 256); // ~256 MB per 1k tokens
}

/** Total estimated VRAM (weights + KV cache) for running `model`. */
export function estimateTotalVramMb(model: string, cfg: LlmRuntimeConfig = getLlmConfig()): number {
  return estimateModelVramMb(model, cfg) + estimateKvCacheMb(cfg.numCtx);
}

/** True if the model is expected to exceed the VRAM budget (would offload to CPU). */
export function isOversized(model: string, cfg: LlmRuntimeConfig = getLlmConfig()): boolean {
  return estimateTotalVramMb(model, cfg) > cfg.vramBudgetMb;
}

/** True if the model is safe to run fully on the GPU within budget. */
export function fitsBudget(model: string, cfg: LlmRuntimeConfig = getLlmConfig()): boolean {
  return !isOversized(model, cfg);
}