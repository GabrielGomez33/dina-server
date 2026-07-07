// File: src/modules/digim/web/scoring/qualityScorer.ts
// ============================================================================
// DIGIM WEB-RESEARCH — QUALITY SCORING
// ============================================================================
//
// Assigns each gathered document five explainable, bounded (0-1) facets plus an
// overall score. These populate the digim_content quality columns and let the
// pipeline rank/trim what feeds synthesis. Deliberately transparent heuristics
// (no black-box model) so scores are auditable and cheap:
//
//   relevance    — lexical overlap between the query and the title+text.
//   freshness    — recency of published_at (exponential decay, ~180-day half-life).
//   authority    — source trust_level + TLD/host heuristics.
//   completeness — word count vs. a "full article" reference length.
//   uniqueness   — 1 for new content, penalized for near-duplicates.
//
// overall is a weighted blend. Weights live here so tuning is one edit.
// ============================================================================

import { ExtractedContent, QualityMetrics } from '../types';

export interface ScoreInputs {
  query: string;
  extracted: ExtractedContent;
  url: string;
  /** 0-1 trust for the originating source (default neutral 0.5). */
  sourceTrust?: number;
  /** True if this content hash was already seen this run/DB. */
  duplicate?: boolean;
}

const WEIGHTS = {
  relevance: 0.35,
  freshness: 0.2,
  authority: 0.2,
  completeness: 0.15,
  uniqueness: 0.1,
};

const REFERENCE_WORD_COUNT = 600; // a "complete" article
const FRESHNESS_HALF_LIFE_DAYS = 180;

// Common high-authority TLDs / host fragments (coarse, extend via ops policy).
const AUTHORITATIVE_TLDS = ['.gov', '.edu', '.mil', '.int'];
const AUTHORITATIVE_HINTS = ['wikipedia.org', 'nature.com', 'science.org', 'reuters.com', 'apnews.com', 'bbc.co', 'who.int', 'nih.gov'];
const LOW_AUTHORITY_HINTS = ['blogspot.', 'wordpress.com', 'medium.com', 'substack.com', 'pinterest.', 'quora.com'];

export class QualityScorer {
  score(inputs: ScoreInputs): QualityMetrics {
    const relevance = this.relevance(inputs.query, inputs.extracted);
    const freshness = this.freshness(inputs.extracted.publishedAt);
    const authority = this.authority(inputs.url, inputs.sourceTrust);
    const completeness = this.completeness(inputs.extracted.wordCount);
    const uniqueness = inputs.duplicate ? 0.15 : 1;

    const overall = clamp01(
      relevance * WEIGHTS.relevance +
        freshness * WEIGHTS.freshness +
        authority * WEIGHTS.authority +
        completeness * WEIGHTS.completeness +
        uniqueness * WEIGHTS.uniqueness
    );

    return {
      overall: round4(overall),
      relevance: round4(relevance),
      freshness: round4(freshness),
      authority: round4(authority),
      completeness: round4(completeness),
      uniqueness: round4(uniqueness),
    };
  }

  /** Jaccard-ish token overlap of query terms present in title+text. */
  private relevance(query: string, extracted: ExtractedContent): number {
    const queryTerms = tokenize(query).filter((t) => t.length > 2);
    if (queryTerms.length === 0) return 0.5; // no signal → neutral
    const uniqueQuery = Array.from(new Set(queryTerms));
    const haystack = (extracted.title + ' ' + extracted.text).toLowerCase();
    const haystackTokens = new Set(tokenize(haystack));
    let hits = 0;
    for (const term of uniqueQuery) {
      if (haystackTokens.has(term)) hits++;
    }
    const coverage = hits / uniqueQuery.length;
    // Slight boost when query terms appear in the title.
    const titleTokens = new Set(tokenize(extracted.title.toLowerCase()));
    const titleHits = uniqueQuery.filter((t) => titleTokens.has(t)).length;
    const titleBoost = uniqueQuery.length ? (titleHits / uniqueQuery.length) * 0.2 : 0;
    return clamp01(coverage * 0.85 + titleBoost);
  }

  private freshness(publishedAt?: string): number {
    if (!publishedAt) return 0.4; // unknown date → mildly stale prior
    const t = Date.parse(publishedAt);
    if (Number.isNaN(t)) return 0.4;
    const ageMs = Date.now() - t;
    if (ageMs < 0) return 0.9; // future-dated (feeds sometimes are) → treat as fresh-ish
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    // Exponential decay with the configured half-life.
    return clamp01(Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS));
  }

  private authority(url: string, sourceTrust?: number): number {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      host = '';
    }
    // Start from the source's configured trust (or neutral).
    let score = typeof sourceTrust === 'number' ? clamp01(sourceTrust) : 0.5;

    if (AUTHORITATIVE_TLDS.some((tld) => host.endsWith(tld))) score = Math.max(score, 0.9);
    if (AUTHORITATIVE_HINTS.some((h) => host.includes(h))) score = Math.max(score, 0.85);
    if (LOW_AUTHORITY_HINTS.some((h) => host.includes(h))) score = Math.min(score, 0.45);
    // HTTPS gets a small nudge over plaintext.
    if (url.startsWith('https://')) score = Math.min(1, score + 0.03);
    return clamp01(score);
  }

  private completeness(wordCount: number): number {
    if (wordCount <= 0) return 0;
    return clamp01(wordCount / REFERENCE_WORD_COUNT);
  }
}

// ----------------------------------------------------------------------------
// UTIL
// ----------------------------------------------------------------------------

function tokenize(text: string): string[] {
  const m = text.toLowerCase().match(/[a-z0-9]+/g);
  return m || [];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
