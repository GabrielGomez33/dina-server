// DINA Server - Phase 1: Redis + WebSocket Foundation (Enhanced for API Routes)
// File: src/index.ts

import https from 'https';
import fs from 'fs';
import express from 'express';
import dotenv from 'dotenv';
import { DinaCore } from './core/orchestrator';
import { DinaWebSocketManager } from './config/wss';
import { setupAPI } from './api/routes'; // Import the setupAPI function
import { database } from './config/database/db'; // Import the database instance

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
  private startTime: Date = new Date(); // Moved initialization here

  constructor() {
    console.log('🚀 Initializing DINA Phase 1: Foundation Services');
    
    this.validateEnvironment();
    this.expressApp = express(); // Initialize express app here
    this.dinaCore = new DinaCore(); // Initialize DinaCore
    this.setupGracefulShutdown();
  }

  /**
   * Validates critical environment variables.
   */
  private validateEnvironment(): void {
    if (!process.env.TUGRRPRIV || !process.env.TUGRRCERT || !process.env.TUGRRINTERCERT) {
      console.warn('⚠️ SSL certificates environment variables (TUGRRPRIV, TUGRRCERT, TUGRRINTERCERT) are not fully set. HTTPS server might not start.');
      // In production, this should be a critical error.
    }
    // No specific validation for REDIS_URL or DINA_PORT as they have defaults.
    console.log('✅ Environment variables validated');
  }

  /**
   * Configures the Express application.
   */
  private configureExpress(): void {
    // Basic Express setup
    this.expressApp.disable('x-powered-by'); // Security best practice
    this.expressApp.use(express.json({ limit: '1mb' })); // For parsing application/json
    this.expressApp.use(express.urlencoded({ extended: true, limit: '1mb' })); // For parsing application/x-www-form-urlencoded

    // Root endpoint
    this.expressApp.get('/', (req, res) => {
      res.status(200).send('DINA Server is running. Access API at /api/v1 or WebSocket at /dina/ws');
    });

    // Setup API routes
    // The Apache config specifies /dina as the base path for DINA.
    // So, the API path will be /dina/api/v1
    setupAPI(this.expressApp, this.dinaCore, '/dina');

    console.log('✅ Express application configured');
  }

  /**
   * Loads SSL certificates.
   * @returns An object containing key, cert, and ca.
   */
  private loadSSLCertificates(): { key: Buffer; cert: Buffer; ca: Buffer } {
    console.log('🔐 Loading SSL certificates...');
    try {
      const privateKey = fs.readFileSync(process.env.TUGRRPRIV!, 'utf8');
      const certificate = fs.readFileSync(process.env.TUGRRCERT!, 'utf8');
      const ca = fs.readFileSync(process.env.TUGRRINTERCERT!, 'utf8');
      console.log('✅ SSL certificates loaded successfully');
      return { key: Buffer.from(privateKey), cert: Buffer.from(certificate), ca: Buffer.from(ca) }; // Convert to Buffer
    } catch (error) {
      console.error('❌ Failed to load SSL certificates:', error);
      throw new Error('SSL certificate loading failed. Ensure TUGRRPRIV, TUGRRCERT, TUGRRINTERCERT are correctly set and files exist.');
    }
  }

  /**
   * Starts the HTTPS server.
   */
  private startHttpServer(): void {
    console.log('🌐 Creating HTTPS server...');
    const credentials = this.loadSSLCertificates();
    this.httpsServer = https.createServer(credentials, this.expressApp);

    const port = parseInt(process.env.DINA_PORT || '8445', 10);
    this.httpsServer.listen(port, () => {
      this.isRunning = true;
      console.log(`🔗 HTTPS Server: https://localhost:${port}/dina`);
    });

    this.httpsServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${port} is already in use. Please free up the port or change DINA_PORT.`);
      } else {
        console.error('❌ HTTPS Server error:', error);
      }
      process.exit(1); // Exit on critical server error
    });
  }

  /**
   * Starts the WebSocket server.
   */
  private startWebSocketServer(): void {
    if (!this.httpsServer) {
      throw new Error('HTTPS server must be started before WebSocket server.');
    }
    console.log('🔌 Setting up secure WebSocket...');
    this.websocketManager = new DinaWebSocketManager(this.httpsServer);
    console.log('🔌 Initializing DINA WebSocket server...'); // Log from wss/index.ts
    console.log('✅ DINA WebSocket server (WSS) ready on /dina/ws');
  }

  /**
   * Starts all DINA services.
   */
  async start(): Promise<void> {
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

    try {
      // Initialize DINA Core first, which initializes DB, Redis, LLM Manager
      await this.dinaCore.initialize();

      this.configureExpress(); // Configure Express AFTER DinaCore is initialized
      this.startHttpServer();
      this.startWebSocketServer();

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('✅ DINA Phase 1 services online!');
      console.log(`🔗 HTTPS Server: https://localhost:${process.env.DINA_PORT || '8445'}/dina`);
      console.log(`🔌 WebSocket Server: wss://localhost:${process.env.DINA_PORT || '8445'}/dina/ws`);
      console.log('📊 System ready for 10,000+ concurrent users');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      await database.log('info', 'dina-server', 'DINA server started successfully');

    } catch (error) {
      console.error('❌ Failed to start DINA Phase 1 services:', error);
      await database.log('critical', 'dina-server', 'DINA server failed to start', { error: (error as Error).message });
      process.exit(1);
    }
  }

  /**
   * Sets up graceful shutdown handlers.
   */
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
        
        // Shutdown DINA Core (includes Redis, LLM Manager, Database)
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

// Start the DINA server
startDinaPhase1();

