// /src/modules/mirror/index.ts
/**
 * DINA MIRROR MODULE - CORE IMPLEMENTATION
 *
 * ENHANCED: Integrated InsightSynthesizer and TruthStreamSynthesizer for routing
 * all mirror-server LLM requests through the mirror module instead of direct chat access.
 *
 * TruthStream integration follows the same pattern as InsightSynthesizer:
 * - Initialized with the module's own DinaLLMManager instance
 * - Invoked via DUMP messages routed through the orchestrator
 * - DinaCore.llmManager stays private
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { v4 as uuidv4 } from 'uuid';

// === CORE IMPORTS ===
import {
  DinaUniversalMessage,
  DinaResponse,
  SecurityLevel,
  createDinaMessage,
  createDinaResponse
} from '../../core/protocol/index';
import {DinaLLMManager} from '../llm/manager';
import { redisManager } from '../../config/redis';
import { database } from '../../config/database/db';

// === MIRROR-SPECIFIC IMPORTS ===
import { MirrorDataProcessor } from './processors/dataProcessor';
import { MirrorContextManager } from './managers/contextManager';
import { MirrorStorageManager } from './managers/storageManager';
import { MirrorInsightGenerator } from './processors/insightGenerator';
import { MirrorNotificationSystem } from './systems/notificationSystem';
import { InsightSynthesizer, InsightSynthesisRequest, InsightSynthesisResponse } from './processors/insightSynthesizer';
import { TruthStreamSynthesizer } from './processors/truthStreamSynthesizer';
import { truthStreamManager } from './truthStreamManager';
import type {
  ClassifyReviewRequest,
  GenerateAnalysisRequest,
  ValidateTruthCardRequest,
  ScoreReviewQualityRequest,
} from './types/truthstream';

// === TYPE IMPORTS ===
import {
  MirrorUserSubmission,
  ProcessedMirrorData,
  MirrorInsight,
  QuickInsight,
  DetectedPattern,
  PerformanceMetric,
  SystemHealth
} from './types';

// ============================================================================
// INTERFACES & TYPES
// ============================================================================

interface SessionInfo {
  userId: string;
  sessionId: string;
  timestamp?: Date;
}

interface ProcessingContext {
  userId: string;
  processId: string;
  sessionId?: string;
  submissionId?: string;
}

interface QueuedAnalysisData {
  userId: string;
  processId: string;
  processedData: ProcessedMirrorData;
  contextData?: any;
  analysisType: string;
  priority: number;
}

// Define MirrorError locally (no import conflict)
export class MirrorModuleError extends Error {
  public readonly code: string;
  public readonly severity: 'low' | 'medium' | 'high' | 'critical';
  public readonly context: Record<string, any>;
  public readonly timestamp: Date;

  constructor(
    code: string,
    message: string,
    severity: 'low' | 'medium' | 'high' | 'critical' = 'medium',
    context: Record<string, any> = {}
  ) {
    super(message);
    this.name = 'MirrorModuleError';
    this.code = code;
    this.severity = severity;
    this.context = context;
    this.timestamp = new Date();
  }
}

// ============================================================================
// CORE MIRROR MODULE CLASS
// ============================================================================

export class MirrorModule extends EventEmitter {
  private dataProcessor: MirrorDataProcessor;
  private contextManager: MirrorContextManager;
  private storageManager: MirrorStorageManager;
  private insightGenerator: MirrorInsightGenerator;
  private notificationSystem: MirrorNotificationSystem;
  private insightSynthesizer: InsightSynthesizer;
  private truthStreamSynthesizer: TruthStreamSynthesizer;
  private llmManager: DinaLLMManager;
  private redis: typeof redisManager;
  private initialized: boolean = false;

  // Performance tracking
  private performanceMetrics: Map<string, number[]> = new Map();
  private activeProcessing: Map<string, Date> = new Map();

  // Configuration
  private readonly MODULE_VERSION = '2.0.0';
  private readonly MAX_PROCESSING_TIME = 30000;
  private readonly MAX_CONCURRENT_PROCESSING = 10;

  constructor() {
    super();
    console.log('🪞 Initializing Mirror Module...');

    this.redis = redisManager;
    this.llmManager = new DinaLLMManager();

    // Initialize modular components
    this.dataProcessor = new MirrorDataProcessor();
    this.contextManager = new MirrorContextManager();
    this.storageManager = new MirrorStorageManager();
    this.insightGenerator = new MirrorInsightGenerator(this.llmManager);
    this.notificationSystem = new MirrorNotificationSystem();
    this.insightSynthesizer = new InsightSynthesizer(this.llmManager);
    this.truthStreamSynthesizer = new TruthStreamSynthesizer(this.llmManager);

    this.setupErrorHandling();
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('✅ Mirror Module already initialized');
      return;
    }

    try {
      console.log('🔧 Initializing Mirror Module components...');

      await this.llmManager.initialize();

      await Promise.all([
        this.dataProcessor.initialize(),
        this.contextManager.initialize(),
        this.storageManager.initialize(),
        this.insightGenerator.initialize(),
        this.notificationSystem.initialize(),
        this.insightSynthesizer.initialize(),
        this.truthStreamSynthesizer.initialize(),
        truthStreamManager.initialize(),
      ]);

      await database.query('SELECT 1');
      console.log('✅ Database connection verified');

      await this.setupProcessingQueues();

      this.initialized = true;
      console.log('✅ Mirror Module initialized successfully (with InsightSynthesizer + TruthStreamSynthesizer)');

      this.emit('initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Mirror Module:', error);
      throw new MirrorModuleError(
        'INITIALIZATION_FAILED',
        'Failed to initialize Mirror Module',
        'critical',
        { error: error instanceof Error ? error.message : 'Unknown error' }
      );
    }
  }

  public get isInitialized(): boolean {
    return this.initialized;
  }

  private setupErrorHandling(): void {
    this.on('error', (error: Error) => {
      console.error('🚨 Mirror Module Error:', error);
    });

    this.dataProcessor.on('error', (error) => this.handleComponentError('DataProcessor', error));
    this.contextManager.on('error', (error) => this.handleComponentError('ContextManager', error));
    this.storageManager.on('error', (error) => this.handleComponentError('StorageManager', error));
    this.insightGenerator.on('error', (error) => this.handleComponentError('InsightGenerator', error));
    this.notificationSystem.on('error', (error) => this.handleComponentError('NotificationSystem', error));
    this.insightSynthesizer.on('error', (error) => this.handleComponentError('InsightSynthesizer', error));
    this.truthStreamSynthesizer.on('error', (error) => this.handleComponentError('TruthStreamSynthesizer', error));
  }

  private handleComponentError(component: string, error: any): void {
    console.error(`❌ ${component} Error:`, error);
    this.emit('componentError', { component, error });
  }

  // ============================================================================
  // MAIN PROCESSING METHOD
  // ============================================================================

  /**
   * Process complete Mirror submission with proper protocol handling
   */
  async processSubmission(
    message: DinaUniversalMessage,
    sessionInfo: SessionInfo
  ): Promise<DinaResponse> {

    if (!this.initialized) {
      throw new MirrorModuleError('NOT_INITIALIZED', 'Mirror Module not initialized', 'critical');
    }

    const processId = uuidv4();
    const startTime = performance.now();
    const submissionId = uuidv4();

    try {
      console.log(`🔄 Processing Mirror submission: ${processId} for user: ${sessionInfo.userId}`);

      this.activeProcessing.set(processId, new Date());

      const submissionData = message.payload.data as MirrorUserSubmission;
      this.validateSubmission(submissionData);

      const context: ProcessingContext = {
        userId: sessionInfo.userId,
        processId,
        sessionId: sessionInfo.sessionId,
        submissionId
      };

      const processedData = await this.dataProcessor.processSubmission(submissionData);

      // Generate immediate insights
      const immediateInsights = await this.generateImmediateInsights(
        processedData,
        context
      );

      await this.storageManager.securelyStoreData(
        processedData,
        { context },
        sessionInfo.userId
      );

      await this.queueDeepAnalysis(context, processedData);

      await this.contextManager.updateUserContext(
        sessionInfo.userId,
        'behavioral_patterns',
        { processedData, insights: immediateInsights }
      );

      if (immediateInsights.length > 0) {
        await this.notificationSystem.sendImmediateNotification(
          sessionInfo.userId,
          immediateInsights
        );
      }

      const processingTime = performance.now() - startTime;
      this.trackPerformance('complete_submission', processingTime);

      this.activeProcessing.delete(processId);

      console.log(`✅ Mirror submission processed in ${processingTime.toFixed(2)}ms`);

      return createDinaResponse({
        request_id: message.id,
        status: 'success',
        payload: {
          submissionId,
          processedData,
          immediateInsights,
          status: 'completed'
        },
        metrics: {
          processing_time_ms: processingTime
        }
      });

    } catch (error) {
      this.activeProcessing.delete(processId);

      console.error(`❌ Mirror submission processing failed:`, error);

      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        metrics: {
          processing_time_ms: performance.now() - startTime
        },
        error: {
          code: 'PROCESSING_FAILED',
          message: error instanceof Error ? error.message : 'Unknown processing error',
          details: { processId }
        }
      });
    }
  }

  // ============================================================================
  // INSIGHT SYNTHESIS - Entry point for mirror-server LLM requests
  // ============================================================================

  /**
   * Synthesize insights for mirror-server requests.
   * This is the entry point that mirror-server should call instead of
   * accessing the LLM chat endpoint directly.
   *
   * Routes through the mirror module to ensure:
   * - Separation of concerns
   * - Context enrichment from mirror's user/group data
   * - Consistent prompt engineering
   * - Centralized rate limiting
   */
  async synthesizeInsights(
    message: DinaUniversalMessage,
    sessionInfo: SessionInfo
  ): Promise<DinaResponse> {
    const startTime = Date.now();

    // Guard: module must be initialized before processing
    if (!this.initialized) {
      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: {
          code: 'NOT_INITIALIZED',
          message: 'Mirror Module not initialized',
        },
        metrics: { processing_time_ms: 0 },
      });
    }

    const requestData = message.payload?.data as InsightSynthesisRequest;

    if (!requestData) {
      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing synthesis request data in payload',
        },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    }

    try {
      const result: InsightSynthesisResponse = await this.insightSynthesizer.synthesize(requestData);

      return createDinaResponse({
        request_id: message.id,
        status: result.success ? 'success' : 'error',
        payload: {
          data: result.synthesis,
          metadata: result.metadata,
        },
        error: result.success
          ? undefined
          : { code: 'SYNTHESIS_FAILED', message: result.error || 'Insight synthesis failed' },
        metrics: {
          processing_time_ms: result.metadata.processingTimeMs,
          model_used: result.metadata.modelUsed,
          tokens_generated: result.metadata.tokensGenerated,
        },
      });
    } catch (error: any) {
      console.error('❌ synthesizeInsights failed:', error.message);

      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: {
          code: 'SYNTHESIS_ERROR',
          message: 'Insight synthesis encountered an internal error',
        },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    }
  }

  // ============================================================================
  // TRUTHSTREAM HANDLERS - Invoked via DUMP protocol from orchestrator
  // ============================================================================

  /**
   * Classify a review via LLM analysis.
   * Called by orchestrator.processMirrorRequest() -> 'mirror_ts_classify_review'
   */
  async handleTruthStreamClassifyReview(
    message: DinaUniversalMessage,
    sessionInfo: SessionInfo
  ): Promise<DinaResponse> {
    const startTime = Date.now();

    if (!this.initialized) {
      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: { code: 'NOT_INITIALIZED', message: 'Mirror Module not initialized' },
        metrics: { processing_time_ms: 0 },
      });
    }

    const requestData = message.payload?.data as ClassifyReviewRequest;

    if (!requestData || !requestData.reviewId || !requestData.responses || !requestData.revieweeGoal) {
      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing required fields: reviewId, responses, revieweeGoal',
        },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    }

    // Build reviewText from structured responses if empty
    if (!requestData.reviewText || requestData.reviewText.trim().length === 0) {
      requestData.reviewText = this.buildReviewTextFromResponses(requestData.responses);
      if (!requestData.reviewText || requestData.reviewText.trim().length === 0) {
        requestData.reviewText = '[Structured responses only — no free-form text provided]';
      }
    }

    try {
      console.log(`🔮 TruthStream: Classifying review ${requestData.reviewId} for user ${sessionInfo.userId}`);
      const result = await this.truthStreamSynthesizer.classifyReview(requestData);

      return createDinaResponse({
        request_id: message.id,
        status: 'success',
        payload: { data: result },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    } catch (error: any) {
      console.error('❌ TruthStream classifyReview failed:', error.message);

      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: {
          code: 'CLASSIFICATION_ERROR',
          message: error instanceof Error ? error.message : 'Review classification failed',
        },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    }
  }

  /**
   * Generate a comprehensive analysis (Truth Mirror Report, etc.)
   * Called by orchestrator.processMirrorRequest() -> 'mirror_ts_generate_analysis'
   */
  async handleTruthStreamGenerateAnalysis(
    message: DinaUniversalMessage,
    sessionInfo: SessionInfo
  ): Promise<DinaResponse> {
    const startTime = Date.now();

    if (!this.initialized) {
      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: { code: 'NOT_INITIALIZED', message: 'Mirror Module not initialized' },
        metrics: { processing_time_ms: 0 },
      });
    }

    const requestData = message.payload?.data as GenerateAnalysisRequest;

    if (!requestData || !requestData.userId || !requestData.analysisType
        || !requestData.reviews || !requestData.goal || !requestData.goalCategory) {
      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing required fields: userId, analysisType, reviews, goal, goalCategory',
        },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    }

    if (!Array.isArray(requestData.reviews) || requestData.reviews.length < 5) {
      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: {
          code: 'INSUFFICIENT_REVIEWS',
          message: `Minimum 5 reviews required, got ${Array.isArray(requestData.reviews) ? requestData.reviews.length : 0}`,
        },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    }

    try {
      console.log(`🔮 TruthStream: Generating ${requestData.analysisType} analysis for user ${requestData.userId}`);

      const result = await this.truthStreamSynthesizer.generateAnalysis(requestData);

      return createDinaResponse({
        request_id: message.id,
        status: 'success',
        payload: { data: result },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    } catch (error: any) {
      console.error('❌ TruthStream generateAnalysis failed:', error.message);

      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: {
          code: 'ANALYSIS_ERROR',
          message: error instanceof Error ? error.message : 'Analysis generation failed',
        },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    }
  }

  /**
   * Validate truth card data.
   * Called by orchestrator.processMirrorRequest() -> 'mirror_ts_validate_truth_card'
   */
  async handleTruthStreamValidateTruthCard(
    message: DinaUniversalMessage,
    _sessionInfo: SessionInfo
  ): Promise<DinaResponse> {
    const startTime = Date.now();
    const requestData = message.payload?.data as ValidateTruthCardRequest;

    if (!requestData || !requestData.goal || !requestData.goalCategory
        || !requestData.sharedDataTypes || !requestData.displayAlias) {
      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing required fields: goal, goalCategory, sharedDataTypes, displayAlias',
        },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    }

    try {
      const result = truthStreamManager.validateTruthCard(requestData);
      return createDinaResponse({
        request_id: message.id,
        status: 'success',
        payload: { data: result },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    } catch (error: any) {
      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: { code: 'VALIDATION_ERROR', message: error.message },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    }
  }

  /**
   * Score review quality.
   * Called by orchestrator.processMirrorRequest() -> 'mirror_ts_score_review_quality'
   */
  async handleTruthStreamScoreReviewQuality(
    message: DinaUniversalMessage,
    _sessionInfo: SessionInfo
  ): Promise<DinaResponse> {
    const startTime = Date.now();
    const requestData = message.payload?.data as ScoreReviewQualityRequest;

    if (!requestData || !requestData.responses || !requestData.questionnaireSections) {
      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing required fields: responses, questionnaireSections',
        },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    }

    try {
      const result = truthStreamManager.scoreReviewQuality(requestData);
      return createDinaResponse({
        request_id: message.id,
        status: 'success',
        payload: { data: result },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    } catch (error: any) {
      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: { code: 'SCORING_ERROR', message: error.message },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    }
  }

  /**
   * Assess hostility pattern.
   * Called by orchestrator.processMirrorRequest() -> 'mirror_ts_assess_hostility'
   */
  async handleTruthStreamAssessHostility(
    message: DinaUniversalMessage,
    _sessionInfo: SessionInfo
  ): Promise<DinaResponse> {
    const startTime = Date.now();
    const data = message.payload?.data;

    if (!data || typeof data.hostilityCount !== 'number' || typeof data.totalReviews !== 'number') {
      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Missing required fields: hostilityCount (number), totalReviews (number)',
        },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    }

    try {
      const result = truthStreamManager.assessHostilityPattern(data.hostilityCount, data.totalReviews);
      return createDinaResponse({
        request_id: message.id,
        status: 'success',
        payload: { data: result },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    } catch (error: any) {
      return createDinaResponse({
        request_id: message.id,
        status: 'error',
        payload: null,
        error: { code: 'ASSESSMENT_ERROR', message: error.message },
        metrics: { processing_time_ms: Date.now() - startTime },
      });
    }
  }

  /**
   * TruthStream health check.
   */
  async handleTruthStreamHealth(): Promise<DinaResponse> {
    const synthesizerHealth = await this.truthStreamSynthesizer.healthCheck();
    return createDinaResponse({
      request_id: 'healthcheck',
      status: 'success',
      payload: {
        data: {
          module: 'truthstream',
          healthy: synthesizerHealth.healthy,
          synthesizer: synthesizerHealth,
          manager: { initialized: true },
          timestamp: new Date().toISOString(),
        },
      },
      metrics: { processing_time_ms: 0 },
    });
  }

  /**
   * Build textual summary from structured review responses when freeFormText is empty.
   */
  private buildReviewTextFromResponses(responses: Record<string, any>): string {
    if (!responses || typeof responses !== 'object') return '';
    const parts: string[] = [];

    for (const [sectionId, sectionData] of Object.entries(responses)) {
      if (!sectionData || typeof sectionData !== 'object') continue;
      for (const [questionId, answer] of Object.entries(sectionData as Record<string, any>)) {
        if (answer === null || answer === undefined) continue;
        if (typeof answer === 'string' && answer.trim().length > 0) {
          parts.push(answer.trim());
        } else if (typeof answer === 'object') {
          if (answer.explanation && typeof answer.explanation === 'string') parts.push(answer.explanation.trim());
          if (answer.categories && Array.isArray(answer.categories)) {
            parts.push(`${questionId}: ${answer.categories.join(', ')}`);
            if (answer.explanation) parts.push(answer.explanation);
          }
        }
      }
    }

    return parts.filter(p => p.length > 0).join('. ');
  }

  // ============================================================================
  // IMMEDIATE INSIGHT GENERATION
  // ============================================================================

  private async generateImmediateInsights(
    processedData: ProcessedMirrorData,
    context: ProcessingContext
  ): Promise<QuickInsight[]> {
    try {
      console.log(`💡 Generating immediate insights for ${context.userId}...`);

      const contextData = await this.contextManager.getUserContext(context.userId);

      const insights = await this.insightGenerator.generateImmediateInsights(
        processedData,
        contextData || await this.createEmptyContext(context.userId)
      );

      console.log(`✅ Generated ${insights.length} immediate insights`);
      return insights;

    } catch (error) {
      console.error('❌ Immediate insight generation failed:', error);
      return [];
    }
  }

  private async createEmptyContext(userId: string): Promise<any> {
    return {
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
      contextSummary: 'Initial context',
      contextSizeTokens: 0,
      compressionRatio: 1.0,
      relevanceThreshold: 0.7,
      activePatterns: [],
      patternConfidence: {},
      temporalWindow: {
        windowDays: 30,
        granularity: 'daily' as const,
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
        analysisDepth: 'medium' as const,
        privacyLevel: 'balanced' as const,
        communicationStyle: 'gentle' as const,
        focusAreas: []
      },
      behavioralPatterns: [],
      feedbackHistory: []
    };
  }

  // ============================================================================
  // DEEP ANALYSIS QUEUEING
  // ============================================================================

  private async queueDeepAnalysis(
    context: ProcessingContext,
    processedData: ProcessedMirrorData
  ): Promise<void> {
    try {
      console.log(`📋 Queueing deep analysis for user ${context.userId}...`);

      const analysisData: QueuedAnalysisData = {
        userId: context.userId,
        processId: context.processId,
        processedData,
        analysisType: 'deep_analysis',
        priority: 3
      };

      const patternDetectionMsg = createDinaMessage({
        source: { module: 'mirror', instance: 'queue' },
        target: { module: 'mirror', method: 'pattern_detection', priority: 3 },
        payload: {
          data: {
            ...analysisData,
            analysisType: 'pattern_detection'
          }
        },
        security: { user_id: context.userId }
      });

      const crossModalMsg = createDinaMessage({
        source: { module: 'mirror', instance: 'queue' },
        target: { module: 'mirror', method: 'cross_modal', priority: 3 },
        payload: {
          data: {
            ...analysisData,
            analysisType: 'cross_modal'
          }
        },
        security: { user_id: context.userId }
      });

      const questionGenMsg = createDinaMessage({
        source: { module: 'mirror', instance: 'queue' },
        target: { module: 'mirror', method: 'question_generation', priority: 3 },
        payload: {
          data: {
            ...analysisData,
            analysisType: 'question_generation'
          }
        },
        security: { user_id: context.userId }
      });

      await Promise.all([
        this.redis.enqueueMessage(patternDetectionMsg),
        this.redis.enqueueMessage(crossModalMsg),
        this.redis.enqueueMessage(questionGenMsg)
      ]);

      console.log(`✅ Deep analysis queued for user ${context.userId}`);
    } catch (error) {
      console.error(`❌ Error queuing deep analysis:`, error);
      throw error;
    }
  }

  // ============================================================================
  // QUEUE PROCESSING SETUP
  // ============================================================================

  private async setupProcessingQueues(): Promise<void> {
    console.log('🚀 Setting up Mirror processing queues...');

    const queueProcessors = [
      { name: 'pattern_detection', processor: this.processPatternDetection.bind(this), interval: 5000 },
      { name: 'cross_modal', processor: this.processCrossModalAnalysis.bind(this), interval: 10000 },
      { name: 'question_generation', processor: this.processQuestionGeneration.bind(this), interval: 15000 }
    ];

    for (const { name, processor, interval } of queueProcessors) {
      setInterval(async () => {
        await this.processSpecificQueue(name, processor);
      }, interval);
    }

    console.log('✅ Mirror processing queues setup complete');
  }

  private async processSpecificQueue(queueType: string, processor: Function): Promise<void> {
    try {
      const message = await this.redis.dequeueMessage(`mirror:queue:${queueType}`, 0.1);

      if (message && message.payload?.data) {
        await processor(message.payload.data);
      }
    } catch (error) {
      console.error(`❌ Error processing queue ${queueType}:`, error);
    }
  }

  // ============================================================================
  // DEEP ANALYSIS PROCESSORS
  // ============================================================================

  private async processPatternDetection(data: QueuedAnalysisData): Promise<void> {
    console.log(`🔍 Processing pattern detection for user ${data.userId}`);

    try {
      const contextData = await this.contextManager.getUserContext(data.userId);
      const patterns = await this.insightGenerator.detectPatterns(
        data.processedData,
        contextData || await this.createEmptyContext(data.userId),
        data.userId
      );

      if (patterns.length > 0) {
        await this.storageManager.storePatterns(data.userId, patterns);

        await this.notificationSystem.sendPatternNotification(
          data.userId,
          patterns
        );
      }

      console.log(`✅ Pattern detection completed for user ${data.userId} - found ${patterns.length} patterns`);
    } catch (error) {
      console.error(`❌ Pattern detection failed for user ${data.userId}:`, error);
    }
  }

  private async processCrossModalAnalysis(data: QueuedAnalysisData): Promise<void> {
    console.log(`🔗 Processing cross-modal analysis for user ${data.userId}`);

    try {
      const contextData = await this.contextManager.getUserContext(data.userId);
      const correlations = await this.insightGenerator.analyzeCrossModalCorrelations(
        data.processedData,
        contextData || await this.createEmptyContext(data.userId),
        data.userId
      );

      if (correlations.length > 0) {
        await this.storageManager.storeCorrelations(data.userId, correlations);
      }

      console.log(`✅ Cross-modal analysis completed for user ${data.userId} - found ${correlations.length} correlations`);
    } catch (error) {
      console.error(`❌ Cross-modal analysis failed for user ${data.userId}:`, error);
    }
  }

  private async processQuestionGeneration(data: QueuedAnalysisData): Promise<void> {
    console.log(`❓ Processing question generation for user ${data.userId}`);

    try {
      const contextData = await this.contextManager.getUserContext(data.userId);
      const questions = await this.insightGenerator.generateQuestions(
        data.processedData,
        contextData || await this.createEmptyContext(data.userId),
        data.userId
      );

      if (questions.length > 0) {
        await this.storageManager.storeQuestions(data.userId, questions);

        await this.notificationSystem.sendQuestionNotification(
          data.userId,
          questions
        );
      }

      console.log(`✅ Question generation completed for user ${data.userId} - generated ${questions.length} questions`);
    } catch (error) {
      console.error(`❌ Question generation failed for user ${data.userId}:`, error);
    }
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  private validateSubmission(submission: MirrorUserSubmission): void {
    console.log('🔍 Validating Mirror submission structure...');

    const required = ['userRegistered', 'name', 'faceAnalysis', 'iqResults', 'personalityResult'];
    for (const field of required) {
      if (!(field in submission)) {
        throw new MirrorModuleError(
          'VALIDATION_FAILED',
          `Missing required field: ${field}`,
          'high',
          { field, submission: Object.keys(submission) }
        );
      }
    }

    if (!submission.faceAnalysis?.detection) {
      throw new MirrorModuleError(
        'VALIDATION_FAILED',
        'Invalid facial analysis data - missing detection',
        'high'
      );
    }

    if (typeof submission.iqResults.iqScore !== 'number') {
      throw new MirrorModuleError(
        'VALIDATION_FAILED',
        'Invalid IQ score data',
        'high'
      );
    }

    if (!submission.personalityResult?.big5Profile) {
      throw new MirrorModuleError(
        'VALIDATION_FAILED',
        'Missing Big Five personality data',
        'high'
      );
    }

    console.log('✅ Submission validation passed');
  }

  private trackPerformance(operation: string, duration: number): void {
    if (!this.performanceMetrics.has(operation)) {
      this.performanceMetrics.set(operation, []);
    }

    const metrics = this.performanceMetrics.get(operation)!;
    metrics.push(duration);

    if (metrics.length > 1000) {
      metrics.splice(0, metrics.length - 1000);
    }

    this.emit('performanceMetric', { operation, duration });
  }

  // ============================================================================
  // HEALTH CHECK & MONITORING
  // ============================================================================

  async healthCheck(): Promise<SystemHealth> {
    try {
      console.log('🔍 Performing Mirror Module health check...');

      await database.query('SELECT 1');
      const redisHealthy = this.redis.isConnected;

      const componentHealth = await Promise.allSettled([
        this.dataProcessor.healthCheck(),
        this.contextManager.healthCheck(),
        this.storageManager.healthCheck(),
        this.insightGenerator.healthCheck(),
        this.notificationSystem.healthCheck(),
        this.insightSynthesizer.healthCheck(),
        this.truthStreamSynthesizer.healthCheck(),
      ]);

      const healthyComponents = componentHealth.filter(result =>
        result.status === 'fulfilled' && ((result.value as any)?.status === 'healthy' || (result.value as any)?.healthy === true)
      ).length;

      const totalComponents = componentHealth.length;

      const performanceData: Record<string, any> = {};
      for (const [operation, metrics] of this.performanceMetrics.entries()) {
        if (metrics.length > 0) {
          performanceData[operation] = {
            average: metrics.reduce((sum, val) => sum + val, 0) / metrics.length,
            min: Math.min(...metrics),
            max: Math.max(...metrics),
            count: metrics.length
          };
        }
      }

      const overallStatus =
        healthyComponents === totalComponents && redisHealthy ? 'healthy' :
        healthyComponents >= totalComponents * 0.7 ? 'degraded' : 'critical';

      return {
        status: overallStatus,
        uptime: Date.now() - (this.initialized ? Date.now() : Date.now()),
        activeProcessing: this.activeProcessing.size,
        queueDepth: await this.redis.getQueueStats(),
        performanceMetrics: performanceData,
        errorRate: 0,
        lastChecked: new Date()
      };

    } catch (error) {
      console.error('❌ Health check failed:', error);
      return {
        status: 'critical',
        uptime: 0,
        activeProcessing: this.activeProcessing.size,
        queueDepth: {},
        performanceMetrics: {},
        errorRate: 1.0,
        lastChecked: new Date()
      };
    }
  }

  async getPerformanceMetrics(): Promise<PerformanceMetric[]> {
    const metrics: PerformanceMetric[] = [];

    for (const [operation, values] of this.performanceMetrics.entries()) {
      if (values.length > 0) {
        metrics.push({
          operation,
          duration: values.reduce((sum, val) => sum + val, 0) / values.length,
          success: true,
          timestamp: new Date(),
          metadata: {
            min: Math.min(...values),
            max: Math.max(...values),
            count: values.length
          }
        });
      }
    }

    return metrics;
  }

  // ============================================================================
  // SHUTDOWN & CLEANUP
  // ============================================================================

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down Mirror Module...');

    try {
      const activeProcesses = Array.from(this.activeProcessing.keys());
      if (activeProcesses.length > 0) {
        console.log(`⏳ Waiting for ${activeProcesses.length} active processes to complete...`);

        const timeout = setTimeout(() => {
          console.warn('⚠️ Shutdown timeout reached, forcing shutdown');
        }, 30000);

        while (this.activeProcessing.size > 0 && this.activeProcessing.size < 100) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        clearTimeout(timeout);
      }

      await Promise.allSettled([
        this.dataProcessor.shutdown(),
        this.contextManager.shutdown(),
        this.storageManager.shutdown(),
        this.insightGenerator.shutdown(),
        this.notificationSystem.shutdown(),
        this.insightSynthesizer.shutdown(),
        this.truthStreamSynthesizer.shutdown(),
      ]);

      this.initialized = false;
      console.log('✅ Mirror Module shutdown complete');

    } catch (error) {
      console.error('❌ Error during Mirror Module shutdown:', error);
      throw error;
    }
  }
}


export const mirrorModule = new MirrorModule();
export default mirrorModule;
