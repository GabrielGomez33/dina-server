// ============================================================================
// INSIGHT SYNTHESIZER - Mirror Module Entry Point for LLM Insight Generation
// ============================================================================
// File: src/modules/mirror/processors/insightSynthesizer.ts
// ----------------------------------------------------------------------------
// This processor replaces direct LLM chat access from mirror-server.
// All insight synthesis requests from mirror-server MUST route through this
// processor via the mirror module to ensure:
//   1. Separation of concerns (mirror module owns all Mirror intelligence)
//   2. Context enrichment from mirror's user/group data
//   3. Consistent prompt engineering and response formatting
//   4. Centralized rate limiting and access control
// ============================================================================

import { EventEmitter } from 'events';
// Lightweight logger shim — mirrors the Logger interface used by mirror-server
// without requiring an external utils/logger module.
class Logger {
  private context: string;
  constructor(context: string) { this.context = context; }
  info(msg: string, meta?: any)  { console.log(`[${this.context}] ${msg}`, meta ?? ''); }
  warn(msg: string, meta?: any)  { console.warn(`[${this.context}] ${msg}`, meta ?? ''); }
  error(msg: string, meta?: any) { console.error(`[${this.context}] ${msg}`, meta ?? ''); }
  debug(msg: string, meta?: any) { console.debug(`[${this.context}] ${msg}`, meta ?? ''); }
}

// ============================================================================
// TYPES
// ============================================================================

export interface InsightSynthesisRequest {
  /** The type of synthesis being requested */
  synthesisType: 'group_analysis' | 'conversation_analysis' | 'post_session_summary';

  /** Group context */
  groupId: string;
  sessionId?: string;

  /** The core analysis data to synthesize */
  analysisData: {
    /** For group_analysis: compatibility, strengths, risks, etc. */
    compatibilityMatrix?: any;
    collectiveStrengths?: any[];
    conflictRisks?: any[];
    goalAlignment?: any;

    /** For conversation_analysis: transcript summary and dynamics */
    conversationSummary?: string;
    participationData?: any;
    sessionDuration?: number;
    transcriptCount?: number;
    compatibilityContext?: any;
  };

  /** User-provided extra context to incorporate into analysis */
  userContext?: string;

  /** Conversation history for additional context (truncated for performance) */
  conversationHistory?: ConversationHistoryEntry[];

  /** Analysis options */
  options?: {
    maxTokens?: number;
    temperature?: number;
    focusAreas?: string[];
    insightType?: string;
    memberCount?: number;
    dataCompleteness?: number;
  };

  /** Security context */
  security?: {
    userId?: string;
    sessionId?: string;
    clearance?: string;
  };
}

export interface ConversationHistoryEntry {
  speaker: string;
  text: string;
  timestamp?: string;
}

export interface InsightSynthesisResponse {
  success: boolean;
  synthesis?: GroupSynthesisResult | ConversationSynthesisResult;
  error?: string;
  metadata: {
    processingTimeMs: number;
    modelUsed: string;
    tokensGenerated?: number;
    contextTokensUsed?: number;
    synthesisType: string;
  };
}

export interface GroupSynthesisResult {
  overview: string;
  keyInsights: string[];
  recommendations: string[];
  narratives: {
    compatibility?: string;
    strengths?: string;
    challenges?: string;
    opportunities?: string;
  };
}

export interface ConversationSynthesisResult {
  keyObservations: string[];
  recommendations: string[];
  dynamicsAssessment?: {
    participationBalance: number;
    engagementLevel: number;
    topicCoherence: number;
    emotionalTone: string;
    interactionPatterns: string[];
  };
  compatibilityNotes?: string[];
  confidenceScore: number;
  relevanceScore: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum conversation history entries to include in prompt */
const MAX_CONVERSATION_HISTORY_ENTRIES = 50;

/** Maximum characters for conversation history in prompt */
const MAX_CONVERSATION_HISTORY_CHARS = 8000;

/** Maximum characters for user context */
const MAX_USER_CONTEXT_CHARS = 2000;

/** Default LLM parameters */
const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_TEMPERATURE = 0.7;

/** Processing timeout */
const SYNTHESIS_TIMEOUT_MS = 120000; // 2 minutes

// ============================================================================
// INSIGHT SYNTHESIZER CLASS
// ============================================================================

export class InsightSynthesizer extends EventEmitter {
  private logger: Logger;
  private llmManager: any; // DinaLLMManager instance
  private isInitialized: boolean = false;

