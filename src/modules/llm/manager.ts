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
}

export class OllamaClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl: string = 'http://localhost:11434', timeoutMs: number = 60000) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    console.log(`🚀 Initializing OllamaClient with baseUrl: ${baseUrl}`);
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
   * @param opts    - Optional: system prompt, maxTokens, temperature
   *
   * FIX: Previously this method accepted only (prompt, model) and hardcoded
   *      num_predict=500 / temperature=0.7 with NO system prompt support.
   *      The Ollama /api/generate endpoint accepts a "system" field that
   *      sets the model's system-level instructions. This was never used,
   *      causing Dina to respond without any persona or conversation context.
   */
  async generate(prompt: string, model: string, opts?: OllamaGenerateOptions): Promise<OllamaResponse> {
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
      }, 600000); // 600 second timeout

      // Build the request body. Include "system" only when provided so that
      // requests without a system prompt behave identically to before.
      const requestBody: Record<string, any> = {
        model,
        prompt,
        stream: false,
        keep_alive: '24h', // Keep model loaded in GPU memory to avoid 150s+ cold starts
        options: {
          num_predict: opts?.maxTokens || 500,
          temperature: opts?.temperature ?? 0.7
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
  }): AsyncGenerator<{ content: string; done: boolean }> {
    console.log(`📡 Starting streaming generation for model ${model}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.error(`⏰ Ollama stream timeout for model ${model}`);
      controller.abort();
    }, 300000);

    try {
      const requestBody: Record<string, any> = {
        model,
        prompt,
        stream: true,
        keep_alive: '24h',
        options: {
          num_predict: options?.maxTokens || 1000,
          temperature: options?.temperature || 0.7
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

  async embed(input: string, model: string = 'mxbai-embed-large'): Promise<OllamaEmbeddingResponse> {
    console.log(`📡 Generating embedding for input: "${input.substring(0, 50)}..." using ${model}`);
    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input, keep_alive: '24h' }),
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
        model,
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
   * The keep_alive: "24h" in generate() ensures they stay loaded.
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
    const modelsToWarm = ['qwen2.5:3b', 'mistral:7b', 'mxbai-embed-large'];
    const available = this.availableModels;
    console.log(`🔥 Starting warmup. Available models: [${available.join(', ')}]`);
    console.log(`🔥 Models to warm: [${modelsToWarm.join(', ')}]`);

    for (const model of modelsToWarm) {
      const modelBase = model.split(':')[0];
      if (!available.some(m => m === model || m.startsWith(modelBase))) {
        console.log(`⏩ Skipping warmup for ${model} (not found in available models)`);
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
    const model = options?.model_preference && this.availableModels.includes(options.model_preference)
      ? options.model_preference
      : complexity.recommendedModel;

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
    const model = options?.model_preference && this.availableModels.includes(options.model_preference)
      ? options.model_preference
      : complexity.recommendedModel;

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
    const model = options?.model_preference && this.availableModels.includes(options.model_preference)
      ? options.model_preference
      : complexity.recommendedModel;

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

    const model = options?.model_preference && this.availableModels.includes(options.model_preference)
      ? options.model_preference
      : 'mxbai-embed-large';

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

    const intelligenceStats = await llmIntelligenceEngine.getIntelligenceStats();
    const performanceStats = performanceOptimizer.getPerformanceStats();
    const contextStats = contextMemorySystem.getContextStats();

    return {
      ollamaHealthy: this._isInitialized,
      availableModels: this.availableModels,
      loadedModels: this.availableModels,
      memoryUsage: '0 MB',
      cacheSize: 0,
      performanceStats,
      intelligenceStats,
      contextStats,
      timestamp: new Date().toISOString()
    };
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
    const model = options?.model || 'mistral:7b';
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
