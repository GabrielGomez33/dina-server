// DINA WebSocket Server Manager with Graceful Redis Degradation
// Located at src/config/wss/index.ts

import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { Server as HTTPSServer } from 'https';
import { v4 as uuidv4 } from 'uuid';
import { 
  DinaUniversalMessage, 
  DinaResponse, 
  DinaProtocol, 
  ConnectionState, 
  SecurityLevel, 
  createDinaMessage 
} from '../../core/protocol';
import { redisManager } from '../redis';
import { DinaLLMManager } from '../../modules/llm/manager';

interface ConnectionInfo {
  ws: WebSocket;
  state: ConnectionState;
  redisSubscribed: boolean;
  operatingMode: 'full' | 'degraded';
}

export class DinaWebSocketManager {
  private wss: WebSocketServer;
  private connections: Map<string, ConnectionInfo> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isShuttingDown: boolean = false;
  private llmManager: DinaLLMManager;

  constructor(httpsServer: HTTPSServer) {
    console.log('🔌 Initializing DINA WebSocket server with Redis resilience...');

    this.wss = new WebSocketServer({
      server: httpsServer,
      path: '/dina/ws',
      clientTracking: true,
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: true,
    });

    // Initialize LLM Manager for Mirror chat
    this.llmManager = new DinaLLMManager();
    this.llmManager.initialize().catch(err => {
      console.warn('⚠️ LLM Manager initialization failed, Mirror chat will be unavailable:', err);
    });

    this.setupServerEvents();
    this.startHeartbeat();

    console.log('✅ DINA WebSocket server (WSS) ready on /dina/ws with graceful degradation');
  }