  constructor(llmManager: any) {
    super();
    this.logger = new Logger('InsightSynthesizer');
    this.llmManager = llmManager;
  }

  async initialize(): Promise<void> {
    this.isInitialized = true;
    this.logger.info('InsightSynthesizer initialized');
  }

  // ==========================================================================
  // MAIN SYNTHESIS METHOD
  // ==========================================================================

  /**
   * Synthesize insights from analysis data.
   * This is the single entry point for all mirror-server insight requests.
   */
  async synthesize(request: InsightSynthesisRequest): Promise<InsightSynthesisResponse> {
    const startTime = Date.now();

    this.logger.info('Insight synthesis requested', {
      synthesisType: request.synthesisType,
      groupId: request.groupId,
      hasUserContext: !!request.userContext,
      conversationHistoryEntries: request.conversationHistory?.length || 0,
    });

    try {
      // Validate request
      this.validateRequest(request);

      // Sanitize user context
      const sanitizedUserContext = this.sanitizeUserContext(request.userContext);

      // Truncate conversation history for performance
      const truncatedHistory = this.truncateConversationHistory(
        request.conversationHistory
      );

      // Build the enriched prompt based on synthesis type
      const prompt = this.buildEnrichedPrompt(
        request,
        sanitizedUserContext,
        truncatedHistory
      );

      // Call LLM through the mirror module's LLM manager
      const llmResponse = await this.callLLM(prompt, request.options);

      // Parse response based on synthesis type
      const synthesis = this.parseResponse(
        llmResponse,
        request.synthesisType
      );

      const processingTime = Date.now() - startTime;

      this.logger.info('Insight synthesis completed', {
        synthesisType: request.synthesisType,
        groupId: request.groupId,
        processingTimeMs: processingTime,
      });

      return {
        success: true,
        synthesis,
        metadata: {
          processingTimeMs: processingTime,
          modelUsed: 'mistral:7b',
          synthesisType: request.synthesisType,
        },
      };
    } catch (error: any) {
      const processingTime = Date.now() - startTime;

      this.logger.error('Insight synthesis failed', {
        error: error.message,
        synthesisType: request.synthesisType,
        groupId: request.groupId,
        processingTimeMs: processingTime,
      });

      return {
        success: false,
        error: 'Insight synthesis failed. Please try again.',
        metadata: {
          processingTimeMs: processingTime,
          modelUsed: 'mistral:7b',
          synthesisType: request.synthesisType,
        },
      };
    }
  }

  // ==========================================================================
  // VALIDATION
  // ==========================================================================

  private validateRequest(request: InsightSynthesisRequest): void {
    if (!request.synthesisType) {
      throw new Error('synthesisType is required');
    }

    if (!request.groupId) {
      throw new Error('groupId is required');
    }

    if (!request.analysisData) {
      throw new Error('analysisData is required');
    }

    const validTypes = [
      'group_analysis',
      'conversation_analysis',
      'post_session_summary',
    ];
    if (!validTypes.includes(request.synthesisType)) {
      throw new Error(
        `Invalid synthesisType: ${request.synthesisType}. Must be one of: ${validTypes.join(', ')}`
      );
    }
  }

  // ==========================================================================
  // USER CONTEXT SANITIZATION
  // ==========================================================================

