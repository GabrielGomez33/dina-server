// ============================================================================
// PERSONAL ANALYSIS SYNTHESIZER - Mirror Module Processor
// ============================================================================
// File: src/modules/mirror/processors/personalAnalysisSynthesizer.ts
// ----------------------------------------------------------------------------
// Generates comprehensive personal analysis reports for individual users
// using their intake data (personality, astrology, cognitive, emotional, voice)
// combined with journal entries to detect trends and patterns over time.
//
// Follows the same pattern as TruthStreamSynthesizer:
//   - Initialized with the module's own DinaLLMManager instance
//   - Invoked via DUMP messages routed through the orchestrator
//   - Builds enriched LLM prompts from multi-modal user data
//   - Parses structured JSON responses from LLM
//
// ARCHITECTURE: mirror-server -> dina-server /mirror/personal-analysis/generate
//   -> orchestrator -> mirrorModule.handlePersonalAnalysis()
//   -> personalAnalysisSynthesizer.generateAnalysis()
//   -> llmManager.generate()
// ============================================================================

import { EventEmitter } from 'events';

// Lightweight logger shim (same as InsightSynthesizer)
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

export interface PersonalAnalysisRequest {
  userId: string;
  analysisType: 'personal_mirror_report' | 'journal_trend_analysis' | 'growth_trajectory' | 'comprehensive';

  /** Intake data snapshot */
  intakeData: {
    personality?: {
      mbtiType?: string;
      big5Profile?: Record<string, number>;
      dominantTraits?: string[];
      description?: string;
    };
    astrology?: {
      western?: { sunSign?: string; moonSign?: string; risingSign?: string; dominantElement?: string };
      chinese?: { animalSign?: string; element?: string; yinYang?: string };
      african?: { orishaGuardian?: string; elementalForce?: string; lifeDestiny?: string };
      numerology?: { lifePathNumber?: number; destinyNumber?: number; soulUrgeNumber?: number };
      synthesis?: { coreThemes?: string[]; lifeDirection?: string; spiritualPath?: string; relationships?: string; career?: string; wellness?: string };
    };
    cognitive?: {
      iqScore?: number;
      category?: string;
      strengths?: string[];
      percentile?: number;
    };
    emotional?: {
      dominantEmotion?: { emotion: string; confidence: number };
      expressions?: Record<string, number>;
      emotionalStability?: number;
    };
    voice?: {
      quality?: string;
      duration?: number;
    };
  };

  /** Journal entries for trend analysis */
  journalEntries?: JournalEntryData[];

  /** Previous analysis for temporal comparison */
  previousAnalysis?: {
    overallScore?: number;
    generatedAt?: string;
    keyInsights?: string[];
    dimensionScores?: Record<string, number>;
  };

  options?: {
    maxTokens?: number;
    temperature?: number;
    focusAreas?: string[];
  };
}

export interface JournalEntryData {
  entryDate: string;
  timeOfDay: string;
  moodRating: number;
  primaryEmotion: string;
  emotionIntensity: number;
  energyLevel: number;
  freeFormEntry?: string;
  tags?: string[];
  sentimentScore?: number;
  dominantThemes?: string[];
  wordCount?: number;
}

export interface PersonalAnalysisResponse {
  analysisType: string;
  analysisData: PersonalMirrorReportData;
  overallScore: number;
  confidenceLevel: number;
  metadata: {
    journalEntriesAnalyzed: number;
    intakeSectionsAvailable: number;
    modelUsed: string;
    processingTimeMs: number;
  };
}

export interface PersonalMirrorReportData {
  executiveSummary: string;

  dimensionScores: {
    selfAwareness: number;
    emotionalIntelligence: number;
    growthMomentum: number;
    authenticity: number;
    resilience: number;
    mindfulness: number;
  };

  personalityInsights: {
    overview: string;
    strengths: string[];
    growthEdges: string[];
    blindSpots: string[];
  };

