// File: src/modules/llm/manager.ts
import { v4 as uuidv4 } from 'uuid';
import { performance } from 'perf_hooks';
import { database } from '../../config/database/db';
import { redisManager } from '../../config/redis';
import { DinaUniversalMessage } from '../../core/protocol'; // FIXED: Corrected import path
import {
  llmIntelligenceEngine,
  contextMemorySystem,
  performanceOptimizer, // FIXED: Added missing import
  ModelType,
  ComplexityScore,
  LLMResponse
} from './intelligence';
import {
  getLlmConfig,
  estimateTotalVramMb,
  isOversized,
  fitsBudget,
} from './llmConfig';
import { gpuMonitor } from './gpuMonitor';
import { gpuArbiter } from '../gpu';
import { LeasePriority } from '../gpu/types';

// ============================================================================
// GPU ARBITER GATE (dark-launch flag)
// ============================================================================
// When DINA_GPU_ARBITER=on, every Ollama call below runs inside a SHARED
// arbiter lease so LLM work queues fairly against exclusive SAGA renders
// (which drain the warm set first). When 'off' (the shipping default) every
// call passes straight through — byte-for-byte the pre-arbiter behaviour.
// One helper, read per-call, so the flag can be flipped with a pm2 reload.
function arbiterEnabled(): boolean {
  return (process.env.DINA_GPU_ARBITER || 'off').trim().toLowerCase() === 'on';
}

interface OllamaResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface OllamaEmbeddingResponse {
  model: string;
  embeddings: number[];
  total_duration?: number;
}

// ============================================================================
// OLLAMA GENERATE OPTIONS
// Configurable options passed through to the Ollama API.
// ============================================================================

interface OllamaGenerateOptions {
  /** System prompt providing persona and context instructions to the model */
  system?: string;
  /** Maximum number of tokens to predict (Ollama's num_predict) */
  maxTokens?: number;
  /** Sampling temperature (0.0 - 1.0). Lower = more deterministic. */
  temperature?: number;
  /** Override GPU layer count (defaults to llmConfig.numGpu = force full GPU). */
  numGpu?: number;
  /** Override context window (defaults to llmConfig.numCtx). */
  numCtx?: number;
  /** Override keep_alive (defaults to llmConfig.keepAlive). */
  keepAlive?: string;
  /** GPU-arbiter scheduling urgency (default 'normal'; chat paths pass 'interactive'). */
  priority?: 'interactive' | 'normal' | 'background';
}