  private sanitizeUserContext(userContext?: string): string | undefined {
    if (!userContext) return undefined;

    // Trim and limit length
    let sanitized = String(userContext).trim();
    if (sanitized.length > MAX_USER_CONTEXT_CHARS) {
      sanitized = sanitized.substring(0, MAX_USER_CONTEXT_CHARS);
      this.logger.warn('User context truncated', {
        originalLength: userContext.length,
        truncatedTo: MAX_USER_CONTEXT_CHARS,
      });
    }

    // Remove potential injection patterns (prompt injection defense)
    // Covers OpenAI role markers, Mistral [INST] tags, ChatML tokens, and code fences
    sanitized = sanitized
      .replace(/\b(system|assistant|user)\s*:/gi, '$1 -')
      .replace(/```/g, "'''")
      .replace(/\[INST\]|\[\/INST\]|<<SYS>>|<<\/SYS>>|<\/s>|<s>/gi, '')
      .replace(/<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>/gi, '');

    return sanitized || undefined;
  }

  // ==========================================================================
  // CONVERSATION HISTORY TRUNCATION
  // ==========================================================================

  /**
   * Truncate conversation history to balance context vs performance.
   * Strategy: Keep most recent messages, respecting both entry count
   * and character limits. This provides enough context for quality
   * analysis without creating unbearable latency.
   */
  private truncateConversationHistory(
    history?: ConversationHistoryEntry[]
  ): ConversationHistoryEntry[] | undefined {
    if (!history || history.length === 0) return undefined;

    // Take most recent entries up to max count
    let truncated = history.slice(-MAX_CONVERSATION_HISTORY_ENTRIES);

    // Enforce character limit
    let totalChars = 0;
    const withinLimit: ConversationHistoryEntry[] = [];

    // Iterate from most recent backwards to keep newest context
    for (let i = truncated.length - 1; i >= 0; i--) {
      const entryChars = (truncated[i].speaker?.length || 0) + (truncated[i].text?.length || 0);
      if (totalChars + entryChars > MAX_CONVERSATION_HISTORY_CHARS) {
        break;
      }
      totalChars += entryChars;
      withinLimit.unshift(truncated[i]);
    }

    if (withinLimit.length < history.length) {
      this.logger.debug('Conversation history truncated', {
        originalEntries: history.length,
        truncatedEntries: withinLimit.length,
        totalChars,
      });
    }

    return withinLimit.length > 0 ? withinLimit : undefined;
  }

  // ==========================================================================
  // PROMPT BUILDING
  // ==========================================================================

  /**
   * Build an enriched prompt that combines:
   * - Core analysis data
   * - User-provided extra context
   * - Conversation history
   * - Focus areas and type-specific instructions
   */
  private buildEnrichedPrompt(
    request: InsightSynthesisRequest,
    userContext?: string,
    conversationHistory?: ConversationHistoryEntry[]
  ): string {
    switch (request.synthesisType) {
      case 'group_analysis':
        return this.buildGroupAnalysisPrompt(request, userContext, conversationHistory);
      case 'conversation_analysis':
        return this.buildConversationAnalysisPrompt(request, userContext, conversationHistory);
      case 'post_session_summary':
        return this.buildPostSessionPrompt(request, userContext, conversationHistory);
      default:
        return this.buildGroupAnalysisPrompt(request, userContext, conversationHistory);
    }
  }

  private buildGroupAnalysisPrompt(
    request: InsightSynthesisRequest,
    userContext?: string,
    conversationHistory?: ConversationHistoryEntry[]
  ): string {
    const { analysisData, options } = request;
    const memberCount = options?.memberCount || 0;
    const dataCompleteness = options?.dataCompleteness || 0;

    const parts: string[] = [];

    // System instruction
    parts.push(
      'You are an expert group dynamics analyst integrated into the Mirror intelligence platform. ' +
      'Provide clear, actionable, compassionate insights about group compatibility, strengths, challenges, and opportunities. ' +
      'Format all responses as valid JSON.'
    );
    parts.push('');

    // Core analysis data
    parts.push(`Analyze this ${memberCount}-member group and provide insights.`);
    parts.push('');
    parts.push(`Group Size: ${memberCount} members`);
    parts.push(`Data Completeness: ${Math.round(dataCompleteness * 100)}%`);

    if (analysisData.compatibilityMatrix) {
      const avg = analysisData.compatibilityMatrix.averageCompatibility;
      const level = avg >= 0.7 ? 'strong' : avg >= 0.5 ? 'moderate' : 'developing';
      parts.push(`Compatibility: ${Math.round(avg * 100)}% average (${level})`);
    }

    if ((analysisData.collectiveStrengths?.length ?? 0) > 0) {
      const names = analysisData.collectiveStrengths!
        .slice(0, 3)
        .map((s: any) => s.name)
        .join(', ');
      parts.push(`Collective Strengths: ${names}`);
    }

    if ((analysisData.conflictRisks?.length ?? 0) > 0) {
      const riskSummary = analysisData.conflictRisks!
        .slice(0, 3)
        .map((r: any) => `${r.type?.replace(/_/g, ' ')} (${r.severity})`)
        .join(', ');
      parts.push(`Conflict Risks: ${riskSummary}`);
    }

    if (analysisData.goalAlignment) {
      parts.push(
        `Goal Alignment: ${Math.round((analysisData.goalAlignment.overallAlignment || 0) * 100)}%`
      );
    }

    // User-provided extra context
    if (userContext) {
      parts.push('');
      parts.push('=== Additional Context from Group Owner ===');
      parts.push(userContext);
      parts.push('=== End Additional Context ===');
    }

    // Conversation history for richer context
    if (conversationHistory && conversationHistory.length > 0) {
      parts.push('');
      parts.push('=== Recent Group Conversation (for context) ===');
      for (const entry of conversationHistory) {
        parts.push(`${entry.speaker}: ${entry.text}`);
      }
      parts.push('=== End Conversation ===');
    }

    // Response format
    parts.push('');
    parts.push('Respond with JSON in this exact format:');
    parts.push(JSON.stringify({
      overview: '2-3 sentence summary',
      keyInsights: ['insight 1', 'insight 2', 'insight 3'],
      recommendations: ['recommendation 1', 'recommendation 2'],
      narratives: {
        compatibility: 'brief narrative',
        strengths: 'brief narrative',
        challenges: 'brief narrative',
        opportunities: 'brief narrative',
      },
    }, null, 2));

    return parts.join('\n');
  }

  private buildConversationAnalysisPrompt(
    request: InsightSynthesisRequest,
    userContext?: string,
    conversationHistory?: ConversationHistoryEntry[]
  ): string {
    const { analysisData, options } = request;
    const focusAreas = options?.focusAreas || ['engagement', 'dynamics', 'actionable'];
    const insightType = options?.insightType || 'periodic';

    const parts: string[] = [];

    parts.push(
      'You are an expert in group dynamics and communication analysis, integrated into the Mirror intelligence platform. ' +
      'Analyze this group conversation and provide actionable insights.'
    );
    parts.push('');

    // Conversation summary (from mirror-server's analysis)
    if (analysisData.conversationSummary) {
      parts.push(analysisData.conversationSummary);
      parts.push('');
    }

    // Session context
    parts.push('Session Context:');
    parts.push(`- Duration: ${analysisData.sessionDuration || 0} minutes`);
    parts.push(`- Contributions: ${analysisData.transcriptCount || 0} speech segments`);

    if (analysisData.compatibilityContext) {
      const compat = analysisData.compatibilityContext;
      parts.push(
        `- Group Compatibility: ${Math.round((compat.averageScore || 0) * 100)}%`
      );
      if (compat.keyStrengths?.length > 0) {
        parts.push(`- Strengths: ${compat.keyStrengths.join(', ')}`);
      }
    }

    // User-provided extra context
    if (userContext) {
      parts.push('');
      parts.push('=== Additional Context from User ===');
      parts.push(userContext);
      parts.push('=== End Additional Context ===');
    }

    // Full conversation history for deeper analysis
    if (conversationHistory && conversationHistory.length > 0) {
      parts.push('');
      parts.push('=== Full Conversation Transcript ===');
      for (const entry of conversationHistory) {
        const ts = entry.timestamp ? ` [${entry.timestamp}]` : '';
        parts.push(`${entry.speaker}${ts}: ${entry.text}`);
      }
      parts.push('=== End Transcript ===');
    }

    parts.push('');
    parts.push(`Focus Areas: ${focusAreas.join(', ')}`);
    parts.push('');

    if (insightType === 'post_session') {
      parts.push(
        'Provide a comprehensive post-session summary with action items.'
      );
    } else {
      parts.push(
        'Provide brief, non-intrusive insights for an ongoing conversation.'
      );
    }

    parts.push('');
    parts.push('Respond with JSON:');
    parts.push(JSON.stringify({
      keyObservations: ['observation1', 'observation2'],
      recommendations: ['recommendation1'],
      dynamicsAssessment: {
        participationBalance: 0.8,
        engagementLevel: 0.7,
        topicCoherence: 0.9,
        emotionalTone: 'constructive',
        interactionPatterns: ['pattern1'],
      },
      compatibilityNotes: ['note1'],
      confidenceScore: 0.8,
      relevanceScore: 0.85,
    }, null, 2));

    return parts.join('\n');
  }

  private buildPostSessionPrompt(
    request: InsightSynthesisRequest,
    userContext?: string,
    conversationHistory?: ConversationHistoryEntry[]
  ): string {
    // Post-session summary uses conversation analysis prompt with post_session type
    return this.buildConversationAnalysisPrompt(
      {
        ...request,
        options: {
          ...request.options,
          insightType: 'post_session',
          focusAreas: ['summary', 'outcomes', 'action_items', 'dynamics'],
        },
      },
      userContext,
      conversationHistory
    );
  }

  // ==========================================================================
  // LLM CALL
  // ==========================================================================

  private async callLLM(
    prompt: string,
    options?: InsightSynthesisRequest['options']
  ): Promise<string> {
    const maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS;
    const temperature = options?.temperature || DEFAULT_TEMPERATURE;

    let timeoutId: ReturnType<typeof setTimeout>;

    try {
      const response = await Promise.race([
        this.llmManager.generate(prompt, {
          maxTokens,
          temperature,
          model_preference: 'mistral:7b',
          task: 'analysis',
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('LLM synthesis timeout')),
            SYNTHESIS_TIMEOUT_MS
          );
        }),
      ]);

      // Clear timeout on success to prevent timer leak
      clearTimeout(timeoutId!);

      // Extract content from the response
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

  // ==========================================================================
  // RESPONSE PARSING
  // ==========================================================================

  private parseResponse(
    content: string,
    synthesisType: string
  ): GroupSynthesisResult | ConversationSynthesisResult {
    try {
      let cleanContent = content.trim();

      // Extract JSON from markdown code blocks if present
      const jsonMatch =
        cleanContent.match(/```json\s*([\s\S]*?)\s*```/) ||
        cleanContent.match(/```\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        cleanContent = jsonMatch[1].trim();
      }

      const parsed = JSON.parse(cleanContent);

      if (synthesisType === 'group_analysis') {
        return this.validateGroupSynthesis(parsed);
      } else {
        return this.validateConversationSynthesis(parsed);
      }
    } catch (error: any) {
      this.logger.error('Failed to parse LLM response', {
        error: error.message,
        contentPreview: content.substring(0, 200),
      });
      throw new Error(`Failed to parse synthesis response: ${error.message}`);
    }
  }

