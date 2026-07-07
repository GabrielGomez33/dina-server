// File: src/modules/digim/web/types.ts
// ============================================================================
// DIGIM WEB-RESEARCH — SHARED TYPES
// ============================================================================
// A single, dependency-free vocabulary shared by every stage of the pipeline
// (search → fetch → extract → score → synthesize). Kept separate from the
// existing digim/types so the web subsystem stays a self-contained concern.
// ============================================================================

/** A normalized search hit, provider-agnostic. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** ISO date string if the provider supplied one. */
  publishedAt?: string;
  /** Provider-supplied relevance score (0-1) when available. */
  score?: number;
  /** Which provider produced this hit ("searxng" | "brave" | "tavily" | ...). */
  provider: string;
}

/** Outcome of a single URL fetch. */
export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  /** Raw response body (HTML/text). Empty on failure. */
  body: string;
  byteLength: number;
  fetchedAt: string;
  ok: boolean;
  error?: string;
  /** Number of redirect hops followed. */
  redirects: number;
}

/** Content extracted and cleaned from a fetched page. */
export interface ExtractedContent {
  title: string;
  /** Cleaned main-body text (boilerplate removed). */
  text: string;
  author?: string;
  publishedAt?: string;
  language?: string;
  wordCount: number;
  /** SHA-256 of the normalized text — the deduplication key. */
  contentHash: string;
  /** Extraction strategy that produced this ("readability" | "heuristic" | "raw"). */
  method: string;
}

/** Per-facet quality metrics for a gathered document (each 0-1). */
export interface QualityMetrics {
  overall: number;
  relevance: number;
  freshness: number;
  authority: number;
  completeness: number;
  uniqueness: number;
}

/** A fully-processed document ready for storage / synthesis. */
export interface GatheredDocument {
  id: string;
  sourceId: string | null;
  contentHash: string;
  title: string;
  content: string;
  url: string;
  author?: string;
  publishedAt?: string;
  gatheredAt: string;
  wordCount: number;
  language?: string;
  quality: QualityMetrics;
  provider: string;
  /** True when this exact contentHash already existed (deduped, not re-stored). */
  duplicate: boolean;
}

/** Options controlling a single gather run. */
export interface GatherOptions {
  /** Free-text research query used both for search and relevance scoring. */
  query: string;
  /** Cap on documents fetched+extracted (defaults to config maxDocumentsPerGather). */
  maxDocuments?: number;
  /** Optional explicit URLs to include in addition to search hits. */
  seedUrls?: string[];
  /** userId for audit/attribution. */
  userId?: string;
}

/** Result of a gather run — the raw material for synthesis. */
export interface GatherResult {
  query: string;
  documents: GatheredDocument[];
  /** Diagnostics: what happened to every candidate URL. */
  diagnostics: GatherDiagnostics;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface GatherDiagnostics {
  searchProvider: string;
  candidatesFound: number;
  fetched: number;
  extracted: number;
  stored: number;
  duplicates: number;
  skipped: Array<{ url: string; reason: string }>;
  errors: Array<{ url: string; error: string }>;
}

/** A document recalled from semantic memory, with its blended relevance score. */
export interface RetrievedMemory {
  id: string;
  title: string;
  url: string;
  content: string;
  publishedAt?: string;
  /** Final blended score (vector + keyword + recency + authority). */
  score: number;
  /** Raw cosine similarity from the vector index. */
  vectorScore: number;
  provider?: string;
}

/** The synthesized intelligence produced from gathered documents. */
export interface WebInsight {
  summary: string;
  keyInsights: string[];
  entities: Array<{ text: string; type: string }>;
  topics: Array<{ topic: string; relevance: number }>;
  trends: Array<{ trend: string; direction: 'rising' | 'falling' | 'stable' | 'unclear' }>;
  confidence: number;
  /** URLs actually consulted to produce this insight (source attribution). */
  sources: Array<{ title: string; url: string }>;
  caveats: string[];
}
