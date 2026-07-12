// File: src/modules/digim/web/sources/sourceRegistry.ts
// ============================================================================
// DIGIM WEB-RESEARCH — SOURCE REGISTRY  [Phase 2.3]
// ============================================================================
//
// Builds the enabled SourceTools from config and fans a query out to all of them
// in parallel, returning the merged candidate SearchResults. Each source is
// fault-isolated (a throwing/slow source yields [] and never breaks a gather).
// The pipeline then dedupes + SSRF-guards + fetches these exactly like search
// results.
// ============================================================================

import { getDigimWebConfig, DigimWebConfig } from '../config/webConfig';
import { SearchResult } from '../types';
import { SourceTool } from './sourceTool';
import { FeedTool } from './feedTool';
import { WikipediaSource } from './wikipediaSource';
import { HackerNewsSource } from './hackerNewsSource';

/** Construct every source tool, filtered to those enabled by config. */
export function createSourceTools(cfg: DigimWebConfig = getDigimWebConfig()): SourceTool[] {
  const all: SourceTool[] = [
    new WikipediaSource(cfg),
    new HackerNewsSource(cfg),
    new FeedTool(cfg),
  ];
  return all.filter((t) => t.isEnabled());
}

export class SourceRegistry {
  private tools: SourceTool[];

  constructor(private cfg: DigimWebConfig = getDigimWebConfig()) {
    this.tools = createSourceTools(cfg);
  }

  /** Names of the currently-enabled sources (for status/diagnostics). */
  get enabledNames(): string[] {
    return this.tools.map((t) => t.name);
  }

  get hasSources(): boolean {
    return this.tools.length > 0;
  }

  /**
   * Fan the query out to every enabled source in parallel and merge the results.
   * Never rejects — a failing source contributes [].
   */
  async collect(query: string, perSourceLimit?: number): Promise<SearchResult[]> {
    if (this.tools.length === 0) return [];
    const limit = perSourceLimit ?? this.cfg.sourceMaxResults;
    const batches = await Promise.all(
      this.tools.map((t) =>
        t.collect(query, limit).catch((err) => {
          console.warn(`⚠️ [sourceRegistry] source '${t.name}' failed: ${(err as Error).message}`);
          return [] as SearchResult[];
        })
      )
    );
    return batches.flat();
  }
}
