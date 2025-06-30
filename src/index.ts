// DINA Server Entry Point
import express from 'express';
import dotenv from 'dotenv';
import { DinaCore } from './core/orchestrator';
import { setupAPI } from './api/routes';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

async function startDina(): Promise<void> {
  try {
    console.log('🚀 Starting DINA Server...');
    
    // Initialize DINA Core
    const dina = new DinaCore();
    await dina.initialize();
    
    // Setup API routes
    setupAPI(app, dina);
    
    // Start server
    app.listen(PORT, () => {
      console.log(`🧠 DINA Server running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
    });
    
  } catch (error) {
    console.error('❌ Failed to start DINA:', error);
    process.exit(1);
  }
}

startDina();
