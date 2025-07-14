// Load environment variables FIRST - before any other imports
import dotenv from 'dotenv';
dotenv.config();

// Debug environment variables
console.log('🔍 Environment Variables Check:');
console.log('DB_HOST:', process.env.DB_HOST || 'NOT SET');
console.log('DB_USER:', process.env.DB_USER || 'NOT SET');
console.log('DB_PASSWORD:', process.env.DB_PASSWORD ? '***SET***' : 'NOT SET');
console.log('DB_NAME:', process.env.DB_NAME || 'NOT SET');

// Now import your application modules
import express from 'express';
import { DinaCore } from './core/orchestrator';
import { setupAPI } from './api/routes';

const app = express();
const PORT = process.env.PORT || 3000;
const basePath = process.env.BASE_PATH || '';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function startDina() {
  try {
    console.log('🚀 Starting DINA Server...');
    console.log(`🌍 Domain: ${process.env.DOMAIN || 'localhost'}`);
    console.log(`📂 Base Path: ${basePath}`);

    // Initialize DINA Core
    const dina = new DinaCore();
    await dina.initialize();

    // Setup API routes
    setupAPI(app, dina, basePath);

    // Basic frontend route
    app.get(basePath || '/', (req, res) => {
      res.json({
        name: 'DINA Server',
        description: 'Distributed Intelligence Neural Architect',
        version: '1.0.0',
        api: `${req.protocol}://${req.get('host')}${basePath}/api/v1`,
        status: 'operational',
        timestamp: new Date().toISOString()
      });
    });

    // Catch-all error handler
    app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      console.error('❌ Unhandled error:', err);
      res.status(500).json({
        error: 'Internal server error',
        message: err.message,
        timestamp: new Date().toISOString()
      });
    });

    // Start server
    app.listen(PORT, () => {
      console.log(`✅ DINA Server running on port ${PORT}`);
      console.log(`🔗 API available at: http://localhost:${PORT}${basePath}/api/v1`);
      console.log(`🏠 Home available at: http://localhost:${PORT}${basePath}`);
    });

  } catch (error) {
    console.error('❌ Failed to start DINA:', error);
    process.exit(1);
  }
}

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down DINA Server...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down DINA Server...');
  process.exit(0);
});

// Start the application
startDina();
