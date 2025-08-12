// ================================================================
// DINA Mirror Module - API-Based Storage Manager
// ================================================================
// Uses HTTP API calls to mirror-server instead of direct imports
// Maintains security, efficiency, modularity, and scalability

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';

// Core imports (dina-server only)
import { database as DB } from '../../../config/database/db';
import { redisManager } from '../../../config/redis';

// Type imports
import {
  ProcessedMirrorData,
  UserContext,
  MirrorInsight,
  DetectedPattern,
  StorageResult,
  StorageMetadata
} from '../types';

/**
 * MIRROR STORAGE MANAGER - API-BASED SECURE STORAGE
 * 
 * KEY ARCHITECTURE CHANGES:
 * - Uses HTTP API calls to mirror-server for encryption/directory operations
 * - Maintains all security, efficiency, modularity, scalability principles
 * - No direct imports from mirror-server controllers
 * 
 * RESPONSIBILITIES:
 * 1. API communication with mirror-server for secure storage operations
 * 2. Context management and user embedding storage in dina-server
 * 3. Cached metadata for personalization
 * 4. Insight and pattern storage with retrieval optimization
 * 5. User feedback storage and integration
 */
export class MirrorStorageManager extends EventEmitter {
  private redisManager: typeof import('../../../config/redis').redisManager;
  private initialized: boolean = false;
  private mirrorServerUrl: string;

  // Storage configuration
  private readonly STORAGE_VERSION = '2.0.0';
  private readonly CACHE_TTL = 3600; // 1 hour cache TTL
  private readonly MAX_CONTEXT_SIZE = 50000; // Maximum context size in tokens

  // Cache keys
  private readonly CACHE_KEYS = {
    USER_CONTEXT: (userId: string) => `mirror:context:${userId}`,
    USER_EMBEDDINGS: (userId: string) => `mirror:embeddings:${userId}`,
    USER_INSIGHTS: (userId: string) => `mirror:insights:${userId}`,
    USER_PATTERNS: (userId: string) => `mirror:patterns:${userId}`,
    USER_METADATA: (userId: string) => `mirror:metadata:${userId}`
  } as const;

    constructor() {
    super();
    console.log('💾 Initializing API-Based Mirror Storage Manager...');
    
    this.redisManager = redisManager;
    // FIXED: Use the correct mirror-server URL
    this.mirrorServerUrl = process.env.MIRROR_SERVER_URL || 'https://www.theundergroundrailroad.world';
    this.setupEventHandlers();
  }