  journalAnalysis: {
    moodTrend: 'improving' | 'stable' | 'declining' | 'volatile';
    moodTrendDescription: string;
    emotionalPatterns: Array<{
      pattern: string;
      frequency: string;
      significance: 'high' | 'medium' | 'low';
    }>;
    energyPatterns: {
      peakTimeOfDay: string;
      averageEnergy: number;
      trend: 'increasing' | 'stable' | 'decreasing';
    };
    thematicThreads: Array<{
      theme: string;
      occurrences: number;
      sentiment: 'positive' | 'neutral' | 'negative';
      evolution: string;
    }>;
    writingDepthTrend: 'deepening' | 'stable' | 'surface';
    reflectionQuality: number;
  };

  temporalTrends: {
    overallTrajectory: 'ascending' | 'plateau' | 'descending' | 'cyclical';
    trajectoryDescription: string;
    milestones: Array<{
      date: string;
      description: string;
      type: 'breakthrough' | 'challenge' | 'insight' | 'shift';
    }>;
    comparedToPrevious?: {
      scoreChange: number;
      improvingAreas: string[];
      decliningAreas: string[];
      newInsights: string[];
    };
  };

  crossModalCorrelations: Array<{
    modalities: string[];
    correlation: string;
    insight: string;
    confidence: number;
  }>;

  growthRecommendations: Array<{
    area: string;
    recommendation: string;
    priority: 'high' | 'medium' | 'low';
    actionSteps: string[];
    relatedModalities: string[];
  }>;

  dailyPractices: Array<{
    practice: string;
    targetArea: string;
    frequency: string;
    expectedImpact: string;
  }>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_JOURNAL_ENTRIES = 100;
const MAX_JOURNAL_TEXT_CHARS = 15000;
const DEFAULT_MAX_TOKENS = 3500;
const DEFAULT_TEMPERATURE = 0.5;
const SYNTHESIS_TIMEOUT_MS = 240000; // 4 minutes

const VALID_ANALYSIS_TYPES = new Set([
  'personal_mirror_report',
  'journal_trend_analysis',
  'growth_trajectory',
  'comprehensive',
]);

// ============================================================================
// PERSONAL ANALYSIS SYNTHESIZER CLASS
// ============================================================================

export class PersonalAnalysisSynthesizer extends EventEmitter {
  private logger: Logger;
  private llmManager: any;
  private isInitialized: boolean = false;

  constructor(llmManager: any) {
    super();
    this.logger = new Logger('PersonalAnalysisSynthesizer');
    this.llmManager = llmManager;
  }

  async initialize(): Promise<void> {
    this.isInitialized = true;
    this.logger.info('PersonalAnalysisSynthesizer initialized');
  }

  async shutdown(): Promise<void> {
    this.isInitialized = false;
    this.logger.info('PersonalAnalysisSynthesizer shut down');
  }

  async healthCheck(): Promise<{ healthy: boolean; initialized: boolean }> {
    return { healthy: this.isInitialized, initialized: this.isInitialized };
  }

  // ==========================================================================
  // MAIN ANALYSIS METHOD
  // ==========================================================================

