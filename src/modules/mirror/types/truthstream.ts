// ============================================================================
// TRUTHSTREAM TYPES - Dina-Server Mirror Module
// ============================================================================
// File: src/modules/mirror/types/truthstream.ts
// Description: TypeScript interfaces for TruthStream operations within the
//              dina-server mirror module. These types define the contract
//              between mirror-server and dina-server for TruthStream features.
// ============================================================================

// ============================================================================
// ENUMS & CONSTANTS
// ============================================================================

export const GOAL_CATEGORIES = [
  'personal_growth', 'dating_readiness', 'professional_image',
  'social_skills', 'first_impressions', 'leadership',
  'communication', 'authenticity', 'confidence', 'custom',
] as const;
export type GoalCategory = typeof GOAL_CATEGORIES[number];

export const REVIEW_CLASSIFICATIONS = [
  'constructive', 'affirming', 'raw_truth', 'hostile',
] as const;
export type ReviewClassification = typeof REVIEW_CLASSIFICATIONS[number];

export const ANALYSIS_TYPES = [
  'truth_mirror_report', 'perception_gap', 'temporal_trend',
  'blind_spot', 'growth_recommendation',
] as const;
export type AnalysisType = typeof ANALYSIS_TYPES[number];

/** Hostile classification threshold — only label "hostile" if confidence exceeds this */
export const HOSTILE_CONFIDENCE_THRESHOLD = 0.85;

/** Maximum user context characters for prompt injection safety */
export const MAX_USER_CONTEXT_CHARS = 2000;

/** Maximum review text characters in classification prompt */
export const MAX_REVIEW_TEXT_CHARS = 8000;

/** LLM synthesis timeout */
export const SYNTHESIS_TIMEOUT_MS = 120000;

// ============================================================================
// REVIEW CLASSIFICATION
// ============================================================================

/**
 * Request to classify a submitted review via Dina LLM.
 * Sent from mirror-server's TruthStreamQueueProcessor.
 */
export interface ClassifyReviewRequest {
  /** The review ID for tracking */
  reviewId: string;

  /** The review text and structured responses */
  reviewText: string;
  responses: Record<string, any>;

  /** Self-tagged tone from reviewer */
  reviewTone?: string;

  /** The reviewee's goal category — influences classification context */
  revieweeGoal: GoalCategory;

  /** The reviewee's stated goal text */
  revieweeGoalText?: string;

  /** Overall quality metrics pre-computed by mirror-server */
  qualityMetrics?: {
    completenessScore: number;
    depthScore: number;
    timeSpentSeconds: number;
  };
}

/**
 * Classification result returned by Dina LLM.
 */
export interface ClassifyReviewResponse {
  /** The classification label */
  classification: ReviewClassification;

  /** Confidence score 0.0 - 1.0 */
  confidence: number;

  /** Reasoning for the classification */
  reasoning: string;

  /**
   * Counter-analysis for hostile reviews.
   * Provides a balanced perspective based on the reviewee's assessment data,
   * acknowledging the hostile content while offering constructive reframing.
   */
  counterAnalysis?: string;

  /** Detected hostility indicators (for audit logging) */
  hostilityIndicators?: string[];

  /** Whether PII was detected in the review */
  piiDetected?: boolean;
  piiWarnings?: string[];
}

// ============================================================================
// TRUTH MIRROR REPORT (Analysis Generation)
// ============================================================================

/**
 * Request to generate a comprehensive Truth Mirror Report.
 * Aggregates all reviews a user has received into perception insights.
 */
export interface GenerateAnalysisRequest {
  /** User ID for whom the analysis is generated */
  userId: number;

  /** Type of analysis to generate */
  analysisType: AnalysisType;

  /** Anonymized reviews to analyze */
  reviews: AnonymizedReview[];

  /** Self-assessment data from intake */
  selfAssessmentData?: {
    personalityProfile?: {
      big5?: Record<string, number>;
      mbtiType?: string;
      dominantTraits?: string[];
    };
    cognitiveProfile?: {
      category?: string;
      strengths?: string[];
    };
    astrologicalHighlights?: string;
  };

  /** The user's stated goal */
  goal: string;
  goalCategory: GoalCategory;

  /** The user's self-statement */
  selfStatement?: string;

  /** Number of total reviews (may differ from reviews.length if filtered) */
  totalReviewCount: number;

  /** Previous analysis for temporal comparison */
  previousAnalysis?: {
    perceptionGapScore?: number;
    generatedAt?: string;
    keyInsights?: string[];
  };
}

/**
 * Anonymized review data for analysis — no reviewer identity.
 */
export interface AnonymizedReview {
  /** Classification of the review */
  classification?: ReviewClassification;
  classificationConfidence?: number;

  /** Structured responses (JSON) */
  responses: Record<string, any>;

  /** Quality metrics */
  qualityScore: number;
  completenessScore: number;
  depthScore: number;

  /** Temporal info (rounded to nearest hour for anonymity) */
  createdAtRounded: string;

  /** Self-tagged tone */
  selfTaggedTone?: string;
}

/**
 * Generated analysis result.
 */
export interface GenerateAnalysisResponse {
  /** Analysis type */
  analysisType: AnalysisType;

  /** The full analysis data */
  analysisData: TruthMirrorReportData | PerceptionGapData | TemporalTrendData | BlindSpotData | GrowthRecommendationData;

  /** Perception gap score (0-100) */
  perceptionGapScore?: number;

  /** Confidence level in the analysis (0.0-1.0) */
  confidenceLevel: number;

  /** Processing metadata */
  metadata: {
    reviewsAnalyzed: number;
    modelUsed: string;
    processingTimeMs: number;
  };
}

