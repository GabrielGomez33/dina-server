// DINA Server - Entry Point
// File: src/index.ts
//
// FIX: Import the singleton `dinaCore` from the orchestrator instead of
// creating a second DinaCore with `new DinaCore()`. The orchestrator module
// already creates one at export time (`export const dinaCore = new DinaCore()`),
// so `new DinaCore()` here was producing a duplicate that never got initialized.

import https from 'https';
import fs from 'fs';
import express from 'express';
import dotenv from 'dotenv';
import { dinaCore } from './core/orchestrator';
import { DinaWebSocketManager } from './config/wss';
import { setupAPI } from './api/routes';
import { database } from './config/database/db';

// Load environment variables FIRST
dotenv.config();

// Debug environment variables
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('   DINA — Distributed Intelligent Neural Architect');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('🔍 Environment:');
console.log(`   PORT:     ${process.env.DINA_PORT || '8445 (default)'}`);
console.log(`   REDIS:    ${process.env.REDIS_URL || 'redis://localhost:6379 (default)'}`);
console.log(`   SSL KEY:  ${process.env.TUGRRPRIV ? '✅' : '❌ NOT SET'}`);
console.log(`   SSL CERT: ${process.env.TUGRRCERT ? '✅' : '❌ NOT SET'}`);
console.log(`   SSL CA:   ${process.env.TUGRRINTERCERT ? '✅' : '❌ NOT SET'}`);
console.log('');

class DinaServer {
  private httpsServer: https.Server | null = null;
  private expressApp: express.Application;
  private websocketManager: DinaWebSocketManager | null = null;
  private isRunning: boolean = false;
  private startTime: Date = new Date();

  constructor() {
    this.validateEnvironment();
    this.expressApp = express();
    this.setupGracefulShutdown();
  }

  /**
   * Validates critical environment variables.
   */
  private validateEnvironment(): void {
    if (!process.env.TUGRRPRIV || !process.env.TUGRRCERT || !process.env.TUGRRINTERCERT) {
      console.warn('⚠️ SSL certificates environment variables (TUGRRPRIV, TUGRRCERT, TUGRRINTERCERT) are not fully set. HTTPS server might not start.');
    }
    console.log('✅ Environment variables validated');
  }

  /**
   * Configures the Express application.
   */
  private configureExpress(): void {
    this.expressApp.disable('x-powered-by');
    this.expressApp.use(express.json({ limit: '1mb' }));
    this.expressApp.use(express.urlencoded({ extended: true, limit: '1mb' }));

    this.expressApp.get('/', (req, res) => {
      res.status(200).send('DINA Server is running. Access API at /api/v1 or WebSocket at /dina/ws');
    });

    // The Apache config specifies /dina as the base path for DINA.
    setupAPI(this.expressApp, dinaCore, '/dina');

    console.log('✅ Express application configured');
  }

  /**
   * Loads SSL certificates.
   */
  private loadSSLCertificates(): { key: Buffer; cert: Buffer; ca: Buffer } {
    console.log('🔐 Loading SSL certificates...');
    try {
      const privateKey = fs.readFileSync(process.env.TUGRRPRIV!, 'utf8');
      const certificate = fs.readFileSync(process.env.TUGRRCERT!, 'utf8');
      const ca = fs.readFileSync(process.env.TUGRRINTERCERT!, 'utf8');
      console.log('✅ SSL certificates loaded successfully');
      return { key: Buffer.from(privateKey), cert: Buffer.from(certificate), ca: Buffer.from(ca) };
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
      process.exit(1);
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
  }

  /**
   * Starts all DINA services.
   */
  async start(): Promise<void> {
    try {
      // Initialize DINA Core first, which initializes DB, Redis, LLM, DIGIM, Mirror
      await dinaCore.initialize();

      this.configureExpress();
      this.startHttpServer();
      this.startWebSocketServer();

      const port = process.env.DINA_PORT || '8445';
      console.log('');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('   ✅ DINA SERVER ONLINE');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('');
      console.log('   Network:');
      console.log(`   🔗 HTTPS  → https://localhost:${port}/dina`);
      console.log(`   🔌 WSS    → wss://localhost:${port}/dina/ws`);
      console.log('');
      console.log('   Modules:');
      console.log('   🤖 LLM    → Multi-model AI (qwen2.5:3b, mistral:7b)');
      console.log('   🧠 DIGIM  → Intelligence Module');
      console.log('   🪞 Mirror → Data Processing + TruthStream');
      console.log('   📡 DUMP   → Universal Message Protocol');
      console.log('');
      console.log('   Capabilities:');
      console.log('   🔐 SSL/TLS encryption');
      console.log('   📊 4-priority queue system (HIGH/MED/LOW/BATCH)');
      console.log('   🔥 Model warmup (cold start prevention)');
      console.log('   💬 Streaming chat (@Dina in Mirror groups)');
      console.log('   📈 TruthStream analysis pipeline');
      console.log('   🔄 Autonomous DB monitoring & self-healing');
      console.log('   🛡️ Per-module error isolation (independent LLM instances)');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      await database.log('info', 'dina-server', 'DINA server started successfully');

    } catch (error) {
      console.error('❌ Failed to start DINA services:', error);
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
        if (this.websocketManager) {
          await this.websocketManager.shutdown();
        }

        if (this.httpsServer) {
          this.httpsServer.close();
        }

        await dinaCore.shutdown();

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
 * DINA Startup
 */
async function startDina() {
  try {
    const server = new DinaServer();
    await server.start();

  } catch (error) {
    console.error('❌ Failed to start DINA:', error);
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
startDina();
