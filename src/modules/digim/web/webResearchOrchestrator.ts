// File: src/modules/digim/web/webResearchOrchestrator.ts
// ============================================================================
// DIGIM WEB-RESEARCH — SUBSYSTEM FACADE
// ============================================================================
//
// The single entry point the DIGIM module talks to. It composes the pipeline
// (gather) and the synthesizer (insight) into three cohesive operations:
//
//   • gather(query)   → surf + collect + store documents          (no LLM)
//   • research(query) → gather THEN synthesize into a WebInsight   (LLM)
//   • getCached(query)→ return a fresh cached intelligence, if any (cheap)
//
// It owns its OWN DinaLLMManager instance — the same per-module isolation the
// mirror module uses (contextManager/dataProcessor each `new DinaLLMManager()`),
// so a web-research LLM problem can never take down chat or TruthStream.
//
// It is safe to construct unconditionally: construction does no I/O and touches
// no network. initialize() is where the (optional) LLM warmup happens, and even
// that is guarded so a missing Ollama never blocks DIGIM startup.
// ============================================================================

import { performance } from 'perf_hooks';
import { getDigimWebConfig, DigimWebConfig } from './config/webConfig';
import { GatheringPipeline } from './pipeline/gatheringPipeline';
import { WebInsightSynthesizer } from './processors/webInsightSynthesizer';
import { WebResearchStore } from './storage/webResearchStore';
import { SemanticMemory } from './memory/semanticMemory';
import { checkUrlSafety } from './security/urlGuard';
import { DinaLLMManager } from '../../llm/manager';
import { ResearchPlanner, InvestigationResult, PlannerLevel } from './planner/researchPlanner';
import { GatherResult, WebInsight, RetrievedMemory, SearchResult } from './types';

/** A discovered candidate annotated with whether it would pass the SSRF guard. */
export interface DiscoveredCandidate extends SearchResult {
  safe: boolean;
  safetyReason?: string;
}

export interface DiscoverResult {
  query: string;
  provider: string;
  configured: boolean;
  candidates: DiscoveredCandidate[];
}

export interface WebResearchStatus {
  enabled: boolean;
  provider: string;
  providerConfigured: boolean;
  memoryEnabled: boolean;
  retentionSweepEnabled: boolean;
  retentionDays: number;
  /** Headless-browser (Phase 2.2) operational state. */
  browserEnabled: boolean;
  browserMode: string;
  browserAvailable: boolean;
  browserStatus: string;
  /** Enabled Phase-2.3 discovery sources (rss/wikipedia/hn). */
  sources: string[];
  /** Whether the Phase-2.4 research planner (digim_investigate) is enabled. */
  plannerEnabled: boolean;
  /** Whether the Phase-2.4b relationship graph is enabled. */
  graphEnabled: boolean;
}

export type IntelligenceLevel = 'surface' | 'deep' | 'predictive';
export type BrowserModeOption = 'off' | 'on-miss' | 'always';

export interface ResearchResult {
  query: string;
  level: IntelligenceLevel;
  insight: WebInsight;
  gather: GatherResult;
  intelligenceId?: string;
  cached: boolean;
  processingTimeMs: number;
  /** How many prior-memory docs were injected into synthesis (0 = pure fresh web). */
  memoryUsed: number;
  /** Where the answer came from: 'web' | 'memory' | 'web+memory' | 'none' | 'cache'. */
  basis: 'web' | 'memory' | 'web+memory' | 'none' | 'cache';
}

export class WebResearchOrchestrator {
  private cfg: DigimWebConfig;
  private llmManager: DinaLLMManager;
  private pipeline: GatheringPipeline;
  private synthesizer: WebInsightSynthesizer;
  private store: WebResearchStore;
  private memory: SemanticMemory;
  private initialized = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private pruning = false;

