// API Routes Setup with Base Path Support (Enhanced with Unified Auth + Mirror Module) - COMPLETE
// File: src/api/routes/index.ts

import express, { Request, Response, NextFunction } from 'express';
import { DinaCore } from '../../core/orchestrator';
import { authenticate, rateLimit, sanitizeInput, handleError, requireTrustLevel, corsMiddleware, AuthenticatedRequest } from '../middleware/security';
import { DinaUniversalMessage, createDinaMessage, MessagePriority, SecurityLevel } from '../../core/protocol';
import { v4 as uuidv4 } from 'uuid';
import { database } from '../../config/database/db';
import { digiMOrchestrator } from '../../modules/digim';
import { isDigiMMethod } from '../../modules/digim/types';

// FIXED: Add helper function to map trust levels to security clearances
function mapTrustLevelToSecurityLevel(trustLevel: string): SecurityLevel {
  switch (trustLevel) {
    case 'new':
      return SecurityLevel.PUBLIC;
    case 'trusted':
      return SecurityLevel.RESTRICTED;
    case 'suspicious':
      return SecurityLevel.PUBLIC;
    case 'blocked':
      return SecurityLevel.PUBLIC;
    default:
      return SecurityLevel.PUBLIC;
  }
}

// FIXED: Simple trust level access helper
function getTrustLevelAccess(trustLevel: string, accessMap: Record<string, string[]>): string[] {
  return accessMap[trustLevel] || accessMap['new'] || [];
}

// In-memory rate limit for synthesis endpoint (userId -> last request timestamp)
const synthesisRateLimit = new Map<string, number>();
// Periodic cleanup to prevent unbounded growth (every 5 minutes, evict entries older than 60s)
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [key, ts] of synthesisRateLimit) {
    if (ts < cutoff) synthesisRateLimit.delete(key);
  }
}, 300000).unref();

