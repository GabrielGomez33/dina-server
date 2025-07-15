// DINA Redis Connection Manager
// Handles message queuing for high-performance processing

import { createClient, RedisClientType } from 'redis';
// Ensure DinaUniversalMessage and DinaResponse are imported from the correct protocol file
import { DinaUniversalMessage, DinaResponse, QUEUE_NAMES } from '../core/protocol'; 

export class DinaRedisManager {
  private client: RedisClientType;
  private publisher: RedisClientType;
  private subscriber: RedisClientType;
  public isConnected: boolean = false; // Made public for easier external health checks
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;

  constructor() {
    // Create Redis clients with proper v5 syntax
    this.client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 50, 500)
      }
    });

    // Separate clients for pub/sub (Redis best practice)
    this.publisher = this.client.duplicate();
    this.subscriber = this.client.duplicate();

    this.setupErrorHandling();
  }

  /**
   * Initialize Redis connection and setup queues
   */
  async initialize(): Promise<void> {
    console.log('📬 Initializing Redis message queue system...');

    try {
      // Connect all clients
      await Promise.all([
        this.client.connect(),
        this.publisher.connect(), 
        this.subscriber.connect()
      ]);

      // Setup queues
      await this.setupQueues();
      
      // Start monitoring
      this.startQueueMonitoring();

      this.isConnected = true;
      console.log('✅ Redis message queue system online');

    } catch (error) {
      console.error('❌ Redis initialization failed:', error);
      this.isConnected = false; // Ensure connection status is false on failure
      throw error;
    }
  }

  /**
   * Add a message to the appropriate priority queue
   */
  async enqueueMessage(message: DinaUniversalMessage): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Redis not connected. Please call initialize() first.');
    }

    try {
      // Determine which queue based on priority
      const queueName = this.getQueueName(message);
      
      // Add timestamp for queue time tracking (using a new type for the queued message)
      // This is an internal detail, so we'll use a type assertion or a local interface
      interface QueuedDinaUniversalMessage extends DinaUniversalMessage {
        queued_at?: number;
      }

      const queuedMessage: QueuedDinaUniversalMessage = {
        ...message,
        queued_at: Date.now()
      };

      // Push to queue (RPUSH = add to end, LPOP = remove from beginning = FIFO)
      await this.client.rPush(queueName, JSON.stringify(queuedMessage));

      console.log(`📨 Message queued: ${message.id} → ${queueName}`);

    } catch (error) {
      console.error('❌ Failed to enqueue message:', error);
      throw error;
    }
  }

  /**
   * Get the next message from a specific queue
   */
  async dequeueMessage(queueName: string, timeoutSeconds: number = 1): Promise<DinaUniversalMessage | null> {
    if (!this.isConnected) {
      throw new Error('Redis not connected. Please call initialize() first.');
    }

    try {
      // BLPOP = blocking left pop (waits for message if queue empty)
      const result = await this.client.blPop(queueName, timeoutSeconds);
      
      if (!result) {
        return null; // Timeout, no message available
      }

      // Parse message and add queue time to trace
      const message: DinaUniversalMessage = JSON.parse(result.element);
      
      // Calculate queue time and assign directly to trace.queue_time_ms
      // No 'any' cast needed if DinaUniversalMessage correctly defines trace.queue_time_ms
      if (typeof (message as any).queued_at === 'number') {
        const queueTime = Date.now() - (message as any).queued_at;
        if (message.trace) { // Ensure trace exists
          message.trace.queue_time_ms = queueTime;
        }
      }

      console.log(`📤 Message dequeued: ${message.id} (waited ${message.trace?.queue_time_ms || 'N/A'}ms)`);
      
      return message;

    } catch (error) {
      console.error('❌ Failed to dequeue message:', error);
      return null;
    }
  }

  /**
   * Process messages from multiple queues with priority ordering
   */
  async processQueues(messageHandler: (message: DinaUniversalMessage) => Promise<DinaResponse>): Promise<void> {
    console.log('🔄 Starting queue processors...');

    // Process each queue with different intervals (higher priority = more frequent)
    // Pass a reference to `this` to ensure `getQueueName` is callable within the class context
    this.processQueue(QUEUE_NAMES.HIGH, messageHandler, 10);    // Check every 10ms
    this.processQueue(QUEUE_NAMES.MEDIUM, messageHandler, 50);  // Check every 50ms
    this.processQueue(QUEUE_NAMES.LOW, messageHandler, 200);    // Check every 200ms
    this.processQueue(QUEUE_NAMES.BATCH, messageHandler, 1000); // Check every 1000ms
  }

  /**
   * Process a single queue continuously
   */
  private processQueue(
    queueName: string, 
    messageHandler: (message: DinaUniversalMessage) => Promise<DinaResponse>,
    intervalMs: number
  ): void {
    
    const processLoop = async () => {
      // Only process if connected to Redis
      if (!this.isConnected) {
        console.warn(`Queue processor (${queueName}) paused due to Redis disconnection.`);
        setTimeout(processLoop, intervalMs * 5); // Retry connection check less frequently
        return;
      }

      try {
        const message = await this.dequeueMessage(queueName, 0.1); // 100ms timeout
        
        if (message) {
          // Process the message
          const startTime = performance.now();
          const response = await messageHandler(message); // Expects DinaResponse
          const processingTime = performance.now() - startTime;

          // Publish response if needed (check for `require_ack` on the original message)
          if (message.qos.require_ack) {
            // Use the connection_id from the original message's source if available, otherwise default
            await this.publishResponse(message.source.instance || message.source.module, response);
          }

          console.log(`✅ Processed ${message.id} in ${processingTime.toFixed(2)}ms`);
        }

      } catch (error) {
        console.error(`❌ Queue processing error (${queueName}):`, error);
      }

      // Schedule next iteration
      setTimeout(processLoop, intervalMs);
    };

    // Start processing
    processLoop();
    console.log(`🔄 Queue processor started: ${queueName} (${intervalMs}ms interval)`);
  }

  /**
   * Publish a response back to a specific connection
   */
  async publishResponse(connectionId: string, response: DinaResponse): Promise<void> {
    if (!this.isConnected) {
        console.warn('Cannot publish response, Redis not connected.');
        return;
    }
    const channel = `dina:response:${connectionId}`;
    try {
        await this.publisher.publish(channel, JSON.stringify(response));
        console.log(`📢 Published response for request ${response.request_id} to channel ${channel}`);
    } catch (error) {
        console.error(`❌ Failed to publish response to ${channel}:`, error);
    }
  }

  /**
   * Subscribe to responses for a specific connection
   */
  async subscribeToResponses(
    connectionId: string, 
    responseHandler: (response: DinaResponse) => void
  ): Promise<void> {
    if (!this.isConnected) {
        throw new Error('Redis not connected. Cannot subscribe.');
    }
    const channel = `dina:response:${connectionId}`;
    
    await this.subscriber.subscribe(channel, (message) => {
      try {
        const response: DinaResponse = JSON.parse(message);
        responseHandler(response);
      } catch (error) {
        console.error('❌ Failed to parse response:', error);
      }
    });
    console.log(`👂 Subscribed to response channel: ${channel}`);
  }

  /**
   * Get queue statistics for monitoring
   */
  async getQueueStats(): Promise<Record<string, number>> {
    if (!this.isConnected) {
        console.warn('Redis not connected. Cannot get queue stats.');
        return {};
    }
    const stats: Record<string, number> = {};
    
    for (const [name, queueName] of Object.entries(QUEUE_NAMES)) {
      stats[name.toLowerCase()] = await this.client.lLen(queueName);
    }
    
    return stats;
  }

  /**
   * Get system load based on queue depths
   */
  async getSystemLoad(): Promise<number> {
    if (!this.isConnected) {
        console.warn('Redis not connected. Cannot get system load.');
        return 0;
    }
    const stats = await this.getQueueStats();
    const totalMessages = Object.values(stats).reduce((sum, count) => sum + count, 0);
    
    // Normalize to 0-1 scale (assuming 1000 queued messages = 100% load)
    return Math.min(totalMessages / 1000, 1.0);
  }

  /**
   * Setup Redis queues on startup
   */
  private async setupQueues(): Promise<void> {
    console.log('🗂️ Setting up message queues...');
    
    // Clear queues on startup (optional - you might want to preserve queues)
    // Added a check to only clear if client is connected
    if (this.client.isReady) {
      for (const queueName of Object.values(QUEUE_NAMES)) {
        await this.client.del(queueName);
        console.log(`🗑️ Cleared queue: ${queueName}`);
      }
    } else {
      console.warn('Client not ready, skipping queue clearing.');
    }
    
    console.log('✅ Message queues ready');
  }

  /**
   * Monitor queue health and performance
   */
  private startQueueMonitoring(): void {
    setInterval(async () => {
      // Only monitor if connected
      if (!this.isConnected) {
        console.warn('Queue monitoring paused due to Redis disconnection.');
        return;
      }
      try {
        const stats = await this.getQueueStats();
        const systemLoad = await this.getSystemLoad();
        
        console.log(`📊 Queue Stats: High:${stats.high} Med:${stats.medium} Low:${stats.low} Batch:${stats.batch} Load:${(systemLoad * 100).toFixed(1)}%`);
        
        // Alert if queues are backing up
        if (stats.high > 100) {
          console.warn('⚠️ High priority queue backing up!');
        }
        if (systemLoad > 0.8) {
          console.warn('⚠️ System load critical!');
        }
        
      } catch (error) {
        console.error('❌ Queue monitoring error:', error);
      }
    }, 30000); // Monitor every 30 seconds
  }

  /**
   * Setup error handling and reconnection logic
   */
  private setupErrorHandling(): void {
    const handleError = (client: RedisClientType, clientName: string) => {
      client.on('error', (error) => {
        console.error(`❌ Redis ${clientName} error:`, error);
        this.isConnected = false;
        // Attempt reconnect only if it's a persistent error, not just a network hiccup
        // The reconnectStrategy handles transient disconnections
        if (error.message.includes('ECONNREFUSED') || error.message.includes('connect ECONNREFUSED')) {
             this.attemptReconnect();
        }
      });

      client.on('connect', () => {
        console.log(`🔗 Redis ${clientName} connected`);
        this.reconnectAttempts = 0;
        this.isConnected = true; // Set connected to true on successful connection
      });

      client.on('end', () => { // 'end' event indicates client is fully disconnected
        console.warn(`🔌 Redis ${clientName} connection ended`);
        this.isConnected = false;
        // The reconnectStrategy handles reconnects automatically; no need for manual attemptReconnect here
      });

       // 'reconnecting' event might be useful for logging
       client.on('reconnecting', (status) => {
         console.log(`🔄 Redis ${clientName} reconnecting... Attempt ${status.attempt} of ${status.total_attempts || 'unlimited'}`);
       });
    };

    handleError(this.client, 'client');
    handleError(this.publisher, 'publisher');
    handleError(this.subscriber, 'subscriber');
  }

  /**
   * Attempt to reconnect to Redis
   * This is a fallback in case the internal reconnectStrategy isn't sufficient
   */
  private async attemptReconnect(): Promise<void> {
    if (this.isConnected) { // Already connected
        return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ Max reconnection attempts reached for Redis. Manual intervention may be required.');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.pow(2, this.reconnectAttempts) * 1000; // Exponential backoff

    console.log(`🔄 Attempting Redis reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);
    
    // Use setTimeout for a delayed retry
    setTimeout(async () => {
      try {
        // Attempt to initialize again, which will try to connect all clients
        await this.initialize();
      } catch (error) {
        console.error('❌ Reconnection attempt failed:', error);
        this.attemptReconnect(); // Retry if this attempt fails
      }
    }, delay);
  }

  /**
   * Determine queue name based on message priority and system load
   */
  private getQueueName(message: DinaUniversalMessage): string {
    const priority = message.target.priority;
    
    // VIP users or critical operations get high priority
    if (message.qos.priority_boost || priority >= 8) {
      return QUEUE_NAMES.HIGH;
    }
    
    // Normal priority
    if (priority >= 5) {
      return QUEUE_NAMES.MEDIUM;
    }
    
    // Low priority
    if (priority >= 3) {
      return QUEUE_NAMES.LOW;
    }
    
    // Background processing
    return QUEUE_NAMES.BATCH;
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down Redis connections...');
    
    try {
      await Promise.allSettled([ // Use allSettled to ensure all quit attempts are made
        this.client.quit(),
        this.publisher.quit(),
        this.subscriber.quit()
      ]);
      
      this.isConnected = false;
      console.log('✅ Redis connections closed gracefully');
      
    } catch (error) {
      console.error('❌ Redis shutdown error:', error);
    }
  }
}

// Export singleton instance
export const redisManager = new DinaRedisManager();
