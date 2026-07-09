// File: src/modules/digim/web/memory/semanticMemory.ts
// ============================================================================
// DIGIM WEB-RESEARCH — SEMANTIC MEMORY
// ============================================================================
//
// DINA's "librarian." It turns gathered documents into vectors and finds them
// again by MEANING, not keywords. Two operations:
//
//   embedAndStore(id, text, meta)  → embed with mxbai-embed-large, store the
//                                    vector in the Redis vector index, and mark
//                                    the MySQL row embedded.
//   retrieve(query, opts)          → embed the query, KNN-search the index,
//                                    hydrate the hits from MySQL, then HYBRID
//                                    re-rank (vector + keyword + recency +
//                                    authority) and return the best.
//
// The vector store is the existing `redisManager` (Redis vector index, DIM 1024
// / COSINE — already matches mxbai-embed-large). MySQL remains the source of
// truth for the document text + embedding status. Everything is best-effort:
// a failure never throws into the gather/research path.
// ============================================================================

import { getDigimWebConfig, DigimWebConfig } from '../config/webConfig';
import { redisManager } from '../../../../config/redis';
import { EmbeddingService } from './embeddingService';
import { WebResearchStore } from '../storage/webResearchStore';
import { rankHybrid, MemoryCandidate } from './hybridRank';
import { RetrievedMemory } from '../types';

export type { MemoryCandidate } from './hybridRank';

export interface RetrieveOptions {
  topK?: number;
  minScore?: number;
}

export interface EmbedItem {
  id: string;
  text: string;
  metadata?: Record<string, any>;
}

export class SemanticMemory {
  private embeddingService: EmbeddingService;
  private store: WebResearchStore;

  constructor(llmManager: any, private cfg: DigimWebConfig = getDigimWebConfig()) {
    this.embeddingService = new EmbeddingService(llmManager, cfg);
    this.store = new WebResearchStore(cfg);
  }

  get enabled(): boolean {
    return this.cfg.memoryEnabled;
  }

  /**
   * Embed a document and store its vector. Returns true on success. Marks the
   * MySQL row 'embedded' or 'failed' accordingly. Never throws.
   */
  async embedAndStore(contentId: string, text: string, metadata: Record<string, any> = {}): Promise<boolean> {
    if (!this.cfg.memoryEnabled) return false;

    const vector = await this.embeddingService.embed(text);
    if (!vector) {
      await this.store.markEmbeddingFailed(contentId);
      return false;
    }

    const magnitude = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    try {
      await redisManager.storeEmbedding({
        id: contentId,
        vector,
        metadata: { ...metadata, contentId },
        timestamp: Date.now(),
        model: this.cfg.embedModel,
        dimensions: vector.length,
        magnitude,
      });
      await this.store.markEmbedded(contentId, this.cfg.embedModel, `embedding:${contentId}`);
      return true;
    } catch (err) {
      console.warn(`⚠️ [semanticMemory] storeEmbedding failed for ${contentId}: ${(err as Error).message}`);
      await this.store.markEmbeddingFailed(contentId);
      return false;
    }
  }

  /** Remove vectors for the given content ids from the index. Best-effort. */
  async forget(ids: string[]): Promise<number> {
    let removed = 0;
    for (const id of ids) {
      try {
        await redisManager.deleteEmbedding(id);
        removed++;
      } catch {
        /* best-effort */
      }
    }
    return removed;
  }

  /** Embed many items with bounded concurrency. Returns counts; never throws. */
  async embedMany(items: EmbedItem[], concurrency = 3): Promise<{ embedded: number; failed: number }> {
    if (!this.cfg.memoryEnabled || items.length === 0) return { embedded: 0, failed: 0 };
    let embedded = 0;
    let failed = 0;
    let idx = 0;
    const n = Math.max(1, Math.min(concurrency, items.length));
    const worker = async (): Promise<void> => {
      while (idx < items.length) {
        const it = items[idx++];
        const success = await this.embedAndStore(it.id, it.text, it.metadata || {});
        if (success) embedded++;
        else failed++;
      }
    };
    await Promise.all(new Array(n).fill(0).map(() => worker()));
    return { embedded, failed };
  }

  /**
   * Backfill embeddings for content still marked 'pending' — populates memory
   * for documents gathered before Phase 1, and repairs after a Redis data loss
   * (reset rows to 'pending' first, then run this). Best-effort.
   */
  async backfillPending(limit = 100, concurrency = 3): Promise<{ processed: number; embedded: number; failed: number }> {
    if (!this.cfg.memoryEnabled) return { processed: 0, embedded: 0, failed: 0 };
    const rows = await this.store.getPendingEmbeddingContent(limit);
    const items: EmbedItem[] = rows.map((r) => ({
      id: r.id,
      text: r.content || '',
      metadata: { url: r.url, title: r.title },
    }));
    const { embedded, failed } = await this.embedMany(items, concurrency);
    if (items.length > 0) {
      console.log(`🧩 [semanticMemory] backfill: processed=${items.length} embedded=${embedded} failed=${failed}`);
    }
    return { processed: items.length, embedded, failed };
  }

  /**
   * Retrieve documents from memory most relevant to `query`. Returns [] on any
   * failure (no embedding, empty index, etc.).
   */
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedMemory[]> {
    if (!this.cfg.memoryEnabled) return [];
    const q = (query || '').trim();
    if (!q) return [];

    const topK = clampInt(opts.topK ?? this.cfg.memoryTopK, 1, 50);
    const minScore = typeof opts.minScore === 'number' ? opts.minScore : this.cfg.memoryMinScore;

    const qvec = await this.embeddingService.embed(q);
    if (!qvec) return [];

    // Over-fetch from the vector index, then hybrid re-rank + trim.
    const hits = await redisManager.searchSimilarEmbeddings(qvec, {
      topK: topK * 3,
      threshold: minScore,
      includeMetadata: true,
    });
    if (hits.length === 0) return [];

    const ids = hits.map((h) => h.id);
    const rows = await this.store.getContentByIds(ids);
    const byId = new Map<string, any>(rows.map((r) => [r.id, r]));

    const candidates: MemoryCandidate[] = [];
    for (const h of hits) {
      const r = byId.get(h.id);
      if (!r) continue; // vector present but content gone (purged) — skip
      candidates.push({
        id: h.id,
        title: r.title || '',
        url: r.url || '',
        content: r.content || '',
        publishedAt: toIso(r.published_at),
        provider: h.metadata?.provider,
        vectorScore: clamp01(h.score),
      });
    }

    return rankHybrid(q, candidates).slice(0, topK);
  }
}

// ----------------------------------------------------------------------------
// UTIL
// ----------------------------------------------------------------------------

function toIso(value: any): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}
