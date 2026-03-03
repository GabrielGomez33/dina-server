// ============================================================================
// TRUTHSTREAM MANAGER - Dina-Server Mirror Module Business Logic
// ============================================================================
// File: src/modules/mirror/truthStreamManager.ts
// ----------------------------------------------------------------------------
// Handles all TruthStream business logic within the dina-server mirror module:
//   1. Truth Card validation and sanitization
//   2. Review quality scoring
//   3. Questionnaire retrieval by goal category
//   4. Minimum data share verification
//   5. Hostility pattern detection
//
// ARCHITECTURE: mirror-server → dina-server mirror module → this manager
// Pattern follows: groupManager.ts
// ============================================================================

import { EventEmitter } from 'events';
import type {
  GoalCategory,
  GOAL_CATEGORIES,
  ValidateTruthCardRequest,
  ValidateTruthCardResponse,
  ScoreReviewQualityRequest,
  ScoreReviewQualityResponse,
  QuestionnaireSection,
} from './types/truthstream';

// ============================================================================
// CONSTANTS
// ============================================================================

const VALID_GOAL_CATEGORIES: readonly string[] = [
  'personal_growth', 'dating_readiness', 'professional_image',
  'social_skills', 'first_impressions', 'leadership',
  'communication', 'authenticity', 'confidence', 'custom',
];

const VALID_SHARED_DATA_TYPES: readonly string[] = [
  'personality', 'cognitive', 'facial', 'voice', 'astrological', 'profile',
];

const MINIMUM_SHARED_DATA_TYPES = 3;
const MAX_ALIAS_LENGTH = 50;
const MIN_ALIAS_LENGTH = 3;
const MAX_GOAL_LENGTH = 1000;
const MAX_SELF_STATEMENT_LENGTH = 2000;
const MAX_FEEDBACK_AREAS = 10;
const MIN_REVIEW_TIME_SECONDS = 45;

/** Quality scoring weights */
const QUALITY_WEIGHT_COMPLETENESS = 0.3;
const QUALITY_WEIGHT_DEPTH = 0.4;
const QUALITY_WEIGHT_CONSTRUCTIVENESS = 0.3;