  private setupServerEvents(): void {
    this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      this.handleNewConnection(ws, request).catch(err => {
        console.error(`❌ Critical error during new connection setup:`, err);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      });
    });

    this.wss.on('error', (error: Error) => {
      console.error('❌ WebSocket server error:', error);
    });
  }

  /**
   * ENHANCED: Handle new WebSocket connection with graceful Redis degradation
   */
  private async handleNewConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
    const connectionId = uuidv4();
    const clientIp = request.socket.remoteAddress;

    console.log(`🔗 New connection: ${connectionId} from ${clientIp}`);

    const connectionState: ConnectionState = {
      id: connectionId,
      session_id: uuidv4(),
      connected_at: new Date(),
      last_activity: new Date(),
      message_count: 0,
      is_authenticated: false
    };

    // ENHANCED: Always create connection info, try Redis but don't fail if unavailable
    let redisSubscribed = false;
    let operatingMode: 'full' | 'degraded' = 'degraded';

    // Try Redis subscription with timeout, but don't fail the connection if it doesn't work
    if (redisManager.isConnected) {
      try {
        await Promise.race([
          this.subscribeToConnectionResponses(connectionId),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Redis subscription timeout')), 5000)
          )
        ]);
        
        redisSubscribed = true;
        operatingMode = 'full';
        console.log(`✅ Connection ${connectionId} established with Redis subscription`);
        
      } catch (error) {
        console.warn(`⚠️ Redis subscription failed for ${connectionId}, continuing in degraded mode:`, error);
        // Don't fail the connection - continue without Redis
      }
    } else {
      console.log(`🔧 Redis unavailable for ${connectionId}, operating in degraded mode`);
    }

    // ALWAYS store connection info and setup handlers
    const connectionInfo: ConnectionInfo = {
      ws,
      state: connectionState,
      redisSubscribed,
      operatingMode
    };

    this.connections.set(connectionId, connectionInfo);
    this.setupConnectionEvents(ws, connectionId);

    // ALWAYS send welcome message regardless of Redis status
    this.sendWelcomeMessage(ws, connectionId, operatingMode, redisSubscribed);
  }

  private setupConnectionEvents(ws: WebSocket, connectionId: string): void {
    ws.on('message', async (data: Buffer) => {
      await this.handleIncomingMessage(ws, connectionId, data);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.handleConnectionClose(connectionId, code, reason);
    });

    ws.on('error', (error: Error) => {
      console.error(`❌ Connection error (${connectionId}):`, error);
      this.cleanupConnection(connectionId);
    });

    ws.on('pong', () => {
      this.updateConnectionActivity(connectionId);
    });
  }

  /**
   * FIXED: Handle incoming messages with proper module extraction
   */
  private async handleIncomingMessage(ws: WebSocket, connectionId: string, data: Buffer): Promise<void> {
    const connectionInfo = this.connections.get(connectionId);
    if (!connectionInfo) return;

    let dinaMessage: DinaUniversalMessage | null = null;

    try {
      const rawMessage = data.toString();
      const messageData = JSON.parse(rawMessage);

      console.log('🔍 RAW MESSAGE DATA:', {
        source: messageData.source,
        target: messageData.target,
        sourceType: typeof messageData.source,
        targetType: typeof messageData.target
      });

      this.updateConnectionActivity(connectionId);
      connectionInfo.state.message_count++;

      // ✅ EXTRACT MODULE STRINGS PROPERLY
      const sourceModule = this.extractModuleString(messageData.source, 'websocket');
      const targetModule = this.extractModuleString(messageData.target, 'core');
      const targetMethod = this.extractMethodString(messageData.target, messageData.method, 'process_data');
      const targetPriority = this.extractPriorityNumber(messageData.target, messageData.priority, 5);

      console.log('🔧 EXTRACTED VALUES:', {
        sourceModule,
        targetModule, 
        targetMethod,
        targetPriority
      });

      dinaMessage = createDinaMessage({
        source: {
          module: sourceModule,                     // ✅ Now a string
          instance: connectionId,
          version: '1.0.0'
        },
        target: {
          module: targetModule,                     // ✅ Now a string
          method: targetMethod,                     // ✅ Now a string
          priority: targetPriority                  // ✅ Now a number
        },
        payload: messageData.payload || messageData,
        qos: {
          delivery_mode: messageData.qos?.delivery_mode || 'at_least_once',
          timeout_ms: messageData.qos?.timeout_ms || 30000,
          retry_count: messageData.qos?.retry_count || 0,
          max_retries: messageData.qos?.max_retries || 3,
          require_ack: messageData.qos?.require_ack || false
        },
        security: {
          user_id: messageData.security?.user_id || connectionInfo.state.session_id,
          session_id: connectionInfo.state.session_id,
          clearance: messageData.security?.clearance || SecurityLevel.PUBLIC,
          sanitized: false
        }
      });

      console.log(`📨 Message from ${connectionId}: ${dinaMessage.target.method}`);
      console.log('✅ FINAL DINA MESSAGE STRUCTURE:', {
        sourceModule: dinaMessage.source.module,
        sourceModuleType: typeof dinaMessage.source.module,
        targetModule: dinaMessage.target.module,
        targetModuleType: typeof dinaMessage.target.module
      });

      // ENHANCED: Try Redis first, fall back to direct processing
      console.log('[WSS/index.ts]: Processing message',dinaMessage);
      await this.processMessage(ws, connectionId, dinaMessage, connectionInfo);

    } catch (parseError) {
      console.error(`❌ Error processing message from ${connectionId}:`, parseError);

      const errorResponse: DinaResponse = {
        request_id: dinaMessage?.id || 'unknown',
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        status: 'error',
        error: {
          code: 'MESSAGE_PARSE_ERROR',
          message: parseError instanceof Error ? parseError.message : 'Failed to parse message'
        },
        payload: { data: null },
        metrics: { processing_time_ms: 0 }
      };

      this.sendResponse(ws, errorResponse);
    }
  }

  /**
   * NEW: Extract module string from source/target object or use fallback
   */
  private extractModuleString(moduleData: any, fallback: string): string {
    // If moduleData is already a string, use it
    if (typeof moduleData === 'string') {
      return moduleData;
    }
    
    // If moduleData is an object with a module property, extract it
    if (moduleData && typeof moduleData === 'object' && typeof moduleData.module === 'string') {
      console.log(`🔧 Extracting module from object: ${JSON.stringify(moduleData)} → "${moduleData.module}"`);
      return moduleData.module;
    }
    
    // Use fallback
    console.log(`🔧 Using fallback module: "${fallback}"`);
    return fallback;
  }

  /**
   * NEW: Extract method string from target object or message root
   */
  private extractMethodString(targetData: any, rootMethod: any, fallback: string): string {
    // Check root method first
    if (typeof rootMethod === 'string') {
      return rootMethod;
    }
    
    // Check target.method
    if (targetData && typeof targetData === 'object' && typeof targetData.method === 'string') {
      return targetData.method;
    }
    
    // Use fallback
    return fallback;
  }

  /**
   * NEW: Extract priority number from target object or message root
   */
  private extractPriorityNumber(targetData: any, rootPriority: any, fallback: number): number {
    // Check root priority first
    if (typeof rootPriority === 'number') {
      return rootPriority;
    }
    
    // Check target.priority
    if (targetData && typeof targetData === 'object' && typeof targetData.priority === 'number') {
      return targetData.priority;
    }
    
    // Use fallback
    return fallback;
  }

  /**
   * NEW: Process message with Redis fallback
   */
  private async processMessage(
    ws: WebSocket,
    connectionId: string,
    dinaMessage: DinaUniversalMessage,
    connectionInfo: ConnectionInfo
  ): Promise<void> {
    // Try Redis if available and subscribed
    if (redisManager.isConnected && connectionInfo.redisSubscribed) {
      console.log('[WSS/index.ts]: RedisManager is connected and subscribed to...Queueing message.');
      try {
        await redisManager.enqueueMessage(dinaMessage);
		console.log('[WSS/index.ts/processMessage()]: CONTENTS OF dinaMessage.qos', dinaMessage.qos);
        if (dinaMessage.qos.require_ack) {
          const ack: DinaResponse = {
            request_id: dinaMessage.id,
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            status: 'queued',
            payload: { data: { message: 'Message queued for processing' } },
            metrics: { processing_time_ms: 0 }
          };
          this.sendResponse(ws, ack);
        }
        return; // Success with Redis

      } catch (redisError) {
        console.warn(`⚠️ Redis enqueue failed for ${connectionId}, falling back to direct processing`);
        // Mark Redis as disconnected and fall through to direct processing
        redisManager.isConnected = false;
        connectionInfo.redisSubscribed = false;
        connectionInfo.operatingMode = 'degraded';
      }
    }

    // FALLBACK: Process message directly without Redis
    await this.processMessageDirectly(ws, connectionId, dinaMessage);
  }

  /**
   * NEW: Direct message processing without Redis
   */
  private async processMessageDirectly(
    ws: WebSocket, 
    connectionId: string, 
    dinaMessage: DinaUniversalMessage
  ): Promise<void> {
    console.log(`🔧 Processing message directly for ${connectionId} (Redis unavailable)`);
    
    // Handle basic commands directly
    if (dinaMessage.target.module === 'core' && dinaMessage.target.method === 'ping') {
      const response: DinaResponse = {
        request_id: dinaMessage.id,
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        status: 'success',
        payload: {
          data: {
            message: 'DINA Core Pong! (Direct Mode)',
            timestamp: new Date().toISOString()
          }
        },
        metrics: { processing_time_ms: 5 }
      };
      
      this.sendResponse(ws, response);
      return;
    }

    // For system stats
    if (dinaMessage.target.module === 'core' && dinaMessage.target.method === 'system_stats') {
      const response: DinaResponse = {
        request_id: dinaMessage.id,
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        status: 'success',
        payload: {
          data: {
            system_status: 'degraded',
            redis_available: false,
            active_connections: this.connections.size,
            uptime: process.uptime()
          }
        },
        metrics: { processing_time_ms: 1 }
      };
      
      this.sendResponse(ws, response);
      return;
    }

    // Handle Mirror chat in degraded mode (fallback when Redis unavailable)
    if (dinaMessage.target.method === 'mirror_chat_stream' || dinaMessage.target.method === 'mirror_chat') {
      await this.handleMirrorChatStream(ws, connectionId, dinaMessage);
      return;
    }

    // For other messages, send a degraded service response
    const response: DinaResponse = {
      request_id: dinaMessage.id,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      status: 'error',
      error: {
        code: 'SERVICE_DEGRADED',
        message: 'Service is running in degraded mode. Some features may be limited. Please try again later.'
      },
      payload: { data: null },
      metrics: { processing_time_ms: 0 }
    };

    this.sendResponse(ws, response);
  }

  /**
   * Handle Mirror @Dina chat requests with streaming response (fallback for degraded mode)
   */
  private async handleMirrorChatStream(
    ws: WebSocket,
    connectionId: string,
    message: DinaUniversalMessage
  ): Promise<void> {
    const requestId = message.id;
    const payload = message.payload?.data || message.payload;
    const query = payload?.query || payload?.message;
    const context = payload?.context;
    const options = payload?.options || {};

    console.log(`🤖 Mirror chat request from ${connectionId}: "${query?.substring(0, 50)}..."`);

    if (!query) {
      this.sendResponse(ws, {
        request_id: requestId,
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        status: 'error',
        error: { code: 'INVALID_REQUEST', message: 'Missing query in chat request' },
        payload: { data: null },
        metrics: { processing_time_ms: 0 }
      });
      return;
    }

    if (!this.llmManager.isInitialized) {
      this.sendResponse(ws, {
        request_id: requestId,
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        status: 'error',
        error: { code: 'LLM_UNAVAILABLE', message: 'LLM service is not available' },
        payload: { data: null },
        metrics: { processing_time_ms: 0 }
      });
      return;
    }

    try {
      let chunkIndex = 0;
      const startTime = Date.now();

      for await (const chunk of this.llmManager.generateStream(query, {
        model: options.model || 'mistral:7b',
        maxTokens: options.maxTokens || 1000,
        temperature: options.temperature || 0.7,
        context: typeof context === 'string' ? context : JSON.stringify(context)
      })) {
        if (ws.readyState !== WebSocket.OPEN) {
          console.warn(`⚠️ WebSocket closed during streaming for ${connectionId}`);
          break;
        }

        ws.send(JSON.stringify({
          type: 'chunk',
          request_id: requestId,
          chunk_index: chunkIndex++,
          content: chunk.content,
          done: chunk.done,
          timestamp: new Date().toISOString()
        }));

        if (chunk.done) {
          this.sendResponse(ws, {
            request_id: requestId,
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            status: 'success',
            payload: {
              data: {
                type: 'complete',
                total_chunks: chunkIndex,
                processing_time_ms: Date.now() - startTime
              }
            },
            metrics: { processing_time_ms: Date.now() - startTime }
          });
        }
      }

      console.log(`✅ Mirror chat stream completed for ${connectionId}: ${chunkIndex} chunks`);

    } catch (error) {
      console.error(`❌ Mirror chat stream error for ${connectionId}:`, error);
      this.sendResponse(ws, {
        request_id: requestId,
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        status: 'error',
        error: {
          code: 'STREAM_ERROR',
          message: error instanceof Error ? error.message : 'Stream processing failed'
        },
        payload: { data: null },
        metrics: { processing_time_ms: 0 }
      });
    }
  }

  private async subscribeToConnectionResponses(connectionId: string): Promise<void> {
    await redisManager.subscribeToResponses(connectionId, (response: DinaResponse) => {
      const connectionInfo = this.connections.get(connectionId);
      if (connectionInfo && connectionInfo.ws.readyState === WebSocket.OPEN) {
        this.sendResponse(connectionInfo.ws, response);
      }
    });
  }

  private sendResponse(ws: WebSocket, response: DinaResponse): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(response));
        console.log(`📤 Response sent: ${response.id} (${response.status})`);
      } catch (error) {
        console.error('❌ Failed to send response:', error);
      }
    }
  }

  /**
   * ENHANCED: Send welcome message with operating mode info
   */
  private sendWelcomeMessage(
    ws: WebSocket, 
    connectionId: string, 
    operatingMode: 'full' | 'degraded',
    redisEnabled: boolean
  ): void {
    const welcome: DinaResponse = {
      request_id: 'connection',
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      status: 'success',
      payload: {
        data: {
          message: 'Welcome to DINA. A Distributed Intelligient Neural Architect',
          connection_id: connectionId,
          capabilities: ['ping', 'echo', 'chat', 'system_stats'],
          system_status: 'online',
          operating_mode: operatingMode,
          redis_enabled: redisEnabled,
          note: operatingMode === 'degraded' ? 'Some features may be limited in degraded mode' : undefined
        }
      },
      metrics: { processing_time_ms: 0 }
    };

    this.sendResponse(ws, welcome);
  }

  private handleConnectionClose(connectionId: string, code: number, reason: Buffer): void {
    const connectionInfo = this.connections.get(connectionId);
    const duration = connectionInfo
      ? Date.now() - connectionInfo.state.connected_at.getTime()
      : 0;

    console.log(`🔌 Connection closed: ${connectionId} (${code}) after ${duration}ms`);

    // Clean up Redis subscription if it was established
    if (connectionInfo?.redisSubscribed && redisManager.isConnected) {
      redisManager.unsubscribeFromResponses(connectionId).catch(err => {
        console.error(`❌ Error unsubscribing from Redis for ${connectionId}:`, err);
      });
    } else {
      console.log(`🚫 Skipping Redis unsubscribe for ${connectionId}: Redis is disconnected.`);
    }

    this.cleanupConnection(connectionId);
  }

  private cleanupConnection(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  private updateConnectionActivity(connectionId: string): void {
    const connectionInfo = this.connections.get(connectionId);
    if (connectionInfo) {
      connectionInfo.state.last_activity = new Date();
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.isShuttingDown) return;

      let active = 0;
      let dead = 0;
      const now = Date.now();

      this.connections.forEach((connectionInfo, connectionId) => {
        const timeSinceActivity = now - connectionInfo.state.last_activity.getTime();

        if (timeSinceActivity > 60000) { // 1 minute timeout
          connectionInfo.ws.terminate();
          this.cleanupConnection(connectionId);
          dead++;
        } else if (connectionInfo.ws.readyState === WebSocket.OPEN) {
          connectionInfo.ws.ping();
          active++;
        }
      });

      if (active > 0 || dead > 0) {
        console.log(`💓 Heartbeat: ${active} active, ${dead} cleaned`);
      }
    }, 30000);
  }

  /**
   * ENHANCED: Get statistics with operating mode info
   */
  getStats(): any {
    const connections = Array.from(this.connections.values());
    const activeConnections = connections.filter(info => info.ws.readyState === WebSocket.OPEN);
    const fullModeConnections = activeConnections.filter(info => info.operatingMode === 'full');
    const degradedModeConnections = activeConnections.filter(info => info.operatingMode === 'degraded');

    return {
      total_connections: this.connections.size,
      active_connections: activeConnections.length,
      full_mode_connections: fullModeConnections.length,
      degraded_mode_connections: degradedModeConnections.length,
      redis_available: redisManager.isConnected,
      total_messages: connections.reduce((sum, info) => sum + info.state.message_count, 0),
      websocket_path: '/dina/ws'
    };
  }

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down WebSocket server...');
    this.isShuttingDown = true;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.connections.forEach((connectionInfo) => {
      if (connectionInfo.ws.readyState === WebSocket.OPEN) {
        connectionInfo.ws.close(1001, 'Server shutting down');
      }
    });

    this.wss.close();
    this.connections.clear();

    console.log('✅ WebSocket server shutdown complete');
  }
}