export function setupAPI(app: express.Application, dina: DinaCore, basePath: string = ''): void {
  const apiPath = `${basePath}/api/v1`;
  
  // API-specific middleware
  const apiRouter = express.Router();

  // FIXED: Enhanced timeout handling to prevent headers already sent error
  apiRouter.use((req: Request, res: Response, next) => {
    // ENHANCED: Track if response has been sent
    let timeoutHandled = false;
    
    const timeout = setTimeout(() => {
      if (!res.headersSent && !timeoutHandled) {
        timeoutHandled = true;
        console.error(`⏰ Request timeout: ${req.method} ${req.path}`);
        res.status(408).json({ 
          error: 'Request timeout',
          message: 'The request took too long to process',
          timeout_ms: 60000
        });
      }
    }, 60000);

    // Clear timeout when response finishes
    res.on('finish', () => {
      clearTimeout(timeout);
    });
    
    res.on('close', () => {
      clearTimeout(timeout);
    });

    next();
  });
  
  // ================================
  // CORS AND MIDDLEWARE SETUP
  // ================================
  
  // Apply CORS first for browser testing
  apiRouter.use(corsMiddleware);
  
  // Apply common middleware to all API routes
  apiRouter.use(express.json({ limit: '10mb' })); // Increased for Mirror submissions
  apiRouter.use(express.urlencoded({ extended: true, limit: '10mb' }));
  apiRouter.use((req: Request, res: Response, next) => {
    console.log(`📡 API Request: ${req.method} ${req.originalUrl}`);
    next();
  });

  // ================================
  // UNIFIED AUTHENTICATION
  // ================================
  // Apply unified authentication to ALL routes except health
  apiRouter.use('/health', (req, res, next) => next()); // Skip auth for health
  apiRouter.use(authenticate); // Apply to all other routes
  apiRouter.use(rateLimit); // Legacy compatibility
  apiRouter.use(sanitizeInput); // Legacy compatibility
  
  // ================================
  // PUBLIC ENDPOINTS
  // ================================
  
  // Health check endpoint (no auth required)
  apiRouter.get('/health', (req: Request, res: Response) => {
    res.json({ 
      status: 'healthy', 
      service: 'DINA API with Unified Auth + Mirror Module',
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      path: apiPath,
      features: ['unified-auth', 'progressive-trust', 'auto-registration', 'mirror-analysis', 'llm-processing', 'digim-gathering']
    });
  });
  
  // System status endpoint (new users allowed)
  apiRouter.get('/status', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const status = await dina.getSystemStatus();
      res.json({
        status: 'operational',
        timestamp: new Date().toISOString(),
        modules: status,
        auth_info: {
          user_key: req.dina?.user_key,
          trust_level: req.dina?.trust_level,
          is_new_user: req.dina?.is_new_user
        },
        endpoints: {
          health: `${apiPath}/health`,
          status: `${apiPath}/status`,
          stats: `${apiPath}/stats`,
          dina: `${apiPath}/dina`,
          mirror: `${apiPath}/mirror`,
          llm: `${apiPath}/models`,
          digim: `${apiPath}/digim`
        }
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to get system status',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // System statistics endpoint (new users allowed)
  apiRouter.get('/stats', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const stats = await dina.getSystemStats();
      res.json({
        timestamp: new Date().toISOString(),
        statistics: stats,
        auth_info: {
          trust_level: req.dina?.trust_level,
          rate_limit_remaining: req.dina?.rate_limit_remaining
        }
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to get system statistics',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Module-specific endpoints (new users allowed)
  apiRouter.get('/modules', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const modules = dina.getModuleStatus();
      res.json({
        available_modules: modules,
        active_count: Object.values(modules).filter(status => status === 'active').length,
        total_count: Object.keys(modules).length,
        auth_info: {
          trust_level: req.dina?.trust_level
        }
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to get module status',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ================================
  // LLM-SPECIFIC API ENDPOINTS
  // ================================

  // List available models (all authenticated users)
  apiRouter.get('/models', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const models = await dina.listAvailableModels();

      // Filter models based on trust level
     const modelAccess = {
        'new': ['mxbai-embed-large', 'mistral:7b', 'codellama:34b', 'llama2:70b'],
        'trusted': ['mxbai-embed-large', 'mistral:7b', 'codellama:34b', 'llama2:70b'],
        'suspicious': ['mxbai-embed-large', 'mistral:7b'],
        'blocked': ['mxbai-embed-large']
      };

      const allowedModels = getTrustLevelAccess(req.dina!.trust_level, modelAccess);
      const filteredModels = models.filter(model => allowedModels.includes(model));

      res.json({
        available_models: filteredModels,
        all_models: models,
        auth_info: {
          trust_level: req.dina?.trust_level,
          allowed_models: allowedModels,
          upgrade_message: req.dina?.trust_level === 'new' ? 
            'Use the system responsibly to gain access to more models' : null
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Error listing models:', error);
      res.status(500).json({
        error: 'Failed to list models',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Chat completions endpoint (trust level restrictions apply)
  apiRouter.post('/models/:modelId/chat', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { modelId } = req.params;
      const { query, options } = req.body;
      const userId = req.dina!.dina_key;

      // Validation
      if (!query) {
        res.status(400).json({ 
          error: 'Bad Request', 
          message: 'Query is required',
          auth_info: { trust_level: req.dina?.trust_level }
        });
        return;
      }

      // Check token limits
      if (query.length > Math.max(req.dina!.token_limit_remaining, 50000)) {
        res.status(413).json({ 
          error: 'Token limit exceeded', 
          limit: req.dina!.token_limit_remaining,
          trust_level: req.dina!.trust_level,
          message: 'Upgrade your trust level by using the system responsibly',
          query_length: query.length
        });
        return;
      }

      // Check model access
      const modelAccess = {
        'new': ['mxbai-embed-large', 'mistral:7b', 'codellama:34b', 'llama2:70b'],
        'trusted': ['mxbai-embed-large', 'mistral:7b', 'codellama:34b', 'llama2:70b'],
        'suspicious': ['mxbai-embed-large', 'mistral:7b'],
        'blocked': ['mxbai-embed-large']
      };

      const allowedModels = getTrustLevelAccess(req.dina!.trust_level, modelAccess);

      if (!allowedModels.includes(modelId)) {
        res.status(403).json({
          error: 'Model access denied',
          message: `Access to model '${modelId}' requires higher trust level`,
          allowed_models: allowedModels,
          current_trust_level: req.dina!.trust_level,
          upgrade_message: 'Use the system responsibly to gain access to more models'
        });
        return;
      }

      // FIXED: Create a DUMP message for LLM chat generation with proper security clearance mapping
      const dinaMessage: DinaUniversalMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'llm', method: 'llm_generate', priority: 7 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
          sanitized: true 
        },
        payload: {  // ← This gets wrapped in { data: ... } by createDinaMessage
          query: query,
          options: {
            ...options,
            model_preference: modelId,
            user_id: userId,
            conversation_id: options?.conversation_id
          }
        }
      });

      console.log(`💬 Chat request: ${modelId} from ${req.dina!.trust_level} user (${req.dina!.rate_limit_remaining} requests remaining)`);
      const llmResponse = await dina.handleIncomingMessage(dinaMessage); 

      res.json({
        ...llmResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level,
          rate_limit_remaining: req.dina?.rate_limit_remaining,
          token_limit_remaining: req.dina?.token_limit_remaining
        }
      });

    } catch (error) {
      console.error('❌ Error in LLM chat completion:', error);
      res.status(500).json({
        error: 'LLM Chat Error',
        message: error instanceof Error ? error.message : 'Unknown error',
        auth_info: {
          trust_level: req.dina?.trust_level
        }
      });
    }
  });

  // Embeddings endpoint (all authenticated users, model restrictions apply)
  apiRouter.post('/models/:modelId/embed', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { modelId } = req.params;
      const { text, options } = req.body;
      const userId = req.dina!.dina_key;

      // Validation
      if (!text) {
        res.status(400).json({ 
          error: 'Bad Request', 
          message: 'Text is required',
          auth_info: { trust_level: req.dina?.trust_level }
        });
        return;
      }

      // Check token limits
      if (text.length > Math.max(req.dina!.token_limit_remaining, 50000)) {
        res.status(413).json({ 
          error: 'Token limit exceeded', 
          limit: req.dina!.token_limit_remaining,
          trust_level: req.dina!.trust_level,
          message: 'Upgrade your trust level for higher limits',
          text_length: text.length
        });
        return;
      }

      // Check model access
      const modelAccess = {
        'new': ['mxbai-embed-large', 'mistral:7b', 'codellama:34b', 'llama2:70b'],
        'trusted': ['mxbai-embed-large', 'mistral:7b', 'codellama:34b', 'llama2:70b'],
        'suspicious': ['mxbai-embed-large', 'mistral:7b'],
        'blocked': ['mxbai-embed-large']
      };

      const allowedModels = getTrustLevelAccess(req.dina!.trust_level, modelAccess);

      if (!allowedModels.includes(modelId)) {
        res.status(403).json({
          error: 'Model access denied',
          message: `Access to model '${modelId}' requires higher trust level`,
          allowed_models: allowedModels,
          current_trust_level: req.dina!.trust_level
        });
        return;
      }

      // FIXED: Create a DUMP message for LLM embeddings with proper security clearance mapping
      const dinaMessage: DinaUniversalMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'llm', method: 'llm_embed', priority: 6 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level), // FIXED: Use mapping function
          sanitized: true 
        },
        payload: {
          text: text,
          options: {
            ...options,
            model_preference: modelId,
          }
        }
      });

      console.log(`🔢 Embeddings request: ${modelId} from ${req.dina!.trust_level} user`);
      const embeddingResponse = await dina.handleIncomingMessage(dinaMessage);

      // ENHANCED: Better response handling with proper embedding format
      if (embeddingResponse.status === 'success' && embeddingResponse.payload?.data) {
        const responseData = embeddingResponse.payload.data;
        
        // FIXED: Extract actual embedding dimensions
        let dimensions = 0;
        if (responseData.response && Array.isArray(responseData.response) && responseData.response.length > 0) {
          if (Array.isArray(responseData.response[0])) {
            dimensions = responseData.response[0].length;
          }
        }

        // ENHANCED: Structured response format
        const structuredResponse = {
          id: responseData.id,
          model: responseData.model || modelId,
          embeddings: responseData.response, // Keep original embeddings array
          dimensions: dimensions, // FIXED: Actual dimension count
          tokens: responseData.tokens || { input: 0, output: 0, total: 0 },
          performance: responseData.performance || {},
          confidence: responseData.confidence || 0.9,
          metadata: {
            ...responseData.metadata,
            actual_dimensions: dimensions, // Double confirmation
            embedding_format: 'array_of_arrays',
            processing_successful: true
          },
          auth_info: {
            trust_level: req.dina?.trust_level,
            rate_limit_remaining: req.dina?.rate_limit_remaining
          }
        };
        
        console.log(`✅ Embedding dimensions: ${dimensions}, model: ${modelId}`);
        res.json(structuredResponse);
        return;
        
      } else {
        // Handle error responses
        console.error('❌ LLM embedding failed:', embeddingResponse);
        res.status(500).json({
          error: 'Embedding generation failed',
          message: embeddingResponse.payload?.data?.message || 'Unknown error',
          auth_info: {
            trust_level: req.dina?.trust_level
          }
        });
        return;
      }

    } catch (error) {
      console.error('❌ Error in LLM embeddings generation:', error);

      // ENHANCED: Ensure response hasn't been sent before responding
      if (!res.headersSent) {
        res.status(500).json({
          error: 'LLM Embeddings Error',
          message: error instanceof Error ? error.message : 'Unknown error',
          auth_info: {
            trust_level: req.dina?.trust_level
          }
        });
      }
    }
  });

  // ================================
  // MIRROR MODULE API ENDPOINTS
  // ================================
  
  console.log('🪞 Setting up Mirror Module API routes...');

  // Mirror Module Status (all authenticated users)
  apiRouter.get('/mirror/status', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const mirrorMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'mirror', method: 'get_status', priority: 7 },
        security: { 
          user_id: req.dina!.dina_key, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
          sanitized: true 
        },
        payload: { 
          detailed: true, 
          include_performance: true,
          include_user_context: req.dina!.trust_level === 'trusted'
        }
      });

      console.log(`🪞 Mirror status request from ${req.dina!.trust_level} user`);
      const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);

      res.json({
        ...mirrorResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level,
          rate_limit_remaining: req.dina?.rate_limit_remaining
        }
      });

    } catch (error) {
      console.error('❌ Error getting Mirror status:', error);
      res.status(500).json({
        error: 'Failed to get Mirror status',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Submit Mirror Data for Analysis (all authenticated users)
  apiRouter.post('/mirror/submit', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const submissionData = req.body;
      const userId = req.dina!.dina_key;

      // Validation
      if (!submissionData) {
        res.status(400).json({ 
          error: 'Bad Request', 
          message: 'Missing submission data',
          auth_info: { trust_level: req.dina?.trust_level }
        });
        return;
      }

      // Check payload size limits based on trust level
      const payloadSize = JSON.stringify(submissionData).length;
      const sizeLimit = req.dina!.trust_level === 'trusted' ? 50 * 1024 * 1024 : 25 * 1024 * 1024; // 50MB vs 25MB vs 1MB

      if (payloadSize > sizeLimit) {
        res.status(413).json({ 
          error: 'Payload too large', 
          limit: sizeLimit,
          current_size: payloadSize,
          trust_level: req.dina!.trust_level,
          message: 'Upgrade your trust level to submit larger analyses'
        });
        return;
      }

      const mirrorMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'mirror', method: 'process_submission', priority: 8 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
          sanitized: true 
        },
        payload: {
          ...submissionData,
          requestId: uuidv4(),
          submitTimestamp: new Date().toISOString(),
          trustLevel: req.dina!.trust_level
        }
      });

      console.log(`🪞 Mirror submission from ${req.dina!.trust_level} user: ${userId}`);
      const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);

      res.json({
        ...mirrorResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level,
          rate_limit_remaining: req.dina?.rate_limit_remaining
        }
      });

    } catch (error) {
      console.error('❌ Error in Mirror submission:', error);
      res.status(500).json({
        error: 'Mirror submission failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Get User Insights (all authenticated users)
  apiRouter.get('/mirror/insights', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.dina!.dina_key;
      const { limit = 10, type, category, sort = 'recent' } = req.query;

      const mirrorMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'mirror', method: 'mirror_get_insights', priority: 6 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
          sanitized: true 
        },
        payload: {
          userId,
          limit: Math.min(parseInt(limit as string), req.dina!.trust_level === 'trusted' ? 500 : 100),
          filter: {
            type: type as string,
            category: category as string,
            sort: sort as string
          }
        }
      });

      console.log(`🔍 Mirror insights request for user: ${userId}`);
      const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);

      res.json({
        ...mirrorResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level
        }
      });

    } catch (error) {
      console.error('❌ Error getting Mirror insights:', error);
      res.status(500).json({
        error: 'Failed to get insights',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Generate Specific Analysis (all authenticated users)
  apiRouter.post('/mirror/analyze', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.dina!.dina_key;
      const { analysis_type, data, options } = req.body;

      if (!analysis_type || !data) {
        res.status(400).json({ 
          error: 'Bad Request', 
          message: 'Missing analysis_type or data',
          auth_info: { trust_level: req.dina?.trust_level }
        });
        return;
      }

      // FIXED: Validate analysis type access with proper typing
      const allowedAnalysisTypes = {
        'new': ['basic_insight', 'personality_summary', 'pattern_analysis', 'correlation_analysis'],
        'trusted': ['basic_insight', 'personality_summary', 'pattern_analysis', 'correlation_analysis', 'deep_insight'],
        'suspicious': ['basic_insight', 'personality_summary'],
        'blocked': ['basic_insight']
      };;

      const userAllowedTypes = getTrustLevelAccess(req.dina!.trust_level, allowedAnalysisTypes);
      if (!userAllowedTypes.includes(analysis_type)) {
        res.status(403).json({
          error: 'Analysis type not allowed',
          message: `Analysis type '${analysis_type}' requires higher trust level`,
          allowed_types: userAllowedTypes,
          current_trust_level: req.dina!.trust_level
        });
        return;
      }

      const mirrorMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'mirror', method: 'mirror_analyze', priority: 7 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
          sanitized: true 
        },
        payload: {
          analysisType: analysis_type,
          data,
          options: {
            ...options,
            trustLevel: req.dina!.trust_level
          }
        }
      });

      console.log(`🔬 Mirror analysis request: ${analysis_type} from ${req.dina!.trust_level} user`);
      const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);

      res.json({
        ...mirrorResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level,
          analysis_type,
          rate_limit_remaining: req.dina?.rate_limit_remaining
        }
      });

    } catch (error) {
      console.error('❌ Error in Mirror analysis:', error);
      res.status(500).json({
        error: 'Analysis failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ========================================================================
  // MIRROR: Synthesize Insights (entry point for mirror-server LLM requests)
  // ========================================================================
  // This endpoint replaces direct LLM chat access from mirror-server.
  // mirror-server's DINALLMConnector and ConversationAnalyzer should
  // call this endpoint instead of /dina/api/v1/models/mistral:7b/chat.
  // ========================================================================

  apiRouter.post('/mirror/synthesize-insights',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        // SECURITY: Use only authenticated user identity, never trust body
        const userId = req.dina?.dina_key;

        if (!userId) {
          res.status(401).json({
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH'
          });
          return;
        }

        const {
          synthesisType,
          groupId,
          sessionId,
          analysisData,
          userContext,
          conversationHistory,
          options
        } = req.body;

        // Validate required fields
        if (!synthesisType || !groupId || !analysisData) {
          res.status(400).json({
            success: false,
            error: 'Missing required fields: synthesisType, groupId, analysisData',
            code: 'INVALID_REQUEST'
          });
          return;
        }

        // Rate limit: max 1 successful synthesis per 30 seconds per user+group
        // Scoped by groupId so different groups aren't blocked, and only set AFTER
        // success so retries after failure aren't rate-limited.
        const rateLimitKey = `mirror:synthesis:ratelimit:${userId}:${groupId}`;
        const now = Date.now();
        const lastSynthesis = synthesisRateLimit.get(rateLimitKey);
        if (lastSynthesis && (now - lastSynthesis) < 30000) {
          res.status(429).json({
            success: false,
            error: 'Please wait before requesting another synthesis',
            code: 'RATE_LIMITED',
            auth_info: { trust_level: req.dina?.trust_level }
          });
          return;
        }

        // Create DUMP message targeting the mirror module's synthesizeInsights
        // NOTE: createDinaMessage wraps payload in { data: payload }, so pass flat
        const mirrorMessage = createDinaMessage({
          source: {
            module: 'api',
            version: '1.0.0'
          },
          target: {
            module: 'mirror',
            method: 'mirror_synthesize_insights',
            priority: 7
          },
          security: {
            user_id: userId,
            session_id: req.dina?.session_id,
            clearance: mapTrustLevelToSecurityLevel(req.dina?.trust_level || 'new'),
            sanitized: true
          },
          payload: {
            synthesisType,
            groupId,
            sessionId,
            analysisData,
            userContext,
            conversationHistory,
            options
          }
        });

        // Route through DINA orchestrator -> mirror module
        const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);

        if (mirrorResponse.status === 'success') {
          // The orchestrator double-wraps via createDinaResponse:
          //   mirrorModule.synthesizeInsights() -> createDinaResponse({ payload: { data, metadata } })
          //   orchestrator.handleIncomingMessage() -> createDinaResponse({ payload: <inner DinaResponse> })
          // So the inner DinaResponse is at mirrorResponse.payload.data
          // And the actual synthesis data is at innerResponse.payload.data.data
          const innerResponse = mirrorResponse.payload?.data;
          const synthesisData = innerResponse?.payload?.data?.data;
          const synthesisMetadata = innerResponse?.payload?.data?.metadata;

          // Only set rate limit after successful synthesis
          synthesisRateLimit.set(rateLimitKey, Date.now());

          res.json({
            success: true,
            data: synthesisData,
            metadata: synthesisMetadata,
            auth_info: {
              trust_level: req.dina?.trust_level,
              rate_limit_remaining: req.dina?.rate_limit_remaining
            }
          });
        } else {
          res.status(500).json({
            success: false,
            error: mirrorResponse.error?.message || 'Unknown synthesis error',
            auth_info: {
              trust_level: req.dina?.trust_level
            }
          });
        }

      } catch (error: any) {
        console.error('❌ Error in mirror/synthesize-insights:', error);
        res.status(500).json({
          error: 'Insight synthesis failed',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  );

  // Get User Context and Patterns (trusted users only)
  apiRouter.get('/mirror/context', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.dina!.dina_key;
      const { include_patterns = true, include_history = true, context_window = 30 } = req.query;

      const mirrorMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'mirror', method: 'mirror_get_context', priority: 5 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: SecurityLevel.RESTRICTED,
          sanitized: true 
        },
        payload: {
          userId,
          options: {
            includePatterns: include_patterns === 'true',
            includeHistory: include_history === 'true',
            contextWindowDays: Math.min(parseInt(context_window as string), 90)
          }
        }
      });

      console.log(`🧠 Mirror context request for user: ${userId}`);
      const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);
      
      res.json({
        ...mirrorResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level
        }
      });

    } catch (error) {
      console.error('❌ Error getting Mirror context:', error);
      res.status(500).json({
        error: 'Failed to get user context',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Get User Notifications (all authenticated users)
  apiRouter.get('/mirror/notifications', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.dina!.dina_key;
      const { limit = 20, unread_only = false, type } = req.query;

      const mirrorMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'mirror', method: 'mirror_get_notifications', priority: 4 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
          sanitized: true 
        },
        payload: {
          userId,
          limit: Math.min(parseInt(limit as string), 50),
          filter: {
            unreadOnly: unread_only === 'true',
            type: type as string
          }
        }
      });

      const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);
      
      res.json({
        ...mirrorResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level
        }
      });

    } catch (error) {
      console.error('❌ Error getting Mirror notifications:', error);
      res.status(500).json({
        error: 'Failed to get notifications',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Mark Notification as Read (all authenticated users)
  apiRouter.post('/mirror/notifications/:notificationId/read', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.dina!.dina_key;
      const { notificationId } = req.params;

      const mirrorMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'mirror', method: 'mirror_mark_notification_read', priority: 3 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
          sanitized: true 
        },
        payload: {
          userId,
          notificationId
        }
      });

      const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);
      
      res.json({
        success: true,
        message: 'Notification marked as read',
        ...mirrorResponse.payload.data
      });

    } catch (error) {
      console.error('❌ Error marking notification as read:', error);
      res.status(500).json({
        error: 'Failed to mark notification as read',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Update User Preferences (all authenticated users)
  apiRouter.post('/mirror/preferences', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.dina!.dina_key;
      const preferences = req.body;

      if (!preferences || typeof preferences !== 'object') {
        res.status(400).json({ 
          error: 'Bad Request', 
          message: 'Invalid preferences data',
          auth_info: { trust_level: req.dina?.trust_level }
        });
        return;
      }

      const mirrorMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'mirror', method: 'mirror_update_preferences', priority: 5 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
          sanitized: true 
        },
        payload: {
          userId,
          preferences
        }
      });

      const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);
      
      res.json({
        success: true,
        message: 'Preferences updated successfully',
        ...mirrorResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level
        }
      });

    } catch (error) {
      console.error('❌ Error updating Mirror preferences:', error);
      res.status(500).json({
        error: 'Failed to update preferences',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Get Submission History (trusted users only)
  apiRouter.get('/mirror/history', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.dina!.dina_key;
      const { limit = 20, include_data = false, date_from, date_to } = req.query;

      const mirrorMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'mirror', method: 'mirror_get_history', priority: 4 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: SecurityLevel.RESTRICTED,
          sanitized: true 
        },
        payload: {
          userId,
          limit: Math.min(parseInt(limit as string), 100),
          options: {
            includeData: include_data === 'true',
            dateFrom: date_from as string,
            dateTo: date_to as string
          }
        }
      });

      const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);
      
      res.json({
        ...mirrorResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level
        }
      });

    } catch (error) {
      console.error('❌ Error getting Mirror history:', error);
      res.status(500).json({
        error: 'Failed to get submission history',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Export User Data (trusted users only)
  apiRouter.post('/mirror/export', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.dina!.dina_key;
      const { format = 'json', include_raw_data = false, anonymize = false } = req.body;

      const mirrorMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'mirror', method: 'mirror_export_data', priority: 6 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: SecurityLevel.RESTRICTED,
          sanitized: true 
        },
        payload: {
          userId,
          exportOptions: {
            format,
            includeRawData: include_raw_data,
            anonymize
          }
        }
      });

      console.log(`📤 Mirror data export request from user: ${userId}`);
      const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);
      
      // Set appropriate content type based on format
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="mirror-export-${userId}-${Date.now()}.csv"`);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="mirror-export-${userId}-${Date.now()}.json"`);
      }
      
      res.json({
        ...mirrorResponse.payload.data,
        export_info: {
          format,
          timestamp: new Date().toISOString(),
          user_id: userId
        }
      });

    } catch (error) {
      console.error('❌ Error exporting Mirror data:', error);
      res.status(500).json({
        error: 'Failed to export data',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Get Analytics Overview (trusted users only)
  apiRouter.get('/mirror/analytics', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.dina!.dina_key;
      const { timeframe = '30d', metrics = 'all' } = req.query;

      const mirrorMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'mirror', method: 'mirror_get_analytics', priority: 5 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: SecurityLevel.RESTRICTED,
          sanitized: true 
        },
        payload: {
          userId,
          timeframe: timeframe as string,
          metrics: metrics as string
        }
      });

      const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);
      
      res.json({
        ...mirrorResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level
        }
      });

    } catch (error) {
      console.error('❌ Error getting Mirror analytics:', error);
      res.status(500).json({
        error: 'Failed to get analytics',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ================================
  // DIGIM INFORMATION GATHERING ENDPOINTS
  // ================================
  
  console.log('🧠 Setting up DIGIM API routes...');

  // DIGIM System Status
  apiRouter.get('/digim/status', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const digiMMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'digim', method: 'digim_status', priority: 7 },
        security: { 
          user_id: req.dina!.dina_key, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
          sanitized: true 
        },
        payload: { detailed: true, include_performance: true, include_security: true }
      });

      console.log(`🧠 DIGIM status request from ${req.dina!.trust_level} user`);
      const digiMResponse = await dina.handleIncomingMessage(digiMMessage);
      
      res.json({
        ...digiMResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level,
          rate_limit_remaining: req.dina?.rate_limit_remaining
        }
      });

    } catch (error) {
      console.error('❌ Error getting DIGIM status:', error);
      res.status(500).json({
        error: 'Failed to get DIGIM status',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // DIGIM Natural Language Query
  apiRouter.post('/digim/query', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { query, filters, intelligence_level, output_format, max_results } = req.body;

      if (!query) {
        res.status(400).json({ 
          error: 'Bad Request', 
          message: 'Query text is required',
          auth_info: { trust_level: req.dina?.trust_level }
        });
        return;
      }

      // Check token limits based on query length and intelligence level
      const estimatedTokens = query.length + (intelligence_level === 'deep' ? 1000 : 200);
      if (estimatedTokens > req.dina!.token_limit_remaining) {
        res.status(413).json({ 
          error: 'Token limit exceeded', 
          limit: req.dina!.token_limit_remaining,
          estimated_tokens: estimatedTokens,
          trust_level: req.dina!.trust_level,
          message: 'Upgrade your trust level for higher limits'
        });
        return;
      }

      const digiMMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'digim', method: 'digim_query', priority: 8 },
        security: { 
          user_id: req.dina!.dina_key, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
          sanitized: true 
        },
        payload: {
          query,
          filters: filters || {},
          intelligence_level: intelligence_level || 'basic',
          output_format: output_format || 'structured',
          max_results: Math.min(max_results || 50, req.dina!.trust_level === 'trusted' ? 1000 : 200),          user_context: {
            trust_level: req.dina!.trust_level,
            preferences: {},
            history_weight: 0.3
          }
        }
      });

      console.log(`🧠 DIGIM query: "${query.substring(0, 50)}..." from ${req.dina!.trust_level} user`);
      const digiMResponse = await dina.handleIncomingMessage(digiMMessage);
      
      res.json({
        ...digiMResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level,
          rate_limit_remaining: req.dina?.rate_limit_remaining,
          token_limit_remaining: req.dina?.token_limit_remaining
        }
      });

    } catch (error) {
      console.error('❌ Error in DIGIM query:', error);
      res.status(500).json({
        error: 'DIGIM query failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // DIGIM List Data Sources
  apiRouter.get('/digim/sources', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const digiMMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'digim', method: 'digim_list_sources', priority: 5 },
        security: { 
          user_id: req.dina!.dina_key, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
          sanitized: true 
        },
        payload: { 
          include_stats: req.dina!.trust_level === 'trusted',
          include_private: req.dina!.trust_level === 'trusted'
        }
      });

      const digiMResponse = await dina.handleIncomingMessage(digiMMessage);
      
      res.json({
        ...digiMResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level
        }
      });

    } catch (error) {
      console.error('❌ Error listing DIGIM sources:', error);
      res.status(500).json({
        error: 'Failed to list data sources',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ================================
  // ADMIN ENDPOINTS (Trusted users only)
  // ================================
  
  // Admin authentication stats
  apiRouter.get('/admin/auth/stats', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const stats = await database.query(`
        SELECT 
          trust_level,
          COUNT(*) as user_count,
          AVG(suspicion_score) as avg_suspicion,
          SUM(total_requests) as total_requests,
          SUM(successful_requests) as successful_requests,
          SUM(failed_requests) as failed_requests
        FROM dina_users 
        GROUP BY trust_level
      `, [], true);
      
      const totalUsers = await database.query(`
        SELECT COUNT(*) as total FROM dina_users
      `, [], true);
      
      res.json({ 
        stats, 
        summary: {
          total_users: totalUsers[0]?.total || 0,
          timestamp: new Date(),
          admin_user: req.dina?.dina_key
        }
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to get auth stats',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Admin user management
  apiRouter.get('/admin/users', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { limit = 50, trust_level, sort = 'recent' } = req.query;
      
      let whereClause = '';
      const params: any[] = [];
      
      if (trust_level) {
        whereClause = 'WHERE trust_level = ?';
        params.push(trust_level);
      }
      
      const orderClause = sort === 'recent' ? 'ORDER BY last_seen DESC' : 
                         sort === 'active' ? 'ORDER BY total_requests DESC' :
                         'ORDER BY first_seen ASC';
      
      const users = await database.query(`
        SELECT 
          dina_key, user_key, trust_level, suspicion_score, 
          total_requests, successful_requests, failed_requests,
          first_seen, last_seen, blocked_until
        FROM dina_users 
        ${whereClause}
        ${orderClause}
        LIMIT ?
      `, [...params, parseInt(limit as string)], true);
      
      res.json({ 
        users,
        total_count: users.length,
        admin_user: req.dina?.dina_key,
        timestamp: new Date()
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to get user list',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Admin block user
  apiRouter.post('/admin/users/:dina_key/block', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { dina_key } = req.params;
      const { duration_hours = 24, reason = 'Admin action' } = req.body;
      
      const blockUntil = new Date();
      blockUntil.setHours(blockUntil.getHours() + parseInt(duration_hours.toString()));
      
      await database.query(`
        UPDATE dina_users 
        SET trust_level = 'blocked', blocked_until = ?, suspicion_score = 100
        WHERE dina_key = ?
      `, [blockUntil, dina_key], true);
      
      res.json({ 
        success: true, 
        message: 'User blocked successfully',
        blocked_user: dina_key,
        blocked_until: blockUntil,
        admin_user: req.dina?.dina_key,
        reason
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to block user',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Admin unblock user
  apiRouter.post('/admin/users/:dina_key/unblock', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { dina_key } = req.params;
      
      await database.query(`
        UPDATE dina_users 
        SET trust_level = 'new', blocked_until = NULL, suspicion_score = 0
        WHERE dina_key = ?
      `, [dina_key], true);
      
      res.json({ 
        success: true, 
        message: 'User unblocked successfully',
        unblocked_user: dina_key,
        admin_user: req.dina?.dina_key
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to unblock user',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ================================
  // DEBUG ENDPOINT (Trusted users only)
  // ================================
  
  apiRouter.post('/debug/ollama-raw', requireTrustLevel('trusted'), async (req: Request, res: Response) => {
    console.log('🔍 DEBUG: Testing raw Ollama responses');
    
    try {
      const { model, prompt } = req.body;
      const testModel = model || 'mistral:7b';
      const testPrompt = prompt || 'Say hello';
      
      console.log(`🔍 DEBUG: Testing model ${testModel} with prompt: "${testPrompt}"`);
      
      const generateResponse = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          model: testModel, 
          prompt: testPrompt,
          stream: false
        })
      });
      
      const generateText = await generateResponse.text();
      console.log(`🔍 DEBUG: Generate response status: ${generateResponse.status}`);
      console.log(`🔍 DEBUG: Generate response length: ${generateText.length}`);
      console.log(`🔍 DEBUG: Generate raw response: ${generateText}`);
      
      const lines = generateText.trim().split('\n').filter(line => line.trim());
      console.log(`🔍 DEBUG: Generate response has ${lines.length} lines`);
      
      const analysisResult = {
        generate_endpoint: {
          status: generateResponse.status,
          response_length: generateText.length,
          line_count: lines.length,
          raw_response: generateText,
          parsed_lines: lines.map((line, index) => {
            try {
              const parsed = JSON.parse(line);
              return {
                line_number: index + 1,
                keys: Object.keys(parsed),
                done: parsed.done,
                response_length: parsed.response ? parsed.response.length : 0,
                sample_content: parsed.response ? parsed.response.substring(0, 50) : null
              };
            } catch (e) {
              return {
                line_number: index + 1,
                error: 'Failed to parse JSON',
                raw_line: line.substring(0, 100)
              };
            }
          })
        }
      };
      
      res.json(analysisResult);
      
    } catch (error) {
      console.error('🔍 DEBUG: Error testing Ollama:', error);
      res.status(500).json({
        error: 'Debug test failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ================================
  // INTEGRATION COMPLETION
  // ================================

  console.log('🪞 Mirror Module API routes configured:');
  console.log('  GET  /mirror/status           - Module status and health');
  console.log('  POST /mirror/submit           - Submit data for analysis');
  console.log('  GET  /mirror/insights         - Get user insights');
  console.log('  GET  /mirror/context          - Get user context (trusted)');
  console.log('  POST /mirror/analyze          - Generate specific analysis');
  console.log('  POST /mirror/synthesize-insights - Synthesize insights via mirror module');
  console.log('  GET  /mirror/notifications    - Get user notifications');
  console.log('  POST /mirror/notifications/:id/read - Mark notification read');
  console.log('  POST /mirror/preferences      - Update user preferences');
  console.log('  GET  /mirror/history          - Get submission history (trusted)');
  console.log('  POST /mirror/export           - Export user data (trusted)');
  console.log('  GET  /mirror/analytics        - Get analytics overview (trusted)');

  console.log('🧠 DIGIM API routes configured:');
  console.log('  GET  /digim/status           - System status');
  console.log('  POST /digim/query            - Natural language queries');
  console.log('  GET  /digim/sources          - List data sources');

  console.log('💬 LLM API routes configured:');
  console.log('  GET  /models                 - List available models');
  console.log('  POST /models/:id/chat        - Chat completions');
  console.log('  POST /models/:id/embed       - Generate embeddings');

  console.log('🔧 Admin API routes configured:');
  console.log('  GET  /admin/auth/stats       - Authentication statistics (trusted)');
  console.log('  GET  /admin/users            - User management (trusted)');
  console.log('  POST /admin/users/:id/block  - Block user (trusted)');
  console.log('  POST /admin/users/:id/unblock- Unblock user (trusted)');

  // Mount the router
  app.use(apiPath, apiRouter);

  console.log(`✅ Complete DINA API with Mirror Module mounted at ${apiPath}`);
  console.log(`📚 API Documentation available at ${apiPath}/docs (if implemented)`);
  
  // Optional: Add a routes listing endpoint
  apiRouter.get('/routes', (req: AuthenticatedRequest, res: Response) => {
    const routes = {
      public: [
        'GET /health - Service health check'
      ],
      authenticated: [
        'GET /status - System status',
        'GET /stats - System statistics',
        'GET /modules - Module status',
        'GET /models - Available LLM models',
        'POST /models/:id/chat - Chat completions',
        'POST /models/:id/embed - Generate embeddings',
        'GET /mirror/status - Mirror module status',
        'POST /mirror/submit - Submit data for analysis',
        'GET /mirror/insights - Get user insights',
        'POST /mirror/analyze - Generate specific analysis',
        'GET /mirror/notifications - Get notifications',
        'POST /mirror/preferences - Update preferences',
        'GET /digim/status - DIGIM system status',
        'POST /digim/query - Natural language queries',
        'GET /digim/sources - List data sources'
      ],
      trusted: [
        'GET /mirror/context - Get detailed user context',
        'GET /mirror/history - Get submission history',
        'POST /mirror/export - Export user data',
        'GET /mirror/analytics - Get analytics overview',
        'GET /admin/* - Administrative endpoints',
        'POST /debug/* - Debug endpoints'
      ]
    };
    
    res.json({
      api_version: '2.0.0',
      base_path: apiPath,
      total_endpoints: Object.values(routes).flat().length,
      current_user: {
        trust_level: req.dina?.trust_level,
        available_routes: routes[req.dina?.trust_level === 'trusted' ? 'trusted' : 'authenticated']
      },
      routes
    });
  });
}
