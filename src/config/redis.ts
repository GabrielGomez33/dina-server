// File: src/config/redis.ts
import { createClient, RedisClientType } from 'redis';
import { DinaUniversalMessage, DinaResponse, QUEUE_NAMES } from '../core/protocol'; 

export class DinaRedisManager {
  private client: RedisClientType;
  private publisher: RedisClientType;
  private subscriber: RedisClientType;
  public isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private responseHandlers: Map<string, (response: DinaResponse) => void> = new Map();
  private queueMonitoringInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 50, 500)
      }
    });

    this.publisher = this.client.duplicate();
    this.subscriber = this.client.duplicate();

    this.setupErrorHandling();
  }

  async initialize(): Promise<void> {
    console.log('📬 Initializing Redis message queue system...');

    try {
      await Promise.all([
        this.client.connect(),
        this.publisher.connect(), 
        this.subscriber.connect()
      ]);

      await this.setupQueues();
      
      this.startQueueMonitoring();

      this.subscriber.on('message', (channel, message) => {
        if (channel.startsWith('dina:response:')) {
          const connectionId = channel.substring('dina:response:'.length);
          const handler = this.responseHandlers.get(connectionId);
          if (handler) {
            try {
              const response: DinaResponse = JSON.parse(message);
              handler(response);
            } catch (error) {
              console.error(`❌ Failed to parse response from channel ${channel}:`, error);
            }
          }
        }
      });

      this.isConnected = true;
      console.log('✅ Redis message queue system online');
      this.reconnectAttempts = 0;

    } catch (error) {
      this.isConnected = false;
      console.error('❌ Failed to initialize Redis:', error);
      this.attemptReconnect();
      throw error;
    }
  }

  private setupErrorHandling(): void {
    this.client.on('error', (err) => {
      console.error('❌ Redis Client Error:', err);
      this.isConnected = false;
      this.attemptReconnect();
    });
    this.publisher.on('error', (err) => {
      console.error('❌ Redis Publisher Error:', err);
      this.isConnected = false;
    });
    this.subscriber.on('error', (err) => {
      console.error('❌ Redis Subscriber Error:', err);
      this.isConnected = false;
    });
    this.client.on('end', () => {
      console.warn('⚠️ Redis Client connection ended.');
      this.isConnected = false;
    });
    this.client.on('reconnecting', () => {
      console.log('🔄 Redis Client attempting to reconnect...');
    });
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ Max Redis reconnection attempts reached. Please check Redis server.');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.pow(2, this.reconnectAttempts) * 1000;
    console.log(`🔄 Attempting Redis reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);

    setTimeout(async () => {
      try {
        await this.initialize();
      } catch (error) {
        console.error('❌ Reconnection attempt failed:', error);
        this.attemptReconnect();
      }
    }, delay);
  }

  private async setupQueues(): Promise<void> {
    console.log('🗂️ Setting up message queues...');
    if (process.env.NODE_ENV !== 'production') {
      await this.client.del(QUEUE_NAMES.HIGH);
      console.log(`🗑️ Cleared queue: ${QUEUE_NAMES.HIGH}`);
      await this.client.del(QUEUE_NAMES.MEDIUM);
      console.log(`🗑️ Cleared queue: ${QUEUE_NAMES.MEDIUM}`);
      await this.client.del(QUEUE_NAMES.LOW);
      console.log(`🗑️ Cleared queue: ${QUEUE_NAMES.LOW}`);
      await this.client.del(QUEUE_NAMES.BATCH);
      console.log(`🗑️ Cleared queue: ${QUEUE_NAMES.BATCH}`);
    }
    console.log('✅ Message queues ready');
  }

  private startQueueMonitoring(): void {
    if (this.queueMonitoringInterval) {
      clearInterval(this.queueMonitoringInterval);
    }
    this.queueMonitoringInterval = setInterval(async () => {
      try {
        const stats = await this.getQueueStats();
        console.log(`📊 Queue Stats: High: ${stats.high}, Medium: ${stats.medium}, Low: ${stats.low}, Batch: ${stats.batch} (Total: ${stats.totalMessages})`);
      } catch (error) {
        console.error('❌ Error getting queue stats during monitoring:', error);
      }
    }, 10000);
  }

  async enqueueMessage(message: DinaUniversalMessage): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Redis not connected. Cannot enqueue message.');
    }

    try {
      const queueName = this.getQueueName(message);
      const queuedMessage: DinaUniversalMessage & { queued_at?: number } = {
        ...message,
        queued_at: Date.now()
      };

      await this.publisher.rPush(queueName, JSON.stringify(queuedMessage));

      console.log(`📨 Message queued: ${message.id} → ${queueName}`);

    } catch (error) {
      console.error('❌ Failed to enqueue message:', error);
      throw error;
    }
  }

  async dequeueMessage(queueName: string, timeoutSeconds: number = 1): Promise<DinaUniversalMessage | null> {
    if (!this.isConnected) {
      console.error('❌ Redis not connected for dequeueMessage');
      throw new Error('Redis not connected. Please call initialize() first.');
    }
    try {
      console.log(`⏳ Attempting to dequeue from ${queueName} with timeout ${timeoutSeconds}s`);
      const result = await this.client.blPop(queueName, timeoutSeconds);
      if (!result) {
        console.log(`⏳ No message available in ${queueName} after ${timeoutSeconds}s`);
        return null;
      }
      const message: DinaUniversalMessage = JSON.parse(result.element);
      if (typeof (message as any).queued_at === 'number') {
        const queueTime = Date.now() - (message as any).queued_at;
        if (message.trace) {
          message.trace.queue_time_ms = queueTime;
        }
      }
      console.log(`📤 Dequeued message: ${message.id}, method: ${message.target.method}, waited: ${message.trace?.queue_time_ms || 'N/A'}ms`);
      return message;
    } catch (error) {
      console.error(`❌ Failed to dequeue message from ${queueName}:`, error);
      return null;
    }
  }

  async retrieveMessage(queueName: string): Promise<DinaUniversalMessage | null> {
  // ADD THIS CHECK at the beginning:
  if (!this.isConnected) {
    // Don't log here to avoid spam - let the caller handle it
    return null;
  }
  
  try {
    // BLPOP = blocking left pop (waits for message if queue empty)
    // Using 0.1s timeout for non-blocking behavior in intervals
    const result = await this.client.blPop(queueName, 0.1); 
    
    if (!result) {
      return null; // Timeout, no message available
    }

    // Parse message and add queue time to trace
    const message: DinaUniversalMessage & { queued_at?: number } = JSON.parse(result.element);
    
    if (typeof message.queued_at === 'number' && message.trace) {
      const queueTime = Date.now() - message.queued_at;
      message.trace.queue_time_ms = queueTime;
    }

    console.log(`📤 Message dequeued: ${message.id} (waited ${message.trace?.queue_time_ms || 'N/A'}ms)`);
    
    return message;
    
  } catch (error) {
    console.error(`❌ Error retrieving message from ${queueName}:`, error);
    // Mark as disconnected if Redis error
    this.isConnected = false;
    return null;
  }
}
  private getQueueName(message: DinaUniversalMessage): string {
    const priority = message.target.priority;
    
    if (message.qos?.priority_boost || priority >= 8) {
      return QUEUE_NAMES.HIGH;
    }
    
    if (priority >= 5) {
      return QUEUE_NAMES.MEDIUM;
    }
    
    if (priority >= 3) {
      return QUEUE_NAMES.LOW;
    }
    
    return QUEUE_NAMES.BATCH;
  }

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

  async subscribeToResponses(
    connectionId: string, 
    responseHandler: (response: DinaResponse) => void
  ): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Redis not connected. Cannot subscribe.');
    }
    const channel = `dina:response:${connectionId}`;
    
    this.responseHandlers.set(connectionId, responseHandler);
    
    await this.subscriber.subscribe(channel, () => {});
    console.log(`👂 Subscribed to response channel: ${channel}`);
  }

  async unsubscribeFromResponses(connectionId: string): Promise<void> {
    if (!this.isConnected) {
      console.warn('Redis not connected. Cannot unsubscribe.');
      return;
    }
    const channel = `dina:response:${connectionId}`;
    
    this.responseHandlers.delete(connectionId);
    
    await this.subscriber.unsubscribe(channel);
    console.log(`🚫 Unsubscribed from response channel: ${channel}`);
  }

async getQueueStats(): Promise<{ [key: string]: number }> {
  // ADD THIS CHECK:
  if (!this.isConnected) {
    // Return empty stats silently when Redis is disconnected
    return {
      [QUEUE_NAMES.HIGH]: 0,
      [QUEUE_NAMES.MEDIUM]: 0,
      [QUEUE_NAMES.LOW]: 0,
      [QUEUE_NAMES.BATCH]: 0
    };
  }
  
  try {
    const stats: { [key: string]: number } = {};
    
    for (const queueName of Object.values(QUEUE_NAMES)) {
      const count = await this.client.lLen(queueName);
      stats[queueName] = count;
    }
    
    return stats;
  } catch (error) {
    console.error('❌ Error getting queue stats:', error);
    // Mark as disconnected if Redis error
    this.isConnected = false;
    return {
      [QUEUE_NAMES.HIGH]: 0,
      [QUEUE_NAMES.MEDIUM]: 0,
      [QUEUE_NAMES.LOW]: 0,
      [QUEUE_NAMES.BATCH]: 0
    };
  }
}

async setExactCachedResponse(key: string, data: any, ttlSeconds: number): Promise<void> {
  console.log(`🔍 REDIS DEBUG: Starting cache set for key: cache:${key}`);
  
  if (!this.isConnected) {
    console.warn('Redis not connected. Cannot set cached response.');
    return;
  }
  
  try {
    const serializedData = JSON.stringify(data);
    console.log(`🔍 REDIS DEBUG: Data serialized, length: ${serializedData.length}`);
    
    // Add timeout to Redis set as well
    const setPromise = this.client.setEx(`cache:${key}`, ttlSeconds, serializedData);
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Redis set timeout')), 5000);
    });
    
    await Promise.race([setPromise, timeoutPromise]);
    
    console.log(`💾 Redis cache: Set key 'cache:${key}' with TTL ${ttlSeconds}s`);
  } catch (error) {
    console.error(`❌ Failed to set Redis cache for key '${key}':`, error);
    
    if (error instanceof Error && error.message === 'Redis set timeout') {
      console.error(`🚨 REDIS SET TIMEOUT: Marking Redis as disconnected`);
      this.isConnected = false;
    }
  }
}

async getExactCachedResponse(key: string): Promise<any | null> {
  console.log(`🔍 REDIS DEBUG: Starting cache get for key: cache:${key}`);
  
  if (!this.isConnected) {
    console.warn('REDIS DEBUG: Redis not connected, returning null');
    return null;
  }
  
  try {
    console.log(`🔍 REDIS DEBUG: About to call this.client.get() - THIS IS WHERE IT HANGS`);
    
    // Add timeout to the Redis call
    const getPromise = this.client.get(`cache:${key}`);
    const timeoutPromise = new Promise<null>((_, reject) => {
      setTimeout(() => reject(new Error('Redis get timeout')), 5000); // 5 second timeout
    });
    
    console.log(`🔍 REDIS DEBUG: Created promises, about to race them`);
    
    const serializedData = await Promise.race([getPromise, timeoutPromise]);
    
    console.log(`🔍 REDIS DEBUG: Redis get completed, data length: ${serializedData?.length || 0}`);
    
    if (serializedData) {
      console.log(`⚡ Redis cache: Hit for key 'cache:${key}'`);
      const parsed = JSON.parse(serializedData);
      console.log(`🔍 REDIS DEBUG: JSON parse successful`);
      return parsed;
    }
    
    console.log(`⏳ Redis cache: Miss for key 'cache:${key}'`);
    return null;
    
  } catch (error) {
    console.error(`❌ REDIS ERROR for key '${key}':`, error);
    
    // If Redis is hanging, mark as disconnected and return null
    if (error instanceof Error && error.message === 'Redis get timeout') {
      console.error(`🚨 REDIS TIMEOUT: Marking Redis as disconnected`);
      this.isConnected = false;
    }
    
    return null;
  }
}

  async clearAllExactCache(): Promise<void> {
    if (!this.isConnected) {
      console.warn('Redis not connected. Cannot clear cache.');
      return;
    }
    try {
      const keys = await this.client.keys('cache:*');
      if (keys.length > 0) {
        await this.client.del(keys);
        console.log(`🗑️ Cleared ${keys.length} exact-match cache entries.`);
      } else {
        console.log('🗑️ No exact-match cache entries to clear.');
      }
    } catch (error) {
      console.error('❌ Failed to clear all Redis exact-match cache entries:', error);
    }
  }

  // Added to resolve TypeScript error in src/modules/llm/manager.ts
  async getCacheSize(): Promise<number> {
    if (!this.isConnected) {
      console.warn('Redis not connected. Cannot get cache size.');
      return 0;
    }
    try {
      const info = await this.client.info('memory');
      const usedMemory = parseInt(info.match(/used_memory:(\d+)/)?.[1] || '0', 10);
      console.log(`📏 Redis cache size: ${usedMemory} bytes`);
      return usedMemory;
    } catch (error) {
      console.error('❌ Failed to get Redis cache size:', error);
      return 0;
    }
  }

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down Redis connections...');
    
    try {
      if (this.queueMonitoringInterval) {
        clearInterval(this.queueMonitoringInterval);
        this.queueMonitoringInterval = null;
      }

      await Promise.allSettled([
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

export const redisManager = new DinaRedisManager();
