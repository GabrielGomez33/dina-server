// File: src/config/redis.ts - ENHANCED REDIS MANAGER (PROJECT-INTEGRATED)
// Vector-safe (Float32), RediSearch-aware, FIFO queues, smart cache, legacy helpers & APIs used by other modules

import { createClient, RedisClientType, RedisClusterType } from 'redis';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import { DinaUniversalMessage, DinaResponse, QUEUE_NAMES } from '../core/protocol';

// Compression utilities
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// ================================
// ENHANCED TYPES & INTERFACES
// ================================

export enum RedisConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  FAILED = 'failed',
  CLUSTER_READY = 'cluster_ready'
}

export interface VectorEmbedding {
  id: string;
  vector: number[];
  metadata: Record<string, any>;
  timestamp: number;
  model: string;
  dimensions: number;
  magnitude?: number;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  evictions: number;
  memoryUsage: number;
  operationsPerSecond: number;
  averageResponseTime: number;
}

export interface VectorSearchOptions {
  topK?: number;
  threshold?: number;
  // only applied in manual fallback
  includeMetadata?: boolean;
  filters?: Record<string, any>;
}

export interface VectorSearchResult {
  id: string;
  score: number;                 // distance (RediSearch/COSINE) or similarity (manual fallback)
  vector?: number[];
  metadata?: Record<string, any>;
}

export interface CachePolicy {
  ttl: number;
  maxSize?: number;
  compressionThreshold?: number;
  evictionPolicy?: 'lru' | 'lfu' | 'ttl';
  warmingStrategy?: 'lazy' | 'eager' | 'predictive';
}

export interface QueueStats {
  length: number;
  processingCount: number;
  errorCount: number;
  lastProcessedAt?: Date;
}

// ================================
// ENHANCED REDIS MANAGER
// ================================

export class EnhancedDinaRedisManager extends EventEmitter {
  // Core Redis connections
  private client: RedisClientType;
  private publisher: RedisClientType;
  private subscriber: RedisClientType;
  private vectorClient: RedisClientType; // Dedicated for vector operations

  // Cluster support
  private cluster?: RedisClusterType;
  private isClusterMode: boolean = false;

  // Connection state
  private connectionState: RedisConnectionState = RedisConnectionState.DISCONNECTED;
  public isConnected = false;
  // <-- exposed mutable boolean (used widely in your code)
  private initializing = false;
  // Performance optimization (present but not used yet)
  private connectionPool: RedisClientType[] = [];
  private poolSize = 10;
  private roundRobinIndex = 0;

  // Intelligent caching
  private cacheMetrics: CacheMetrics = {
    hits: 0, misses: 0, evictions: 0, memoryUsage: 0,
    operationsPerSecond: 0, averageResponseTime: 0
  };
  // Vector database capabilities
  private vectorIndexes: Set<string> = new Set();
  private redisSearchAvailable = false;
  // Message buffering
  private messageBuffer: DinaUniversalMessage[] = [];
  private maxBufferSize = 10000;
  // Pub/Sub response handlers
  private responseHandlers: Map<string, (response: DinaResponse) => void> = new Map();
  private subscriptionChannels: Map<string, string> = new Map(); // connectionId -> channel

  // Configuration
  private readonly config = {
    // Connection settings
    maxRetries: 5,
    retryDelay: 1000,
    commandTimeout: 30000,

    // Compression settings
    compressionThreshold: 1024, // bytes
    compressionLevel: 6,

    // Cache policies
    defaultTTL: 3600,
    embeddingTTL: 86400,
    contextTTL: 7200,

    // Performance settings
    batchSize: 100,
    pipelineThreshold: 10,

    // Vector Settings
    defaultVectorDimensions: 1024,
    vectorSearchTimeout: 5000
  };

