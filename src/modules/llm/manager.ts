// DINA Phase 2: Multi-Model LLM Manager & Orchestrator
// File: src/modules/llm/manager.ts

import { performance } from 'perf_hooks';
import axios from 'axios';
import { 
  ModelType, 
  LLMResponse, 
  ComplexityScore,
  llmIntelligenceEngine, 
  contextMemorySystem, 
  performanceOptimizer 
} from './intelligence';
import { database } from '../../config/database/db';

// ================================
// OLLAMA INTEGRATION
// ================================

interface OllamaResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface ModelInfo {
  name: string;
  loaded: boolean;
  size: number;
  modified_at: string;
  digest: string;
}

class OllamaClient {
  private baseUrl: string;
  private timeout: number;

  constructor(baseUrl: string = process.env.OLLAMA_URL || 'http://localhost:11434') {
    this.baseUrl = baseUrl;
    this.timeout = 30000;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tags`, { timeout: 5000 });
      return response.status === 200;
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Ollama health check failed:', error.message);
      } else {
        console.error('Ollama health check failed:', error);
      }
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tags`, { timeout: this.timeout });
      return response.data.models.map((m: any) => ({
        name: m.name,
        loaded: m.details?.is_loaded || false,
        size: m.size,
        modified_at: m.modified_at,
        digest: m.digest
      }));
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to list Ollama models:', error.message);
      } else {
        console.error('Failed to list Ollama models:', error);
      }
      return [];
    }
  }

  async generate(model: string, prompt: string, options?: { stream?: boolean; raw?: boolean; format?: string; }): Promise<OllamaResponse> {
    try {
      const response = await axios.post(`${this.baseUrl}/api/generate`, {
        model,
        prompt,
        stream: options?.stream || false,
        raw: options?.raw || false,
        format: options?.format || 'json'
      }, { timeout: this.timeout });
      
      if (options?.stream) {
        if (response.data.responses && response.data.responses.length > 0) {
          return response.data.responses[0];
        }
      }
      return response.data;
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(`Failed to generate response from Ollama model ${model}:`, error.message);
      } else {
        console.error(`Failed to generate response from Ollama model ${model}:`, error);
      }
      throw error;
    }
  }

  async pullModel(modelName: string): Promise<void> {
    try {
      console.log(`📥 Pulling Ollama model: ${modelName}...`);
      await axios.post(`${this.baseUrl}/api/pull`, { name: modelName, stream: true }, { timeout: 10 * 60 * 1000 });
      console.log(`✅ Model ${modelName} pulled successfully.`);
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(`❌ Failed to pull Ollama model ${modelName}:`, error.message);
      } else {
        console.error(`❌ Failed to pull Ollama model ${modelName}:`, error);
      }
      throw error;
    }
  }

  async unloadModel(modelName: string): Promise<void> {
    try {
      console.log(`🧹 Unloading Ollama model: ${modelName}...`);
      await axios.post(`${this.baseUrl}/api/unload`, { model: modelName }, { timeout: this.timeout });
      console.log(`✅ Model ${modelName} unloaded.`);
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(`❌ Failed to unload Ollama model ${modelName}:`, error.message);
      } else {
        console.error(`❌ Failed to unload Ollama model ${modelName}:`, error);
      }
      throw error;
    }
  }
}

// ================================
// MODEL MANAGEMENT SYSTEM
// ================================

class ModelManager {
  private ollamaClient: OllamaClient;
  private loadedModels: Map<ModelType, { lastUsed: number; loadingPromise: Promise<void> | null }>;
  private modelCache: Map<ModelType, OllamaResponse>;
  private activeModels: Set<ModelType>;

  constructor(ollamaClient: OllamaClient) {
    this.ollamaClient = ollamaClient;
    this.loadedModels = new Map();
    this.modelCache = new Map();
    this.activeModels = new Set();
  }

  async loadModel(modelType: ModelType): Promise<void> {
    if (this.loadedModels.has(modelType)) {
      this.loadedModels.get(modelType)!.lastUsed = Date.now();
      if (this.loadedModels.get(modelType)!.loadingPromise) {
        return this.loadedModels.get(modelType)!.loadingPromise!;
      }
    }

    console.log(`⏳ Loading model: ${modelType}...`);
    const loadingPromise = this.ollamaClient.pullModel(modelType)
      .then(() => {
        this.loadedModels.set(modelType, { lastUsed: Date.now(), loadingPromise: null });
        this.activeModels.add(modelType);
        console.log(`✅ Model ${modelType} loaded.`);
      })
      .catch(error => {
        console.error(`❌ Failed to load model ${modelType}:`, error);
        this.loadedModels.delete(modelType);
        this.activeModels.delete(modelType);
        throw error;
      });

    this.loadedModels.set(modelType, { lastUsed: Date.now(), loadingPromise });
    return loadingPromise;
  }

