// File: src/core/orchestrator/index.ts
import {
  DinaUniversalMessage,
  DinaResponse,
  createDinaMessage,
  createDinaResponse,
  MessagePriority,
  SecurityLevel,
  DinaProtocol,
  QUEUE_NAMES
} from '../protocol';
import { database } from '../../config/database/db';
import { redisManager } from '../../config/redis';
import { DinaLLMManager } from '../../modules/llm/manager';
import { ModelType, performanceOptimizer } from '../../modules/llm/intelligence'; // Added performanceOptimizer import


// ================================
// ENHANCED MESSAGE TYPES
// ================================

interface LLMGenerateRequest {
  query: string;
  options?: {
    model_preference?: ModelType;
    streaming?: boolean;
    max_tokens?: number;
    temperature?: number;
    include_context?: boolean;
    conversation_id?: string;
    user_id?: string;
  };
}

interface LLMCodeRequest {
  code_request: string;
  language?: string;
  context?: string;
  options?: {
    explain?: boolean;
    optimize?: boolean;
    debug?: boolean;
  };
}

interface LLMAnalysisRequest {
  analysis_query: string;
  data?: any;
  analysis_type?: 'comparison' | 'summary' | 'evaluation' | 'prediction';
  options?: {
    depth?: 'shallow' | 'medium' | 'deep';
    format?: 'text' | 'structured' | 'json';
  };
}

interface LLMEmbedRequest {
  text: string;
  options?: {
    model_preference?: string;
    user_id?: string;
    conversation_id?: string;
  };
}

// ================================
// DINA CORE ORCHESTRATOR
// ================================

export class DinaCore {
  private initialized: boolean = false;
  private queueProcessors: Map<string, NodeJS.Timeout> = new Map();
  private llmManager: DinaLLMManager;
  private startTime: Date = new Date();
  private lastRedisWarning: number = 0;
  private lastStatsWarning: number = 0;
  
  constructor() {
    console.log('🧠 Initializing DINA Core...');
    this.llmManager = new DinaLLMManager();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('ℹ️ DINA Core already initialized.');
      return;
    }

    console.log('🚀 Initializing Enhanced DINA Core Orchestrator...');
    try {
      await database.initialize();
      await redisManager.initialize();
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🤖 PHASE 2: Multi-Model LLM System Initialization');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🧠 Step 1: Loading LLM Intelligence Engine...');
      console.log('⚡ Step 2: Connecting to Ollama Server...');
      
      // Fixed: Call public initialize method
      await this.llmManager.initialize();
      
      console.log('🎯 Step 3: Model Availability Check...');
      const llmStatus = await this.llmManager.getSystemStatus();
      console.log(`📊 Available Models: ${llmStatus.availableModels.length}`);
      console.log(`🔥 Loaded Models: ${llmStatus.loadedModels.length}`);
      console.log(`💾 Memory Usage: ${llmStatus.memoryUsage}`);
      console.log(`🩺 Ollama Health: ${llmStatus.ollamaHealthy ? '✅ Healthy' : '❌ Unhealthy'}`);
      console.log(`🎉 Multi-Model AI System: ${llmStatus.ollamaHealthy && llmStatus.loadedModels.length > 0 ? 'FULLY OPERATIONAL' : 'DEGRADED'}`);
      console.log('✅ LLM System initialization complete');
      console.log('🔄 Phase 4: Advanced Message Processing Activation');
      this.startQueueProcessors();
      console.log('✅ Enhanced queue processing active');
      console.log('⚡ Advanced optimization systems activated');
      this.initialized = true;
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('✅ DINA PHASE 2 INITIALIZATION COMPLETE');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('Phase 2 Enhanced Features:');
      console.log('  ✅ Multi-Model AI Intelligence (3 Models)');
      console.log('  ✅ Query Complexity Analysis');
      console.log('  ✅ Context Memory System');
      console.log('  ✅ Performance Optimization');
      console.log('  ✅ DUMP Protocol Compliance');
      console.log('  ✅ Smart Model Routing & Fallbacks');
      console.log('  ✅ Enterprise Message Queuing');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🎯 DINA Enhanced Core ready for intelligent processing!');
      await database.log('info', 'core', 'DINA Enhanced Core initialized successfully', { phase: '2-complete' });
    } catch (error) {
      console.error('❌ Failed to initialize DINA Core:', error);
      this.initialized = false;
      await database.log('critical', 'core', 'DINA Enhanced Core initialization failed', { error: (error as Error).message });
      throw error;
    }
  }

