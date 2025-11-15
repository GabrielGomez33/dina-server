// File: src/modules/llm/manager.ts
// DINA LLM Manager - Optimized & Revamped
import { v4 as uuidv4 } from 'uuid';
import { performance } from 'perf_hooks';
import { database } from '../../config/database/db';
import { redisManager } from '../../config/redis';
import { DinaUniversalMessage } from '../../core/protocol';
import {
  llmIntelligenceEngine,
  contextMemorySystem,
  performanceOptimizer,
  ModelType,
  ComplexityScore,
  LLMResponse
} from './intelligence';

// ================================
// LOGGER UTILITY (Optimized)
// ================================
enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

class Logger {
  private static level: LogLevel = LogLevel.INFO;

  static setLevel(level: LogLevel) {
    this.level = level;
  }

  static error(message: string, ...args: any[]) {
    if (this.level >= LogLevel.ERROR) console.error(`❌ ${message}`, ...args);
  }

  static warn(message: string, ...args: any[]) {
    if (this.level >= LogLevel.WARN) console.warn(`⚠️ ${message}`, ...args);
  }

  static info(message: string, ...args: any[]) {
    if (this.level >= LogLevel.INFO) console.log(`ℹ️ ${message}`, ...args);
  }

  static debug(message: string, ...args: any[]) {
    if (this.level >= LogLevel.DEBUG) console.log(`🔍 ${message}`, ...args);
  }
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

// ================================
// REQUEST QUEUE (New)
// ================================
class RequestQueue {
  private queue: Array<{
    fn: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];
  private running: number = 0;
  private maxConcurrent: number = 3;

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  private async process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    this.running++;
    const item = this.queue.shift();
    if (!item) {
      this.running--;
      return;
    }

    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      this.running--;
      this.process();
    }
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  getRunningCount(): number {
    return this.running;
  }
}

export class OllamaClient {
  private baseUrl: string;
  private timeoutMs: number;
  private requestQueue: RequestQueue;
  private preloadedModels: Set<string> = new Set();

