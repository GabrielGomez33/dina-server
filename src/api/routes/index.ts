// API Routes Setup with Base Path Support
import express, { Request, Response } from 'express';
import { DinaCore } from '../../core/orchestrator';

export function setupAPI(app: express.Application, dina: DinaCore, basePath: string = ''): void {
  const apiPath = `${basePath}/api/v1`;
  
  // API-specific middleware
  const apiRouter = express.Router();
  
  // Request logging middleware
  apiRouter.use((req: Request, res: Response, next) => {
    console.log(`📡 API Request: ${req.method} ${req.originalUrl}`);
    next();
  });
  
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
  
  // DINA message processing endpoint
  apiRouter.post('/dina', async (req: Request, res: Response) => {
    try {
      console.log('📨 Received DINA message:', req.body);
      const response = await dina.processMessage(req.body);
      res.json(response);
    } catch (error) {
      console.error('❌ Message processing error:', error);
      res.status(500).json({ 
        error: 'Processing failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      });
    }
  });

  // DINA dashboard info endpoint
  apiRouter.get('/dashboard', (req: Request, res: Response) => {
    res.json({
      name: 'DINA Dashboard',
      description: 'Distributed Intelligence Neural Architect - System Monitor',
      version: '1.0.0',
      features: [
        'Real-time system monitoring',
        'Request processing analytics',
        'Module status tracking',
        'Performance metrics',
        'System logs'
      ],
      endpoints: {
        frontend: basePath,
        api: apiPath,
        websocket: `${basePath}/ws`
      }
    });
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

  // API documentation endpoint
  apiRouter.get('/', (req: Request, res: Response) => {
    res.json({
      name: 'DINA API',
      version: '1.0.0',
      description: 'Distributed Intelligence Neural Architect API',
      base_url: apiPath,
      endpoints: {
        'GET /': 'This API documentation',
        'GET /health': 'API health check',
        'GET /status': 'System status',
        'GET /stats': 'System statistics',
        'GET /modules': 'Module status',
        'GET /dashboard': 'Dashboard information',
        'POST /dina': 'Process DINA message'
      },
      message_format: {
        id: 'string (optional)',
        source: 'string',
        target: 'string (dina|mirror|system)',
        method: 'string',
        payload: 'object',
        priority: 'number (1-10, optional)'
      }
    });
  });

  // Mount the API router
  app.use(apiPath, apiRouter);
  
  console.log(`🔌 API mounted at: ${apiPath}`);
}


