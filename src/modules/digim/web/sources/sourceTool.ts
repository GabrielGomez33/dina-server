// File: src/modules/digim/web/sources/sourceTool.ts
// ============================================================================
// DIGIM WEB-RESEARCH — SOURCETOOL ABSTRACTION (Phase 2.3)
// ============================================================================
//
// The SECOND tool ROLE (the FetchTool role arrived in 2.2). A SourceTool is a
// DISCOVERY producer: given a query it returns candidate SearchResults — exactly
// the shape the search provider already yields. So sources simply merge into the
// existing candidate list and flow through the SAME proven pipeline
// (SSRF-guard → fetch → extract → score → embed → synthesize). No pipeline
// surgery; sources are just more ways to find URLs.
//
// CONTRACT: collect() MUST resolve, never reject. Errors → [] so one flaky
// source never breaks a gather. SourceTools only PRODUCE candidate URLs; they
// never fetch/trust them — the pipeline's SSRF guard still vets every URL before
// any fetch.
// ============================================================================

import { SearchResult } from '../types';

export interface SourceTool {
  /** Stable id, tagged onto each SearchResult.provider it emits. */
  readonly name: string;
  /** Config-gated on/off for this specific source. */
  isEnabled(): boolean;
  /** Produce up to `limit` candidate results for the query. Never rejects. */
  collect(query: string, limit: number): Promise<SearchResult[]>;
}

// ----------------------------------------------------------------------------
// Shared bounded fetch for source API/feed calls (defensive; never throws).
// Returns the raw text body (JSON or XML) or null on any failure.
// ----------------------------------------------------------------------------

export async function sourceFetchText(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxBytes: number
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      console.warn(`⚠️ [source] HTTP ${res.status} from ${safeHost(url)}`);
      return null;
    }
    const text = await res.text();
    if (text.length > maxBytes) {
      // Sources return compact metadata; an oversized body is suspicious — cap it.
      return text.slice(0, maxBytes);
    }
    return text;
  } catch (err) {
    console.warn(`⚠️ [source] request failed for ${safeHost(url)}: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(bad url)';
  }
}

/** Clamp a caller-supplied limit to a sane [1, hardMax] range. */
export function clampSourceLimit(limit: number, fallback: number, hardMax = 50): number {
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.round(limit), hardMax);
}
