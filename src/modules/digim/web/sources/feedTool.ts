// File: src/modules/digim/web/sources/feedTool.ts
// ============================================================================
// DIGIM WEB-RESEARCH — FEED TOOL (RSS / Atom)  [Phase 2.3]
// ============================================================================
//
// Polls operator-configured RSS/Atom feeds and emits their recent entries as
// candidate SearchResults. Unlike the query-driven API sources, feeds are
// AMBIENT — a standing set of URLs the operator trusts (news sites, blogs). When
// a query is present, entries are keyword-filtered; otherwise the latest are
// returned. Good for "what's the latest on X" and (later) monitoring.
//
// PARSER: dependency-free, regex-based over <item>/<entry> blocks — mirrors the
// contentExtractor's heuristic style. It handles the common, well-formed RSS 2.0
// and Atom shapes; malformed feeds degrade to fewer/zero entries, never a throw.
//
// SECURITY: feed URLs are URL-based config, so each feed fetch is run through the
// SSRF guard (cheap defense in depth). The ENTRY URLs a feed yields are untrusted
// and re-checked by the pipeline before any fetch.
// ============================================================================

import { DigimWebConfig } from '../config/webConfig';
import { SearchResult } from '../types';
import { checkUrlSafety } from '../security/urlGuard';
import { SourceTool, sourceFetchText, safeHost } from './sourceTool';

interface FeedEntry {
  title: string;
  url: string;
  summary: string;
  publishedAt?: string;
}

export class FeedTool implements SourceTool {
  readonly name = 'rss';
  constructor(private cfg: DigimWebConfig) {}

  isEnabled(): boolean {
    return this.cfg.sources.includes('feeds') && this.cfg.feedUrls.length > 0;
  }

  async collect(query: string, limit: number): Promise<SearchResult[]> {
    if (!this.isEnabled()) return [];
    const q = (query || '').trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter((t) => t.length > 2) : [];

    const perFeed = Math.max(1, Math.ceil(limit / this.cfg.feedUrls.length));
    const all: SearchResult[] = [];

    for (const feedUrl of this.cfg.feedUrls) {
      if (all.length >= limit) break;
      // SSRF-guard the feed URL itself (operator-configured, but URL-based).
      const safety = await checkUrlSafety(feedUrl, this.cfg);
      if (!safety.safe) {
        console.warn(`⚠️ [feedTool] skipping unsafe feed URL ${safeHost(feedUrl)}: ${safety.reason}`);
        continue;
      }
      const body = await sourceFetchText(
        feedUrl,
        { method: 'GET', headers: { 'User-Agent': this.cfg.userAgent, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } },
        this.cfg.fetchTimeoutMs,
        this.cfg.maxContentBytes
      );
      if (!body) continue;

      const entries = parseFeed(body);
      const filtered = terms.length > 0 ? entries.filter((e) => matchesTerms(e, terms)) : entries;
      for (const e of filtered.slice(0, perFeed)) {
        if (all.length >= limit) break;
        all.push({
          title: e.title || '(untitled)',
          url: e.url,
          snippet: e.summary,
          publishedAt: e.publishedAt,
          provider: this.name,
        });
      }
    }
    return all;
  }
}

// ----------------------------------------------------------------------------
// PARSING (dependency-free)
// ----------------------------------------------------------------------------

export function parseFeed(xml: string): FeedEntry[] {
  const items = matchBlocks(xml, 'item'); // RSS 2.0
  if (items.length > 0) return items.map(parseRssItem).filter((e) => e.url.length > 0);
  const entries = matchBlocks(xml, 'entry'); // Atom
  return entries.map(parseAtomEntry).filter((e) => e.url.length > 0);
}

function matchBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'gi');
  return xml.match(re) || [];
}

function parseRssItem(block: string): FeedEntry {
  return {
    title: tagText(block, 'title'),
    url: tagText(block, 'link'),
    summary: clip(stripTags(tagText(block, 'description')), 400),
    publishedAt: toIso(tagText(block, 'pubDate') || tagText(block, 'dc:date')),
  };
}

function parseAtomEntry(block: string): FeedEntry {
  return {
    title: tagText(block, 'title'),
    url: atomLink(block),
    summary: clip(stripTags(tagText(block, 'summary') || tagText(block, 'content')), 400),
    publishedAt: toIso(tagText(block, 'published') || tagText(block, 'updated')),
  };
}

/** Extract the text of the FIRST <tag>…</tag>, unwrapping CDATA. */
function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  return decodeEntities(unwrapCdata(m[1]).trim());
}

/** Atom links are <link href="..."/>; prefer rel="alternate" (the article). */
function atomLink(block: string): string {
  const links = block.match(/<link\b[^>]*>/gi) || [];
  let fallback = '';
  for (const l of links) {
    const href = (l.match(/href=["']([^"']+)["']/i) || [])[1] || '';
    if (!href) continue;
    const rel = (l.match(/rel=["']([^"']+)["']/i) || [])[1] || 'alternate';
    if (rel === 'alternate') return decodeEntities(href.trim());
    if (!fallback) fallback = decodeEntities(href.trim());
  }
  return fallback;
}

function unwrapCdata(s: string): string {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : s;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function matchesTerms(e: FeedEntry, terms: string[]): boolean {
  const hay = `${e.title} ${e.summary}`.toLowerCase();
  return terms.some((t) => hay.includes(t));
}

function toIso(dateStr: string): string | undefined {
  if (!dateStr) return undefined;
  const t = Date.parse(dateStr);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
