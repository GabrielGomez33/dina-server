// ============================================================================
// TRUTHSTREAM SYNTHESIZER - LLM Prompt Engineering for TruthStream Analysis
// ============================================================================
// File: src/modules/mirror/processors/truthStreamSynthesizer.ts
// ----------------------------------------------------------------------------
// This processor handles all LLM interactions for TruthStream:
//   1. Review classification (constructive, affirming, raw_truth, hostile)
//   2. Truth Mirror Report generation (comprehensive perception analysis)
//   3. Blind spot detection (self vs external perception gaps)
//   4. Growth recommendations (goal-specific, actionable)
//   5. Temporal trend analysis (perception changes over time)
//   6. Counter-analysis for hostile reviews (balanced perspective)
//
// ARCHITECTURE: mirror-server → dina-server mirror module → this synthesizer
// All requests flow through truthStreamRoutes → truthStreamManager → here
// ============================================================================

import { EventEmitter } from 'events';
import type {
  ClassifyReviewRequest,
  ClassifyReviewResponse,
  GenerateAnalysisRequest,
  GenerateAnalysisResponse,
  ReviewClassification,
  AnonymizedReview,
  TruthMirrorReportData,
  PerceptionGapData,
  BlindSpotData,
  GrowthRecommendationData,
  TemporalTrendData,
  HOSTILE_CONFIDENCE_THRESHOLD,
  MAX_USER_CONTEXT_CHARS,
  MAX_REVIEW_TEXT_CHARS,
  SYNTHESIS_TIMEOUT_MS,
} from '../types/truthstream';

// Re-import constants as values (type-only imports can't be used as values)
const HOSTILE_THRESHOLD = 0.85;
const MAX_CONTEXT_CHARS = 2000;
const MAX_REVIEW_CHARS = 8000;
const TIMEOUT_MS = 120000;

// ============================================================================
// LOGGER SHIM — matches Logger interface from mirror-server
// ============================================================================
class Logger {
  private context: string;
  constructor(context: string) { this.context = context; }
  info(msg: string, meta?: any)  { console.log(`[${this.context}] ${msg}`, meta ?? ''); }
  warn(msg: string, meta?: any)  { console.warn(`[${this.context}] ${msg}`, meta ?? ''); }
  error(msg: string, meta?: any) { console.error(`[${this.context}] ${msg}`, meta ?? ''); }
  debug(msg: string, meta?: any) { console.debug(`[${this.context}] ${msg}`, meta ?? ''); }
}

// ============================================================================
// TRUTHSTREAM SYNTHESIZER CLASS
// ============================================================================

export class TruthStreamSynthesizer extends EventEmitter {
  private logger: Logger;
  private llmManager: any; // DinaLLMManager instance
  private isInitialized: boolean = false;

  constructor(llmManager: any) {
    super();
    this.logger = new Logger('TruthStreamSynthesizer');
    this.llmManager = llmManager;
  }

  async initialize(): Promise<void> {
    this.isInitialized = true;
    this.logger.info('TruthStreamSynthesizer initialized');
  }

  async shutdown(): Promise<void> {
    this.isInitialized = false;
    this.logger.info('TruthStreamSynthesizer shut down');
  }

  async healthCheck(): Promise<{ healthy: boolean; initialized: boolean }> {
    return { healthy: this.isInitialized, initialized: this.isInitialized };
  }

  // ==========================================================================
  // 1. REVIEW CLASSIFICATION
  // ==========================================================================