  constructor() {
    super();
    console.log('🚀 Initializing Enhanced DINA Redis Manager with Vector Database capabilities...');
    // Initialize Redis clients with enhanced configuration
    this.client = this.createEnhancedClient('main');
    this.publisher = this.createEnhancedClient('publisher');
    this.subscriber = this.createEnhancedClient('subscriber');
    this.vectorClient = this.createEnhancedClient('vector');

    this.setupEventHandlers();
    this.initializeConnectionPool();
    this.startPerformanceMonitoring();
  }

  // ================================
  // ENHANCED CONNECTION MANAGEMENT
  // ================================

  private createEnhancedClient(clientType: string): RedisClientType {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';

    return createClient({
      url,
      // NOTE: `lazyConnect` property has been removed as it is not a valid option
      // in the type definition provided by your compiler. You may need to
      // update your `redis` library if you require this functionality.
      socket: {
        connectTimeout: 10000,
        reconnectStrategy: (retries) => {
          if (retries > this.config.maxRetries) {
            this.emit('connectionFailed', { clientType, retries });
            return false;
          }
          const delay = Math.min(retries * this.config.retryDelay, 30000);
          this.emit('reconnectAttempt', { clientType, retries, delay });
          return delay;
        }
      },
      commandsQueueMaxLength: 10000
    });
  }

  private setupEventHandlers(): void {
    const clients = [
      { client: this.client, name: 'main' },
      { client: this.publisher, name: 'publisher' },
      { client: this.subscriber, name: 'subscriber' },
      { client: this.vectorClient, name: 'vector' }
    ];
    clients.forEach(({ client, name }) => {
      client.on('error', (error) => {
        const msg = (error as any)?.message ?? String(error);
        console.error(`❌ Redis ${name} error:`, msg);
        this.handleConnectionError(name, error as Error);
      });

      client.on('connect', () => {
        console.log(`🔗 Redis ${name} connecting...`);
        this.setConnectionState(RedisConnectionState.CONNECTING);
      });

      client.on('ready', () => {
        console.log(`✅ Redis ${name} ready`);
        this.handleConnectionReady(name);
      });

      client.on('end', () => {
        console.log(`🔌 Redis ${name} connection ended`);
        this.handleConnectionEnd(name);
      });

      (client as any).on?.('reconnecting', () => {
        console.log(`🔄 Redis ${name} reconnecting...`);
        this.setConnectionState(RedisConnectionState.RECONNECTING);
      });
   
    });
  }

  private async initializeConnectionPool(): Promise<void> {
    console.log(`🏊 Initializing connection pool with ${this.poolSize} connections...`);
    for (let i = 0; i < this.poolSize; i++) {
      const poolClient = this.createEnhancedClient(`pool-${i}`);
      this.connectionPool.push(poolClient);
    }
  }

  private getPoolConnection(): RedisClientType {
    const client = this.connectionPool[this.roundRobinIndex];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % this.poolSize;
    return client;
  }

  private handleConnectionError(clientName: string, error: Error): void {
    this.emit('connectionError', { clientName, error });
    if (clientName === 'main') {
      this.isConnected = false;
      this.setConnectionState(RedisConnectionState.FAILED);
    }
    this.scheduleReconnection(clientName);
  }

  private handleConnectionReady(clientName: string): void {
    if (clientName === 'main') {
      this.isConnected = true;
      this.setConnectionState(RedisConnectionState.CONNECTED);
      this.emit('connected');
      this.processMessageBuffer();
    }
  }

  private handleConnectionEnd(clientName: string): void {
    if (clientName === 'main') {
      this.isConnected = false;
      this.setConnectionState(RedisConnectionState.DISCONNECTED);
      this.emit('disconnected');
    }
  }

  private scheduleReconnection(clientName: string): void {
    setTimeout(async () => {
      try {
        console.log(`🔄 Attempting to reconnect ${clientName}...`);
        await this.reconnectClient(clientName);
      } catch (error) {
        console.error(`❌ Reconnection failed for ${clientName}:`, error);
      }
    }, this.config.retryDelay);
  }

