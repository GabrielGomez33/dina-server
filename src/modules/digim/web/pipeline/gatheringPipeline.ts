// File: src/modules/digim/web/pipeline/gatheringPipeline.ts
// ============================================================================
// DIGIM WEB-RESEARCH — GATHERING PIPELINE
// ============================================================================
//
// The "surf the web" stage. Given a query it:
//   1. Asks the configured search provider for candidate URLs (+ optional seeds).
//   2. De-duplicates candidate URLs and drops obviously bad ones.
//   3. Fetches each (bounded concurrency, SSRF-guarded, polite) — isolated so
//      one bad URL never fails the run.
//   4. Extracts clean content, dedupes by content hash (in-run + DB).
//   5. Scores quality and persists to digim_content.
//   6. Returns the gathered documents + full diagnostics.
//
// Every stage is fault-isolated: a failure is recorded in diagnostics and the
// pipeline moves on. The method resolves even if zero documents are gathered.
// ============================================================================

import { getDigimWebConfig, DigimWebConfig } from '../config/webConfig';
import { createSearchProvider, SearchProvider } from '../gatherers/searchProvider';
import { WebFetcher } from '../gatherers/webFetcher';
import { ContentExtractor } from '../gatherers/contentExtractor';
import { QualityScorer } from '../scoring/qualityScorer';
import { WebResearchStore, toGatheredDocument, StoreContentInput } from '../storage/webResearchStore';
import { checkUrlSafety } from '../security/urlGuard';
import {
  GatherOptions,
  GatherResult,
  GatherDiagnostics,
  GatheredDocument,
  SearchResult,
} from '../types';

export class GatheringPipeline {
  private provider: SearchProvider;
  private fetcher: WebFetcher;
  private extractor: ContentExtractor;
  private scorer: QualityScorer;
  private store: WebResearchStore;

  constructor(private cfg: DigimWebConfig = getDigimWebConfig()) {
    this.provider = createSearchProvider(cfg);
    this.fetcher = new WebFetcher(cfg);
    this.extractor = new ContentExtractor();
    this.scorer = new QualityScorer();
    this.store = new WebResearchStore(cfg);
  }

  get providerName(): string {
    return this.provider.name;
  }

  async gather(options: GatherOptions): Promise<GatherResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const query = (options.query || '').trim();
    const maxDocs = clampInt(options.maxDocuments ?? this.cfg.maxDocumentsPerGather, 1, 50);

    const diagnostics: GatherDiagnostics = {
      searchProvider: this.provider.name,
      candidatesFound: 0,
      fetched: 0,
      extracted: 0,
      stored: 0,
      duplicates: 0,
      skipped: [],
      errors: [],
    };

    if (!this.cfg.enabled) {
      diagnostics.skipped.push({ url: '(all)', reason: 'web-research disabled (DIGIM_WEB_ENABLED=false)' });
      return this.finish(query, [], diagnostics, startedAt, t0);
    }
    if (!query && (!options.seedUrls || options.seedUrls.length === 0)) {
      diagnostics.skipped.push({ url: '(all)', reason: 'empty query and no seed URLs' });
      return this.finish(query, [], diagnostics, startedAt, t0);
    }

    // (1) Search + seeds → candidate URLs.
    let searchResults: SearchResult[] = [];
    if (query) {
      try {
        searchResults = await this.provider.search(query, this.cfg.maxSearchResults);
      } catch (err) {
        diagnostics.errors.push({ url: '(search)', error: (err as Error).message });
      }
    }

    const seeds: SearchResult[] = (options.seedUrls || []).map((u) => ({
      title: '',
      url: u,
      snippet: '',
      provider: 'seed',
    }));

    const candidates = dedupeByUrl([...seeds, ...searchResults]);
    diagnostics.candidatesFound = candidates.length;

    if (candidates.length === 0) {
      return this.finish(query, [], diagnostics, startedAt, t0);
    }

    // Ensure the FK target exists before any writes (once).
    try {
      await this.store.ensureSystemSource();
    } catch (err) {
      diagnostics.errors.push({ url: '(store)', error: `system source init failed: ${(err as Error).message}` });
      return this.finish(query, [], diagnostics, startedAt, t0);
    }

