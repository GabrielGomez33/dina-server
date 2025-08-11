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
import { v4 as uuidv4 } from 'uuid';
import { performance } from 'perf_hooks';

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
      
      // CRITICAL: Prevent recursive loops and stack overflow
      const callDepth = (message as any).__callDepth || 0;
      if (callDepth > 5) {
        console.error('❌ Maximum call depth exceeded, preventing stack overflow');
        return this.createErrorResponse(message.id, 'RECURSION_ERROR', 'Maximum recursion depth exceeded');
      }
      
      (message as any).__callDepth = callDepth + 1;
    
      let responsePayload: any;
      let responseStatus: 'success' | 'error' | 'processing' | 'queued' = 'success';
      let errorMessage: string | undefined;
      
      const requestId = `dina_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
      try {
        await database.logRequest({
          source: message.source.module,
          target: message.target.module,
          method: message.target.method,
          payload: message.payload,
          priority: message.target.priority,
          userId: message.security.user_id,
          securityContext: message.security
        });
    
        console.log(`🔍 Processing message ${requestId}: ${message.target.module}.${message.target.method}`);
    
        if (!DinaProtocol.validateMessage(message)) {
          throw new Error('Invalid DINA message: Protocol validation failed');
        }
    
        const sanitizedMessage = DinaProtocol.sanitizeMessage(message);
        console.log(`🧹 Message sanitized successfully for ${requestId}`);
    
        if (!sanitizedMessage.target || typeof sanitizedMessage.target.module !== 'string') {
          throw new Error(
            `Invalid target module format. Expected string, got: ${typeof sanitizedMessage.target?.module}`
          );
        }
    
        const targetModule = sanitizedMessage.target.module;
        console.log(`🎯 Routing to module: "${targetModule}" with method: "${sanitizedMessage.target.method}"`);
    
        // Enhanced routing with proper error handling
        switch (targetModule) {
          case 'core':
            console.log('🏛️ Processing CORE request');
            responsePayload = await this.processCoreRequest(sanitizedMessage);
            break;
            
          case 'llm':
            console.log('🤖 Processing LLM request');
            responsePayload = await this.processLLMRequest(sanitizedMessage);
            break;
            
          case 'database':
            console.log('🗄️ Processing DATABASE request');
            responsePayload = await this.processDatabaseRequest(sanitizedMessage);
            break;
            
          case 'system':
            console.log('⚙️ Processing SYSTEM request');
            responsePayload = await this.processSystemRequest(sanitizedMessage);
            break;
            
          case 'digim':
            console.log('🧠 Processing DIGIM request');
            if (!isDigiMMessage(sanitizedMessage)) {
              throw new Error('Invalid DIGIM message format');
            }
            const digiMResponse = await digiMOrchestrator.handleIncomingMessage(sanitizedMessage);
            responsePayload = digiMResponse.payload.data;
            break;
            
          default:
            const availableModules = ['core', 'llm', 'database', 'system', 'digim'];
            throw new Error(
              `Unknown target module: "${targetModule}". ` +
              `Available modules: ${availableModules.join(', ')}`
            );
        }
    
        console.log(`✅ Successfully processed ${requestId} in ${(performance.now() - startTime).toFixed(2)}ms`);
    
      } catch (error) {
        console.error(`❌ Error processing message ${requestId}:`, error);
        
        responseStatus = 'error';
        errorMessage = (error as Error).message;
        responsePayload = {
          status: 'error',
          message: errorMessage,
          debug: {
            originalTargetModule: message.target?.module,
            targetModuleType: typeof message.target?.module,
            timestamp: new Date().toISOString(),
            requestId: requestId,
            callDepth: callDepth
          }
        };
    
        // ✅ CORRECTED: Log error with proper method signature
        try {
          await database.log('error', 'orchestrator', errorMessage, {
            request_id: requestId,
            target_module: message.target?.module,
            target_method: message.target?.method,
            user_id: message.security?.user_id,
            error_type: (error as Error).name,
            call_depth: callDepth,
            stack_trace: process.env.NODE_ENV === 'development' ? (error as Error).stack : undefined
          });
        } catch (dbError) {
          console.error('❌ Failed to log error to database:', dbError);
        }
      }
    
      const processingTime = performance.now() - startTime;
    
      const dinaResponse: DinaResponse = createDinaResponse({
        request_id: requestId,
        status: responseStatus,
        payload: responsePayload,
        metrics: { 
          processing_time_ms: processingTime,
          queue_time_ms: message.trace.queue_time_ms || 0
        },
        error: errorMessage ? {
          code: responseStatus === 'error' ? 'PROCESSING_ERROR' : 'UNKNOWN_ERROR',
          message: errorMessage,
          details: {
            target_module: message.target?.module,
            target_method: message.target?.method,
            processing_time: processingTime
          }
        } : undefined
      });
    
      console.log(`📤 Response generated for ${requestId}: status=${responseStatus}, time=${processingTime.toFixed(2)}ms`);
      
      return dinaResponse;
    }

  private createErrorResponse(
    requestId: string, 
    errorCode: string = 'PROCESSING_ERROR', 
    message: string = 'An error occurred during processing',
    details?: any
  ): DinaResponse {
    
    return {
      request_id: requestId,
      id: uuidv4(), // Make sure to import { v4 as uuidv4 } from 'uuid';
      timestamp: new Date().toISOString(),
      status: 'error',
      payload: {
        data: null,
        metadata: {
          error: true,
          error_code: errorCode
        }
      },
      error: {
        code: errorCode,
        message: message,
        details: details
      },
      metrics: {
        processing_time_ms: 0,
        queue_time_ms: 0
      }
    };
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
  console.log(`🤖 Processing LLM request: ${method}`);

  // CRITICAL: Flexible payload extraction for different nesting levels
  const extractPayloadData = (payload: any, field: string): any => {
    // Direct access (correct structure)
    if (payload[field] !== undefined) {
      console.log(`✅ Found ${field} at direct level`);
      return payload[field];
    }
    
    // Nested data access (current structure from API)
    if (payload.data && payload.data[field] !== undefined) {
      console.log(`✅ Found ${field} at data level`);
      return payload.data[field];
    }
    
    // Double-nested access (backward compatibility)
    if (payload.data && payload.data.data && payload.data.data[field] !== undefined) {
      console.log(`✅ Found ${field} at data.data level`);
      return payload.data.data[field];
    }
    
    return undefined;
  };

  // Extract data with flexible handling
  const query = extractPayloadData(message.payload, 'query');
  const text = extractPayloadData(message.payload, 'text');
  const code_request = extractPayloadData(message.payload, 'code_request');
  const analysis_query = extractPayloadData(message.payload, 'analysis_query');
  const options = extractPayloadData(message.payload, 'options') || {};

  console.log(`🔍 Extracted data: query=${!!query}, text=${!!text}, code_request=${!!code_request}, analysis_query=${!!analysis_query}`);

  // Enhanced validation with helpful error messages
  if (method === 'llm_generate' && !query) {
    console.error('❌ Missing query for llm_generate');
    console.error('Payload structure:', JSON.stringify(message.payload, null, 2));
    throw new Error('Missing required field: query for llm_generate');
  }
  
  if (method === 'llm_embed' && !text) {
    console.error('❌ Missing text for llm_embed');
    console.error('Payload structure:', JSON.stringify(message.payload, null, 2));
    throw new Error('Missing required field: text for llm_embed');
  }

  // Cache handling
  const cacheKey = `llm:${method}:${message.security.user_id || 'default'}:${query || text || code_request || analysis_query}`;
  const cachedResponse = await redisManager.getExactCachedResponse(cacheKey);

  if (cachedResponse) {
    console.log(`⚡ Serving cached LLM response for method: ${method}`);
    return { ...cachedResponse, metadata: { ...cachedResponse.metadata, cached: true } };
  }

  let llmResponse: any;
  try {
    console.log(`🚀 Processing LLM method: ${method}`);
    
    switch (method) {
      case 'llm_generate':
        console.log(`🧠 Generating response for query: "${query.substring(0, 50)}..."`);
        llmResponse = await this.llmManager.generate(query, {
          user_id: message.security.user_id,
          conversation_id: options?.conversation_id,
          model_preference: options?.model_preference,
          streaming: options?.streaming,
          max_tokens: options?.max_tokens,
          temperature: options?.temperature,
          include_context: options?.include_context
        });
        break;
        
      case 'llm_embed':
        console.log(`🔢 Generating embedding for text: "${text.substring(0, 50)}..."`);
        llmResponse = await this.llmManager.embed(text, {
          user_id: message.security.user_id,
          conversation_id: options?.conversation_id,
          model_preference: options?.model_preference
        });
        break;
        
      case 'llm_code':
        if (!code_request) throw new Error('Missing required field: code_request for llm_code');
        llmResponse = await this.llmManager.generateCode(code_request, options);
        break;
        
      case 'llm_analysis':
        if (!analysis_query) throw new Error('Missing required field: analysis_query for llm_analysis');
        llmResponse = await this.llmManager.analyze(analysis_query, options);
        break;
        
      default:
        throw new Error(`Unsupported LLM method: ${method}`);
    }

    console.log(`✅ LLM processing completed for ${method}`);

    // Cache successful responses
    if (llmResponse && llmResponse.status !== 'error') {
      await redisManager.setExactCachedResponse(cacheKey, llmResponse, 3600);
      console.log(`💾 Cached LLM response for method: ${method}`);
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