  private async reconnectClient(clientName: string): Promise<void> {
    try {
      switch (clientName) {
        case 'main': await this.client.connect();
          break;
        case 'publisher': await this.publisher.connect(); break;
        case 'subscriber': await this.subscriber.connect(); break;
        case 'vector': await this.vectorClient.connect(); break;
      }
    } catch (error) {
      console.error(`❌ Failed to reconnect ${clientName}:`, error);
      throw error;
    }
  }

  // ================================
  // INITIALIZATION & LIFECYCLE
  // ================================

  async initialize(): Promise<void> {
    if (this.initializing) return;
    this.initializing = true;

    console.log('🚀 Initializing Enhanced Redis with Vector Database capabilities...');
    try {
      await Promise.all([
        this.client.connect(),
        this.publisher.connect(),
        this.subscriber.connect(),
        this.vectorClient.connect()
      ]);
      await Promise.all(this.connectionPool.map(client => client.connect()));

      await this.initializeVectorDatabase();

      await this.setupEnhancedQueues();
      await this.createSearchIndexes();

      this.startPerformanceMonitoring();

      this.setConnectionState(RedisConnectionState.CONNECTED);
      this.isConnected = true;
      this.initializing = false;
      console.log('✅ Enhanced Redis Manager initialized successfully');
      this.emit('initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Enhanced Redis Manager:', error);
      this.initializing = false;
      throw error;
    }
  }

  private async initializeVectorDatabase(): Promise<void> {
    console.log('🧠 Initializing vector database capabilities...');
    try {
      this.redisSearchAvailable = false;
      try {
        const modules = await this.client.sendCommand(['MODULE', 'LIST']);
        this.redisSearchAvailable = this.checkRedisSearchAvailable(modules);
      } catch {
        this.redisSearchAvailable = false;
      }

      if (!this.redisSearchAvailable) {
        console.warn('⚠️ RediSearch module not available - using manual vector search fallback');
      } else {
        console.log('✅ RediSearch detected');
      }

      await this.createVectorIndexes();

      console.log('✅ Vector database initialized');
    } catch (error) {
      console.error('❌ Failed to initialize vector database:', error);
      this.redisSearchAvailable = false;
    }
  }

  private checkRedisSearchAvailable(modules: any): boolean {
    try {
      if (Array.isArray(modules)) {
        return modules.some(m =>
          (typeof m === 'string' && m.toLowerCase().includes('search')) ||
          (Array.isArray(m) && m.some(x => typeof x === 'string' && x.toLowerCase().includes('search')))
        );
      }
      if (typeof modules === 'string') return modules.toLowerCase().includes('search');
      return false;
    } catch {
      return false;
    }
  }

  // ================================
  // VECTOR SERIALIZATION (Float32)
  // ================================

  private serializeVector(vector: number[]): Buffer {
    const buf = Buffer.allocUnsafe(vector.length * 4);
    for (let i = 0; i < vector.length; i++) buf.writeFloatLE(vector[i], i * 4);
    return buf;
  }

  private deserializeVector(buffer: Buffer): number[] {
    const out: number[] = [];
    for (let i = 0; i < buffer.length; i += 4) out.push(buffer.readFloatLE(i));
    return out;
  }

  private async hgetBuffer(key: string, field: string): Promise<Buffer | null> {
    const res = await (this.vectorClient as any)
      .commandOptions({ returnBuffers: true })
      .sendCommand(['HGET', key, field]);
    return res ?? null;
  }

  // ================================
  // VECTOR DATABASE OPERATIONS
  // ================================

  async storeEmbedding(embedding: VectorEmbedding): Promise<void> {
    try {
      if (embedding.vector.length !== this.config.defaultVectorDimensions) {
        throw new Error(
          `Vector dim ${embedding.vector.length} != index DIM ${this.config.defaultVectorDimensions}`
        );
      }

      const key = `embedding:${embedding.id}`;
      const vectorBuffer = this.serializeVector(embedding.vector);
      await this.vectorClient.hSet(key, {
        vector_data: vectorBuffer as any,
        metadata: JSON.stringify(embedding.metadata),
        timestamp: embedding.timestamp.toString(),
        model: embedding.model,
        dimensions: embedding.dimensions.toString(),
        magnitude: (embedding.magnitude || 0).toString()
      });
      if (this.redisSearchAvailable) {
        await this.addToVectorIndex(embedding);
      }

      this.cacheMetrics.hits++;
      console.log(`📦 Stored embedding ${embedding.id} with ${embedding.dimensions} dimensions`);
    } catch (error) {
      console.error('❌ Failed to store embedding:', error);
      throw error;
    }
  }