// ============================================================================
// ANALYSIS DATA STRUCTURES
// ============================================================================

export interface TruthMirrorReportData {
  /** Professional executive summary — 3-5 sentences */
  executiveSummary: string;

  /** How others see them — aggregate perception with quotes */
  perceptionSummary: {
    overview: string;
    averageScores: {
      firstImpression: number;
      physicalPresentation: number;
      intellectualAttractiveness: number;
      emotionalAttractiveness: number;
      socialEnergy: number;
      overall: number;
      selfAlignment: number;
    };
    topImpressionWords: Array<{ word: string; count: number; percentage: number }>;
    strengthDistribution: Array<{ category: string; count: number; percentage: number }>;
    struggleDistribution: Array<{ category: string; count: number; percentage: number }>;
    keyQuotes: string[];
  };

  /** Per-dimension score breakdown with reviewer quotes */
  dimensionBreakdown: Array<{
    name: string;
    score: number;
    description: string;
    reviewerQuotes: string[];
  }>;

  /** Patterns multiple reviewers independently noticed, with evidence */
  patternDetection: Array<{
    pattern: string;
    frequency: number;
    reviewerCount: number;
    significance: 'high' | 'medium' | 'low';
    description: string;
    supportingQuotes: string[];
  }>;

  /** Self vs external perception gaps (blind spots) */
  blindSpots: Array<{
    dimension: string;
    selfScore: number;
    externalScore: number;
    gap: number;
    interpretation: string;
    evidence: string;
  }>;

  /** Perception Gap — self-awareness alignment metric */
  perceptionGap: {
    score: number;
    level: 'exceptional' | 'good' | 'significant_gaps' | 'major_disconnect';
    summary: string;
    narrative: string;
    details: string[];
  };

  /** Reviewer consensus — areas of agreement and disagreement */
  reviewerConsensus: {
    overallSentiment: 'positive' | 'mixed' | 'critical';
    sentimentBreakdown: { positive: number; neutral: number; critical: number };
    agreementAreas: string[];
    disagreementAreas: string[];
  };

  /** Goal-specific growth recommendations */
  growthRecommendations: Array<{
    area: string;
    recommendation: string;
    journalPrompt?: string;
    suggestedGroupType?: string;
    priority: 'high' | 'medium' | 'low';
  }>;

  /** Community insights — how user compares to cohort */
  communityInsights: {
    personalityTypeComparison: string;
    percentileScores: Record<string, number>;
  };
}

export interface PerceptionGapData {
  score: number;
  interpretation: string;
  dimensions: Array<{
    name: string;
    selfScore?: number;
    externalScore: number;
    gap: number;
    direction: 'overestimate' | 'underestimate' | 'aligned';
  }>;
  overallDirection: string;
  improvementSuggestions: string[];
}

export interface TemporalTrendData {
  periods: Array<{
    periodLabel: string;
    reviewCount: number;
    averageScore: number;
    topWords: string[];
    sentiment: string;
  }>;
  overallTrend: 'improving' | 'declining' | 'stable' | 'fluctuating';
  trendNarrative: string;
  keyChanges: string[];
}

export interface BlindSpotData {
  blindSpots: Array<{
    area: string;
    selfBelief: string;
    externalReality: string;
    evidenceStrength: 'strong' | 'moderate' | 'suggestive';
    recommendation: string;
  }>;
  selfAwarenessScore: number;
  summary: string;
}

export interface GrowthRecommendationData {
  recommendations: Array<{
    area: string;
    currentState: string;
    targetState: string;
    actionPlan: string[];
    timeframe: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  overallGrowthPotential: string;
  quickWins: string[];
  longTermGoals: string[];
}

// ============================================================================
// TRUTH CARD VALIDATION
// ============================================================================

/**
 * Request to validate and sanitize truth card data before creation.
 */
export interface ValidateTruthCardRequest {
  selfStatement?: string;
  goal: string;
  goalCategory: GoalCategory;
  sharedDataTypes: string[];
  feedbackAreas?: string[];
  displayAlias: string;
}

export interface ValidateTruthCardResponse {
  valid: boolean;
  errors: string[];
  warnings: string[];
  recommendations: string[];
  sanitizedData: {
    selfStatement?: string;
    goal: string;
    goalCategory: GoalCategory;
    sharedDataTypes: string[];
    feedbackAreas: string[];
    displayAlias: string;
  } | null;
}

// ============================================================================
// REVIEW QUALITY SCORING
// ============================================================================

/**
 * Request to score review quality via mirror module.
 */
export interface ScoreReviewQualityRequest {
  responses: Record<string, any>;
  questionnaireSections: any[];
  timeSpentSeconds: number;
  freeFormText?: string;
}

export interface ScoreReviewQualityResponse {
  completenessScore: number;
  depthScore: number;
  qualityScore: number;
  breakdown: {
    fieldsCompleted: number;
    totalFields: number;
    freeFormLength: number;
    hasAdvice: boolean;
    hasCriticism: boolean;
    hasTipsForOvercoming: boolean;
    timeAdequate: boolean;
  };
}

// ============================================================================
// QUESTIONNAIRE
// ============================================================================

export interface QuestionnaireSection {
  id: string;
  title: string;
  required: boolean;
  questions: QuestionnaireQuestion[];
}

export interface QuestionnaireQuestion {
  id: string;
  type: 'scale' | 'select_words' | 'category_explain' | 'free_text' | 'multi_choice';
  text: string;
  config: Record<string, any>;
}

export interface QuestionnaireTemplate {
  id: string;
  goalCategory: GoalCategory;
  version: number;
  sections: QuestionnaireSection[];
}
