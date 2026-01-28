// File: src/config/redis.ts - COMPLETE ENHANCED REDIS MANAGER WITH ALL ORIGINAL METHODS
// Preserves ALL existing functionality while adding persistence capabilities

import { createClient, RedisClientType, RedisClusterType } from 'redis';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import { DinaUniversalMessage, DinaResponse, QUEUE_NAMES } from '../core/protocol';
import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { DinaProtocol } from '../core/protocol';
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
  includeMetadata?: boolean;
  filters?: Record<string, any>;
}

export interface VectorSearchResult {
  id: string;
  score: number;
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
// PERSISTENCE INTERFACES
// ================================

interface PersistenceConfig {
  embeddingsPersistence: {
    enabled: boolean;
    filePath: string;
    backupInterval: number;
    maxFileSize: number;
    compressionLevel: number;
  };
  complexityPersistence: {
    enabled: boolean;
    filePath: string;
    maxEntries: number;
    validityPeriod: number;
  };
  queryPersistence: {
    enabled: boolean;
    filePath: string;
    maxEntries: number;
    validityPeriod: number;
  };
  intelligencePersistence: {
    enabled: boolean;
    filePath: string;
    performanceThreshold: number;
  };
}

interface PersistedEmbedding {
  id: string;
  vector: number[];
  metadata: Record<string, any>;
  model: string;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
  computationCost: number;
}

interface PersistedComplexity {
  queryHash: string;
  complexity: any;
  timestamp: number;
  hitCount: number;
  lastAccessed: number;
  validUntil: number;
}

interface PersistedQuery {
  queryHash: string;
  response: any;
  model: string;
  timestamp: number;
  accessCount: number;
  quality: number;
  tokens: number;
  processingTime: number;
}

// ================================
// ENHANCED REDIS MANAGER
// ================================

export class EnhancedDinaRedisManager extends EventEmitter {
  // Core Redis connections
  private client: RedisClientType;
  private publisher: RedisClientType;
  private subscriber: RedisClientType;
  private vectorClient: RedisClientType;

  // Cluster support
  private cluster?: RedisClusterType;
  private isClusterMode: boolean = false;

  // Connection state
  private connectionState: RedisConnectionState = RedisConnectionState.DISCONNECTED;
  public isConnected = false;
  private initializing = false;

  // Performance optimization
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
  private subscriptionChannels: Map<string, string> = new Map();

  // Persistence layer
  private persistenceConfig: PersistenceConfig;
  private persistedEmbeddings: Map<string, PersistedEmbedding> = new Map();
  private persistedComplexity: Map<string, PersistedComplexity> = new Map();
  private persistedQueries: Map<string, PersistedQuery> = new Map();
  private persistenceEnabled: boolean = true;
  private lastPersistenceBackup: number = 0;
  private persistenceMetrics = {
    embeddingsLoaded: 0,
    complexityLoaded: 0,
    queriesLoaded: 0,
    backupCount: 0,
    lastBackupTime: 0,
    diskSpaceUsed: 0
  };

  // Configuration
  private readonly config = {
    maxRetries: 5,
    retryDelay: 1000,
    commandTimeout: 30000,
    compressionThreshold: 1024,
    compressionLevel: 6,
    defaultTTL: 3600,
    embeddingTTL: 86400,
    contextTTL: 7200,
    batchSize: 100,
    pipelineThreshold: 10,
    defaultVectorDimensions: 1024,
    vectorSearchTimeout: 5000
  };

  constructor() {
    super();
    console.log('🚀 Initializing Enhanced DINA Redis Manager with Vector Database and Persistence capabilities...');
    
    // Load persistence configuration
    this.persistenceConfig = this.loadPersistenceConfig();
    
    // Initialize Redis clients
    this.client = this.createEnhancedClient('main');
    this.publisher = this.createEnhancedClient('publisher');
    this.subscriber = this.createEnhancedClient('subscriber');
    this.vectorClient = this.createEnhancedClient('vector');

    this.setupEventHandlers();
    this.initializeConnectionPool();
    this.startPerformanceMonitoring();
  }

