// API Routes Setup with Base Path Support (Enhanced with Unified Auth) - COMPLETE WITH FIXES
// File: src/api/routes/index.ts

import express, { Request, Response, NextFunction } from 'express'; // FIXED: Added NextFunction
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
  apiRouter.use(express.json({ limit: '1mb' }));
  apiRouter.use(express.urlencoded({ extended: true, limit: '1mb' }));
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
      service: 'DINA API with Unified Auth',
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      path: apiPath,
      features: ['unified-auth', 'progressive-trust', 'auto-registration']
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
          dina: `${apiPath}/dina`
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

  // Dashboard information endpoint (new users allowed)
  apiRouter.get('/dashboard', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const systemStatus = await dina.getSystemStatus();
      const systemStats = await dina.getSystemStats();
      const moduleStatus = dina.getModuleStatus();

      res.json({
        dashboard_summary: {
          overall_health: systemStatus.overallHealth === 'healthy' ? 'Operational' : 'Degraded',
          active_modules: Object.values(moduleStatus).filter(status => status === 'active').length,
          total_requests_processed: systemStats.totalRequestsProcessed || 0,
          avg_response_time_ms: systemStats.avgResponseTimeMs || 0,
        },
        detailed_status: systemStatus,
        detailed_stats: systemStats,
        module_status: moduleStatus,
        auth_info: {
          user_key: req.dina?.user_key,
          dina_key: req.dina?.dina_key,
          trust_level: req.dina?.trust_level,
          session_id: req.dina?.session_id
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to retrieve dashboard information',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ================================
  // DINA CORE MESSAGE PROCESSING ENDPOINT
  // ================================
  
  apiRouter.post('/dina', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { source, target, method, payload, priority } = req.body;
      const userId = req.dina!.dina_key;
      const securityLevel = req.dina!.trust_level;

      if (!source || !target || !method || !payload) {
        res.status(400).json({ 
          error: 'Bad Request', 
          message: 'Missing required fields: source, target, method, payload',
          auth_info: {
            trust_level: req.dina?.trust_level,
            dina_key: req.dina?.dina_key
          }
        });
        return;
      }

      // FIXED: Create a DUMP message with proper security clearance mapping
      const dinaMessage: DinaUniversalMessage = createDinaMessage({
        source: { module: source, version: '1.0.0' },
        target: { module: target, method: method, priority: priority as MessagePriority || 5 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(securityLevel), // FIXED: Use mapping function
          sanitized: true 
        },
        payload: payload
      });

      console.log(`✉️ Processing DUMP message: ${method} for ${target} from ${securityLevel} user`);
      const response = await dina.handleIncomingMessage(dinaMessage); 
      res.json({
        ...response.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level,
          rate_limit_remaining: req.dina?.rate_limit_remaining
        }
      });

    } catch (error) {
      console.error('❌ Error processing DINA message:', error);
      res.status(500).json({ 
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
        auth_info: {
          trust_level: req.dina?.trust_level
        }
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
      const modelAccess: { [key: string]: string[] } = {
        'new': ['mxbai-embed-large'],
        'trusted': ['mxbai-embed-large', 'mistral:7b', 'codellama:34b'],
        'suspicious': ['mxbai-embed-large'],
        'blocked': []
      };
      
      const allowedModels = modelAccess[req.dina!.trust_level] || [];
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

      if (!query) {
        res.status(400).json({ 
          error: 'Bad Request', 
          message: 'Missing "query" in request body',
          auth_info: {
            trust_level: req.dina?.trust_level
          }
        });
        return;
      }

      // Check token limits
      if (query.length > req.dina!.token_limit_remaining) {
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
      const modelAccess: { [key: string]: string[] } = {
        'new': ['mxbai-embed-large'],
        'trusted': ['mxbai-embed-large', 'mistral:7b', 'codellama:34b'],
        'suspicious': ['mxbai-embed-large'],
        'blocked': []
      };
      
      const allowedModels = modelAccess[req.dina!.trust_level] || [];
      
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
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level), // FIXED: Use mapping function
          sanitized: true 
        },
        payload: {
          query: query,
          options: {
            ...options,
            model_preference: modelId,
            conversation_id: options?.conversation_id || uuidv4(),
            streaming: false,
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

  // FIXED: Embeddings generation endpoint with proper dimension counting and error handling
  apiRouter.post('/models/:modelId/embeddings', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { modelId } = req.params;
      const { text, options } = req.body;
      const userId = req.dina!.dina_key;

      if (!text) {
        res.status(400).json({ 
          error: 'Bad Request', 
          message: 'Missing "text" in request body',
          auth_info: {
            trust_level: req.dina?.trust_level
          }
        });
        return;
      }

      // Check model access
      const modelAccess: { [key: string]: string[] } = {
        'new': ['mxbai-embed-large'],
        'trusted': ['mxbai-embed-large', 'mistral:7b', 'codellama:34b'],
        'suspicious': ['mxbai-embed-large'],
        'blocked': []
      };
      
      const allowedModels = modelAccess[req.dina!.trust_level] || [];
      
      if (!allowedModels.includes(modelId)) {
        res.status(403).json({
          error: 'Model access denied',
          message: `Access to model '${modelId}' requires higher trust level`,
          allowed_models: allowedModels,
          current_trust_level: req.dina!.trust_level
        });
        return;
      }

      // FIXED: Create DUMP message with proper security clearance mapping
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

  // Admin security events
  apiRouter.get('/admin/auth/events', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const events = await database.query(`
        SELECT * FROM dina_security_events 
        WHERE severity IN ('high', 'critical')
        ORDER BY timestamp DESC 
        LIMIT 100
      `, [], true);
      
      res.json({ 
        events, 
        count: events.length,
        timestamp: new Date(),
        admin_user: req.dina?.dina_key
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to get security events',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Admin user management
  apiRouter.post('/admin/auth/unblock', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { dina_key } = req.body;
      
      if (!dina_key) {
        res.status(400).json({ error: 'Missing dina_key in request body' });
        return;
      }
      
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
        const estimatedTokens = query.length + (intelligence_level === 'deep' ? 500 : 200);
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
            intelligence_level: intelligence_level || 'surface',
            output_format: output_format || 'json',
            max_results: max_results || 50
          }
        });
  
        console.log(`🧠 DIGIM query from ${req.dina!.trust_level} user: "${query.substring(0, 50)}..."`);
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
        console.error('❌ Error processing DIGIM export:', error);
        res.status(500).json({
          error: 'DIGIM Export Error',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  
    // DIGIM Content Clusters
    apiRouter.get('/digim/clusters', async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { category, time_range, similarity_threshold } = req.query;
  
        const digiMMessage = createDinaMessage({
          source: { module: 'api', version: '1.0.0' },
          target: { module: 'digim', method: 'digim_cluster', priority: 6 },
          security: { 
            user_id: req.dina!.dina_key, 
            session_id: req.dina!.session_id, 
            clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
            sanitized: true 
          },
          payload: {
            category: category as string,
            similarity_threshold: similarity_threshold ? parseFloat(similarity_threshold as string) : 0.8,
            max_clusters: req.dina!.trust_level === 'trusted' ? 100 : 50
          }
        });
  
        console.log(`🔗 DIGIM clusters request from ${req.dina!.trust_level} user`);
        const digiMResponse = await dina.handleIncomingMessage(digiMMessage);
        
        res.json({
          ...digiMResponse.payload.data,
          auth_info: {
            trust_level: req.dina?.trust_level
          }
        });
  
      } catch (error) {
        console.error('❌ Error getting DIGIM clusters:', error);
        res.status(500).json({
          error: 'DIGIM Clusters Error',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  
    // DIGIM Security Operations (Trusted users only)
    apiRouter.post('/digim/security/scan', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { target_ids, security_level } = req.body;
  
        const digiMMessage = createDinaMessage({
          source: { module: 'api', version: '1.0.0' },
          target: { module: 'digim', method: 'digim_security', priority: 9 },
          security: { 
            user_id: req.dina!.dina_key, 
            session_id: req.dina!.session_id, 
            clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
            sanitized: true 
          },
          payload: {
            action: 'scan',
            target_ids: target_ids || [],
            security_level: security_level || 'standard'
          }
        });
  
        console.log(`🔒 DIGIM security scan from ${req.dina!.trust_level} user`);
        const digiMResponse = await dina.handleIncomingMessage(digiMMessage);
        
        res.json({
          ...digiMResponse.payload.data,
          auth_info: {
            trust_level: req.dina?.trust_level,
            admin_user: req.dina?.dina_key
          }
        });
  
      } catch (error) {
        console.error('❌ Error processing DIGIM security scan:', error);
        res.status(500).json({
          error: 'DIGIM Security Error',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  
    // ================================
    // DIGIM ADMIN ENDPOINTS (Trusted users only)
    // ================================
    
    // DIGIM System Statistics
    apiRouter.get('/digim/admin/stats', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
      try {
        const stats = await database.query(`
          SELECT 
            ds.category,
            ds.subcategory,
            COUNT(ds.id) as source_count,
            COUNT(dc.id) as content_count,
            AVG(dc.quality_score) as avg_quality,
            AVG(dc.freshness_score) as avg_freshness,
            SUM(CASE WHEN ds.is_active = TRUE THEN 1 ELSE 0 END) as active_sources
          FROM digim_sources ds
          LEFT JOIN digim_content dc ON ds.id = dc.source_id
          GROUP BY ds.category, ds.subcategory
          ORDER BY ds.category, ds.subcategory
        `, [], true);
        
        const securityStats = await database.query(`
          SELECT 
            security_status,
            COUNT(*) as count
          FROM digim_content 
          GROUP BY security_status
        `, [], true);
        
        res.json({ 
          category_stats: stats,
          security_stats: securityStats,
          timestamp: new Date(),
          admin_user: req.dina?.dina_key
        });
      } catch (error) {
        res.status(500).json({ 
          error: 'Failed to get DIGIM stats',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  
    // DIGIM Content Management
    apiRouter.get('/digim/admin/content', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { status, category, limit = 50, offset = 0 } = req.query;
        
        let whereClause = '1=1';
        const params: any[] = [];
        
        if (status) {
          whereClause += ' AND dc.processing_status = ?';
          params.push(status);
        }
        
        if (category) {
          whereClause += ' AND ds.category = ?';
          params.push(category);
        }
        
        params.push(parseInt(limit as string), parseInt(offset as string));
        
        const content = await database.query(`
          SELECT 
            dc.*,
            ds.name as source_name,
            ds.category,
            ds.subcategory
          FROM digim_content dc
          JOIN digim_sources ds ON dc.source_id = ds.id
          WHERE ${whereClause}
          ORDER BY dc.gathered_at DESC
          LIMIT ? OFFSET ?
        `, params, true);
        
        res.json({ 
          content,
          pagination: {
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            has_more: content.length === parseInt(limit as string)
          },
          admin_user: req.dina?.dina_key
        });
      } catch (error) {
        res.status(500).json({ 
          error: 'Failed to get DIGIM content',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  
    // DIGIM Source Testing
    apiRouter.post('/digim/admin/test/:sourceId', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { sourceId } = req.params;
        
        const digiMMessage = createDinaMessage({
          source: { module: 'api', version: '1.0.0' },
          target: { module: 'digim', method: 'digim_sources', priority: 8 },
          security: { 
            user_id: req.dina!.dina_key, 
            session_id: req.dina!.session_id, 
            clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
            sanitized: true 
          },
          payload: { 
            action: 'test',
            source_id: sourceId
          }
        });
  
        console.log(`🧪 DIGIM source test from admin: ${sourceId}`);
        const digiMResponse = await dina.handleIncomingMessage(digiMMessage);
        
        res.json({
          ...digiMResponse.payload.data,
          admin_user: req.dina?.dina_key
        });
        
      } catch (error) {
        res.status(500).json({ 
          error: 'Failed to test DIGIM source',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  
    // ================================
    // INTEGRATION COMPLETION
    // ================================
  
    console.log('🧠 DIGIM API routes configured:');
    console.log('  GET  /digim/status           - System status');
    console.log('  POST /digim/query            - Natural language queries');
    console.log('  GET  /digim/sources          - List data sources');
    console.log('  POST /digim/sources          - Add data source (trusted)');
    console.log('  POST /digim/gather           - Manual gathering');
    console.log('  POST /digim/analyze          - Content analysis');
    console.log('  POST /digim/generate         - Content generation');
    console.log('  POST /digim/export           - Export data (trusted)');
    console.log('  GET  /digim/clusters         - Content clusters');
    console.log('  POST /digim/security/scan    - Security scan (trusted)');
    console.log('  GET  /digim/admin/*          - Admin endpoints (trusted)');
  
  

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
      
      res.json({
        success: true,
        analysis: analysisResult,
        recommendations: {
          issue: 'Ollama generate endpoint returns NDJSON even with stream:false',
          solution: 'Parse multiple JSON objects and accumulate response parts',
          alternative: 'Use chat endpoint if available (returns single JSON)'
        }
      });
      
    } catch (error) {
      console.error('❌ Debug endpoint error:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  });

  // FIXED: Apply the enhanced error handling middleware last
  apiRouter.use(enhancedErrorHandler);

  // Mount the API router at the specified base path
  app.use(apiPath, apiRouter);
  console.log(`🌐 DINA API v2 with Unified Auth routes mounted at: ${apiPath}`);
  console.log(`🔐 Authentication: Auto-registration enabled, Progressive trust system active`);
  console.log(`🧠 DIGIM: Information gathering and intelligence system active`);
}

// FIXED: Enhanced error handler placed outside the setupAPI function
const enhancedErrorHandler = (error: Error, req: Request, res: Response, next: NextFunction): void => {
  console.error('❌ API Error:', error);
  
  // CRITICAL: Check if headers already sent
  if (res.headersSent) {
    console.error('⚠️ Headers already sent, cannot send error response');
    return next(error);
  }
  
  // Enhanced error categorization
  let statusCode = 500;
  let errorCode = 'INTERNAL_SERVER_ERROR';
  let message = 'Internal server error';
  
  if (error.message.includes('timeout')) {
    statusCode = 408;
    errorCode = 'REQUEST_TIMEOUT';
    message = 'Request timeout';
  } else if (error.message.includes('Redis')) {
    statusCode = 503;
    errorCode = 'SERVICE_UNAVAILABLE';
    message = 'Cache service temporarily unavailable';
  } else if (error.message.includes('validation')) {
    statusCode = 400;
    errorCode = 'VALIDATION_ERROR';
    message = 'Request validation failed';
  }
  
  const errorResponse = {
    success: false,
    error: {
      code: errorCode,
      message: message,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    },
    timestamp: new Date().toISOString(),
    request_id: `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  };
  
  try {
    res.status(statusCode).json(errorResponse);
  } catch (sendError) {
    console.error('❌ Failed to send error response:', sendError);
  }
};