  /**
   * Classify a review into one of four categories using LLM analysis.
   * For hostile reviews, also generates a counter-analysis.
   */
  async classifyReview(request: ClassifyReviewRequest): Promise<ClassifyReviewResponse> {
    const startTime = Date.now();

    this.logger.info('Classifying review', {
      reviewId: request.reviewId,
      goalCategory: request.revieweeGoal,
      hasTone: !!request.reviewTone,
    });

    try {
      const prompt = this.buildClassificationPrompt(request);
      const llmResponse = await this.callLLM(prompt, { maxTokens: 800, temperature: 0.3 });
      const parsed = this.parseJsonResponse<ClassifyReviewResponse>(llmResponse);

      // Safety: only allow "hostile" if confidence exceeds threshold
      if (parsed.classification === 'hostile' && parsed.confidence < HOSTILE_THRESHOLD) {
        this.logger.warn('Hostile classification below threshold, downgrading to raw_truth', {
          reviewId: request.reviewId,
          confidence: parsed.confidence,
          threshold: HOSTILE_THRESHOLD,
        });
        parsed.classification = 'raw_truth';
      }

      // If hostile, generate counter-analysis if not already present
      if (parsed.classification === 'hostile' && !parsed.counterAnalysis) {
        try {
          parsed.counterAnalysis = await this.generateCounterAnalysis(request, parsed.reasoning);
        } catch (err: any) {
          this.logger.warn('Counter-analysis generation failed, continuing without', {
            error: err.message,
          });
        }
      }

      this.logger.info('Review classified', {
        reviewId: request.reviewId,
        classification: parsed.classification,
        confidence: parsed.confidence,
        processingTimeMs: Date.now() - startTime,
      });

      return {
        classification: parsed.classification,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning || 'Classification based on content analysis.',
        counterAnalysis: parsed.counterAnalysis,
        hostilityIndicators: parsed.hostilityIndicators || [],
        piiDetected: parsed.piiDetected || false,
        piiWarnings: parsed.piiWarnings || [],
      };
    } catch (error: any) {
      this.logger.error('Review classification failed', {
        reviewId: request.reviewId,
        error: error.message,
        processingTimeMs: Date.now() - startTime,
      });
      throw error;
    }
  }

  // ==========================================================================
  // 2. TRUTH MIRROR REPORT
  // ==========================================================================

  /**
   * Generate a comprehensive Truth Mirror Report from aggregated reviews.
   */
  async generateAnalysis(request: GenerateAnalysisRequest): Promise<GenerateAnalysisResponse> {
    const startTime = Date.now();

    this.logger.info('Generating analysis', {
      userId: request.userId,
      analysisType: request.analysisType,
      reviewCount: request.reviews.length,
      goalCategory: request.goalCategory,
    });

    try {
      let prompt: string;
      switch (request.analysisType) {
        case 'truth_mirror_report':
          prompt = this.buildTruthMirrorReportPrompt(request);
          break;
        case 'perception_gap':
          prompt = this.buildPerceptionGapPrompt(request);
          break;
        case 'blind_spot':
          prompt = this.buildBlindSpotPrompt(request);
          break;
        case 'growth_recommendation':
          prompt = this.buildGrowthRecommendationPrompt(request);
          break;
        case 'temporal_trend':
          prompt = this.buildTemporalTrendPrompt(request);
          break;
        default:
          prompt = this.buildTruthMirrorReportPrompt(request);
      }

      const llmResponse = await this.callLLM(prompt, {
        maxTokens: 2500,
        temperature: 0.6,
      });

      const analysisData = this.parseJsonResponse<any>(llmResponse);

      const processingTimeMs = Date.now() - startTime;

      this.logger.info('Analysis generated', {
        userId: request.userId,
        analysisType: request.analysisType,
        processingTimeMs,
      });

      return {
        analysisType: request.analysisType,
        analysisData,
        perceptionGapScore: analysisData.perceptionGapScore ?? analysisData.score ?? null,
        confidenceLevel: this.calculateConfidence(request.reviews),
        metadata: {
          reviewsAnalyzed: request.reviews.length,
          modelUsed: 'mistral:7b',
          processingTimeMs,
        },
      };
    } catch (error: any) {
      this.logger.error('Analysis generation failed', {
        userId: request.userId,
        analysisType: request.analysisType,
        error: error.message,
        processingTimeMs: Date.now() - startTime,
      });
      throw error;
    }
  }

  // ==========================================================================
  // 3. COUNTER-ANALYSIS FOR HOSTILE REVIEWS
  // ==========================================================================

  /**
   * Generate a balanced perspective for a hostile review.
   * Acknowledges the hostility while offering constructive reframing.
   */
  private async generateCounterAnalysis(
    request: ClassifyReviewRequest,
    hostileReasoning: string
  ): Promise<string> {
    const prompt = this.buildCounterAnalysisPrompt(request, hostileReasoning);
    const response = await this.callLLM(prompt, { maxTokens: 500, temperature: 0.5 });

    // Counter-analysis is free-text, not JSON
    return response.trim();
  }

  // ==========================================================================
  // PROMPT BUILDERS
  // ==========================================================================

