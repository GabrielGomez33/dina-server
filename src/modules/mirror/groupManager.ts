// /src/modules/mirror/groupManager.ts
/**
 * DINA MIRROR MODULE - GROUP MANAGER
 *
 * This manager handles all group-related operations that flow through
 * the dina-server's mirror module. It provides:
 *
 * 1. Group creation validation (type, privacy, goal validation before DB write)
 * 2. Group context enrichment for insights (adds group metadata to analysis)
 * 3. Group goal tracking and recommendations
 * 4. Cross-member pattern detection for group insights
 *
 * ARCHITECTURE: mirror-server -> dina-server mirror module -> groupManager
 *
 * All mirror-server group interactions with Dina should enter through
 * this module to maintain separation of concerns.
 */

import { EventEmitter } from 'events';

// ============================================================================
// TYPES
// ============================================================================

export interface GroupValidationRequest {
  name: string;
  type: string;
  subtype?: string;
  privacy: string;
  goal?: string;
  goalCustom?: string;
  description?: string;
  maxMembers?: number;
  creatorUserId: string;
}

export interface GroupValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  recommendations: GroupRecommendation[];
  sanitizedData: SanitizedGroupData | null;
}

export interface SanitizedGroupData {
  name: string;
  type: ValidGroupType;
  subtype: string | null;
  privacy: ValidPrivacy;
  goal: string | null;
  goalCustom: string | null;
  description: string | null;
  maxMembers: number;
  suggestedSettings: GroupSettingsSuggestion;
}

export interface GroupRecommendation {
  type: 'privacy' | 'size' | 'goal' | 'settings' | 'security';
  message: string;
  priority: 'low' | 'medium' | 'high';
}

export interface GroupSettingsSuggestion {
  requireApproval: boolean;
  enableVoting: boolean;
  enableConversationInsights: boolean;
  allowAnonymousSharing: boolean;
}

export interface GroupContextEnrichment {
  groupId: string;
  groupType: string;
  groupSubtype?: string;
  groupGoal?: string;
  memberCount: number;
  memberUserIds: string[];
}

export interface EnrichedGroupContext {
  groupId: string;
  analysisHints: string[];
  focusAreas: string[];
  contextPrompt: string;
}

// ============================================================================
// VALID TYPES
// ============================================================================

const VALID_GROUP_TYPES = [
  'family', 'partners', 'teamwork', 'friends', 'professional',
  'therapy', 'anonymous', 'open', 'private', 'team', 'community', 'public'
] as const;
type ValidGroupType = typeof VALID_GROUP_TYPES[number];

const VALID_PRIVACY = ['private', 'public', 'secret'] as const;
type ValidPrivacy = typeof VALID_PRIVACY[number];

const VALID_PARTNER_SUBTYPES = ['lover', 'platonic'] as const;

// ============================================================================
// TYPE-SPECIFIC CONFIGURATIONS
// ============================================================================

interface TypeConfig {
  defaultPrivacy: ValidPrivacy;
  typicalSizeMin: number;
  typicalSizeMax: number;
  maxMembersMax: number;
  insightsFocus: string[];
  analysisHints: string[];
  suggestedSettings: GroupSettingsSuggestion;
}

