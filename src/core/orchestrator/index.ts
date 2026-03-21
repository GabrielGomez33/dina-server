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
import { mirrorModule } from '../../modules/mirror';
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

// ============================================================================
// CONTEXT NORMALIZATION
// ============================================================================
//
// The mirror-server sends context in a FLAT format:
//   { groupName, groupGoal, members: string[], recentMessages, requestingUser }
//
// The dina-server processors expect a NESTED format:
//   { groupInfo: { name, goal }, members: [{ username }], recentMessages }
//
// normalizeContext() converts either format into the canonical nested form
// so that all downstream code (orchestrator, chatProcessor,
// streamingChatProcessor) works correctly regardless of which format arrives.
// ============================================================================

interface NormalizedContext {
  groupInfo: {
    name: string;
    description?: string;
    goal?: string;
  };
  members: Array<{ username: string; role?: string }>;
  recentMessages: Array<{ username: string; content: string; createdAt?: string; timestamp?: string }>;
  requestingUser?: string;
  originalContext?: any;
}

/**
 * Normalize mirror chat context into a canonical nested structure.
 *
 * Handles three known input shapes:
 * 1. Flat format from mirror-server (both WS & HTTP paths):
 *    { groupName, groupGoal, members: ["alice", "bob"], recentMessages, requestingUser }
 * 2. Nested format from DinaChatContext (buildDinaChatContext utility):
 *    { groupInfo: { name, goal }, members: [{ username }], recentMessages }
 * 3. Empty / partial context
 *
 * Edge cases handled:
 * - null / undefined context
 * - members as string[] vs object[]
 * - Missing fields default gracefully
 * - Timestamp field normalization (createdAt vs timestamp)
 */