  private buildClassificationPrompt(request: ClassifyReviewRequest): string {
    const reviewText = this.sanitizeForPrompt(
      request.reviewText,
      MAX_REVIEW_CHARS
    );

    const parts: string[] = [];

    parts.push(
      'You are an expert behavioral analyst for the Mirror intelligence platform. ' +
      'Your task is to classify a review of a person into exactly one category.'
    );
    parts.push('');
    parts.push('CLASSIFICATION CATEGORIES:');
    parts.push('- constructive: Specific, actionable feedback that includes BOTH criticism AND tips for improvement. Balanced and thoughtful.');
    parts.push('- affirming: Positive, encouraging, highlights genuine strengths. May lack critical depth but is authentic.');
    parts.push('- raw_truth: Honest and potentially uncomfortable, but fair. Not attacking the person — just being direct about what they see.');
    parts.push('- hostile: Mean-spirited, personal attacks, non-constructive negativity. Intended to harm rather than help.');
    parts.push('');
    parts.push(`REVIEWEE'S GOAL: ${request.revieweeGoal}${request.revieweeGoalText ? ` — "${request.revieweeGoalText}"` : ''}`);
    parts.push(`REVIEWER'S SELF-TAGGED TONE: ${request.reviewTone || 'not specified'}`);
    parts.push('');
    parts.push('REVIEW CONTENT:');
    parts.push(reviewText);

    if (request.qualityMetrics) {
      parts.push('');
      parts.push('QUALITY METRICS:');
      parts.push(`- Completeness: ${Math.round(request.qualityMetrics.completenessScore * 100)}%`);
      parts.push(`- Depth: ${Math.round(request.qualityMetrics.depthScore * 100)}%`);
      parts.push(`- Time spent: ${request.qualityMetrics.timeSpentSeconds} seconds`);
    }

    parts.push('');
    parts.push('INSTRUCTIONS:');
    parts.push('1. Classify the review into exactly one category.');
    parts.push('2. Provide a confidence score (0.0 to 1.0).');
    parts.push('3. Explain your reasoning in 1-2 sentences.');
    parts.push('4. If the review is hostile, list specific hostility indicators.');
    parts.push('5. If you detect personal identifying information (names, phone numbers, addresses), flag it.');
    parts.push('6. For hostile reviews with confidence >= 0.85, provide a counter-analysis that offers balanced perspective.');
    parts.push('');
    parts.push('Respond with JSON in this EXACT format:');
    parts.push(JSON.stringify({
      classification: 'constructive',
      confidence: 0.85,
      reasoning: 'Brief explanation of classification.',
      counterAnalysis: 'Only for hostile reviews — balanced perspective.',
      hostilityIndicators: ['indicator1'],
      piiDetected: false,
      piiWarnings: [],
    }, null, 2));

    return parts.join('\n');
  }