  async generateAnalysis(request: PersonalAnalysisRequest): Promise<PersonalAnalysisResponse> {
    const startTime = Date.now();

    this.logger.info('Personal analysis requested', {
      userId: request.userId,
      analysisType: request.analysisType,
      journalEntries: request.journalEntries?.length || 0,
      intakeSections: this.countIntakeSections(request.intakeData),
    });

    try {
      this.validateRequest(request);

      const truncatedJournal = this.truncateJournalEntries(request.journalEntries);
      const prompt = this.buildAnalysisPrompt(request, truncatedJournal);
      const llmResponse = await this.callLLM(prompt, request.options);
      const rawData = this.parseJsonResponse<any>(llmResponse);
      const analysisData = this.normalizeReportData(rawData, request);
      const overallScore = this.calculateOverallScore(analysisData);

      const processingTimeMs = Date.now() - startTime;

      this.logger.info('Personal analysis completed', {
        userId: request.userId,
        analysisType: request.analysisType,
        overallScore,
        processingTimeMs,
      });

      return {
        analysisType: request.analysisType,
        analysisData,
        overallScore,
        confidenceLevel: this.calculateConfidence(request),
        metadata: {
          journalEntriesAnalyzed: truncatedJournal?.length || 0,
          intakeSectionsAvailable: this.countIntakeSections(request.intakeData),
          modelUsed: 'qwen2.5:3b',
          processingTimeMs,
        },
      };
    } catch (error: any) {
      const processingTimeMs = Date.now() - startTime;

      this.logger.error('Personal analysis failed', {
        error: error.message,
        userId: request.userId,
        analysisType: request.analysisType,
        processingTimeMs,
      });

      throw error;
    }
  }

  // ==========================================================================
  // VALIDATION
  // ==========================================================================

  private validateRequest(request: PersonalAnalysisRequest): void {
    if (!request.userId) {
      throw new Error('userId is required');
    }
    if (!request.analysisType || !VALID_ANALYSIS_TYPES.has(request.analysisType)) {
      throw new Error(
        `Invalid analysisType: ${request.analysisType}. Must be one of: ${[...VALID_ANALYSIS_TYPES].join(', ')}`
      );
    }
    if (!request.intakeData) {
      throw new Error('intakeData is required');
    }
  }

  // ==========================================================================
  // JOURNAL TRUNCATION
  // ==========================================================================

  private truncateJournalEntries(entries?: JournalEntryData[]): JournalEntryData[] | undefined {
    if (!entries || entries.length === 0) return undefined;

    // Sort by date descending (most recent first)
    const sorted = [...entries].sort((a, b) =>
      new Date(b.entryDate).getTime() - new Date(a.entryDate).getTime()
    );

    // Limit count
    let truncated = sorted.slice(0, MAX_JOURNAL_ENTRIES);

    // Limit total text characters
    let totalChars = 0;
    const withinLimit: JournalEntryData[] = [];

    for (const entry of truncated) {
      const entryChars = (entry.freeFormEntry?.length || 0) + 100; // 100 for metadata
      if (totalChars + entryChars > MAX_JOURNAL_TEXT_CHARS) {
        // Truncate the entry text to fit
        if (entry.freeFormEntry && totalChars < MAX_JOURNAL_TEXT_CHARS) {
          const remaining = MAX_JOURNAL_TEXT_CHARS - totalChars;
          entry.freeFormEntry = entry.freeFormEntry.substring(0, remaining);
          withinLimit.push(entry);
        }
        break;
      }
      totalChars += entryChars;
      withinLimit.push(entry);
    }

    if (withinLimit.length < entries.length) {
      this.logger.debug('Journal entries truncated', {
        originalCount: entries.length,
        truncatedCount: withinLimit.length,
        totalChars,
      });
    }

    return withinLimit.length > 0 ? withinLimit : undefined;
  }

  // ==========================================================================
  // PROMPT BUILDING
  // ==========================================================================

