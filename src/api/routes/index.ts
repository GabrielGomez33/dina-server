// FIXED API Routes Setup - Relaxed for Internal DINA System
// File: src/api/routes/index.ts

import express, { Request, Response, NextFunction } from 'express';
import { DinaCore } from '../../core/orchestrator';
import { authenticate, rateLimit, sanitizeInput, handleError, requireTrustLevel, corsMiddleware, AuthenticatedRequest } from '../middleware/security';
import { DinaUniversalMessage, createDinaMessage, MessagePriority, SecurityLevel } from '../../core/protocol';
import { v4 as uuidv4 } from 'uuid';
import { database } from '../../config/database/db';
import { digiMOrchestrator } from '../../modules/digim';
import { isDigiMMethod } from '../../modules/digim/types';
import {DinaLLMManager} from '../../modules/llm/manager';

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

// FIXED: Relaxed trust level access for internal system
function getTrustLevelAccess(trustLevel: string, accessMap: Record<string, string[]>): string[] {
  // RELAXED: Since DINA is not user-facing, allow broader access
  if (trustLevel === 'blocked') return [];
  return accessMap[trustLevel] || accessMap['new'] || [];
}

export function setupAPI(app: express.Application, dina: DinaCore, basePath: string = ''): void {
  const apiPath = `${basePath}/api/v1`;
  
  // API-specific middleware
  const apiRouter = express.Router();

  // ENHANCED: Apply middleware with relaxed restrictions
  apiRouter.use(corsMiddleware);
  apiRouter.use(express.json({ limit: '10mb' })); // Increased limit for internal system
  apiRouter.use(express.urlencoded({ extended: true, limit: '10mb' }));
  apiRouter.use(authenticate); // Still authenticate but be less restrictive
  apiRouter.use(rateLimit); // Keep rate limiting but with higher limits

  // Error handling middleware
  apiRouter.use(handleError);

  console.log(`🔧 Setting up DINA API routes at ${apiPath} with relaxed internal restrictions...`);

  // ================================
  // PUBLIC HEALTH ENDPOINTS (No Auth Required)
  // ================================

  // Health check - no authentication required
  apiRouter.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
      status: 'healthy',
      service: 'DINA API',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime())
    });
  });

  // ================================
  // BASIC API ENDPOINTS
  // ================================

  // System status (authenticated users)
  apiRouter.get('/status', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const status = await dina.getSystemStatus();
      res.json({
        ...status,
        auth_info: {
          trust_level: req.dina?.trust_level,
          rate_limit_remaining: req.dina?.rate_limit_remaining
        }
      });
    } catch (error) {
      console.error('❌ Error getting system status:', error);
      res.status(500).json({
        error: 'Failed to get system status',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // System statistics (authenticated users)
  apiRouter.get('/stats', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const stats = await dina.getSystemStats();
      res.json({
        ...stats,
        auth_info: {
          trust_level: req.dina?.trust_level,
          rate_limit_remaining: req.dina?.rate_limit_remaining
        }
      });
    } catch (error) {
      console.error('❌ Error getting system stats:', error);
      res.status(500).json({
        error: 'Failed to get system stats',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Module status (authenticated users)
  apiRouter.get('/modules', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const moduleStatus = await dina.getSystemStatus();
      res.json({
        modules: moduleStatus,
        timestamp: new Date().toISOString(),
        auth_info: {
          trust_level: req.dina?.trust_level
        }
      });
    } catch (error) {
      console.error('❌ Error getting module status:', error);
      res.status(500).json({
        error: 'Failed to get module status',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ================================
  // FIXED LLM-SPECIFIC API ENDPOINTS
  // ================================

  // FIXED: List available models with relaxed restrictions
  apiRouter.get('/models', async (req: AuthenticatedRequest, res: Response) => {
    try {
      console.log('📋 API: Fetching available models...');
      const models = await dina.listAvailableModels();
      console.log(`📋 API: Found ${models.length} models: ${models.join(', ')}`);
      
      // RELAXED: More permissive model access for internal system
      const modelAccess = {
        'new': ['mxbai-embed-large', 'mistral:7b'], // EXPANDED: Allow mistral for new users
        'trusted': ['mxbai-embed-large', 'mistral:7b', 'codellama:34b', 'llama2:70b'],
        'suspicious': ['mxbai-embed-large'], // Still restrict suspicious users
        'blocked': [] // Blocked users get nothing
      };
      
      const allowedModels = getTrustLevelAccess(req.dina!.trust_level, modelAccess);
      const filteredModels = models.filter(model => {
        // RELAXED: If model isn't in our access list, allow it for trusted+ users
        return allowedModels.includes(model) || 
               (req.dina!.trust_level === 'trusted' && models.includes(model));
      });
      
      res.json({
        available_models: filteredModels,
        all_models: models,
        system_info: {
          total_models_detected: models.length,
          models_accessible: filteredModels.length
        },
        auth_info: {
          trust_level: req.dina?.trust_level,
          allowed_models: allowedModels,
          upgrade_message: req.dina?.trust_level === 'new' ? 
            'Internal system - most models available' : null
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Error listing models:', error);
      res.status(500).json({
        error: 'Failed to list models',
        message: error instanceof Error ? error.message : 'Unknown error',
        auth_info: {
          trust_level: req.dina?.trust_level
        }
      });
    }
  });

  // FIXED: Chat completions endpoint with relaxed restrictions
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

      // RELAXED: Higher token limits for internal system
      const tokenLimit = req.dina!.trust_level === 'trusted' ? 50000 : 10000;
      if (query.length > tokenLimit) {
        res.status(413).json({ 
          error: 'Token limit exceeded', 
          limit: tokenLimit,
          trust_level: req.dina!.trust_level,
          message: 'Internal system - contact admin for higher limits',
          query_length: query.length
        });
        return;
      }

      // RELAXED: Model access check
      const modelAccess = {
        'new': ['mxbai-embed-large', 'mistral:7b'],
        'trusted': ['mxbai-embed-large', 'mistral:7b', 'codellama:34b', 'llama2:70b'],
        'suspicious': ['mxbai-embed-large'],
        'blocked': []
      };
      
      const allowedModels = getTrustLevelAccess(req.dina!.trust_level, modelAccess);
      
      // RELAXED: Allow access if user is trusted or model is generally available
      const hasAccess = allowedModels.includes(modelId) || 
                       (req.dina!.trust_level === 'trusted');
      
      if (!hasAccess && req.dina!.trust_level !== 'blocked') {
        // SOFT REJECTION: Suggest alternative instead of hard block
        res.status(403).json({
          error: 'Model access limited',
          message: `Model '${modelId}' requires higher trust level, try: ${allowedModels.join(', ')}`,
          allowed_models: allowedModels,
          current_trust_level: req.dina!.trust_level,
          suggested_models: allowedModels,
          upgrade_message: 'Internal system - contact admin for model access'
        });
        return;
      }

      // Create DINA message for LLM chat generation
      const dinaMessage: DinaUniversalMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'llm', method: 'llm_generate', priority: 7 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
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
      
      // TIMEOUT PROTECTION: Set response timeout
      const responseTimeout = setTimeout(() => {
        if (!res.headersSent) {
          res.status(408).json({
            error: 'Request timeout',
            message: 'LLM response took too long',
            timeout_ms: 30000
          });
        }
      }, 30000);

      try {
        const llmResponse = await dina.handleIncomingMessage(dinaMessage);
        clearTimeout(responseTimeout);
        
        if (!res.headersSent) {
          res.json({
            ...llmResponse.payload.data,
            auth_info: {
              trust_level: req.dina?.trust_level,
              rate_limit_remaining: req.dina?.rate_limit_remaining,
              token_limit_remaining: tokenLimit - query.length
            }
          });
        }
      } catch (error) {
        clearTimeout(responseTimeout);
        throw error;
      }

    } catch (error) {
      console.error('❌ Error in LLM chat completion:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'LLM Chat Error',
          message: error instanceof Error ? error.message : 'Unknown error',
          auth_info: {
            trust_level: req.dina?.trust_level
          }
        });
      }
    }
  });

  // FIXED: Embeddings endpoint with BOTH /embed and /embeddings routes
  const embeddingHandler = async (req: AuthenticatedRequest, res: Response) => {
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

      // RELAXED: Higher token limits
      const tokenLimit = req.dina!.trust_level === 'trusted' ? 50000 : 10000;
      if (text.length > tokenLimit) {
        res.status(413).json({ 
          error: 'Token limit exceeded', 
          limit: tokenLimit,
          trust_level: req.dina!.trust_level,
          message: 'Internal system - contact admin for higher limits',
          text_length: text.length
        });
        return;
      }

      // RELAXED: Model access check for embeddings
      const modelAccess = {
        'new': ['mxbai-embed-large'],
        'trusted': ['mxbai-embed-large', 'mistral:7b', 'codellama:34b'],
        'suspicious': ['mxbai-embed-large'],
        'blocked': []
      };
      
      const allowedModels = getTrustLevelAccess(req.dina!.trust_level, modelAccess);
      const hasAccess = allowedModels.includes(modelId) || 
                       (req.dina!.trust_level === 'trusted');
      
      if (!hasAccess) {
        res.status(403).json({
          error: 'Model access limited',
          message: `Embedding model '${modelId}' requires higher trust level`,
          allowed_models: allowedModels,
          current_trust_level: req.dina!.trust_level,
          suggested_models: ['mxbai-embed-large']
        });
        return;
      }

      // Create DINA message for LLM embedding
      const dinaMessage: DinaUniversalMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'llm', method: 'llm_embed', priority: 6 },
        security: { 
          user_id: userId, 
          session_id: req.dina!.session_id, 
          clearance: mapTrustLevelToSecurityLevel(req.dina!.trust_level),
          sanitized: true 
        },
        payload: {
          text: text,
          options: {
            ...options,
            model_preference: modelId
          }
        }
      });

      console.log(`🔢 Embedding request: ${modelId} from ${req.dina!.trust_level} user`);
      
      // TIMEOUT PROTECTION
      const responseTimeout = setTimeout(() => {
        if (!res.headersSent) {
          res.status(408).json({
            error: 'Request timeout',
            message: 'Embedding generation took too long',
            timeout_ms: 30000
          });
        }
      }, 30000);

      try {
        const embeddingResponse = await dina.handleIncomingMessage(dinaMessage);
        clearTimeout(responseTimeout);
        
        if (!res.headersSent && embeddingResponse.status === 'success') {
          const responseData = embeddingResponse.payload.data;
          
          // Parse embeddings if they're stored as JSON string
          let embeddings = responseData.response;
          if (typeof embeddings === 'string') {
            try {
              embeddings = JSON.parse(embeddings);
            } catch (e) {
              console.warn('Could not parse embeddings JSON, using raw response');
            }
          }
          
          const dimensions = Array.isArray(embeddings) ? embeddings.length : 0;
          
          const structuredResponse = {
            id: responseData.id,
            model: responseData.model || modelId,
            embeddings: embeddings,
            dimensions: dimensions,
            tokens: responseData.tokens || { input: 0, output: 0, total: 0 },
            performance: responseData.performance || {},
            confidence: responseData.confidence || 0.9,
            metadata: {
              ...responseData.metadata,
              actual_dimensions: dimensions,
              embedding_format: 'array',
              processing_successful: true
            },
            auth_info: {
              trust_level: req.dina?.trust_level,
              rate_limit_remaining: req.dina?.rate_limit_remaining
            }
          };
          
          console.log(`✅ Embedding dimensions: ${dimensions}, model: ${modelId}`);
          res.json(structuredResponse);
        } else {
          if (!res.headersSent) {
            console.error('❌ LLM embedding failed:', embeddingResponse);
            res.status(500).json({
              error: 'Embedding generation failed',
              message: embeddingResponse.payload?.data?.message || 'Unknown error',
              auth_info: {
                trust_level: req.dina?.trust_level
              }
            });
          }
        }
      } catch (error) {
        clearTimeout(responseTimeout);
        throw error;
      }

    } catch (error) {
      console.error('❌ Error in LLM embeddings generation:', error);
      
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
  };

  // FIXED: Support BOTH /embed and /embeddings endpoints
  apiRouter.post('/models/:modelId/embed', embeddingHandler);
  apiRouter.post('/models/:modelId/embeddings', embeddingHandler); // ADDED: For client compatibility

  // ================================
  // ADMIN ENDPOINTS
  // ================================

  // Admin auth stats
  apiRouter.get('/admin/auth/stats', requireTrustLevel('trusted'), async (req: AuthenticatedRequest, res: Response) => {
    try {
      const stats = await database.query(`
        SELECT 
          trust_level,
          COUNT(*) as user_count,
          AVG(suspicion_score) as avg_suspicion,
          MAX(last_request_time) as last_activity
        FROM dina_users 
        GROUP BY trust_level
      `, [], true);
      
      res.json({ 
        auth_statistics: stats,
        admin_user: req.dina?.dina_key,
        generated_at: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to get auth stats',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ================================
  // DEBUG ENDPOINT (Internal Use)
  // ================================
  
  apiRouter.post('/debug/ollama-raw', requireTrustLevel('trusted'), async (req: Request, res: Response) => {
    console.log('🔍 DEBUG: Testing raw Ollama responses');
    
    try {
      const { model, prompt } = req.body;
      const testModel = model || 'mistral:7b';
      const testPrompt = prompt || 'Say hello in one sentence';
      
      console.log(`🔍 DEBUG: Testing model ${testModel} with prompt: "${testPrompt}"`);
      
      // Test both generate and embed endpoints
      const [generateTest, embedTest] = await Promise.allSettled([
        fetch('http://localhost:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            model: testModel, 
            prompt: testPrompt,
            stream: false
          })
        }),
        fetch('http://localhost:11434/api/embed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            model: 'mxbai-embed-large', 
            input: testPrompt
          })
        })
      ]);
      
      const result: any = {
        timestamp: new Date().toISOString(),
        test_model: testModel,
        test_prompt: testPrompt,
        generate_test: {
          status: generateTest.status,
          success: generateTest.status === 'fulfilled'
        },
        embed_test: {
          status: embedTest.status,
          success: embedTest.status === 'fulfilled'
        }
      };

      if (generateTest.status === 'fulfilled') {
        const response = generateTest.value;
        const responseText = await response.text();
        result.generate_test = {
          ...result.generate_test,
          http_status: response.status,
          response_length: responseText.length,
          first_100_chars: responseText.substring(0, 100)
        };
      }

      if (embedTest.status === 'fulfilled') {
        const response = embedTest.value;
        const responseText = await response.text();
        result.embed_test = {
          ...result.embed_test,
          http_status: response.status,
          response_length: responseText.length,
          first_100_chars: responseText.substring(0, 100)
        };
      }
      
      res.json(result);
      
    } catch (error) {
      console.error('🔍 DEBUG: Ollama test failed:', error);
      res.status(500).json({
        error: 'Debug test failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // Log configuration
  console.log('🔧 API Configuration:');
  console.log('  🌍 CORS: Enhanced for internal use');
  console.log('  🔐 Auth: Relaxed restrictions for internal system');
  console.log('  📝 Rate Limits: Higher for internal system');
  console.log('  📊 Token Limits: 10K (new), 50K (trusted)');

  console.log('📡 Basic API routes configured:');
  console.log('  GET  /health                 - Service health check');
  console.log('  GET  /status                 - System status');
  console.log('  GET  /stats                  - System statistics');
  console.log('  GET  /modules                - Module status');

  console.log('💬 LLM API routes configured:');
  console.log('  GET  /models                 - List available models');
  console.log('  POST /models/:id/chat        - Chat completions');
  console.log('  POST /models/:id/embed       - Generate embeddings');
  console.log('  POST /models/:id/embeddings  - Generate embeddings (compatibility)');

  console.log('🔧 Admin API routes configured:');
  console.log('  GET  /admin/auth/stats       - Authentication statistics');
  console.log('  POST /debug/ollama-raw       - Ollama direct testing');

  // Mount the router
  app.use(apiPath, apiRouter);
  
  console.log(`✅ Enhanced DINA API with relaxed restrictions mounted at ${apiPath}`);
  console.log(`📚 Internal system optimized for development and testing`);
}
