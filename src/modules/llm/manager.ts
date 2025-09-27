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
  LLMResponse,
} from './intelligence';

interface OllamaResponse {
  model: string;
  created_at?: string;
  response: string;
  done?: boolean;
  context?: number[];
  total_duration?: number;   // ns
  load_duration?: number;    // ns
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;    // ns
}

interface OllamaEmbeddingResponse {
  model: string;
  embeddings: number[];
  total_duration?: number;
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
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const data = (await response.json()) as { models: Array<{ name: string }> };
      const models = data.models.map((m) => m.name);
      console.log(`✅ Available models: ${models.join(', ')}`);
      return models;
    } catch (error) {
      console.error(`❌ Failed to list models: ${error}`);
      return [];
    }
  }

  // NDJSON-aware generate
  async generate(prompt: string, model: string): Promise<OllamaResponse> {
    console.log(
      `📡 Sending request to Ollama for model ${model}, prompt: "${prompt.substring(0, 50)}..."`
    );
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.error(`⏰ Ollama generate timeout for model ${model}`);
      controller.abort();
    }, 600_000); // 600s

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false, // Some versions still return NDJSON lines
          options: { num_predict: 500, temperature: 0.7 },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama HTTP ${response.status}: ${response.statusText} - ${errorText}`);
      }

      const responseText = await response.text();
      console.log(
        `🔍 OLLAMA DEBUG: Raw response length: ${responseText.length}, first 100 chars: ${responseText.substring(0, 100)}`
      );

      const lines = responseText
        .trim()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      console.log(`🔍 OLLAMA DEBUG: Found ${lines.length} JSON lines`);

      if (lines.length === 0) {
        throw new Error('Empty response from Ollama');
      }

      let finalResponse: any = null;
      let accumulatedResponse = '';

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (typeof obj.response === 'string') accumulatedResponse += obj.response;
          if (obj.done === true) {
            finalResponse = obj;
            finalResponse.response = accumulatedResponse;
            break;
          }
        } catch (e) {
          console.error(`🔍 OLLAMA DEBUG: Failed to parse JSON line (showing up to 100 chars): ${line.substring(0, 100)}`);
          console.error(`🔍 OLLAMA DEBUG: Parse error: ${String(e)}`);
        }
      }

      if (!finalResponse) {
        const last = JSON.parse(lines[lines.length - 1]);
        finalResponse = last;
        finalResponse.response = accumulatedResponse || last.response || '';
      }

      console.log(
        `✅ Received Ollama response for model ${model}: "${String(finalResponse.response || '').substring(0, 50)}..."`
      );

      const out: OllamaResponse = {
        model,
        created_at: finalResponse.created_at,
        response: String(finalResponse.response ?? ''),
        done: !!finalResponse.done,
        context: finalResponse.context,
        total_duration: finalResponse.total_duration,
        load_duration: finalResponse.load_duration,
        prompt_eval_count: finalResponse.prompt_eval_count,
        eval_count: finalResponse.eval_count,
        eval_duration: finalResponse.eval_duration,
      };

      return out;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async embed(input: string, model: string = 'mxbai-embed-large'): Promise<OllamaEmbeddingResponse> {
    console.log(`📡 Generating embedding for input: "${input.substring(0, 50)}..." using ${model}`);
    try {
      // NB: On some Ollama versions the embeddings path is /api/embeddings; on others it's /api/embed.
      // Your last working version used /api/embed, so we keep that here.
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Ollama HTTP ${response.status}: ${response.statusText} - ${text}`);
      }

      const data = (await response.json()) as OllamaEmbeddingResponse;
      console.log(`✅ Generated embedding: ${data.embeddings.length} dimensions`);
      return data;
    } catch (error) {
      console.error(`❌ Ollama embed error: ${error}`);
      // Fallback mock response (kept from your working version approach)
      return {
        model,
        embeddings: Array(1024)
          .fill(0)
          .map(() => Math.random()),
        total_duration: 1000,
      };
    }
  }
}

export class DinaLLMManager {
  private ollama: OllamaClient;
  private availableModels: string[] = [];
  private _isInitialized = false;

