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
import { DinaLLMManager } from '../../llm/manager';
import { GatherResult, WebInsight } from './types';

export type IntelligenceLevel = 'surface' | 'deep' | 'predictive';

export interface ResearchResult {
  query: string;
  level: IntelligenceLevel;
  insight: WebInsight;
  gather: GatherResult;
  intelligenceId?: string;
  cached: boolean;
  processingTimeMs: number;
}

export class WebResearchOrchestrator {
  private cfg: DigimWebConfig;
  private llmManager: DinaLLMManager;
  private pipeline: GatheringPipeline;
  private synthesizer: WebInsightSynthesizer;
  private store: WebResearchStore;
  private initialized = false;

  constructor(cfg: DigimWebConfig = getDigimWebConfig()) {
    this.cfg = cfg;
    this.llmManager = new DinaLLMManager();
    this.pipeline = new GatheringPipeline(cfg);
    this.synthesizer = new WebInsightSynthesizer(this.llmManager, cfg);
    this.store = new WebResearchStore(cfg);
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
    this.initialized = true;
    console.log(
      `🌐 [webResearchOrchestrator] ready — enabled=${this.cfg.enabled}, provider=${this.providerName}`
    );
  }

  async shutdown(): Promise<void> {
    try {
      await this.synthesizer.shutdown();
      await this.llmManager.shutdown();
    } catch {
      /* best-effort */
    }
    this.initialized = false;
  }

  /** Gather only — surf the web and store documents, no synthesis. */
  async gather(query: string, opts?: { maxDocuments?: number; seedUrls?: string[]; userId?: string }): Promise<GatherResult> {
    this.assertEnabled();
    return this.pipeline.gather({
      query,
      maxDocuments: opts?.maxDocuments,
      seedUrls: opts?.seedUrls,
      userId: opts?.userId,
    });
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
    }
  ): Promise<ResearchResult> {
    this.assertEnabled();
    const start = performance.now();
    const level: IntelligenceLevel = opts?.level || 'surface';
    const cleanQuery = (query || '').trim();
    if (!cleanQuery && (!opts?.seedUrls || opts.seedUrls.length === 0)) {
      throw new Error('research requires a non-empty query or seed URLs');
    }

    // (cache) Serve a fresh cached result unless refresh is forced.
    if (!opts?.forceRefresh) {
      const cachedRow = await this.store.getFreshIntelligence(cleanQuery);
      if (cachedRow) {
        return {
          query: cleanQuery,
          level,
          insight: this.rowToInsight(cachedRow),
          gather: emptyGather(cleanQuery, this.providerName),
          intelligenceId: cachedRow.id,
          cached: true,
          processingTimeMs: performance.now() - start,
        };
      }
    }

    // (gather → synthesize)
    const gather = await this.pipeline.gather({
      query: cleanQuery,
      maxDocuments: opts?.maxDocuments,
      seedUrls: opts?.seedUrls,
      userId: opts?.userId,
    });

    const insight = await this.synthesizer.synthesize(cleanQuery, gather.documents, level);

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

    return {
      query: cleanQuery,
      level,
      insight,
      gather,
      intelligenceId,
      cached: false,
      processingTimeMs: performance.now() - start,
    };
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
      skipped: [{ url: '(all)', reason: 'served from cache' }],
      errors: [],
    },
    startedAt: now,
    completedAt: now,
    durationMs: 0,
  };
}
