// DINA WebSocket Server Manager
// Located at src/config/wss/index.ts

import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { Server as HTTPSServer } from 'https';
import { v4 as uuidv4 } from 'uuid';
import { DinaUniversalMessage, DinaResponse, DinaProtocol, ConnectionState } from '../../core/protocol';
import { redisManager } from '../redis';

export class DinaWebSocketManager {
  private wss: WebSocketServer;
  private connections: Map<string, WebSocket> = new Map();
  private connectionStates: Map<string, ConnectionState> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isShuttingDown: boolean = false;

  constructor(httpsServer: HTTPSServer) {
    console.log('🔌 Initializing DINA WebSocket server...');
    
    // Create WebSocket server attached to HTTPS server
    this.wss = new WebSocketServer({ 
      server: httpsServer,
      path: '/dina/ws',                  // WebSocket endpoint
      clientTracking: true,
      maxPayload: 16 * 1024 * 1024,      // 16MB max message size
      perMessageDeflate: true,            // Enable compression
    });

    this.setupServerEvents();
    this.startHeartbeat();
    
    console.log('✅ DINA WebSocket server (WSS) ready on /dina/ws');
  }

  /**
   * Setup WebSocket server event handlers
   */
  private setupServerEvents(): void {
    this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      this.handleNewConnection(ws, request);
    });

    this.wss.on('error', (error: Error) => {
      console.error('❌ WebSocket server error:', error);
    });
  }

  /**
   * Handle new WebSocket connection
   */
  private handleNewConnection(ws: WebSocket, request: IncomingMessage): void {
    const connectionId = uuidv4();
    const clientIp = request.socket.remoteAddress;
    
    console.log(`🔗 New connection: ${connectionId} from ${clientIp}`);

    // Store connection
    this.connections.set(connectionId, ws);
    
    // Create connection state
    const connectionState: ConnectionState = {
      id: connectionId,
      session_id: uuidv4(),
      connected_at: new Date(),
      last_activity: new Date(),
      message_count: 0,
      is_authenticated: false
    };
    this.connectionStates.set(connectionId, connectionState);

    // Setup connection events
    this.setupConnectionEvents(ws, connectionId);

    // Subscribe to Redis responses
    this.subscribeToConnectionResponses(connectionId);

    // Send welcome message
    this.sendWelcomeMessage(ws, connectionId);
  }

  /**
   * Setup event handlers for a specific connection
   */
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
   * Handle incoming message from client
   */
  private async handleIncomingMessage(ws: WebSocket, connectionId: string, data: Buffer): Promise<void> {
    const connectionState = this.connectionStates.get(connectionId);
    if (!connectionState) return;

    try {
      const rawMessage = data.toString();
      const messageData = JSON.parse(rawMessage);

      // Update activity
      this.updateConnectionActivity(connectionId);
      connectionState.message_count++;

      // Convert to DINA message format
      let dinaMessage: DinaUniversalMessage;
      
      if (DinaProtocol.validateMessage(messageData)) {
        dinaMessage = messageData;
      } else {
        dinaMessage = this.convertToDigmessage(messageData, connectionId);
      }

      // Add connection context
      dinaMessage.source.instance = connectionId;
      dinaMessage.security.session_id = connectionState.session_id;
      dinaMessage = DinaProtocol.sanitizeMessage(dinaMessage);

      console.log(`📨 Message from ${connectionId}: ${dinaMessage.target.method}`);

      // Queue for processing
      await redisManager.enqueueMessage(dinaMessage);

      // Send acknowledgment if requested
      if (dinaMessage.qos.require_ack) {
        const ack: DinaResponse = {
          request_id: dinaMessage.id,
          id: uuidv4(),
          timestamp: new Date().toISOString(),
          status: 'queued',
          result: { message: 'Message queued for processing' },
          metrics: { processing_time_ms: 0 }
        };
        this.sendResponse(ws, ack);
      }

    } catch (error) {
      console.error(`❌ Error processing message from ${connectionId}:`, error);
      
      const errorResponse: DinaResponse = {
        request_id: 'unknown',
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        status: 'error',
        error: {
          code: 'MESSAGE_PARSE_ERROR',
          message: error instanceof Error ? error.message : 'Failed to parse message'
        },
        metrics: { processing_time_ms: 0 }
      };
      
      this.sendResponse(ws, errorResponse);
    }
  }

  /**
   * Convert simple message to DINA format
   */
  private convertToDigmessage(messageData: any, connectionId: string): DinaUniversalMessage {
    const method = messageData.method || messageData.action || 'chat';
    const data = messageData.data || messageData.message || messageData.prompt || messageData;
    
    return DinaProtocol.createMessage(
      'websocket',
      'core',
      method,
      data,
      {
        source: { 
          module: 'websocket',
          instance: connectionId,
          version: '1.0.0'
        },
        target: { 
          module: 'core',
          method: method,
          priority: messageData.priority || 5 
        },
        qos: {
          timeout_ms: messageData.timeout || 30000,
          retry_count: 0,
          max_retries: 3,
          require_ack: messageData.require_ack || false
        }
      }
    );
  }

  /**
   * Subscribe to Redis responses for this connection
   */
  private async subscribeToConnectionResponses(connectionId: string): Promise<void> {
    await redisManager.subscribeToResponses(connectionId, (response: DinaResponse) => {
      const ws = this.connections.get(connectionId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        this.sendResponse(ws, response);
      }
    });
  }

  /**
   * Send response to client
   */
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
   * Send welcome message
   */
  private sendWelcomeMessage(ws: WebSocket, connectionId: string): void {
    const welcome: DinaResponse = {
      request_id: 'connection',
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      status: 'success',
      result: {
        message: 'Welcome to DINA Phase 1!',
        connection_id: connectionId,
        capabilities: ['ping', 'echo', 'chat', 'system_stats'],
        system_status: 'online'
      },
      metrics: { processing_time_ms: 0 }
    };
    
    this.sendResponse(ws, welcome);
  }

  /**
   * Handle connection close
   */
  private handleConnectionClose(connectionId: string, code: number, reason: Buffer): void {
    const connectionState = this.connectionStates.get(connectionId);
    const duration = connectionState 
      ? Date.now() - connectionState.connected_at.getTime()
      : 0;
    
    console.log(`🔌 Connection closed: ${connectionId} (${code}) after ${duration}ms`);
    this.cleanupConnection(connectionId);
  }

  /**
   * Clean up connection
   */
  private cleanupConnection(connectionId: string): void {
    this.connections.delete(connectionId);
    this.connectionStates.delete(connectionId);
  }

  /**
   * Update connection activity
   */
  private updateConnectionActivity(connectionId: string): void {
    const connectionState = this.connectionStates.get(connectionId);
    if (connectionState) {
      connectionState.last_activity = new Date();
    }
  }

  /**
   * Start heartbeat
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.isShuttingDown) return;
      
      let active = 0;
      let dead = 0;
      const now = Date.now();

      this.connections.forEach((ws, connectionId) => {
        const state = this.connectionStates.get(connectionId);
        if (!state) {
          this.cleanupConnection(connectionId);
          return;
        }

        const timeSinceActivity = now - state.last_activity.getTime();
        
        if (timeSinceActivity > 60000) { // 1 minute timeout
          ws.terminate();
          this.cleanupConnection(connectionId);
          dead++;
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
          active++;
        }
      });

      if (active > 0 || dead > 0) {
        console.log(`💓 Heartbeat: ${active} active, ${dead} cleaned`);
      }
    }, 30000);
  }

  /**
   * Get statistics
   */
  getStats(): any {
    return {
      total_connections: this.connections.size,
      active_connections: Array.from(this.connections.values())
        .filter(ws => ws.readyState === WebSocket.OPEN).length,
      total_messages: Array.from(this.connectionStates.values())
        .reduce((sum, state) => sum + state.message_count, 0),
      websocket_path: '/dina/ws'
    };
  }

  /**
   * Shutdown
   */
  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down WebSocket server...');
    this.isShuttingDown = true;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Close all connections
    this.connections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, 'Server shutting down');
      }
    });

    this.wss.close();
    this.connections.clear();
    this.connectionStates.clear();
    
    console.log('✅ WebSocket server shutdown complete');
  }
}