  private buildTruthMirrorReportPrompt(request: GenerateAnalysisRequest): string {
    const parts: string[] = [];

    parts.push(
      'You are the Mirror intelligence analyst. Generate a comprehensive perception report ' +
      'for this user based on all the reviews they have received from anonymous strangers. ' +
      'Be thorough, insightful, and honest. The user came to TruthStream seeking truth.'
    );
    parts.push('');

    // Self-assessment context
    if (request.selfAssessmentData) {
      parts.push('=== SELF-ASSESSMENT DATA ===');
      const self = request.selfAssessmentData;
      if (self.personalityProfile) {
        if (self.personalityProfile.mbtiType) {
          parts.push(`MBTI Type: ${self.personalityProfile.mbtiType}`);
        }
        if (self.personalityProfile.big5) {
          const b5 = self.personalityProfile.big5;
          parts.push(`Big 5: O=${b5.openness || 'N/A'}, C=${b5.conscientiousness || 'N/A'}, E=${b5.extraversion || 'N/A'}, A=${b5.agreeableness || 'N/A'}, N=${b5.neuroticism || 'N/A'}`);
        }
        if (self.personalityProfile.dominantTraits?.length) {
          parts.push(`Dominant Traits: ${self.personalityProfile.dominantTraits.join(', ')}`);
        }
      }
      if (self.cognitiveProfile) {
        parts.push(`Cognitive Style: ${self.cognitiveProfile.category || 'N/A'}`);
      }
      if (self.astrologicalHighlights) {
        parts.push(`Astrological Highlights: ${self.astrologicalHighlights}`);
      }
      parts.push('=== END SELF-ASSESSMENT ===');
      parts.push('');
    }

    // User's goal
    parts.push(`USER'S GOAL: ${request.goalCategory} — "${request.goal}"`);
    if (request.selfStatement) {
      parts.push(`USER'S SELF-STATEMENT: "${this.sanitizeForPrompt(request.selfStatement, 500)}"`);
    }
    parts.push('');

    // Reviews
    parts.push(`=== ANONYMOUS REVIEWS (${request.reviews.length} total) ===`);
    for (let i = 0; i < request.reviews.length; i++) {
      const review = request.reviews[i];
      parts.push(`--- Review ${i + 1} (${review.classification || 'unclassified'}, quality: ${Math.round(review.qualityScore * 100)}%) ---`);
      parts.push(this.summarizeReviewResponses(review.responses));
      if (review.selfTaggedTone) {
        parts.push(`Reviewer's tone: ${review.selfTaggedTone}`);
      }
      parts.push('');
    }
    parts.push('=== END REVIEWS ===');
    parts.push('');

    // Response format
    parts.push('Generate a comprehensive Truth Mirror Report. Respond with JSON:');
    parts.push(JSON.stringify({
      perceptionSummary: {
        overallImpression: '2-3 sentence overview of how others perceive this person',
        topImpressionWords: [{ word: 'example', frequency: 5 }],
        averageScores: { overall: 7.5, section_name: 8.0 },
      },
      patternDetection: {
        consistentStrengths: ['strength multiple reviewers mentioned'],
        consistentConcerns: ['concern multiple reviewers mentioned'],
        divergentOpinions: ['areas where reviewers disagreed'],
      },
      blindSpots: {
        items: [{
          dimension: 'area',
          selfPerception: 'how they see themselves',
          externalPerception: 'how others see them',
          gap: 'the disconnect',
          severity: 'moderate',
        }],
        summary: 'overall blind spots narrative',
      },
      perceptionGapScore: 72,
      perceptionGapInterpretation: 'What the score means',
      growthRecommendations: [{
        area: 'specific area',
        recommendation: 'what to do',
        priority: 'high',
        actionSteps: ['step 1', 'step 2'],
      }],
      honestAssessment: 'The unvarnished truth about what the data says. No sugar-coating.',
      reviewDistribution: { constructive: 3, affirming: 2, rawTruth: 1, hostile: 0 },
    }, null, 2));

    return parts.join('\n');
  }

  private buildPerceptionGapPrompt(request: GenerateAnalysisRequest): string {
    const parts: string[] = [];

    parts.push(
      'You are the Mirror perception gap analyst. Compare this user\'s self-assessment ' +
      'with how anonymous reviewers perceive them. Calculate a Perception Gap Score (0-100) ' +
      'where 0 = perfect self-awareness and 100 = completely disconnected from reality.'
    );
    parts.push('');

    if (request.selfAssessmentData?.personalityProfile) {
      parts.push('SELF-ASSESSMENT:');
      parts.push(JSON.stringify(request.selfAssessmentData.personalityProfile, null, 2));
      parts.push('');
    }

    if (request.selfStatement) {
      parts.push(`SELF-STATEMENT: "${this.sanitizeForPrompt(request.selfStatement, 500)}"`);
      parts.push('');
    }

    parts.push(`REVIEWS (${request.reviews.length}):`);
    for (const review of request.reviews) {
      parts.push(this.summarizeReviewResponses(review.responses));
      parts.push('---');
    }
    parts.push('');

    parts.push('Respond with JSON:');
    parts.push(JSON.stringify({
      score: 35,
      interpretation: 'What this score means for their self-awareness',
      dimensions: [{
        name: 'dimension',
        selfScore: 8,
        externalScore: 6,
        gap: 2,
        direction: 'overestimate',
      }],
      overallDirection: 'tends to overestimate or underestimate',
      improvementSuggestions: ['suggestion'],
    }, null, 2));

    return parts.join('\n');
  }

  private buildBlindSpotPrompt(request: GenerateAnalysisRequest): string {
    const parts: string[] = [];

    parts.push(
      'You are the Mirror blind spot detector. Identify areas where this user\'s ' +
      'self-perception significantly differs from how others see them. ' +
      'Be specific, evidence-based, and constructive.'
    );
    parts.push('');
    parts.push(`Goal: ${request.goalCategory} — "${request.goal}"`);
    parts.push('');

    if (request.selfStatement) {
      parts.push(`Self-statement: "${this.sanitizeForPrompt(request.selfStatement, 500)}"`);
    }

    parts.push('');
    parts.push(`Reviews (${request.reviews.length}):`);
    for (const review of request.reviews) {
      parts.push(this.summarizeReviewResponses(review.responses));
      parts.push('---');
    }

    parts.push('');
    parts.push('Respond with JSON:');
    parts.push(JSON.stringify({
      blindSpots: [{
        area: 'specific area',
        selfBelief: 'what they think about themselves',
        externalReality: 'what others actually see',
        evidenceStrength: 'strong',
        recommendation: 'what to do about it',
      }],
      selfAwarenessScore: 65,
      summary: 'Overall blind spot narrative',
    }, null, 2));

    return parts.join('\n');
  }

