// API Routes Setup with Base Path Support (Enhanced with Unified Auth)
// File: src/api/routes/index.ts

import express, { Request, Response } from 'express';
import { DinaCore } from '../../core/orchestrator';
import { authenticate, rateLimit, sanitizeInput, handleError, requireTrustLevel, corsMiddleware, AuthenticatedRequest } from '../middleware/security';
import { DinaUniversalMessage, createDinaMessage, MessagePriority, SecurityLevel } from '../../core/protocol';
import { v4 as uuidv4 } from 'uuid';
import { database } from '../../config/database/db';

export function setupAPI(app: express.Application, dina: DinaCore, basePath: string = ''): void {
  const apiPath = `${basePath}/api/v1`;
  
  // API-specific middleware
  const apiRouter = express.Router();

  // Add response timeout handling
  apiRouter.use((req: Request, res: Response, next) => {
    res.setTimeout(60000, () => {
      console.error(`⏰ Request timeout: ${req.method} ${req.path}`);
      if (!res.headersSent) {
        res.status(408).json({ error: 'Request timeout' });
      }
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

      // Create a DUMP message
      const dinaMessage: DinaUniversalMessage = createDinaMessage({
        source: { module: source, version: '1.0.0' },
        target: { module: target, method: method, priority: priority as MessagePriority || 5 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: securityLevel as SecurityLevel, 
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

      // Create a DUMP message for LLM chat generation
      const dinaMessage: DinaUniversalMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'llm', method: 'llm_generate', priority: 7 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: req.dina!.trust_level as SecurityLevel, 
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

  // Embeddings generation endpoint (most users have access)
  apiRouter.post('/models/:modelId/embeddings', async (req: AuthenticatedRequest, res: Response) => {
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

      const dinaMessage: DinaUniversalMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'llm', method: 'llm_embed', priority: 6 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: req.dina!.trust_level as SecurityLevel, 
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
      
      res.json({
        ...embeddingResponse.payload.data,
        auth_info: {
          trust_level: req.dina?.trust_level,
          rate_limit_remaining: req.dina?.rate_limit_remaining
        }
      });

    } catch (error) {
      console.error('❌ Error in LLM embeddings generation:', error);
      res.status(500).json({
        error: 'LLM Embeddings Error',
        message: error instanceof Error ? error.message : 'Unknown error',
        auth_info: {
          trust_level: req.dina?.trust_level
        }
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

  // Apply the centralized error handling middleware last
  apiRouter.use(handleError);

  // Mount the API router at the specified base path
  app.use(apiPath, apiRouter);
  console.log(`🌐 DINA API v2 with Unified Auth routes mounted at: ${apiPath}`);
  console.log(`🔐 Authentication: Auto-registration enabled, Progressive trust system active`);
}
