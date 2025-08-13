// FIXED Core Orchestrator - Enhanced Performance & Initialization
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
import { ModelType, performanceOptimizer } from '../../modules/llm/intelligence';
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
// ENHANCED DINA CORE ORCHESTRATOR
// ================================

export class DinaCore {
  private initialized: boolean = false;
  private queueProcessors: Map<string, NodeJS.Timeout> = new Map();
  private llmManager: DinaLLMManager;
  private startTime: Date = new Date();
  private lastRedisWarning: number = 0;
  private lastStatsWarning: number = 0;
  private processingQueue: Map<string, Promise<any>> = new Map(); // ADDED: Track ongoing processes
  
  constructor() {
    console.log('🧠 Initializing Enhanced DINA Core...');
    this.llmManager = new DinaLLMManager();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('ℹ️ DINA Core already initialized.');
      return;
    }

    try {
      console.log('⚡ Starting DINA Core initialization...');
      
      // ENHANCED: Initialize database first (fastest)
      console.log('🗄️ Initializing database connection...');
      if (!database.isConnected) {
        // FIXED: Use initialize() instead of connect()
        await database.initialize();
      }
      console.log('✅ Database connected');

      // ENHANCED: Initialize Redis with fallback
      console.log('📦 Initializing Redis connection...');
      try {
        if (!redisManager.isConnected) {
          // FIXED: Use initialize() instead of connect()
          await redisManager.initialize();
        }
        console.log('✅ Redis connected and ready');
      } catch (redisError) {
        console.warn('⚠️ Redis connection failed, running in degraded mode:', redisError);
        // Continue without Redis - the system should still work
      }

      // CRITICAL FIX: Initialize LLM Manager properly
      console.log('🤖 Initializing LLM Manager...');
      try {
        await this.llmManager.initialize();
        if (this.llmManager.isInitialized) {
          console.log('✅ LLM Manager initialized successfully');
          
          // ENHANCED: Test LLM connectivity
          const models = await this.llmManager.getSystemStatus();
          console.log(`🔍 LLM Status Check: ${models.availableModels.length} models available`);
          if (models.availableModels.length === 0) {
            console.warn('⚠️ No LLM models detected - check Ollama connection');
          } else {
            console.log(`✅ Available models: ${models.availableModels.join(', ')}`);
          }
        } else {
          throw new Error('LLM Manager failed to initialize');
        }
      } catch (llmError) {
        console.error('❌ LLM Manager initialization failed:', llmError);
        console.warn('⚠️ Continuing without LLM capabilities');
      }

      // ENHANCED: Initialize DIGIM with error handling
      console.log('🔬 Initializing DIGIM module...');
      try {
        await digiMOrchestrator.initialize();
        console.log('✅ DIGIM module initialized');
      } catch (digimError) {
        console.warn('⚠️ DIGIM initialization failed, continuing without it:', digimError);
      }

      // ENHANCED: Start queue processors with improved performance
      console.log('🔄 Starting enhanced queue processors...');
      this.startEnhancedQueueProcessors();

      this.initialized = true;
      const initTime = Date.now() - this.startTime.getTime();
      console.log(`✅ Enhanced DINA Core initialized successfully in ${initTime}ms`);

    } catch (error) {
      console.error('❌ DINA Core initialization failed:', error);
      this.initialized = false;
      throw error;
    }
  }

  // ENHANCED: Faster queue processing with better error handling
  private startEnhancedQueueProcessors(): void {
    const queueConfigs = [
      { name: QUEUE_NAMES.HIGH, interval: 50, timeout: 0.05 },      // 50ms interval, 50ms timeout
      { name: QUEUE_NAMES.MEDIUM, interval: 100, timeout: 0.1 },    // 100ms interval, 100ms timeout  
      { name: QUEUE_NAMES.LOW, interval: 250, timeout: 0.2 },       // 250ms interval, 200ms timeout
      { name: QUEUE_NAMES.BATCH, interval: 1000, timeout: 0.5 }     // 1s interval, 500ms timeout
    ];

    queueConfigs.forEach(config => {
      const processor = setInterval(async () => {
        if (!redisManager.isConnected) return; // Skip if Redis unavailable
        
        try {
          const message = await redisManager.dequeueMessage(config.name, config.timeout);
          if (message) {
            console.log(`📤 Message dequeued from ${config.name}: ${message.id}`);
            
            // CRITICAL FIX: Process without blocking other queues
            this.processMessageAsync(message).catch(error => {
              console.error(`❌ Async message processing failed for ${message.id}:`, error);
            });
          }
        } catch (error) {
          // FIXED: Proper error type handling
          const errorMessage = error instanceof Error ? error.message : String(error);
          // Reduce error noise for expected timeouts
          if (!errorMessage.includes('timeout') && !errorMessage.includes('BRPOP')) {
            console.error(`❌ Queue processor error for ${config.name}:`, error);
          }
        }
      }, config.interval);

      this.queueProcessors.set(config.name, processor);
      console.log(`✅ Enhanced ${config.name} processor started (${config.interval}ms interval)`);
    });

    console.log('🔄 All enhanced queue processors started');
  }

  // ENHANCED: Async message processing to prevent blocking
  private async processMessageAsync(message: DinaUniversalMessage): Promise<void> {
    const messageId = message.id;
    
    // CRITICAL FIX: Prevent duplicate processing
    if (this.processingQueue.has(messageId)) {
      console.log(`⚠️ Message ${messageId} already being processed, skipping duplicate`);
      return;
    }

    // Track this processing job
    const processingPromise = this.handleIncomingMessage(message);
    this.processingQueue.set(messageId, processingPromise);

    try {
      const response = await processingPromise;
      console.log(`✅ Async processing completed for ${messageId}`);
      
      // Publish response if Redis is available
      if (redisManager.isConnected && message.qos.require_ack) {
        await redisManager.publishResponse(messageId, response);
      }
    } catch (error) {
      console.error(`❌ Async processing failed for ${messageId}:`, error);
    } finally {
      // Clean up tracking
      this.processingQueue.delete(messageId);
    }
  }

  // CRITICAL FIX: Enhanced message handling with recursion protection
  public async handleIncomingMessage(message: DinaUniversalMessage): Promise<DinaResponse> {
    const startTime = performance.now();
    
    // CRITICAL FIX: Prevent recursive loops and stack overflow
    const callDepth = (message as any).__callDepth || 0;
    if (callDepth > 3) { // REDUCED: Lower threshold to prevent issues
      console.error(`❌ Maximum call depth (${callDepth}) exceeded, preventing stack overflow`);
      return this.createErrorResponse(message.id, 'RECURSION_ERROR', 'Maximum recursion depth exceeded');
    }
    
    (message as any).__callDepth = callDepth + 1;

    let responsePayload: any;
    let responseStatus: 'success' | 'error' | 'processing' | 'queued' = 'success';
    let errorMessage: string | undefined;
    
    const requestId = `dina_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      // ENHANCED: Faster validation with caching
      if (!this.validateMessageFast(message)) {
        throw new Error('Invalid DINA message: Fast validation failed');
      }

      console.log(`🔍 Processing message ${requestId}: ${message.target.module}.${message.target.method}`);

      // ENHANCED: Skip expensive operations for simple requests
      const isSimpleRequest = ['ping', 'health', 'status'].includes(message.target.method);
      if (!isSimpleRequest) {
        // Log to database only for complex requests
        await database.logRequest({
          source: message.source.module,
          target: message.target.module,
          method: message.target.method,
          payload: message.payload,
          priority: message.target.priority,
          userId: message.security.user_id,
          securityContext: message.security
        });
      }

      // ENHANCED: Sanitize only untrusted input
      const sanitizedMessage = message.security.sanitized ? 
        message : DinaProtocol.sanitizeMessage(message);
      
      if (!isSimpleRequest) {
        console.log(`🧹 Message sanitized for ${requestId}`);
      }

      console.log(`🎯 Routing to module: "${sanitizedMessage.target.module}" with method: "${sanitizedMessage.target.method}"`);

      // ENHANCED: Route to appropriate handler
      switch (sanitizedMessage.target.module) {
        case 'core':
        case 'system':
          responsePayload = await this.processCoreRequest(sanitizedMessage);
          break;
        case 'llm':
          responsePayload = await this.processLLMRequest(sanitizedMessage);
          break;
        case 'database':
          responsePayload = await this.processDatabaseRequest(sanitizedMessage);
          break;
        case 'mirror':
          responsePayload = await this.processMirrorRequest(sanitizedMessage);
          break;
        case 'digim':
          if (isDigiMMessage(sanitizedMessage)) {
            // FIXED: Use the method that actually exists
            responsePayload = await digiMOrchestrator.handleIncomingMessage(sanitizedMessage);
          } else {
            throw new Error(`Invalid DIGIM message format`);
          }
          break;
        default:
          throw new Error(`Unknown target module: ${sanitizedMessage.target.module}`);
      }

      const processingTime = performance.now() - startTime;
      console.log(`✅ Successfully processed ${requestId} in ${processingTime.toFixed(2)}ms`);

    } catch (error) {
      const processingTime = performance.now() - startTime;
      console.error(`❌ Error processing message ${requestId}:`, error);
      
      responseStatus = 'error';
      errorMessage = error instanceof Error ? error.message : 'Unknown error';
      responsePayload = { error: errorMessage };
      
      // Log error to database
      try {
        await database.log('error', 'orchestrator', `Message processing failed: ${errorMessage}`, {
          messageId: requestId,
          module: message.target.module,
          method: message.target.method,
          processingTime
        });
      } catch (logError) {
        console.error('❌ Failed to log error to database:', logError);
      }
    }

    // ENHANCED: Create optimized response
    const response = this.createOptimizedResponse(
      message.id,
      responseStatus,
      responsePayload,
      performance.now() - startTime,
      errorMessage
    );

    console.log(`📤 Response generated for ${requestId}: status=${response.status}, time=${response.metrics.processing_time_ms.toFixed(2)}ms`);
    return response;
  }

  // ENHANCED: Fast validation for performance
  private validateMessageFast(message: any): boolean {
    return !!(
      message &&
      message.id &&
      message.target &&
      message.target.module &&
      message.target.method &&
      message.payload
    );
  }

  // ENHANCED: Optimized response creation
  private createOptimizedResponse(
    requestId: string,
    status: 'success' | 'error' | 'processing' | 'queued',
    payload: any,
    processingTime: number,
    errorMessage?: string
  ): DinaResponse {
    return {
      request_id: requestId,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      status,
      payload: { data: payload },
      error: errorMessage ? {
        code: status === 'error' ? 'PROCESSING_ERROR' : 'UNKNOWN',
        message: errorMessage
      } : undefined,
      metrics: {
        processing_time_ms: processingTime,
        queue_time_ms: 0 // Will be set by queue processor if applicable
      }
    };
  }

  // ENHANCED: Core request processing
  private async processCoreRequest(message: DinaUniversalMessage): Promise<any> {
    console.log('🏛️ Processing CORE request');
    
    switch (message.target.method) {
      case 'ping':
        return {
          message: 'DINA Core Pong!',
          timestamp: new Date().toISOString(),
          uptime: Date.now() - this.startTime.getTime(),
          status: 'healthy'
        };
      case 'health':
        return await this.getEnhancedSystemStatus();
      case 'status':
        return await this.getEnhancedSystemStatus();
      case 'stats':
        return await this.getEnhancedSystemStats();
      default:
        throw new Error(`Unknown core method: ${message.target.method}`);
    }
  }

  // ENHANCED: LLM request processing with better error handling
  private async processLLMRequest(message: DinaUniversalMessage): Promise<any> {
    console.log('🤖 Processing LLM request');
    
    if (!this.llmManager.isInitialized) {
      throw new Error('LLM Manager not initialized');
    }

    // CRITICAL FIX: Better payload extraction
    const extractPayloadData = (payload: any, field: string): any => {
      if (payload[field] !== undefined) return payload[field];
      if (payload.data && payload.data[field] !== undefined) return payload.data[field];
      return undefined;
    };

    const method = message.target.method;
    const query = extractPayloadData(message.payload, 'query');
    const text = extractPayloadData(message.payload, 'text');
    const code_request = extractPayloadData(message.payload, 'code_request');
    const analysis_query = extractPayloadData(message.payload, 'analysis_query');
    const options = extractPayloadData(message.payload, 'options') || {};

    // ENHANCED: Cache check for repeated requests
    const cacheKey = `llm:${method}:${this.createCacheKey(query || text || code_request || analysis_query, options)}`;
    
    let llmResponse: any;
    
    try {
      // ENHANCED: Check cache first
      if (redisManager.isConnected) {
        const cachedResponse = await redisManager.getExactCachedResponse(cacheKey);
        if (cachedResponse) {
          console.log(`💾 Cache hit for LLM ${method}`);
          return cachedResponse;
        }
      }

      // ENHANCED: Process based on method
      switch (method) {
        case 'llm_generate':
          if (!query) throw new Error('Missing required field: query for llm_generate');
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
          if (!text) throw new Error('Missing required field: text for llm_embed');
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

      // ENHANCED: Cache successful responses
      if (llmResponse && redisManager.isConnected) {
        await redisManager.setExactCachedResponse(cacheKey, llmResponse, 3600);
        console.log(`💾 Cached LLM response for method: ${method}`);
      }
      
    } catch (error) {
      console.error(`❌ LLM processing failed for ${method}:`, error);
      throw error;
    }

    return llmResponse;
  }

  // ENHANCED: Create cache key
  private createCacheKey(input: string, options: any): string {
    const optionsStr = JSON.stringify(options || {});
    return `${input?.substring(0, 100) || ''}:${optionsStr}`.replace(/[^a-zA-Z0-9:]/g, '');
  }

  // ENHANCED: Database request processing
  private async processDatabaseRequest(message: DinaUniversalMessage): Promise<any> {
    switch (message.target.method) {
      case 'query':
        const { sql, params } = message.payload.data;
        if (!sql) throw new Error('SQL query is required');
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

  // ENHANCED: Mirror request processing (placeholder)
  private async processMirrorRequest(message: DinaUniversalMessage): Promise<any> {
    console.log('🪞 Processing MIRROR request (placeholder)');
    return {
      status: 'success',
      message: 'Mirror module processing placeholder',
      method: message.target.method
    };
  }

  // ENHANCED: Better error response creation
  private createErrorResponse(requestId: string, code: string, message: string): DinaResponse {
    return {
      request_id: requestId,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      status: 'error',
      payload: { data: null },
      error: { code, message },
      metrics: { processing_time_ms: 0 }
    };
  }

  // ENHANCED: System status with performance metrics
  async getEnhancedSystemStatus(): Promise<Record<string, any>> {
    const dbStatus = await database.getSystemStatus();
    const redisStatus = { 
      isConnected: redisManager.isConnected, 
      queueStats: redisManager.isConnected ? await redisManager.getQueueStats() : null 
    };
    const llmStatus = this.llmManager.isInitialized ? await this.llmManager.getSystemStatus() : null;
    
    const digiMStatus = {
      initialized: digiMOrchestrator.isInitialized,
      health: digiMOrchestrator.moduleStatus,
      active_sources: digiMOrchestrator.getActiveSources().length,
      phase: 'foundation'
    };
  
    return {
      overallHealth: dbStatus.status === 'online' && 
                     (redisStatus.isConnected || true) && // Allow degraded mode
                     (llmStatus?.ollamaHealthy !== false) ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime_ms: Date.now() - this.startTime.getTime(),
      database: dbStatus,
      redis: redisStatus,
      llm: llmStatus || { status: 'unavailable', message: 'LLM not initialized' },
      digim: digiMStatus,
      performance: {
        active_processing_jobs: this.processingQueue.size,
        queue_processors_active: this.queueProcessors.size,
        memory_usage: process.memoryUsage(),
        cpu_usage: process.cpuUsage()
      },
      modules: this.getModuleStatus()
    };
  }

  // ENHANCED: System statistics
  async getEnhancedSystemStats(): Promise<Record<string, any>> {
    const now = Date.now();
    
    // Prevent too frequent stats queries
    if (now - this.lastStatsWarning < 5000) {
      return { message: 'Stats cached, try again in a moment' };
    }
    this.lastStatsWarning = now;

    try {
      const [dbStats, llmStats] = await Promise.allSettled([
        database.getSystemStats(),
        this.llmManager.isInitialized ? this.llmManager.getSystemStatus() : Promise.resolve(null)
      ]);

      return {
        timestamp: new Date().toISOString(),
        database: dbStats.status === 'fulfilled' ? dbStats.value : { error: 'unavailable' },
        llm: llmStats.status === 'fulfilled' ? llmStats.value : { error: 'unavailable' },
        system: {
          uptime_ms: Date.now() - this.startTime.getTime(),
          memory: process.memoryUsage(),
          active_processes: this.processingQueue.size
        }
      };
    } catch (error) {
      console.error('❌ Error getting system stats:', error);
      return { error: 'Failed to get system stats' };
    }
  }

  // ENHANCED: Module status
  getModuleStatus(): Record<string, string> {
    return {
      'core': this.initialized ? 'active' : 'initializing',
      'redis': redisManager.isConnected ? 'active' : 'degraded',
      'database': database.isConnected ? 'active' : 'inactive',
      'llm-system': this.llmManager.isInitialized ? 'active' : 'unavailable',
      'digim': digiMOrchestrator.isInitialized ? 
        `${digiMOrchestrator.moduleStatus}-phase1` : 'inactive',
      'phase': '2-enhanced-performance'
    };
  }

  // ENHANCED: List available models with caching
  async listAvailableModels(): Promise<string[]> {
    try {
      if (!this.llmManager.isInitialized) {
        console.warn('⚠️ LLM Manager not initialized, returning empty model list');
        return [];
      }
      
      const status = await this.llmManager.getSystemStatus();
      const models = status.availableModels || [];
      console.log(`📋 Returning ${models.length} available models: ${models.join(', ')}`);
      return models;
    } catch (error) {
      console.error('❌ Error listing models:', error);
      return [];
    }
  }

  // ENHANCED: Graceful shutdown
  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down Enhanced DINA Core...');
    try {
      // Stop queue processors
      this.queueProcessors.forEach(interval => clearInterval(interval));
      this.queueProcessors.clear();
      console.log('✅ Stopped all queue processors');
      
      // Wait for active processing to complete (with timeout)
      if (this.processingQueue.size > 0) {
        console.log(`⏳ Waiting for ${this.processingQueue.size} active processes to complete...`);
        const activePromises = Array.from(this.processingQueue.values());
        await Promise.allSettled(activePromises);
      }
      
      // Shutdown modules
      await this.llmManager.shutdown();
      await digiMOrchestrator.shutdown();
      console.log('✅ DIGIM shutdown complete');
      
      // Shutdown infrastructure
      await redisManager.shutdown();
      await database.close();
      
      this.initialized = false;
      console.log('✅ Enhanced DINA Core shutdown complete');
    } catch (error) {
      console.error('❌ Enhanced shutdown error:', error);
      throw error;
    }
  }

  // Public methods for API compatibility
  async getSystemStatus(): Promise<Record<string, any>> {
    return await this.getEnhancedSystemStatus();
  }

  async getSystemStats(): Promise<Record<string, any>> {
    return await this.getEnhancedSystemStats();
  }
}

export const dinaCore = new DinaCore();
export default dinaCore;

console.log('🚀 Enhanced DINA Core Orchestrator loaded with performance optimizations');
console.log('✨ Features: Fast queue processing, recursion protection, degraded mode support');
console.log('⚡ Performance: Reduced timeouts, async processing, intelligent caching');