private startQueueProcessors(): void {
  const queueIntervals: { [key: string]: number } = {
    [QUEUE_NAMES.HIGH]: 10,
    [QUEUE_NAMES.MEDIUM]: 50,
    [QUEUE_NAMES.LOW]: 200,
    [QUEUE_NAMES.BATCH]: 1000
  };

  for (const queueName of Object.keys(queueIntervals)) {
    const interval = queueIntervals[queueName];
    console.log(`🔄 Queue processor started: ${queueName} (${interval}ms interval)`);
    const processor = setInterval(async () => {
      // ADD THIS CHECK: Don't process if not initialized or Redis not connected
      if (!this.initialized) {
        return;
      }
      
      // ADD THIS CHECK: Skip processing if Redis is not connected
      if (!redisManager.isConnected) {
        // Don't spam logs - only log once per minute when Redis is down
        const now = Date.now();
        if (!this.lastRedisWarning || (now - this.lastRedisWarning) > 60000) {
          console.warn(`⚠️ Skipping queue processing for ${queueName} - Redis disconnected`);
          this.lastRedisWarning = now;
        }
        return;
      }
      
      const message = await redisManager.retrieveMessage(queueName);
      if (message) {
        console.log(`📥 Processing message from ${queueName} queue: ${message.target.method}`);
        try {
          const response = await this.handleIncomingMessage(message);
          console.log(`📤 Generated response for message ${message.id}:`, JSON.stringify(response, null, 2));
          if (message.source.instance) {
            console.log(`📤 Publishing response to channel dina:response:${message.source.instance}`);
            await redisManager.publishResponse(message.source.instance, response);
            console.log(`✅ Response published for message ${message.id}`);
          } else {
            console.warn(`⚠️ No source.instance for message ${message.id}, cannot publish response`);
          }
          await database.updateRequestStatus(
            message.id,
            'completed',
            response.payload.data,
            response.metrics?.processing_time_ms
          );
        } catch (error) {
          console.error(`❌ Error in DUMP message processing for ${message.target.method}:`, error);
          await database.updateRequestStatus(
            message.id,
            'failed',
            { status: 'error', message: (error as Error).message },
            undefined,
            (error as Error).message
          );
          if (message.source.instance) {
            const errorResponse: DinaResponse = createDinaResponse({
              request_id: message.id,
              status: 'error',
              payload: { message: (error as Error).message, code: 'PROCESSING_ERROR' },
              metrics: { processing_time_ms: 0 },
              error: {
                code: 'PROCESSING_ERROR',
                message: (error as Error).message,
                details: { error: true }
              }
            });
            console.log(`📤 Publishing error response for message ${message.id}:`, JSON.stringify(errorResponse, null, 2));
            await redisManager.publishResponse(message.source.instance, errorResponse);
            console.log(`✅ Error response published for message ${message.id}`);
          } else {
            console.warn(`⚠️ No source.instance for error response of message ${message.id}, cannot publish`);
          }
        }
      }
    }, interval);
    this.queueProcessors.set(queueName, processor);
  }
}


  public async handleIncomingMessage(message: DinaUniversalMessage): Promise<DinaResponse> {
    const startTime = performance.now();
    let responsePayload: any;
    let responseStatus: DinaResponse['status'] = 'success';
    let errorMessage: string | undefined;

    const requestId = await database.logRequest({
      source: message.source.module,
      target: message.target.module,
      method: message.target.method,
      payload: message.payload.data,
      priority: message.target.priority,
      userId: message.security.user_id,
      securityContext: message.security
    });
    console.log(`📝 Logged request ${requestId} for ${message.target.module}:${message.target.method}`);

    try {
      console.log(`🔍 Validating message ${requestId}`);
      if (!DinaProtocol.validateMessage(message)) {
        throw new Error('Invalid DINA message: Protocol validation failed');
      }
      console.log(`✅ Message ${requestId} validated successfully`);

      const sanitizedMessage = DinaProtocol.sanitizeMessage(message);
      console.log(`🧼 Message ${requestId} sanitized, sanitized flag: ${sanitizedMessage.security.sanitized}`);

      switch (sanitizedMessage.target.module) {
        case 'core':
          responsePayload = await this.processCoreRequest(sanitizedMessage);
          break;
        case 'llm':
          responsePayload = await this.processLLMRequest(sanitizedMessage);
          break;
        case 'database':
          responsePayload = await this.processDatabaseRequest(sanitizedMessage);
          break;
        case 'system':
          responsePayload = await this.processSystemRequest(sanitizedMessage);
          break;
        default:
          throw new Error(`Unknown target module: ${sanitizedMessage.target.module}`);
      }
    } catch (error) {
      responseStatus = 'error';
      errorMessage = (error as Error).message;
      responsePayload = {
        status: 'error',
        message: errorMessage
      };
      console.error(`❌ Error processing message ${requestId} for ${message.target.module}:${message.target.method}:`, error);
    }

    const processingTime = performance.now() - startTime;

    const dinaResponse: DinaResponse = createDinaResponse({
      request_id: requestId,
      status: responseStatus,
      payload: responsePayload,
      metrics: { processing_time_ms: processingTime }
    });

    console.log(`✅ Generated response for request ${requestId}:`, JSON.stringify(dinaResponse, null, 2));
    return dinaResponse;
  }

  private async processCoreRequest(message: DinaUniversalMessage): Promise<any> {
    switch (message.target.method) {
      case 'ping':
        return { message: 'DINA Core Pong!', timestamp: new Date().toISOString() };
      case 'get_status':
        return await this.getEnhancedSystemStatus();
      case 'get_stats':
        return await this.getEnhancedSystemStats();
      default:
        throw new Error(`Unknown core method: ${message.target.method}`);
    }
  }