  private validateGroupSynthesis(parsed: any): GroupSynthesisResult {
    return {
      overview: parsed.overview || 'Analysis complete - review detailed sections.',
      keyInsights: Array.isArray(parsed.keyInsights)
        ? parsed.keyInsights
        : ['Group analysis complete.'],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations
        : ['Continue fostering open communication.'],
      narratives: {
        compatibility: parsed.narratives?.compatibility || undefined,
        strengths: parsed.narratives?.strengths || undefined,
        challenges: parsed.narratives?.challenges || undefined,
        opportunities: parsed.narratives?.opportunities || undefined,
      },
    };
  }

  private validateConversationSynthesis(
    parsed: any
  ): ConversationSynthesisResult {
    return {
      keyObservations: Array.isArray(parsed.keyObservations)
        ? parsed.keyObservations
        : ['Analysis completed.'],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations
        : ['Continue the discussion.'],
      dynamicsAssessment: parsed.dynamicsAssessment || undefined,
      compatibilityNotes: Array.isArray(parsed.compatibilityNotes)
        ? parsed.compatibilityNotes
        : undefined,
      confidenceScore:
        typeof parsed.confidenceScore === 'number'
          ? parsed.confidenceScore
          : 0.7,
      relevanceScore:
        typeof parsed.relevanceScore === 'number'
          ? parsed.relevanceScore
          : 0.7,
    };
  }

  // ==========================================================================
  // HEALTH CHECK
  // ==========================================================================

  async healthCheck(): Promise<{ healthy: boolean; initialized: boolean }> {
    return {
      healthy: this.isInitialized,
      initialized: this.isInitialized,
    };
  }

  async shutdown(): Promise<void> {
    this.isInitialized = false;
    this.logger.info('InsightSynthesizer shut down');
  }
}
