// API Routes Setup with Base Path Support (Enhanced for Phase 1)
// File: src/api/routes/index.ts

import express, { Request, Response } from 'express';
import { DinaCore } from '../../core/orchestrator';
import { authenticate, rateLimit, sanitizeInput, handleError } from '../middleware/security'; // Import new middleware
import { DinaUniversalMessage, createDinaMessage, MessagePriority, SecurityLevel } from '../../core/protocol'; // Import DUMP types and SecurityLevel
import { v4 as uuidv4 } from 'uuid'; // Import uuidv4

export function setupAPI(app: express.Application, dina: DinaCore, basePath: string = ''): void {
  const apiPath = `${basePath}/api/v1`;
  
  // API-specific middleware
  const apiRouter = express.Router();
  
  // Apply common middleware to all API routes
  apiRouter.use(express.json({ limit: '1mb' })); // Parse JSON bodies, limit payload size
  apiRouter.use(express.urlencoded({ extended: true, limit: '1mb' })); // Parse URL-encoded bodies
  apiRouter.use((req: Request, res: Response, next) => {
    console.log(`📡 API Request: ${req.method} ${req.originalUrl}`);
    next();
  });

  // Apply security middleware to core API routes that require authentication
  // The /models endpoint is now public.
  //apiRouter.use(['/models/:modelId/chat', '/models/:modelId/embeddings', '/dina'], authenticate);
  //apiRouter.use(['/models/:modelId/chat', '/models/:modelId/embeddings', '/dina'], rateLimit);
  //apiRouter.use(['/models/:modelId/chat', '/models/:modelId/embeddings', '/dina'], sanitizeInput);

  // Apply security middleware to core API routes that require authentication
  // Make embeddings endpoint public for testing
  apiRouter.use(['/models/:modelId/chat', '/dina'], authenticate);
  apiRouter.use(['/models/:modelId/chat', '/dina'], rateLimit);
  apiRouter.use(['/models/:modelId/chat', '/dina'], sanitizeInput);
  
  // Health check endpoint (specific to API)
  apiRouter.get('/health', (req: Request, res: Response) => {
    res.json({ 
      status: 'healthy', 
      service: 'DINA API',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      path: apiPath
    });
  });
  
  // System status endpoint
  apiRouter.get('/status', async (req: Request, res: Response) => {
    try {
      const status = await dina.getSystemStatus();
      res.json({
        status: 'operational',
        timestamp: new Date().toISOString(),
        modules: status,
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

  // System statistics endpoint
  apiRouter.get('/stats', async (req: Request, res: Response) => {
    try {
      const stats = await dina.getSystemStats();
      res.json({
        timestamp: new Date().toISOString(),
        statistics: stats
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to get system statistics',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Module-specific endpoints (for future modules)
  apiRouter.get('/modules', async (req: Request, res: Response) => {
    try {
      const modules = dina.getModuleStatus();
      res.json({
        available_modules: modules,
        active_count: Object.values(modules).filter(status => status === 'active').length,
        total_count: Object.keys(modules).length
      });
    } catch (error) {
      res.status(500).json({ 
        error: 'Failed to get module status',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Dashboard information endpoint (placeholder)
  apiRouter.get('/dashboard', async (req: Request, res: Response) => {
    try {
      // In a real scenario, this would aggregate data from various modules
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
  // This endpoint is the primary way to send DUMP messages to DINA Core.
  apiRouter.post('/dina', async (req: Request, res: Response) => {
    try {
      const { source, target, method, payload, priority } = req.body;
      const userId = (req as any).user?.id;
      const securityLevel = (req as any).user?.securityLevel;

      if (!source || !target || !method || !payload) {
        res.status(400).json({ error: 'Bad Request', message: 'Missing required fields: source, target, method, payload' });
        return;
      }

      // Create a DUMP message
      const dinaMessage: DinaUniversalMessage = createDinaMessage({
        source: { module: source, version: '1.0.0' }, // Assuming API is source module
        target: { module: target, method: method, priority: priority as MessagePriority || 5 },
        security: { user_id: userId, session_id: uuidv4(), clearance: securityLevel, sanitized: true },
        payload: payload // payload is already the data part
      });

      console.log(`✉️ Forwarding DUMP message to DinaCore: ${method} for ${target}`);
      // Changed from processMessage to handleIncomingMessage
      const response = await dina.handleIncomingMessage(dinaMessage); 
      res.json(response.payload.data); // Return the LLM response data from payload.data

    } catch (error) {
      console.error('❌ Error processing DINA message:', error);
      res.status(500).json({ 
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // ================================
  // LLM-SPECIFIC API ENDPOINTS (Phase 1)
  // ================================

  // List available models (now public)
  apiRouter.get('/models', async (req: Request, res: Response) => {
    try {
      // This will call the LLM Manager via DinaCore to get available models
      const models = await dina.listAvailableModels();
      res.json({
        available_models: models,
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

  // Chat completions endpoint
  apiRouter.post('/models/:modelId/chat', async (req: Request, res: Response) => {
    try {
      const { modelId } = req.params;
      const { query, options } = req.body;
      const userId = (req as any).user?.id;

      if (!query) {
        res.status(400).json({ error: 'Bad Request', message: 'Missing "query" in request body' });
        return;
      }

      // Create a DUMP message for LLM chat generation
      const dinaMessage: DinaUniversalMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'llm', method: 'llm_generate', priority: 7 }, // High priority for chat
        security: { user_id: userId, session_id: uuidv4(), clearance: (req as any).user?.securityLevel, sanitized: true },
        payload: {
          query: query,
          options: {
            ...options,
            model_preference: modelId, // Route to specific model
            conversation_id: options?.conversation_id || uuidv4(), // Ensure conversation ID
            streaming: false, // For initial API, assume non-streaming. WSS for streaming.
          }
        }
      });

      console.log(`💬 Requesting chat completion for model: ${modelId}`);
      // Changed from processMessage to handleIncomingMessage
      const llmResponse = await dina.handleIncomingMessage(dinaMessage); 
      res.json(llmResponse.payload.data); // Return the LLM response data from payload.data

    } catch (error) {
      console.error('❌ Error in LLM chat completion:', error);
      res.status(500).json({
        error: 'LLM Chat Error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Embeddings generation endpoint
  apiRouter.post('/models/:modelId/embeddings', async (req: Request, res: Response) => {
    try {
      const { modelId } = req.params;
      const { text, options } = req.body;
      const userId = (req as any).user?.id;

      if (!text) {
        res.status(400).json({ error: 'Bad Request', message: 'Missing "text" in request body' });
        return;
      }

      // Create a DUMP message for LLM embeddings generation
      const dinaMessage: DinaUniversalMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'llm', method: 'llm_embed', priority: 6 }, // Medium-high priority
        security: { user_id: userId, session_id: uuidv4(), clearance: (req as any).user?.securityLevel, sanitized: true },
        payload: {
          text: text,
          options: {
            ...options,
            model_preference: modelId, // Route to specific model
          }
        }
      });

      console.log(`🔢 Requesting embeddings for model: ${modelId}`);
      // Changed from processMessage to handleIncomingMessage
      const embeddingResponse = await dina.handleIncomingMessage(dinaMessage); 
      res.json(embeddingResponse.payload.data); // Return the embeddings data from payload.data

    } catch (error) {
      console.error('❌ Error in LLM embeddings generation:', error);
      res.status(500).json({
        error: 'LLM Embeddings Error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  // Apply the centralized error handling middleware last
  apiRouter.use(handleError);

  // Mount the API router at the specified base path
  app.use(apiPath, apiRouter);
  console.log(`🌐 DINA API v1 routes mounted at: ${apiPath}`);
}