const TYPE_CONFIGS: Record<string, TypeConfig> = {
  family: {
    defaultPrivacy: 'private',
    typicalSizeMin: 3,
    typicalSizeMax: 8,
    maxMembersMax: 20,
    insightsFocus: [
      'Intergenerational communication patterns',
      'Shared family traits vs. individual differences',
      'Conflict resolution styles inherited/learned',
    ],
    analysisHints: [
      'Consider generational differences in communication styles',
      'Look for inherited behavioral patterns',
      'Focus on emotional needs across age groups',
    ],
    suggestedSettings: {
      requireApproval: true,
      enableVoting: true,
      enableConversationInsights: true,
      allowAnonymousSharing: false,
    },
  },
  partners: {
    defaultPrivacy: 'private',
    typicalSizeMin: 2,
    typicalSizeMax: 4,
    maxMembersMax: 6,
    insightsFocus: [
      'Compatibility across all modalities',
      'Complementary strengths',
      'Potential friction points and mitigation',
    ],
    analysisHints: [
      'Focus on compatibility and complementarity',
      'Identify communication style differences',
      'Assess emotional intelligence alignment',
    ],
    suggestedSettings: {
      requireApproval: true,
      enableVoting: false,
      enableConversationInsights: true,
      allowAnonymousSharing: false,
    },
  },
  teamwork: {
    defaultPrivacy: 'private',
    typicalSizeMin: 4,
    typicalSizeMax: 20,
    maxMembersMax: 100,
    insightsFocus: [
      'Leadership distribution',
      'Collaboration patterns',
      'Skill complementarity and gap analysis',
      'Goal alignment',
    ],
    analysisHints: [
      'Identify natural leadership styles',
      'Map collaboration preferences',
      'Assess skill gaps and overlaps',
      'Evaluate goal alignment across members',
    ],
    suggestedSettings: {
      requireApproval: true,
      enableVoting: true,
      enableConversationInsights: true,
      allowAnonymousSharing: false,
    },
  },
  friends: {
    defaultPrivacy: 'private',
    typicalSizeMin: 3,
    typicalSizeMax: 10,
    maxMembersMax: 30,
    insightsFocus: ['Social dynamics', 'Communication preferences', 'Group harmony'],
    analysisHints: ['Focus on social dynamics', 'Identify communication preferences'],
    suggestedSettings: {
      requireApproval: true,
      enableVoting: true,
      enableConversationInsights: true,
      allowAnonymousSharing: false,
    },
  },
  professional: {
    defaultPrivacy: 'private',
    typicalSizeMin: 4,
    typicalSizeMax: 20,
    maxMembersMax: 50,
    insightsFocus: ['Work styles', 'Professional growth', 'Team dynamics'],
    analysisHints: ['Focus on professional development', 'Identify work style compatibility'],
    suggestedSettings: {
      requireApproval: true,
      enableVoting: true,
      enableConversationInsights: true,
      allowAnonymousSharing: false,
    },
  },
  therapy: {
    defaultPrivacy: 'private',
    typicalSizeMin: 3,
    typicalSizeMax: 12,
    maxMembersMax: 20,
    insightsFocus: ['Emotional support patterns', 'Progress tracking', 'Safe space dynamics'],
    analysisHints: ['Prioritize emotional safety', 'Track progress gently', 'Respect boundaries'],
    suggestedSettings: {
      requireApproval: true,
      enableVoting: false,
      enableConversationInsights: true,
      allowAnonymousSharing: true,
    },
  },
  anonymous: {
    defaultPrivacy: 'secret',
    typicalSizeMin: 5,
    typicalSizeMax: 25,
    maxMembersMax: 50,
    insightsFocus: ['Aggregated patterns', 'Anonymous insights', 'Collective wisdom'],
    analysisHints: ['Focus on aggregate patterns only', 'Do not identify individuals'],
    suggestedSettings: {
      requireApproval: true,
      enableVoting: true,
      enableConversationInsights: true,
      allowAnonymousSharing: true,
    },
  },
};

// ============================================================================
// GROUP MANAGER CLASS
// ============================================================================

export class MirrorGroupManager extends EventEmitter {
  private initialized: boolean = false;

  constructor() {
    super();
  }

  async initialize(): Promise<void> {
    this.initialized = true;
    console.log('MirrorGroupManager initialized');
  }

  // ========================================================================
  // GROUP CREATION VALIDATION
  // ========================================================================

  /**
   * Validates and sanitizes group creation data.
   * Returns validation result with sanitized data, errors, warnings,
   * and type-specific recommendations.
   */
  validateGroupCreation(request: GroupValidationRequest): GroupValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const recommendations: GroupRecommendation[] = [];