  constructor(baseUrl: string = 'http://localhost:11434', timeoutMs: number = 60000) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.requestQueue = new RequestQueue();
    Logger.info(`Initializing OllamaClient with baseUrl: ${baseUrl}`);
  }

  async listModels(): Promise<string[]> {
    try {
      Logger.debug('Fetching available models from Ollama...');
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as { models: Array<{ name: string }> };
      const models = data.models.map((m: { name: string }) => m.name);
      Logger.info(`Available models: ${models.join(', ')}`);
      return models;
    } catch (error) {
      Logger.error(`Failed to list models: ${error}`);
      return [];
    }
  }

  /**
   * Preload a model to avoid cold start delays
   */
  async preloadModel(model: string): Promise<void> {
    if (this.preloadedModels.has(model)) {
      Logger.debug(`Model ${model} already preloaded`);
      return;
    }

    try {
      Logger.info(`Preloading model: ${model}`);
      const startTime = performance.now();

      // Send a minimal prompt to load the model into memory
      await this.generate('ping', model);

      this.preloadedModels.add(model);
      const loadTime = performance.now() - startTime;
      Logger.info(`Model ${model} preloaded in ${loadTime.toFixed(2)}ms`);
    } catch (error) {
      Logger.warn(`Failed to preload model ${model}: ${error}`);
    }
  }

  /**
   * Retry logic with exponential backoff
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    initialDelay: number = 1000
  ): Promise<T> {
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (attempt < maxRetries - 1) {
          const delay = initialDelay * Math.pow(2, attempt);
          Logger.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

/**
   * Optimized NDJSON parsing - more efficient, less logging
   */
  private parseNDJSON(responseText: string): OllamaResponse {
    const lines = responseText.trim().split('\n').filter(line => line.trim());

    if (lines.length === 0) {
      throw new Error('Empty response from Ollama');
    }

    let accumulatedResponse = '';
    let finalResponse: any = null;

    // Parse each line efficiently
    for (const line of lines) {
      try {
        const jsonObj = JSON.parse(line);

        if (jsonObj.response) {
          accumulatedResponse += jsonObj.response;
        }

        if (jsonObj.done === true) {
          finalResponse = jsonObj;
          finalResponse.response = accumulatedResponse;
          return finalResponse as OllamaResponse;
        }
      } catch (parseError) {
        Logger.debug(`Failed to parse NDJSON line: ${line.substring(0, 50)}`);
      }
    }

    // Fallback: use last valid JSON object
    if (!finalResponse && lines.length > 0) {
      finalResponse = JSON.parse(lines[lines.length - 1]);
      finalResponse.response = accumulatedResponse || finalResponse.response;
    }

    if (!finalResponse) {
      throw new Error('No valid response in NDJSON');
    }

    return finalResponse as OllamaResponse;
  }

  /**
   * Generate with retry, queue, and optimized parsing
   */
  async generate(prompt: string, model: string): Promise<OllamaResponse> {
    return this.requestQueue.enqueue(async () => {
      return this.retryWithBackoff(async () => {
        Logger.debug(`Generating with model ${model}, prompt length: ${prompt.length}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          Logger.warn(`Timeout for model ${model}`);
          controller.abort();
        }, 600000);

        try {
          const response = await fetch(`${this.baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              prompt,
              stream: false,
              options: {
                num_predict: 500,
                temperature: 0.7
              }
            }),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Ollama HTTP ${response.status}: ${errorText}`);
          }

          const responseText = await response.text();
          const parsedResponse = this.parseNDJSON(responseText);

          Logger.debug(`Generated response for ${model}, length: ${parsedResponse.response.length}`);
          return parsedResponse;
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
      }, 3, 1000);
    });
  }

/**
   * Embedding with retry - NO RANDOM FALLBACK!
   */
  async embed(input: string, model: string = 'mxbai-embed-large'): Promise<OllamaEmbeddingResponse> {
    return this.requestQueue.enqueue(async () => {
      return this.retryWithBackoff(async () => {
        Logger.debug(`Embedding with model ${model}, input length: ${input.length}`);

        const response = await fetch(`${this.baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input }),
          signal: AbortSignal.timeout(this.timeoutMs)
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Ollama embed HTTP ${response.status}: ${errorText}`);
        }

        const data = await response.json() as OllamaEmbeddingResponse;
        Logger.debug(`Generated embedding: ${data.embeddings.length} dimensions`);
        return data;
      }, 3, 1000);
    });
  }

  /**
   * Stream generate with real-time chunks
   * Useful for chat interfaces that need progressive rendering
   */
  async *generateStream(prompt: string, model: string): AsyncGenerator<string> {
    Logger.debug(`Starting stream generation with model ${model}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      Logger.warn(`Stream timeout for model ${model}`);
      controller.abort();
    }, 600000);

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: true,  // Enable real streaming
          options: {
            num_predict: 500,
            temperature: 0.7
          }
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama HTTP ${response.status}: ${errorText}`);
      }

      // Stream NDJSON responses
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No response body');
      }

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const jsonObj = JSON.parse(line);
            if (jsonObj.response) {
              yield jsonObj.response;
            }

            if (jsonObj.done === true) {
              return;
            }
          } catch (parseError) {
            Logger.debug(`Failed to parse stream line: ${line.substring(0, 50)}`);
          }
        }
      }
    } catch (error) {
      clearTimeout(timeoutId);
      Logger.error(`Stream generation error: ${error}`);
      throw error;
    }
  }

  /**
   * Get queue statistics
   */
  getQueueStats(): { queued: number; running: number } {
    return {
      queued: this.requestQueue.getQueueSize(),
      running: this.requestQueue.getRunningCount()
    };
  }
}

export class DinaLLMManager {
  private ollama: OllamaClient;
  private availableModels: string[] = [];
  private _isInitialized: boolean = false;
  private modelFallbacks: Map<string, string> = new Map();

  constructor() {
    this.ollama = new OllamaClient();
    this.setupModelFallbacks();
    Logger.info('Initializing DinaLLMManager');
  }

  private setupModelFallbacks(): void {
    // Define fallback models for retry logic
    this.modelFallbacks.set(ModelType.LLAMA2_70B, ModelType.CODELLAMA_34B);
    this.modelFallbacks.set(ModelType.CODELLAMA_34B, ModelType.MISTRAL_7B);
    this.modelFallbacks.set(ModelType.MISTRAL_7B, ModelType.MISTRAL_7B); // No fallback
  }

  /**
   * Initialize with model preloading for better performance
   */
  public async initialize(): Promise<void> {
    try {
      Logger.info('Starting DinaLLMManager initialization...');

      // List available models
      this.availableModels = await this.ollama.listModels();
      Logger.info(`Found ${this.availableModels.length} models`);

      // Preload frequently used models
      const modelsToPreload = [
        ModelType.MISTRAL_7B,  // Most frequently used
        'mxbai-embed-large'     // Embedding model
      ];

      for (const model of modelsToPreload) {
        if (this.availableModels.includes(model)) {
          await this.ollama.preloadModel(model);
        } else {
          Logger.warn(`Model ${model} not available for preloading`);
        }
      }

      this._isInitialized = true;
      Logger.info('DinaLLMManager initialized successfully');
    } catch (error) {
      Logger.error(`Failed to initialize DinaLLMManager: ${error}`);
      this._isInitialized = false;
      throw error;
    }
  }

  public get isInitialized(): boolean {
    return this._isInitialized;
  }

async processLLMRequest(message: DinaUniversalMessage): Promise<LLMResponse | null> {
    Logger.debug(`Processing LLM request: method=${message.target.method}`);

    const extractPayloadData = (payload: any, field: string): any => {
      if (payload[field] !== undefined) return payload[field];
      if (payload.data && payload.data[field] !== undefined) return payload.data[field];
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
            Logger.error('Missing query in llm_generate request');
            Logger.debug(`Payload: ${JSON.stringify(message.payload)}`);
            return null;
          }

          Logger.debug(`Processing query, length: ${query.length}`);
          response = await this.generateWithFallback(query, options);
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
            Logger.error('Missing text in llm_embed request');
            Logger.debug(`Payload: ${JSON.stringify(message.payload)}`);
            return null;
          }

          Logger.debug(`Processing embed, text length: ${text.length}`);
          response = await this.embed(text, embedOptions);
          break;

        default:
          Logger.error(`Unsupported method: ${message.target.method}`);
          return null;
      }

      if (response) {
        const processingTime = performance.now() - startTime;
        Logger.info(`Response generated: id=${response.id}, model=${response.model}, time=${processingTime.toFixed(0)}ms`);

        await performanceOptimizer.recordPerformance({
          queryHash: llmIntelligenceEngine.getQueryHash(message.payload.data.query || message.payload.data.text || message.payload.data.code_request || message.payload.data.analysis_query),
          model: response.model as ModelType,
          complexity: response.metadata.complexity.level,
          actualProcessingTime: processingTime,
          estimatedProcessingTime: response.metadata.complexity.processingTime,
          tokens: response.tokens,
          success: true,
          quality: response.confidence
        });
      }
      return response;
    } catch (error) {
      Logger.error(`Error processing LLM request: ${error}`);
      return null;
    }
  }

  /**
   * Generate with automatic fallback to lighter models on failure
   */
  private async generateWithFallback(query: string, options?: any): Promise<LLMResponse> {
    const complexity = await llmIntelligenceEngine.analyzeQuery(query, options?.context);
    let model = options?.model_preference && this.availableModels.includes(options.model_preference)
      ? options.model_preference
      : complexity.recommendedModel;

    let lastError: any;
    const attemptedModels: string[] = [];

    // Try primary model and fallbacks
    while (model && !attemptedModels.includes(model)) {
      attemptedModels.push(model);

      try {
        Logger.debug(`Attempting generation with model: ${model}`);
        return await this.generate(query, { ...options, model_preference: model });
      } catch (error) {
        lastError = error;
        Logger.warn(`Model ${model} failed: ${error}`);

        // Try fallback
        const fallback = this.modelFallbacks.get(model);
        if (fallback && fallback !== model && !attemptedModels.includes(fallback)) {
          Logger.info(`Falling back to model: ${fallback}`);
          model = fallback;
        } else {
          break;
        }
      }
    }

    throw lastError || new Error('All models failed');
  }

public async generate(query: string, options?: any): Promise<LLMResponse> {
    Logger.debug(`Generating response, query length: ${query.length}`);
    const startTime = performance.now();

    const complexity = await llmIntelligenceEngine.analyzeQuery(query, options?.context);
    const model = options?.model_preference && this.availableModels.includes(options.model_preference)
      ? options.model_preference
      : complexity.recommendedModel;

    const ollamaResponse = await this.ollama.generate(query, model);

    const response: LLMResponse = {
      id: `llm-res-${uuidv4()}`,
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

    Logger.debug(`Generated response: id=${response.id}, model=${model}`);
    return response;
  }

public async generateCode(query: string, options?: any): Promise<LLMResponse> {
    Logger.debug(`Generating code, query length: ${query.length}`);
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

    Logger.debug(`Code response generated: id=${response.id}`);
    return response;
  }

  public async analyze(query: string, options?: any): Promise<LLMResponse> {
    Logger.debug(`Analyzing query, length: ${query.length}`);
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

    Logger.debug(`Analysis response generated: id=${response.id}`);
    return response;
  }

public async embed(text: string, options?: any): Promise<LLMResponse> {
    Logger.debug(`Embedding text, length: ${text.length}`);
    const startTime = performance.now();

    const complexity = await llmIntelligenceEngine.analyzeQuery(text, options?.context);

    const model = options?.model_preference && this.availableModels.includes(options.model_preference)
      ? options.model_preference
      : 'mxbai-embed-large';

    const embeddingResponse = await this.ollama.embed(text, model);

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

    Logger.debug(`Embedding complete: id=${response.id}, dimensions=${embeddingResponse.embeddings.length}`);
    return response;
  }

public async getSystemStatus(): Promise<Record<string, any>> {
    Logger.debug('Fetching LLM system status...');

    const intelligenceStats = await llmIntelligenceEngine.getIntelligenceStats();
    const performanceStats = performanceOptimizer.getPerformanceStats();
    const contextStats = contextMemorySystem.getContextStats();
    const queueStats = this.ollama.getQueueStats();

    return {
      ollamaHealthy: this._isInitialized,
      availableModels: this.availableModels,
      loadedModels: this.availableModels,
      queueStats,
      performanceStats,
      intelligenceStats,
      contextStats,
      timestamp: new Date().toISOString()
    };
  }

  public async getOptimizationRecommendations(): Promise<any[]> {
    Logger.debug('Fetching optimization recommendations...');
    return await performanceOptimizer.getOptimizationRecommendations();
  }

  public async unloadUnusedModels(): Promise<void> {
    Logger.info('Ollama manages model loading/unloading automatically');
  }

  public async shutdown(): Promise<void> {
    Logger.info('Shutting down LLM Manager...');
    this._isInitialized = false;
    Logger.info('LLM Manager shutdown complete');
  }

  async getModelCapabilities(): Promise<Record<string, any>> {
    Logger.debug('Fetching model capabilities...');
    const capabilities: Record<string, any> = {
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
      'mxbai-embed-large': {
        maxTokens: 512,
        strengthAreas: ['embeddings', 'semantic search'],
        weaknesses: ['text generation'],
        averageResponseTime: 100,
        memoryUsage: 1000
      }
    };
    return capabilities;
  }
}

// Export Logger for use in other modules
export { Logger, LogLevel };
