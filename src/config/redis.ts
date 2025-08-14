// File: src/config/redis.ts - RESILIENT VERSION (healthcheck + cache timeouts hardened)
import { createClient, RedisClientType } from 'redis';
import { DinaUniversalMessage, DinaResponse, QUEUE_NAMES } from '../core/protocol';

export enum RedisConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  FAILED = 'failed',
  CIRCUIT_OPEN = 'circuit_open',
}

export class DinaRedisManager {
  private client: RedisClientType;
  private publisher: RedisClientType;
  private subscriber: RedisClientType;

  // State
  public isConnected = false; // compatibility flag
  private connectionState: RedisConnectionState = RedisConnectionState.DISCONNECTED;
  private initializing = false;

  // Reconnect / failure accounting
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private consecutiveFailures = 0;
  private lastError: Error | null = null;

  // Circuit breaker
  private circuitBreakerOpen = false;
  private circuitBreakerOpenTime = 0;
  private circuitBreakerThreshold = 5;
  private circuitBreakerTimeoutMs = 60_000;

  // Message buffer
  private messageBuffer: DinaUniversalMessage[] = [];
  private maxBufferSize = 1000;

  // Monitoring
  private responseHandlers: Map<string, (response: DinaResponse) => void> = new Map();
  private queueMonitoringInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private queuesInitialized = false;

  constructor() {
    this.client = this.createMainClient();
    this.publisher = this.client.duplicate();
    this.subscriber = this.client.duplicate();
    this.setupErrorHandling();
  }