  private buildAnalysisPrompt(
    request: PersonalAnalysisRequest,
    journalEntries?: JournalEntryData[]
  ): string {
    const { intakeData, previousAnalysis, analysisType } = request;

    const sections: string[] = [];

    // System context
    sections.push(`You are an expert personal development analyst and psychological insights synthesizer.
You generate structured, insightful personal analysis reports.
You MUST respond with valid JSON only. No markdown, no commentary, no code fences.`);

    // Analysis type
    sections.push(`\n## ANALYSIS TYPE: ${analysisType}`);

    // === INTAKE DATA ===
    sections.push('\n## MULTI-MODAL ASSESSMENT DATA');

    if (intakeData.personality) {
      sections.push(`\n### Personality Profile
- MBTI: ${intakeData.personality.mbtiType || 'Not assessed'}
- Big Five: ${intakeData.personality.big5Profile ? Object.entries(intakeData.personality.big5Profile).map(([k, v]) => `${k}: ${v}%`).join(', ') : 'Not assessed'}
- Dominant Traits: ${intakeData.personality.dominantTraits?.join(', ') || 'None identified'}
- Description: ${intakeData.personality.description || 'N/A'}`);
    }

    if (intakeData.astrology) {
      const a = intakeData.astrology;
      sections.push(`\n### Astrological Profile
- Western: ${a.western?.sunSign || '?'} Sun / ${a.western?.moonSign || '?'} Moon / ${a.western?.risingSign || '?'} Rising (${a.western?.dominantElement || '?'} element)
- Chinese: ${a.chinese?.animalSign || '?'} (${a.chinese?.element || '?'} ${a.chinese?.yinYang || '?'})
- African: Guardian ${a.african?.orishaGuardian || '?'}, ${a.african?.elementalForce || '?'} force, Destiny: ${a.african?.lifeDestiny || '?'}
- Numerology: Life Path ${a.numerology?.lifePathNumber || '?'}, Destiny ${a.numerology?.destinyNumber || '?'}, Soul Urge ${a.numerology?.soulUrgeNumber || '?'}
- Synthesis: ${a.synthesis?.lifeDirection || 'N/A'}`);

      if (a.synthesis?.coreThemes?.length) {
        sections.push(`- Core Themes: ${a.synthesis.coreThemes.join(', ')}`);
      }
    }

    if (intakeData.cognitive) {
      sections.push(`\n### Cognitive Profile
- IQ Score: ${intakeData.cognitive.iqScore || '?'} (${intakeData.cognitive.category || '?'}, ${intakeData.cognitive.percentile || '?'}th percentile)
- Strengths: ${intakeData.cognitive.strengths?.join(', ') || 'Not identified'}`);
    }

    if (intakeData.emotional) {
      sections.push(`\n### Emotional Profile
- Dominant Emotion: ${intakeData.emotional.dominantEmotion?.emotion || '?'} (${Math.round((intakeData.emotional.dominantEmotion?.confidence || 0) * 100)}% confidence)
- Emotional Stability: ${intakeData.emotional.emotionalStability || '?'}%
- Expression Spectrum: ${intakeData.emotional.expressions ? Object.entries(intakeData.emotional.expressions).sort(([, a], [, b]) => (b as number) - (a as number)).slice(0, 5).map(([k, v]) => `${k}: ${(v as number).toFixed(2)}`).join(', ') : 'N/A'}`);
    }

    if (intakeData.voice) {
      sections.push(`\n### Voice Analysis
- Quality: ${intakeData.voice.quality || '?'}
- Duration: ${intakeData.voice.duration || '?'}s`);
    }

    // === JOURNAL DATA ===
    if (journalEntries && journalEntries.length > 0) {
      sections.push(`\n## JOURNAL ENTRIES (${journalEntries.length} entries)`);

      // Aggregate stats
      const moodAvg = journalEntries.reduce((s, e) => s + (e.moodRating || 0), 0) / journalEntries.length;
      const energyAvg = journalEntries.reduce((s, e) => s + (e.energyLevel || 0), 0) / journalEntries.length;
      const emotions = journalEntries.map(e => e.primaryEmotion).filter(Boolean);
      const emotionCounts: Record<string, number> = {};
      emotions.forEach(e => { emotionCounts[e] = (emotionCounts[e] || 0) + 1; });
      const topEmotions = Object.entries(emotionCounts).sort(([, a], [, b]) => b - a).slice(0, 5);
      const allTags = journalEntries.flatMap(e => e.tags || []);
      const tagCounts: Record<string, number> = {};
      allTags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
      const topTags = Object.entries(tagCounts).sort(([, a], [, b]) => b - a).slice(0, 8);
      const allThemes = journalEntries.flatMap(e => e.dominantThemes || []);
      const themeCounts: Record<string, number> = {};
      allThemes.forEach(t => { themeCounts[t] = (themeCounts[t] || 0) + 1; });
      const topThemes = Object.entries(themeCounts).sort(([, a], [, b]) => b - a).slice(0, 6);

      sections.push(`### Aggregate Journal Statistics
- Average Mood: ${moodAvg.toFixed(1)}/10
- Average Energy: ${energyAvg.toFixed(1)}/10
- Date Range: ${journalEntries[journalEntries.length - 1]?.entryDate} to ${journalEntries[0]?.entryDate}
- Top Emotions: ${topEmotions.map(([e, c]) => `${e} (${c}x)`).join(', ')}
- Top Tags: ${topTags.map(([t, c]) => `${t} (${c}x)`).join(', ')}
- Top Themes: ${topThemes.map(([t, c]) => `${t} (${c}x)`).join(', ')}`);

      // Include recent entries with detail
      const recentEntries = journalEntries.slice(0, 15);
      sections.push('\n### Recent Journal Entries (most recent first)');
      recentEntries.forEach(e => {
        sections.push(`- [${e.entryDate} ${e.timeOfDay}] Mood: ${e.moodRating}/10, Energy: ${e.energyLevel}/10, Emotion: ${e.primaryEmotion} (${e.emotionIntensity}/10)${e.freeFormEntry ? ` | "${e.freeFormEntry.substring(0, 300)}"` : ''}${e.tags?.length ? ` [${e.tags.join(', ')}]` : ''}`);
      });

      // Trend data - split into time periods for LLM
      if (journalEntries.length >= 7) {
        const half = Math.floor(journalEntries.length / 2);
        const recentHalf = journalEntries.slice(0, half);
        const olderHalf = journalEntries.slice(half);

        const recentMood = recentHalf.reduce((s, e) => s + (e.moodRating || 0), 0) / recentHalf.length;
        const olderMood = olderHalf.reduce((s, e) => s + (e.energyLevel || 0), 0) / olderHalf.length;
        const recentEnergy = recentHalf.reduce((s, e) => s + (e.energyLevel || 0), 0) / recentHalf.length;
        const olderEnergy = olderHalf.reduce((s, e) => s + (e.energyLevel || 0), 0) / olderHalf.length;

        sections.push(`\n### Temporal Comparison
- Recent period mood avg: ${recentMood.toFixed(1)} vs Earlier period: ${olderMood.toFixed(1)}
- Recent period energy avg: ${recentEnergy.toFixed(1)} vs Earlier period: ${olderEnergy.toFixed(1)}
- Mood trend: ${recentMood > olderMood + 0.5 ? 'IMPROVING' : recentMood < olderMood - 0.5 ? 'DECLINING' : 'STABLE'}
- Energy trend: ${recentEnergy > olderEnergy + 0.5 ? 'INCREASING' : recentEnergy < olderEnergy - 0.5 ? 'DECREASING' : 'STABLE'}`);
      }
    }

    // === PREVIOUS ANALYSIS ===
    if (previousAnalysis) {
      sections.push(`\n## PREVIOUS ANALYSIS (for comparison)
- Previous Overall Score: ${previousAnalysis.overallScore || '?'}
- Generated: ${previousAnalysis.generatedAt || '?'}
- Previous Key Insights: ${previousAnalysis.keyInsights?.join('; ') || 'N/A'}
- Previous Dimension Scores: ${previousAnalysis.dimensionScores ? Object.entries(previousAnalysis.dimensionScores).map(([k, v]) => `${k}: ${v}`).join(', ') : 'N/A'}`);
    }

    // === OUTPUT FORMAT ===
    sections.push(`\n## REQUIRED OUTPUT FORMAT
Respond with ONLY valid JSON matching this structure exactly:
{
  "executiveSummary": "3-5 sentence synthesis of the person's current state, drawing from ALL available data modalities",
  "dimensionScores": {
    "selfAwareness": <0-100>,
    "emotionalIntelligence": <0-100>,
    "growthMomentum": <0-100>,
    "authenticity": <0-100>,
    "resilience": <0-100>,
    "mindfulness": <0-100>
  },
  "personalityInsights": {
    "overview": "2-3 sentence personality synthesis combining MBTI, Big5, and astrological data",
    "strengths": ["strength1", "strength2", "strength3"],
    "growthEdges": ["edge1", "edge2"],
    "blindSpots": ["blindspot1", "blindspot2"]
  },
  "journalAnalysis": {
    "moodTrend": "improving|stable|declining|volatile",
    "moodTrendDescription": "1-2 sentence description of mood patterns",
    "emotionalPatterns": [{"pattern": "...", "frequency": "daily|weekly|occasional", "significance": "high|medium|low"}],
    "energyPatterns": {"peakTimeOfDay": "morning|afternoon|evening|night", "averageEnergy": <1-10>, "trend": "increasing|stable|decreasing"},
    "thematicThreads": [{"theme": "...", "occurrences": <n>, "sentiment": "positive|neutral|negative", "evolution": "how this theme has evolved"}],
    "writingDepthTrend": "deepening|stable|surface",
    "reflectionQuality": <0-100>
  },
  "temporalTrends": {
    "overallTrajectory": "ascending|plateau|descending|cyclical",
    "trajectoryDescription": "1-2 sentence description",
    "milestones": [{"date": "YYYY-MM-DD", "description": "...", "type": "breakthrough|challenge|insight|shift"}],
    "comparedToPrevious": {"scoreChange": <number>, "improvingAreas": ["..."], "decliningAreas": ["..."], "newInsights": ["..."]}
  },
  "crossModalCorrelations": [{"modalities": ["personality", "journal"], "correlation": "...", "insight": "...", "confidence": <0-1>}],
  "growthRecommendations": [{"area": "...", "recommendation": "...", "priority": "high|medium|low", "actionSteps": ["..."], "relatedModalities": ["personality", "journal", "astrology"]}],
  "dailyPractices": [{"practice": "...", "targetArea": "...", "frequency": "daily|weekly", "expectedImpact": "..."}]
}

IMPORTANT:
- All scores are integers 0-100
- Draw correlations between DIFFERENT data modalities (personality + journal, astrology + emotional, etc.)
- ${journalEntries && journalEntries.length > 0 ? 'Journal data IS available - provide detailed journal analysis' : 'No journal entries available - set journalAnalysis fields to reasonable defaults based on intake data'}
- ${previousAnalysis ? 'Previous analysis IS available - provide temporal comparison' : 'No previous analysis - set comparedToPrevious to null'}
- Be specific, actionable, and evidence-based in recommendations
- Reference actual data points from the user's profile in insights`);

    return sections.join('\n');
  }