  async ensureModelLoaded(modelType: ModelType): Promise<void> {
    if (!this.activeModels.has(modelType)) {
      await this.loadModel(modelType);
    } else {
      this.loadedModels.get(modelType)!.lastUsed = Date.now();
    }
  }

  async unloadUnusedModels(thresholdMinutes: number = 30): Promise<void> {
    console.log(`🧹 Checking for unused models (threshold: ${thresholdMinutes} mins)...`);
    const now = Date.now();
    const modelsToUnload: ModelType[] = [];

    for (const [modelType, { lastUsed }] of this.loadedModels.entries()) {
      if (now - lastUsed > thresholdMinutes * 60 * 1000) {
        modelsToUnload.push(modelType);
      }
    }

    for (const modelType of modelsToUnload) {
      try {
        await this.ollamaClient.unloadModel(modelType);
        this.loadedModels.delete(modelType);
        this.activeModels.delete(modelType);
      } catch (error) {
        console.error(`❌ Error unloading model ${modelType}:`, error);
      }
    }
    console.log(`✅ Unloaded ${modelsToUnload.length} unused models.`);
  }

  getModelStats() {
    return {
      loadedModels: Array.from(this.loadedModels.keys()),
      activeModels: Array.from(this.activeModels.keys()),
      memoryUsage: 'TODO: Implement actual memory usage tracking per model'
    };
  }
}

// ================================
// CONTEXT AND CACHING SYSTEM
// ================================

class ResponseCache {
  private cache: Map<string, { response: LLMResponse; timestamp: number }>;
  private maxSize: number;
  private ttl: number;

  constructor(maxSize: number = 100, ttlMinutes: number = 60) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttlMinutes * 60 * 1000;
    this.cleanupInterval();
  }

  get(key: string): LLMResponse | undefined {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp < this.ttl) {
      this.cache.set(key, { ...entry, timestamp: Date.now() });
      return entry.response;
    }
    this.delete(key);
    return undefined;
  }

  set(key: string, value: LLMResponse): void {
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }
    this.cache.set(key, { response: value, timestamp: Date.now() });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  private evictOldest(): void {
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
    }
  }

  private cleanupInterval(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.cache.entries()) {
        if (now - entry.timestamp >= this.ttl) {
          this.cache.delete(key);
        }
      }
      console.log(`🧹 Cache cleanup: ${this.cache.size} items remaining.`);
    }, 5 * 60 * 1000);
  }
}

// ================================
// DINA LLM MANAGER MAIN CLASS
// ================================

export class DinaLLMManager {
  private ollamaClient: OllamaClient;
  private modelManager: ModelManager;
  private responseCache: ResponseCache;
  private isInitialized: boolean = false;

  constructor() {
    this.ollamaClient = new OllamaClient();
    this.modelManager = new ModelManager(this.ollamaClient);
    this.responseCache = new ResponseCache();
  }