  // ----------------------------------------------------------------------------
  // Client creation & error handling
  // ----------------------------------------------------------------------------
  private createMainClient(): RedisClientType {
    return createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > this.maxReconnectAttempts) return false;
          return Math.min(retries * 1000, 15000);
        },
        connectTimeout: 8000,
      },
    });
  }

  private setupErrorHandling(): void {
    [this.client, this.publisher, this.subscriber].forEach((c, i) => {
      const clientName = ['main', 'publisher', 'subscriber'][i];

      c.on('error', (error: Error) => {
        console.error(`❌ Redis ${clientName} error:`, error.message);
        this.handleConnectionFailure(error);
      });

      c.on('connect', () => {
        console.log(`🔗 Redis ${clientName} connecting...`);
        this.setConnectionState(RedisConnectionState.CONNECTING);
      });

      c.on('ready', () => {
        console.log(`✅ Redis ${clientName} ready`);
        if (clientName === 'main') {
          this.handleConnectionSuccess();
        }
      });

      c.on('end', () => {
        console.log(`🔌 Redis ${clientName} connection ended`);
        this.handleConnectionFailure(new Error('Connection ended'));
      });

      // node-redis v4: no 'reconnecting' event
    });
  }

  private setConnectionState(state: RedisConnectionState): void {
    const prev = this.connectionState;
    this.connectionState = state;
    if (prev !== state) console.log(`🔄 Redis state: ${prev} → ${state}`);
  }

  private handleConnectionSuccess(): void {
    this.isConnected = true;
    this.setConnectionState(RedisConnectionState.CONNECTED);
    this.reconnectAttempts = 0;
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.circuitBreakerOpen = false;

    console.log('✅ Redis connected - processing buffered messages');
    void this.processMessageBuffer();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private handleConnectionFailure(error: Error): void {
    this.isConnected = false;
    this.lastError = error;
    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
      this.openCircuitBreaker();
      return;
    }

    this.setConnectionState(RedisConnectionState.FAILED);

    if (!this.reconnectTimeout && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    }
  }

  private openCircuitBreaker(): void {
    this.circuitBreakerOpen = true;
    this.circuitBreakerOpenTime = Date.now();
    this.setConnectionState(RedisConnectionState.CIRCUIT_OPEN);
    console.log(`🚨 Circuit breaker opened after ${this.consecutiveFailures} failures`);
    setTimeout(() => this.resetCircuitBreaker(), this.circuitBreakerTimeoutMs);
  }

  private resetCircuitBreaker(): void {
    this.circuitBreakerOpen = false;
    this.consecutiveFailures = 0;
    console.log('🔄 Circuit breaker reset, attempting reconnection');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout || this.circuitBreakerOpen || this.initializing) return;

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectAttempts * 3000, 30000);
    console.log(`🔄 Redis reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      try {
        await this.reconnectFresh();
      } catch (error) {
        console.log(`❌ Reconnection attempt ${this.reconnectAttempts} failed: ${(error as Error)?.message}`);
      }
    }, delay);
  }

  private pauseMonitors(): void {
    if (this.queueMonitoringInterval) {
      clearInterval(this.queueMonitoringInterval);
      this.queueMonitoringInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private async reconnectFresh(): Promise<void> {
    // Pause monitors so ping doesn't fire while clients are closed
    this.pauseMonitors();

    this.setConnectionState(RedisConnectionState.RECONNECTING);
    try {
      await Promise.allSettled([this.client.quit(), this.publisher.quit(), this.subscriber.quit()]);
    } catch {
      /* ignore */
    }

    // Recreate clients and rewire events
    this.client = this.createMainClient();
    this.publisher = this.client.duplicate();
    this.subscriber = this.client.duplicate();
    this.setupErrorHandling();

    await this.initialize();
  }

  // ----------------------------------------------------------------------------
  // Initialization
  // ----------------------------------------------------------------------------
  async initialize(): Promise<void> {
    if (this.initializing) return;
    this.initializing = true;

    console.log('📬 Initializing Redis with enhanced connection management...');

    try {
      if (this.circuitBreakerOpen) {
        const elapsed = Date.now() - this.circuitBreakerOpenTime;
        if (elapsed < this.circuitBreakerTimeoutMs) {
          throw new Error('Circuit breaker is open - Redis operations disabled');
        } else {
          this.resetCircuitBreaker();
        }
      }

      this.setConnectionState(RedisConnectionState.CONNECTING);

      const initPromise = Promise.all([this.client.connect(), this.publisher.connect(), this.subscriber.connect()]);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Redis initialization timeout')), 10_000),
      );

      await Promise.race([initPromise, timeoutPromise]);

      await this.setupQueues(); // guarded, clears once in dev
      this.startQueueMonitoring();
      this.startHealthCheck();

      // No global 'message' listener; v4 uses per-subscription callbacks

      this.handleConnectionSuccess();
    } catch (error) {
      console.error('❌ Redis initialization failed:', error);
      this.handleConnectionFailure(error as Error);
      throw error;
    } finally {
      this.initializing = false;
    }
  }

  // ----------------------------------------------------------------------------
  // Message buffer (graceful degradation)
  // ----------------------------------------------------------------------------
  private bufferMessage(message: DinaUniversalMessage): void {
    if (this.messageBuffer.length >= this.maxBufferSize) {
      this.messageBuffer.shift();
      console.warn('⚠️ Message buffer full, dropped oldest message');
    }
    this.messageBuffer.push(message);
    console.log(`📦 Buffered message ${message.id} (${this.messageBuffer.length}/${this.maxBufferSize})`);
  }

  private async processMessageBuffer(): Promise<void> {
    if (this.messageBuffer.length === 0) return;

    console.log(`🔄 Processing ${this.messageBuffer.length} buffered messages`);
    const messages = [...this.messageBuffer];
    this.messageBuffer = [];

    for (const m of messages) {
      try {
        await this.enqueueMessage(m);
      } catch (error) {
        console.error('❌ Failed to process buffered message:', error);
        this.bufferMessage(m); // re-buffer if still failing
      }
    }
  }

  // ----------------------------------------------------------------------------
  // Queue operations
  // ----------------------------------------------------------------------------
  private async setupQueues(): Promise<void> {
    console.log('🗂️ Setting up message queues...');
    if (!this.queuesInitialized) {
      if (process.env.NODE_ENV !== 'production') {
        await this.client.del([QUEUE_NAMES.HIGH, QUEUE_NAMES.MEDIUM, QUEUE_NAMES.LOW, QUEUE_NAMES.BATCH]);
        console.log('🗑️ Cleared dev queues once at init.');
      }
      this.queuesInitialized = true;
    }
    console.log('✅ Message queues ready');
  }

  private startQueueMonitoring(): void {
    if (this.queueMonitoringInterval) clearInterval(this.queueMonitoringInterval);

    this.queueMonitoringInterval = setInterval(async () => {
      if (!this.isConnected) return;
      try {
        const stats = await this.getQueueStats();
        const high = stats[QUEUE_NAMES.HIGH] || 0;
        const medium = stats[QUEUE_NAMES.MEDIUM] || 0;
        const low = stats[QUEUE_NAMES.LOW] || 0;
        const batch = stats[QUEUE_NAMES.BATCH] || 0;
        const total = high + medium + low + batch;
        console.log(`📊 Queue Stats: High: ${high}, Medium: ${medium}, Low: ${low}, Batch: ${batch} (Total: ${total})`);
      } catch (error) {
        console.error('❌ Error getting queue stats during monitoring:', error);
      }
    }, 15_000);
  }

  private getQueueName(message: DinaUniversalMessage): string {
    const priority = (message as any)?.target?.priority ?? 0;
    if (priority >= 8) return QUEUE_NAMES.HIGH;
    if (priority >= 5) return QUEUE_NAMES.MEDIUM;
    if (priority >= 3) return QUEUE_NAMES.LOW;
    return QUEUE_NAMES.BATCH;
  }

  async enqueueMessage(message: DinaUniversalMessage): Promise<void> {
    if (this.circuitBreakerOpen) {
      this.bufferMessage(message);
      return;
    }
    if (!this.isConnected) {
      console.warn('⚠️ Redis not connected, buffering message for queue');
      this.bufferMessage(message);
      return;
    }

    try {
      const queueName = this.getQueueName(message);
      const queuedMessage: DinaUniversalMessage & { queued_at?: number } = { ...message, queued_at: Date.now() };

      await Promise.race([
        this.client.lPush(queueName, JSON.stringify(queuedMessage)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Enqueue timeout')), 5000)),
      ]);

      console.log(`📨 Message queued: ${message.id} → ${queueName}`);
    } catch (error) {
      console.error('❌ Failed to enqueue message:', error);
      if ((message as any)?.target?.priority < 8) {
        this.bufferMessage(message);
      } else {
        throw error; // critical messages fail fast
      }
    }
  }

  async dequeueMessage(queueName: string, timeoutSeconds = 1): Promise<DinaUniversalMessage | null> {
    if (!this.isConnected) {
      // Quietly indicate no work available instead of throwing
      return null;
    }

    try {
      const result = await Promise.race([
        this.client.brPop(queueName, timeoutSeconds),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Dequeue timeout')), (timeoutSeconds + 1) * 1000),
        ),
      ]);

      if (result) {
        const message: DinaUniversalMessage = JSON.parse(result.element);
        console.log(`📬 Message dequeued: ${message.id} from ${queueName}`);
        return message;
      }
      return null;
    } catch (error) {
      if (error instanceof Error && error.message === 'Dequeue timeout') {
        return null; // benign idle timeout
      }
      console.error('❌ Failed to dequeue message:', error);
      this.handleConnectionFailure(error as Error);
      throw error;
    }
  }

  // Alias for compatibility
  async retrieveMessage(queueName: string): Promise<DinaUniversalMessage | null> {
    return this.dequeueMessage(queueName, 1);
  }

  async getQueueStats(): Promise<{ [key: string]: number }> {
    if (!this.isConnected) {
      return {
        [QUEUE_NAMES.HIGH]: 0,
        [QUEUE_NAMES.MEDIUM]: 0,
        [QUEUE_NAMES.LOW]: 0,
        [QUEUE_NAMES.BATCH]: 0,
      };
    }
    try {
      const stats: { [key: string]: number } = {};
      for (const q of Object.values(QUEUE_NAMES)) {
        const count = await this.client.lLen(q);
        stats[q] = count || 0;
      }
      return stats;
    } catch (error) {
      console.error('❌ Error getting queue stats:', error);
      this.handleConnectionFailure(error as Error);
      return {
        [QUEUE_NAMES.HIGH]: 0,
        [QUEUE_NAMES.MEDIUM]: 0,
        [QUEUE_NAMES.LOW]: 0,
        [QUEUE_NAMES.BATCH]: 0,
      };
    }
  }

  // ----------------------------------------------------------------------------
  // Cache operations (timeouts are cache misses; no state flip)
  // ----------------------------------------------------------------------------
  async get(key: string): Promise<string | null> {
    if (!this.isConnected) return null;
    try {
      return await Promise.race([
        this.client.get(key),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Get timeout')), 3000)),
      ]);
    } catch (error) {
      console.warn(`⚠️ Redis get timeout for ${key}`);
      return null; // treat as cache miss, do NOT handleConnectionFailure
    }
  }

  async setex(key: string, seconds: number, value: string): Promise<void> {
    if (!this.isConnected) return;
    try {
      await Promise.race([
        this.client.setEx(key, seconds, value),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Setex timeout')), 2000)),
      ]);
    } catch {
      console.warn(`⚠️ Redis setex timeout for ${key}`); // no state flip
    }
  }

  async getExactCachedResponse(key: string): Promise<any | null> {
    if (!this.isConnected) return null;

    try {
      const serialized = await Promise.race([
        this.client.get(`cache:${key}`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Redis get timeout')), 2000)),
      ]);

      if (serialized) return JSON.parse(serialized);
      return null;
    } catch {
      console.warn(`⚠️ Redis cache get timeout for key: ${key.substring(0, 50)}...`);
      return null; // no state flip
    }
  }

  async setExactCachedResponse(key: string, data: any, ttlSeconds: number): Promise<void> {
    if (!this.isConnected) return;
    try {
      await Promise.race([
        this.client.setEx(`cache:${key}`, ttlSeconds, JSON.stringify(data)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Redis set timeout')), 1000)),
      ]);
    } catch {
      console.warn(`⚠️ Redis cache set timeout for key: ${key.substring(0, 50)}...`);
    }
  }

  async clearCache(): Promise<void> {
    if (!this.isConnected) return;
    try {
      const keys = await this.client.keys('cache:*');
      if (keys.length > 0) {
        await this.client.del(keys); // pass array (v4 typing safe)
        console.log(`🗑️ Cleared ${keys.length} cache entries.`);
      } else {
        console.log('🗑️ No cache entries to clear.');
      }
    } catch (error) {
      console.error('❌ Failed to clear Redis cache:', error);
    }
  }

  async clearAllExactCache(): Promise<void> {
    if (!this.isConnected) return;
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
    if (!this.isConnected) return 0;
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

  // ----------------------------------------------------------------------------
  // Pub/Sub operations
  // ----------------------------------------------------------------------------
  async publishResponse(connectionId: string, response: DinaResponse): Promise<void> {
    if (!this.isConnected) return;

    const channel = `dina:response:${connectionId}`;
    try {
      await Promise.race([
        this.publisher.publish(channel, JSON.stringify(response)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Publish timeout')), 3000)),
      ]);
      console.log(`📢 Published response for request ${response.request_id} to channel ${channel}`);
    } catch (error) {
      console.error(`❌ Failed to publish response to ${channel}:`, error);
      // publishing timeouts may indicate trouble; we still don't flip state here
    }
  }

  async subscribeToResponses(
    connectionId: string,
    responseHandler: (response: DinaResponse) => void,
  ): Promise<void> {
    if (!this.isConnected) throw new Error('Redis not connected. Cannot subscribe.');

    const channel = `dina:response:${connectionId}`;
    this.responseHandlers.set(connectionId, responseHandler);

    try {
      await Promise.race([
        this.subscriber.subscribe(channel, (raw) => {
          const handler = this.responseHandlers.get(connectionId);
          if (!handler) return;
          try {
            const parsed: DinaResponse = JSON.parse(raw);
            handler(parsed);
          } catch (e) {
            console.error('❌ Failed to parse response message:', e);
          }
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Subscribe timeout')), 3000)),
      ]);
      console.log(`👂 Subscribed to response channel: ${channel}`);
    } catch (error) {
      console.error(`❌ Failed to subscribe to ${channel}:`, error);
      this.responseHandlers.delete(connectionId);
      throw error;
    }
  }

  async unsubscribeFromResponses(connectionId: string): Promise<void> {
    if (!this.isConnected) return;

    const channel = `dina:response:${connectionId}`;
    this.responseHandlers.delete(connectionId);

    try {
      await Promise.race([
        this.subscriber.unsubscribe(channel),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Unsubscribe timeout')), 2000)),
      ]);
      console.log(`🚫 Unsubscribed from response channel: ${channel}`);
    } catch (error) {
      console.warn(`⚠️ Failed to unsubscribe ${connectionId}:`, error);
    }
  }

  // ----------------------------------------------------------------------------
  // Health monitoring (only when connected & open)
  // ----------------------------------------------------------------------------
  private startHealthCheck(): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);

    this.healthCheckInterval = setInterval(async () => {
      // Only ping when we believe we're connected and client socket is open
      if (this.connectionState !== RedisConnectionState.CONNECTED) return;
      // @redis/client exposes isOpen
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      if (!(this.client as any)?.isOpen) return;

      try {
        await Promise.race([
          this.client.ping(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 5000)),
        ]);
        if (!this.isConnected) this.handleConnectionSuccess();
        // Keep logs modest to avoid noise
        // console.log('💓 Redis health check passed');
      } catch (error: any) {
        // If the client closed during reconnect window, ignore
        if (String(error?.name || '').includes('ClientClosedError')) return;
        console.error('❌ Redis health check failed:', error);
        this.handleConnectionFailure(error as Error);
      }
    }, 30_000);
  }

  // ----------------------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------------------
  public get state(): RedisConnectionState {
    return this.connectionState;
  }

  public getMetrics() {
    return {
      connectionState: this.connectionState,
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      circuitBreakerOpen: this.circuitBreakerOpen,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError?.message,
      bufferedMessages: this.messageBuffer.length,
      maxBufferSize: this.maxBufferSize,
    };
  }

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down Redis with enhanced cleanup...');
    this.pauseMonitors();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    try {
      await Promise.allSettled([this.client.quit(), this.publisher.quit(), this.subscriber.quit()]);
      this.isConnected = false;
      this.setConnectionState(RedisConnectionState.DISCONNECTED);
      console.log('✅ Redis shutdown complete');
    } catch (error) {
      console.error('❌ Redis shutdown error:', error);
    }
  }
}

export const redisManager = new DinaRedisManager();