export class OllamaClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl?: string, timeoutMs?: number) {
    const cfg = getLlmConfig();
    this.baseUrl = baseUrl ?? cfg.ollamaBaseUrl;
    this.timeoutMs = timeoutMs ?? cfg.requestTimeoutMs;
    console.log(`🚀 Initializing OllamaClient with baseUrl: ${this.baseUrl}`);
  }

  async listModels(): Promise<string[]> {
    try {
      console.log('📋 Fetching available models from Ollama...');
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(this.timeoutMs) });
      // FIXED: Proper type casting
      const data = await response.json() as { models: Array<{ name: string }> };
      const models = data.models.map((m: { name: string }) => m.name);
      console.log(`✅ Available models: ${models.join(', ')}`);
      return models;
    } catch (error) {
      console.error(`❌ Failed to list models: ${error}`);
      return [];
    }
  }

  /**
   * Generate a response from Ollama.
   *
   * @param prompt  - The user-facing prompt / query text
   * @param model   - Ollama model identifier (e.g. "mistral:7b")
   * @param opts    - Optional: system prompt, maxTokens, temperature, GPU opts
   *
   * GPU NOTE: num_gpu / num_ctx / keep_alive now come from llmConfig (env-driven)
   *           so the GPU is used explicitly and consistently. num_gpu=999 forces
   *           Ollama to offload every layer that fits to the GPU; the upstream
   *           resolveModel() guard ensures the model actually fits in VRAM so
   *           this does not trigger a CPU split.
   */
  async generate(prompt: string, model: string, opts?: OllamaGenerateOptions): Promise<OllamaResponse> {
    if (!arbiterEnabled()) return this._generate(prompt, model, opts);
    return gpuArbiter.run(
      {
        label: `llm.generate:${model}`,
        engine: 'ollama',
        estVramMb: estimateTotalVramMb(model),
        mode: 'shared',
        priority: (opts?.priority ?? 'normal') as LeasePriority,
      },
      () => this._generate(prompt, model, opts),
    );
  }

  private async _generate(prompt: string, model: string, opts?: OllamaGenerateOptions): Promise<OllamaResponse> {
    const cfg = getLlmConfig();
    const hasSystem = opts?.system && opts.system.trim().length > 0;
    console.log(`📡 Sending request to Ollama for model ${model}, prompt: "${prompt.substring(0, 50)}..."`);
    if (hasSystem) {
      console.log(`📡 System prompt provided (${opts!.system!.length} chars)`);
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.error(`⏰ Ollama generate timeout for model ${model}`);
        controller.abort();
      }, cfg.generateTimeoutMs);

      // Build the request body. Include "system" only when provided so that
      // requests without a system prompt behave identically to before.
      const requestBody: Record<string, any> = {
        model,
        prompt,
        stream: false,
        keep_alive: opts?.keepAlive ?? cfg.keepAlive, // Keep model loaded in GPU memory to avoid 150s+ cold starts
        options: {
          num_predict: opts?.maxTokens || 500,
          temperature: opts?.temperature ?? 0.7,
          num_gpu: opts?.numGpu ?? cfg.numGpu, // force full GPU offload
          num_ctx: opts?.numCtx ?? cfg.numCtx,
        }
      };

      // FIX: Pass the system prompt to Ollama when available.
      // This is the core fix — the system prompt carries Dina's persona,
      // group context, and conversation history that the model MUST see.
      if (hasSystem) {
        requestBody.system = opts!.system;
      }

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama HTTP ${response.status}: ${response.statusText} - ${errorText}`);
      }

      // THE FIX: Ollama returns NDJSON (newline-delimited JSON) even with stream:false
      const responseText = await response.text();
      console.log(`🔍 OLLAMA DEBUG: Raw response length: ${responseText.length}, first 100 chars: ${responseText.substring(0, 100)}`);

      // Parse NDJSON: Split by newlines and parse each JSON object
      const lines = responseText.trim().split('\n').filter(line => line.trim());
      console.log(`🔍 OLLAMA DEBUG: Found ${lines.length} JSON lines`);

      if (lines.length === 0) {
        throw new Error('Empty response from Ollama');
      }

      // Ollama sends multiple JSON objects, the last one has done:true and the complete response
      let finalResponse: any = null;
      let accumulatedResponse = '';

      for (const line of lines) {
        try {
          const jsonObj = JSON.parse(line);
          console.log(`🔍 OLLAMA DEBUG: Parsed JSON with keys: ${Object.keys(jsonObj).join(', ')}`);

          // Accumulate response parts
          if (jsonObj.response) {
            accumulatedResponse += jsonObj.response;
          }

          // The final object has done:true
          if (jsonObj.done === true) {
            finalResponse = jsonObj;
            // Set the complete accumulated response
            finalResponse.response = accumulatedResponse;
            break;
          }
        } catch (parseError) {
          console.error(`🔍 OLLAMA DEBUG: Failed to parse JSON line: ${line.substring(0, 100)}`);
          console.error(`🔍 OLLAMA DEBUG: Parse error: ${parseError}`);
        }
      }

      if (!finalResponse) {
        // Fallback: use the last valid JSON object
        const lastLine = lines[lines.length - 1];
        finalResponse = JSON.parse(lastLine);
        finalResponse.response = accumulatedResponse || finalResponse.response;
      }

      console.log(`✅ Received Ollama response for model ${model}: "${(finalResponse.response || '').substring(0, 50)}..."`);
      console.log(`🔍 OLLAMA DEBUG: Final response keys: ${Object.keys(finalResponse).join(', ')}`);

      return finalResponse as OllamaResponse;

    } catch (error) {
      console.error(`❌ Ollama generate error: ${error}`);
      //console.error(`❌ Error type: ${error.constructor.name}`);
      if (error instanceof SyntaxError) {
        console.error(`❌ This is a JSON parsing error - Ollama is returning malformed JSON`);
      }
      throw error;
    }
  }

  /**
   * Stream a response from Ollama.
   *
   * FIX: Added system prompt support, matching the generate() fix.
   */
  async *generateStream(prompt: string, model: string = 'mistral:7b', options?: {
    maxTokens?: number;
    temperature?: number;
    system?: string;
    numGpu?: number;
    numCtx?: number;
    keepAlive?: string;
    priority?: 'interactive' | 'normal' | 'background';
  }): AsyncGenerator<{ content: string; done: boolean }> {
    if (!arbiterEnabled()) {
      yield* this._generateStream(prompt, model, options);
      return;
    }
    // Streaming holds its lease for the WHOLE stream (a human is reading it) —
    // acquire/try/finally rather than run(), since the generator outlives the call.
    const lease = await gpuArbiter.acquire({
      label: `llm.stream:${model}`,
      engine: 'ollama',
      estVramMb: estimateTotalVramMb(model),
      mode: 'shared',
      priority: (options?.priority ?? 'interactive') as LeasePriority,
    });
    try {
      yield* this._generateStream(prompt, model, options);
    } finally {
      lease.release();
    }
  }

  private async *_generateStream(prompt: string, model: string = 'mistral:7b', options?: {
    maxTokens?: number;
    temperature?: number;
    system?: string;
    numGpu?: number;
    numCtx?: number;
    keepAlive?: string;
    priority?: 'interactive' | 'normal' | 'background';
  }): AsyncGenerator<{ content: string; done: boolean }> {
    const cfg = getLlmConfig();
    console.log(`📡 Starting streaming generation for model ${model}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.error(`⏰ Ollama stream timeout for model ${model}`);
      controller.abort();
    }, cfg.generateTimeoutMs);

    try {
      const requestBody: Record<string, any> = {
        model,
        prompt,
        stream: true,
        keep_alive: options?.keepAlive ?? cfg.keepAlive,
        options: {
          num_predict: options?.maxTokens || 1000,
          temperature: options?.temperature || 0.7,
          num_gpu: options?.numGpu ?? cfg.numGpu,
          num_ctx: options?.numCtx ?? cfg.numCtx,
        }
      };

      // FIX: Pass system prompt for streaming as well
      if (options?.system && options.system.trim().length > 0) {
        requestBody.system = options.system;
      }

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama HTTP ${response.status}: ${response.statusText} - ${errorText}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          if (buffer.trim()) {
            try {
              const json = JSON.parse(buffer);
              yield { content: json.response || '', done: json.done || true };
            } catch (e) {
              // Ignore parse errors on final chunk
            }
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const json = JSON.parse(line);
              yield { content: json.response || '', done: json.done || false };
              if (json.done) return;
            } catch (e) {
              console.warn(`⚠️ Failed to parse streaming chunk: ${line.substring(0, 50)}`);
            }
          }
        }
      }
    } catch (error) {
      clearTimeout(timeoutId);
      console.error(`❌ Ollama stream error: ${error}`);
      throw error;
    }
  }

  async embed(input: string, model?: string): Promise<OllamaEmbeddingResponse> {
    if (!arbiterEnabled()) return this._embed(input, model);
    const embedModelName = model || getLlmConfig().embedModel;
    return gpuArbiter.run(
      {
        label: `llm.embed:${embedModelName}`,
        engine: 'ollama',
        estVramMb: estimateTotalVramMb(embedModelName),
        mode: 'shared',
        priority: 'background', // embeddings are pipeline work — never block chat
      },
      () => this._embed(input, model),
    );
  }

  private async _embed(input: string, model?: string): Promise<OllamaEmbeddingResponse> {
    const cfg = getLlmConfig();
    const embedModel = model || cfg.embedModel;
    console.log(`📡 Generating embedding for input: "${input.substring(0, 50)}..." using ${embedModel}`);
    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embedModel, input, keep_alive: cfg.keepAlive }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      // FIXED: Proper type casting
      const data = await response.json() as OllamaEmbeddingResponse;
      console.log(`✅ Generated embedding: ${data.embeddings.length} dimensions`);
      return data;
    } catch (error) {
      console.error(`❌ Ollama embed error: ${error}`);
      // Fallback mock response
      return {
        model: embedModel,
        embeddings: Array(1024).fill(0).map(() => Math.random()), // mxbai-embed-large: ~1024 dimensions
        total_duration: 1000
      };
    }
  }
}