    // ---- Name validation ----
    const name = this.sanitizeString(request.name, 50);
    if (!name || name.length < 3) {
      errors.push('Group name must be between 3 and 50 characters');
    }

    // Check for potentially problematic characters
    if (name && /[<>"'`\\;]/.test(name)) {
      errors.push('Group name contains invalid characters');
    }

    // ---- Type validation ----
    const type = request.type as ValidGroupType;
    if (!VALID_GROUP_TYPES.includes(type as any)) {
      errors.push(`Invalid group type: ${request.type}. Valid types: ${VALID_GROUP_TYPES.join(', ')}`);
    }

    // ---- Subtype validation (partners only) ----
    let subtype: string | null = null;
    if (type === 'partners' && request.subtype) {
      if (VALID_PARTNER_SUBTYPES.includes(request.subtype as any)) {
        subtype = request.subtype;
      } else {
        warnings.push(`Invalid partner subtype: ${request.subtype}. Defaulting to none.`);
      }
    }

    // ---- Privacy validation ----
    let privacy: ValidPrivacy = 'private';
    if (request.privacy && VALID_PRIVACY.includes(request.privacy as any)) {
      privacy = request.privacy as ValidPrivacy;
    } else if (request.privacy) {
      warnings.push(`Invalid privacy: ${request.privacy}. Using default.`);
    }

    // Get type config
    const typeConfig = TYPE_CONFIGS[type] || TYPE_CONFIGS.friends;

    // ---- Privacy recommendations ----
    if (privacy !== typeConfig.defaultPrivacy) {
      if ((type === 'family' || type === 'partners') && privacy === 'public') {
        recommendations.push({
          type: 'privacy',
          message: `${type === 'family' ? 'Family' : 'Partner'} groups typically use private visibility for sensitive content.`,
          priority: 'high',
        });
      }
      if (type === 'anonymous' && privacy !== 'secret') {
        recommendations.push({
          type: 'privacy',
          message: 'Anonymous groups are recommended to use secret privacy for maximum protection.',
          priority: 'high',
        });
      }
    }

    // ---- Goal sanitization ----
    const goal = this.sanitizeString(request.goal, 500);
    const goalCustom = this.sanitizeString(request.goalCustom, 500);

    // ---- Max members validation ----
    let maxMembers = request.maxMembers || typeConfig.typicalSizeMax;
    maxMembers = Math.max(2, Math.min(typeConfig.maxMembersMax, maxMembers));

    if (maxMembers > typeConfig.typicalSizeMax) {
      recommendations.push({
        type: 'size',
        message: `${type} groups typically have ${typeConfig.typicalSizeMin}-${typeConfig.typicalSizeMax} members. Larger groups may reduce intimacy of insights.`,
        priority: 'low',
      });
    }

    // ---- Description requirement for public ----
    const description = this.sanitizeString(request.description, 500);
    if (privacy === 'public' && !description) {
      errors.push('Public groups require a description for the directory listing');
    }

    // ---- Build result ----
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
        name: name!,
        type: type,
        subtype,
        privacy,
        goal,
        goalCustom,
        description,
        maxMembers,
        suggestedSettings: typeConfig.suggestedSettings,
      },
    };
  }

  // ========================================================================
  // GROUP CONTEXT ENRICHMENT
  // ========================================================================

  /**
   * Enriches group context for use in insight synthesis.
   * Called before LLM analysis to provide type-specific analysis guidance.
   */
  enrichGroupContext(enrichment: GroupContextEnrichment): EnrichedGroupContext {
    const typeConfig = TYPE_CONFIGS[enrichment.groupType] || TYPE_CONFIGS.friends;

    const focusAreas = [...typeConfig.insightsFocus];
    const analysisHints = [...typeConfig.analysisHints];

    // Subtype-specific enrichment for partners
    if (enrichment.groupType === 'partners' && enrichment.groupSubtype === 'lover') {
      focusAreas.push('Romantic compatibility indicators');
      focusAreas.push('Emotional attachment patterns');
      analysisHints.push('Assess love language compatibility');
      analysisHints.push('Identify emotional regulation patterns');
    } else if (enrichment.groupType === 'partners' && enrichment.groupSubtype === 'platonic') {
      focusAreas.push('Working style compatibility');
      focusAreas.push('Creative synergy potential');
      analysisHints.push('Focus on professional complementarity');
      analysisHints.push('Evaluate decision-making alignment');
    }

    // Goal-specific enrichment
    if (enrichment.groupGoal) {
      focusAreas.push(`Goal alignment: "${enrichment.groupGoal}"`);
      analysisHints.push(`Frame insights in context of the group goal: "${enrichment.groupGoal}"`);
    }

    // Build context prompt for LLM
    const contextPrompt = this.buildGroupContextPrompt(enrichment, focusAreas, analysisHints);

    return {
      groupId: enrichment.groupId,
      analysisHints,
      focusAreas,
      contextPrompt,
    };
  }

  // ========================================================================
  // GROUP GOAL RECOMMENDATIONS
  // ========================================================================

  /**
   * Returns recommended goals for a given group type.
   * Used by the frontend to show preset options.
   */
  getGoalRecommendations(groupType: string, subtype?: string): string[] {
    const familyGoals = [
      'Improve communication across generations',
      "Understand each other's emotional needs better",
      'Resolve long-standing conflicts',
      'Navigate a major family transition',
      'Build stronger family bonds',
    ];

    const partnerGoals = [
      'Strengthen our relationship and communication',
      "Understand each other's love languages / working styles",
      'Prepare for major life transition together',
      'Deepen emotional connection and trust',
      'Improve conflict resolution skills',
    ];

    const teamworkGoals = [
      'Improve team collaboration and productivity',
      'Advance to leadership positions together',
      'Complete a major project by deadline',
      'Improve code review / creative process',
      'Build a high-performing team culture',
    ];

    switch (groupType) {
      case 'family': return familyGoals;
      case 'partners': {
        if (subtype === 'platonic') {
          return [
            'Strengthen our creative/business partnership',
            "Understand each other's working styles",
            'Prepare for a major business milestone',
            'Improve our decision-making process',
            'Build mutual trust and transparency',
          ];
        }
        return partnerGoals;
      }
      case 'teamwork':
      case 'professional':
        return teamworkGoals;
      default:
        return teamworkGoals;
    }
  }

  // ========================================================================
  // PRIVATE HELPERS
  // ========================================================================

  private sanitizeString(input: unknown, maxLength: number): string | null {
    if (input === null || input === undefined) return null;
    if (typeof input !== 'string') return null;
    const cleaned = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
    return cleaned.length > 0 ? cleaned.substring(0, maxLength) : null;
  }

  private buildGroupContextPrompt(
    enrichment: GroupContextEnrichment,
    focusAreas: string[],
    analysisHints: string[]
  ): string {
    const parts: string[] = [];

    parts.push(`GROUP CONTEXT:`);
    parts.push(`- Type: ${enrichment.groupType}${enrichment.groupSubtype ? ` (${enrichment.groupSubtype})` : ''}`);
    parts.push(`- Members: ${enrichment.memberCount}`);

    if (enrichment.groupGoal) {
      parts.push(`- Goal: "${enrichment.groupGoal}"`);
    }

    parts.push('');
    parts.push('FOCUS AREAS:');
    focusAreas.forEach((area) => parts.push(`- ${area}`));

    parts.push('');
    parts.push('ANALYSIS GUIDANCE:');
    analysisHints.forEach((hint) => parts.push(`- ${hint}`));

    return parts.join('\n');
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const mirrorGroupManager = new MirrorGroupManager();