  constructor() {
    this.ollama = new OllamaClient();
    console.log('🚀 Initializing DinaLLMManager');
  }

  // Required by other modules
  public async initialize(): Promise<void> {
    try {
      this.availableModels = await this.ollama.listModels();
      this._isInitialized = true;
      console.log('✅ DinaLLMManager initialized successfully');
    } catch (error) {
      console.error(`❌ Failed to initialize DinaLLMManager: ${error}`);
      this._isInitialized = false;
      throw error;
    }
  }

  public get isInitialized(): boolean {
    return this._isInitialized;
  }

  async processLLMRequest(message: DinaUniversalMessage): Promise<LLMResponse | null> {
    console.log(
      `🤖 Processing LLM request: query="${message.payload?.data?.query?.substring(0, 50) ?? ''}...", method=${message.target.method}`
    );

    const extractPayloadData = (payload: any, field: string): any => {
      if (!payload) return undefined;
      if (payload[field] !== undefined) return payload[field];
      if (payload.data && payload.data[field] !== undefined) return payload.data[field];
      if (payload.data && payload.data.data && payload.data.data[field] !== undefined)
        return payload.data.data[field];
      return undefined;
    };

    try {
      const startTime = performance.now();
      let response: LLMResponse | null = null;

      switch (message.target.method) {
        case 'llm_generate': {
          const query = extractPayloadData(message.payload, 'query');
          const options = extractPayloadData(message.payload, 'options') || {};
          if (!query) {
            console.error('❌ Missing query in llm_generate request');
            console.error('Payload structure:', JSON.stringify(message.payload, null, 2));
            return null;
          }
          console.log(`🧠 Processing query: "${String(query).substring(0, 50)}..."`);
          response = await this.generate(query, options);
          break;
        }
        case 'llm_code': {
          const codeReq = extractPayloadData(message.payload, 'code_request');
          const options = extractPayloadData(message.payload, 'options') || {};
          if (!codeReq) {
            console.error('❌ Missing code_request in llm_code request');
            return null;
          }
          response = await this.generateCode(codeReq, options);
          break;
        }
        case 'llm_analysis': {
          const analysisQuery = extractPayloadData(message.payload, 'analysis_query');
          const options = extractPayloadData(message.payload, 'options') || {};
          if (!analysisQuery) {
            console.error('❌ Missing analysis_query in llm_analysis request');
            return null;
          }
          response = await this.analyze(analysisQuery, options);
          break;
        }
        case 'llm_embed': {
          const text = extractPayloadData(message.payload, 'text');
          const embedOptions = extractPayloadData(message.payload, 'options') || {};
          if (!text) {
            console.error('❌ Missing text in llm_embed request');
            console.error('Payload structure:', JSON.stringify(message.payload, null, 2));
            return null;
          }
          console.log(`🔢 Processing embed for text: "${String(text).substring(0, 50)}..."`);
          response = await this.embed(text, embedOptions);
          break;
        }
        default:
          console.error(`❌ Unsupported method: ${message.target.method}`);
          return null;
      }

      if (response) {
        const processingTime = performance.now() - startTime;
        console.log(
          `✅ LLM response generated: id=${response.id}, model=${response.model}, processingTime=${processingTime.toFixed(
            2
          )}ms`
        );
        await performanceOptimizer.recordPerformance({
          queryHash: llmIntelligenceEngine.getQueryHash(
            message.payload?.data?.query ||
            message.payload?.data?.text ||
            message.payload?.data?.code_request ||
            message.payload?.data?.analysis_query ||
            ''
          ),
          model: response.model as ModelType,
          complexity: response.metadata.complexity.level,
          actualProcessingTime: processingTime,
          estimatedProcessingTime: response.metadata.complexity.processingTime,
          tokens: response.tokens.total, // <-- was `response.tokens`
          success: true,
          quality: response.confidence,
        });
      }
      return response;
    } catch (error) {
      console.error(`❌ Error processing LLM request: ${error}`);
      return null;
    }
  }

