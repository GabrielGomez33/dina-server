// API Routes Setup
import express, { Request, Response } from 'express';
import { DinaCore } from '../../core/orchestrator';

export function setupAPI(app: express.Application, dina: DinaCore): void {
  // Basic middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  
  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.json({ 
      status: 'healthy', 
      service: 'DINA Server',
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    });
  });
  
  // DINA message processing endpoint
  app.post('/api/v1/dina', async (req: Request, res: Response) => {
    try {
      console.log('📨 Received DINA message:', req.body);
      const response = await dina.processMessage(req.body);
      res.json(response);
    } catch (error) {
      console.error('❌ Message processing error:', error);
      res.status(500).json({ 
        error: 'Processing failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  // System status endpoint
  app.get('/api/v1/status', (req: Request, res: Response) => {
    res.json({
      status: 'operational',
      modules: dina.getModuleStatus(),
      timestamp: new Date().toISOString()
    });
  });
}
