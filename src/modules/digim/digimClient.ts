// File: src/modules/digim/digimClient.ts
// ============================================================================
// DIGIM — DUMP CLIENT API (for foreign requestees)
// ============================================================================
//
// The single, correct way for ANYTHING outside the DIGIM module — other modules
// (mirror, llm, …) or the HTTP API layer — to reach DIGIM's capabilities over
// the DUMP protocol (DinaUniversalMessage). Callers get typed methods and never
// hand-build a message.
//
// WHY THIS EXISTS
// ---------------
// Before this, every caller assembled the DUMP payload by hand. That duplication
// is exactly how the `browser_mode` field got silently dropped in the HTTP route
// (Phase 2.2): one call site forgot a field. Centralizing message construction
// here means each capability's payload is defined in ONE place — a whole class of
// "forgot to forward a field" bugs simply can't recur.
//
// The client is a thin, transport-correct wrapper: it builds the message with the
// caller's identity/clearance, dispatches it through DinaCore, and returns the
// response's `payload.data`. It performs NO business logic — that stays in the
// DIGIM handlers.
// ============================================================================

import { DinaCore } from '../../core/orchestrator';
import { createDinaMessage, SecurityLevel } from '../../core/protocol';

/** Who is making the call — lets a foreign module pass its own identity/clearance. */
export interface DigimCaller {
  /** The calling module ('api', 'mirror', 'llm', …). */
  sourceModule: string;
  userId?: string;
  sessionId?: string;
  clearance?: SecurityLevel;
}

export type DigimIntelligenceLevel = 'surface' | 'deep' | 'predictive';
export type DigimBrowserMode = 'off' | 'on-miss' | 'always';

export interface DigimResearchInput {
  query?: string;
  seedUrls?: string[];
  intelligenceLevel?: DigimIntelligenceLevel;
  maxDocuments?: number;
  forceRefresh?: boolean;
  browserMode?: DigimBrowserMode;
}

export interface DigimGatherInput {
  query?: string;
  seedUrls?: string[];
  maxDocuments?: number;
  browserMode?: DigimBrowserMode;
}

export interface DigimInvestigateInput {
  query: string;
  intelligenceLevel?: DigimIntelligenceLevel;
}

export interface DigimSearchInput {
  query: string;
  limit?: number;
}

export interface DigimGraphInput {
  query: string;
  maxNodes?: number;
}

export interface DigimRecallInput {
  query: string;
  topK?: number;
  minScore?: number;
}

/**
 * Typed DUMP client for DIGIM. Construct once with the DinaCore instance (and an
 * optional default caller identity), then call the capability methods.
 */
export class DigimClient {
  constructor(private readonly dina: DinaCore, private readonly defaultCaller?: Partial<DigimCaller>) {}

  /** Full research: search → gather → synthesize → cache. */
  research(input: DigimResearchInput, caller?: Partial<DigimCaller>): Promise<any> {
    return this.dispatch('digim_research', 7, {
      query: input.query ?? '',
      seed_urls: input.seedUrls ?? [],
      intelligence_level: input.intelligenceLevel ?? 'surface',
      max_documents: input.maxDocuments,
      force_refresh: input.forceRefresh === true,
      browser_mode: input.browserMode,
    }, caller);
  }

  /** Gather only — surf + collect + store, no synthesis. */
  gather(input: DigimGatherInput, caller?: Partial<DigimCaller>): Promise<any> {
    return this.dispatch('digim_gather', 6, {
      query: input.query ?? '',
      seed_urls: input.seedUrls ?? [],
      max_documents: input.maxDocuments,
      browser_mode: input.browserMode,
    }, caller);
  }

  /** Multi-facet investigation — decompose → research facets → fuse (Phase 2.4a). */
  investigate(input: DigimInvestigateInput, caller?: Partial<DigimCaller>): Promise<any> {
    return this.dispatch('digim_investigate', 7, {
      query: input.query,
      intelligence_level: input.intelligenceLevel ?? 'deep',
    }, caller);
  }

  /** Discovery inspection — candidate URLs (SSRF-annotated), no fetch. */
  search(input: DigimSearchInput, caller?: Partial<DigimCaller>): Promise<any> {
    return this.dispatch('digim_search', 6, {
      query: input.query,
      limit: input.limit,
    }, caller);
  }

  /** Query the relationship graph — subgraph around a focus + suggested view. */
  graph(input: DigimGraphInput, caller?: Partial<DigimCaller>): Promise<any> {
    return this.dispatch('digim_graph', 6, {
      query: input.query,
      max_nodes: input.maxNodes,
    }, caller);
  }

  /** Recall from semantic memory by meaning — no gathering. */
  recall(input: DigimRecallInput, caller?: Partial<DigimCaller>): Promise<any> {
    return this.dispatch('digim_recall', 6, {
      query: input.query,
      top_k: input.topK,
      min_score: input.minScore,
    }, caller);
  }

  /** Subsystem status (provider, memory, browser, sources, retention). */
  status(caller?: Partial<DigimCaller>): Promise<any> {
    return this.dispatch('digim_status', 4, {}, caller);
  }

  /** Maintenance: embed content still pending into semantic memory. */
  memoryBackfill(limit?: number, caller?: Partial<DigimCaller>): Promise<any> {
    return this.dispatch('digim_memory_backfill', 5, { limit }, caller);
  }

  /** Maintenance: run the retention sweep on demand. */
  memoryPrune(caller?: Partial<DigimCaller>): Promise<any> {
    return this.dispatch('digim_memory_prune', 5, {}, caller);
  }

  // --------------------------------------------------------------------------
  // TRANSPORT
  // --------------------------------------------------------------------------

  private async dispatch(method: string, priority: number, payload: any, caller?: Partial<DigimCaller>): Promise<any> {
    const id: Partial<DigimCaller> = { ...this.defaultCaller, ...caller };
    const message = createDinaMessage({
      source: { module: id.sourceModule || 'digim-client', version: '1.0.0' },
      target: { module: 'digim', method, priority },
      security: {
        user_id: id.userId,
        session_id: id.sessionId,
        clearance: id.clearance ?? SecurityLevel.RESTRICTED,
        sanitized: true,
      },
      payload,
    });
    const response = await this.dina.handleIncomingMessage(message);
    return response?.payload?.data;
  }
}