  // ================================
  // PERSISTENCE CONFIGURATION
  // ================================

  private loadPersistenceConfig(): PersistenceConfig {
    const dataDir = process.env.DINA_DATA_DIR || './data/persistence';
    
    return {
      embeddingsPersistence: {
        enabled: process.env.REDIS_PERSIST_EMBEDDINGS !== 'false',
        filePath: join(dataDir, 'embeddings.backup'),
        backupInterval: parseInt(process.env.PERSISTENCE_BACKUP_INTERVAL || '300000'),
        maxFileSize: parseInt(process.env.PERSISTENCE_MAX_FILE_SIZE || '104857600'),
        compressionLevel: parseInt(process.env.PERSISTENCE_COMPRESSION_LEVEL || '6')
      },
      complexityPersistence: {
        enabled: process.env.REDIS_PERSIST_COMPLEXITY !== 'false',
        filePath: join(dataDir, 'complexity.backup'),
        maxEntries: parseInt(process.env.PERSISTENCE_COMPLEXITY_MAX_ENTRIES || '10000'),
        validityPeriod: parseInt(process.env.PERSISTENCE_COMPLEXITY_TTL || '86400000')
      },
      queryPersistence: {
        enabled: process.env.REDIS_PERSIST_QUERIES !== 'false',
        filePath: join(dataDir, 'queries.backup'),
        maxEntries: parseInt(process.env.PERSISTENCE_QUERY_MAX_ENTRIES || '5000'),
        validityPeriod: parseInt(process.env.PERSISTENCE_QUERY_TTL || '7200000')
      },
      intelligencePersistence: {
        enabled: process.env.REDIS_PERSIST_INTELLIGENCE !== 'false',
        filePath: join(dataDir, 'intelligence.backup'),
        performanceThreshold: parseInt(process.env.PERSISTENCE_MIN_PROCESSING_TIME || '1000')
      }
    };
  }

  // ================================
  // ENHANCED CONNECTION MANAGEMENT
  // ================================