    // (3-5) Fetch → extract → score → store, bounded concurrency, fault-isolated.
    const seenHashes = new Set<string>();
    const documents: GatheredDocument[] = [];

    const worker = async (candidate: SearchResult): Promise<void> => {
      if (documents.length >= maxDocs) return;

      // Pre-flight SSRF check to skip obviously bad URLs cheaply (fetcher also
      // re-checks each hop).
      const safety = await checkUrlSafety(candidate.url, this.cfg);
      if (!safety.safe) {
        diagnostics.skipped.push({ url: candidate.url, reason: safety.reason || 'unsafe' });
        return;
      }

      const fetched = await this.fetcher.fetchUrl(candidate.url);
      if (!fetched.ok) {
        diagnostics.errors.push({ url: candidate.url, error: fetched.error || 'fetch failed' });
        return;
      }
      diagnostics.fetched++;

      const extracted = this.extractor.extract(fetched.body, fetched.contentType, fetched.finalUrl);
      if (extracted.wordCount < this.cfg.minWordCount) {
        diagnostics.skipped.push({
          url: candidate.url,
          reason: `too short (${extracted.wordCount} words < ${this.cfg.minWordCount})`,
        });
        return;
      }
      diagnostics.extracted++;

      // In-run dedup.
      if (seenHashes.has(extracted.contentHash)) {
        diagnostics.duplicates++;
        return;
      }
      seenHashes.add(extracted.contentHash);

      // Merge published date from search result if extractor found none.
      if (!extracted.publishedAt && candidate.publishedAt) {
        const t = Date.parse(candidate.publishedAt);
        if (!Number.isNaN(t)) extracted.publishedAt = new Date(t).toISOString();
      }

      const quality = this.scorer.score({
        query: query || candidate.title || '',
        extracted,
        url: fetched.finalUrl,
        sourceTrust: 0.6,
      });

      const storeInput: StoreContentInput = {
        url: fetched.finalUrl,
        extracted,
        quality,
        provider: candidate.provider,
      };

      try {
        const result = await this.store.storeContent(storeInput);
        if (result.duplicate) {
          diagnostics.duplicates++;
        } else {
          diagnostics.stored++;
        }
        if (documents.length < maxDocs) {
          documents.push(toGatheredDocument(result.id, storeInput, result.duplicate));
        }
      } catch (err) {
        diagnostics.errors.push({ url: candidate.url, error: `store failed: ${(err as Error).message}` });
      }
    };

    await runPool(candidates, this.cfg.fetchConcurrency, worker, () => documents.length >= maxDocs);

    // Rank by overall quality (best first) and trim to the doc budget.
    documents.sort((a, b) => b.quality.overall - a.quality.overall);
    const trimmed = documents.slice(0, maxDocs);

    return this.finish(query, trimmed, diagnostics, startedAt, t0);
  }

  private finish(
    query: string,
    documents: GatheredDocument[],
    diagnostics: GatherDiagnostics,
    startedAt: string,
    t0: number
  ): GatherResult {
    const completedAt = new Date().toISOString();
    return {
      query,
      documents,
      diagnostics,
      startedAt,
      completedAt,
      durationMs: Date.now() - t0,
    };
  }
}

// ----------------------------------------------------------------------------
// CONCURRENCY POOL
// ----------------------------------------------------------------------------

/**
 * Run `worker` over `items` with at most `concurrency` in flight. Stops feeding
 * new work once `shouldStop()` becomes true. Never rejects — a throwing worker
 * is the worker's own responsibility to record.
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean
): Promise<void> {
  const n = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;

  const runners = new Array(n).fill(0).map(async () => {
    while (index < items.length) {
      if (shouldStop()) return;
      const current = index++;
      try {
        await worker(items[current]);
      } catch {
        // Worker is expected to record its own errors; swallow to keep the pool alive.
      }
    }
  });

  await Promise.all(runners);
}

function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = canonicalizeUrl(r.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    // Drop common tracking params for dedupe purposes.
    const drop = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
    for (const p of drop) u.searchParams.delete(p);
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}