  public async generate(query: string, options?: any): Promise<LLMResponse> {
    console.log(`🧠 Generating response for query: "${query.substring(0, 50)}..."`);
    const startTime = performance.now();

    const complexity = await llmIntelligenceEngine.analyzeQuery(query, options?.context);
    const model =
      options?.model_preference && this.availableModels.includes(options.model_preference)
        ? options.model_preference
        : complexity.recommendedModel;

    const ollamaResponse = await this.ollama.generate(query, model);

    const response: LLMResponse = {
      id: `llm-res-${uuidv4()}`,
      model,
      response: String(ollamaResponse.response ?? ''),
      tokens: {
        input: ollamaResponse.prompt_eval_count ?? 0,
        output: ollamaResponse.eval_count ?? 0,
        total: (ollamaResponse.prompt_eval_count ?? 0) + (ollamaResponse.eval_count ?? 0),
      },
      performance: {
        processingTime: ollamaResponse.total_duration
          ? ollamaResponse.total_duration / 1e6
          : performance.now() - startTime,
        queueTime: 0,
        modelLoadTime: ollamaResponse.load_duration ? ollamaResponse.load_duration / 1e6 : 0,
      },
      confidence: await llmIntelligenceEngine.assessConfidence(String(ollamaResponse.response ?? '')),
      metadata: {
        complexity,
        context_used: !!options?.context,
        cached: false,
      },
    };

    if (options?.include_context) {
      await contextMemorySystem.updateContext(
        options.user_id || 'anonymous',
        options.conversation_id || 'default',
        query,
        response.response
      );
    }

    console.log(`✅ Generated response: id=${response.id}, model=${model}`);
    return response;
  }

  public async generateCode(query: string, options?: any): Promise<LLMResponse> {
    console.log(`💻 Generating code for query: "${query.substring(0, 50)}..."`);
    const startTime = performance.now();

    const complexity = await llmIntelligenceEngine.analyzeQuery(query, options?.context);
    const model =
      options?.model_preference && this.availableModels.includes(options.model_preference)
        ? options.model_preference
        : complexity.recommendedModel;

    const prompt = `Generate code for the following request: ${query}`;
    const ollamaResponse = await this.ollama.generate(prompt, model);

    const response: LLMResponse = {
      id: `llm-code-${uuidv4()}`,
      model,
      response: String(ollamaResponse.response ?? ''),
      tokens: {
        input: ollamaResponse.prompt_eval_count ?? 0,
        output: ollamaResponse.eval_count ?? 0,
        total: (ollamaResponse.prompt_eval_count ?? 0) + (ollamaResponse.eval_count ?? 0),
      },
      performance: {
        processingTime: ollamaResponse.total_duration
          ? ollamaResponse.total_duration / 1e6
          : performance.now() - startTime,
        queueTime: 0,
        modelLoadTime: ollamaResponse.load_duration ? ollamaResponse.load_duration / 1e6 : 0,
      },
      confidence: await llmIntelligenceEngine.assessConfidence(String(ollamaResponse.response ?? '')),
      metadata: {
        complexity,
        context_used: !!options?.context,
        cached: false,
      },
    };

    console.log(`✅ Generated code response: id=${response.id}, model=${model}`);
    return response;
  }

  public async analyze(query: string, options?: any): Promise<LLMResponse> {
    console.log(`🔍 Analyzing query: "${query.substring(0, 50)}..."`);
    const startTime = performance.now();

    const complexity = await llmIntelligenceEngine.analyzeQuery(query, options?.context);
    const model =
      options?.model_preference && this.availableModels.includes(options.model_preference)
        ? options.model_preference
        : complexity.recommendedModel;

    const prompt = `Analyze and provide detailed insights for: ${query}`;
    const ollamaResponse = await this.ollama.generate(prompt, model);

    const response: LLMResponse = {
      id: `llm-analysis-${uuidv4()}`,
      model,
      response: String(ollamaResponse.response ?? ''),
      tokens: {
        input: ollamaResponse.prompt_eval_count ?? 0,
        output: ollamaResponse.eval_count ?? 0,
        total: (ollamaResponse.prompt_eval_count ?? 0) + (ollamaResponse.eval_count ?? 0),
      },
      performance: {
        processingTime: ollamaResponse.total_duration
          ? ollamaResponse.total_duration / 1e6
          : performance.now() - startTime,
        queueTime: 0,
        modelLoadTime: ollamaResponse.load_duration ? ollamaResponse.load_duration / 1e6 : 0,
      },
      confidence: await llmIntelligenceEngine.assessConfidence(String(ollamaResponse.response ?? '')),
      metadata: {
        complexity,
        context_used: !!options?.context,
        cached: false,
      },
    };

    console.log(`✅ Analysis response: id=${response.id}, model=${model}`);
    return response;
  }

