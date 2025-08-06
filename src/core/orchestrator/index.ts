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
import { digiMOrchestrator} from '../../modules/digim';
import { isDigiMMessage } from '../../modules/digim/types';

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
        console.log('🔐 Unified authentication system initialized via database');
        
        await redisManager.initialize();
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🤖 PHASE 2: Multi-Model LLM System Initialization');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        await this.llmManager.initialize();
        console.log('✅ LLM System initialization complete');
        
        // ADD DIGIM INITIALIZATION HERE:
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🧠 PHASE 1.5: DIGIM Intelligence Module Initialization');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📊 Step 1: Loading DIGIM Foundation...');
        
        await digiMOrchestrator.initialize();
        
        console.log('🎯 Step 2: DIGIM Integration Check...');
        const digiMStatus = digiMOrchestrator.moduleStatus;
        console.log(`📈 DIGIM Health: ${digiMStatus === 'healthy' ? '✅ Operational' : '⚠️ Degraded'}`);
        console.log(`🔄 DIGIM Sources: ${digiMOrchestrator.getActiveSources().length} configured`);
        console.log(`✨ DIGIM Foundation: ${digiMOrchestrator.isInitialized ? 'READY' : 'FAILED'}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ DIGIM PHASE 1 INITIALIZATION COMPLETE');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('DIGIM Phase 1 Features:');
        console.log('  ✅ DUMP Protocol Integration');
        console.log('  ✅ Database Schema Foundation');
        console.log('  ✅ Source Management Framework');
        console.log('  ✅ Security Framework (Basic)');
        console.log('  ✅ Health Monitoring System');
        console.log('  ✅ Natural Language Query Interface');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');


        // ADD MIRROR INITIALIZATION HERE:
       
        
        console.log('🔄 Phase 4: Advanced Message Processing Activation');
        this.startQueueProcessors();
        
        this.initialized = true;
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ DINA ENHANCED CORE INITIALIZATION COMPLETE');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        await database.log('info', 'core', 'DINA Enhanced Core with DIGIM initialized successfully', { 
          phase: '2-complete-with-digim',
          digim_status: digiMStatus,
          digim_sources: digiMOrchestrator.getActiveSources().length
        });
        
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
  private isMirrorMessage(message: DinaUniversalMessage): boolean {
    const validMirrorMethods = [
      'mirror_submit_profile',
      'mirror_get_insights', 
      'mirror_get_patterns',
      'mirror_answer_question',
      'deep_facial_analysis',
      'detect_patterns',
      'temporal_analysis',
      'mirror_feedback'
    ];
    
    return validMirrorMethods.includes(message.target.method);
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
    
      try {
        console.log(`🔍 Validating message ${requestId}`);
        
        // ENHANCED DEBUGGING: Log the original message structure
        console.log(`📋 Original message structure:`, {
          source: message.source,
          target: message.target,
          targetModule: message.target?.module,
          targetModuleType: typeof message.target?.module,
          fullMessage: JSON.stringify(message, null, 2)
        });
        
        if (!DinaProtocol.validateMessage(message)) {
          throw new Error('Invalid DINA message: Protocol validation failed');
        }
    
        const sanitizedMessage = DinaProtocol.sanitizeMessage(message);
        
        // ENHANCED DEBUGGING: Log the sanitized message structure
        console.log(`🧹 Sanitized message structure:`, {
          source: sanitizedMessage.source,
          target: sanitizedMessage.target,
          targetModule: sanitizedMessage.target?.module,
          targetModuleType: typeof sanitizedMessage.target?.module,
          isTargetModuleString: typeof sanitizedMessage.target?.module === 'string',
          sanitizedTargetKeys: Object.keys(sanitizedMessage.target || {}),
          fullSanitizedMessage: JSON.stringify(sanitizedMessage, null, 2)
        });
    
        // SAFETY CHECK: Ensure target.module is a string
        if (!sanitizedMessage.target || typeof sanitizedMessage.target.module !== 'string') {
          throw new Error(
            `Invalid target module format. Expected string, got: ${typeof sanitizedMessage.target?.module}. ` +
            `Value: ${JSON.stringify(sanitizedMessage.target?.module)}. ` +
            `Full target: ${JSON.stringify(sanitizedMessage.target)}`
          );
        }
    
        const targetModule = sanitizedMessage.target.module;
        console.log(`🎯 Processing target module: "${targetModule}" (type: ${typeof targetModule})`);
    
        // ADD DIGIM ROUTING HERE:
        switch (targetModule) {
          case 'core':
            console.log('🏛️ Routing to CORE module');
            responsePayload = await this.processCoreRequest(sanitizedMessage);
            break;
          case 'llm':
            console.log('🤖 Routing to LLM module');
            responsePayload = await this.processLLMRequest(sanitizedMessage);
            break;
          case 'database':
            console.log('🗄️ Routing to DATABASE module');
            responsePayload = await this.processDatabaseRequest(sanitizedMessage);
            break;
          case 'system':
            console.log('⚙️ Routing to SYSTEM module');
            responsePayload = await this.processSystemRequest(sanitizedMessage);
            break;
          // ADD DIGIM CASE:
          case 'digim':
            console.log(`🧠 Routing to DIGIM: ${sanitizedMessage.target.method}`);
            if (!isDigiMMessage(sanitizedMessage)) {
              throw new Error('Invalid DIGIM message format');
            }
            const digiMResponse = await digiMOrchestrator.handleIncomingMessage(sanitizedMessage);
            responsePayload = digiMResponse.payload.data;
            break;

          default:
            // ENHANCED ERROR: Provide more detailed information
            const availableModules = ['core', 'llm', 'database', 'system', 'digim'];
            throw new Error(
              `Unknown target module: "${targetModule}" (type: ${typeof targetModule}). ` +
              `Available modules: ${availableModules.join(', ')}. ` +
              `Full target object: ${JSON.stringify(sanitizedMessage.target)}`
            );
        }
      } catch (error) {
        responseStatus = 'error';
        errorMessage = (error as Error).message;
        responsePayload = {
          status: 'error',
          message: errorMessage,
          // ENHANCED ERROR PAYLOAD: Include debugging info
          debug: {
            originalTargetModule: message.target?.module,
            targetModuleType: typeof message.target?.module,
            timestamp: new Date().toISOString(),
            requestId
          }
        };
        console.error(`❌ Error processing message ${requestId}:`, error);
        
        // Log the full error context
        console.error(`🔍 Error context:`, {
          originalMessage: JSON.stringify(message, null, 2),
          errorMessage: (error as Error).message,
          errorStack: (error as Error).stack
        });
      }
    
      const processingTime = performance.now() - startTime;
      
      const dinaResponse: DinaResponse = createDinaResponse({
        request_id: requestId,
        status: responseStatus,
        payload: responsePayload,
        metrics: { processing_time_ms: processingTime }
      });
    
      console.log(`📤 Generated response for message ${requestId}:`, JSON.stringify(dinaResponse, null, 2));
      
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
    
    // ADD DIGIM STATUS:
    const digiMStatus = {
      initialized: digiMOrchestrator.isInitialized,
      health: digiMOrchestrator.moduleStatus,
      active_sources: digiMOrchestrator.getActiveSources().length,
      phase: 'foundation'
    };
  
    return {
      overallHealth: dbStatus.status === 'online' && 
                     redisStatus.isConnected && 
                     llmStatus.ollamaHealthy && 
                     digiMOrchestrator.moduleStatus === 'healthy' ? 'healthy' : 'degraded',
      database: dbStatus,
      redis: redisStatus,
      llm_system: llmStatus,
      // ADD DIGIM STATUS:
      digim: digiMStatus,
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
      'mirror':'active-foundation',
      'digim': digiMOrchestrator.isInitialized ? 
        `${digiMOrchestrator.moduleStatus}-phase1` : 'inactive',
      'phase': '2-complete-with-digim'
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
      
      // ADD DIGIM SHUTDOWN LOGIC:
      await digiMOrchestrator.shutdown();
      console.log('✅ DIGIM shutdown complete');

      // ADD MIRROR SHUTDOWN LOGIC

      
      await redisManager.shutdown();
      await database.close();
      this.initialized = false;
      console.log('✅ Enhanced DINA Core with DIGIM shutdown complete');
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