  private createEnhancedClient(clientType: string): RedisClientType {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    console.log(`🔌 Creating ${clientType} Redis client: ${url}`);

    return createClient({
      url,
      socket: {
        connectTimeout: this.config.commandTimeout,
        reconnectStrategy: (retries) => {
          console.log(`🔄 Redis reconnect attempt ${retries} for ${clientType}`);
          return Math.min(retries * 100, 3000);
        }
      },
      database: parseInt(process.env.REDIS_DB || '0')
    });
  }

  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      console.log('✅ Main Redis client connected');
      this.setConnectionState(RedisConnectionState.CONNECTED);
    });

    this.client.on('error', (error) => {
      console.error('❌ Main Redis client error:', error);
      this.setConnectionState(RedisConnectionState.FAILED);
    });

    this.client.on('reconnecting', () => {
      console.log('🔄 Main Redis client reconnecting...');
      this.setConnectionState(RedisConnectionState.RECONNECTING);
    });

    this.subscriber.on('message', async (channel, message) => {
      try {
        const response: DinaResponse = JSON.parse(message);
        const handler = this.responseHandlers.get(response.request_id);
        if (handler) {
          handler(response);
          this.responseHandlers.delete(response.request_id);
        }
        this.emit('message', { channel, response });
      } catch (error) {
        console.error('❌ Failed to parse pub/sub message:', error);
      }
    });
  }

  private initializeConnectionPool(): void {
    console.log(`🏊 Initializing connection pool with ${this.poolSize} connections...`);
    for (let i = 0; i < this.poolSize; i++) {
      const poolClient = this.createEnhancedClient(`pool-${i}`);
      this.connectionPool.push(poolClient);
    }
  }

  private getPooledClient(): RedisClientType {
    const client = this.connectionPool[this.roundRobinIndex];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % this.poolSize;
    return client;
  }

  // ================================
  // INITIALIZATION WITH PERSISTENCE
  // ================================

  async initialize(): Promise<void> {
    if (this.initializing) {
      console.log('⏳ Redis Manager already initializing...');
      return;
    }
    if (this.isConnected) {
      console.log('✅ Redis Manager already initialized');
      return;
    }

    this.initializing = true;
    console.log('🚀 Starting Enhanced Redis Manager initialization...');

    try {
      this.setConnectionState(RedisConnectionState.CONNECTING);

      await Promise.all([
        this.client.connect(),
        this.publisher.connect(),
        this.subscriber.connect(),
        this.vectorClient.connect(),
        ...this.connectionPool.map(client => client.connect())
      ]);

      await this.initializePersistence();
      await this.checkRedisSearchAvailability();
      await this.createVectorIndexes();
      await this.createSearchIndexes();
      await this.setupEnhancedQueues();

      this.isConnected = true;
      this.setConnectionState(RedisConnectionState.CONNECTED);
      
      console.log('✅ Enhanced Redis Manager initialized successfully with persistence');
      this.emit('connected');

    } catch (error) {
      console.error('❌ Failed to initialize Enhanced Redis Manager:', error);
      this.setConnectionState(RedisConnectionState.FAILED);
      throw error;
    } finally {
      this.initializing = false;
    }
  }

  // ================================
  // PERSISTENCE INITIALIZATION
  // ================================

  private async initializePersistence(): Promise<void> {
    if (!this.persistenceEnabled) {
      console.log('⚠️ Persistence disabled by configuration');
      return;
    }

    console.log('💾 Initializing persistence layer...');
    
    try {
      const dataDir = dirname(this.persistenceConfig.embeddingsPersistence.filePath);
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
        console.log(`📁 Created persistence directory: ${dataDir}`);
      }

      await this.loadPersistedData();
      this.startPeriodicBackup();
      
      console.log('✅ Persistence layer initialized');
      console.log(`📊 Loaded: ${this.persistenceMetrics.embeddingsLoaded} embeddings, ${this.persistenceMetrics.complexityLoaded} complexity entries, ${this.persistenceMetrics.queriesLoaded} queries`);
      
    } catch (error) {
      console.error('❌ Failed to initialize persistence layer:', error);
      this.persistenceEnabled = false;
    }
  }

  private async loadPersistedData(): Promise<void> {
    console.log('📂 Loading persisted data from disk...');
    
    if (this.persistenceConfig.embeddingsPersistence.enabled) {
      await this.loadPersistedEmbeddings();
    }
    
    if (this.persistenceConfig.complexityPersistence.enabled) {
      await this.loadPersistedComplexity();
    }
    
    if (this.persistenceConfig.queryPersistence.enabled) {
      await this.loadPersistedQueries();
    }
  }

  private async loadPersistedEmbeddings(): Promise<void> {
    try {
      const filePath = this.persistenceConfig.embeddingsPersistence.filePath;
      if (!existsSync(filePath)) {
        console.log('📂 No persisted embeddings file found');
        return;
      }

      console.log('📂 Loading persisted embeddings...');
      const compressed = readFileSync(filePath);
      const decompressed = await gunzipAsync(compressed);
      const data = JSON.parse(decompressed.toString());
      
      let loadedCount = 0;
      const now = Date.now();
      
      for (const embedding of data.embeddings || []) {
        const age = now - embedding.timestamp;
        if (age < 7 * 24 * 60 * 60 * 1000) {
          this.persistedEmbeddings.set(embedding.id, embedding);
          
          await this.storeEmbedding({
            id: embedding.id,
            vector: embedding.vector,
            metadata: embedding.metadata,
            timestamp: embedding.timestamp,
            model: embedding.model,
            dimensions: embedding.vector.length,
            magnitude: Math.sqrt(embedding.vector.reduce((sum: number, val: number) => sum + val * val, 0))
          });
          
          loadedCount++;
        }
      }
      
      this.persistenceMetrics.embeddingsLoaded = loadedCount;
      console.log(`✅ Loaded ${loadedCount} persisted embeddings`);
      
    } catch (error) {
      console.error('❌ Failed to load persisted embeddings:', error);
    }
  }

  private async loadPersistedComplexity(): Promise<void> {
    try {
      const filePath = this.persistenceConfig.complexityPersistence.filePath;
      if (!existsSync(filePath)) {
        console.log('📂 No persisted complexity file found');
        return;
      }

      console.log('📂 Loading persisted complexity analysis...');
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      
      let loadedCount = 0;
      const now = Date.now();
      
      for (const entry of data.complexity || []) {
        if (entry.validUntil > now) {
          this.persistedComplexity.set(entry.queryHash, entry);
          loadedCount++;
        }
      }
      
      this.persistenceMetrics.complexityLoaded = loadedCount;
      console.log(`✅ Loaded ${loadedCount} persisted complexity entries`);
      
    } catch (error) {
      console.error('❌ Failed to load persisted complexity:', error);
    }
  }

  private async loadPersistedQueries(): Promise<void> {
    try {
      const filePath = this.persistenceConfig.queryPersistence.filePath;
      if (!existsSync(filePath)) {
        console.log('📂 No persisted queries file found');
        return;
      }

      console.log('📂 Loading persisted queries...');
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      
      let loadedCount = 0;
      const now = Date.now();
      const validityPeriod = this.persistenceConfig.queryPersistence.validityPeriod;
      
      for (const query of data.queries || []) {
        const age = now - query.timestamp;
        if (age < validityPeriod && query.quality > 0.7) {
          this.persistedQueries.set(query.queryHash, query);
          
          await this.setExactCachedResponse(
            `llm:query:${query.queryHash}`,
            query.response,
            Math.floor(validityPeriod / 1000)
          );
          
          loadedCount++;
        }
      }
      
      this.persistenceMetrics.queriesLoaded = loadedCount;
      console.log(`✅ Loaded ${loadedCount} persisted queries`);
      
    } catch (error) {
      console.error('❌ Failed to load persisted queries:', error);
    }
  }

  // ================================
  // REDISEARCH AVAILABILITY CHECK
  // ================================

  private async checkRedisSearchAvailability(): Promise<void> {
    try {
      await this.client.sendCommand(['FT._LIST']);
      this.redisSearchAvailable = true;
      console.log('✅ RediSearch module detected and available');
    } catch (error) {
      this.redisSearchAvailable = false;
      console.log('ℹ️ RediSearch module not available - using manual vector search fallback');
    }
  }

  // ================================
  // VECTOR OPERATIONS
  // ================================

  private serializeVector(vector: number[]): Buffer {
    const buffer = Buffer.allocUnsafe(vector.length * 4);
    for (let i = 0; i < vector.length; i++) {
      buffer.writeFloatLE(vector[i], i * 4);
    }
    return buffer;
  }

  private deserializeVector(buffer: Buffer): number[] {
    const vector: number[] = [];
    for (let i = 0; i < buffer.length; i += 4) {
      vector.push(buffer.readFloatLE(i));
    }
    return vector;
  }

  private async hgetBuffer(key: string, field: string): Promise<Buffer | null> {
    try {
      const result = await this.client.hGet(key, field);
      if (result === null || result === undefined) {
        return null;
      }
      if (typeof result === 'string') {
        return Buffer.from(result, 'binary');
      }
      if (Buffer.isBuffer(result)) {
        return result;
      }
      return Buffer.from(String(result), 'binary');
    } catch (error) {
      console.error('❌ Failed to get buffer from hash:', error);
      return null;
    }
  }

  private async createVectorIndexes(): Promise<void> {
    if (!this.redisSearchAvailable) {
      console.log('ℹ️ Skipping vector index creation - RediSearch not available');
      return;
    }

    try {
      const indexName = 'embeddings';
      await this.client.sendCommand([
        'FT.CREATE', indexName,
        'ON', 'HASH',
        'PREFIX', '1', 'embedding:',
        'SCHEMA',
        'vector_data', 'VECTOR', 'FLAT', '6',
        'TYPE', 'FLOAT32',
        'DIM', this.config.defaultVectorDimensions.toString(),
        'DISTANCE_METRIC', 'COSINE',
        'metadata', 'TEXT',
        'model', 'TEXT',
        'timestamp', 'NUMERIC'
      ]);
      
      this.vectorIndexes.add(indexName);
      console.log(`🔍 Created vector index: ${indexName}`);
      
    } catch (error: any) {
      if (error?.message && error.message.includes('Index already exists')) {
        console.log('ℹ️ Vector index already exists');
        this.vectorIndexes.add('embeddings');
      } else {
        console.warn('⚠️ Could not create vector index:', error?.message ?? error);
      }
    }
  }

  private async addToVectorIndex(embedding: VectorEmbedding): Promise<void> {
    try {
      const key = `embedding:${embedding.id}`;
      await this.vectorClient.hSet(key, 'indexed', 'true');
    } catch (error) {
      console.error('❌ Failed to mark indexed flag:', error);
    }
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
        vector_data: vectorBuffer,
        metadata: JSON.stringify(embedding.metadata),
        timestamp: embedding.timestamp.toString(),
        model: embedding.model,
        dimensions: embedding.dimensions.toString(),
        magnitude: (embedding.magnitude || 0).toString()
      });
      
      if (this.redisSearchAvailable) {
        await this.addToVectorIndex(embedding);
      }

      if (this.persistenceEnabled && this.persistenceConfig.embeddingsPersistence.enabled) {
        const persistedEmbedding: PersistedEmbedding = {
          id: embedding.id,
          vector: embedding.vector,
          metadata: embedding.metadata,
          model: embedding.model,
          timestamp: embedding.timestamp,
          accessCount: 1,
          lastAccessed: Date.now(),
          computationCost: this.estimateEmbeddingCost(embedding)
        };
        
        this.persistedEmbeddings.set(embedding.id, persistedEmbedding);
        console.log(`💾 Embedding ${embedding.id} marked for persistence`);
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

  // ================================
  // ENHANCED CACHING WITH PERSISTENCE
  // ================================

  async cacheComplexityAnalysis(queryHash: string, complexity: any): Promise<void> {
    if (!this.persistenceEnabled || !this.persistenceConfig.complexityPersistence.enabled) {
      return;
    }

    const entry: PersistedComplexity = {
      queryHash,
      complexity,
      timestamp: Date.now(),
      hitCount: 1,
      lastAccessed: Date.now(),
      validUntil: Date.now() + this.persistenceConfig.complexityPersistence.validityPeriod
    };

    this.persistedComplexity.set(queryHash, entry);
    console.log(`🧠 Complexity analysis cached for query hash: ${queryHash}`);
  }

  async getComplexityFromCache(queryHash: string): Promise<any | null> {
    const entry = this.persistedComplexity.get(queryHash);
    if (!entry || entry.validUntil < Date.now()) {
      return null;
    }

    entry.hitCount++;
    entry.lastAccessed = Date.now();
    this.persistedComplexity.set(queryHash, entry);

    console.log(`⚡ Complexity cache hit for query hash: ${queryHash} (hits: ${entry.hitCount})`);
    return entry.complexity;
  }

  async cacheHighValueQuery(queryHash: string, response: any, metadata: {
    model: string;
    quality: number;
    tokens: number;
    processingTime: number;
  }): Promise<void> {
    if (!this.persistenceEnabled || !this.persistenceConfig.queryPersistence.enabled) {
      return;
    }

    if (metadata.quality > 0.8 && metadata.processingTime > this.persistenceConfig.intelligencePersistence.performanceThreshold) {
      const entry: PersistedQuery = {
        queryHash,
        response,
        model: metadata.model,
        timestamp: Date.now(),
        accessCount: 1,
        quality: metadata.quality,
        tokens: metadata.tokens,
        processingTime: metadata.processingTime
      };

      this.persistedQueries.set(queryHash, entry);
      console.log(`💎 High-value query cached: ${queryHash} (quality: ${metadata.quality})`);
    }
  }

  async getPersistedQuery(queryHash: string): Promise<any | null> {
    const entry = this.persistedQueries.get(queryHash);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > this.persistenceConfig.queryPersistence.validityPeriod) {
      this.persistedQueries.delete(queryHash);
      return null;
    }

    entry.accessCount++;
    this.persistedQueries.set(queryHash, entry);
    
    return entry;
  }

  // ================================
  // ORIGINAL CACHE METHODS (PRESERVED EXACTLY)
  // ================================

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
        await this.client.sendCommand(['DEL', ...keys]);
        console.log(`🗑️ Cleared ${keys.length} cache entries (cache:*)`);
      }
    } catch (error) {
      console.error('❌ Failed to clear cache:', error);
    }
  }

  // ================================
  // ORIGINAL LLM-SPECIFIC OPTIMIZATIONS (PRESERVED)
  // ================================

  async cacheEmbedding(embeddingId: string, vector: number[], metadata: any = {}): Promise<void> {
    const embedding: VectorEmbedding = {
      id: embeddingId,
      vector,
      metadata,
      timestamp: Date.now(),
      model: metadata.model || 'default',
      dimensions: vector.length,
      magnitude: Math.sqrt(vector.reduce((sum: number, val: number) => sum + val * val, 0))
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
  // ORIGINAL MESSAGE QUEUE OPERATIONS (PRESERVED)
  // ================================

  async enqueueMessage(message: DinaUniversalMessage, queueName?: string): Promise<void> {
    if (!this.isConnected) {
      this.bufferMessage(message);
      return;
    }
  
    try {
      const systemLoad = 0; // TODO: real load metric
      const q = queueName || DinaProtocol.getQueueName(message, systemLoad);
  
      if (!Object.values(QUEUE_NAMES).includes(q as any)) {
        throw new Error(`Invalid queue resolved: ${q}`);
      }
  
      const serialized = JSON.stringify(message);
      await this.client.lPush(q, serialized);
  
      console.log(`📤 Enqueued message ${message.id} → ${q}`);
    } catch (error) {
      console.error('❌ Failed to enqueue message:', error);
      this.bufferMessage(message);
    }
  }

  async dequeueMessage<T = DinaUniversalMessage>(queueName: string, timeoutSeconds?: number): Promise<T | null> {
    if (!this.isConnected) return null;
    try {
      if (timeoutSeconds !== undefined) {
        const result = await this.client.brPop(queueName, Math.max(0, Math.ceil(timeoutSeconds)));
        if (!result) return null;
        return JSON.parse(result.element) as T;
      } else {
        const payload = await this.client.rPop(queueName);
        if (!payload) return null;
        return JSON.parse(payload) as T;
      }
    } catch (error) {
      console.error(`❌ Failed to dequeue from ${queueName}:`, error);
      return null;
    }
  }

  // ORIGINAL: Alias used by orchestrator
  async retrieveMessage<T = DinaUniversalMessage>(queueName: string, timeoutSeconds?: number): Promise<T | null> {
    return this.dequeueMessage<T>(queueName, timeoutSeconds);
  }

  // ORIGINAL: Publish a model response to a per-instance channel
  async publishResponse(instance: string, response: DinaResponse): Promise<void> {
    try {
      const channel = `response:${instance}`;
      await this.publisher.publish(channel, JSON.stringify(response));
    } catch (error) {
      console.error('❌ Failed to publish response:', error);
    }
  }

  // ORIGINAL: Subscribe/unsubscribe helpers used by WSS
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

  async waitForResponse(requestId: string, timeout: number = 30000): Promise<DinaResponse | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.responseHandlers.delete(requestId);
        resolve(null);
      }, timeout);

      this.responseHandlers.set(requestId, (response: DinaResponse) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  // Overloaded queue stats methods
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
  // ENHANCED QUEUE OPERATIONS
  // ================================

  private async setupEnhancedQueues(): Promise<void> {
    const queues = Object.values(QUEUE_NAMES) as string[];
    for (const queue of queues) {
      try {
        await this.client.del(queue);
        console.log(`✅ Enhanced queue ${queue} ready`);
      } catch (error) {
        console.error(`❌ Failed to setup queue ${queue}:`, error);
      }
    }
  }

  // ================================
  // PERIODIC BACKUP
  // ================================

  private startPeriodicBackup(): void {
    const backupInterval = this.persistenceConfig.embeddingsPersistence.backupInterval;
    
    setInterval(async () => {
      await this.performBackup();
    }, backupInterval);

    console.log(`⏰ Periodic backup scheduled every ${backupInterval / 1000} seconds`);
  }

  private async performBackup(): Promise<void> {
    if (!this.persistenceEnabled) return;

    const startTime = Date.now();
    console.log('💾 Starting periodic backup...');

    try {
      await Promise.all([
        this.backupEmbeddings(),
        this.backupComplexity(),
        this.backupQueries()
      ]);

      this.persistenceMetrics.backupCount++;
      this.persistenceMetrics.lastBackupTime = Date.now();
      
      const duration = Date.now() - startTime;
      console.log(`✅ Backup completed in ${duration}ms`);
      
    } catch (error) {
      console.error('❌ Backup failed:', error);
    }
  }

  private async backupEmbeddings(): Promise<void> {
    if (!this.persistenceConfig.embeddingsPersistence.enabled) return;

    try {
      const data = {
        version: '1.0',
        timestamp: Date.now(),
        embeddings: Array.from(this.persistedEmbeddings.values())
      };

      const json = JSON.stringify(data);
      const compressed = await gzipAsync(json);
      
      if (compressed.length > this.persistenceConfig.embeddingsPersistence.maxFileSize) {
        console.warn('⚠️ Embeddings backup size exceeds limit, cleaning old entries...');
        await this.cleanOldEmbeddings();
        
        const cleanedData = {
          version: '1.0',
          timestamp: Date.now(),
          embeddings: Array.from(this.persistedEmbeddings.values())
        };
        const cleanedJson = JSON.stringify(cleanedData);
        const cleanedCompressed = await gzipAsync(cleanedJson);
        writeFileSync(this.persistenceConfig.embeddingsPersistence.filePath, cleanedCompressed);
      } else {
        writeFileSync(this.persistenceConfig.embeddingsPersistence.filePath, compressed);
      }

      console.log(`💾 Embeddings backed up: ${this.persistedEmbeddings.size} entries`);
      
    } catch (error) {
      console.error('❌ Failed to backup embeddings:', error);
    }
  }

  private async backupComplexity(): Promise<void> {
    if (!this.persistenceConfig.complexityPersistence.enabled) return;

    try {
      const now = Date.now();
      for (const [hash, entry] of this.persistedComplexity.entries()) {
        if (entry.validUntil < now) {
          this.persistedComplexity.delete(hash);
        }
      }

      const data = {
        version: '1.0',
        timestamp: Date.now(),
        complexity: Array.from(this.persistedComplexity.values())
      };

      writeFileSync(this.persistenceConfig.complexityPersistence.filePath, JSON.stringify(data));
      console.log(`🧠 Complexity analysis backed up: ${this.persistedComplexity.size} entries`);
      
    } catch (error) {
      console.error('❌ Failed to backup complexity:', error);
    }
  }

  private async backupQueries(): Promise<void> {
    if (!this.persistenceConfig.queryPersistence.enabled) return;

    try {
      const now = Date.now();
      const validityPeriod = this.persistenceConfig.queryPersistence.validityPeriod;
      
      for (const [hash, query] of this.persistedQueries.entries()) {
        const age = now - query.timestamp;
        if (age > validityPeriod || query.quality < 0.7) {
          this.persistedQueries.delete(hash);
        }
      }

      const data = {
        version: '1.0',
        timestamp: Date.now(),
        queries: Array.from(this.persistedQueries.values())
      };

      writeFileSync(this.persistenceConfig.queryPersistence.filePath, JSON.stringify(data));
      console.log(`💎 Queries backed up: ${this.persistedQueries.size} entries`);
      
    } catch (error) {
      console.error('❌ Failed to backup queries:', error);
    }
  }

  // ================================
  // CLEANUP AND OPTIMIZATION
  // ================================

  private async cleanOldEmbeddings(): Promise<void> {
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    
    let cleaned = 0;
    for (const [id, embedding] of this.persistedEmbeddings.entries()) {
      const age = now - embedding.timestamp;
      
      if (age > maxAge && embedding.accessCount < 5) {
        this.persistedEmbeddings.delete(id);
        cleaned++;
      }
    }
    
    console.log(`🧹 Cleaned ${cleaned} old embeddings`);
  }

  private estimateEmbeddingCost(embedding: VectorEmbedding): number {
    const baseCost = 100;
    const dimensionCost = embedding.dimensions * 0.1;
    const modelCost = embedding.model.includes('large') ? 200 : 100;
    
    return baseCost + dimensionCost + modelCost;
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
  // MONITORING AND METRICS
  // ================================

  getPersistenceMetrics(): any {
    const diskSpaceUsed = this.calculateDiskSpaceUsed();
    
    return {
      ...this.persistenceMetrics,
      diskSpaceUsed,
      embeddingsCached: this.persistedEmbeddings.size,
      complexityCached: this.persistedComplexity.size,
      queriesCached: this.persistedQueries.size,
      persistenceEnabled: this.persistenceEnabled,
      config: {
        embeddingsEnabled: this.persistenceConfig.embeddingsPersistence.enabled,
        complexityEnabled: this.persistenceConfig.complexityPersistence.enabled,
        queriesEnabled: this.persistenceConfig.queryPersistence.enabled
      }
    };
  }

  private calculateDiskSpaceUsed(): number {
    try {
      let totalSize = 0;
      
      const files = [
        this.persistenceConfig.embeddingsPersistence.filePath,
        this.persistenceConfig.complexityPersistence.filePath,
        this.persistenceConfig.queryPersistence.filePath
      ];
      
      for (const file of files) {
        if (existsSync(file)) {
          totalSize += statSync(file).size;
        }
      }
      
      return totalSize;
    } catch (error) {
      return 0;
    }
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

  //private defaultQueueFor(message: DinaUniversalMessage): string {
  //  const qNames = QUEUE_NAMES as any;
  //  return (message as any).queue
  //    || qNames?.UNIFIED
  //    || qNames?.DEFAULT
  //    || qNames?.INBOUND
  //    || 'dina:queue';
  //}

  private safeParseJSON(jsonString: string): any {
    try { 
      return JSON.parse(jsonString);
    } catch { 
      return {};
    }
  }

  // ================================
  // HEALTH CHECK METHOD
  // ================================

  async ping(): Promise<string> {
    try {
      if (!this.isConnected) {
        throw new Error('Redis not connected');
      }
      const result = await this.client.ping();
      return result;
    } catch (error) {
      console.error('❌ Redis ping failed:', error);
      throw error;
    }
  }

  // ================================
  // SHUTDOWN & CLEANUP
  // ================================

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down Enhanced Redis Manager with final backup...');
    
    try {
      if (this.persistenceEnabled) {
        await this.performBackup();
      }

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
}

// ================================
// WARM STARTUP HELPER
// ================================

export class WarmStartupManager {
  private redisManager: EnhancedDinaRedisManager;
  
  constructor(redisManager: EnhancedDinaRedisManager) {
    this.redisManager = redisManager;
  }

  async performWarmStartup(): Promise<void> {
    console.log('🔥 Initiating warm startup sequence...');
    
    const startTime = Date.now();
    
    try {
      await this.preloadCriticalEmbeddings();
      await this.preloadComplexityAnalysis();
      await this.preloadFrequentQueries();
      
      const duration = Date.now() - startTime;
      console.log(`✅ Warm startup completed in ${duration}ms`);
      
    } catch (error) {
      console.error('❌ Warm startup failed:', error);
    }
  }

  private async preloadCriticalEmbeddings(): Promise<void> {
    console.log('🔥 Preloading critical embeddings...');
  }

  private async preloadComplexityAnalysis(): Promise<void> {
    console.log('🔥 Preloading complexity analysis...');
  }

  private async preloadFrequentQueries(): Promise<void> {
    console.log('🔥 Preloading frequent queries...');
  }
}

// ================================
// EXPORT ENHANCED MANAGER
// ================================

export const redisManager = new EnhancedDinaRedisManager();

redisManager.initialize().then(async () => {
  const warmStartup = new WarmStartupManager(redisManager);
  await warmStartup.performWarmStartup();
}).catch(error => {
  console.error('❌ Failed to auto-initialize Redis manager:', error);
});

export default redisManager;