  public async embed(text: string, options?: any): Promise<LLMResponse> {
    console.log(`🔢 MANAGER: Starting embed method for text: "${text.substring(0, 50)}..."`);
    const startTime = performance.now();

    try {
      console.log(`🔍 MANAGER DEBUG: About to call intelligence engine analyzeQuery`);
      const complexity = await llmIntelligenceEngine.analyzeQuery(text, options?.context);

      console.log(`🔍 MANAGER DEBUG: Intelligence analysis complete: level=${complexity.level}`);
      const model =
        options?.model_preference && this.availableModels.includes(options.model_preference)
          ? options.model_preference
          : 'mxbai-embed-large';

      console.log(`🔍 MANAGER DEBUG: Model selected: ${model}, about to call ollama.embed()`);
      const embeddingResponse = await this.ollama.embed(text, model);

      console.log(`🔍 MANAGER DEBUG: Ollama embed complete, building response object`);

      const inputTokens = Math.ceil(text.split(/\s+/).length * 1.3);
      const dim = embeddingResponse.embeddings.length;

      const response: LLMResponse = {
        id: `llm-embed-${uuidv4()}`,
        model: model as ModelType,
        response: JSON.stringify(embeddingResponse.embeddings),
        tokens: {
          input: inputTokens,
          output: dim,
          total: inputTokens + dim,
        },
        performance: {
          processingTime: embeddingResponse.total_duration
            ? embeddingResponse.total_duration / 1e6
            : performance.now() - startTime,
          queueTime: 0,
          modelLoadTime: 0,
        },
        confidence: 0.9,
        metadata: {
          complexity,
          context_used: !!options?.context,
          cached: false,
        },
      };

      console.log(
        `✅ MANAGER: Embedding response built: id=${response.id}, model=${model}, dimensions=${dim}`
      );
      return response;
    } catch (error) {
      console.error(`❌ MANAGER ERROR in embed method: ${error}`);
      throw error;
    }
  }

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
      timestamp: new Date().toISOString(),
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

  public async getModelCapabilities(): Promise<Record<string, any>> {
    console.log('📋 Fetching model capabilities...');
    const capabilities: Record<string, any> = {
      [ModelType.MISTRAL_7B]: {
        maxTokens: 32000,
        strengthAreas: ['general knowledge', 'text generation'],
        weaknesses: ['complex code generation'],
        averageResponseTime: 150,
        memoryUsage: 7000,
      },
      [ModelType.CODELLAMA_34B]: {
        maxTokens: 16000,
        strengthAreas: ['code generation', 'technical analysis'],
        weaknesses: ['creative writing'],
        averageResponseTime: 800,
        memoryUsage: 20000,
      },
      [ModelType.LLAMA2_70B]: {
        maxTokens: 4096,
        strengthAreas: ['complex reasoning', 'large context'],
        weaknesses: ['speed'],
        averageResponseTime: 2500,
        memoryUsage: 40000,
      },
      'mxbai-embed-large': {
        maxTokens: 512,
        strengthAreas: ['embeddings', 'semantic search'],
        weaknesses: ['text generation'],
        averageResponseTime: 100,
        memoryUsage: 1000,
      },
    };
    console.log(`✅ Model capabilities: ${Object.keys(capabilities).join(', ')}`);
    return capabilities;
  }
}
