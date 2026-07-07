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

    // (1b) OPTIONAL high-quality extraction — used only if @mozilla/readability
    // and linkedom are installed (guarded require, no forced dependency). This
    // yields much cleaner main-content text on complex pages. Falls through to
    // the heuristic when unavailable or when it produces too little.
    const readable = tryReadability(safeHtml);
    if (readable && countWords(readable.text) >= 40) {
      return this.finalize(
        readable.text,
        readable.title || title,
        readable.author || author,
        publishedAt,
        language,
        'readability'
      );
    }

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

// NOTE: `article`/`section` are intentionally NOT matched as blocks — they are
// containers, and matching them would swallow all inner paragraphs (including
// hatnotes) into one block, defeating per-block boilerplate filtering. We
// extract the leaf text blocks (p/li/h/blockquote/td/dd/figcaption) instead.
const BLOCK_RE = /<(p|li|h[1-6]|blockquote|td|dd|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi;

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
    if (words >= minWords && !seen.has(text) && !isBoilerplateLine(text)) {
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

// Inline reference/edit artifacts common to wikis and CMS pages, e.g. "[1]",
// "[ citation needed ]", "[ edit ]". Safe to strip everywhere.
const ARTIFACT_RE =
  /\[\s*(?:\d+|citation needed|citation\s*needed|edit|update|clarification needed|dubious|discuss|according to whom\??|by whom\??|when\??|who\??|note \d+|page needed|verification needed|failed verification|original research\?)\s*\]/gi;

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(ARTIFACT_RE, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Whole-block navigation/hatnote/boilerplate lines to drop (Wikipedia + common
// CMS chrome). Matched against a block's cleaned text.
const BOILERPLATE_LINE_RE =
  /^(from wikipedia|jump to (navigation|search|content)|redirects here|for other uses|this article is about\b.*\bsee\b|not to be confused with|this article (needs|may|is missing)|this section (needs|does not)|see also$|main article:|further information:|retrieved from|privacy policy|terms of (use|service)|cookie policy|all rights reserved|©\s*\d{4}|share this|sign in|log in|subscribe( now)?$|advertisement$)/i;

// High-signal nav phrases that can appear MID-line (not just at the start),
// so they're matched with a contains-check rather than an anchor.
const BOILERPLATE_CONTAINS_RE =
  /\b(redirects here|for other uses,?\s*see|not to be confused with|jump to (navigation|search)|from wikipedia, the free encyclopedia)\b/i;

function isBoilerplateLine(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  if (BOILERPLATE_LINE_RE.test(t)) return true;
  if (BOILERPLATE_CONTAINS_RE.test(t)) return true;
  // Very short nav-ish fragments.
  if (t.length <= 3) return true;
  return false;
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
// OPTIONAL MOZILLA READABILITY ADAPTER
// ----------------------------------------------------------------------------
// If `@mozilla/readability` + `linkedom` are installed, use the industry-
// standard extractor for much cleaner main-content text. Loaded via guarded
// require() so the packages are a soft, optional dependency — absent them,
// extraction transparently uses the built-in heuristic. To enable:
//   npm i @mozilla/readability linkedom
// ----------------------------------------------------------------------------

let _readabilityChecked = false;
let _Readability: any = null;
let _parseHTML: any = null;

function loadReadability(): void {
  if (_readabilityChecked) return;
  _readabilityChecked = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _Readability = require('@mozilla/readability').Readability;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _parseHTML = require('linkedom').parseHTML;
    console.log('✅ [contentExtractor] @mozilla/readability + linkedom detected — using high-quality extraction');
  } catch {
    _Readability = null;
    _parseHTML = null;
  }
}

function tryReadability(html: string): { title: string; text: string; author?: string } | null {
  loadReadability();
  if (!_Readability || !_parseHTML || !html) return null;
  try {
    const { document } = _parseHTML(html);
    const article = new _Readability(document).parse();
    if (!article || typeof article.textContent !== 'string') return null;
    const text = normalizeWhitespace(article.textContent);
    if (!text) return null;
    return {
      title: typeof article.title === 'string' ? decodeEntities(article.title) : '',
      text,
      author: typeof article.byline === 'string' && article.byline.trim() ? article.byline.trim() : undefined,
    };
  } catch (err) {
    console.warn(`⚠️ [contentExtractor] readability failed, using heuristic: ${(err as Error).message}`);
    return null;
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