function normalizeContext(raw: any): NormalizedContext {
  if (!raw || typeof raw !== 'object') {
    return {
      groupInfo: { name: 'Mirror Group', goal: 'General discussion' },
      members: [],
      recentMessages: [],
    };
  }

  // ---- Group Info ----
  // Priority: nested groupInfo > flat groupName/groupGoal > defaults
  let groupName: string;
  let groupGoal: string | undefined;
  let groupDescription: string | undefined;

  if (raw.groupInfo && typeof raw.groupInfo === 'object') {
    // Nested format
    groupName = raw.groupInfo.name || 'Mirror Group';
    groupGoal = raw.groupInfo.goal || undefined;
    groupDescription = raw.groupInfo.description || undefined;
  } else {
    // Flat format from mirror-server
    groupName = raw.groupName || 'Mirror Group';
    groupGoal = raw.groupGoal || undefined;
    groupDescription = raw.groupDescription || undefined;
  }

  // ---- Members ----
  // mirror-server sends members as string[] ("GabrielGomez33", "Gabriel2")
  // DinaChatContext sends members as { username, role }[]
  let members: Array<{ username: string; role?: string }> = [];
  if (Array.isArray(raw.members)) {
    members = raw.members
      .filter((m: any) => m != null)
      .map((m: any) => {
        if (typeof m === 'string') {
          return { username: m };
        }
        if (typeof m === 'object' && m.username) {
          return { username: m.username, role: m.role };
        }
        return null;
      })
      .filter(Boolean) as Array<{ username: string; role?: string }>;
  }

  // ---- Recent Messages ----
  let recentMessages: Array<{ username: string; content: string; createdAt?: string; timestamp?: string }> = [];
  if (Array.isArray(raw.recentMessages)) {
    recentMessages = raw.recentMessages
      .filter((m: any) => m && m.username && m.content)
      .map((m: any) => ({
        username: m.username,
        content: m.content,
        createdAt: m.createdAt || m.created_at || m.timestamp || undefined,
        timestamp: m.timestamp || m.createdAt || m.created_at || undefined,
      }));
  }

  // ---- Requesting User ----
  const requestingUser = raw.requestingUser || undefined;

  return {
    groupInfo: {
      name: groupName,
      description: groupDescription,
      goal: groupGoal,
    },
    members,
    recentMessages,
    requestingUser,
    originalContext: raw.originalContext,
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

      try {
        // ── Phase 1: Database ──────────────────────────────────────
        console.log('📦 Phase 1/4 — Database & Auth');
        await database.initialize();

        // ── Phase 2: LLM System ────────────────────────────────────
        console.log('🤖 Phase 2/4 — Multi-Model LLM System');
        await this.llmManager.initialize();
        console.log('   ✅ LLM System ready');

        // ── Phase 3: DIGIM Intelligence ────────────────────────────
        console.log('🧠 Phase 3/4 — DIGIM Intelligence Module');
        await digiMOrchestrator.initialize();
        const digiMStatus = digiMOrchestrator.moduleStatus;
        console.log(`   ${digiMStatus === 'healthy' ? '✅' : '⚠️'} DIGIM ${digiMStatus} — ${digiMOrchestrator.getActiveSources().length} sources`);

        // ── Phase 4: Mirror Module ─────────────────────────────────
        console.log('🪞 Phase 4/4 — Mirror Module');
        await mirrorModule.initialize();
        const mirrorStatus = mirrorModule.isInitialized;
        console.log(`   ${mirrorStatus ? '✅' : '⚠️'} Mirror ${mirrorStatus ? 'ready' : 'degraded'}`);

        // ── Queue Processors ───────────────────────────────────────
        this.initialized = true;
        this.startQueueProcessors();

        console.log('');
        console.log('✅ DINA Core initialization complete');

        await database.log('info', 'core', 'DINA Core initialized successfully', {
          digim_status: digiMStatus,
          digim_sources: digiMOrchestrator.getActiveSources().length,
          mirror_status: mirrorStatus ? 'ready' : 'degraded'
        });

      } catch (error) {
        console.error('❌ Failed to initialize DINA Core:', error);
        this.initialized = false;
        await database.log('critical', 'core', 'DINA Core initialization failed', { error: (error as Error).message });
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
    const processor = setInterval(async () => {
      if (!this.initialized) {
        return;
      }

      if (!redisManager.isConnected) {
        const now = Date.now();
        if (!this.lastRedisWarning || (now - this.lastRedisWarning) > 60000) {
          console.warn(`⚠️ Skipping queue processing for ${queueName} - Redis disconnected`);
          this.lastRedisWarning = now;
        }
        return;
      }
	  let message;
	  try{
      	   message = await redisManager.retrieveMessage(queueName);
		 } catch (err) {
		 	console.error(`❌ Redis retrieve failed for ${queueName}`, err);
		 	return;
		 }
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
    }, 1000);

    this.queueProcessors.set(queueName, processor);
  }
}

  private isMirrorMessage(message: DinaUniversalMessage): boolean {
    const validMirrorMethods = [
      'mirror_submit_profile',
      'mirror_get_insights',
      'mirror_get_patterns',
      'mirror_answer_question',
      'mirror_chat',
      'mirror_chat_stream',
      'mirror_synthesize_insights',
      'deep_facial_analysis',
      'detect_patterns',
      'temporal_analysis',
      'mirror_feedback'
    ];
    return validMirrorMethods.includes(message.target.method);
  }

  public async handleIncomingMessage(message: DinaUniversalMessage): Promise<DinaResponse> {
      const startTime = performance.now();
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
		console.log(`core/orchestrator/index.ts -> handleIncomingMessage() Content of message prior to sanitation -> ${JSON.stringify(message)}`);
        const sanitizedMessage = DinaProtocol.sanitizeMessage(message);
        console.log(`🧹 Message sanitized successfully for ${requestId}`);

        if (!sanitizedMessage.target || typeof sanitizedMessage.target.module !== 'string') {
          throw new Error(
            `Invalid target module format. Expected string, got: ${typeof sanitizedMessage.target?.module}`
          );
        }

        const targetModule = sanitizedMessage.target.module;
        console.log(`🎯 Routing to module: "${targetModule}" with method: "${sanitizedMessage.target.method}"`);

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

          case 'mirror':
          	 console.log('🪞 Processing MIRROR request');
         	 responsePayload = await this.processMirrorRequest(sanitizedMessage);
        	 break;

          default:
            const availableModules = ['core', 'llm', 'database', 'system', 'digim', 'mirror'];
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
      id: uuidv4(),
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

  const extractPayloadData = (payload: any, field: string): any => {
    if (payload[field] !== undefined) {
      console.log(`✅ Found ${field} at direct level`);
      return payload[field];
    }

    if (payload.data && payload.data[field] !== undefined) {
      console.log(`✅ Found ${field} at data level`);
      return payload.data[field];
    }

    if (payload.data && payload.data.data && payload.data.data[field] !== undefined) {
      console.log(`✅ Found ${field} at data.data level`);
      return payload.data.data[field];
    }

    return undefined;
  };

  const query = extractPayloadData(message.payload, 'query');
  const text = extractPayloadData(message.payload, 'text');
  const code_request = extractPayloadData(message.payload, 'code_request');
  const analysis_query = extractPayloadData(message.payload, 'analysis_query');
  const options = extractPayloadData(message.payload, 'options') || {};

  console.log(`🔍 Extracted data: query=${!!query}, text=${!!text}, code_request=${!!code_request}, analysis_query=${!!analysis_query}`);

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

  private async processMirrorRequest(message: DinaUniversalMessage): Promise<any> {
      console.log(`🪞 Processing Mirror method: ${message.target.method}`);
      const sessionInfo = {
         userId: message.security.user_id || 'anonymous',
         sessionId: message.security.session_id || 'default'
      };

      switch (message.target.method) {
        case 'process_submission':
          return await mirrorModule.processSubmission(message, sessionInfo);

        case 'mirror_synthesize_insights':
          console.log('🧪 Processing Mirror Insight Synthesis');
          return await mirrorModule.synthesizeInsights(message, sessionInfo);

        case 'mirror_chat':
          // Process @Dina chat message (non-streaming)
          console.log('💬 Processing Mirror Chat query');
          return await this.processMirrorChat(message, sessionInfo, false);

        case 'mirror_chat_stream':
          // Process @Dina chat message with streaming
          console.log('📡 Processing Mirror Chat query with streaming');
          return await this.processMirrorChat(message, sessionInfo, true);

        case 'get_status':
          return await mirrorModule.healthCheck();

        case 'get_metrics':
          return await mirrorModule.getPerformanceMetrics();

        // ================================================================
        // TRUTHSTREAM: LLM-powered review classification
        // ================================================================
        case 'mirror_ts_classify_review':
          console.log('🔮 Processing TruthStream Review Classification');
          return await mirrorModule.handleTruthStreamClassifyReview(message, sessionInfo);

        // ================================================================
        // TRUTHSTREAM: Full analysis generation (Truth Mirror Report, etc.)
        // ================================================================
        case 'mirror_ts_generate_analysis':
          console.log('🔮 Processing TruthStream Analysis Generation');
          return await mirrorModule.handleTruthStreamGenerateAnalysis(message, sessionInfo);

        // ================================================================
        // TRUTHSTREAM: Truth card data validation
        // ================================================================
        case 'mirror_ts_validate_truth_card':
          console.log('🔮 Processing TruthStream Truth Card Validation');
          return await mirrorModule.handleTruthStreamValidateTruthCard(message, sessionInfo);

        // ================================================================
        // TRUTHSTREAM: Review quality scoring
        // ================================================================
        case 'mirror_ts_score_review_quality':
          console.log('🔮 Processing TruthStream Review Quality Scoring');
          return await mirrorModule.handleTruthStreamScoreReviewQuality(message, sessionInfo);

        // ================================================================
        // TRUTHSTREAM: Hostility pattern assessment
        // ================================================================
        case 'mirror_ts_assess_hostility':
          console.log('🔮 Processing TruthStream Hostility Assessment');
          return await mirrorModule.handleTruthStreamAssessHostility(message, sessionInfo);

        // ================================================================
        // TRUTHSTREAM: Health check
        // ================================================================
        case 'mirror_ts_health':
          console.log('🔮 Processing TruthStream Health Check');
          return await mirrorModule.handleTruthStreamHealth();

        case 'get_insights':
        case 'get_patterns':
        case 'get_questions':
        case 'immediate_insights':
        case 'cross_modal_insight':
        case 'mirror_get_insights':
        case 'mirror_analyze':
        case 'mirror_get_context':
        case 'mirror_get_notifications':
        case 'mirror_mark_notification_read':
        case 'mirror_update_preferences':
        case 'mirror_get_history':
        case 'mirror_export_data':
        case 'mirror_get_analytics':
          return await mirrorModule.processSubmission(message, sessionInfo);

        default:
          throw new Error(`Unknown mirror method: ${message.target.method}`);
      }
    }

  private async processMirrorChat(
    message: DinaUniversalMessage,
    sessionInfo: { userId: string; sessionId: string },
    streaming: boolean
  ): Promise<any> {
    const startTime = performance.now();

    console.log(`[SRC/CORE/ORCHESTRATOR/index.ts -> processMirrorChat()] Contents of message -> ${JSON.stringify(message)}`);
    // Extract chat data from payload
    const payload = message.payload?.data || message.payload;
    const query = payload?.query || payload?.message || payload?.content;
    const groupId = payload?.groupId || payload?.group_id;
    const username = payload?.username || sessionInfo.userId;
    const context = payload?.context || {};
	//WHERE WE LEFT OFF 1/28/26 8:47PM Adding request Identifier to fix mismatch in mirror server causing request to not be found
	//Wrong id returned.
    const requestIdentifier = payload.requestId;
    console.log(`[SRC/CORE/ORCHESTRATOR/index.ts -> processMirrorChat()] contents of requestIdentifier -> ${requestIdentifier}`);

    if (!query) {
      throw new Error('Missing required field: query for mirror_chat');
    }

    console.log(`💬 Mirror Chat: Processing query from ${username} in group ${groupId}`);

    // FIX: Normalize context to handle both flat (mirror-server) and nested formats.
    // Before this fix, context.groupInfo.name was always undefined because the
    // mirror-server sends context.groupName (flat), causing fallback to defaults.
    const normalizedCtx = normalizeContext(context);
    console.log(`[SRC/CORE/ORCHESTRATOR/index.ts -> processMirrorChat()] Normalized context -> group="${normalizedCtx.groupInfo.name}", goal="${normalizedCtx.groupInfo.goal}", messages=${normalizedCtx.recentMessages.length}, members=${normalizedCtx.members.length}`);

    // Build system prompt with normalized context
    const systemPrompt = this.buildMirrorChatSystemPrompt(normalizedCtx, username);

    try {
      // Generate response using LLM
      const llmResponse = await this.llmManager.generate(query, {
        user_id: sessionInfo.userId,
        conversation_id: groupId,
        requestId: requestIdentifier,
        streaming: streaming,
        max_tokens: 1000,
        temperature: 0.7,
        system_prompt: systemPrompt
      });

      const processingTime = performance.now() - startTime;

      return {
        success: true,
        content: llmResponse.response,
        metadata: {
          processingTimeMs: processingTime,
          streaming: streaming,
          model: llmResponse.model || 'default',
          groupId: groupId,
          sourceRequestId: llmResponse.sourceRequestId,
          respondingTo: username
        }
      };
    } catch (error) {
      console.error('❌ Mirror Chat processing failed:', error);
      throw error;
    }
  }

  /**
   * Build the system prompt for @Dina chat responses.
   *
   * FIX: This method now receives a NormalizedContext (always nested format)
   *      from processMirrorChat(). Previously it read context.groupInfo.name
   *      directly from the raw payload, which used flat fields (groupName),
   *      causing fallback to "Mirror Group" / "General discussion".
   *
   * The system prompt is now structured with explicit sections that help
   * the model understand it has full conversation history access and should
   * use it when responding to contextual questions.
   */
  private buildMirrorChatSystemPrompt(ctx: NormalizedContext, username: string): string {
    const groupName = ctx.groupInfo.name;
    const groupGoal = ctx.groupInfo.goal || 'General discussion';
    const recentMessages = ctx.recentMessages || [];

    // Build conversation history with timestamps for better temporal awareness
    const recentMessagesText = recentMessages
      .slice(-15) // Include up to 15 recent messages for richer context
      .map((m: any) => {
        const timestamp = m.timestamp || m.createdAt;
        const timeStr = timestamp ? ` [${new Date(timestamp).toLocaleString()}]` : '';
        return `${m.username}${timeStr}: ${(m.content || '').substring(0, 300)}`;
      })
      .join('\n') || 'No recent messages available.';

    // Build members list
    const membersText = ctx.members.length > 0
      ? ctx.members.map(m => m.username).join(', ')
      : 'Unknown';

    return `You are Dina, an intelligent and empathetic AI assistant integrated into Mirror, a group chat application focused on personal growth, mental wellness, and meaningful connections.

IMPORTANT: You have FULL ACCESS to the conversation history shown below. When users ask about previous messages, topics discussed, or conversation patterns, you MUST reference and analyze this history directly. Do NOT say you cannot access conversation history — it is provided to you right here.

GROUP CONTEXT:
- Group Name: "${groupName}"
- Group Goal: ${groupGoal}
- Members: ${membersText}
- User asking: ${username}

CONVERSATION HISTORY (most recent messages in this group):
${recentMessagesText}

GUIDELINES:
- Reference the conversation history above when answering questions about what was discussed
- Be helpful, concise, and empathetic
- Stay relevant to the group context and ongoing conversation
- Provide actionable insights when appropriate
- Keep responses under 500 words unless more detail is necessary
- Use a warm but professional tone
- Address users by name when relevant
- If asked about conversation topics or patterns, analyze the history above
- Never claim you cannot see or access the conversation — you can see it above
- Respect privacy and maintain a supportive atmosphere`;
  }

  async getEnhancedSystemStatus(): Promise<Record<string, any>> {
      const dbStatus = await database.getSystemStatus();
      const redisStatus = { isConnected: redisManager.isConnected, queueStats: await redisManager.getQueueStats() };
      const llmStatus = await this.llmManager.getSystemStatus();

      const digiMStatus = {
        initialized: digiMOrchestrator.isInitialized,
        health: digiMOrchestrator.moduleStatus,
        active_sources: digiMOrchestrator.getActiveSources().length,
        phase: 'foundation'
      };

      const mirrorStatus = {
        initialized: mirrorModule.isInitialized,
        health: mirrorModule.isInitialized ? 'healthy' : 'critical',
        components: {
          dataProcessor: 'ready',
          contextManager: 'ready',
           storageManager: 'ready',
          insightGenerator: 'ready',
          notificationSystem: 'ready'
        },
        version: '2.0.0',
        phase: 'integration-complete'
      };

      return {
        overallHealth: dbStatus.status === 'online' &&
                        redisStatus.isConnected &&
                        llmStatus.ollamaHealthy &&
                        digiMOrchestrator.moduleStatus === 'healthy' &&
                       mirrorModule.isInitialized ?
          'healthy' : 'degraded',
        database: dbStatus,
        redis: redisStatus,
        llm_system: llmStatus,
        digim: digiMStatus,
        mirror: mirrorStatus,
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
      'mirror-module': mirrorModule.isInitialized ? 'active' : 'inactive',
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

      await digiMOrchestrator.shutdown();
      console.log('✅ DIGIM shutdown complete');

	  await mirrorModule.shutdown();
	  console.log('✅ Mirror shutdown complete');

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
