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

async generate(prompt: string, model: string): Promise<OllamaResponse> {
  console.log(`📡 Sending request to Ollama for model ${model}, prompt: "${prompt.substring(0, 50)}..."`);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.error(`⏰ Ollama generate timeout for model ${model}`);
      controller.abort();
    }, 60000); // 60 second timeout

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        model, 
        prompt,
        stream: false,  // This actually still returns streaming format!
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

  async embed(input: string, model: string = 'mxbai-embed-large'): Promise<OllamaEmbeddingResponse> {
    console.log(`📡 Generating embedding for input: "${input.substring(0, 50)}..." using ${model}`);
    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input }),
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
          tokens: response.tokens,
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

  // FIXED: Made public
  public async generate(query: string, options?: any): Promise<LLMResponse> {
    console.log(`🧠 Generating response for query: "${query.substring(0, 50)}..."`);
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
    
    console.log(`✅ Generated response: id=${response.id}, model=${model}`);
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

  async getModelCapabilities(): Promise<Record<string, any>> {
    console.log('📋 Fetching model capabilities...');
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
    console.log(`✅ Model capabilities: ${Object.keys(capabilities).join(', ')}`);
    return capabilities;
  }
}