  async getEmbedding(id: string): Promise<VectorEmbedding | null> {
    try {
      const key = `embedding:${id}`;
      const data = await this.vectorClient.hGetAll(key);

      if (!data || !('vector_data' in data)) {
        this.cacheMetrics.misses++;
        return null;
      }

      const dim = parseInt(data.dimensions || '0', 10);
      const vectorBuf = await this.hgetBuffer(key, 'vector_data');
      if (!vectorBuf || !dim) {
        this.cacheMetrics.misses++;
        return null;
      }

      const vector = this.deserializeVector(vectorBuf);
      this.cacheMetrics.hits++;
      return {
        id,
        vector,
        metadata: this.safeParseJSON(data.metadata || '{}'),
        timestamp: parseInt(data.timestamp || '0', 10),
        model: data.model || 'unknown',
        dimensions: dim,
        magnitude: parseFloat(data.magnitude || '0')
      };
    } catch (error) {
      console.error('❌ Failed to get embedding:', error);
      this.cacheMetrics.misses++;
      return null;
    }
  }

  async searchSimilarEmbeddings(
    queryVector: number[],
    options: VectorSearchOptions = {}
  ): Promise<VectorSearchResult[]> {
    try {
      if (this.redisSearchAvailable && this.vectorIndexes.has('embeddings')) {
        return await this.redisSearchVectorQuery(queryVector, options);
      }
      return await this.manualVectorSearch(queryVector, options);
    } catch (error) {
      console.error('❌ Failed to search similar embeddings:', error);
      return [];
    }
  }

  private async redisSearchVectorQuery(
    queryVector: number[],
    options: VectorSearchOptions
  ): Promise<VectorSearchResult[]> {
    const { topK = 10, includeMetadata = true } = options;
    const queryBuffer = this.serializeVector(queryVector);

    const cmd: (string | Buffer | number)[] = [
      'FT.SEARCH', 'embeddings',
      `*=>[KNN ${topK} @vector_data $vec AS score]`,
      'PARAMS', '2', 'vec', queryBuffer,
      'SORTBY', 'score',
      'RETURN', includeMetadata ? '2' : '1',
      ...(includeMetadata ? ['metadata', 'score'] : ['score']),
      'DIALECT', '2'
    ];
    const res = await (this.vectorClient as any)
      .commandOptions({ returnBuffers: true })
      .sendCommand(cmd);
    return this.processRedisSearchResults(res, options);
  }

  private processRedisSearchResults(results: any, options: VectorSearchOptions): VectorSearchResult[] {
    if (!Array.isArray(results) || results.length < 2) return [];
    const out: VectorSearchResult[] = [];
    for (let i = 1; i < results.length; i += 2) {
      const keyBuf = results[i] as Buffer;
      const fields = results[i + 1] as Buffer[];

      const id = keyBuf.toString().replace('embedding:', '');
      const entry: VectorSearchResult = { id, score: 0 };

      for (let j = 0; j < fields.length; j += 2) {
        const fname = fields[j].toString();
        const fval = fields[j + 1];

        if (fname === 'score') {
          entry.score = parseFloat(fval.toString());
        } else if (fname === 'metadata' && options.includeMetadata) {
          entry.metadata = this.safeParseJSON(fval.toString());
        }
      }
      out.push(entry);
    }

    return out;
  }

