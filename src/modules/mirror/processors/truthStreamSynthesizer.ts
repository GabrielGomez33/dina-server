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
//
// FIXES APPLIED:
//   1. Reduced TIMEOUT_MS from 120s to 55s to fit within Express 60s timeout
//   2. Added maxTokens forwarding to llmManager.generate() via correct param name
//   3. Improved error messages (no more empty/undefined errors)
//   4. Added JSON extraction fallback for malformed LLM responses
//   5. Added structured response summarization for classification prompts
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

// Timeout hierarchy: Synthesizer (240s) < Queue processor (280s) < Express route (300s)
// Cold Ollama model loads can take 150-160s before generation even starts.
// The previous 150s limit caused consistent first-attempt timeouts on cold starts.
// This must be LESS than the Express route timeout to prevent ERR_HTTP_HEADERS_SENT.
const TIMEOUT_MS = 240000; // 240s — handles cold Ollama model loads + generation

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
      reviewTextLength: request.reviewText?.length || 0,
    });

    try {
      const prompt = this.buildClassificationPrompt(request);
      const llmResponse = await this.callLLM(prompt, { maxTokens: 800, temperature: 0.3 });
      const parsed = this.parseJsonResponse<ClassifyReviewResponse>(llmResponse);

      // Validate classification is a known value
      const validClassifications: ReviewClassification[] = ['constructive', 'affirming', 'raw_truth', 'hostile'];
      if (!validClassifications.includes(parsed.classification)) {
        this.logger.warn('LLM returned unknown classification, defaulting to constructive', {
          received: parsed.classification,
        });
        parsed.classification = 'constructive';
        parsed.confidence = Math.min(parsed.confidence || 0.5, 0.6);
      }

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
      const errorMessage = error instanceof Error ? error.message : String(error || 'Unknown classification error');
      this.logger.error('Review classification failed', {
        reviewId: request.reviewId,
        error: errorMessage,
        processingTimeMs: Date.now() - startTime,
      });
      throw new Error(`Review classification failed: ${errorMessage}`);
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
        maxTokens: 3500,
        temperature: 0.5,
      });

      const rawAnalysisData = this.parseJsonResponse<any>(llmResponse);

      // Post-process to ensure structure matches frontend expectations
      const analysisData = this.normalizeReportData(rawAnalysisData, request);

      const processingTimeMs = Date.now() - startTime;

      this.logger.info('Analysis generated', {
        userId: request.userId,
        analysisType: request.analysisType,
        processingTimeMs,
      });

      return {
        analysisType: request.analysisType,
        analysisData,
        perceptionGapScore: analysisData.perceptionGap?.score ?? rawAnalysisData.perceptionGapScore ?? null,
        confidenceLevel: this.calculateConfidence(request.reviews),
        metadata: {
          reviewsAnalyzed: request.reviews.length,
          modelUsed: 'qwen2.5:3b',
          processingTimeMs,
        },
      };
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error || 'Unknown analysis error');
      this.logger.error('Analysis generation failed', {
        userId: request.userId,
        analysisType: request.analysisType,
        error: errorMessage,
        processingTimeMs: Date.now() - startTime,
      });
      throw new Error(`Analysis generation failed (${request.analysisType}): ${errorMessage}`);
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
    const sanitizedGoal = this.sanitizeForPrompt(request.revieweeGoal || '', MAX_CONTEXT_CHARS);
    const sanitizedGoalText = request.revieweeGoalText ? this.sanitizeForPrompt(request.revieweeGoalText, MAX_CONTEXT_CHARS) : '';
    const sanitizedTone = this.sanitizeForPrompt(request.reviewTone || 'not specified', 200);
    parts.push(`REVIEWEE'S GOAL: ${sanitizedGoal}${sanitizedGoalText ? ` — "${sanitizedGoalText}"` : ''}`);
    parts.push(`REVIEWER'S SELF-TAGGED TONE: ${sanitizedTone}`);
    parts.push('');
    parts.push('REVIEW CONTENT:');
    parts.push(reviewText);

    // Include structured response summary for richer classification context
    if (request.responses && typeof request.responses === 'object') {
      const summary = this.summarizeReviewResponses(request.responses);
      if (summary && summary !== '[No responses]' && summary !== '[Empty responses]') {
        parts.push('');
        parts.push('STRUCTURED RESPONSES:');
        parts.push(summary);
      }
    }

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
      'You are an expert perception analyst writing a professional Truth Mirror Report. ' +
      'Your report will be presented as a polished intelligence briefing. Write with authority, ' +
      'depth, and specificity. ALWAYS cite direct quotes from reviewers to support every claim. ' +
      'Use phrases like "One reviewer noted..." or "Multiple reviewers observed..." followed by ' +
      'exact words from the reviews. Be honest but constructive. The user seeks genuine truth.'
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
      parts.push(`USER'S SELF-DESCRIPTION (free-form text, NOT their name — do NOT use this as a name or identifier): "${this.sanitizeForPrompt(request.selfStatement, 500)}"`);
    }
    parts.push('');

    // Reviews — include full text for quote extraction
    parts.push(`=== ANONYMOUS REVIEWS (${request.reviews.length} total) ===`);
    for (let i = 0; i < request.reviews.length; i++) {
      const review = request.reviews[i];
      parts.push(`--- Review ${i + 1} (${review.classification || 'unclassified'}, quality: ${Math.round(review.qualityScore * 100)}%) ---`);
      parts.push(this.summarizeReviewResponses(review.responses));
      if (review.selfTaggedTone) {
        parts.push(`Reviewer's self-tagged tone: ${review.selfTaggedTone}`);
      }
      parts.push('');
    }
    parts.push('=== END REVIEWS ===');
    parts.push('');

    // Response format instructions — compact to reduce token count and generation time
    parts.push('Generate a Truth Mirror Report. Respond ONLY with valid JSON. Rules:');
    parts.push('- IMPORTANT: Refer to the subject as "the individual" or "the reviewee" — NEVER use the self-description text as a name');
    parts.push('- Cite EXACT reviewer quotes in supportingQuotes/keyQuotes/evidence fields');
    parts.push('- Scores are 0-10 (except perceptionGap.score: 0-100)');
    parts.push('- perceptionGap.level: "exceptional"(0-25),"good"(26-50),"significant_gaps"(51-75),"major_disconnect"(76-100)');
    parts.push('- Write detailed narratives (not brief phrases) for description/overview/summary fields');
    parts.push('');
    parts.push('JSON structure (fill ALL fields):');
    parts.push('IMPORTANT: averageScores MUST be computed from reviewer data (1-10 scale). Do NOT leave them as 0.');
    parts.push(`{
  "executiveSummary": "4-6 sentences synthesizing overall perception",
  "perceptionSummary": {
    "overview": "3-4 sentence narrative",
    "averageScores": {"firstImpression":"<1-10>","physicalPresentation":"<1-10>","intellectualAttractiveness":"<1-10>","emotionalAttractiveness":"<1-10>","socialEnergy":"<1-10>","overall":"<1-10>","selfAlignment":"<1-10>"},
    "topImpressionWords": [{"word":"","count":1,"percentage":20}],
    "strengthDistribution": [{"category":"","count":1,"percentage":20}],
    "struggleDistribution": [{"category":"","count":1,"percentage":20}],
    "keyQuotes": ["exact quote"]
  },
  "dimensionBreakdown": [{"name":"","score":0,"description":"2-3 sentences with quotes","reviewerQuotes":["exact quote"]}],
  "patternDetection": [{"pattern":"","frequency":0,"reviewerCount":0,"significance":"high|medium|low","description":"2-3 sentences","supportingQuotes":["exact quote"]}],
  "blindSpots": [{"dimension":"","selfScore":0,"externalScore":0,"gap":0,"interpretation":"2-3 sentences","evidence":"exact quote"}],
  "perceptionGap": {"score":0,"level":"good","summary":"1-2 sentences","narrative":"3-5 sentences","details":["point with evidence"]},
  "reviewerConsensus": {"overallSentiment":"positive|mixed|critical","sentimentBreakdown":{"positive":0,"neutral":0,"critical":0},"agreementAreas":["area"],"disagreementAreas":["area"]},
  "growthRecommendations": [{"area":"","recommendation":"2-3 actionable sentences","journalPrompt":"reflection question","priority":"high|medium|low"}],
  "communityInsights": {"personalityTypeComparison":"2-3 sentences","percentileScores":{"overall":0,"selfAwareness":0,"socialPresence":0}}
}`);

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
      parts.push(`SELF-DESCRIPTION (free-form text, NOT a name): "${this.sanitizeForPrompt(request.selfStatement, 500)}"`);
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
      parts.push(`Self-description (free-form text, NOT a name): "${this.sanitizeForPrompt(request.selfStatement, 500)}"`);
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
   * Compute average scores directly from review response data.
   * Used as a reliable fallback when the LLM returns zeros or invalid scores.
   */
  private computeAverageScoresFromReviews(reviews: any[]): Record<string, number> {
    const sums: Record<string, number> = {
      firstImpression: 0, physicalPresentation: 0, intellectualAttractiveness: 0,
      emotionalAttractiveness: 0, socialEnergy: 0, overall: 0, selfAlignment: 0,
    };
    const counts: Record<string, number> = { ...sums };

    for (const review of reviews) {
      const r = review.responses || review;

      // Map questionnaire response fields to score dimensions
      const mappings: Array<[string, () => number | undefined]> = [
        ['firstImpression', () => r.first_impression?.gut_reaction ?? r.firstImpressionScore],
        ['overall', () => r.overall?.overall_score ?? r.overallScore],
        ['selfAlignment', () => r.blind_spots?.self_awareness_rating ?? r.selfAlignmentScore],
        ['socialEnergy', () => r.socialEnergyScore],
        ['physicalPresentation', () => r.physicalPresentationScore],
        ['intellectualAttractiveness', () => r.intellectualAttractivenessScore],
        ['emotionalAttractiveness', () => r.emotionalAttractivenessScore],
      ];

      for (const [key, getter] of mappings) {
        const val = getter();
        if (typeof val === 'number' && val > 0 && val <= 10) {
          sums[key] += val;
          counts[key]++;
        }
      }
    }

    // Compute averages; for dimensions with no data, estimate from overall or default to 5.0
    const result: Record<string, number> = {};
    const overallAvg = counts.overall > 0 ? sums.overall / counts.overall : 5.0;

    for (const key of Object.keys(sums)) {
      result[key] = counts[key] > 0
        ? Math.round((sums[key] / counts[key]) * 10) / 10
        : Math.round(overallAvg * 10) / 10;
    }

    return result;
  }

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
          lines.push(`${questionId}: ${answer.score}/10${answer.explanation ? ` — "${String(answer.explanation).substring(0, 100)}"` : ''}`);
        } else if (typeof answer === 'object' && 'categories' in answer && Array.isArray(answer.categories)) {
          lines.push(`${questionId}: [${answer.categories.join(', ')}]${answer.explanation ? ` — "${String(answer.explanation).substring(0, 100)}"` : ''}`);
        } else if (Array.isArray(answer)) {
          lines.push(`${questionId}: [${answer.join(', ')}]`);
        } else if (typeof answer === 'string') {
          lines.push(`${questionId}: "${answer.substring(0, 150)}"`);
        } else {
          lines.push(`${questionId}: ${JSON.stringify(answer).substring(0, 100)}`);
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
  /**
   * Normalize LLM response to match the frontend's TruthMirrorReport.analysisData structure.
   * LLMs may return slightly different shapes — this ensures the frontend won't crash.
   */
  private normalizeReportData(raw: any, request: GenerateAnalysisRequest): any {
    const reviewCount = request.reviews.length;

    // --- perceptionSummary ---
    const rawSummary = raw.perceptionSummary || {};

    // Compute averages from actual review data as fallback
    const computedScores = this.computeAverageScoresFromReviews(request.reviews);

    // Parse LLM scores — treat 0 as "not computed" (use computed fallback)
    const llmScores = rawSummary.averageScores || {};
    const pickScore = (llmVal: any, computedVal: number): number => {
      const n = typeof llmVal === 'string' ? parseFloat(llmVal) : (typeof llmVal === 'number' ? llmVal : NaN);
      return (!isNaN(n) && n > 0) ? n : computedVal;
    };

    const perceptionSummary = {
      overview: rawSummary.overview || rawSummary.overallImpression || 'Analysis based on reviewer feedback.',
      averageScores: {
        firstImpression: pickScore(llmScores.firstImpression, computedScores.firstImpression),
        physicalPresentation: pickScore(llmScores.physicalPresentation, computedScores.physicalPresentation),
        intellectualAttractiveness: pickScore(llmScores.intellectualAttractiveness, computedScores.intellectualAttractiveness),
        emotionalAttractiveness: pickScore(llmScores.emotionalAttractiveness, computedScores.emotionalAttractiveness),
        socialEnergy: pickScore(llmScores.socialEnergy, computedScores.socialEnergy),
        overall: pickScore(llmScores.overall, computedScores.overall),
        selfAlignment: pickScore(llmScores.selfAlignment, computedScores.selfAlignment),
      },
      topImpressionWords: Array.isArray(rawSummary.topImpressionWords)
        ? rawSummary.topImpressionWords.map((w: any) => ({
            word: w.word || w,
            count: w.count ?? w.frequency ?? 1,
            percentage: w.percentage ?? Math.round(((w.count ?? w.frequency ?? 1) / Math.max(reviewCount, 1)) * 100),
          }))
        : [],
      strengthDistribution: Array.isArray(rawSummary.strengthDistribution)
        ? rawSummary.strengthDistribution
        : [],
      struggleDistribution: Array.isArray(rawSummary.struggleDistribution)
        ? rawSummary.struggleDistribution
        : [],
    };

    // --- patternDetection (should be array) ---
    let patternDetection: any[] = [];
    if (Array.isArray(raw.patternDetection)) {
      patternDetection = raw.patternDetection.map((p: any) => ({
        pattern: p.pattern || p.name || 'Unnamed pattern',
        frequency: p.frequency ?? 1,
        reviewerCount: p.reviewerCount ?? 1,
        significance: p.significance || 'medium',
        description: p.description || '',
      }));
    } else if (raw.patternDetection && typeof raw.patternDetection === 'object') {
      // Convert old {consistentStrengths, consistentConcerns, divergentOpinions} format
      const pd = raw.patternDetection;
      const strengths = Array.isArray(pd.consistentStrengths) ? pd.consistentStrengths : [];
      const concerns = Array.isArray(pd.consistentConcerns) ? pd.consistentConcerns : [];
      patternDetection = [
        ...strengths.map((s: string) => ({ pattern: s, frequency: 2, reviewerCount: 2, significance: 'high' as const, description: `Strength noted by multiple reviewers: ${s}` })),
        ...concerns.map((c: string) => ({ pattern: c, frequency: 2, reviewerCount: 2, significance: 'medium' as const, description: `Concern noted by multiple reviewers: ${c}` })),
      ];
    }

    // --- blindSpots (should be flat array) ---
    let blindSpots: any[] = [];
    if (Array.isArray(raw.blindSpots)) {
      blindSpots = raw.blindSpots.map((bs: any) => ({
        dimension: bs.dimension || bs.area || 'Unknown',
        selfScore: bs.selfScore ?? 5.0,
        externalScore: bs.externalScore ?? 5.0,
        gap: bs.gap ?? Math.abs((bs.selfScore ?? 5) - (bs.externalScore ?? 5)),
        interpretation: bs.interpretation || bs.gap || bs.summary || '',
      }));
    } else if (raw.blindSpots?.items && Array.isArray(raw.blindSpots.items)) {
      // Convert old {items, summary} format
      blindSpots = raw.blindSpots.items.map((bs: any) => ({
        dimension: bs.dimension || 'Unknown',
        selfScore: bs.selfScore ?? 7.0,
        externalScore: bs.externalScore ?? 5.0,
        gap: bs.gap ?? 2.0,
        interpretation: bs.interpretation || `${bs.selfPerception || ''} vs ${bs.externalPerception || ''}`.trim(),
      }));
    }

    // --- perceptionGap (nested object with level) ---
    let perceptionGap: any;
    if (raw.perceptionGap && typeof raw.perceptionGap === 'object' && raw.perceptionGap.level) {
      perceptionGap = {
        score: raw.perceptionGap.score ?? raw.perceptionGapScore ?? 50,
        level: raw.perceptionGap.level,
        summary: raw.perceptionGap.summary || '',
        details: Array.isArray(raw.perceptionGap.details) ? raw.perceptionGap.details : [],
      };
    } else {
      // Convert old flat perceptionGapScore/perceptionGapInterpretation format
      const score = raw.perceptionGap?.score ?? raw.perceptionGapScore ?? 50;
      perceptionGap = {
        score,
        level: this.scoreToGapLevel(score),
        summary: raw.perceptionGap?.summary || raw.perceptionGapInterpretation || 'Analysis of how your self-perception aligns with external feedback.',
        details: raw.perceptionGap?.details || [],
      };
    }

    // --- growthRecommendations ---
    const growthRecommendations = Array.isArray(raw.growthRecommendations)
      ? raw.growthRecommendations.map((rec: any) => ({
          area: rec.area || 'General',
          recommendation: rec.recommendation || '',
          journalPrompt: rec.journalPrompt || null,
          suggestedGroupType: rec.suggestedGroupType || null,
          priority: rec.priority || 'medium',
        }))
      : [];

    // --- communityInsights ---
    const communityInsights = raw.communityInsights || {
      personalityTypeComparison: 'Comparison data will improve as more community members complete reviews.',
      percentileScores: { overall: 50 },
    };

    // --- executiveSummary ---
    const executiveSummary = raw.executiveSummary || '';

    // --- dimensionBreakdown ---
    const dimensionBreakdown = Array.isArray(raw.dimensionBreakdown)
      ? raw.dimensionBreakdown.map((d: any) => ({
          name: d.name || 'Unknown',
          score: d.score ?? 5.0,
          description: d.description || '',
          reviewerQuotes: Array.isArray(d.reviewerQuotes) ? d.reviewerQuotes : [],
        }))
      : [];

    // --- reviewerConsensus ---
    const reviewerConsensus = raw.reviewerConsensus && typeof raw.reviewerConsensus === 'object'
      ? {
          overallSentiment: raw.reviewerConsensus.overallSentiment || 'mixed',
          sentimentBreakdown: raw.reviewerConsensus.sentimentBreakdown || { positive: 33, neutral: 34, critical: 33 },
          agreementAreas: Array.isArray(raw.reviewerConsensus.agreementAreas) ? raw.reviewerConsensus.agreementAreas : [],
          disagreementAreas: Array.isArray(raw.reviewerConsensus.disagreementAreas) ? raw.reviewerConsensus.disagreementAreas : [],
        }
      : null;

    // Pass through enriched sub-fields in perceptionSummary
    if (Array.isArray(rawSummary.keyQuotes) && rawSummary.keyQuotes.length) {
      (perceptionSummary as any).keyQuotes = rawSummary.keyQuotes;
    }

    // Pass through enriched sub-fields in patternDetection
    patternDetection = patternDetection.map((p: any, i: number) => {
      const rawP = Array.isArray(raw.patternDetection) ? raw.patternDetection[i] : null;
      if (rawP && Array.isArray(rawP.supportingQuotes)) {
        p.supportingQuotes = rawP.supportingQuotes;
      }
      return p;
    });

    // Pass through enriched sub-fields in blindSpots
    blindSpots = blindSpots.map((bs: any, i: number) => {
      const rawBS = Array.isArray(raw.blindSpots) ? raw.blindSpots[i] : null;
      if (rawBS?.evidence) {
        bs.evidence = rawBS.evidence;
      }
      return bs;
    });

    // Pass through narrative in perceptionGap
    if (raw.perceptionGap?.narrative) {
      perceptionGap.narrative = raw.perceptionGap.narrative;
    }

    return {
      executiveSummary,
      perceptionSummary,
      dimensionBreakdown,
      patternDetection,
      blindSpots,
      perceptionGap,
      reviewerConsensus,
      growthRecommendations,
      communityInsights,
    };
  }

  /**
   * Map a perception gap score (0-100) to a level label.
   */
  private scoreToGapLevel(score: number): 'exceptional' | 'good' | 'significant_gaps' | 'major_disconnect' {
    if (score <= 25) return 'exceptional';
    if (score <= 50) return 'good';
    if (score <= 75) return 'significant_gaps';
    return 'major_disconnect';
  }

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
   *
   * FIX: Now passes maxTokens and temperature correctly to DinaLLMManager.generate()
   * using the parameter names that generate() actually reads (max_tokens, temperature).
   * Also reduced timeout to prevent the Express timeout from firing first.
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
          max_tokens: maxTokens,  // DinaLLMManager reads this key
          temperature,
          model_preference: 'qwen2.5:3b',
          task: 'truthstream_analysis',
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`TruthStream LLM synthesis timeout after ${TIMEOUT_MS / 1000}s`)),
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

      throw new Error('No content in LLM response — received keys: ' + (response ? Object.keys(response).join(', ') : 'null'));
    } catch (error: any) {
      clearTimeout(timeoutId!);
      const errorMessage = error instanceof Error ? error.message : String(error || 'Unknown LLM error');
      this.logger.error('LLM call failed', { error: errorMessage });
      throw new Error(errorMessage);
    }
  }

  /**
   * Parse JSON response from LLM, handling markdown code blocks.
   * Enhanced with fallback extraction for partially malformed responses.
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
    } catch (firstError: any) {
      // Fallback: try to find any JSON object in the response
      try {
        const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
        if (jsonObjectMatch) {
          return JSON.parse(jsonObjectMatch[0]) as T;
        }
      } catch {
        // Fall through to final error
      }

      this.logger.error('Failed to parse LLM JSON response', {
        error: firstError.message,
        contentPreview: content.substring(0, 300),
      });
      throw new Error(`Failed to parse TruthStream synthesis response: ${firstError.message}. Content preview: "${content.substring(0, 100)}..."`);
    }
  }
}