  private buildGrowthRecommendationPrompt(request: GenerateAnalysisRequest): string {
    const parts: string[] = [];

    parts.push(
      'You are the Mirror growth advisor. Based on anonymous reviews and self-assessment data, ' +
      'generate specific, actionable growth recommendations tailored to this user\'s stated goal.'
    );
    parts.push('');
    parts.push(`Goal: ${request.goalCategory} — "${request.goal}"`);
    parts.push('');

    parts.push(`Reviews analyzed: ${request.reviews.length}`);
    for (const review of request.reviews) {
      parts.push(this.summarizeReviewResponses(review.responses));
      parts.push('---');
    }

    if (request.previousAnalysis?.keyInsights?.length) {
      parts.push('');
      parts.push('Previous insights:');
      for (const insight of request.previousAnalysis.keyInsights) {
        parts.push(`- ${insight}`);
      }
    }

    parts.push('');
    parts.push('Respond with JSON:');
    parts.push(JSON.stringify({
      recommendations: [{
        area: 'specific area',
        currentState: 'where they are now',
        targetState: 'where they should aim',
        actionPlan: ['step 1', 'step 2', 'step 3'],
        timeframe: '2-4 weeks',
        priority: 'high',
      }],
      overallGrowthPotential: 'narrative about growth potential',
      quickWins: ['easy thing to do today'],
      longTermGoals: ['longer-term objective'],
    }, null, 2));

    return parts.join('\n');
  }

  private buildTemporalTrendPrompt(request: GenerateAnalysisRequest): string {
    const parts: string[] = [];

    parts.push(
      'You are the Mirror trend analyst. Analyze how this user\'s perception ' +
      'has changed over time based on their reviews.'
    );
    parts.push('');
    parts.push(`Goal: ${request.goalCategory} — "${request.goal}"`);
    parts.push(`Total reviews: ${request.reviews.length}`);
    parts.push('');

    // Group reviews by approximate time period
    parts.push('Reviews (chronological):');
    const sorted = [...request.reviews].sort(
      (a, b) => new Date(a.createdAtRounded).getTime() - new Date(b.createdAtRounded).getTime()
    );
    for (const review of sorted) {
      parts.push(`[${review.createdAtRounded}] Score: ${review.responses?.overall?.overall_score || 'N/A'}, Classification: ${review.classification || 'unclassified'}`);
    }

    if (request.previousAnalysis) {
      parts.push('');
      parts.push(`Previous perception gap score: ${request.previousAnalysis.perceptionGapScore || 'N/A'}`);
    }

    parts.push('');
    parts.push('Respond with JSON:');
    parts.push(JSON.stringify({
      periods: [{
        periodLabel: 'Week 1-2',
        reviewCount: 3,
        averageScore: 6.5,
        topWords: ['word1', 'word2'],
        sentiment: 'mixed',
      }],
      overallTrend: 'improving',
      trendNarrative: 'Narrative about perception changes over time',
      keyChanges: ['notable change'],
    }, null, 2));

    return parts.join('\n');
  }