  async initialize(): Promise<void> {
    console.log('🧠 Initializing DINA LLM Manager...');
    try {
      await Promise.all([
        this.modelManager.loadModel(ModelType.MISTRAL_7B),
        this.modelManager.loadModel(ModelType.CODELLAMA_34B),
        this.modelManager.loadModel(ModelType.LLAMA2_70B)
      ]);
      
      this.isInitialized = true;
      console.log('✅ DINA LLM Manager initialized. Models ready for use.');
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('❌ DINA LLM Manager initialization failed:', error.message);
      } else {
        console.error('❌ DINA LLM Manager initialization failed:', error);
      }
      this.isInitialized = false;
      throw error;
    }
  }

  async processLLMRequest(
    query: string,
    options: {
      userId: string;
      conversationId: string;
      preferences?: {
        preferredModel?: ModelType;
        streaming?: boolean;
      };
      streaming?: boolean;
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<LLMResponse> {
    if (!this.isInitialized) {
      throw new Error('LLM Manager not initialized. Call initialize() first.');
    }

    const cacheKey = `${options.userId}-${options.conversationId}-${query}`;
    if (this.responseCache.has(cacheKey)) {
      const cachedResponse = this.responseCache.get(cacheKey);
      if (cachedResponse) {
        console.log(`⚡ Serving response from cache for query: "${query.substring(0, 50)}..."`);
        return { ...cachedResponse, metadata: { ...cachedResponse.metadata, cached: true } };
      }
    }

    const startTime = performance.now();

    const complexityAnalysis = await llmIntelligenceEngine.analyzeQuery(query, options);
    const recommendedModel = options.preferences?.preferredModel || complexityAnalysis.recommendedModel;

    console.log(`🧠 Query Complexity: ${complexityAnalysis.level} (Recommended Model: ${recommendedModel})`);

    await this.modelManager.ensureModelLoaded(recommendedModel);
    const modelLoadTime = performance.now() - startTime;

    const context = await contextMemorySystem.getRelevantContext(options.userId, options.conversationId, query);
    const contextUsed = context.length > 0;
    
    let fullPrompt = query;
    if (contextUsed) {
      fullPrompt = `Context: ${context.join('\n')}\n\nQuery: ${query}`;
      console.log(`📚 Context applied for query: "${query.substring(0, 50)}..."`);
    }

    let ollamaResponse: OllamaResponse;
    try {
      ollamaResponse = await this.ollamaClient.generate(recommendedModel, fullPrompt, {
        stream: options.streaming,
        format: 'json'
      });
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(`Error from primary model ${recommendedModel}:`, error.message);
      } else {
        console.error(`Error from primary model ${recommendedModel}:`, error);
      }
      
      const fallbackModel = this.getFallbackModel(recommendedModel);
      if (fallbackModel) {
        console.warn(`🔄 Falling back to model: ${fallbackModel}`);
        await this.modelManager.ensureModelLoaded(fallbackModel);
        ollamaResponse = await this.ollamaClient.generate(fallbackModel, fullPrompt, {
          stream: options.streaming,
          format: 'json'
        });
      } else {
        throw new Error('No fallback model available and primary generation failed.');
      }
    }

    const processingTime = performance.now() - startTime;

    const estimatedInputTokens = this.estimateTokens(fullPrompt);
    const estimatedOutputTokens = this.estimateTokens(ollamaResponse.response);
    
    const llmResponse: LLMResponse = {
      id: `llm-res-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      model: ollamaResponse.model,
      response: ollamaResponse.response,
      tokens: {
        input: ollamaResponse.prompt_eval_count || estimatedInputTokens,
        output: ollamaResponse.eval_count || estimatedOutputTokens,
        total: (ollamaResponse.prompt_eval_count || estimatedInputTokens) + (ollamaResponse.eval_count || estimatedOutputTokens),
      },
      performance: {
        processingTime: processingTime,
        queueTime: 0,
        modelLoadTime: modelLoadTime,
      },
      confidence: await llmIntelligenceEngine.assessConfidence(ollamaResponse.response),
      metadata: {
        complexity: complexityAnalysis,
        context_used: contextUsed,
        cached: false,
        fallback_used: ollamaResponse.model !== recommendedModel
      },
    };

    this.responseCache.set(cacheKey, llmResponse);

    await contextMemorySystem.updateContext(options.userId, options.conversationId, query, llmResponse.response);
    
    await performanceOptimizer.recordPerformance({
      queryHash: llmIntelligenceEngine['hashQuery'](query),
      model: recommendedModel,
      complexity: complexityAnalysis.level,
      actualProcessingTime: processingTime,
      estimatedProcessingTime: complexityAnalysis.processingTime,
      tokens: llmResponse.tokens,
      success: true,
      quality: llmResponse.confidence
    });

    return llmResponse;
  }

  private getFallbackModel(failedModel: ModelType): ModelType | undefined {
    switch (failedModel) {
      case ModelType.MISTRAL_7B: return ModelType.LLAMA2_70B;
      case ModelType.CODELLAMA_34B: return ModelType.MISTRAL_7B;
      case ModelType.LLAMA2_70B: return ModelType.MISTRAL_7B;
      default: return undefined;
    }
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.split(/\s+/).length * 1.3);
  }

  async getSystemStatus(): Promise<any> {
    const isHealthy = await this.ollamaClient.isHealthy();
    const models = await this.ollamaClient.listModels();
    const modelStats = this.modelManager.getModelStats();
    
    return {
      initialized: this.isInitialized,
      ollamaHealthy: isHealthy,
      availableModels: models.length,
      loadedModels: modelStats.loadedModels.length,
      memoryUsage: modelStats.memoryUsage,
      activeStreams: 0,
      cacheSize: this.responseCache.size,
      performanceStats: performanceOptimizer.getPerformanceStats(),
      intelligenceStats: await llmIntelligenceEngine.getIntelligenceStats(),
      contextStats: contextMemorySystem.getContextStats()
    };
  }

  async getOptimizationRecommendations(): Promise<any[]> {
    return await performanceOptimizer.getOptimizationRecommendations();
  }

  async unloadUnusedModels(): Promise<void> {
    await this.modelManager.unloadUnusedModels();
  }

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down LLM Manager...');
    
    this.responseCache.clear();
    
    await database.log('info', 'llm-manager', 'LLM Manager shutdown completed');
    console.log('✅ LLM Manager shutdown complete');
  }
}

export const dinaLLMManager = new DinaLLMManager();

console.log('🚀 DINA LLM Manager module loaded successfully');
console.log('🎯 Ready for intelligent AI processing');