/** Forbidden patterns in display aliases */
const ALIAS_FORBIDDEN_PATTERNS = [
  /[\x00-\x1F\x7F]/g,        // Control characters
  /[<>"'`\\;{}]/g,            // Script/injection characters
  /@/g,                        // Email-like
  /\./g,                       // Domain-like (could be username)
];

// ============================================================================
// TRUTHSTREAM MANAGER CLASS
// ============================================================================

export class TruthStreamManager extends EventEmitter {
  private initialized: boolean = false;

  constructor() {
    super();
  }

  async initialize(): Promise<void> {
    this.initialized = true;
    console.log('[TruthStreamManager] Initialized');
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    console.log('[TruthStreamManager] Shut down');
  }

  // ==========================================================================
  // 1. TRUTH CARD VALIDATION
  // ==========================================================================

  /**
   * Validate and sanitize truth card creation/update data.
   * Returns validation result with sanitized data, errors, warnings, recommendations.
   */
  validateTruthCard(request: ValidateTruthCardRequest): ValidateTruthCardResponse {
    const errors: string[] = [];
    const warnings: string[] = [];
    const recommendations: string[] = [];

    // ---- Display Alias Validation ----
    const alias = this.sanitizeAlias(request.displayAlias);
    if (!alias) {
      errors.push('Display alias is required');
    } else if (alias.length < MIN_ALIAS_LENGTH) {
      errors.push(`Display alias must be at least ${MIN_ALIAS_LENGTH} characters`);
    } else if (alias.length > MAX_ALIAS_LENGTH) {
      errors.push(`Display alias must be at most ${MAX_ALIAS_LENGTH} characters`);
    }

    // ---- Goal Validation ----
    const goal = this.sanitizeString(request.goal, MAX_GOAL_LENGTH);
    if (!goal || goal.length < 10) {
      errors.push('Goal must be at least 10 characters describing what feedback you want');
    }

    // ---- Goal Category Validation ----
    if (!VALID_GOAL_CATEGORIES.includes(request.goalCategory)) {
      errors.push(`Invalid goal category: ${request.goalCategory}. Valid: ${VALID_GOAL_CATEGORIES.join(', ')}`);
    }

    // ---- Shared Data Types Validation ----
    const validatedSharedTypes = this.validateSharedDataTypes(request.sharedDataTypes);
    if (validatedSharedTypes.length < MINIMUM_SHARED_DATA_TYPES) {
      errors.push(`Must share at least ${MINIMUM_SHARED_DATA_TYPES} data types. Currently sharing: ${validatedSharedTypes.length}`);
    }

    // ---- Self Statement Sanitization ----
    const selfStatement = request.selfStatement
      ? this.sanitizeString(request.selfStatement, MAX_SELF_STATEMENT_LENGTH)
      : undefined;

    // ---- Feedback Areas Validation ----
    const feedbackAreas = this.validateFeedbackAreas(request.feedbackAreas);

    // ---- Recommendations based on goal ----
    if (request.goalCategory === 'dating_readiness' && !validatedSharedTypes.includes('facial')) {
      recommendations.push('For dating readiness feedback, sharing your facial analysis data can provide more relevant insights about physical presentation.');
    }
    if (request.goalCategory === 'professional_image' && !validatedSharedTypes.includes('cognitive')) {
      recommendations.push('For professional image feedback, sharing cognitive data helps reviewers assess intellectual impression.');
    }
    if (request.goalCategory === 'communication' && !validatedSharedTypes.includes('voice')) {
      recommendations.push('For communication feedback, sharing voice data helps reviewers assess vocal qualities.');
    }
    if (request.goalCategory === 'authenticity' && !validatedSharedTypes.includes('personality')) {
      recommendations.push('For authenticity feedback, sharing personality data helps reviewers compare their impression against your actual profile.');
    }
    if (!selfStatement) {
      recommendations.push('Adding a self-statement ("This is who I think I am") helps generate more accurate blind spot analysis.');
    }
    if (feedbackAreas.length === 0) {
      warnings.push('No specific feedback areas selected. Reviewers will focus on your goal category only.');
    }

    // ---- Build Result ----
    if (errors.length > 0) {
      return {
        valid: false,
        errors,
        warnings,
        recommendations,
        sanitizedData: null,
      };
    }

    return {
      valid: true,
      errors: [],
      warnings,
      recommendations,
      sanitizedData: {
        selfStatement: selfStatement || undefined,
        goal: goal!,
        goalCategory: request.goalCategory as GoalCategory,
        sharedDataTypes: validatedSharedTypes,
        feedbackAreas,
        displayAlias: alias!,
      },
    };
  }

  // ==========================================================================
  // 2. REVIEW QUALITY SCORING
  // ==========================================================================

  /**
   * Calculate review quality scores based on completeness, depth, and constructiveness.
   *
   * Quality = (completeness * 0.3) + (depth * 0.4) + (constructiveness * 0.3)
   *
   * Completeness: % of questionnaire fields filled
   * Depth: Free-form text length + explanation quality
   * Constructiveness: Has criticism AND tips? Has honest opinion with reasoning?
   */
  scoreReviewQuality(request: ScoreReviewQualityRequest): ScoreReviewQualityResponse {
    const { responses, questionnaireSections, timeSpentSeconds, freeFormText } = request;

    // ---- Completeness Score (0-1) ----
    let totalFields = 0;
    let filledFields = 0;

    for (const section of questionnaireSections) {
      for (const question of (section.questions || [])) {
        totalFields++;
        const sectionResponses = responses[section.id];
        if (sectionResponses && sectionResponses[question.id] !== undefined && sectionResponses[question.id] !== null) {
          const answer = sectionResponses[question.id];
          // Check if field is meaningfully filled
          if (typeof answer === 'string' && answer.trim().length === 0) continue;
          if (typeof answer === 'object' && 'score' in answer && answer.score === null) continue;
          filledFields++;
        }
      }
    }

    const completenessScore = totalFields > 0 ? filledFields / totalFields : 0;

    // ---- Depth Score (0-1) ----
    let totalTextLength = 0;
    let explanationCount = 0;
    let explanationsWithSubstance = 0;

    for (const section of questionnaireSections) {
      const sectionResponses = responses[section.id];
      if (!sectionResponses) continue;

      for (const question of (section.questions || [])) {
        const answer = sectionResponses[question.id];
        if (!answer) continue;

        if (question.type === 'free_text' || question.type === 'category_explain') {
          explanationCount++;
          const text = typeof answer === 'string' ? answer : (answer?.explanation || answer?.text || '');
          if (typeof text === 'string') {
            totalTextLength += text.length;
            if (text.length >= 30) explanationsWithSubstance++;
          }
        }
      }
    }

    // Add free-form text
    if (freeFormText) {
      totalTextLength += freeFormText.length;
    }

    // Normalize depth: 500 chars = 0.5, 2000+ chars = 1.0
    const textDepth = Math.min(totalTextLength / 2000, 1.0);
    const explanationDepth = explanationCount > 0
      ? explanationsWithSubstance / explanationCount
      : 0;
    const depthScore = (textDepth * 0.6) + (explanationDepth * 0.4);

    // ---- Constructiveness Score (0-1) ----
    let constructivenessScore = 0;

    // Check for criticism + tips pattern
    const hasCriticism = this.detectsCriticism(responses);
    const hasTips = this.detectsTips(responses);
    const hasAdvice = this.detectsAdvice(responses, freeFormText);

    if (hasCriticism && hasTips) constructivenessScore += 0.3;
    if (hasAdvice) constructivenessScore += 0.3;

    // Free-form with actionable content
    if (freeFormText && freeFormText.length >= 100) {
      constructivenessScore += 0.2;
    }

    // Time adequacy bonus
    const timeAdequate = timeSpentSeconds >= MIN_REVIEW_TIME_SECONDS;
    if (timeAdequate) constructivenessScore += 0.2;

    constructivenessScore = Math.min(constructivenessScore, 1.0);

    // ---- Combined Quality Score ----
    const qualityScore = Math.round(
      ((completenessScore * QUALITY_WEIGHT_COMPLETENESS) +
       (depthScore * QUALITY_WEIGHT_DEPTH) +
       (constructivenessScore * QUALITY_WEIGHT_CONSTRUCTIVENESS)) * 100
    ) / 100;

    return {
      completenessScore: Math.round(completenessScore * 100) / 100,
      depthScore: Math.round(depthScore * 100) / 100,
      qualityScore: Math.round(qualityScore * 100) / 100,
      breakdown: {
        fieldsCompleted: filledFields,
        totalFields,
        freeFormLength: totalTextLength,
        hasAdvice,
        hasCriticism,
        hasTipsForOvercoming: hasTips,
        timeAdequate,
      },
    };
  }

  // ==========================================================================
  // 3. MINIMUM SHARE VERIFICATION
  // ==========================================================================

  /**
   * Check if shared data types meet the minimum requirement (3+ types).
   */
  checkMinimumShareRequirement(sharedDataTypes: string[]): {
    met: boolean;
    count: number;
    minimum: number;
    missing: number;
  } {
    const valid = this.validateSharedDataTypes(sharedDataTypes);
    return {
      met: valid.length >= MINIMUM_SHARED_DATA_TYPES,
      count: valid.length,
      minimum: MINIMUM_SHARED_DATA_TYPES,
      missing: Math.max(0, MINIMUM_SHARED_DATA_TYPES - valid.length),
    };
  }

  // ==========================================================================
  // 4. HOSTILITY PATTERN DETECTION
  // ==========================================================================

  /**
   * Check if a reviewer shows a pattern of hostile reviews.
   * Returns risk assessment based on their hostility history.
   */
  assessHostilityPattern(hostilityCount: number, totalReviews: number): {
    isPattern: boolean;
    hostilityRatio: number;
    riskLevel: 'none' | 'low' | 'moderate' | 'high';
    recommendation: string;
  } {
    if (totalReviews === 0 || hostilityCount === 0) {
      return {
        isPattern: false,
        hostilityRatio: 0,
        riskLevel: 'none',
        recommendation: 'No hostile reviews detected.',
      };
    }

    const ratio = hostilityCount / totalReviews;

    if (ratio >= 0.5 && hostilityCount >= 3) {
      return {
        isPattern: true,
        hostilityRatio: ratio,
        riskLevel: 'high',
        recommendation: 'This reviewer has a significant pattern of hostile reviews. Consider flagging for manual review.',
      };
    }

    if (ratio >= 0.3 && hostilityCount >= 2) {
      return {
        isPattern: true,
        hostilityRatio: ratio,
        riskLevel: 'moderate',
        recommendation: 'This reviewer shows a concerning hostility pattern. Monitor future reviews.',
      };
    }

    if (hostilityCount >= 1) {
      return {
        isPattern: false,
        hostilityRatio: ratio,
        riskLevel: 'low',
        recommendation: 'Isolated hostile review. No pattern detected yet.',
      };
    }

    return {
      isPattern: false,
      hostilityRatio: 0,
      riskLevel: 'none',
      recommendation: 'No hostile reviews detected.',
    };
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  /**
   * Sanitize display alias — strict validation for anonymity.
   */
  private sanitizeAlias(alias: unknown): string | null {
    if (!alias || typeof alias !== 'string') return null;

    let cleaned = alias.trim();

    // Remove forbidden characters
    for (const pattern of ALIAS_FORBIDDEN_PATTERNS) {
      cleaned = cleaned.replace(pattern, '');
    }

    cleaned = cleaned.trim();

    if (cleaned.length < MIN_ALIAS_LENGTH) return null;
    return cleaned.substring(0, MAX_ALIAS_LENGTH);
  }

  /**
   * Sanitize a generic string input.
   */
  private sanitizeString(input: unknown, maxLength: number): string | null {
    if (input === null || input === undefined) return null;
    if (typeof input !== 'string') return null;
    const cleaned = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
    return cleaned.length > 0 ? cleaned.substring(0, maxLength) : null;
  }

  /**
   * Validate and filter shared data types against allowed values.
   */
  private validateSharedDataTypes(types: string[]): string[] {
    if (!Array.isArray(types)) return [];
    return types.filter(t => typeof t === 'string' && VALID_SHARED_DATA_TYPES.includes(t));
  }

  /**
   * Validate feedback areas.
   */
  private validateFeedbackAreas(areas?: string[]): string[] {
    if (!Array.isArray(areas)) return [];
    return areas
      .filter(a => typeof a === 'string' && a.trim().length > 0)
      .map(a => a.trim().substring(0, 100))
      .slice(0, MAX_FEEDBACK_AREAS);
  }

  /**
   * Detect if review responses contain criticism.
   */
  private detectsCriticism(responses: Record<string, any>): boolean {
    const criticismKeywords = [
      'struggle', 'weakness', 'improve', 'growth', 'blind spot',
      'concern', 'issue', 'problem', 'challenge', 'difficult',
      'lack', 'missing', 'needs work', 'could be better',
    ];

    const text = JSON.stringify(responses).toLowerCase();
    return criticismKeywords.some(kw => text.includes(kw));
  }

  /**
   * Detect if review responses contain tips for overcoming criticisms.
   */
  private detectsTips(responses: Record<string, any>): boolean {
    const tipKeywords = [
      'try', 'suggest', 'recommend', 'consider', 'advice',
      'tip', 'should', 'could try', 'practice', 'work on',
      'focus on', 'start', 'develop', 'build', 'learn',
    ];

    const text = JSON.stringify(responses).toLowerCase();
    return tipKeywords.some(kw => text.includes(kw));
  }

  /**
   * Detect if review contains actionable advice.
   */
  private detectsAdvice(responses: Record<string, any>, freeFormText?: string): boolean {
    const adviceKeywords = [
      'advice', 'recommend', 'suggest', 'should', 'could',
      'would help', 'try to', 'consider', 'practice',
    ];

    let text = JSON.stringify(responses).toLowerCase();
    if (freeFormText) text += ' ' + freeFormText.toLowerCase();

    const matchCount = adviceKeywords.filter(kw => text.includes(kw)).length;
    return matchCount >= 2; // At least 2 advice indicators
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const truthStreamManager = new TruthStreamManager();