  private async manualVectorSearch(
    queryVector: number[],
    options: VectorSearchOptions
  ): Promise<VectorSearchResult[]> {
    const { topK = 10, threshold = 0.7, includeMetadata = true } = options;
    const results: VectorSearchResult[] = [];

    try {
      const keys = await this.vectorClient.keys('embedding:*');
      const batchSize = 50;
      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(async (key) => {
            const embeddingId = key.substring('embedding:'.length);
            const embedding = await this.getEmbedding(embeddingId);
            if (!embedding || embedding.vector.length !== queryVector.length) return null;

            const similarity = this.cosineSimilarity(queryVector, embedding.vector);
            if (similarity >= threshold) {
 
              return {
                id: embedding.id,
                score: similarity, // similarity in fallback
                vector: includeMetadata ? embedding.vector : undefined,
                metadata: includeMetadata ? embedding.metadata : undefined
      
              };
            }
            return null;
          })
        );
        results.push(...(batchResults.filter(Boolean) as VectorSearchResult[]));
      }

      return results.sort((a, b) => b.score - a.score).slice(0, topK);
    } catch (error) {
      console.error('❌ Manual vector search failed:', error);
      return [];
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i]; nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : (dot / denom);
  }

  private async createVectorIndexes(): Promise<void> {
    if (!this.redisSearchAvailable) {
      console.log('ℹ️ Skipping vector index creation - RediSearch not available');
      return;
    }

    try {
      const indexName = 'embeddings';
      try {
        await this.vectorClient.sendCommand([
          'FT.CREATE', indexName,
          'ON', 'HASH',
          'PREFIX', '1', 'embedding:',
          'SCHEMA',
          'vector_data', 'VECTOR', 'FLAT', '6',
          'TYPE', 'FLOAT32',
          'DIM', this.config.defaultVectorDimensions.toString(),
          'DISTANCE_METRIC', 'COSINE',
          'metadata', 'TEXT',
          'model', 'TAG'
        ]);
        this.vectorIndexes.add(indexName);
        console.log(`✅ Created vector index: ${indexName}`);
      } catch (error: any) {
        const msg = String(error?.message || '').toLowerCase();
        if (msg.includes('index already exists')) {
          this.vectorIndexes.add(indexName);
          console.log(`ℹ️ Vector index already exists: ${indexName}`);
        } else if (msg.includes('unknown command') || msg.includes('module')) {
          console.warn('⚠️ RediSearch unavailable; using manual vector search.');
        } else {
          console.warn('⚠️ Could not create vector index:', error?.message ?? error);
        }
      }
    } catch (error) {
      console.error('❌ Failed to create vector indexes:', error);
    }
  }

  private async addToVectorIndex(_embedding: VectorEmbedding): Promise<void> {
    try {
      const key = `embedding:${_embedding.id}`;
      await this.vectorClient.hSet(key, 'indexed', 'true');
    } catch (error) {
      console.error('❌ Failed to mark indexed flag:', error);
    }
  }

  // ================================
  // INTELLIGENT CACHING SYSTEM
  // ================================

  async smartCache<T>(
    key: string,
    fetchFunction: () => Promise<T>,
    policy: CachePolicy = { ttl: this.config.defaultTTL }
  ): Promise<T> {
    const cached = await this.getFromSmartCache<T>(key);
    if (cached !== null) {
      this.cacheMetrics.hits++;
      return cached;
    }
    this.cacheMetrics.misses++;
    const data = await fetchFunction();
    await this.setInSmartCache(key, data, policy);
    return data;
  }

  private async getFromSmartCache<T>(key: string): Promise<T | null> {
    try {
      const data = await this.client.get(key);
      if (!data) return null;

      if (data.startsWith('gzip:')) {
        const compressed = Buffer.from(data.slice(5), 'base64');
        const decompressed = await gunzipAsync(compressed);
        return JSON.parse(decompressed.toString());
      }
      return JSON.parse(data);
    } catch (error) {
      console.error('❌ Failed to get from smart cache:', error);
      return null;
    }
  }

  private async setInSmartCache<T>(
    key: string,
    data: T,
    policy: CachePolicy
  ): Promise<void> {
    try {
      let serialized = JSON.stringify(data);
      if (serialized.length > (policy.compressionThreshold || this.config.compressionThreshold)) {
        const compressed = await gzipAsync(serialized);
        serialized = 'gzip:' + compressed.toString('base64');
      }
      await this.client.setEx(key, policy.ttl, serialized);
    } catch (error) {
      console.error('❌ Failed to set in smart cache:', error);
    }
  }

  // ================================
  // LLM-SPECIFIC OPTIMIZATIONS
  // ================================

  async cacheEmbedding(embeddingId: string, vector: number[], metadata: any = {}): Promise<void> {
    const embedding: VectorEmbedding = {
      id: embeddingId,
      vector,
      metadata,
      timestamp: Date.now(),
      model: metadata.model || 'default',
      dimensions: vector.length,
      magnitude: Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0))
    };
    await this.storeEmbedding(embedding);
  }

  async getCachedEmbedding(embeddingId: string): Promise<number[] | null> {
    const embedding = await this.getEmbedding(embeddingId);
    return embedding ? embedding.vector : null;
  }

  async cacheContextWindow(
    userId: string,
    conversationId: string,
    context: any
  ): Promise<void> {
    const key = `context:${userId}:${conversationId}`;
    await this.smartCache(key, async () => context, { ttl: this.config.contextTTL });
  }

  async getCachedContext(userId: string, conversationId: string): Promise<any | null> {
    const key = `context:${userId}:${conversationId}`;
    return await this.getFromSmartCache(key);
  }

  async cacheModelResponse(
    queryHash: string,
    model: string,
    response: any,
    ttl: number = this.config.defaultTTL
  ): Promise<void> {
    const key = `model_response:${model}:${queryHash}`;
    await this.smartCache(key, async () => response, { ttl });
  }

  async getCachedModelResponse(queryHash: string, model: string): Promise<any | null> {
    const key = `model_response:${model}:${queryHash}`;
    return await this.getFromSmartCache(key);
  }

  // ================================
  // LEGACY / PROJECT INTEGRATION APIS
  // ================================

  // Older callers expect these to work with a single argument (we default the queue).
  async enqueueMessage(message: DinaUniversalMessage, queueName?: string): Promise<void> {
    if (!this.isConnected) {
      this.bufferMessage(message);
      return;
    }
    try {
      const q = queueName || this.defaultQueueFor(message);
      const serialized = JSON.stringify(message);
      await this.client.lPush(q, serialized);
      console.log(`📤 Enqueued message ${message.id} to ${q}`);
    } catch (error) {
      console.error('❌ Failed to enqueue message:', error);
      this.bufferMessage(message);
    }
  }

  // Support BRPOP when timeoutSeconds provided (e.g., 0.1)
  async dequeueMessage<T = DinaUniversalMessage>(queueName: string, timeoutSeconds?: number): Promise<T | null> {
    if (!this.isConnected) return null;
    try {
      if (timeoutSeconds !== undefined) {
        const result = await this.client.brPop(queueName, Math.max(0, Math.ceil(timeoutSeconds)));
        if (!result) return null;
        return JSON.parse(result.element) as T;
      } else {
        const payload = await this.client.rPop(queueName);
        // FIFO (LPUSH + RPOP)
        if (!payload) return null;
        return JSON.parse(payload) as T;
      }
    } catch (error) {
      console.error(`❌ Failed to dequeue from ${queueName}:`, error);
      return null;
    }
  }

  // Alias used by orchestrator
  async retrieveMessage<T = DinaUniversalMessage>(queueName: string, timeoutSeconds?: number): Promise<T | null> {
    return this.dequeueMessage<T>(queueName, timeoutSeconds);
  }

  // Publish a model response to a per-instance channel
  async publishResponse(instance: string, response: DinaResponse): Promise<void> {
    try {
      const channel = `response:${instance}`;
      await this.publisher.publish(channel, JSON.stringify(response));
    } catch (error) {
      console.error('❌ Failed to publish response:', error);
    }
  }

  // Subscribe/unsubscribe helpers used by WSS
  async subscribeToResponses(connectionId: string, handler: (response: DinaResponse) => void): Promise<void> {
    const channel = `response:${connectionId}`;
    if (this.subscriptionChannels.has(connectionId)) return; // already subscribed
    await this.subscriber.subscribe(channel, (payload) => {
      try {
        const parsed = JSON.parse(payload) as DinaResponse;
        handler(parsed);
      } catch (e) {
        console.error('❌ Failed to parse response payload:', e);
      }
    });
    this.subscriptionChannels.set(connectionId, channel);
  }

  async unsubscribeFromResponses(connectionId: string): Promise<void> {
    const channel = this.subscriptionChannels.get(connectionId);
    if (!channel) return;
    await this.subscriber.unsubscribe(channel);
    this.subscriptionChannels.delete(connectionId);
  }

  // Exact cache helpers
  async getExactCachedResponse(key: string): Promise<any | null> {
    if (!this.isConnected) return null;
    try {
      const serialized = await Promise.race([
        this.client.get(`cache:${key}`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Redis get timeout')), 2000)),
      ]);
      return serialized ? JSON.parse(serialized) : null;
    } catch {
      console.warn(`⚠️ Redis cache get timeout for key: ${key.substring(0, 50)}...`);
      return null;
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

  async clearAllExactCache(): Promise<void> {
      if (!this.isConnected) return;
      try {
        const keys = await this.client.keys('cache:*');
        if (keys.length > 0) {
          // Fix for TS2556: Use sendCommand to avoid the spread operator error.
          // It accepts an array of strings, which is a more robust approach.
          await this.client.sendCommand(['DEL', ...keys]);
          console.log(`🗑️ Cleared ${keys.length} cache entries (cache:*)`);
        }
      } catch (error) {
        console.error('❌ Failed to clear cache:', error);
      }
    }

  // Overloaded: with a queueName returns detailed stats;
  // without returns a map of queue depths
  async getQueueStats(queueName: string): Promise<QueueStats>;
  async getQueueStats(): Promise<Record<string, number>>;
  async getQueueStats(queueName?: string): Promise<QueueStats | Record<string, number>> {
    try {
      if (queueName) {
        const length = await this.client.lLen(queueName);
        return {
          length,
          processingCount: 0,
          errorCount: 0,
          lastProcessedAt: new Date()
        };
      } else {
        const queues = Object.values(QUEUE_NAMES) as string[];
        const entries = await Promise.all(
          queues.map(async (q) => [q, await this.client.lLen(q)] as const)
        );
        const map: Record<string, number> = {};
        for (const [q, len] of entries) map[q] = Number(len);
        return map;
      }
    } catch (error) {
      console.error('❌ Failed to get queue stats:', error);
      return queueName
        ? { length: 0, processingCount: 0, errorCount: 0 }
        : {};
    }
  }

  // ================================
  // PERFORMANCE MONITORING
  // ================================

  private startPerformanceMonitoring(): void {
    setInterval(() => {
      this.updatePerformanceMetrics();
      this.emit('performanceUpdate', this.cacheMetrics);
    }, 10000);
  }

  private async updatePerformanceMetrics(): Promise<void> {
    try {
      const info = await this.client.info('memory');
      const memoryMatch = info.match(/used_memory:(\d+)/);
      this.cacheMetrics.memoryUsage = memoryMatch ? parseInt(memoryMatch[1]) : 0;

      const total = this.cacheMetrics.hits + this.cacheMetrics.misses;
      const hitRate = total > 0 ? (this.cacheMetrics.hits / total) * 100 : 0;
      console.log(
        `📊 Cache Hit Rate: ${hitRate.toFixed(2)}%, Memory: ${this.formatBytes(this.cacheMetrics.memoryUsage)}`
      );
    } catch (error) {
      console.error('❌ Failed to update performance metrics:', error);
    }
  }

  private formatBytes(bytes: number): string {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
  }

  // ================================
  // UTILITY METHODS
  // ================================

  private setConnectionState(state: RedisConnectionState): void {
    const prev = this.connectionState;
    this.connectionState = state;
    if (prev !== state) {
      console.log(`🔄 Redis state: ${prev} → ${state}`);
      this.emit('stateChange', { from: prev, to: state });
    }
  }

  private async processMessageBuffer(): Promise<void> {
    if (this.messageBuffer.length === 0) return;
    console.log(`📤 Processing ${this.messageBuffer.length} buffered messages...`);
    const messages = [...this.messageBuffer];
    this.messageBuffer = [];
    for (const message of messages) {
      try {
        await this.processMessage(message);
      } catch (error) {
        console.error('❌ Failed to process buffered message:', error);
      }
    }
  }

  private bufferMessage(message: DinaUniversalMessage): void {
    if (this.messageBuffer.length >= this.maxBufferSize) {
      this.messageBuffer.shift();
      this.cacheMetrics.evictions++;
    }
    this.messageBuffer.push(message);
  }

  private async processMessage(message: DinaUniversalMessage): Promise<void> {
    console.log(`⚙️ Processing message ${message.id}`);
  }

  private defaultQueueFor(message: DinaUniversalMessage): string {
    // Best-effort default selection based on message content or enum presence
    const qNames = QUEUE_NAMES as any;
    return (message as any).queue
      || qNames?.UNIFIED
      || qNames?.DEFAULT
      || qNames?.INBOUND
      || 'dina:queue';
  }

  // ================================
  // ENHANCED QUEUE OPERATIONS
  // ================================

  private async setupEnhancedQueues(): Promise<void> {
    const queues = Object.values(QUEUE_NAMES) as string[];
    for (const queue of queues) {
      try {
        await this.client.del(queue);
        // actually clears the list
        console.log(`✅ Enhanced queue ${queue} ready`);
      } catch (error) {
        console.error(`❌ Failed to setup queue ${queue}:`, error);
      }
    }
  }

  // ================================
  // SEARCH INDEXES (non-vector)
  // ================================

  private async createSearchIndexes(): Promise<void> {
    if (!this.redisSearchAvailable) {
      console.log('ℹ️ Skipping search index creation - RediSearch not available');
      return;
    }

    const indexes = ['user_contexts', 'model_responses', 'conversation_history'];
    for (const indexName of indexes) {
      try {
        await this.createSpecificIndex(indexName);
      } catch (error) {
        console.error(`❌ Failed to create index ${indexName}:`, error);
      }
    }
  }

  private async createSpecificIndex(indexName: string): Promise<void> {
    try {
      await this.client.sendCommand([
        'FT.CREATE', indexName,
        'ON', 'HASH',
        'PREFIX', '1', `${indexName}:`,
        'SCHEMA',
        'content', 'TEXT',
        'timestamp', 'NUMERIC'
      ]);
      console.log(`🔍 Created search index: ${indexName}`);
    } catch (error: any) {
      if (error?.message && error.message.includes('Index already exists')) {
        console.log(`ℹ️ Search index already exists: ${indexName}`);
      } else {
        console.warn(`⚠️ Could not create index ${indexName}:`, error?.message ?? error);
      }
    }
  }

  // ================================
  // SHUTDOWN & CLEANUP
  // ================================

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down Enhanced Redis Manager...');
    try {
      await Promise.all([
        this.client.quit(),
        this.publisher.quit(),
        this.subscriber.quit(),
        this.vectorClient.quit(),
        ...this.connectionPool.map(client => client.quit())
      ]);
      this.isConnected = false;
      this.setConnectionState(RedisConnectionState.DISCONNECTED);
      console.log('✅ Enhanced Redis Manager shutdown complete');
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
    }
  }

  // ================================
  // HELPERS
  // ================================

  private safeParseJSON(jsonString: string): any {
    try { return JSON.parse(jsonString);
    } catch { return {}; }
  }
}

// ================================
// EXPORT ENHANCED MANAGER
// ================================

export const redisManager = new EnhancedDinaRedisManager();
// Auto-initialize on import
redisManager.initialize().catch(error => {
  console.error('❌ Failed to auto-initialize Redis manager:', error);
});

export default redisManager;