export class DinaLLMManager {
  // Shared warmup promise — all instances in this process await the same
  // warmup work.  Unlike a boolean flag this guarantees the warmup actually
  // finishes before any instance considers it "done", and only one warmup
  // ever runs per process.
  private static _warmupPromise: Promise<void> | null = null;
  private ollama: OllamaClient;
  private availableModels: string[] = [];
  private _isInitialized: boolean = false;

  constructor() {
    this.ollama = new OllamaClient();
    console.log('🚀 Initializing DinaLLMManager');
  }

  // FIXED: Made public
  public async initialize(): Promise<void> {
    try {
      this.availableModels = await this.ollama.listModels();
      this._isInitialized = true;
      console.log('✅ DinaLLMManager initialized successfully');

      // Start the GPU residency monitor (idempotent across instances). This is
      // what catches a silent CPU fallback (e.g. driver/library mismatch) and
      // raises a loud, observable alert instead of degrading quietly.
      if (getLlmConfig().monitorEnabled) {
        gpuMonitor.start();
      }

      // Warm up primary models so they're loaded in GPU memory and ready for requests.
      // This eliminates the 150-160s cold start on the first TruthStream analysis.
      this.warmupModels().catch(err => {
        console.warn(`⚠️ Model warmup failed (non-fatal): ${err.message || err}`);
      });
    } catch (error) {
      console.error(`❌ Failed to initialize DinaLLMManager: ${error}`);
      this._isInitialized = false;
      throw error;
    }
  }

  /**
   * Pre-load models into GPU memory by sending a minimal prompt.
   * Runs in the background (fire-and-forget) so it doesn't block startup.
   * The keep_alive (llmConfig.keepAlive) in generate() ensures they stay loaded.
   */
  private async warmupModels(): Promise<void> {
    // If another instance already started warming, just wait for it.
    if (DinaLLMManager._warmupPromise) {
      return DinaLLMManager._warmupPromise;
    }

    // Skip if this instance has no models (shouldn't happen, but be safe).
    if (this.availableModels.length === 0) {
      console.log('⏩ Skipping warmup — no available models on this instance');
      return;
    }

    // Capture the promise so other instances can await it instead of re-running.
    DinaLLMManager._warmupPromise = this.doWarmup();
    return DinaLLMManager._warmupPromise;
  }

