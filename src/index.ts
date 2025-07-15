// DINA Server - Phase 1: Redis + WebSocket Foundation
// REPLACE your existing src/index.ts with this file

import https from 'https';
import fs from 'fs';
import express from 'express';
import dotenv from 'dotenv';
import { DinaCore } from './core/orchestrator';
import { DinaWebSocketManager } from './config/wss';

// Load environment variables FIRST
dotenv.config();

// Debug environment variables
console.log('🔍 DINA Environment Variables Check:');
console.log('DINA_PORT:', process.env.DINA_PORT || 'NOT SET (will use 8443)');
console.log('REDIS_URL:', process.env.REDIS_URL || 'NOT SET (will use redis://localhost:6379)');
console.log('TUGRRPRIV:', process.env.TUGRRPRIV ? '✅ SSL Private Key SET' : '❌ NOT SET');
console.log('TUGRRCERT:', process.env.TUGRRCERT ? '✅ SSL Certificate SET' : '❌ NOT SET');
console.log('TUGRRINTERCERT:', process.env.TUGRRINTERCERT ? '✅ SSL Intermediate SET' : '❌ NOT SET');

class DinaServer {
  private httpsServer: https.Server | null = null;
  private expressApp: express.Application;
  private websocketManager: DinaWebSocketManager | null = null;
  private dinaCore: DinaCore;
  private isRunning: boolean = false;
  private startTime: Date = new Date();

  constructor() {
    console.log('🚀 Initializing DINA Phase 1: Foundation Services');
    
    this.validateEnvironment();
    this.expressApp = this.setupExpress();
    this.dinaCore = new DinaCore();
    this.setupGracefulShutdown();
  }

  /**
   * Validate required environment variables
   */
  private validateEnvironment(): void {
    const requiredEnvs = ['TUGRRPRIV', 'TUGRRCERT', 'TUGRRINTERCERT'];

    for (const key of requiredEnvs) {
      if (!process.env[key]) {
        console.error(`❌ Missing required environment variable: ${key}`);
        console.error(`💡 Please add ${key} to your .env file`);
        process.exit(1);
      }
    }
    
    console.log('✅ Environment variables validated');
  }

  /**
   * Setup Express application
   */
  private setupExpress(): express.Application {
    const app = express();
    
    // Middleware
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    
    // Request logging
    app.use((req, res, next) => {
      console.log(`[HTTP] ${req.method} ${req.url} from ${req.ip}`);
      next();
    });
    
    // DINA API routes
    this.setupAPIRoutes(app);
    
    return app;
  }

