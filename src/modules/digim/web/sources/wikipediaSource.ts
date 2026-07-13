// File: src/modules/digim/web/sources/wikipediaSource.ts
// ============================================================================
// DIGIM WEB-RESEARCH — WIKIPEDIA SOURCE  [Phase 2.3]
// ============================================================================
//
// Query-driven discovery via Wikipedia's key-free `opensearch` API. Returns the
// top matching article URLs, which then flow through the normal pipeline (fetch
// the article HTML we already know how to extract cleanly). Wikipedia's own
// search is far better than a general engine for encyclopedic queries.
//
// The API host (wikipedia.org) is an operator-trusted endpoint, so this call
// doesn't need the SSRF guard; the article URLs it returns are still vetted by
// the pipeline before any fetch.
// ============================================================================

import { DigimWebConfig } from '../config/webConfig';
import { SearchResult } from '../types';
import { SourceTool, sourceFetchText } from './sourceTool';

export class WikipediaSource implements SourceTool {
  readonly name = 'wikipedia';
  constructor(private cfg: DigimWebConfig) {}

  isEnabled(): boolean {
    return this.cfg.sources.includes('wikipedia');
  }

  async collect(query: string, limit: number): Promise<SearchResult[]> {
    if (!this.isEnabled()) return [];
    const q = (query || '').trim();
    if (!q) return [];

    const lang = pickLang(this.cfg.searchLanguage);
    const url =
      `https://${lang}.wikipedia.org/w/api.php?action=opensearch` +
      `&search=${encodeURIComponent(q)}&limit=${limit}&namespace=0&format=json`;

    const body = await sourceFetchText(
      url,
      { method: 'GET', headers: { 'User-Agent': this.cfg.userAgent, Accept: 'application/json' } },
      this.cfg.fetchTimeoutMs,
      this.cfg.maxContentBytes
    );
    if (!body) return [];

    // opensearch returns [term, titles[], descriptions[], urls[]].
    let data: any;
    try {
      data = JSON.parse(body);
    } catch {
      return [];
    }
    if (!Array.isArray(data) || data.length < 4) return [];
    const titles: string[] = Array.isArray(data[1]) ? data[1] : [];
    const descriptions: string[] = Array.isArray(data[2]) ? data[2] : [];
    const urls: string[] = Array.isArray(data[3]) ? data[3] : [];

    const out: SearchResult[] = [];
    for (let i = 0; i < urls.length && out.length < limit; i++) {
      const u = String(urls[i] || '').trim();
      if (!u) continue;
      out.push({
        title: String(titles[i] || '').trim() || '(untitled)',
        url: u,
        snippet: String(descriptions[i] || '').trim(),
        provider: this.name,
      });
    }
    return out;
  }
}

/** Map DINA's search language to a Wikipedia subdomain ('all'/unknown → en). */
function pickLang(searchLanguage: string): string {
  const l = (searchLanguage || '').trim().toLowerCase();
  if (!l || l === 'all') return 'en';
  // Accept 'en', 'fa', 'ar' or IETF tags like 'en-US' → take the primary subtag.
  const primary = l.split('-')[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : 'en';
}
