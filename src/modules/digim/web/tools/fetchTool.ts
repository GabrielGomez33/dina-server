// File: src/modules/digim/web/tools/fetchTool.ts
// ============================================================================
// DIGIM WEB-RESEARCH — FETCHTOOL ABSTRACTION (Phase 2.2)
// ============================================================================
//
// A `ResearchTool` in DIGIM comes in two ROLES, each introduced only when a
// second concrete instance justifies it (abstract on the 2nd, not the 1st):
//
//   • FetchTool  (acquisition) — URL in → FetchResult out.
//         Instances: HttpFetchTool (the proven WebFetcher), BrowserTool.
//   • SourceTool (production)  — query in → documents out.   [Phase 2.3]
//         Instances: FeedTool, ApiTool (Wikipedia/Reddit/HN/...).
//
// This file defines the FetchTool role. Everything DOWNSTREAM of acquisition
// (extract → score → dedupe → store → embed → synthesize) already consumes a
// tool-agnostic FetchResult, so the abstraction lives at acquisition ONLY —
// no other stage changes.
//
// CONTRACT: fetch() MUST resolve, never reject. Expected failures (blocked URL,
// timeout, HTTP error, unavailable tool) come back as `{ ok: false, error }`,
// exactly like WebFetcher — so the pipeline keeps going.
// ============================================================================

import { FetchResult } from '../types';

/** Selection hint the registry uses to prefer cheap tools. */
export type FetchToolCost = 'cheap' | 'expensive';

/**
 * A single URL-acquisition backend. Both the HTTP fetcher and the headless
 * browser implement this identical surface, so they are interchangeable and the
 * registry can pick per job.
 */
export interface FetchTool {
  /** Stable identifier, surfaced in FetchResult.tool and diagnostics. */
  readonly name: string;
  /** Cost class — the registry prefers 'cheap' and escalates to 'expensive'. */
  readonly cost: FetchToolCost;
  /**
   * Whether this tool can run RIGHT NOW. For the browser this is DYNAMIC — it
   * reflects live reachability of the browser service, not just whether the
   * library is installed — so a down browser degrades gracefully to HTTP-only.
   */
  isAvailable(): boolean;
  /** Acquire raw content for a URL. Always resolves; errors → ok:false. */
  fetch(url: string): Promise<FetchResult>;
  /** Release any held resources (browser: close/disconnect). Optional, best-effort. */
  shutdown?(): Promise<void>;
}

/**
 * A failed FetchResult scaffold — the single place the not-ok shape is built so
 * every tool reports failures identically.
 */
export function failedFetch(url: string, error: string, tool: string): FetchResult {
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 0,
    contentType: '',
    body: '',
    byteLength: 0,
    fetchedAt: new Date().toISOString(),
    ok: false,
    error,
    redirects: 0,
    tool,
  };
}
