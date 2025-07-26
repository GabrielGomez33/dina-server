// File: src/config/redis.ts - FIXED VERSION
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
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 50, 500),
        connectTimeout: 5000 // ENHANCED: Longer connect timeout
      }
    });

    this.publisher = this.client.duplicate();
    this.subscriber = this.client.duplicate();

    this.setupErrorHandling();
  }

  async initialize(): Promise<void> {
    console.log('📬 Initializing Redis with enhanced connection management...');

    try {
      // ENHANCED: Initialize with timeout
      const initPromise = Promise.all([
        this.client.connect(),
        this.publisher.connect(),
        this.subscriber.connect()
      ]);
      
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Redis initialization timeout')), 8000);
      });
      
      await Promise.race([initPromise, timeoutPromise]);

      await this.setupQueues();
      this.startQueueMonitoring();
      this.startHealthCheck();

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
      console.log('✅ Redis enhanced connection system online');
      this.reconnectAttempts = 0;

    } catch (error) {
      this.isConnected = false;
      console.error('❌ Failed to initialize Redis:', error);
      console.log('🔄 Continuing without Redis - system will work in fallback mode');
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

  // ENHANCED: Robust health check with retries
  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      if (this.isConnected) {
        try {
          await this.performHealthCheck();
        } catch (error) {
          console.warn('⚠️ Redis health check failed after all attempts, marking as disconnected');
          this.isConnected = false;
          this.attemptReconnect();
        }
      }
    }, 45000); // Check every 45 seconds (less frequent)
  }

  // NEW: Robust health check method
  private async performHealthCheck(): Promise<void> {
    let success = false;
    let lastError = null;
    
    // Try health check up to 3 times with increasing timeouts
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const timeout = attempt * 10000; // 3s, 6s, 9s timeouts
        
        await Promise.race([
          // Test all three connections
          Promise.all([
            this.client.ping(),
            this.publisher.ping(),
            this.subscriber.ping()
          ]),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Health check timeout attempt ${attempt}`)), timeout)
          )
        ]);
        
        success = true;
        break; // Success, exit retry loop
        
      } catch (error) {
        lastError = error;
        console.warn(`⚠️ Redis health check attempt ${attempt}/3 failed:`, error instanceof Error ? error.message : error);
        
        if (attempt < 3) {
          // Wait before retry (progressive delay)
          await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        }
      }
    }
    
    if (!success) {
      throw lastError || new Error('All health check attempts failed');
    }
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
        const high = stats[QUEUE_NAMES.HIGH] || 0;
        const medium = stats[QUEUE_NAMES.MEDIUM] || 0;
        const low = stats[QUEUE_NAMES.LOW] || 0;
        const batch = stats[QUEUE_NAMES.BATCH] || 0;
        const totalMessages = high + medium + low + batch;

        console.log(`📊 Queue Stats: High: ${high}, Medium: ${medium}, Low: ${low}, Batch: ${batch} (Total: ${totalMessages})`);
      } catch (error) {
        console.error('❌ Error getting queue stats during monitoring:', error);
      }
    }, 15000); // Check every 15 seconds (less frequent)
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

      // ENHANCED: Add timeout to enqueue operations
      await Promise.race([
        this.publisher.rPush(queueName, JSON.stringify(queuedMessage)),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Enqueue timeout')), 3000)
        )
      ]);

      console.log(`📨 Message queued: ${message.id} → ${queueName}`);

    } catch (error) {
      console.error('❌ Failed to enqueue message:', error);
      if (error instanceof Error && error.message === 'Enqueue timeout') {
        this.isConnected = false;
      }
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
    if (!this.isConnected) {
      return null;
    }

    try {
      const result = await this.client.blPop(queueName, 0.1);

      if (!result) {
        return null;
      }

      const message: DinaUniversalMessage & { queued_at?: number } = JSON.parse(result.element);

      if (typeof message.queued_at === 'number' && message.trace) {
        const queueTime = Date.now() - message.queued_at;
        message.trace.queue_time_ms = queueTime;
      }

      console.log(`📤 Message dequeued: ${message.id} (waited ${message.trace?.queue_time_ms || 'N/A'}ms)`);

      return message;

    } catch (error) {
      console.error(`❌ Error retrieving message from ${queueName}:`, error);
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
      // ENHANCED: Add timeout to publish operations
      await Promise.race([
        this.publisher.publish(channel, JSON.stringify(response)),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Publish timeout')), 2000)
        )
      ]);
      console.log(`📢 Published response for request ${response.request_id} to channel ${channel}`);
    } catch (error) {
      console.error(`❌ Failed to publish response to ${channel}:`, error);
      if (error instanceof Error && error.message === 'Publish timeout') {
        this.isConnected = false;
      }
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

    // ENHANCED: Add timeout to subscribe operations
    try {
      await Promise.race([
        this.subscriber.subscribe(channel, () => {}),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Subscribe timeout')), 3000)
        )
      ]);
      console.log(`👂 Subscribed to response channel: ${channel}`);
    } catch (error) {
      console.error(`❌ Failed to subscribe to ${channel}:`, error);
      this.responseHandlers.delete(connectionId);
      if (error instanceof Error && error.message === 'Subscribe timeout') {
        this.isConnected = false;
      }
      throw error;
    }
  }

  async unsubscribeFromResponses(connectionId: string): Promise<void> {
    if (!this.isConnected) {
      console.warn('Redis not connected. Cannot unsubscribe.');
      return;
    }
    const channel = `dina:response:${connectionId}`;

    this.responseHandlers.delete(connectionId);

    try {
      await Promise.race([
        this.subscriber.unsubscribe(channel),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Unsubscribe timeout')), 2000)
        )
      ]);
      console.log(`🚫 Unsubscribed from response channel: ${channel}`);
    } catch (error) {
      console.warn(`⚠️ Failed to unsubscribe ${connectionId}:`, error);
    }
  }

  async getQueueStats(): Promise<{ [key: string]: number }> {
    if (!this.isConnected) {
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
        stats[queueName] = count || 0;
      }
      return stats;
    } catch (error) {
      console.error('❌ Error getting queue stats:', error);
      this.isConnected = false;
      return {
        [QUEUE_NAMES.HIGH]: 0,
        [QUEUE_NAMES.MEDIUM]: 0,
        [QUEUE_NAMES.LOW]: 0,
        [QUEUE_NAMES.BATCH]: 0
      };
    }
  }

  async getExactCachedResponse(key: string): Promise<any | null> {
    if (!this.isConnected) {
      return null;
    }
    
    try {
      const getPromise = this.client.get(`cache:${key}`);
      const timeoutPromise = new Promise<null>((_, reject) => {
        setTimeout(() => reject(new Error('Redis get timeout')), 2000); // 2 second timeout
      });
      
      const serializedData = await Promise.race([getPromise, timeoutPromise]);
      
      if (serializedData) {
        return JSON.parse(serializedData);
      }
      
      return null;
      
    } catch (error) {
      if (error instanceof Error && error.message === 'Redis get timeout') {
        console.warn(`⚠️ Redis cache timeout for key: ${key.substring(0, 50)}...`);
        this.isConnected = false;
      }
      return null;
    }
  }

  async setExactCachedResponse(key: string, data: any, ttlSeconds: number): Promise<void> {
    if (!this.isConnected) {
      return;
    }
    
    try {
      const setPromise = this.client.setEx(`cache:${key}`, ttlSeconds, JSON.stringify(data));
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('Redis set timeout')), 1000);
      });
      
      await Promise.race([setPromise, timeoutPromise]);
      
    } catch (error) {
      if (error instanceof Error && error.message === 'Redis set timeout') {
        this.isConnected = false;
      }
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

  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('⚠️ Max Redis reconnection attempts reached, will retry later');
      setTimeout(() => { this.reconnectAttempts = 0; }, 300000);
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectAttempts * 3000, 15000); // Longer delays

    console.log(`🔄 Redis reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    setTimeout(async () => {
      try {
        if (!this.client.isOpen) {
          await this.client.connect();
        }
        
        await this.client.ping();
        
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.log('✅ Redis reconnected successfully');
        
      } catch (error) {
        console.log(`❌ Redis reconnect ${this.reconnectAttempts} failed`);
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.attemptReconnect();
        }
      }
    }, delay);
  }

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down Redis with cleanup...');
    
    try {
      if (this.queueMonitoringInterval) {
        clearInterval(this.queueMonitoringInterval);
        this.queueMonitoringInterval = null;
      }
      
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }

      await Promise.allSettled([
        this.client.quit(),
        this.publisher.quit(),
        this.subscriber.quit()
      ]);
      
      this.isConnected = false;
      console.log('✅ Redis shutdown complete');
      
    } catch (error) {
      console.error('❌ Redis shutdown error:', error);
    }
  }
}

export const redisManager = new DinaRedisManager();
