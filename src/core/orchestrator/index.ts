// DINA Core Orchestrator with Database Integration
import { DinaMessage, DinaResponse } from '../../types';
import { database } from '../../config/database/db';

export class DinaCore {
  private initialized: boolean = false;
  private modules: Map<string, any> = new Map();
  private requestCount: number = 0;

  async initialize(): Promise<void> {
    console.log('🧠 Initializing DINA Core Orchestrator...');
    
    try {
      // Initialize database connection
      await database.initialize();
      await database.log('info', 'dina-core', 'DINA Core initialization started');
      
      // TODO: Initialize Redis connection
      console.log('🔴 Redis connection - pending implementation');
      
      // TODO: Initialize LLM services
      console.log('🤖 Local LLM initialization - pending implementation');
      
      this.initialized = true;
      await database.log('info', 'dina-core', 'DINA Core initialized successfully');
      console.log('✅ DINA Core initialized successfully');
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await database.log('error', 'dina-core', 'DINA Core initialization failed', { error: errorMessage });
      console.error('❌ DINA Core initialization failed:', error);
      throw error;
    }
  }
  
  async processMessage(message: any): Promise<DinaResponse> {
    if (!this.initialized) {
      throw new Error('DINA Core not initialized');
    }

    const startTime = Date.now();
    const messageId = message.id || this.generateId();
    this.requestCount++;

    console.log(`📨 Processing message: ${messageId}`);

    try {
      // Log the incoming request
      const requestId = await database.logRequest({
        source: message.source || 'unknown',
        target: message.target || 'dina',
        method: message.method || 'unknown',
        payload: message,
        priority: message.priority || 5
      });

      // Process the message
      const result = await this.handleMessage(message);
      
      // Calculate processing time
      const processingTime = Date.now() - startTime;
      
      // Create response
      const response: DinaResponse = {
        id: messageId,
        timestamp: new Date().toISOString(),
        status: 'processed',
        result: {
          message: 'DINA Core processed message successfully',
          processed_by: 'dina-orchestrator',
          processing_time_ms: processingTime,
          request_count: this.requestCount,
          modules_available: Array.from(this.modules.keys()),
          original_message: message
        }
      };

      // Update request status in database
      await database.updateRequestStatus(requestId, 'completed', response, processingTime);
      
      // Log successful processing
      await database.log('info', 'dina-core', `Message processed successfully: ${messageId}`, {
        processing_time_ms: processingTime,
        target: message.target
      });

      return response;
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Log the error
      await database.log('error', 'dina-core', `Message processing failed: ${messageId}`, {
        error: errorMessage,
        processing_time_ms: processingTime
      });

      // Return error response
      const errorResponse: DinaResponse = {
        id: messageId,
        timestamp: new Date().toISOString(),
        status: 'failed',
        error: errorMessage
      };

      return errorResponse;
    }
  }

  private async handleMessage(message: any): Promise<any> {
    // Basic message routing logic
    const { target, method } = message;

    switch (target) {
      case 'dina':
        return await this.handleInternalMessage(message);
      case 'mirror':
        return await this.routeToMirrorModule(message);
      case 'system':
        return await this.handleSystemMessage(message);
      default:
        throw new Error(`Unknown target module: ${target}`);
    }
  }

  private async handleInternalMessage(message: any): Promise<any> {
    const { method } = message;

    switch (method) {
      case 'ping':
        return { pong: true, timestamp: new Date().toISOString() };
      
      case 'status':
        return await this.getSystemStatus();
      
      case 'stats':
        return await this.getSystemStats();
      
      default:
        return {
          message: 'DINA Core received message',
          available_methods: ['ping', 'status', 'stats'],
          received_method: method
        };
    }
  }

  private async routeToMirrorModule(message: any): Promise<any> {
    // TODO: Implement MirrorModule routing
    return {
      message: 'MirrorModule not yet implemented',
      target: 'mirror',
      status: 'pending_implementation'
    };
  }

  private async handleSystemMessage(message: any): Promise<any> {
    const { method } = message;

    switch (method) {
      case 'health':
        const dbStatus = await database.getConnectionStatus();
        return {
          system: 'healthy',
          database: dbStatus.connected ? 'connected' : 'disconnected',
          uptime: process.uptime(),
          memory: process.memoryUsage()
        };
      
      default:
        return { message: 'System module active', method };
    }
  }

  async getSystemStatus(): Promise<Record<string, any>> {
    const dbStatus = await database.getConnectionStatus();
    
    return {
      'dina-core': this.initialized ? 'active' : 'inactive',
      'database': dbStatus.connected ? 'connected' : 'disconnected',
      'mirror-module': 'pending',
      'redis': 'pending',
      'llm': 'pending',
      'request-count': this.requestCount,
      'uptime-seconds': Math.floor(process.uptime()),
      'memory-usage': process.memoryUsage()
    };
  }

  async getSystemStats(): Promise<Record<string, any>> {
    // Get recent request stats from database
    const recentRequests = await database.query(`
      SELECT 
        status,
        COUNT(*) as count,
        AVG(processing_time_ms) as avg_processing_time
      FROM dina_requests 
      WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
      GROUP BY status
    `);

    return {
      recent_requests: recentRequests,
      total_requests: this.requestCount,
      system_uptime: process.uptime(),
      memory_usage: process.memoryUsage(),
      node_version: process.version
    };
  }

  getModuleStatus(): Record<string, string> {
    return {
      'dina-core': this.initialized ? 'active' : 'inactive',
      'database': 'active', // Will be checked in real-time
      'mirror-module': 'pending',
      'redis': 'pending',
      'llm': 'pending'
    };
  }
  
  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down DINA Core...');
    await database.log('info', 'dina-core', 'DINA Core shutdown initiated');
    
    // Close database connections
    await database.close();
    
    this.initialized = false;
    console.log('✅ DINA Core shutdown complete');
  }
}

