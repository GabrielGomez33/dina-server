// File: src/modules/digim/web/gatherers/contentExtractor.ts
// ============================================================================
// DIGIM WEB-RESEARCH — HTML CONTENT EXTRACTOR (dependency-free)
// ============================================================================
//
// Turns raw HTML into clean, boilerplate-free main-body text plus metadata.
// Deliberately dependency-free (no jsdom/cheerio/readability) so the subsystem
// adds ZERO new npm packages and cannot break the existing dependency tree.
//
// STRATEGY (heuristic readability, per the research):
//   1. Pull metadata from <head> (title, author, published date, language)
//      BEFORE we strip anything.
//   2. Delete non-content regions: script/style/noscript/svg/nav/header/footer/
//      aside/form and HTML comments.
//   3. Score block-level elements (<p>, <li>, <h1-6>, <article>, <blockquote>)
//      by text length and keep the substantial ones — the Readability insight
//      that main content is text-dense and tag-sparse.
//   4. Strip residual tags, decode entities, collapse whitespace.
//   5. Hash the normalized text (SHA-256) for deduplication.
//
// A Mozilla-Readability adapter can be dropped in later behind the same
// interface (see digim-web-research/INTEGRATION.md) without touching callers.
// ============================================================================

import crypto from 'crypto';
import { ExtractedContent } from '../types';

export class ContentExtractor {
  /**
   * Extract clean content from an HTML (or plain-text) body.
   * `sourceUrl` is used only for logging/fallback titles.
   */
  extract(html: string, contentType = 'text/html', sourceUrl = ''): ExtractedContent {
    const safeHtml = typeof html === 'string' ? html : '';

    // Plain text short-circuit — no HTML to strip.
    if (contentType.includes('text/plain')) {
      const text = normalizeWhitespace(decodeEntities(safeHtml));
      return this.finalize(text, deriveTitleFromUrl(sourceUrl), undefined, undefined, undefined, 'raw');
    }

    // (1) Metadata first.
    const title = extractTitle(safeHtml) || deriveTitleFromUrl(sourceUrl);
    const author = extractMeta(safeHtml, ['author', 'article:author', 'og:author', 'twitter:creator']);
    const publishedAt = normalizeDate(
      extractMeta(safeHtml, [
        'article:published_time',
        'article:published',
        'og:published_time',
        'datePublished',
        'publishdate',
        'date',
      ]) || extractTimeDatetime(safeHtml)
    );
    const language = extractLang(safeHtml);

    // (2) Remove non-content regions.
    let body = extractBodyRegion(safeHtml);
    body = stripRegions(body);

    // (3) Score & keep substantial block-level text.
    let text = extractMainText(body);

    // Fallback: if the heuristic produced very little, strip all tags.
    let method = 'heuristic';
    if (countWords(text) < 25) {
      const stripped = normalizeWhitespace(decodeEntities(stripTags(body)));
      if (countWords(stripped) > countWords(text)) {
        text = stripped;
        method = 'fallback-striptags';
      }
    }

    return this.finalize(text, title, author, publishedAt, language, method);
  }

  private finalize(
    text: string,
    title: string,
    author?: string,
    publishedAt?: string,
    language?: string,
    method = 'heuristic'
  ): ExtractedContent {
    const normalized = normalizeWhitespace(text);
    const wordCount = countWords(normalized);
    const contentHash = crypto
      .createHash('sha256')
      .update(normalized.toLowerCase())
      .digest('hex');
    return {
      title: title.trim() || '(untitled)',
      text: normalized,
      author: author?.trim() || undefined,
      publishedAt: publishedAt || undefined,
      language: language || undefined,
      wordCount,
      contentHash,
      method,
    };
  }
}

// ----------------------------------------------------------------------------
// METADATA EXTRACTION
// ----------------------------------------------------------------------------

function extractTitle(html: string): string {
  const og = extractMeta(html, ['og:title', 'twitter:title']);
  if (og) return decodeEntities(og);
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) return decodeEntities(m[1]);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return decodeEntities(stripTags(h1[1]));
  return '';
}

/**
 * Read the first matching <meta name|property="X" content="Y"> value.
 * Order-insensitive to attribute position (content before name, etc.).
 */
function extractMeta(html: string, names: string[]): string | undefined {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const metaRe = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRe.exec(html)) !== null) {
    const tag = match[0];
    const key = (attr(tag, 'name') || attr(tag, 'property') || attr(tag, 'itemprop') || '').toLowerCase();
    if (key && wanted.has(key)) {
      const content = attr(tag, 'content');
      if (content && content.trim()) return decodeEntities(content.trim());
    }
  }
  return undefined;
}

function extractTimeDatetime(html: string): string | undefined {
  const m = html.match(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : undefined;
}

function extractLang(html: string): string | undefined {
  const m = html.match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i);
  if (!m) return undefined;
  return m[1].trim().slice(0, 10).toLowerCase() || undefined;
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3];
}

// ----------------------------------------------------------------------------
// REGION / TAG STRIPPING
// ----------------------------------------------------------------------------

function extractBodyRegion(html: string): string {
  const m = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : html;
}

const BOILERPLATE_TAGS = ['script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'aside', 'form', 'template', 'iframe'];

function stripRegions(html: string): string {
  let out = html;
  // Remove HTML comments.
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  // Remove whole boilerplate regions (open→close, including content).
  for (const tag of BOILERPLATE_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    out = out.replace(re, ' ');
    // Also drop any self-closing / unclosed leftovers.
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), ' ');
  }
  return out;
}

const BLOCK_RE = /<(p|li|h[1-6]|article|section|blockquote|td|dd|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi;

/**
 * Extract text from substantial block-level elements. Blocks whose cleaned
 * text is too short (typical of menus/labels) are dropped.
 */
function extractMainText(html: string): string {
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((match = BLOCK_RE.exec(html)) !== null) {
    const raw = match[2];
    const text = normalizeWhitespace(decodeEntities(stripTags(raw)));
    const words = countWords(text);
    const tag = match[1].toLowerCase();
    const minWords = /^h[1-6]$/.test(tag) ? 1 : 4;
    if (words >= minWords && !seen.has(text)) {
      seen.add(text);
      blocks.push(text);
    }
  }
  return blocks.join('\n\n');
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

// ----------------------------------------------------------------------------
// TEXT NORMALIZATION
// ----------------------------------------------------------------------------

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»',
  deg: '°', euro: '€', pound: '£', cent: '¢', sect: '§', middot: '·', bull: '•',
};

function decodeEntities(text: string): string {
  if (!text) return '';
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : whole;
  });
}

function countWords(text: string): number {
  if (!text) return 0;
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

function deriveTitleFromUrl(url: string): string {
  if (!url) return '(untitled)';
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(last).replace(/[-_]+/g, ' ').replace(/\.[a-z0-9]+$/i, '').trim() || u.hostname;
  } catch {
    return '(untitled)';
  }
}

// ----------------------------------------------------------------------------
// DATE NORMALIZATION
// ----------------------------------------------------------------------------

/** Best-effort ISO normalization; returns undefined on unparseable input. */
function normalizeDate(value?: string): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}
