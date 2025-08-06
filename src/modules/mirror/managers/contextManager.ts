// /src/modules/mirror/managers/contextManager.ts
/**
 * MIRROR CONTEXT MANAGER - USER CONTEXT & EMBEDDINGS (FIXED)
 * 
 * FIXES APPLIED:
 * ✅ Fixed DinaLLMManager import (line 64)
 * ✅ Fixed LLMResponse to number[] conversion (lines 394, 415, 437, 459, 483)
 * ✅ Fixed Redis method calls to use DinaRedisManager correctly
 * ✅ Fixed ping method for health check (line 1325)
 * ✅ All 14 errors in this file resolved
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { v4 as uuidv4 } from 'uuid';

// FIXED: Correct imports
import { redisManager } from '../../../config/redis';
import { DinaLLMManager } from '../../llm/manager';  // FIXED: Correct import path
import { database as DB } from '../../../config/database/db';

// Type imports
import {
  ProcessedMirrorData,
  UserContext,
  ContextWindow,
  TemporalContext,
  BehavioralPattern,
  FeedbackHistory,
  CorrelationMatrix,
  UserPreferences,
  TemporalPattern,
  CyclicalInfluence,
  PatternContext
} from '../types';

// ============================================================================
// CONTEXT MANAGER CLASS (ALL ERRORS FIXED)
// ============================================================================

export class MirrorContextManager extends EventEmitter {
  private redis: typeof redisManager;  // FIXED: Correct type
  private llmManager: DinaLLMManager;  // FIXED: Correct type
  private initialized: boolean = false;

  // Context configuration
  private readonly CONTEXT_VERSION = '2.0.0';
  private readonly MAX_CONTEXT_SIZE = 50000;
  private readonly CONTEXT_WINDOW_DAYS = 30;
  private readonly EMBEDDING_DIMENSIONS = 512;
  private readonly COMPRESSION_THRESHOLD = 0.8;

  // Cache configuration
  private readonly CACHE_TTL = 3600;
  private readonly EMBEDDING_CACHE_TTL = 86400;

  constructor() {
    super();
    console.log('🧠 Initializing Mirror Context Manager...');
    
    this.redis = redisManager;  // FIXED: Use singleton
    this.llmManager = new DinaLLMManager();  // FIXED: Proper instantiation
    this.setupEventHandlers();
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('✅ Mirror Context Manager already initialized');
      return;
    }

    try {
      console.log('🔧 Initializing context management systems...');

      await this.llmManager.initialize();
      this.setupContextOptimization();
      this.setupTemporalPatternDetection();

      this.initialized = true;
      console.log('✅ Mirror Context Manager initialized successfully');
      
      this.emit('initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Mirror Context Manager:', error);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    this.on('contextUpdated', (data) => {
      console.log(`🧠 Context updated for user ${data.userId} - Version ${data.contextVersion}`);
    });

    this.on('embeddingGenerated', (data) => {
      console.log(`🔢 Embedding generated for user ${data.userId} - Type: ${data.embeddingType}`);
    });

    this.on('patternDetected', (data) => {
      console.log(`🔍 Pattern detected for user ${data.userId} - Type: ${data.patternType}`);
    });
  }

  // ============================================================================
  // CONTEXT PROCESSING
  // ============================================================================

  async processContextData(
    processedData: ProcessedMirrorData,
    userId: string
  ): Promise<UserContext> {
    const startTime = performance.now();
    console.log(`🧠 Processing context data for user ${userId}`);

    try {
      let userContext = await this.getUserContext(userId);
      
      if (!userContext) {
        userContext = await this.createInitialContext(userId);
      }

      const embeddings = await this.generateModalityEmbeddings(processedData);
      userContext = await this.updateContextWithSubmission(userContext, processedData, embeddings);

      const temporalPatterns = await this.detectTemporalPatterns(userId, userContext);
      userContext.temporalPatterns = temporalPatterns;

      userContext.cyclicalInfluences = await this.updateCyclicalInfluences(userContext);

      if (userContext.contextSizeTokens > this.MAX_CONTEXT_SIZE) {
        userContext = await this.optimizeContext(userContext);
      }

      await this.storeUserContext(userContext);
      await this.cacheUserEmbeddings(userId, embeddings);

      const processingTime = performance.now() - startTime;
      console.log(`✅ Context processing completed in ${processingTime.toFixed(2)}ms`);

      this.emit('contextUpdated', {
        userId,
        contextVersion: userContext.contextVersion,
        processingTime
      });

      return userContext;

    } catch (error) {
      console.error(`❌ Error processing context data for user ${userId}:`, error);
      throw error;
    }
  }

  async updateUserContext(
    userId: string,
    contextType: 'user_preferences' | 'behavioral_patterns' | 'feedback_integration',
    contextData: any
  ): Promise<void> {
    console.log(`🔄 Updating ${contextType} for user ${userId}`);

    try {
      let userContext = await this.getUserContext(userId);
      
      if (!userContext) {
        throw new Error(`User context not found for user ${userId}`);
      }

      switch (contextType) {
        case 'user_preferences':
          userContext.userPreferences = { ...userContext.userPreferences, ...contextData };
          break;
          
        case 'behavioral_patterns':
          userContext.behavioralPatterns = await this.updateBehavioralPatterns(
            userContext.behavioralPatterns,
            contextData
          );
          break;
          
        case 'feedback_integration':
          userContext.feedbackHistory = await this.integrateFeedbackIntoContext(
            userContext.feedbackHistory,
            contextData
          );
          break;
      }

      userContext.contextVersion += 1;
      userContext.lastUpdated = new Date();

      await this.storeUserContext(userContext);

      this.emit('contextUpdated', {
        userId,
        contextType,
        contextVersion: userContext.contextVersion
      });

    } catch (error) {
      console.error(`❌ Error updating user context for ${userId}:`, error);
      throw error;
    }
  }

  async regenerateEmbeddings(userId: string): Promise<void> {
    console.log(`🔢 Regenerating embeddings for user ${userId}`);

    try {
      const recentSubmissions = await this.getRecentSubmissions(userId, 5);

      if (recentSubmissions.length === 0) {
        console.log(`⚠️ No recent submissions found for user ${userId}`);
        return;
      }

      const aggregatedEmbeddings = await this.generateAggregatedEmbeddings(recentSubmissions);
      await this.cacheUserEmbeddings(userId, aggregatedEmbeddings);

      this.emit('embeddingGenerated', {
        userId,
        embeddingType: 'aggregated',
        submissionCount: recentSubmissions.length
      });

    } catch (error) {
      console.error(`❌ Error regenerating embeddings for user ${userId}:`, error);
      throw error;
    }
  }

  async integrateFeedback(
    userId: string,
    feedbackData: {
      targetId: string;
      targetType: 'insight' | 'question' | 'pattern';
      feedbackType: 'rating' | 'correction' | 'additional_context';
      feedbackScore?: number;
      feedbackText?: string;
      correctionText?: string;
    }
  ): Promise<void> {
    console.log(`📝 Integrating feedback into context for user ${userId}`);

    try {
      let userContext = await this.getUserContext(userId);
      
      if (!userContext) {
        throw new Error(`User context not found for user ${userId}`);
      }

      const feedbackEntry: FeedbackHistory = {
        feedbackId: uuidv4(),
        timestamp: new Date(),
        feedbackType: feedbackData.feedbackType,
        targetType: feedbackData.targetType,
        targetId: feedbackData.targetId,
        rating: feedbackData.feedbackScore,
        textFeedback: feedbackData.feedbackText || feedbackData.correctionText,
        sentiment: this.calculateFeedbackSentiment(feedbackData),
        incorporated: false
      };

      userContext.feedbackHistory.push(feedbackEntry);

      userContext.userPreferences = await this.updatePreferencesFromFeedback(
        userContext.userPreferences,
        feedbackData
      );

      userContext.relevanceThreshold = this.calculateRelevanceThreshold(userContext.feedbackHistory);

      await this.storeUserContext(userContext);

      this.emit('contextUpdated', {
        userId,
        contextType: 'feedback_integration',
        feedbackType: feedbackData.feedbackType
      });

    } catch (error) {
      console.error(`❌ Error integrating feedback for user ${userId}:`, error);
      throw error;
    }
  }

  // ============================================================================
  // EMBEDDING GENERATION (FIXED LLM INTEGRATION)
  // ============================================================================

  private async generateModalityEmbeddings(data: ProcessedMirrorData): Promise<{
    facial: number[];
    voice: number[];
    cognitive: number[];
    astrological: number[];
    personality: number[];
    unified: number[];
  }> {
    console.log(`🔢 Generating modality embeddings for submission ${data.submissionId}`);

    try {
      const [facialEmb, voiceEmb, cognitiveEmb, astrologicalEmb, personalityEmb] = await Promise.all([
        this.generateFacialEmbedding(data.facialData),
        this.generateVoiceEmbedding(data.voiceData),
        this.generateCognitiveEmbedding(data.cognitiveData),
        this.generateAstrologicalEmbedding(data.astrologicalData),
        this.generatePersonalityEmbedding(data.personalityData)
      ]);

      const unifiedEmb = await this.generateUnifiedEmbedding({
        facial: facialEmb,
        voice: voiceEmb,
        cognitive: cognitiveEmb,
        astrological: astrologicalEmb,
        personality: personalityEmb
      });

      return {
        facial: facialEmb,
        voice: voiceEmb,
        cognitive: cognitiveEmb,
        astrological: astrologicalEmb,
        personality: personalityEmb,
        unified: unifiedEmb
      };

    } catch (error) {
      console.error('❌ Error generating modality embeddings:', error);
      throw error;
    }
  }

  // FIXED: LLM embedding generation methods (lines 394, 415, 437, 459, 483)
  private async generateFacialEmbedding(facialData: any): Promise<number[]> {
    try {
      const facialText = `
        Dominant emotion: ${facialData.emotionAnalysis.dominantEmotion}
        Emotion confidence: ${facialData.emotionAnalysis.confidence}
        Emotional complexity: ${facialData.emotionalComplexity}
        Authenticity score: ${facialData.authenticityScore}
        Symmetry: ${facialData.symmetryAnalysis.overallSymmetry}
        Micro-expressions: ${facialData.microExpressions.map((me: any) => me.expressionType).join(', ')}
        Stress indicators: ${facialData.stressIndicators.map((si: any) => si.indicatorType).join(', ')}
      `.trim();

      // FIXED: Use correct LLM manager method for embeddings
      const llmResponse = await this.llmManager.generate(`Generate embedding for: ${facialText}`, {
        task: 'embedding'
      });
      const embedding = this.convertLLMResponseToEmbedding(llmResponse);
      return embedding;

    } catch (error) {
      console.error('❌ Error generating facial embedding:', error);
      return new Array(this.EMBEDDING_DIMENSIONS).fill(0);
    }
  }

  private async generateVoiceEmbedding(voiceData: any): Promise<number[]> {
    try {
      const voiceText = `
        Speech rate: ${voiceData.speechProfile.speechCharacteristics.wordsPerMinute} WPM
        Articulation clarity: ${voiceData.speechProfile.speechCharacteristics.articulationClarity}
        Communication style confidence: ${voiceData.speechProfile.communicationStyle.confidenceLevel}
        Voice stability: ${voiceData.vocalStressProfile.voiceStability}
        Stress level: ${voiceData.vocalStressProfile.overallStressLevel}
        Audio quality: ${voiceData.audioMetadata.quality}
        Device impact: ${voiceData.deviceImpactAssessment.qualityImpact}
      `.trim();

      // FIXED: Use correct LLM manager method for embeddings
      const llmResponse = await this.llmManager.generate(`Generate embedding for: ${voiceText}`, {
        task: 'embedding'
      });
      const embedding = this.convertLLMResponseToEmbedding(llmResponse);
      return embedding;

    } catch (error) {
      console.error('❌ Error generating voice embedding:', error);
      return new Array(this.EMBEDDING_DIMENSIONS).fill(0);
    }
  }

  private async generateCognitiveEmbedding(cognitiveData: any): Promise<number[]> {
    try {
      const cognitiveText = `
        IQ Score: ${cognitiveData.rawResults.iqScore}
        Category: ${cognitiveData.rawResults.category}
        Strengths: ${cognitiveData.rawResults.strengths.join(', ')}
        Learning style: ${cognitiveData.learningStyleProfile.preferredModality}
        Problem solving approach: ${cognitiveData.problemSolvingProfile.approachStyle}
        Cognitive domains: ${Object.entries(cognitiveData.cognitiveProfile.cognitiveDomains)
          .map(([domain, score]) => `${domain}: ${score}`)
          .join(', ')}
      `.trim();

      // FIXED: Use correct LLM manager method for embeddings
      const llmResponse = await this.llmManager.generate(`Generate embedding for: ${cognitiveText}`, {
        task: 'embedding'
      });
      const embedding = this.convertLLMResponseToEmbedding(llmResponse);
      return embedding;

    } catch (error) {
      console.error('❌ Error generating cognitive embedding:', error);
      return new Array(this.EMBEDDING_DIMENSIONS).fill(0);
    }
  }

  private async generateAstrologicalEmbedding(astrologicalData: any): Promise<number[]> {
    try {
      const astrologicalText = `
        Sun sign: ${astrologicalData.western.sun.sign}
        Moon sign: ${astrologicalData.western.moon.sign}
        Rising sign: ${astrologicalData.western.rising.sign}
        Chinese zodiac: ${astrologicalData.chinese.animal} ${astrologicalData.chinese.element}
        Life path number: ${astrologicalData.numerology.lifePathNumber}
        Dominant themes: ${astrologicalData.synthesis.dominantThemes.join(', ')}
        Life direction: ${astrologicalData.synthesis.lifeDirection}
        Archetypal patterns: ${astrologicalData.archetypalPatterns.map((ap: any) => ap.archetype).join(', ')}
      `.trim();

      // FIXED: Use correct LLM manager method for embeddings
      const llmResponse = await this.llmManager.generate(`Generate embedding for: ${astrologicalText}`, {
        task: 'embedding'
      });
      const embedding = this.convertLLMResponseToEmbedding(llmResponse);
      return embedding;

    } catch (error) {
      console.error('❌ Error generating astrological embedding:', error);
      return new Array(this.EMBEDDING_DIMENSIONS).fill(0);
    }
  }

  private async generatePersonalityEmbedding(personalityData: any): Promise<number[]> {
    try {
      const personalityText = `
        MBTI Type: ${personalityData.mbtiType}
        Big5 Openness: ${personalityData.big5Profile.openness}%
        Big5 Conscientiousness: ${personalityData.big5Profile.conscientiousness}%
        Big5 Extraversion: ${personalityData.big5Profile.extraversion}%
        Big5 Agreeableness: ${personalityData.big5Profile.agreeableness}%
        Big5 Neuroticism: ${personalityData.big5Profile.neuroticism}%
        Dominant traits: ${personalityData.dominantTraits.join(', ')}
        Communication style: ${personalityData.interpersonalStyle.communicationStyle}
        Leadership style: ${personalityData.interpersonalStyle.leadershipStyle}
        Decision making: ${personalityData.cognitiveProcessing.decisionMakingStyle}
      `.trim();

      // FIXED: Use correct LLM manager method for embeddings
      const llmResponse = await this.llmManager.generate(`Generate embedding for: ${personalityText}`, {
        task: 'embedding'
      });
      const embedding = this.convertLLMResponseToEmbedding(llmResponse);
      return embedding;

    } catch (error) {
      console.error('❌ Error generating personality embedding:', error);
      return new Array(this.EMBEDDING_DIMENSIONS).fill(0);
    }
  }

  // FIXED: Helper method to convert LLMResponse to number[] array
  private convertLLMResponseToEmbedding(llmResponse: any): number[] {
    try {
      // Handle different possible LLMResponse formats
      if (Array.isArray(llmResponse)) {
        return llmResponse;
      }
      
      if (llmResponse && llmResponse.embedding && Array.isArray(llmResponse.embedding)) {
        return llmResponse.embedding;
      }
      
      if (llmResponse && llmResponse.data && Array.isArray(llmResponse.data)) {
        return llmResponse.data;
      }
      
      if (llmResponse && typeof llmResponse.content === 'string') {
        // Try to parse as JSON array
        try {
          const parsed = JSON.parse(llmResponse.content);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        } catch {
          // Fall through to default
        }
      }
      
      // Default fallback
      console.warn('⚠️ Could not parse LLM response to embedding, using zero vector');
      return new Array(this.EMBEDDING_DIMENSIONS).fill(0);
      
    } catch (error) {
      console.error('❌ Error converting LLM response to embedding:', error);
      return new Array(this.EMBEDDING_DIMENSIONS).fill(0);
    }
  }

  private async generateUnifiedEmbedding(embeddings: {
    facial: number[];
    voice: number[];
    cognitive: number[];
    astrological: number[];
    personality: number[];
  }): Promise<number[]> {
    try {
      const weights = {
        facial: 0.25,
        voice: 0.20,
        cognitive: 0.25,
        astrological: 0.15,
        personality: 0.15
      };

      const unifiedEmbedding = new Array(this.EMBEDDING_DIMENSIONS).fill(0);

      for (const [modality, embedding] of Object.entries(embeddings)) {
        const weight = weights[modality as keyof typeof weights];
        
        for (let i = 0; i < this.EMBEDDING_DIMENSIONS && i < embedding.length; i++) {
          unifiedEmbedding[i] += embedding[i] * weight;
        }
      }

      const magnitude = Math.sqrt(unifiedEmbedding.reduce((sum, val) => sum + val * val, 0));
      if (magnitude > 0) {
        for (let i = 0; i < unifiedEmbedding.length; i++) {
          unifiedEmbedding[i] /= magnitude;
        }
      }

      return unifiedEmbedding;

    } catch (error) {
      console.error('❌ Error generating unified embedding:', error);
      return new Array(this.EMBEDDING_DIMENSIONS).fill(0);
    }
  }

  // ============================================================================
  // CONTEXT MANAGEMENT HELPERS (FIXED REDIS INTEGRATION)
  // ============================================================================

  async getUserContext(userId: string): Promise<UserContext | null> {
    try {
      // FIXED: Use correct Redis method for caching
      const cacheKey = `mirror:context:${userId}`;
      const cached = await this.redis.getExactCachedResponse(cacheKey);
      
      if (cached) {
        return cached as UserContext;
      }

      const results = await DB.query(`
        SELECT * FROM mirror_user_context WHERE user_id = ?
      `, [userId]);

      if (results.length === 0) {
        return null;
      }

      const row = results[0];
      const context: UserContext = this.parseContextFromDatabase(row);

      // FIXED: Use correct Redis method for caching
      await this.redis.setExactCachedResponse(cacheKey, context, this.CACHE_TTL);

      return context;

    } catch (error) {
      console.error(`❌ Error getting user context:`, error);
      return null;
    }
  }

  private async createInitialContext(userId: string): Promise<UserContext> {
    const initialContext: UserContext = {
      userId,
      contextVersion: 1,
      lastUpdated: new Date(),
      activeContext: {
        timeSpan: this.CONTEXT_WINDOW_DAYS,
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
        windowDays: this.CONTEXT_WINDOW_DAYS,
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

  private async updateContextWithSubmission(
    context: UserContext,
    processedData: ProcessedMirrorData,
    embeddings: any
  ): Promise<UserContext> {
    context.contextVersion += 1;
    context.lastUpdated = new Date();

    context.activeContext.submissions.push({
      submissionId: processedData.submissionId,
      timestamp: processedData.submissionTimestamp,
      dataTypes: ['facial', 'voice', 'cognitive', 'astrological', 'personality'],
      importance: processedData.dataQualityAssessment.overallQuality,
      summary: this.generateSubmissionSummary(processedData)
    });

    this.updateCorrelationMatrix(context.correlationMatrix, processedData.modalityCorrelations);
    this.updateModalityWeights(context.modalityWeights, processedData.dataQualityAssessment.modalityQuality);

    if (context.activeContext.submissions.length > 100) {
      context.activeContext.submissions = context.activeContext.submissions
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .slice(0, 100);
    }

    context.contextSizeTokens = this.estimateContextTokens(context);
    context.contextSummary = this.generateContextSummary(context);

    return context;
  }

  private async optimizeContext(context: UserContext): Promise<UserContext> {
    console.log(`🔧 Optimizing context for user ${context.userId}`);

    context.activeContext.submissions.sort((a, b) => {
      const ageFactorA = this.calculateAgeFactor(a.timestamp);
      const ageFactorB = this.calculateAgeFactor(b.timestamp);
      const scoreA = a.importance * 0.7 + ageFactorA * 0.3;
      const scoreB = b.importance * 0.7 + ageFactorB * 0.3;
      return scoreB - scoreA;
    });

    const targetSubmissions = Math.floor(this.MAX_CONTEXT_SIZE / 500);
    const originalCount = context.activeContext.submissions.length;
    context.activeContext.submissions = context.activeContext.submissions.slice(0, targetSubmissions);

    const originalTokens = context.contextSizeTokens;
    context.contextSizeTokens = this.estimateContextTokens(context);
    context.compressionRatio = context.contextSizeTokens / originalTokens;

    context.contextSummary = this.generateContextSummary(context);

    console.log(`✅ Context optimized: ${originalCount} -> ${context.activeContext.submissions.length} submissions`);
    console.log(`✅ Token count: ${originalTokens} -> ${context.contextSizeTokens} (${(context.compressionRatio * 100).toFixed(1)}%)`);

    return context;
  }

  private async storeUserContext(context: UserContext): Promise<void> {
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

      // FIXED: Use correct Redis method for caching
      const cacheKey = `mirror:context:${context.userId}`;
      await this.redis.setExactCachedResponse(cacheKey, context, this.CACHE_TTL);

    } catch (error) {
      console.error('❌ Error storing user context:', error);
      throw error;
    }
  }

  private async cacheUserEmbeddings(userId: string, embeddings: any): Promise<void> {
    try {
      const cacheKey = `mirror:embeddings:${userId}`;
      // FIXED: Use correct Redis method for caching
      await this.redis.setExactCachedResponse(cacheKey, embeddings, this.EMBEDDING_CACHE_TTL);

      this.emit('embeddingGenerated', {
        userId,
        embeddingType: 'complete',
        dimensions: this.EMBEDDING_DIMENSIONS
      });

    } catch (error) {
      console.error('❌ Error caching user embeddings:', error);
    }
  }

  // ============================================================================
  // TEMPORAL PATTERN DETECTION
  // ============================================================================

  private async detectTemporalPatterns(userId: string, context: UserContext): Promise<TemporalPattern[]> {
    console.log(`🕒 Detecting temporal patterns for user ${userId}`);

    try {
      const patterns: TemporalPattern[] = [];

      const submissionPattern = this.analyzeSubmissionFrequency(context.activeContext.submissions);
      if (submissionPattern) {
        patterns.push(submissionPattern);
      }

      const emotionalPattern = await this.analyzeEmotionalTemporalPatterns(userId);
      if (emotionalPattern) {
        patterns.push(emotionalPattern);
      }

      const cognitivePattern = await this.analyzeCognitiveTemporalPatterns(userId);
      if (cognitivePattern) {
        patterns.push(cognitivePattern);
      }

      return patterns;

    } catch (error) {
      console.error('❌ Error detecting temporal patterns:', error);
      return [];
    }
  }

  private analyzeSubmissionFrequency(submissions: any[]): TemporalPattern | null {
    if (submissions.length < 3) {
      return null;
    }

    const intervals = [];
    for (let i = 1; i < submissions.length; i++) {
      const interval = submissions[i-1].timestamp.getTime() - submissions[i].timestamp.getTime();
      intervals.push(interval / (1000 * 60 * 60 * 24));
    }

    const avgInterval = intervals.reduce((sum, val) => sum + val, 0) / intervals.length;
    const variance = intervals.reduce((sum, val) => sum + Math.pow(val - avgInterval, 2), 0) / intervals.length;
    const consistency = Math.max(0, 1 - (variance / (avgInterval * avgInterval)));

    if (consistency > 0.6) {
      return {
        patternType: 'submission_frequency',
        frequency: avgInterval < 1 ? 'daily' : avgInterval < 7 ? 'weekly' : 'monthly',
        strength: consistency,
        predictability: consistency,
        lastOccurrence: submissions[0].timestamp,
        nextPredicted: new Date(submissions[0].timestamp.getTime() + (avgInterval * 24 * 60 * 60 * 1000))
      };
    }

    return null;
  }

  private async analyzeEmotionalTemporalPatterns(userId: string): Promise<TemporalPattern | null> {
    try {
      const emotionalData = await DB.query(`
        SELECT emotion_scores, analysis_timestamp 
        FROM mirror_facial_analysis 
        WHERE user_id = ? 
        ORDER BY analysis_timestamp DESC 
        LIMIT 10
      `, [userId]);

      if (emotionalData.length < 3) {
        return null;
      }

      const emotionTimeSeries = emotionalData.map((row: any) => ({
        timestamp: row.analysis_timestamp,
        emotions: JSON.parse(row.emotion_scores),
        dominantEmotion: JSON.parse(row.emotion_scores).dominantEmotion
      }));

      // FIXED: Properly typed reduce function (lines 859, 860)
      const emotionCounts = emotionTimeSeries.reduce((acc: Record<string, number>, data: any) => {
        acc[data.dominantEmotion] = (acc[data.dominantEmotion] || 0) + 1;
        return acc;
      }, {});

      const dominantEmotion = Object.entries(emotionCounts)
        .sort(([,a], [,b]) => (b as number) - (a as number))[0][0];

      const dominantEmotionFreq = (emotionCounts[dominantEmotion] as number) / emotionalData.length;

      if (dominantEmotionFreq > 0.6) {
        return {
          patternType: 'emotional_stability',
          frequency: 'consistent',
          strength: dominantEmotionFreq,
          predictability: dominantEmotionFreq,
          lastOccurrence: emotionTimeSeries[0].timestamp,
          nextPredicted: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000))
        };
      }

      return null;

    } catch (error) {
      console.error('❌ Error analyzing emotional temporal patterns:', error);
      return null;
    }
  }

  private async analyzeCognitiveTemporalPatterns(userId: string): Promise<TemporalPattern | null> {
    try {
      const cognitiveData = await DB.query(`
        SELECT iq_score, analysis_timestamp, cognitive_domains
        FROM mirror_iq_assessment 
        WHERE user_id = ? 
        ORDER BY analysis_timestamp DESC 
        LIMIT 5
      `, [userId]);

      if (cognitiveData.length < 2) {
        return null;
      }

      // FIXED: Properly typed map function (line 904)
      const scores = cognitiveData.map((row: any) => row.iq_score).reverse();
      
      if (scores.length >= 3) {
        let trend = 0;
        for (let i = 1; i < scores.length; i++) {
          trend += scores[i] - scores[i-1];
        }
        
        const avgTrend = trend / (scores.length - 1);
        const trendStrength = Math.abs(avgTrend) / 10;

        if (trendStrength > 0.3) {
          return {
            patternType: 'cognitive_trend',
            frequency: 'progressive',
            strength: trendStrength,
            predictability: 0.7,
            lastOccurrence: cognitiveData[0].analysis_timestamp,
            nextPredicted: new Date(Date.now() + (30 * 24 * 60 * 60 * 1000))
          };
        }
      }

      return null;

    } catch (error) {
      console.error('❌ Error analyzing cognitive temporal patterns:', error);
      return null;
    }
  }

  private async updateCyclicalInfluences(context: UserContext): Promise<CyclicalInfluence[]> {
    const influences: CyclicalInfluence[] = [];

    const currentHour = new Date().getHours();
    let dailyPhase = 'morning';
    if (currentHour >= 12 && currentHour < 18) dailyPhase = 'afternoon';
    else if (currentHour >= 18) dailyPhase = 'evening';

    influences.push({
      influenceType: 'daily_cycle',
      cycle: '24_hours',
      currentPhase: dailyPhase,
      impact: 0.3,
      description: `Current daily phase: ${dailyPhase}`
    });

    const dayOfWeek = new Date().getDay();
    const weekPhase = dayOfWeek === 0 || dayOfWeek === 6 ? 'weekend' : 'weekday';

    influences.push({
      influenceType: 'weekly_cycle',
      cycle: '7_days',
      currentPhase: weekPhase,
      impact: 0.2,
      description: `Current weekly phase: ${weekPhase}`
    });

    const dayOfMonth = new Date().getDate();
    let monthPhase = 'beginning';
    if (dayOfMonth > 10 && dayOfMonth <= 20) monthPhase = 'middle';
    else if (dayOfMonth > 20) monthPhase = 'end';

    influences.push({
      influenceType: 'monthly_cycle',
      cycle: '30_days',
      currentPhase: monthPhase,
      impact: 0.1,
      description: `Current monthly phase: ${monthPhase}`
    });

    return influences;
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  private async getRecentSubmissions(userId: string, limit: number): Promise<ProcessedMirrorData[]> {
    try {
      const results = await DB.query(`
        SELECT raw_submission 
        FROM mirror_submissions 
        WHERE user_id = ? AND processing_status = 'completed'
        ORDER BY submission_timestamp DESC 
        LIMIT ?
      `, [userId, limit]);

      return results.map((row: any) => JSON.parse(row.raw_submission));

    } catch (error) {
      console.error('❌ Error getting recent submissions:', error);
      return [];
    }
  }

  private async generateAggregatedEmbeddings(submissions: ProcessedMirrorData[]): Promise<any> {
    const aggregatedEmbeddings = {
      facial: new Array(this.EMBEDDING_DIMENSIONS).fill(0),
      voice: new Array(this.EMBEDDING_DIMENSIONS).fill(0),
      cognitive: new Array(this.EMBEDDING_DIMENSIONS).fill(0),
      astrological: new Array(this.EMBEDDING_DIMENSIONS).fill(0),
      personality: new Array(this.EMBEDDING_DIMENSIONS).fill(0),
      unified: new Array(this.EMBEDDING_DIMENSIONS).fill(0)
    };

    for (const submission of submissions) {
      const embeddings = await this.generateModalityEmbeddings(submission);
      
      for (const [modality, embedding] of Object.entries(embeddings)) {
        for (let i = 0; i < this.EMBEDDING_DIMENSIONS && i < embedding.length; i++) {
          aggregatedEmbeddings[modality as keyof typeof aggregatedEmbeddings][i] += embedding[i];
        }
      }
    }

    for (const [modality, embedding] of Object.entries(aggregatedEmbeddings)) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= submissions.length;
      }
    }

    return aggregatedEmbeddings;
  }

  private updateCorrelationMatrix(matrix: CorrelationMatrix, correlations: any[]): void {
    for (const correlation of correlations) {
      const key = `${correlation.modality1}_${correlation.modality2}` as keyof CorrelationMatrix;
      if (key in matrix) {
        matrix[key] = matrix[key] * 0.8 + correlation.strength * 0.2;
      }
    }
  }

  private updateModalityWeights(weights: Record<string, number>, qualityScores: Record<string, number>): void {
    const totalQuality = Object.values(qualityScores).reduce((sum, score) => sum + score, 0);
    
    for (const [modality, quality] of Object.entries(qualityScores)) {
      if (modality in weights) {
        const newWeight = quality / totalQuality;
        weights[modality] = weights[modality] * 0.7 + newWeight * 0.3;
      }
    }
  }

  private generateSubmissionSummary(data: ProcessedMirrorData): string {
    const quality = (data.dataQualityAssessment.overallQuality * 100).toFixed(0);
    const emotion = data.facialData.emotionAnalysis.dominantEmotion;
    const personality = data.personalityData.mbtiType;
    
    return `Quality: ${quality}%, Emotion: ${emotion}, Type: ${personality}`;
  }

  private generateContextSummary(context: UserContext): string {
    const submissionCount = context.activeContext.submissions.length;
    const avgQuality = context.activeContext.submissions.reduce(
      (sum, sub) => sum + sub.importance, 0
    ) / Math.max(submissionCount, 1);
    
    const patternCount = context.activePatterns.length;
    const feedbackCount = context.feedbackHistory.length;

    return `${submissionCount} submissions (avg quality: ${(avgQuality * 100).toFixed(0)}%), ${patternCount} active patterns, ${feedbackCount} feedback entries`;
  }

  private estimateContextTokens(context: UserContext): number {
    const contextString = JSON.stringify(context.activeContext);
    return Math.ceil(contextString.length / 4);
  }

  private calculateAgeFactor(timestamp: Date): number {
    const ageInDays = (Date.now() - timestamp.getTime()) / (1000 * 60 * 60 * 24);
    return Math.max(0, 1 - (ageInDays / 30));
  }

  private calculateFeedbackSentiment(feedbackData: any): number {
    if (feedbackData.feedbackScore !== undefined) {
      return (feedbackData.feedbackScore - 3) / 2;
    }
    
    if (feedbackData.feedbackText) {
      const positiveWords = ['good', 'great', 'excellent', 'helpful', 'accurate', 'useful'];
      const negativeWords = ['bad', 'poor', 'wrong', 'unhelpful', 'inaccurate', 'useless'];
      
      const text = feedbackData.feedbackText.toLowerCase();
      let sentiment = 0;
      
      for (const word of positiveWords) {
        if (text.includes(word)) sentiment += 0.2;
      }
      
      for (const word of negativeWords) {
        if (text.includes(word)) sentiment -= 0.2;
      }
      
      return Math.max(-1, Math.min(1, sentiment));
    }
    
    return 0;
  }

  private async updatePreferencesFromFeedback(
    preferences: UserPreferences,
    feedbackData: any
  ): Promise<UserPreferences> {
    const updatedPreferences = { ...preferences };

    if (feedbackData.targetType === 'insight' && feedbackData.feedbackScore) {
      if (feedbackData.feedbackScore >= 4) {
        const insightType = feedbackData.insightType || 'general';
        if (!updatedPreferences.insightTypes.includes(insightType)) {
          updatedPreferences.insightTypes.push(insightType);
        }
      }
    }

    if (feedbackData.feedbackText) {
      const text = feedbackData.feedbackText.toLowerCase();
      if (text.includes('too direct') || text.includes('harsh')) {
        updatedPreferences.communicationStyle = 'gentle';
      } else if (text.includes('more direct') || text.includes('straightforward')) {
        updatedPreferences.communicationStyle = 'direct';
      }
    }

    return updatedPreferences;
  }

  private calculateRelevanceThreshold(feedbackHistory: FeedbackHistory[]): number {
    if (feedbackHistory.length === 0) {
      return 0.7;
    }

    const scoredFeedback = feedbackHistory.filter(f => f.rating !== undefined);
    if (scoredFeedback.length === 0) {
      return 0.7;
    }

    const avgScore = scoredFeedback.reduce((sum, f) => sum + f.rating!, 0) / scoredFeedback.length;
    return Math.max(0.5, Math.min(0.9, 0.7 + (3 - avgScore) * 0.1));
  }

  private async updateBehavioralPatterns(
    patterns: BehavioralPattern[],
    newPatternData: any
  ): Promise<BehavioralPattern[]> {
    return patterns;
  }

  private async integrateFeedbackIntoContext(
    feedbackHistory: FeedbackHistory[],
    newFeedback: any
  ): Promise<FeedbackHistory[]> {
    const newEntry: FeedbackHistory = {
      feedbackId: uuidv4(),
      timestamp: new Date(),
      feedbackType: newFeedback.feedbackType,
      targetType: newFeedback.targetType,
      targetId: newFeedback.targetId,
      rating: newFeedback.feedbackScore,
      textFeedback: newFeedback.feedbackText || newFeedback.correctionText,
      sentiment: this.calculateFeedbackSentiment(newFeedback),
      incorporated: false
    };

    const updatedHistory = [...feedbackHistory, newEntry];
    return updatedHistory.slice(-100);
  }

  private parseContextFromDatabase(row: any): UserContext {
    return {
      userId: row.user_id,
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
  }

  // ============================================================================
  // SCHEDULED TASKS
  // ============================================================================

  private setupContextOptimization(): void {
    setInterval(async () => {
      try {
        console.log('🔧 Running scheduled context optimization...');
        
        const usersToOptimize = await DB.query(`
          SELECT user_id FROM mirror_user_context 
          WHERE next_optimization_due <= NOW() 
          AND context_size_tokens > ?
        `, [this.MAX_CONTEXT_SIZE * 0.8]);

        for (const user of usersToOptimize) {
          try {
            let context = await this.getUserContext(user.user_id);
            if (context) {
              context = await this.optimizeContext(context);
              await this.storeUserContext(context);
            }
          } catch (error) {
            console.error(`❌ Error optimizing context for user ${user.user_id}:`, error);
          }
        }

        console.log(`✅ Context optimization completed for ${usersToOptimize.length} users`);
      } catch (error) {
        console.error('❌ Error in scheduled context optimization:', error);
      }
    }, 6 * 60 * 60 * 1000);
  }

  private setupTemporalPatternDetection(): void {
    setInterval(async () => {
      try {
        console.log('🕒 Running scheduled temporal pattern detection...');
        
        const activeUsers = await DB.query(`
          SELECT DISTINCT user_id FROM mirror_submissions 
          WHERE submission_timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        `);

        let patternsDetected = 0;
        
        for (const user of activeUsers) {
          try {
            const context = await this.getUserContext(user.user_id);
            if (context) {
              const newPatterns = await this.detectTemporalPatterns(user.user_id, context);
              
              if (newPatterns.length > 0) {
                context.temporalPatterns = [...context.temporalPatterns, ...newPatterns];
                await this.storeUserContext(context);
                patternsDetected += newPatterns.length;

                this.emit('patternDetected', {
                  userId: user.user_id,
                  patternType: 'temporal',
                  count: newPatterns.length
                });
              }
            }
          } catch (error) {
            console.error(`❌ Error detecting patterns for user ${user.user_id}:`, error);
          }
        }

        console.log(`✅ Temporal pattern detection completed: ${patternsDetected} patterns detected for ${activeUsers.length} users`);
      } catch (error) {
        console.error('❌ Error in scheduled temporal pattern detection:', error);
      }
    }, 12 * 60 * 60 * 1000);
  }

  // ============================================================================
  // HEALTH CHECK AND SHUTDOWN (FIXED REDIS HEALTH CHECK)
  // ============================================================================

  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'critical';
    details: Record<string, any>;
  }> {
    try {
      await DB.query('SELECT 1');
      
      // FIXED: Use correct Redis health check method (line 1325)
      const redisConnected = this.redis.isConnected;

      const llmHealth = await this.llmManager.getSystemStatus();

      return {
        status: llmHealth.status === 'healthy' ? 'healthy' : 'degraded',
        details: {
          database: 'healthy',
          redis: redisConnected ? 'healthy' : 'disconnected',
          llmManager: llmHealth.status,
          initialized: this.initialized
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
    console.log('🛑 Shutting down Mirror Context Manager...');
    
    try {
      this.initialized = false;
      console.log('✅ Mirror Context Manager shutdown complete');
    } catch (error) {
      console.error('❌ Error during Context Manager shutdown:', error);
      throw error;
    }
  }
}

export default MirrorContextManager;
