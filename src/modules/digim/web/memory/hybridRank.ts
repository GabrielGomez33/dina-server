// File: src/modules/digim/web/memory/hybridRank.ts
// ============================================================================
// DIGIM WEB-RESEARCH — HYBRID RETRIEVAL RANKING (pure, dependency-free)
// ============================================================================
//
// Blends the vector similarity from the index with cheap, transparent signals
// (keyword overlap, recency, source authority) so retrieval isn't purely
// embedding-driven. Kept in its own file with NO heavy imports so it can be
// unit-tested in isolation. Pure and deterministic.
// ============================================================================

import { RetrievedMemory } from '../types';

export interface MemoryCandidate {
  id: string;
  title: string;
  url: string;
  content: string;
  publishedAt?: string;
  provider?: string;
  /** Raw cosine similarity from the vector index (0-1). */
  vectorScore: number;
}

const WEIGHTS = { vector: 0.6, keyword: 0.2, recency: 0.1, authority: 0.1 };
const FRESHNESS_HALF_LIFE_DAYS = 180;
const AUTHORITATIVE_TLDS = ['.gov', '.edu', '.mil', '.int'];
const LOW_AUTHORITY_HINTS = ['blogspot.', 'wordpress.com', 'medium.com', 'substack.com'];

/** Blend vector similarity with keyword/recency/authority; best-first. */
export function rankHybrid(query: string, candidates: MemoryCandidate[]): RetrievedMemory[] {
  const qTerms = new Set(tokenize(query).filter((t) => t.length > 2));
  return candidates
    .map((c): RetrievedMemory => {
      const vector = clamp01(c.vectorScore);
      const keyword = keywordScore(qTerms, `${c.title} ${c.content}`);
      const recency = recencyScore(c.publishedAt);
      const authority = authorityScore(c.url);
      const score = clamp01(
        vector * WEIGHTS.vector +
          keyword * WEIGHTS.keyword +
          recency * WEIGHTS.recency +
          authority * WEIGHTS.authority
      );
      return {
        id: c.id,
        title: c.title,
        url: c.url,
        content: c.content,
        publishedAt: c.publishedAt,
        score: round4(score),
        vectorScore: round4(vector),
        provider: c.provider,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function keywordScore(qTerms: Set<string>, haystack: string): number {
  if (qTerms.size === 0) return 0.5;
  const tokens = new Set(tokenize(haystack));
  let hits = 0;
  for (const t of qTerms) if (tokens.has(t)) hits++;
  return clamp01(hits / qTerms.size);
}

function recencyScore(publishedAt?: string): number {
  if (!publishedAt) return 0.4;
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return 0.4;
  const ageDays = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 0.9;
  return clamp01(Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS));
}

function authorityScore(url: string): number {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 0.5;
  }
  let score = 0.5;
  if (AUTHORITATIVE_TLDS.some((tld) => host.endsWith(tld))) score = 0.9;
  if (LOW_AUTHORITY_HINTS.some((h) => host.includes(h))) score = Math.min(score, 0.45);
  return clamp01(score);
}

function tokenize(text: string): string[] {
  const m = (text || '').toLowerCase().match(/[a-z0-9]+/g);
  return m || [];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