  private async doWarmup(): Promise<void> {
    const cfg = getLlmConfig();
    // Warm the configured set (chat + analysis + embed by default). Driven by
    // llmConfig so the warm set always tracks the models we actually use.
    const modelsToWarm = cfg.warmupModels;
    const available = this.availableModels;
    console.log(`🔥 Starting warmup. Available models: [${available.join(', ')}]`);
    console.log(`🔥 Models to warm: [${modelsToWarm.join(', ')}]`);

    for (const model of modelsToWarm) {
      if (!this.isInstalled(model, available)) {
        console.log(`⏩ Skipping warmup for ${model} (not found in available models)`);
        continue;
      }

      // Never warm a model that cannot fit the GPU (would force a CPU load and
      // evict the small models we actually want resident).
      if (isOversized(model, cfg) && !cfg.allowOversized) {
        console.warn(`🛡️ Skipping warmup for oversized model ${model} (~${estimateTotalVramMb(model, cfg)}MB > ${cfg.vramBudgetMb}MB budget)`);
        continue;
      }

      try {
        console.log(`🔥 Warming up model: ${model}...`);
        const startTime = Date.now();

        if (model.includes('embed')) {
          await this.ollama.embed('warmup', model);
        } else {
          // Minimal prompt — just enough to load the model into GPU memory
          await this.ollama.generate('Hi', model, { maxTokens: 1, temperature: 0 });
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ Model ${model} warmed up in ${elapsed}s — ready for requests`);
      } catch (err: any) {
        console.warn(`⚠️ Failed to warm up ${model}: ${err.message || err}`);
      }
    }
  }

  public get isInitialized(): boolean {
    return this._isInitialized;
  }

  // ==========================================================================
  // MODEL RESOLUTION GUARDRAIL ("no silent CPU offload")
  // ==========================================================================

  /**
   * Decide whether a model name is installed on the local Ollama.
   * Tagged names (e.g. "mistral:7b") require an exact match; untagged names
   * (e.g. "mxbai-embed-large") match any tag of the same family.
   */
  private isInstalled(model: string, available: string[]): boolean {
    if (!model) return false;
    if (available.includes(model)) return true;
    if (!model.includes(':')) {
      // family match: "mistral" matches "mistral:7b" / "mistral:latest"
      return available.some(a => a === model || a.startsWith(`${model}:`));
    }
    return false;
  }

  /**
   * Pick the best model that is BOTH installed and fits the VRAM budget.
   * Preference order: configured chat model → largest fitting auto model →
   * any fitting installed model → smallest installed model (last resort).
   */
  private pickFittingAutoModel(available: string[]): string {
    const cfg = getLlmConfig();

    const installedAuto = cfg.autoModels.filter(m => this.isInstalled(m, available));
    const fittingAuto = installedAuto.filter(m => fitsBudget(m, cfg));
    if (fittingAuto.length > 0) {
      if (fittingAuto.includes(cfg.chatModel)) return cfg.chatModel;
      // Largest fitting auto model = best quality that still stays on the GPU.
      return fittingAuto.slice().sort((a, b) => estimateTotalVramMb(b, cfg) - estimateTotalVramMb(a, cfg))[0];
    }

    // No auto model available/fits → any installed model that fits.
    const anyFitting = available.filter(m => fitsBudget(m, cfg));
    if (anyFitting.length > 0) {
      return anyFitting.slice().sort((a, b) => estimateTotalVramMb(a, cfg) - estimateTotalVramMb(b, cfg))[0];
    }

    // Nothing fits the budget (misconfiguration) → smallest installed model.
    if (available.length > 0) {
      return available.slice().sort((a, b) => estimateTotalVramMb(a, cfg) - estimateTotalVramMb(b, cfg))[0];
    }

    // No model list at all → fall back to the configured chat model and let
    // Ollama attempt it (covers a transient listModels() failure).
    return cfg.chatModel;
  }

  /**
   * Resolve the model that will actually be sent to Ollama.
   * Enforces three rules, in order:
   *   1. Honour an explicit, installed model_preference.
   *   2. Never use a model that isn't installed.
   *   3. Never auto-run a model that exceeds the VRAM budget (it would offload
   *      to CPU). Oversized models run ONLY via explicit opt-in
   *      (DINA_ALLOW_OVERSIZED=true or options.allow_oversized === true).
   */
  private resolveModel(
    requested: string | undefined,
    recommended: string,
    available: string[],
    opts?: any
  ): string {
    const cfg = getLlmConfig();
    const allowOversized = cfg.allowOversized || opts?.allow_oversized === true;
    const haveList = available.length > 0;

    const wasExplicit = !!(requested && String(requested).trim());
    let candidate = wasExplicit ? String(requested).trim() : recommended;
    if (!candidate) candidate = cfg.chatModel;

    // Rule 2: must be installed (only enforceable when we have a model list).
    if (haveList && !this.isInstalled(candidate, available)) {
      const fallback = this.pickFittingAutoModel(available);
      console.warn(`⚠️ [resolveModel] Model "${candidate}" is not installed — using "${fallback}" instead.`);
      candidate = fallback;
    }

    // Rule 3: must fit the GPU unless oversized execution is opted into.
    if (isOversized(candidate, cfg) && !allowOversized) {
      const fallback = this.pickFittingAutoModel(available);
      console.warn(
        `🛡️ [resolveModel] "${candidate}" (~${estimateTotalVramMb(candidate, cfg)}MB) exceeds the VRAM budget ` +
        `(${cfg.vramBudgetMb}MB) and would offload to CPU. ` +
        `${wasExplicit ? 'Explicit request' : 'Auto-selection'} downgraded to "${fallback}". ` +
        `Set DINA_ALLOW_OVERSIZED=true or pass options.allow_oversized to override.`
      );
      candidate = fallback;
    } else if (isOversized(candidate, cfg) && allowOversized) {
      console.warn(`⚠️ [resolveModel] Running oversized model "${candidate}" by explicit opt-in — it may partially execute on CPU.`);
    }

    // Final safety net.
    if (haveList && !this.isInstalled(candidate, available)) {
      const fallback = this.pickFittingAutoModel(available);
      console.warn(`⚠️ [resolveModel] Final candidate "${candidate}" still not installed; using "${fallback}".`);
      candidate = fallback;
    }

    return candidate;
  }

  async processLLMRequest(message: DinaUniversalMessage): Promise<LLMResponse | null> {
    console.log(`🤖 Processing LLM request: query="${message.payload.data.query?.substring(0, 50)}...", method=${message.target.method}`);

	const extractPayloadData = (payload: any, field: string): any => {
		  // Try direct access first
		  if (payload[field] !== undefined) return payload[field];
		  // Try nested data access
		  if (payload.data && payload.data[field] !== undefined) return payload.data[field];
		  // Try double-nested access (for backward compatibility)
		  if (payload.data && payload.data.data && payload.data.data[field] !== undefined) return payload.data.data[field];
		  return undefined;
 	};

    try {
      const startTime = performance.now();
      let response: LLMResponse | null = null;

      switch (message.target.method) {
        case 'llm_generate':
              const query = extractPayloadData(message.payload, 'query');
              const options = extractPayloadData(message.payload, 'options') || {};

              if (!query) {
                console.error('❌ Missing query in llm_generate request');
                console.error('Payload structure:', JSON.stringify(message.payload, null, 2));
                return null;
              }

              console.log(`🧠 Processing query: "${query.substring(0, 50)}..."`);
              response = await this.generate(query, options);
              break;
        case 'llm_code':
          response = await this.generateCode(message.payload.data.code_request, message.payload.data.options);
          break;
        case 'llm_analysis':
          response = await this.analyze(message.payload.data.analysis_query, message.payload.data.options);
          break;
        case 'llm_embed':
              const text = extractPayloadData(message.payload, 'text');
              const embedOptions = extractPayloadData(message.payload, 'options') || {};

              if (!text) {
                console.error('❌ Missing text in llm_embed request');
                console.error('Payload structure:', JSON.stringify(message.payload, null, 2));
                return null;
              }

              console.log(`🔢 Processing embed for text: "${text.substring(0, 50)}..."`);
              response = await this.embed(text, embedOptions);
              break;
        default:
          console.error(`❌ Unsupported method: ${message.target.method}`);
          return null;
      }

      if (response) {
        const processingTime = performance.now() - startTime;
        console.log(`✅ LLM response generated: id=${response.id}, model=${response.model}, processingTime=${processingTime.toFixed(2)}ms`);
        await performanceOptimizer.recordPerformance({
          queryHash: llmIntelligenceEngine.getQueryHash(message.payload.data.query || message.payload.data.text || message.payload.data.code_request || message.payload.data.analysis_query),
          model: response.model as ModelType,
          complexity: response.metadata.complexity.level,
          actualProcessingTime: processingTime,
          estimatedProcessingTime: response.metadata.complexity.processingTime,
          tokens: response.tokens.total,
          success: true,
          quality: response.confidence
        });
      }
      return response;
    } catch (error) {
      console.error(`❌ Error processing LLM request: ${error}`);
      return null;
    }
  }

  /**
   * Generate a response using Ollama.
   *
   * FIX: Now forwards system_prompt, max_tokens, and temperature from
   *      the options object to OllamaClient.generate(). Previously these
   *      were silently discarded, causing the model to receive only the
   *      bare user query with no system context.
   */
  // FIXED: Made public
  public async generate(query: string, options?: any): Promise<LLMResponse> {
    console.log(`[SRC/MODULES/LLM/manager.ts -> generate()] 🧠 Generating response for query: "${query.substring(0, 50)}..."`);
    console.log(`[SRC/MODULES/LLM/manager.ts -> generate()] Contents of options param -> ${JSON.stringify(options)}`);
    const startTime = performance.now();

    const complexity = await llmIntelligenceEngine.analyzeQuery(query, options?.context);

    // GUARDRAIL: resolveModel() honours an installed model_preference, refuses
    // uninstalled models, and refuses oversized models that would offload to CPU
    // (unless explicitly opted in). This is the central choke point — every
    // generate path benefits, including @Dina chat routed via the orchestrator.
    const model = this.resolveModel(options?.model_preference, complexity.recommendedModel, this.availableModels, options);

    // FIX: Forward system_prompt, max_tokens, and temperature to OllamaClient.
    // Before this fix, only (query, model) was passed — the system prompt
    // carrying Dina's persona, group context, and conversation history was
    // silently dropped, causing the model to respond without any context.
    const ollamaOpts: OllamaGenerateOptions = {};

    if (options?.system_prompt) {
      ollamaOpts.system = options.system_prompt;
      console.log(`[SRC/MODULES/LLM/manager.ts -> generate()] 📋 Forwarding system_prompt to Ollama (${options.system_prompt.length} chars)`);
    }

    if (options?.max_tokens) {
      ollamaOpts.maxTokens = options.max_tokens;
    }

    if (options?.temperature !== undefined) {
      ollamaOpts.temperature = options.temperature;
    }

    // GPU-arbiter urgency: chat paths pass 'interactive'; pipelines 'background'.
    if (options?.priority) {
      ollamaOpts.priority = options.priority;
    }

    const ollamaResponse = await this.ollama.generate(query, model, ollamaOpts);

    const response: LLMResponse = {
      id: `llm-res-${uuidv4()}`,
      sourceRequestId: options.requestId,
      model,
      response: ollamaResponse.response,
      tokens: {
        input: ollamaResponse.prompt_eval_count || 0,
        output: ollamaResponse.eval_count || 0,
        total: (ollamaResponse.prompt_eval_count || 0) + (ollamaResponse.eval_count || 0)
      },
      performance: {
        processingTime: ollamaResponse.total_duration ? ollamaResponse.total_duration / 1e6 : performance.now() - startTime,
        queueTime: 0,
        modelLoadTime: ollamaResponse.load_duration ? ollamaResponse.load_duration / 1e6 : 0
      },
      confidence: await llmIntelligenceEngine.assessConfidence(ollamaResponse.response),
      metadata: {
        complexity,
        context_used: !!options?.context,
        cached: false
      }
    };

    if (options?.include_context) {
      await contextMemorySystem.updateContext(
        options.user_id || 'anonymous',
        options.conversation_id || 'default',
        query,
        ollamaResponse.response
      );
    }

    console.log(`✅ Generated response: id=${response.id}, model=${model}, sourceRequestId=${options.requestId}`);
    return response;
  }

  // FIXED: Made public
  public async generateCode(query: string, options?: any): Promise<LLMResponse> {
    console.log(`💻 Generating code for query: "${query.substring(0, 50)}..."`);
    const startTime = performance.now();

    const complexity = await llmIntelligenceEngine.analyzeQuery(query, options?.context);
    const model = this.resolveModel(options?.model_preference, complexity.recommendedModel, this.availableModels, options);

    const prompt = `Generate code for the following request: ${query}`;
    const ollamaResponse = await this.ollama.generate(prompt, model);

    const response: LLMResponse = {
      id: `llm-code-${uuidv4()}`,
      model,
      response: ollamaResponse.response,
      tokens: {
        input: ollamaResponse.prompt_eval_count || 0,
        output: ollamaResponse.eval_count || 0,
        total: (ollamaResponse.prompt_eval_count || 0) + (ollamaResponse.eval_count || 0)
      },
      performance: {
        processingTime: ollamaResponse.total_duration ? ollamaResponse.total_duration / 1e6 : performance.now() - startTime,
        queueTime: 0,
        modelLoadTime: ollamaResponse.load_duration ? ollamaResponse.load_duration / 1e6 : 0
      },
      confidence: await llmIntelligenceEngine.assessConfidence(ollamaResponse.response),
      metadata: {
        complexity,
        context_used: !!options?.context,
        cached: false
      }
    };

    console.log(`✅ Generated code response: id=${response.id}, model=${model}`);
    return response;
  }

  // FIXED: Made public
  public async analyze(query: string, options?: any): Promise<LLMResponse> {
    console.log(`🔍 Analyzing query: "${query.substring(0, 50)}..."`);
    const startTime = performance.now();

    const complexity = await llmIntelligenceEngine.analyzeQuery(query, options?.context);
    const model = this.resolveModel(options?.model_preference, complexity.recommendedModel, this.availableModels, options);

    const prompt = `Analyze and provide detailed insights for: ${query}`;
    const ollamaResponse = await this.ollama.generate(prompt, model);

    const response: LLMResponse = {
      id: `llm-analysis-${uuidv4()}`,
      model,
      response: ollamaResponse.response,
      tokens: {
        input: ollamaResponse.prompt_eval_count || 0,
        output: ollamaResponse.eval_count || 0,
        total: (ollamaResponse.prompt_eval_count || 0) + (ollamaResponse.eval_count || 0)
      },
      performance: {
        processingTime: ollamaResponse.total_duration ? ollamaResponse.total_duration / 1e6 : performance.now() - startTime,
        queueTime: 0,
        modelLoadTime: ollamaResponse.load_duration ? ollamaResponse.load_duration / 1e6 : 0
      },
      confidence: await llmIntelligenceEngine.assessConfidence(ollamaResponse.response),
      metadata: {
        complexity,
        context_used: !!options?.context,
        cached: false
      }
    };

    console.log(`✅ Analysis response: id=${response.id}, model=${model}`);
    return response;
  }

public async embed(text: string, options?: any): Promise<LLMResponse> {
  console.log(`🔢 MANAGER: Starting embed method for text: "${text.substring(0, 50)}..."`);
  const startTime = performance.now();

  try {
    // ADD DEBUG LOG:
    console.log(`🔍 MANAGER DEBUG: About to call intelligence engine analyzeQuery`);

    const complexity = await llmIntelligenceEngine.analyzeQuery(text, options?.context);

    // ADD DEBUG LOG:
    console.log(`🔍 MANAGER DEBUG: Intelligence analysis complete: level=${complexity.level}`);

    const cfg = getLlmConfig();
    const model = options?.model_preference && this.isInstalled(options.model_preference, this.availableModels)
      ? options.model_preference
      : cfg.embedModel;

    // ADD DEBUG LOG:
    console.log(`🔍 MANAGER DEBUG: Model selected: ${model}, about to call ollama.embed()`);

    const embeddingResponse = await this.ollama.embed(text, model);

    // ADD DEBUG LOG:
    console.log(`🔍 MANAGER DEBUG: Ollama embed complete, building response object`);

    const response: LLMResponse = {
      id: `llm-embed-${uuidv4()}`,
      model,
      response: JSON.stringify(embeddingResponse.embeddings),
      tokens: {
        input: Math.ceil(text.split(/\s+/).length * 1.3),
        output: embeddingResponse.embeddings.length,
        total: Math.ceil(text.split(/\s+/).length * 1.3) + embeddingResponse.embeddings.length
      },
      performance: {
        processingTime: embeddingResponse.total_duration ? embeddingResponse.total_duration / 1e6 : performance.now() - startTime,
        queueTime: 0,
        modelLoadTime: 0
      },
      confidence: 0.9,
      metadata: {
        complexity,
        context_used: !!options?.context,
        cached: false
      }
    };

    console.log(`✅ MANAGER: Embedding response built: id=${response.id}, model=${model}, dimensions=${embeddingResponse.embeddings.length}`);
    return response;

  } catch (error) {
    console.error(`❌ MANAGER ERROR in embed method: ${error}`);
    throw error;
  }
}

  // FIXED: Added missing methods
  public async getSystemStatus(): Promise<Record<string, any>> {
    console.log('📋 Fetching LLM system status...');

    const cfg = getLlmConfig();
    const intelligenceStats = await llmIntelligenceEngine.getIntelligenceStats();
    const performanceStats = performanceOptimizer.getPerformanceStats();
    const contextStats = contextMemorySystem.getContextStats();
    const gpu = gpuMonitor.getStatus();

    return {
      ollamaHealthy: this._isInitialized,
      availableModels: this.availableModels,
      loadedModels: gpu.loadedModels.map(m => m.name),
      // GPU residency — the field operators should watch. healthy=false means
      // Ollama is (partially or fully) running on CPU.
      gpu,
      llmConfig: {
        chatModel: cfg.chatModel,
        analysisModel: cfg.analysisModel,
        embedModel: cfg.embedModel,
        autoModels: cfg.autoModels,
        vramBudgetMb: cfg.vramBudgetMb,
        allowOversized: cfg.allowOversized,
        numCtx: cfg.numCtx,
        numGpu: cfg.numGpu,
        keepAlive: cfg.keepAlive,
      },
      memoryUsage: '0 MB',
      cacheSize: 0,
      performanceStats,
      intelligenceStats,
      contextStats,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Rich, on-demand LLM/GPU diagnostics. Forces a fresh GPU residency check and
   * returns actionable advisories. This is the payload the mirror module exposes
   * to mirror-server so operators can see "Dina is on CPU" in real time.
   */
  public async getDiagnostics(): Promise<Record<string, any>> {
    const cfg = getLlmConfig();
    const gpu = await gpuMonitor.refresh();

    const warmInstalled = cfg.warmupModels.filter(m => this.isInstalled(m, this.availableModels));
    const warmMissing = cfg.warmupModels.filter(m => !this.isInstalled(m, this.availableModels));

    return {
      timestamp: new Date().toISOString(),
      initialized: this._isInitialized,
      ollamaBaseUrl: cfg.ollamaBaseUrl,
      availableModels: this.availableModels,
      warmup: { configured: cfg.warmupModels, installed: warmInstalled, missing: warmMissing },
      gpu,
      config: {
        chatModel: cfg.chatModel,
        analysisModel: cfg.analysisModel,
        embedModel: cfg.embedModel,
        autoModels: cfg.autoModels,
        vramBudgetMb: cfg.vramBudgetMb,
        allowOversized: cfg.allowOversized,
        numCtx: cfg.numCtx,
        numGpu: cfg.numGpu,
        keepAlive: cfg.keepAlive,
      },
      // Live lease/queue/budget view of the cross-engine GPU arbiter (SAGA
      // renders vs LLM). enforcement=off means dark launch: registered, not gating.
      gpuArbiter: { enforcement: arbiterEnabled() ? 'on' : 'off', ...gpuArbiter.snapshot() },
      advisories: this.buildAdvisories(gpu, warmMissing),
    };
  }

  private buildAdvisories(gpu: ReturnType<typeof gpuMonitor.getStatus>, warmMissing: string[]): string[] {
    const advisories: string[] = [];
    if (gpu.state === 'cpu') {
      advisories.push('CRITICAL: Ollama is running on CPU. Run `nvidia-smi`; if it reports a driver/library mismatch, reboot the host. See ops/GPU_RUNBOOK.md.');
    } else if (gpu.state === 'partial') {
      advisories.push('WARNING: A model is split across GPU/CPU (VRAM exceeded). Reduce model size, lower DINA_NUM_CTX, or stop competing models.');
    } else if (gpu.state === 'unreachable') {
      advisories.push('Ollama is unreachable. Check `systemctl status ollama`.');
    }
    if (warmMissing.length > 0) {
      advisories.push(`Warmup models not installed: ${warmMissing.join(', ')}. Install with \`ollama pull <model>\` or update DINA_WARMUP_MODELS.`);
    }
    if (advisories.length === 0) {
      advisories.push('All systems nominal — models resident on GPU.');
    }
    return advisories;
  }

  public async getOptimizationRecommendations(): Promise<any[]> {
    console.log('📈 Fetching optimization recommendations...');
    return await performanceOptimizer.getOptimizationRecommendations();
  }

  public async unloadUnusedModels(): Promise<void> {
    console.log('🗑️ Unloading unused models...');
    console.log('ℹ️ Ollama manages model loading/unloading automatically');
  }

  public async shutdown(): Promise<void> {
    console.log('🛑 Shutting down LLM Manager...');
    this._isInitialized = false;
    console.log('✅ LLM Manager shutdown complete');
  }

  /**
   * Stream a response from the LLM.
   *
   * FIX: Now forwards system_prompt to OllamaClient.generateStream()
   *      so that streaming responses also receive persona/context.
   */
  public async *generateStream(query: string, options?: any): AsyncGenerator<{ content: string; done: boolean }> {
    // Apply the same guardrail to streaming: honour an installed preference,
    // otherwise fall back to a fitting model (never an oversized one).
    const model = this.resolveModel(options?.model || options?.model_preference, getLlmConfig().chatModel, this.availableModels, options);
    let prompt = query;
    if (options?.context) {
      prompt = `Context:\n${options.context}\n\nUser Query: ${query}`;
    }
    console.log(`🔄 Starting stream generation with model ${model}`);
    for await (const chunk of this.ollama.generateStream(prompt, model, {
      maxTokens: options?.maxTokens || 1000,
      temperature: options?.temperature || 0.7,
      system: options?.system_prompt
    })) {
      yield chunk;
    }
  }

  async getModelCapabilities(): Promise<Record<string, any>> {
    console.log('📋 Fetching model capabilities...');
    const capabilities: Record<string, any> = {
      [ModelType.QWEN25_3B]: {
        maxTokens: 32000,
        strengthAreas: ['structured JSON output', 'summarization', 'fast inference'],
        weaknesses: ['complex reasoning', 'long-form creative writing'],
        averageResponseTime: 50,
        memoryUsage: 1900
      },
      [ModelType.MISTRAL_7B]: {
        maxTokens: 32000,
        strengthAreas: ['general knowledge', 'text generation'],
        weaknesses: ['complex code generation'],
        averageResponseTime: 150,
        memoryUsage: 7000
      },
      [ModelType.CODELLAMA_34B]: {
        maxTokens: 16000,
        strengthAreas: ['code generation', 'technical analysis'],
        weaknesses: ['creative writing'],
        averageResponseTime: 800,
        memoryUsage: 20000
      },
      [ModelType.LLAMA2_70B]: {
        maxTokens: 4096,
        strengthAreas: ['complex reasoning', 'large context'],
        weaknesses: ['speed'],
        averageResponseTime: 2500,
        memoryUsage: 40000
      },
    };
    return capabilities;
  }
}