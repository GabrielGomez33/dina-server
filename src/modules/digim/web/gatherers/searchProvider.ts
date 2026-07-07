// File: src/modules/digim/web/gatherers/searchProvider.ts
// ============================================================================
// DIGIM WEB-RESEARCH — PLUGGABLE SEARCH PROVIDER LAYER
// ============================================================================
//
// WHY A PROVIDER ABSTRACTION
// --------------------------
// The search-API market is volatile (Microsoft retired the Bing Search API in
// 2025; Brave changed its free tier; self-hosted SearXNG is a strong on-prem
// fit for DINA's own-the-stack posture). Rather than couple DIGIM to one
// vendor, every backend implements a single `SearchProvider` interface and is
// selected by config. Swapping providers is an env change, not a code change.
//
// Providers implemented:
//   * SearXNG  — self-hosted meta-search, free, best fit for an on-prem GPU box.
//   * Brave    — the main independent western index with a real API.
//   * Tavily   — AI-native search+answer API.
//   * None     — graceful no-op so an unconfigured deploy never throws.
//
// SECURITY: providers only PRODUCE candidate URLs. They never fetch them —
// fetching is the fetcher's job and passes through the SSRF guard. Provider
// endpoints themselves are trusted (operator-configured), so provider HTTP
// calls intentionally bypass the URL guard.
// ============================================================================

import { getDigimWebConfig, DigimWebConfig } from '../config/webConfig';
import { SearchResult } from '../types';

export interface SearchProvider {
  readonly name: string;
  /** True when this provider has the config it needs to actually run. */
  isConfigured(): boolean;
  /** Execute a search. MUST resolve (never reject) — errors become []. */
  search(query: string, limit: number): Promise<SearchResult[]>;
}

// ----------------------------------------------------------------------------
// Shared fetch helper for provider API calls (bounded, defensive).
// ----------------------------------------------------------------------------

async function providerFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      console.warn(`⚠️ [searchProvider] HTTP ${res.status} from ${new URL(url).host}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`⚠️ [searchProvider] request failed: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function clampLimit(limit: number, cfg: DigimWebConfig): number {
  if (!Number.isFinite(limit) || limit <= 0) return cfg.maxSearchResults;
  return Math.min(Math.round(limit), cfg.maxSearchResults);
}

// ----------------------------------------------------------------------------
// NONE — graceful no-op
// ----------------------------------------------------------------------------

class NullSearchProvider implements SearchProvider {
  readonly name = 'none';
  isConfigured(): boolean {
    return true; // always "configured" — it just returns nothing
  }
  async search(): Promise<SearchResult[]> {
    console.warn('⚠️ [searchProvider:none] No search provider configured — returning 0 results. Set DIGIM_WEB_SEARCH_PROVIDER.');
    return [];
  }
}

// ----------------------------------------------------------------------------
// SEARXNG — self-hosted meta-search (default recommendation for on-prem)
// ----------------------------------------------------------------------------

class SearxngSearchProvider implements SearchProvider {
  readonly name = 'searxng';
  constructor(private cfg: DigimWebConfig) {}

  isConfigured(): boolean {
    return this.cfg.searxngBaseUrl.trim().length > 0;
  }

  async search(query: string, limit: number): Promise<SearchResult[]> {
    if (!this.isConfigured()) return [];
    const n = clampLimit(limit, this.cfg);
    const base = this.cfg.searxngBaseUrl.replace(/\/+$/, '');
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;

    const data = await providerFetch(
      url,
      { method: 'GET', headers: { 'User-Agent': this.cfg.userAgent, Accept: 'application/json' } },
      this.cfg.fetchTimeoutMs
    );
    if (!data || !Array.isArray(data.results)) return [];

    return data.results.slice(0, n).map((r: any): SearchResult => ({
      title: String(r.title || '').trim() || '(untitled)',
      url: String(r.url || '').trim(),
      snippet: String(r.content || '').trim(),
      publishedAt: typeof r.publishedDate === 'string' ? r.publishedDate : undefined,
      score: typeof r.score === 'number' ? r.score : undefined,
      provider: this.name,
    })).filter((r: SearchResult) => r.url.length > 0);
  }
}

// ----------------------------------------------------------------------------
// BRAVE — independent western index
// ----------------------------------------------------------------------------

class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave';
  constructor(private cfg: DigimWebConfig) {}

  isConfigured(): boolean {
    return this.cfg.braveApiKey.trim().length > 0;
  }

  async search(query: string, limit: number): Promise<SearchResult[]> {
    if (!this.isConfigured()) {
      console.warn('⚠️ [searchProvider:brave] DIGIM_WEB_BRAVE_API_KEY not set — returning 0 results.');
      return [];
    }
    const n = clampLimit(limit, this.cfg);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`;

    const data = await providerFetch(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.cfg.braveApiKey,
          'User-Agent': this.cfg.userAgent,
        },
      },
      this.cfg.fetchTimeoutMs
    );
    const results = data?.web?.results;
    if (!Array.isArray(results)) return [];

    return results.slice(0, n).map((r: any): SearchResult => ({
      title: String(r.title || '').trim() || '(untitled)',
      url: String(r.url || '').trim(),
      snippet: String(r.description || '').trim(),
      publishedAt: typeof r.age === 'string' ? r.age : (typeof r.page_age === 'string' ? r.page_age : undefined),
      provider: this.name,
    })).filter((r: SearchResult) => r.url.length > 0);
  }
}

// ----------------------------------------------------------------------------
// TAVILY — AI-native search
// ----------------------------------------------------------------------------

class TavilySearchProvider implements SearchProvider {
  readonly name = 'tavily';
  constructor(private cfg: DigimWebConfig) {}

  isConfigured(): boolean {
    return this.cfg.tavilyApiKey.trim().length > 0;
  }

  async search(query: string, limit: number): Promise<SearchResult[]> {
    if (!this.isConfigured()) {
      console.warn('⚠️ [searchProvider:tavily] DIGIM_WEB_TAVILY_API_KEY not set — returning 0 results.');
      return [];
    }
    const n = clampLimit(limit, this.cfg);
    const data = await providerFetch(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': this.cfg.userAgent },
        body: JSON.stringify({
          api_key: this.cfg.tavilyApiKey,
          query,
          max_results: n,
          search_depth: 'basic',
        }),
      },
      this.cfg.fetchTimeoutMs
    );
    if (!data || !Array.isArray(data.results)) return [];

    return data.results.slice(0, n).map((r: any): SearchResult => ({
      title: String(r.title || '').trim() || '(untitled)',
      url: String(r.url || '').trim(),
      snippet: String(r.content || '').trim(),
      publishedAt: typeof r.published_date === 'string' ? r.published_date : undefined,
      score: typeof r.score === 'number' ? r.score : undefined,
      provider: this.name,
    })).filter((r: SearchResult) => r.url.length > 0);
  }
}

// ----------------------------------------------------------------------------
// FACTORY
// ----------------------------------------------------------------------------

/**
 * Build the configured search provider. Falls back to the no-op provider when
 * the selected provider is not usable, so callers never have to null-check.
 */
export function createSearchProvider(cfg: DigimWebConfig = getDigimWebConfig()): SearchProvider {
  switch (cfg.searchProvider) {
    case 'searxng': {
      const p = new SearxngSearchProvider(cfg);
      return p.isConfigured() ? p : new NullSearchProvider();
    }
    case 'brave':
      return new BraveSearchProvider(cfg);
    case 'tavily':
      return new TavilySearchProvider(cfg);
    case 'none':
    default:
      return new NullSearchProvider();
  }
}