  // ================================================================
  // INITIALIZATION
  // ================================================================

  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('✅ Mirror Storage Manager already initialized');
      return;
    }

    try {
      console.log('🔧 Initializing API-based storage systems...');

      // Verify database tables exist
      await this.verifyStorageSchema();

      // Initialize Redis connection
      //await this.redisManager.initialize();

      // Test connection to mirror-server
      //await this.testMirrorServerConnection();

      // Set up cache cleanup
      this.setupCacheCleanup();

      this.initialized = true;
      console.log('✅ API-Based Mirror Storage Manager initialized successfully');
      
      this.emit('initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Mirror Storage Manager:', error);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    this.on('dataStored', (data) => {
      console.log(`📦 Data stored: ${data.type} for user ${data.userId}`);
    });

    this.on('contextUpdated', (data) => {
      console.log(`🧠 Context updated for user ${data.userId}`);
    });

    this.on('cacheInvalidated', (data) => {
      console.log(`🗑️ Cache invalidated: ${data.key}`);
    });
  }

  // ================================================================
  // MIRROR-SERVER API COMMUNICATION
  // ================================================================

  /**
   * Test connection to mirror-server
   */
  private async testMirrorServerConnection(): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
  
      const response = await fetch(`${this.mirrorServerUrl}/mirror/api/debug/status`, {
        method: 'GET',
        signal: controller.signal as any // FIXED: Type assertion
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`Mirror server health check failed: ${response.status}`);
      }
      
      console.log('✅ Mirror server connection verified');
    } catch (error) {
      // FIXED: Type-safe error handling
      if (error instanceof Error) {
        console.error('❌ Failed to connect to mirror-server:', error.message);
        throw new Error(`Cannot connect to mirror-server at ${this.mirrorServerUrl}: ${error.message}`);
      } else {
        console.error('❌ Failed to connect to mirror-server:', error);
        throw new Error(`Cannot connect to mirror-server at ${this.mirrorServerUrl}`);
      }
    }
  }

  /**
   * Make authenticated API call to mirror-server
   */
  private async callMirrorServerAPI(endpoint: string, method: string, data?: any): Promise<any> {
    try {
      const url = `${this.mirrorServerUrl}${endpoint}`;
      console.log(`🔗 Mirror API Call: ${method} ${url}`);
      
      const options: any = {
        method,
        headers: {
          'Content-Type': 'application/json',
          // TODO: Add authentication when needed
          // 'Authorization': `Bearer ${process.env.MIRROR_SERVER_API_KEY || 'development-key'}`
        }
      };
  
      // Add body for POST requests
      if (data && method !== 'GET') {
        options.body = JSON.stringify(data);
      }
  
      // Create AbortController for timeout (FIXED)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 30000); // 30 second timeout
  
      // Add signal to options (FIXED - use type assertion)
      options.signal = controller.signal as any;
  
      const response = await fetch(url, options);
      clearTimeout(timeoutId);
  
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Mirror API Error: ${response.status} - ${errorText}`);
      }
  
      const result = await response.json();
      console.log(`✅ Mirror API Success: ${endpoint}`);
      return result;
      
    } catch (error) {
      // FIXED: Type-safe error handling
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Mirror server timeout after 30 seconds`);
        }
        console.error(`❌ Mirror API Failed: ${endpoint}`, error.message);
        throw new Error(`Cannot connect to mirror-server at ${this.mirrorServerUrl}: ${error.message}`);
      } else {
        console.error(`❌ Mirror API Failed: ${endpoint}`, error);
        throw new Error(`Unknown error connecting to mirror-server`);
      }
    }
  }

  // ================================================================
  // SECURE DATA STORAGE (API-BASED)
  // ================================================================

  /**
   * Securely store processed Mirror data using API calls
   */
  async securelyStoreData(
    processedData: ProcessedMirrorData,
    contextData: any,
    userId: string
  ): Promise<StorageResult> {
    const startTime = performance.now();
    console.log(`💾 Securely storing data for user ${userId} via API`);

    try {
      // Ensure user directories exist via API
      await this.ensureUserDirectoriesAPI(userId);

      // Store embeddings securely via API
      await this.storeUserEmbeddingsAPI(userId, processedData);

      // Store/update user context (local to dina-server)
      await this.storeUserContext(userId, contextData, processedData);

      // Store cached metadata for quick retrieval (local)
      await this.storeCachedMetadata(userId, processedData);

      // Store files in tiered storage via API
      await this.storeDataFilesAPI(userId, processedData);

      const processingTime = performance.now() - startTime;
      console.log(`✅ Data securely stored via API in ${processingTime.toFixed(2)}ms`);

      this.emit('dataStored', {
        userId,
        submissionId: processedData.submissionId,
        type: 'processed_data',
        processingTime
      });

      return {
        success: true,
        dataId: processedData.submissionId,
        metadata: {
          contentType: 'processed_mirror_data',
          size: JSON.stringify(processedData).length,
          checksum: this.generateChecksum(processedData),
          createdAt: new Date(),
          accessLevel: 'user_private',
          tags: ['mirror', 'processed', processedData.submissionType]
        }
      };

    } catch (error) {
      console.error(`❌ Error securely storing data for user ${userId}:`, error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown storage error'
      };
    }
  }

  /**
   * Ensure user directories exist via mirror-server API
   */
  private async ensureUserDirectoriesAPI(userId: string): Promise<void> {
    try {
      await this.callMirrorServerAPI('/mirror/api/storage/directories/create', 'POST', {
        userId
      });
      console.log(`✅ User directories ensured for ${userId}`);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`❌ Failed to ensure directories for user ${userId}:`, error.message);
        throw error;
      } else {
        console.error(`❌ Failed to ensure directories for user ${userId}:`, error);
        throw new Error(`Failed to ensure directories for user ${userId}`);
      }
    }
  }

  /**
   * Store user embeddings via mirror-server API
   */
  private async storeUserEmbeddingsAPI(userId: string, data: ProcessedMirrorData): Promise<void> {
    console.log(`🔢 Storing embeddings for user ${userId} via API`);
  
    try {
      const embeddings = {
        facial: data.facialData.facialEmbedding,
        voice: data.voiceData.voiceEmbedding,
        cognitive: data.cognitiveData.cognitiveEmbedding,
        astrological: data.astrologicalData.astrologicalEmbedding,
        personality: data.personalityData.personalityEmbedding,
        timestamp: new Date(),
        submissionId: data.submissionId
      };
  
      // Store in encrypted tier storage via API
      await this.callMirrorServerAPI('/mirror/api/storage/store', 'POST', {
        userId,
        tier: 'tier3', // Highest security for embeddings
        filename: `embeddings_${data.submissionId}.json`,
        data: embeddings,
        metadata: {
          reason: 'embedding_storage',
          dataType: 'embeddings'
        }
      });
  
      // Cache latest embeddings in Redis for quick access
      await this.redisManager.setExactCachedResponse(
        this.CACHE_KEYS.USER_EMBEDDINGS(userId),
        embeddings,
        this.CACHE_TTL
      );
  
      console.log(`✅ Embeddings stored via API for user ${userId}`);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`❌ Error storing embeddings for user ${userId}:`, error.message);
        throw error;
      } else {
        console.error(`❌ Error storing embeddings for user ${userId}:`, error);
        throw new Error(`Failed to store embeddings for user ${userId}`);
      }
    }
  }

  /**
   * Store data files via mirror-server API
   */
  private async storeDataFilesAPI(userId: string, data: ProcessedMirrorData): Promise<void> {
    console.log(`📁 Storing data files for user ${userId} via API`);

    try {
      // Store complete processed data as backup
      await this.callMirrorServerAPI('/storage/store', 'POST', {
        userId,
        tier: 'tier2',
        filename: `processed_data_${data.submissionId}.json`,
        data: data,
        metadata: {
          reason: 'backup_storage',
          dataType: 'complete_processed_data'
        }
      });

      // Store specific modality data separately for targeted access
      const modalityFiles = [
        { name: `facial_${data.submissionId}.json`, data: data.facialData, type: 'facial' },
        { name: `voice_${data.submissionId}.json`, data: data.voiceData, type: 'voice' },
        { name: `cognitive_${data.submissionId}.json`, data: data.cognitiveData, type: 'cognitive' },
        { name: `astrological_${data.submissionId}.json`, data: data.astrologicalData, type: 'astrological' },
        { name: `personality_${data.submissionId}.json`, data: data.personalityData, type: 'personality' }
      ];

      // Process modality files in parallel for efficiency
      const storePromises = modalityFiles.map(async (file) => {
        if (file.data) {
          return await this.callMirrorServerAPI('/storage/store', 'POST', {
            userId,
            tier: 'tier2', // Encrypted storage for modality data
            filename: file.name,
            data: file.data,
            metadata: {
              reason: 'modality_storage',
              dataType: file.type
            }
          });
        }
        return null;
      });

      await Promise.all(storePromises);

      console.log(`✅ Data files stored via API for user ${userId}`);
    } catch (error) {
      console.error(`❌ Error storing data files for user ${userId}:`, error);
      throw error;
    }
  }

  // ================================================================
  // LOCAL CONTEXT MANAGEMENT (DINA-SERVER)
  // ================================================================

  /**
   * Store and update user context (local to dina-server)
   */
  private async storeUserContext(
    userId: string, 
    contextData: any, 
    processedData: ProcessedMirrorData
  ): Promise<void> {
    console.log(`🧠 Storing/updating context for user ${userId}`);

    try {
      // Get existing context or create new
      let userContext = await this.getUserContext(userId);
      
      if (!userContext) {
        userContext = await this.createInitialUserContext(userId);
      }

      // Update context with new data
      userContext = await this.updateContextWithNewData(userContext, processedData, contextData);

      // Optimize context size if needed
      if (userContext.contextSizeTokens > this.MAX_CONTEXT_SIZE) {
        userContext = await this.optimizeContext(userContext);
      }

      // Store updated context in database
      await this.saveUserContextToDatabase(userContext);

      // Cache context in Redis
      await this.redisManager.setExactCachedResponse(
        this.CACHE_KEYS.USER_CONTEXT(userId),
        userContext,
        this.CACHE_TTL
      );

      this.emit('contextUpdated', { userId, contextVersion: userContext.contextVersion });

      console.log(`✅ Context updated for user ${userId}`);
    } catch (error) {
      console.error(`❌ Error storing context for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Store cached metadata for personalization (local)
   */
  private async storeCachedMetadata(userId: string, data: ProcessedMirrorData): Promise<void> {
    console.log(`📋 Storing cached metadata for user ${userId}`);

    try {
      const metadata = {
        userId,
        submissionId: data.submissionId,
        submissionType: data.submissionType,
        timestamp: data.submissionTimestamp,
        dataQuality: data.dataQualityAssessment.overallQuality,
        modalityQuality: data.dataQualityAssessment.modalityQuality,
        processingTime: data.processingMetadata.processingTime,
        confidenceLevel: data.processingMetadata.confidenceLevel,
        
        // Quick access insights
        dominantEmotion: data.facialData.emotionAnalysis.dominantEmotion,
        personalityType: data.personalityData.mbtiType,
        cognitiveStrengths: data.cognitiveData.cognitiveProfile.cognitiveStrengths,
        astrologicalThemes: data.astrologicalData.synthesis.dominantThemes,
        
        // Modality flags
        hasHighQualityFacial: data.dataQualityAssessment.modalityQuality.facial > 0.8,
        hasHighQualityVoice: data.dataQualityAssessment.modalityQuality.voice > 0.8,
        hasHighQualityCognitive: data.dataQualityAssessment.modalityQuality.cognitive > 0.8,
        
        lastUpdated: new Date()
      };

      // Store in Redis for quick access
      await this.redisManager.setExactCachedResponse(
        this.CACHE_KEYS.USER_METADATA(userId),
        metadata,
        this.CACHE_TTL * 24 // Longer TTL for metadata
      );

      // Also store in database for persistence
      await DB.query(`
        INSERT INTO mirror_user_metadata (
          user_id, submission_id, metadata_type, metadata_content, created_at
        ) VALUES (?, ?, 'cached_metadata', ?, NOW())
        ON DUPLICATE KEY UPDATE 
        metadata_content = VALUES(metadata_content), 
        updated_at = NOW()
      `, [userId, data.submissionId, JSON.stringify(metadata)]);

      console.log(`✅ Cached metadata stored for user ${userId}`);
    } catch (error) {
      console.error(`❌ Error storing cached metadata for user ${userId}:`, error);
      throw error;
    }
  }

  // ================================================================
  // INSIGHT STORAGE AND RETRIEVAL (LOCAL)
  // ================================================================

  /**
   * Store generated insights
   */
  async storeInsight(insight: MirrorInsight): Promise<StorageResult> {
    console.log(`💡 Storing insight ${insight.insightId} for user ${insight.userId}`);

    try {
      await DB.query(`
        INSERT INTO mirror_generated_insights (
          id, user_id, submission_id, insight_text, insight_summary,
          insight_type, confidence_score, relevance_score, novelty_score,
          actionability_score, source_modalities, source_data_ids,
          contributing_patterns, temporal_context, cross_modal_correlations,
          pattern_references, processing_time_ms, model_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [
        insight.insightId, insight.userId, insight.submissionId,
        insight.insightText, insight.insightSummary, insight.insightType,
        insight.confidenceScore, insight.relevanceScore, insight.noveltyScore,
        insight.actionabilityScore, JSON.stringify(insight.sourceModalities),
        JSON.stringify(insight.sourceDataIds), JSON.stringify(insight.contributingPatterns),
        JSON.stringify(insight.temporalContext), JSON.stringify(insight.crossModalCorrelations),
        JSON.stringify(insight.patternReferences), insight.processingTime,
        insight.modelVersion
      ]);

      // Cache recent insights
      await this.cacheRecentInsights(insight.userId, insight);

      this.emit('dataStored', {
        userId: insight.userId,
        type: 'insight',
        insightId: insight.insightId
      });

      return {
        success: true,
        dataId: insight.insightId
      };

    } catch (error) {
      console.error(`❌ Error storing insight:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Retrieve user insights with filtering and pagination
   */
  async getUserInsights(
    userId: string,
    options: {
      limit?: number;
      offset?: number;
      insightType?: string;
      minConfidence?: number;
      dateRange?: { start: Date; end: Date };
    } = {}
  ): Promise<MirrorInsight[]> {
    console.log(`📊 Retrieving insights for user ${userId}`);

    try {
      // Check cache first
      const cacheKey = `${this.CACHE_KEYS.USER_INSIGHTS(userId)}:${JSON.stringify(options)}`;
      const cached = await this.redisManager.getExactCachedResponse(cacheKey);
      
      if (cached) {
        console.log(`✅ Retrieved insights from cache for user ${userId}`);
        return cached as MirrorInsight[];
      }

      // Build query with filters
      let query = `
        SELECT * FROM mirror_generated_insights 
        WHERE user_id = ?
      `;
      const params: any[] = [userId];

      if (options.insightType) {
        query += ` AND insight_type = ?`;
        params.push(options.insightType);
      }

      if (options.minConfidence) {
        query += ` AND confidence_score >= ?`;
        params.push(options.minConfidence);
      }

      if (options.dateRange) {
        query += ` AND created_at BETWEEN ? AND ?`;
        params.push(options.dateRange.start, options.dateRange.end);
      }

      query += ` ORDER BY created_at DESC`;

      if (options.limit) {
        query += ` LIMIT ?`;
        params.push(options.limit);
      }

      if (options.offset) {
        query += ` OFFSET ?`;
        params.push(options.offset);
      }

      const results = await DB.query(query, params);

      // Convert database results to MirrorInsight objects
      const insights: MirrorInsight[] = results.map((row: any) => ({
        insightId: row.id,
        userId: row.user_id,
        submissionId: row.submission_id,
        insightText: row.insight_text,
        insightSummary: row.insight_summary,
        insightType: row.insight_type,
        category: row.insight_type,
        confidenceScore: row.confidence_score,
        relevanceScore: row.relevance_score,
        noveltyScore: row.novelty_score,
        actionabilityScore: row.actionability_score,
        sourceModalities: JSON.parse(row.source_modalities || '[]'),
        sourceDataIds: JSON.parse(row.source_data_ids || '[]'),
        contributingPatterns: JSON.parse(row.contributing_patterns || '[]'),
        temporalContext: JSON.parse(row.temporal_context || '{}'),
        crossModalCorrelations: JSON.parse(row.cross_modal_correlations || '{}'),
        patternReferences: JSON.parse(row.pattern_references || '{}'),
        userFeedbackScore: row.user_feedback_score,
        userFeedbackText: row.user_feedback_text,
        feedbackTimestamp: row.feedback_timestamp,
        createdAt: row.created_at,
        deliveredAt: row.delivered_at,
        readAt: row.read_at,
        processingTime: row.processing_time_ms,
        modelVersion: row.model_version
      }));

      // Cache results for future requests
      await this.redisManager.setExactCachedResponse(cacheKey, insights, this.CACHE_TTL / 2);

      console.log(`✅ Retrieved ${insights.length} insights for user ${userId}`);
      return insights;

    } catch (error) {
      console.error(`❌ Error retrieving insights for user ${userId}:`, error);
      throw error;
    }
  }

  // ================================================================
  // RETRIEVAL METHODS (API-BASED)
  // ================================================================

  /**
   * Retrieve modality-specific data via API
   */
  async getModalityData(
    userId: string, 
    submissionId: string, 
    modality: string
  ): Promise<any | null> {
    try {
      // Try cache first
      const cacheKey = `mirror:modality:${userId}:${submissionId}:${modality}`;
      const cached = await this.redisManager.getExactCachedResponse(cacheKey);
      
      if (cached) {
        return cached;
      }

      // Retrieve from mirror-server via API
      const data = await this.callMirrorServerAPI('/storage/retrieve', 'POST', {
        userId,
        tier: 'tier2',
        filename: `${modality}_${submissionId}.json`
      });
      
      if (data) {
        // Cache for quick access
        await this.redisManager.setExactCachedResponse(cacheKey, data, this.CACHE_TTL);
        return data;
      }

      return null;
    } catch (error) {
      console.error(`❌ Error retrieving modality data:`, error);
      return null;
    }
  }

  /**
   * Retrieve user embeddings via API
   */
  async getUserEmbeddings(userId: string, submissionId?: string): Promise<any | null> {
    try {
      // Check cache first
      const cached = await this.redisManager.getExactCachedResponse(this.CACHE_KEYS.USER_EMBEDDINGS(userId));
      
      if (cached && !submissionId) {
        return cached;
      }

      if (submissionId) {
        const data = await this.callMirrorServerAPI('/storage/retrieve', 'POST', {
          userId,
          tier: 'tier3',
          filename: `embeddings_${submissionId}.json`
        });
        return data;
      }

      return cached || null;
    } catch (error) {
      console.error(`❌ Error retrieving user embeddings:`, error);
      return null;
    }
  }

  // ================================================================
  // PATTERN STORAGE (LOCAL)
  // ================================================================

  /**
   * Store detected patterns
   */
  async storePatterns(userId: string, patterns: DetectedPattern[]): Promise<void> {
    console.log(`🔍 Storing ${patterns.length} patterns for user ${userId}`);

    try {
      for (const pattern of patterns) {
        await DB.query(`
          INSERT INTO mirror_cross_modal_patterns (
            id, user_id, submission_id, pattern_type, pattern_name,
            pattern_description, source_modalities, correlation_strength,
            statistical_significance, pattern_data, confidence_level,
            pattern_stability, first_detected, last_confirmed,
            occurrence_frequency, psychological_significance,
            behavioral_implications, development_recommendations,
            detection_method, algorithm_version, processing_time_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          pattern.patternId, userId, (pattern as any).submissionId || null,
          pattern.patternType, pattern.patternName, pattern.description,
          JSON.stringify(pattern.sourceModalities), pattern.correlationStrength,
          pattern.statisticalSignificance, JSON.stringify(pattern.patternData),
          pattern.confidence, pattern.stability, pattern.firstDetected,
          pattern.lastConfirmed, pattern.occurrenceFrequency,
          pattern.psychologicalSignificance, JSON.stringify(pattern.behavioralImplications),
          JSON.stringify(pattern.developmentRecommendations), pattern.detectionMethod,
          pattern.algorithmVersion, pattern.processingTime
        ]);
      }

      // Cache recent patterns
      await this.cacheRecentPatterns(userId, patterns);

      this.emit('dataStored', {
        userId,
        type: 'patterns',
        count: patterns.length
      });

      console.log(`✅ Stored ${patterns.length} patterns for user ${userId}`);
    } catch (error) {
      console.error(`❌ Error storing patterns for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Store cross-modal correlations
   */
  async storeCorrelations(userId: string, correlations: any[]): Promise<void> {
    console.log(`🔗 Storing ${correlations.length} correlations for user ${userId}`);

    try {
      // Store correlations as patterns with specific type
      const correlationPatterns: DetectedPattern[] = correlations.map(corr => ({
        patternId: uuidv4(),
        userId,
        patternType: 'correlation',
        patternName: `${corr.modality1}_${corr.modality2}_correlation`,
        description: corr.description,
        sourceModalities: [corr.modality1, corr.modality2],
        correlationStrength: corr.strength,
        statisticalSignificance: corr.significance,
        confidence: corr.confidence,
        patternData: corr,
        supportingEvidence: {},
        stability: 'stable',
        firstDetected: new Date(),
        lastConfirmed: new Date(),
        occurrenceFrequency: 1,
        psychologicalSignificance: corr.description,
        behavioralImplications: {},
        developmentRecommendations: [],
        detectionMethod: 'cross_modal_analysis',
        algorithmVersion: this.STORAGE_VERSION,
        processingTime: 0
      }));

      await this.storePatterns(userId, correlationPatterns);

      console.log(`✅ Stored ${correlations.length} correlations for user ${userId}`);
    } catch (error) {
      console.error(`❌ Error storing correlations for user ${userId}:`, error);
      throw error;
    }
  }

  // ================================================================
  // UTILITY METHODS
  // ================================================================

  /**
   * Get user context from cache or database
   */
  async getUserContext(userId: string): Promise<UserContext | null> {
    try {
      // Check cache first
      const cached = await this.redisManager.getExactCachedResponse(this.CACHE_KEYS.USER_CONTEXT(userId));
      if (cached) {
        return cached as UserContext;
      }

      // Get from database
      const results = await DB.query(`
        SELECT * FROM mirror_user_context WHERE user_id = ?
      `, [userId]);

      if (results.length === 0) {
        return null;
      }

      const row = results[0];
      const context: UserContext = {
        userId,
        contextVersion: row.context_version,
        lastUpdated: row.last_updated,
        activeContext: JSON.parse(row.active_context),
        contextSummary: row.context_summary,
        contextSizeTokens: row.context_size_tokens,
        compressionRatio: row.context_compression_ratio,
        relevanceThreshold: row.relevance_threshold,
        activePatterns: JSON.parse(row.active_patterns || '[]'),
        patternConfidence: JSON.parse(row.pattern_confidence || '{}'),
        temporalWindow: {
          windowDays: row.temporal_window_days,
          granularity: 'daily',
          seasonalFactors: [],
          cyclicalPatterns: [],
          timeSeriesData: []
        },
        temporalPatterns: JSON.parse(row.temporal_patterns || '[]'),
        cyclicalInfluences: JSON.parse(row.cyclical_influences || '[]'),
        modalityWeights: JSON.parse(row.modality_weights || '{}'),
        correlationMatrix: JSON.parse(row.correlation_matrix || '{}'),
        userPreferences: {
          insightTypes: [],
          notificationFrequency: 'daily',
          analysisDepth: 'medium',
          privacyLevel: 'balanced',
          communicationStyle: 'gentle',
          focusAreas: []
        },
        behavioralPatterns: [],
        feedbackHistory: []
      };

      // Cache for future requests
      await this.redisManager.setExactCachedResponse(
        this.CACHE_KEYS.USER_CONTEXT(userId),
        context,
        this.CACHE_TTL
      );

      return context;

    } catch (error) {
      console.error(`❌ Error getting user context for ${userId}:`, error);
      return null;
    }
  }

  /**
   * Create initial user context
   */
  private async createInitialUserContext(userId: string): Promise<UserContext> {
    const initialContext: UserContext = {
      userId,
      contextVersion: 1,
      lastUpdated: new Date(),
      activeContext: {
        timeSpan: 30,
        submissions: [],
        insights: [],
        patterns: [],
        keyEvents: []
      },
      contextSummary: 'Initial user context',
      contextSizeTokens: 0,
      compressionRatio: 1.0,
      relevanceThreshold: 0.7,
      activePatterns: [],
      patternConfidence: {},
      temporalWindow: {
        windowDays: 30,
        granularity: 'daily',
        seasonalFactors: [],
        cyclicalPatterns: [],
        timeSeriesData: []
      },
      temporalPatterns: [],
      cyclicalInfluences: [],
      modalityWeights: {
        facial: 0.2,
        voice: 0.2,
        cognitive: 0.2,
        astrological: 0.2,
        personality: 0.2
      },
      correlationMatrix: {
        facial_voice: 0,
        facial_cognitive: 0,
        facial_astrological: 0,
        facial_personality: 0,
        voice_cognitive: 0,
        voice_astrological: 0,
        voice_personality: 0,
        cognitive_astrological: 0,
        cognitive_personality: 0,
        astrological_personality: 0
      },
      userPreferences: {
        insightTypes: [],
        notificationFrequency: 'daily',
        analysisDepth: 'medium',
        privacyLevel: 'balanced',
        communicationStyle: 'gentle',
        focusAreas: []
      },
      behavioralPatterns: [],
      feedbackHistory: []
    };

    return initialContext;
  }

  /**
   * Update context with new processed data
   */
  private async updateContextWithNewData(
    context: UserContext,
    processedData: ProcessedMirrorData,
    contextData: any
  ): Promise<UserContext> {
    // Update context version
    context.contextVersion += 1;
    context.lastUpdated = new Date();

    // Add new submission to active context
    context.activeContext.submissions.push({
      submissionId: processedData.submissionId,
      timestamp: processedData.submissionTimestamp,
      dataTypes: ['facial', 'voice', 'cognitive', 'astrological', 'personality'],
      importance: processedData.dataQualityAssessment.overallQuality,
      summary: `Submission with ${processedData.dataQualityAssessment.overallQuality.toFixed(2)} quality`
    });

    // Update modality weights based on data quality
    const qualityWeights = processedData.dataQualityAssessment.modalityQuality;
    const totalWeight = Object.values(qualityWeights).reduce((sum, weight) => sum + weight, 0);
    
    for (const [modality, quality] of Object.entries(qualityWeights)) {
      context.modalityWeights[modality] = quality / totalWeight;
    }

    // Update correlation matrix with new correlations
    for (const correlation of processedData.modalityCorrelations) {
      const key = `${correlation.modality1}_${correlation.modality2}` as keyof typeof context.correlationMatrix;
      if (key in context.correlationMatrix) {
        // Use weighted average with existing correlations
        context.correlationMatrix[key] = 
          (context.correlationMatrix[key] * 0.7) + (correlation.strength * 0.3);
      }
    }

    // Trim old submissions to maintain context size
    if (context.activeContext.submissions.length > 50) {
      context.activeContext.submissions = context.activeContext.submissions
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, 50);
    }

    // Update context size estimation
    context.contextSizeTokens = this.estimateContextTokens(context);

    return context;
  }

  /**
   * Optimize context size by compression and relevance filtering
   */
  private async optimizeContext(context: UserContext): Promise<UserContext> {
    console.log(`🔧 Optimizing context for user ${context.userId}`);

    // Sort submissions by importance and recency
    context.activeContext.submissions.sort((a, b) => {
      const scoreA = a.importance * 0.7 + (Date.now() - a.timestamp.getTime()) / (1000 * 60 * 60 * 24) * 0.3;
      const scoreB = b.importance * 0.7 + (Date.now() - b.timestamp.getTime()) / (1000 * 60 * 60 * 24) * 0.3;
      return scoreB - scoreA;
    });

    // Keep only the most relevant submissions
    const targetSubmissions = Math.floor(this.MAX_CONTEXT_SIZE / 1000); // Rough estimate
    context.activeContext.submissions = context.activeContext.submissions.slice(0, targetSubmissions);

    // Update context summary
    context.contextSummary = this.generateContextSummary(context);

    // Update compression ratio
    const originalSize = context.contextSizeTokens;
    context.contextSizeTokens = this.estimateContextTokens(context);
    context.compressionRatio = context.contextSizeTokens / originalSize;

    console.log(`✅ Context optimized: ${originalSize} -> ${context.contextSizeTokens} tokens`);

    return context;
  }

  /**
   * Save user context to database
   */
  private async saveUserContextToDatabase(context: UserContext): Promise<void> {
    try {
      await DB.query(`
        INSERT INTO mirror_user_context (
          user_id, active_context, context_summary, context_size_tokens,
          context_compression_ratio, relevance_threshold, active_patterns,
          pattern_confidence, temporal_window_days, temporal_patterns,
          cyclical_influences, modality_weights, correlation_matrix,
          context_version, last_updated, next_optimization_due
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))
        ON DUPLICATE KEY UPDATE
        active_context = VALUES(active_context),
        context_summary = VALUES(context_summary),
        context_size_tokens = VALUES(context_size_tokens),
        context_compression_ratio = VALUES(context_compression_ratio),
        relevance_threshold = VALUES(relevance_threshold),
        active_patterns = VALUES(active_patterns),
        pattern_confidence = VALUES(pattern_confidence),
        temporal_window_days = VALUES(temporal_window_days),
        temporal_patterns = VALUES(temporal_patterns),
        cyclical_influences = VALUES(cyclical_influences),
        modality_weights = VALUES(modality_weights),
        correlation_matrix = VALUES(correlation_matrix),
        context_version = VALUES(context_version),
        last_updated = VALUES(last_updated),
        next_optimization_due = VALUES(next_optimization_due)
      `, [
        context.userId, JSON.stringify(context.activeContext), context.contextSummary,
        context.contextSizeTokens, context.compressionRatio, context.relevanceThreshold,
        JSON.stringify(context.activePatterns), JSON.stringify(context.patternConfidence),
        context.temporalWindow.windowDays, JSON.stringify(context.temporalPatterns),
        JSON.stringify(context.cyclicalInfluences), JSON.stringify(context.modalityWeights),
        JSON.stringify(context.correlationMatrix), context.contextVersion, context.lastUpdated
      ]);
    } catch (error) {
      console.error(`❌ Error saving user context to database:`, error);
      throw error;
    }
  }

  private async cacheRecentInsights(userId: string, insight: MirrorInsight): Promise<void> {
    const cacheKey = this.CACHE_KEYS.USER_INSIGHTS(userId);
    
    try {
      const existing = await this.redisManager.getExactCachedResponse(cacheKey);
      const insights = existing ? (existing as MirrorInsight[]) : [];
      
      insights.unshift(insight);
      
      // Keep only last 20 insights in cache
      const recentInsights = insights.slice(0, 20);
      
      await this.redisManager.setExactCachedResponse(cacheKey, recentInsights, this.CACHE_TTL);
    } catch (error) {
      console.error('❌ Error caching recent insights:', error);
    }
  }

  private async cacheRecentPatterns(userId: string, patterns: DetectedPattern[]): Promise<void> {
    const cacheKey = this.CACHE_KEYS.USER_PATTERNS(userId);
    
    try {
      const existing = await this.redisManager.getExactCachedResponse(cacheKey);
      const existingPatterns = existing ? (existing as DetectedPattern[]) : [];
      
      const allPatterns = [...patterns, ...existingPatterns];
      
      // Keep only last 50 patterns in cache
      const recentPatterns = allPatterns.slice(0, 50);
      
      await this.redisManager.setExactCachedResponse(cacheKey, recentPatterns, this.CACHE_TTL);
    } catch (error) {
      console.error('❌ Error caching recent patterns:', error);
    }
  }

  private async invalidateUserCaches(userId: string): Promise<void> {
    try {
      // Clear specific user caches (we use clearAllExactCache since we can't target specific keys easily)
      await this.redisManager.clearAllExactCache();

      this.emit('cacheInvalidated', { userId, action: 'full_cache_clear' });
    } catch (error) {
      console.error('❌ Error invalidating user caches:', error);
    }
  }

  private generateChecksum(data: any): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
  }

  private estimateContextTokens(context: UserContext): number {
    // Rough estimation based on JSON string length
    const contextString = JSON.stringify(context.activeContext);
    return Math.ceil(contextString.length / 4); // Rough token estimation
  }

  private generateContextSummary(context: UserContext): string {
    const submissionCount = context.activeContext.submissions.length;
    const avgQuality = context.activeContext.submissions.reduce(
      (sum, sub) => sum + sub.importance, 0
    ) / submissionCount;

    return `User context with ${submissionCount} submissions, avg quality ${avgQuality.toFixed(2)}`;
  }

  private async verifyStorageSchema(): Promise<void> {
    console.log('🔍 Verifying storage schema...');
    
    try {
      // Check if required tables exist
      const requiredTables = [
        'mirror_generated_insights',
        'mirror_cross_modal_patterns',
        'mirror_generated_questions',
        'mirror_user_feedback',
        'mirror_user_context',
        'mirror_user_metadata'
      ];

      for (const table of requiredTables) {
        const exists = await DB.query(
          `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_name = ?`,
          [table]
        );
        
        if (exists[0].count === 0) {
          console.warn(`⚠️ Table ${table} does not exist. Please run migrations.`);
        }
      }

      console.log('✅ Storage schema verification complete');
    } catch (error) {
      console.error('❌ Error verifying storage schema:', error);
      throw error;
    }
  }

  private setupCacheCleanup(): void {
    // Set up periodic cache cleanup
    setInterval(async () => {
      try {
        // Clean up expired cache entries
        // This is handled automatically by Redis TTL, but we could add custom logic here
        console.log('🧹 Cache cleanup completed');
      } catch (error) {
        console.error('❌ Error during cache cleanup:', error);
      }
    }, 3600000); // Every hour
  }

  // ================================================================
  // FEEDBACK STORAGE AND INTEGRATION
  // ================================================================

  /**
   * Store user feedback
   */
  async storeFeedback(userId: string, feedbackData: {
    targetId: string;
    targetType: 'insight' | 'question' | 'pattern';
    feedbackType: 'rating' | 'correction' | 'additional_context';
    feedbackScore?: number;
    feedbackText?: string;
    correctionText?: string;
  }): Promise<void> {
    console.log(`📝 Storing feedback from user ${userId}`);

    try {
      await DB.query(`
        INSERT INTO mirror_user_feedback (
          id, user_id, feedback_type, target_type, target_id,
          feedback_score, feedback_text, correction_text,
          provided_at, feedback_method
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'direct')
      `, [
        uuidv4(), userId, feedbackData.feedbackType, feedbackData.targetType,
        feedbackData.targetId, feedbackData.feedbackScore || null,
        feedbackData.feedbackText || null, feedbackData.correctionText || null
      ]);

      // Update target item with feedback if it's a rating
      if (feedbackData.feedbackType === 'rating' && feedbackData.feedbackScore) {
        await this.updateTargetWithFeedback(
          feedbackData.targetType,
          feedbackData.targetId,
          feedbackData.feedbackScore,
          feedbackData.feedbackText
        );
      }

      // Invalidate relevant caches
      await this.invalidateUserCaches(userId);

      this.emit('dataStored', {
        userId,
        type: 'feedback',
        targetType: feedbackData.targetType,
        targetId: feedbackData.targetId
      });

      console.log(`✅ Feedback stored for user ${userId}`);
    } catch (error) {
      console.error(`❌ Error storing feedback for user ${userId}:`, error);
      throw error;
    }
  }

  private async updateTargetWithFeedback(
    targetType: string,
    targetId: string,
    score: number,
    text?: string
  ): Promise<void> {
    try {
      if (targetType === 'insight') {
        await DB.query(`
          UPDATE mirror_generated_insights 
          SET user_feedback_score = ?, user_feedback_text = ?, feedback_timestamp = NOW()
          WHERE id = ?
        `, [score, text || null, targetId]);
      }
      // Add other target types as needed
    } catch (error) {
      console.error(`❌ Error updating target with feedback:`, error);
    }
  }

  /**
   * Store generated questions
   */
  async storeQuestions(userId: string, questions: any[]): Promise<void> {
    console.log(`❓ Storing ${questions.length} questions for user ${userId}`);

    try {
      for (const question of questions) {
        await DB.query(`
          INSERT INTO mirror_generated_questions (
            id, user_id, submission_id, question_text, question_type,
            question_category, triggered_by_modalities, related_insights,
            context_data, relevance_score, engagement_potential,
            information_value, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
          question.questionId || uuidv4(), userId, question.submissionId || null,
          question.questionText, question.questionType, question.category,
          JSON.stringify(question.triggeredByModalities || []),
          JSON.stringify(question.relatedInsights || []),
          JSON.stringify(question.contextData || {}),
          question.relevanceScore || 0.5, question.engagementPotential || 0.5,
          question.informationValue || 0.5
        ]);
      }

      this.emit('dataStored', {
        userId,
        type: 'questions',
        count: questions.length
      });

      console.log(`✅ Stored ${questions.length} questions for user ${userId}`);
    } catch (error) {
      console.error(`❌ Error storing questions for user ${userId}:`, error);
      throw error;
    }
  }

  // ================================================================
  // PATTERN RETRIEVAL
  // ================================================================

  /**
   * Get user patterns with filtering
   */
  async getUserPatterns(
    userId: string,
    options: {
      patternType?: string;
      minConfidence?: number;
      limit?: number;
    } = {}
  ): Promise<DetectedPattern[]> {
    try {
      let query = `
        SELECT * FROM mirror_cross_modal_patterns 
        WHERE user_id = ?
      `;
      const params: any[] = [userId];

      if (options.patternType) {
        query += ` AND pattern_type = ?`;
        params.push(options.patternType);
      }

      if (options.minConfidence) {
        query += ` AND confidence_level >= ?`;
        params.push(options.minConfidence);
      }

      query += ` ORDER BY last_confirmed DESC`;

      if (options.limit) {
        query += ` LIMIT ?`;
        params.push(options.limit);
      }

      const results = await DB.query(query, params);

      return results.map((row: any) => ({
        patternId: row.id,
        userId: row.user_id,
        submissionId: row.submission_id,
        patternType: row.pattern_type,
        patternName: row.pattern_name,
        description: row.pattern_description,
        sourceModalities: JSON.parse(row.source_modalities || '[]'),
        correlationStrength: row.correlation_strength,
        statisticalSignificance: row.statistical_significance,
        confidence: row.confidence_level,
        patternData: JSON.parse(row.pattern_data || '{}'),
        supportingEvidence: {},
        stability: row.pattern_stability,
        firstDetected: row.first_detected,
        lastConfirmed: row.last_confirmed,
        occurrenceFrequency: row.occurrence_frequency,
        psychologicalSignificance: row.psychological_significance,
        behavioralImplications: JSON.parse(row.behavioral_implications || '{}'),
        developmentRecommendations: JSON.parse(row.development_recommendations || '[]'),
        detectionMethod: row.detection_method,
        algorithmVersion: row.algorithm_version,
        processingTime: row.processing_time_ms
      }));
    } catch (error) {
      console.error(`❌ Error retrieving user patterns:`, error);
      return [];
    }
  }

  // ================================================================
  // HEALTH CHECK AND SHUTDOWN
  // ================================================================

  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'critical';
    details: Record<string, any>;
  }> {
    try {
      // Check database connectivity
      await DB.query('SELECT 1');
      
      // Check Redis connectivity
      const redisConnected = this.redisManager.isConnected;

      // Check mirror-server connectivity
      let mirrorServerHealthy = false;
      try {
        await this.testMirrorServerConnection();
        mirrorServerHealthy = true;
      } catch (error) {
        console.warn('⚠️ Mirror server connection failed during health check');
      }

      const status = redisConnected && mirrorServerHealthy ? 'healthy' : 'degraded';

      return {
        status,
        details: {
          database: 'healthy',
          redis: redisConnected ? 'healthy' : 'disconnected',
          mirrorServer: mirrorServerHealthy ? 'healthy' : 'unreachable',
          initialized: this.initialized,
          storageVersion: this.STORAGE_VERSION,
          mirrorServerUrl: this.mirrorServerUrl
        }
      };
    } catch (error) {
      return {
        status: 'critical',
        details: {
          error: error instanceof Error ? error.message : 'Unknown error',
          initialized: this.initialized
        }
      };
    }
  }

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down API-Based Mirror Storage Manager...');
    
    try {
      // Note: We don't manage the redisManager lifecycle directly
      // as it's shared across the application
      
      this.initialized = false;
      console.log('✅ API-Based Mirror Storage Manager shutdown complete');
    } catch (error: any) {
      console.error('❌ Error during Storage Manager shutdown:', error);
      throw error;
    }
  }
}

export default MirrorStorageManager;