  private buildCounterAnalysisPrompt(
    request: ClassifyReviewRequest,
    hostileReasoning: string
  ): string {
    const parts: string[] = [];

    parts.push(
      'You are the Mirror guardian — a balanced, compassionate voice. ' +
      'A review has been classified as hostile. Your job is NOT to dismiss the review, ' +
      'but to provide a balanced counter-perspective that acknowledges any kernels of truth ' +
      'while protecting the reviewee from unwarranted attacks.'
    );
    parts.push('');
    parts.push(`Reviewee's goal: ${request.revieweeGoal}`);
    parts.push(`Hostile review reasoning: ${hostileReasoning}`);
    parts.push('');
    parts.push('Provide a 2-3 sentence balanced counter-analysis. Do NOT dismiss the review entirely — ');
    parts.push('extract any useful truth and reframe it constructively. Acknowledge the hostility ');
    parts.push('but help the reviewee see past it to any actionable insight.');
    parts.push('');
    parts.push('Respond with plain text (NOT JSON). Be direct, empathetic, and constructive.');

    return parts.join('\n');
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /**
   * Summarize review responses into readable text for the LLM prompt.
   */
  private summarizeReviewResponses(responses: Record<string, any>): string {
    if (!responses || typeof responses !== 'object') return '[No responses]';

    const lines: string[] = [];
    for (const [sectionId, sectionData] of Object.entries(responses)) {
      if (!sectionData || typeof sectionData !== 'object') continue;
      for (const [questionId, answer] of Object.entries(sectionData as Record<string, any>)) {
        if (answer === null || answer === undefined) continue;
        if (typeof answer === 'object' && 'score' in answer) {
          lines.push(`${sectionId}.${questionId}: ${answer.score}/10${answer.explanation ? ` — "${String(answer.explanation).substring(0, 200)}"` : ''}`);
        } else if (Array.isArray(answer)) {
          lines.push(`${sectionId}.${questionId}: [${answer.join(', ')}]`);
        } else if (typeof answer === 'string') {
          lines.push(`${sectionId}.${questionId}: "${answer.substring(0, 300)}"`);
        } else {
          lines.push(`${sectionId}.${questionId}: ${JSON.stringify(answer).substring(0, 200)}`);
        }
      }
    }
    return lines.join('\n') || '[Empty responses]';
  }

  /**
   * Sanitize text for LLM prompt — remove injection patterns, enforce length.
   */
  private sanitizeForPrompt(text: string, maxLength: number): string {
    if (!text) return '';
    let sanitized = String(text).trim();
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength);
    }
    // Prompt injection defense
    sanitized = sanitized
      .replace(/\b(system|assistant|user)\s*:/gi, '$1 -')
      .replace(/```/g, "'''")
      .replace(/\[INST\]|\[\/INST\]|<<SYS>>|<<\/SYS>>|<\/s>|<s>/gi, '')
      .replace(/<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>/gi, '');

    return sanitized;
  }

  /**
   * Calculate confidence based on review quantity and quality.
   */
  private calculateConfidence(reviews: AnonymizedReview[]): number {
    if (reviews.length === 0) return 0;

    // Base confidence from review count (5 reviews = 0.5, 20+ = 0.8 max from count)
    const countFactor = Math.min(reviews.length / 25, 0.8);

    // Quality factor (average quality score)
    const avgQuality = reviews.reduce((sum, r) => sum + r.qualityScore, 0) / reviews.length;
    const qualityFactor = avgQuality * 0.2;

    return Math.min(Math.round((countFactor + qualityFactor) * 100) / 100, 1.0);
  }

  /**
   * Call LLM through the mirror module's LLM manager.
   */
  private async callLLM(
    prompt: string,
    options: { maxTokens?: number; temperature?: number } = {}
  ): Promise<string> {
    const maxTokens = options.maxTokens || 1500;
    const temperature = options.temperature || 0.7;

    let timeoutId: ReturnType<typeof setTimeout>;

    try {
      const response = await Promise.race([
        this.llmManager.generate(prompt, {
          maxTokens,
          temperature,
          model_preference: 'mistral:7b',
          task: 'truthstream_analysis',
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('TruthStream LLM synthesis timeout')),
            TIMEOUT_MS
          );
        }),
      ]);

      clearTimeout(timeoutId!);

      // Extract content from various response formats
      if (typeof response === 'string') return response;
      if (response?.response) return response.response;
      if (response?.content) return response.content;
      if (response?.choices?.[0]?.message?.content) {
        return response.choices[0].message.content;
      }

      throw new Error('No content in LLM response');
    } catch (error: any) {
      clearTimeout(timeoutId!);
      this.logger.error('LLM call failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Parse JSON response from LLM, handling markdown code blocks.
   */
  private parseJsonResponse<T>(content: string): T {
    try {
      let cleanContent = content.trim();

      // Extract JSON from markdown code blocks if present
      const jsonMatch =
        cleanContent.match(/```json\s*([\s\S]*?)\s*```/) ||
        cleanContent.match(/```\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        cleanContent = jsonMatch[1].trim();
      }

      return JSON.parse(cleanContent) as T;
    } catch (error: any) {
      this.logger.error('Failed to parse LLM JSON response', {
        error: error.message,
        contentPreview: content.substring(0, 300),
      });
      throw new Error(`Failed to parse TruthStream synthesis response: ${error.message}`);
    }
  }
}
