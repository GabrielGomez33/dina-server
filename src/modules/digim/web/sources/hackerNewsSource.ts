// File: src/modules/digim/web/sources/hackerNewsSource.ts
// ============================================================================
// DIGIM WEB-RESEARCH — HACKER NEWS SOURCE  [Phase 2.3]
// ============================================================================
//
// Query-driven discovery via the free, key-free Algolia HN Search API. Returns
// top matching stories. A story's external URL is preferred; "Ask/Show HN" posts
// with no external URL fall back to their HN discussion page.
//
// The API host (hn.algolia.com) is operator-trusted; the story URLs it returns
// are untrusted and vetted by the pipeline before any fetch.
// ============================================================================

import { DigimWebConfig } from '../config/webConfig';
import { SearchResult } from '../types';
import { SourceTool, sourceFetchText } from './sourceTool';

export class HackerNewsSource implements SourceTool {
  readonly name = 'hn';
  constructor(private cfg: DigimWebConfig) {}

  isEnabled(): boolean {
    return this.cfg.sources.includes('hn');
  }

  async collect(query: string, limit: number): Promise<SearchResult[]> {
    if (!this.isEnabled()) return [];
    const q = (query || '').trim();
    if (!q) return [];

    const url =
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}` +
      `&tags=story&hitsPerPage=${limit}`;

    const body = await sourceFetchText(
      url,
      { method: 'GET', headers: { 'User-Agent': this.cfg.userAgent, Accept: 'application/json' } },
      this.cfg.fetchTimeoutMs,
      this.cfg.maxContentBytes
    );
    if (!body) return [];

    let data: any;
    try {
      data = JSON.parse(body);
    } catch {
      return [];
    }
    const hits: any[] = Array.isArray(data?.hits) ? data.hits : [];

    const out: SearchResult[] = [];
    for (const h of hits) {
      if (out.length >= limit) break;
      const external = typeof h?.url === 'string' ? h.url.trim() : '';
      const objectId = String(h?.objectID || '').trim();
      const url = external || (objectId ? `https://news.ycombinator.com/item?id=${objectId}` : '');
      if (!url) continue;
      out.push({
        title: String(h?.title || h?.story_title || '').trim() || '(untitled)',
        url,
        snippet: typeof h?.points === 'number' ? `${h.points} points, ${h.num_comments || 0} comments on Hacker News` : 'Hacker News story',
        publishedAt: typeof h?.created_at === 'string' ? h.created_at : undefined,
        provider: this.name,
      });
    }
    return out;
  }
}