  // ==========================================================================
  // LLM CALL
  // ==========================================================================

  private async callLLM(prompt: string, options?: PersonalAnalysisRequest['options']): Promise<string> {
    const maxTokens = options?.maxTokens || DEFAULT_MAX_TOKENS;
    const temperature = options?.temperature || DEFAULT_TEMPERATURE;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const response = await Promise.race([
        this.llmManager.generate(prompt, {
          maxTokens,
          max_tokens: maxTokens,
          temperature,
          model_preference: 'qwen2.5:3b',
          task: 'personal_analysis',
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Personal analysis LLM synthesis timeout after ${SYNTHESIS_TIMEOUT_MS / 1000}s`)),
            SYNTHESIS_TIMEOUT_MS
          );
        }),
      ]);

      if (timeoutId) clearTimeout(timeoutId);

      // Extract text from various response formats
      if (typeof response === 'string') return response;
      if (response?.response) return response.response;
      if (response?.content) return response.content;
      if (response?.choices?.[0]?.message?.content) return response.choices[0].message.content;

      this.logger.warn('Unexpected LLM response format', { type: typeof response });
      return JSON.stringify(response);
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      throw error;
    }
  }

  // ==========================================================================
  // RESPONSE PARSING
  // ==========================================================================

  private parseJsonResponse<T>(response: string): T {
    // Strip markdown code fences if present
    let cleaned = response.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    // Find JSON object boundaries
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }

    try {
      return JSON.parse(cleaned) as T;
    } catch (parseError) {
      this.logger.error('Failed to parse LLM JSON response', {
        responseLength: response.length,
        firstChars: response.substring(0, 200),
      });
      throw new Error('Failed to parse personal analysis response as JSON');
    }
  }

  // ==========================================================================
  // DATA NORMALIZATION
  // ==========================================================================

  private normalizeReportData(
    raw: any,
    request: PersonalAnalysisRequest
  ): PersonalMirrorReportData {
    const hasJournal = (request.journalEntries?.length || 0) > 0;

    return {
      executiveSummary: String(raw.executiveSummary || 'Analysis generated based on available data.'),

      dimensionScores: {
        selfAwareness: this.clampScore(raw.dimensionScores?.selfAwareness),
        emotionalIntelligence: this.clampScore(raw.dimensionScores?.emotionalIntelligence),
        growthMomentum: this.clampScore(raw.dimensionScores?.growthMomentum),
        authenticity: this.clampScore(raw.dimensionScores?.authenticity),
        resilience: this.clampScore(raw.dimensionScores?.resilience),
        mindfulness: this.clampScore(raw.dimensionScores?.mindfulness),
      },

      personalityInsights: {
        overview: String(raw.personalityInsights?.overview || 'Personality synthesis pending additional data.'),
        strengths: this.ensureStringArray(raw.personalityInsights?.strengths, 3),
        growthEdges: this.ensureStringArray(raw.personalityInsights?.growthEdges, 2),
        blindSpots: this.ensureStringArray(raw.personalityInsights?.blindSpots, 2),
      },

      journalAnalysis: {
        moodTrend: this.ensureEnum(raw.journalAnalysis?.moodTrend, ['improving', 'stable', 'declining', 'volatile'], 'stable'),
        moodTrendDescription: String(raw.journalAnalysis?.moodTrendDescription || (hasJournal ? 'Mood patterns detected from journal entries.' : 'Begin journaling to track mood trends.')),
        emotionalPatterns: this.ensureArray(raw.journalAnalysis?.emotionalPatterns, []),
        energyPatterns: {
          peakTimeOfDay: String(raw.journalAnalysis?.energyPatterns?.peakTimeOfDay || 'morning'),
          averageEnergy: this.clamp(raw.journalAnalysis?.energyPatterns?.averageEnergy, 1, 10, 5),
          trend: this.ensureEnum(raw.journalAnalysis?.energyPatterns?.trend, ['increasing', 'stable', 'decreasing'], 'stable'),
        },
        thematicThreads: this.ensureArray(raw.journalAnalysis?.thematicThreads, []),
        writingDepthTrend: this.ensureEnum(raw.journalAnalysis?.writingDepthTrend, ['deepening', 'stable', 'surface'], 'stable'),
        reflectionQuality: this.clampScore(raw.journalAnalysis?.reflectionQuality, 50),
      },

      temporalTrends: {
        overallTrajectory: this.ensureEnum(raw.temporalTrends?.overallTrajectory, ['ascending', 'plateau', 'descending', 'cyclical'], 'plateau'),
        trajectoryDescription: String(raw.temporalTrends?.trajectoryDescription || 'Continue journaling and engaging with Mirror to track your trajectory.'),
        milestones: this.ensureArray(raw.temporalTrends?.milestones, []),
        comparedToPrevious: request.previousAnalysis ? {
          scoreChange: typeof raw.temporalTrends?.comparedToPrevious?.scoreChange === 'number' ? raw.temporalTrends.comparedToPrevious.scoreChange : 0,
          improvingAreas: this.ensureStringArray(raw.temporalTrends?.comparedToPrevious?.improvingAreas, 0),
          decliningAreas: this.ensureStringArray(raw.temporalTrends?.comparedToPrevious?.decliningAreas, 0),
          newInsights: this.ensureStringArray(raw.temporalTrends?.comparedToPrevious?.newInsights, 0),
        } : undefined,
      },

      crossModalCorrelations: this.ensureArray(raw.crossModalCorrelations, []).map((c: any) => ({
        modalities: this.ensureStringArray(c.modalities, 2),
        correlation: String(c.correlation || ''),
        insight: String(c.insight || ''),
        confidence: this.clamp(c.confidence, 0, 1, 0.5),
      })),

      growthRecommendations: this.ensureArray(raw.growthRecommendations, []).map((r: any) => ({
        area: String(r.area || 'General'),
        recommendation: String(r.recommendation || ''),
        priority: this.ensureEnum(r.priority, ['high', 'medium', 'low'], 'medium'),
        actionSteps: this.ensureStringArray(r.actionSteps, 0),
        relatedModalities: this.ensureStringArray(r.relatedModalities, 0),
      })),

      dailyPractices: this.ensureArray(raw.dailyPractices, []).map((p: any) => ({
        practice: String(p.practice || ''),
        targetArea: String(p.targetArea || ''),
        frequency: String(p.frequency || 'daily'),
        expectedImpact: String(p.expectedImpact || ''),
      })),
    };
  }

  // ==========================================================================
  // SCORING
  // ==========================================================================

  private calculateOverallScore(data: PersonalMirrorReportData): number {
    const scores = data.dimensionScores;
    const weights = {
      selfAwareness: 0.2,
      emotionalIntelligence: 0.2,
      growthMomentum: 0.15,
      authenticity: 0.2,
      resilience: 0.15,
      mindfulness: 0.1,
    };

    let weighted = 0;
    for (const [key, weight] of Object.entries(weights)) {
      weighted += (scores[key as keyof typeof scores] || 0) * weight;
    }

    return Math.round(weighted);
  }

  private calculateConfidence(request: PersonalAnalysisRequest): number {
    let confidence = 0.3; // Base confidence

    const sections = this.countIntakeSections(request.intakeData);
    confidence += sections * 0.1; // Up to 0.5 from intake

    const journalCount = request.journalEntries?.length || 0;
    if (journalCount >= 30) confidence += 0.15;
    else if (journalCount >= 14) confidence += 0.1;
    else if (journalCount >= 7) confidence += 0.05;

    if (request.previousAnalysis) confidence += 0.05;

    return Math.min(confidence, 0.95);
  }

  // ==========================================================================
  // UTILITY METHODS
  // ==========================================================================

  private countIntakeSections(intakeData: PersonalAnalysisRequest['intakeData']): number {
    let count = 0;
    if (intakeData?.personality?.mbtiType) count++;
    if (intakeData?.astrology?.western?.sunSign) count++;
    if (intakeData?.cognitive?.iqScore) count++;
    if (intakeData?.emotional?.dominantEmotion) count++;
    if (intakeData?.voice?.quality) count++;
    return count;
  }

  private clampScore(value: any, defaultVal: number = 50): number {
    const n = typeof value === 'number' ? value : defaultVal;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  private clamp(value: any, min: number, max: number, defaultVal: number): number {
    const n = typeof value === 'number' ? value : defaultVal;
    return Math.max(min, Math.min(max, n));
  }

  private ensureStringArray(value: any, minLength: number): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v: any) => typeof v === 'string' && v.trim().length > 0);
  }

  private ensureArray(value: any, fallback: any[]): any[] {
    return Array.isArray(value) ? value : fallback;
  }

  private ensureEnum<T extends string>(value: any, valid: T[], defaultVal: T): T {
    return valid.includes(value) ? value : defaultVal;
  }
}