  constructor(cfg: DigimWebConfig = getDigimWebConfig()) {
    this.cfg = cfg;
    this.llmManager = new DinaLLMManager();
    this.pipeline = new GatheringPipeline(cfg);
    this.synthesizer = new WebInsightSynthesizer(this.llmManager, cfg);
    this.store = new WebResearchStore(cfg);
    this.memory = new SemanticMemory(this.llmManager, cfg);
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  get providerName(): string {
    return this.pipeline.providerName;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // Only spin up the LLM when the subsystem is actually enabled — a disabled
    // deploy pays zero cost.
    if (this.cfg.enabled) {
      try {
        await this.llmManager.initialize();
        await this.synthesizer.initialize();
      } catch (err) {
        console.warn(`⚠️ [webResearchOrchestrator] LLM init failed (synthesis will degrade): ${(err as Error).message}`);
      }
      try {
        await this.store.ensureSystemSource();
      } catch (err) {
        console.warn(`⚠️ [webResearchOrchestrator] system source init deferred: ${(err as Error).message}`);
      }
    }
    // Start the retention sweep (bounded, self-limiting; unref'd so it never
    // holds the process open). Only when enabled.
    if (this.cfg.enabled && this.cfg.retentionSweepEnabled && !this.sweepTimer) {
      const intervalMs = this.cfg.retentionSweepIntervalHours * 3600 * 1000;
      this.sweepTimer = setInterval(() => {
        this.prune().catch((err) => console.warn(`⚠️ [webResearchOrchestrator] scheduled prune error: ${(err as Error).message}`));
      }, intervalMs);
      if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
      console.log(`🧹 [webResearchOrchestrator] retention sweep scheduled every ${this.cfg.retentionSweepIntervalHours}h (retention=${this.cfg.contentRetentionDays}d)`);
    }

    this.initialized = true;
    console.log(
      `🌐 [webResearchOrchestrator] ready — enabled=${this.cfg.enabled}, provider=${this.providerName}`
    );
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    try {
      await this.pipeline.shutdown();
      await this.synthesizer.shutdown();
      await this.llmManager.shutdown();
    } catch {
      /* best-effort */
    }
    this.initialized = false;
  }

  /** Gather only — surf the web and store documents, no synthesis. */
  async gather(query: string, opts?: { maxDocuments?: number; seedUrls?: string[]; userId?: string; browserMode?: BrowserModeOption }): Promise<GatherResult> {
    this.assertEnabled();
    const result = await this.pipeline.gather({
      query,
      maxDocuments: opts?.maxDocuments,
      seedUrls: opts?.seedUrls,
      userId: opts?.userId,
      browserMode: opts?.browserMode,
    });
    await this.embedGathered(result);
    return result;
  }

  /**
   * Recall from semantic memory only — no gathering. Returns documents already
   * in memory most relevant to the query, by meaning.
   */
  async recall(query: string, opts?: { topK?: number; minScore?: number }): Promise<RetrievedMemory[]> {
    this.assertEnabled();
    return this.memory.retrieve(query, { topK: opts?.topK, minScore: opts?.minScore });
  }

  /**
   * Discovery inspection — run the search provider and return candidate URLs,
   * each annotated with whether it would pass the SSRF guard, WITHOUT fetching.
   * Lets operators see (and audit) what DINA would gather before it does.
   */
  async discover(query: string, opts?: { limit?: number }): Promise<DiscoverResult> {
    this.assertEnabled();
    const raw = await this.pipeline.search(query, opts?.limit);
    const candidates: DiscoveredCandidate[] = [];
    for (const r of raw) {
      const safety = await checkUrlSafety(r.url, this.cfg);
      candidates.push({ ...r, safe: safety.safe, safetyReason: safety.reason });
    }
    return {
      query: (query || '').trim(),
      provider: this.providerName,
      configured: this.pipeline.providerConfigured,
      candidates,
    };
  }

  /** Operational status of the web-research subsystem. */
  getStatus(): WebResearchStatus {
    return {
      enabled: this.cfg.enabled,
      provider: this.providerName,
      providerConfigured: this.pipeline.providerConfigured,
      memoryEnabled: this.cfg.memoryEnabled,
      retentionSweepEnabled: this.cfg.retentionSweepEnabled,
      retentionDays: this.cfg.contentRetentionDays,
      browserEnabled: this.cfg.browserEnabled,
      browserMode: this.cfg.browserMode,
      browserAvailable: this.pipeline.browserAvailable,
      browserStatus: this.pipeline.browserStatusReason,
      sources: this.pipeline.sourceNames,
      plannerEnabled: this.cfg.plannerEnabled,
      graphEnabled: this.cfg.graphEnabled,
    };
  }

  /** Embed freshly-gathered (non-duplicate) documents into semantic memory. */
  private async embedGathered(result: GatherResult): Promise<void> {
    if (!this.memory.enabled) return;
    const items = result.documents
      .filter((d) => !d.duplicate) // already embedded on a prior run
      .map((d) => ({ id: d.id, text: d.content, metadata: { url: d.url, title: d.title, provider: d.provider } }));
    if (items.length === 0) return;
    try {
      await this.memory.embedMany(items);
    } catch (err) {
      console.warn(`⚠️ [webResearchOrchestrator] batch embed failed: ${(err as Error).message}`);
    }
  }

  /** Backfill embeddings for content still pending (admin/maintenance). */
  async backfillMemory(limit = 100): Promise<{ processed: number; embedded: number; failed: number }> {
    this.assertEnabled();
    return this.memory.backfillPending(limit);
  }

  /**
   * Prune aged content (older than contentRetentionDays) — removes the content
   * rows AND their vectors — plus expired cached intelligence. Bounded per run
   * by retentionSweepBatch. Runs on a schedule and on demand. Never throws.
   */
  async prune(): Promise<{ contentDeleted: number; vectorsRemoved: number; intelligencePruned: number }> {
    if (this.pruning) return { contentDeleted: 0, vectorsRemoved: 0, intelligencePruned: 0 };
    this.pruning = true;
    try {
      const ids = await this.store.getExpiredContentIds(this.cfg.contentRetentionDays, this.cfg.retentionSweepBatch);
      const vectorsRemoved = ids.length ? await this.memory.forget(ids) : 0;
      const contentDeleted = ids.length ? await this.store.deleteContentByIds(ids) : 0;
      const intelligencePruned = await this.store.pruneExpiredIntelligence();
      if (contentDeleted > 0 || intelligencePruned > 0) {
        console.log(`🧹 [webResearchOrchestrator] retention sweep: content=${contentDeleted} vectors=${vectorsRemoved} intelligence=${intelligencePruned}`);
      }
      return { contentDeleted, vectorsRemoved, intelligencePruned };
    } catch (err) {
      console.warn(`⚠️ [webResearchOrchestrator] prune failed: ${(err as Error).message}`);
      return { contentDeleted: 0, vectorsRemoved: 0, intelligencePruned: 0 };
    } finally {
      this.pruning = false;
    }
  }

  /**
   * Full research: (cache →) gather → synthesize → persist intelligence.
   * `forceRefresh` bypasses the cache.
   */
  async research(
    query: string,
    opts?: {
      level?: IntelligenceLevel;
      maxDocuments?: number;
      seedUrls?: string[];
      userId?: string;
      forceRefresh?: boolean;
      browserMode?: BrowserModeOption;
    }
  ): Promise<ResearchResult> {
    this.assertEnabled();
    const start = performance.now();
    const level: IntelligenceLevel = opts?.level || 'surface';
    const cleanQuery = (query || '').trim();
    if (!cleanQuery && (!opts?.seedUrls || opts.seedUrls.length === 0)) {
      throw new Error('research requires a non-empty query or seed URLs');
    }

    // (cache) Serve a fresh cached result unless refresh is forced. Keyed by
    // query AND level so a 'surface' result isn't served for a 'deep' request.
    if (!opts?.forceRefresh) {
      const cachedRow = await this.store.getFreshIntelligence(cleanQuery, level);
      if (cachedRow) {
        return {
          query: cleanQuery,
          level,
          insight: this.rowToInsight(cachedRow),
          gather: emptyGather(cleanQuery, this.providerName),
          intelligenceId: cachedRow.id,
          cached: true,
          processingTimeMs: performance.now() - start,
          memoryUsed: 0,
          basis: 'cache',
        };
      }
    }

    // (recall) Pull PRIOR knowledge from semantic memory before gathering, so
    // synthesis can connect new findings to what DINA already knows. Uses a
    // STRICTER threshold than the recall endpoint so only strongly-relevant
    // memory is injected + cited (a loose bar cited unrelated old docs as
    // sources — e.g. a battery article for an NBA query).
    let priorMemory: RetrievedMemory[] = [];
    if (this.cfg.memorySynthesisTopK > 0) {
      try {
        priorMemory = await this.memory.retrieve(cleanQuery, {
          minScore: this.cfg.memorySynthesisMinScore,
          topK: this.cfg.memorySynthesisTopK,
        });
      } catch (err) {
        console.warn(`⚠️ [webResearchOrchestrator] memory recall failed: ${(err as Error).message}`);
      }
    }

    // (gather → embed → synthesize)
    const gather = await this.pipeline.gather({
      query: cleanQuery,
      maxDocuments: opts?.maxDocuments,
      seedUrls: opts?.seedUrls,
      userId: opts?.userId,
      browserMode: opts?.browserMode,
    });
    await this.embedGathered(gather);

    const insight = await this.synthesizer.synthesize(cleanQuery, gather.documents, level, priorMemory);

    // (persist) Store the intelligence — best effort, never fails the response.
    let intelligenceId: string | undefined;
    if (gather.documents.length > 0) {
      try {
        intelligenceId = await this.store.storeIntelligence({
          query: cleanQuery,
          userId: opts?.userId,
          level,
          insight,
          sourceContentIds: gather.documents.map((d) => d.id),
          modelUsed: this.cfg.synthesisModel,
          processingTimeMs: performance.now() - start,
        });
      } catch (err) {
        console.warn(`⚠️ [webResearchOrchestrator] intelligence persist failed: ${(err as Error).message}`);
      }
    }

    const gatheredCount = gather.documents.length;
    const memoryUsed = priorMemory.length;
    const basis: ResearchResult['basis'] =
      gatheredCount > 0 && memoryUsed > 0 ? 'web+memory'
      : gatheredCount > 0 ? 'web'
      : memoryUsed > 0 ? 'memory'
      : 'none';

    return {
      query: cleanQuery,
      level,
      insight,
      gather,
      intelligenceId,
      cached: false,
      processingTimeMs: performance.now() - start,
      memoryUsed,
      basis,
    };
  }

  /**
   * Multi-facet investigation (Phase 2.4a): decompose a broad question into
   * sub-queries, research each through the proven pipeline, and fuse into one
   * comprehensive briefing. Composes existing capabilities — no new gathering.
   */
  async investigate(query: string, opts?: { level?: IntelligenceLevel }): Promise<InvestigationResult> {
    this.assertEnabled();
    if (!this.cfg.plannerEnabled) {
      throw new Error('DIGIM research planner is disabled (set DIGIM_WEB_PLANNER_ENABLED=true to enable)');
    }
    const planner = new ResearchPlanner(this.cfg, {
      generate: (prompt) => this.generateText(prompt, 'digim_planner_decompose'),
      research: async (q, level) => {
        const r = await this.research(q, { level: level as IntelligenceLevel });
        return { insight: r.insight, documentsGathered: r.gather.documents.length, basis: r.basis };
      },
      synthesize: (q, sources, level) => this.synthesizer.synthesize(q, sources, level),
    });
    return planner.investigate(query, { level: opts?.level as PlannerLevel });
  }

  /** LLM text generation with a hard timeout (used by the planner's decompose). */
  private async generateText(prompt: string, task: string): Promise<string> {
    const generation = this.llmManager.generate(prompt, {
      maxTokens: this.cfg.synthesisMaxTokens,
      max_tokens: this.cfg.synthesisMaxTokens,
      temperature: 0.3,
      model_preference: this.cfg.synthesisModel,
      task,
    });
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${task} timed out after ${this.cfg.synthesisTimeoutMs}ms`)), this.cfg.synthesisTimeoutMs);
      if (typeof (t as any).unref === 'function') (t as any).unref();
    });
    const response = await Promise.race([generation, timeout]);
    return extractLlmText(response);
  }

  private assertEnabled(): void {
    if (!this.cfg.enabled) {
      throw new Error('DIGIM web-research is disabled (set DIGIM_WEB_ENABLED=true to enable)');
    }
  }

  private rowToInsight(row: any): WebInsight {
    const raw = safeJson(row.raw_data, {});
    return {
      summary: typeof row.summary === 'string' ? row.summary : '',
      keyInsights: safeJson(row.insights, []),
      entities: Array.isArray(raw.entities) ? raw.entities : [],
      topics: Array.isArray(raw.topics) ? raw.topics : [],
      trends: safeJson(row.trends, []),
      confidence: typeof row.confidence_score !== 'undefined' ? Number(row.confidence_score) : 0,
      sources: Array.isArray(raw.sources) ? raw.sources : [],
      caveats: Array.isArray(raw.caveats) ? raw.caveats : [],
    };
  }
}

// ----------------------------------------------------------------------------
// UTIL
// ----------------------------------------------------------------------------

/** Extract readable text from whatever shape the LLM manager returns. */
function extractLlmText(response: any): string {
  if (typeof response === 'string') return response;
  if (response?.response) return response.response;
  if (response?.content) return response.content;
  if (response?.choices?.[0]?.message?.content) return response.choices[0].message.content;
  throw new Error('LLM response had no readable text field');
}

function safeJson(value: any, fallback: any): any {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function emptyGather(query: string, provider: string): GatherResult {
  const now = new Date().toISOString();
  return {
    query,
    documents: [],
    diagnostics: {
      searchProvider: provider,
      candidatesFound: 0,
      fetched: 0,
      extracted: 0,
      stored: 0,
      duplicates: 0,
      browserUsed: 0,
      escalated: 0,
      skipped: [{ url: '(all)', reason: 'served from cache' }],
      errors: [],
    },
    startedAt: now,
    completedAt: now,
    durationMs: 0,
  };
}