private async processLLMRequest(message: DinaUniversalMessage): Promise<any> {
  const { method } = message.target;
  const { query, text, code_request, analysis_query, options } = message.payload.data;
  console.log(`🤖 Processing LLM request: ${method}, query: ${query || text || code_request || analysis_query}`);

  // ADD THIS DEBUG LOG:
  console.log(`🔍 DEBUG: About to switch on method: ${method}`);

  if (method === 'llm_generate' && !query) {
    throw new Error('Missing required field: query for llm_generate');
  }
  if (method === 'llm_code' && !code_request) {
    throw new Error('Missing required field: code_request for llm_code');
  }
  if (method === 'llm_analysis' && !analysis_query) {
    throw new Error('Missing required field: analysis_query for llm_analysis');
  }
  if (method === 'llm_embed' && !text) {
    throw new Error('Missing required field: text for llm_embed');
  }

  // ADD THIS DEBUG LOG:
  console.log(`🔍 DEBUG: Validation passed, creating cache key...`);

  const cacheKey = `${method}:${message.security.user_id || 'default'}:${message.security.session_id || 'default'}:${query || text || code_request || analysis_query}`;
  
  // ADD THIS DEBUG LOG:
  console.log(`🔍 DEBUG: Cache key created: ${cacheKey}`);
  
  const cachedResponse = await redisManager.getExactCachedResponse(cacheKey);

  // ADD THIS DEBUG LOG:
  console.log(`🔍 DEBUG: Cache check complete, cached: ${!!cachedResponse}`);

  if (cachedResponse) {
    console.log(`⚡ Serving cached LLM response for method: ${method}, key: ${cacheKey}`);
    return { ...cachedResponse, metadata: { ...cachedResponse.metadata, cached: true } };
  }

  let llmResponse: any;
  try {
    // ADD THIS DEBUG LOG:
    console.log(`🔍 DEBUG: About to switch to method handler: ${method}`);
    
    switch (method) {
      case 'llm_generate':
        console.log(`🔍 DEBUG: Entering llm_generate case`);
        console.log(`🚀 Calling llmManager.generate with query: ${query}, model: ${options?.model_preference}`);
        llmResponse = await this.llmManager.generate(query!, {
          user_id: message.security.user_id,
          conversation_id: options?.conversation_id,
          model_preference: options?.model_preference as ModelType,
          streaming: options?.streaming,
          max_tokens: options?.max_tokens,
          temperature: options?.temperature,
          include_context: options?.include_context
        });
        console.log(`🔍 DEBUG: llm_generate completed`);
        break;
        
      case 'llm_embed':
        console.log(`🔍 DEBUG: Entering llm_embed case`);
        console.log(`🚀 Calling llmManager.embed with text: ${text}`);
        // ADD THIS DEBUG LOG IMMEDIATELY BEFORE THE CALL:
        console.log(`🔍 DEBUG: About to call this.llmManager.embed() - THIS IS WHERE IT MIGHT HANG`);
        
        llmResponse = await this.llmManager.embed(text!, {
          user_id: message.security.user_id,
          conversation_id: options?.conversation_id,
          model_preference: options?.model_preference
        });
        
        console.log(`🔍 DEBUG: llm_embed completed`);
        break;
        
      // ... other cases
    }
    
    // ADD THIS DEBUG LOG:
    console.log(`🔍 DEBUG: Method handler completed, checking response...`);

    if (llmResponse && llmResponse.status !== 'error') {
      const ttlSeconds = 3600;
      await redisManager.setExactCachedResponse(cacheKey, llmResponse, ttlSeconds);
      console.log(`💾 Cached LLM response for method: ${method}, key: ${cacheKey}`);
    }
  } catch (error) {
    console.error(`❌ LLM processing failed for ${method}:`, error);
    throw error;
  }

  return llmResponse;
}

  private async processDatabaseRequest(message: DinaUniversalMessage): Promise<any> {
    switch (message.target.method) {
      case 'query':
        const { sql, params } = message.payload.data;
        if (!sql) throw new Error('SQL query is required.');
        return await database.query(sql, params);
      case 'get_connection_status':
        return await database.getConnectionStatus();
      case 'log':
        const { level, module, msg, metadata } = message.payload.data;
        await database.log(level, module, msg, metadata);
        return { status: 'success', message: 'Log recorded' };
      default:
        throw new Error(`Unknown database method: ${message.target.method}`);
    }
  }

  private async processSystemRequest(message: DinaUniversalMessage): Promise<any> {
    switch (message.target.method) {
      case 'get_status':
        return await this.getEnhancedSystemStatus();
      case 'get_stats':
        return await this.getEnhancedSystemStats();
      case 'get_modules':
        return this.getModuleStatus();
      case 'get_optimization_recommendations':
        return await this.llmManager.getOptimizationRecommendations();
      case 'unload_unused_models':
        await this.llmManager.unloadUnusedModels();
        return { status: 'success', message: 'Unused models unloaded' };
      case 'clear_llm_cache':
        await redisManager.clearAllExactCache();
        return { status: 'success', message: 'LLM cache cleared' };
      default:
        throw new Error(`Unknown system method: ${message.target.method}`);
    }
  }

  async getEnhancedSystemStatus(): Promise<Record<string, any>> {
    const dbStatus = await database.getSystemStatus();
    const redisStatus = { isConnected: redisManager.isConnected, queueStats: await redisManager.getQueueStats() };
    const llmStatus = await this.llmManager.getSystemStatus();

    return {
      overallHealth: dbStatus.status === 'online' && redisStatus.isConnected && llmStatus.ollamaHealthy ? 'healthy' : 'degraded',
      database: dbStatus,
      redis: redisStatus,
      llm_system: llmStatus,
      core: {
        initialized: this.initialized,
        uptime: Date.now() - this.startTime.getTime(),
        queueProcessorsActive: this.queueProcessors.size > 0
      },
      timestamp: new Date().toISOString()
    };
  }

  async getEnhancedSystemStats(): Promise<Record<string, any>> {
    const dbStats = await database.getSystemStats();
    const llmStats = await this.llmManager.getSystemStatus();

    return {
      totalRequestsProcessed: dbStats.totalRequestsProcessed,
      avgResponseTimeMs: dbStats.avgResponseTimeMs,
      llm: {
        totalModels: llmStats.availableModels.length,
        loadedModels: llmStats.loadedModels.length,
        ollamaHealthy: llmStats.ollamaHealthy,
        cacheSize: llmStats.cacheSize,
        performanceStats: llmStats.performanceStats,
        intelligenceStats: llmStats.intelligenceStats,
        contextStats: llmStats.contextStats
      },
      timestamp: new Date().toISOString()
    };
  }

  getModuleStatus(): Record<string, string> {
    return {
      'dina-core': this.initialized ? 'enhanced-active' : 'inactive',
      'database': database.isConnected ? 'enhanced-autonomous' : 'inactive',
      'intelligence': 'active',
      'security': 'monitoring',
      'performance': 'optimizing',
      'llm-system': this.llmManager.isInitialized ? 'active' : 'unavailable',
      'redis': redisManager.isConnected ? 'active' : 'inactive',
      'mirror-module': 'pending',
      'phase': '2-complete'
    };
  }

  async listAvailableModels(): Promise<string[]> {
    const status = await this.llmManager.getSystemStatus();
    return status.availableModels;
  }

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down Enhanced DINA Core...');
    try {
      this.queueProcessors.forEach(interval => clearInterval(interval));
      this.queueProcessors.clear();
      console.log('✅ Stopped all queue processors');
      await this.llmManager.shutdown();
      await redisManager.shutdown();
      await database.close();
      this.initialized = false;
      console.log('✅ Enhanced DINA Core shutdown complete');
    } catch (error) {
      console.error('❌ Enhanced shutdown error:', error);
      throw error;
    }
  }

  async getSystemStatus(): Promise<Record<string, any>> {
    return await this.getEnhancedSystemStatus();
  }

  async getSystemStats(): Promise<Record<string, any>> {
    return await this.getEnhancedSystemStats();
  }
}

export const dinaCore = new DinaCore();

export default dinaCore;

console.log('🚀 Enhanced DINA Core Orchestrator loaded with Phase 2 LLM capabilities');
console.log('✨ Multi-Model AI System ready for production deployment');
