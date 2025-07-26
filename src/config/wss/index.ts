// DINA WebSocket Server Manager
// Located at src/config/wss/index.ts

import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { Server as HTTPSServer } from 'https';
import { v4 as uuidv4 } from 'uuid';
import { DinaUniversalMessage, DinaResponse, DinaProtocol, ConnectionState, SecurityLevel, createDinaMessage } from '../../core/protocol'; // Import createDinaMessage
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
      // Asynchronously handle the new connection and add a top-level catch
      // to prevent any unhandled rejections from crashing the server.
      this.handleNewConnection(ws, request).catch(err => {
          console.error(`❌ Critical error during new connection setup:`, err);
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.terminate(); // Force-close the connection on unexpected failure
          }
      });
    });

    this.wss.on('error', (error: Error) => {
      console.error('❌ WebSocket server error:', error);
    });
  }

  /**
   * Handle new WebSocket connection
   */
  private async handleNewConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
      const connectionId = uuidv4();
      const clientIp = request.socket.remoteAddress;
      
      console.log(`🔗 New connection: ${connectionId} from ${clientIp}`);
  
      this.connections.set(connectionId, ws);
      
      const connectionState: ConnectionState = {
        id: connectionId,
        session_id: uuidv4(),
        connected_at: new Date(),
        last_activity: new Date(),
        message_count: 0,
        is_authenticated: false
      };
      this.connectionStates.set(connectionId, connectionState);
  
      this.setupConnectionEvents(ws, connectionId);
  
      try {
        // Await the Redis subscription. This is the critical step.
        await this.subscribeToConnectionResponses(connectionId);
  
        // If the subscription is successful, welcome the client.
        this.sendWelcomeMessage(ws, connectionId);
  
      } catch (error) {
        // If Redis subscription fails, catch the error and handle it gracefully.
        console.error(`❌ FATAL: Failed to subscribe connection ${connectionId} to Redis. Rejecting connection.`, error);
        
        const errorResponse: DinaResponse = {
          request_id: 'connection',
          id: uuidv4(),
          timestamp: new Date().toISOString(),
          status: 'error',
          error: {
            code: 'SERVER_UNAVAILABLE',
            message: 'Backend service is temporarily unavailable. Please try reconnecting.'
          },
          payload: { data: null },
          metrics: { processing_time_ms: 0 }
        };
        
        // Attempt to send a final error message to the client before closing.
        if (ws.readyState === WebSocket.OPEN) {
          this.sendResponse(ws, errorResponse);
        }
  
        // Close the connection with a specific code and reason.
        ws.close(1011, 'Server setup failed due to an internal error.');
        
        // Ensure resources are released.
        this.cleanupConnection(connectionId);
      }
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
  
      // Define message variable here to access it in different catch blocks
      let dinaMessage: DinaUniversalMessage | null = null;
  
      try {
        const rawMessage = data.toString();
        const messageData = JSON.parse(rawMessage);
  
        this.updateConnectionActivity(connectionId);
        connectionState.message_count++;
  
        // Create the DINA message
        dinaMessage = createDinaMessage({
          // FIX: Re-populated the full object structure from the original code
          source: {
            module: messageData.source || 'websocket',
            instance: connectionId,
            version: '1.0.0'
          },
          target: {
            module: messageData.target || 'core',
            method: messageData.method || 'process_data',
            priority: messageData.priority || 5
          },
          qos: {
            delivery_mode: messageData.qos?.delivery_mode || 'at_least_once',
            timeout_ms: messageData.qos?.timeout_ms || 30000,
            retry_count: messageData.qos?.retry_count || 0,
            max_retries: messageData.qos?.max_retries || 3,
            require_ack: messageData.qos?.require_ack || false
          },
          security: {
            user_id: messageData.security?.user_id || connectionState.session_id,
            session_id: connectionState.session_id,
            clearance: messageData.security?.clearance || SecurityLevel.PUBLIC,
            sanitized: false
          },
          payload: {
            data: messageData.payload || messageData
          }
        });
  
        console.log(`📨 Message from ${connectionId}: ${dinaMessage.target.method}`);
  
        // --- New try/catch block specifically for Redis operations ---
        try {
          await redisManager.enqueueMessage(dinaMessage);
  
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
        } catch (redisError) {
          console.error(`❌ Redis Error: Failed to enqueue message for ${connectionId}.`, redisError);
          const errorResponse: DinaResponse = {
            request_id: dinaMessage.id,
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            status: 'error',
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Message could not be processed. Backend service is temporarily unavailable.'
            },
            payload: { data: null },
            metrics: { processing_time_ms: 0 }
          };
          this.sendResponse(ws, errorResponse);
        }
        // --- End of new try/catch block ---
  
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
      payload: { // Use payload.data
        data: {
          message: 'Welcome to DINA Phase 1!',
          connection_id: connectionId,
          capabilities: ['ping', 'echo', 'chat', 'system_stats'],
          system_status: 'online'
        }
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
    
        // FIX: Changed redisManager.isConnected() to redisManager.isConnected
        // Access it as a property, not a method.
        if (redisManager.isConnected) {
          redisManager.unsubscribeFromResponses(connectionId).catch(err => {
            console.error(`❌ Error unsubscribing from Redis for ${connectionId}:`, err);
          });
        } else {
            console.log(`🚫 Skipping Redis unsubscribe for ${connectionId}: Redis is disconnected.`);
        }
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