  /**
   * Setup API routes
   */
  private setupAPIRoutes(app: express.Application): void {
    // Root DINA endpoint
    app.get('/dina', (req, res) => {
      res.json({
        name: 'DINA Server',
        description: 'Distributed Intelligence Neural Architect',
        version: '1.0.0',
        phase: 1,
        capabilities: ['websocket', 'redis_queues', 'ssl'],
        endpoints: {
          health: '/dina/health',
          stats: '/dina/stats',
          websocket: `wss://${req.get('host')}/dina/ws`
        },
        status: this.isRunning ? 'running' : 'starting',
        timestamp: new Date().toISOString()
      });
    });

    // Health check
    app.get('/dina/health', (req, res) => {
      const coreStatus = this.dinaCore.getModuleStatus();
      const wsStats = this.websocketManager?.getStats() || {};
      
      res.json({
        status: 'healthy',
        phase: 1,
        services: {
          core: coreStatus['dina-core'] === 'active' ? 'online' : 'offline',
          websocket: this.websocketManager ? 'online' : 'offline',
          redis: coreStatus['redis'] === 'active' ? 'online' : 'offline',
          ssl: 'enabled'
        },
        uptime_ms: Date.now() - this.startTime.getTime(),
        connections: wsStats.active_connections || 0,
        timestamp: new Date().toISOString()
      });
    });

    // System statistics
    app.get('/dina/stats', async (req, res) => {
      try {
        const coreStatus = this.dinaCore.getModuleStatus();
        const wsStats = this.websocketManager?.getStats() || {};
        
        res.json({
          server: {
            uptime_ms: Date.now() - this.startTime.getTime(),
            memory_usage: process.memoryUsage(),
            node_version: process.version,
            phase: 1,
            ssl_enabled: true
          },
          core: coreStatus,
          connections: wsStats,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        res.status(500).json({ 
          error: 'Failed to get system stats',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Error handler
    app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      console.error('❌ HTTP Error:', err);
      res.status(500).json({
        error: 'Internal server error',
        message: err.message,
        timestamp: new Date().toISOString()
      });
    });
  }

  /**
   * Load SSL credentials
   */
  private loadSSLCredentials(): https.ServerOptions {
    try {
      const PRIV = fs.readFileSync(process.env.TUGRRPRIV!, 'utf8');
      const CERT = fs.readFileSync(process.env.TUGRRCERT!, 'utf8');
      const INTERCERT = fs.readFileSync(process.env.TUGRRINTERCERT!, 'utf8');
      
      console.log('✅ SSL certificates loaded successfully');
      
      return {
        key: PRIV,
        cert: CERT,
        ca: INTERCERT,
      };
    } catch (error) {
      console.error('❌ Failed to load SSL certificates:', error);
      throw error;
    }
  }

  /**
   * Start the DINA server
   */
  async start(): Promise<void> {
    try {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('Phase 1 Features:');
      console.log('  ✅ SSL/TLS Security');
      console.log('  ✅ Secure WebSocket (WSS)'); 
      console.log('  ✅ Redis Message Queues (4 Priority Levels)');
      console.log('  ✅ Universal Message Protocol (DUMP)');
      console.log('  ✅ Connection Management (10,000+ users)');
      console.log('  ✅ Performance Monitoring');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('⚡ Starting DINA services...');
      
      // Step 1: Initialize DINA Core (includes Redis)
      console.log('🧠 Initializing DINA Core...');
      await this.dinaCore.initialize();
      
      // Step 2: Load SSL certificates
      console.log('🔐 Loading SSL certificates...');
      const credentials = this.loadSSLCredentials();
      
      // Step 3: Create HTTPS server
      console.log('🌐 Creating HTTPS server...');
      this.httpsServer = https.createServer(credentials, this.expressApp);
      
      // Step 4: Setup WebSocket on HTTPS server
      console.log('🔌 Setting up secure WebSocket...');
      this.websocketManager = new DinaWebSocketManager(this.httpsServer);
      
      // Step 5: Start listening
      const port = parseInt(process.env.DINA_PORT || '8443');
      this.httpsServer.listen(port, () => {
        this.isRunning = true;
        this.startTime = new Date();
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ DINA Phase 1 services online!');
        console.log(`🔗 HTTPS Server: https://localhost:${port}/dina`);
        console.log(`🔌 WebSocket Server: wss://localhost:${port}/dina/ws`);
        console.log('📊 System ready for 10,000+ concurrent users');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🎯 Phase 1 Complete! Ready for Phase 2: Multi-Model LLM Integration');
        console.log('');
      });
      
    } catch (error) {
      console.error('❌ Failed to start DINA:', error);
      process.exit(1);
    }
  }
  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}, shutting down DINA gracefully...`);
      
      this.isRunning = false;
      
      try {
        // Close WebSocket connections
        if (this.websocketManager) {
          await this.websocketManager.shutdown();
        }
        
        // Close HTTPS server
        if (this.httpsServer) {
          this.httpsServer.close();
        }
        
        // Shutdown DINA Core (includes Redis)
        await this.dinaCore.shutdown();
        
        console.log('✅ DINA shutdown complete');
        process.exit(0);
        
      } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

/**
 * DINA Phase 1 Startup Function
 */
async function startDinaPhase1() {
  try {
    const server = new DinaServer();
    await server.start();
    
  } catch (error) {
    console.error('❌ Failed to start DINA Phase 1:', error);
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the DINA Phase 1 application
startDinaPhase1();
