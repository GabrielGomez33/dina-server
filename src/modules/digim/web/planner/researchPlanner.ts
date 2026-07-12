// File: src/modules/digim/web/planner/researchPlanner.ts
// ============================================================================
// DIGIM WEB-RESEARCH — RESEARCH PLANNER (Phase 2.4a)
// ============================================================================
//
// Turns a BROAD question into COVERAGE. A single search can't answer "the
// Iran–USA war and its ripples" — that's timeline + causes + oil impact +
// regional fallout + actors. The planner:
//
//   1. DECOMPOSE — LLM breaks the question into a bounded set of sub-queries
//      (facets). Degrades to [original query] if the LLM fails or returns junk.
//   2. RUN FACETS — each sub-query runs through the ALREADY-PROVEN research
//      pipeline (search + sources + browser-escalation + memory). Bounded
//      concurrency so a fan-out can't swamp Ollama.
//   3. FUSE — the per-facet briefings become "documents" for a final synthesis
//      that connects across facets. Real source URLs + entities are then unioned
//      back in, so provenance is genuine, not synthetic.
//
// SEPARATION OF CONCERNS: the planner owns ONLY orchestration. Every heavy/risky
// step (gather, synthesize, LLM call) is an INJECTED dependency — so this whole
// file is unit-testable with mocks, and it never reaches into the pipeline's
// internals. It imports no orchestrator (no circular deps).
//
// FAULT ISOLATION: decompose, each facet, and fuse are independently guarded. A
// failure anywhere degrades to a smaller-but-valid result; investigate() never
// throws for an expected failure.
// ============================================================================

import { performance } from 'perf_hooks';
import { DigimWebConfig } from '../config/webConfig';
import { WebInsight } from '../types';
import { SynthSource } from '../processors/webInsightSynthesizer';
import { INJECTION_SYSTEM_RULE } from '../security/promptGuard';

export type PlannerLevel = 'surface' | 'deep' | 'predictive';

/** One decomposed facet of the investigation. */
export interface PlanItem {
  facet: string;
  query: string;
}

/** The outcome of researching one facet. */
export interface FacetResult {
  facet: string;
  query: string;
  insight: WebInsight;
  documentsGathered: number;
  basis: string;
}

export interface InvestigationResult {
  query: string;
  level: PlannerLevel;
  facetsPlanned: number;
  plan: PlanItem[];
  facets: FacetResult[];
  synthesis: WebInsight;
  sourcesConsulted: number;
  processingTimeMs: number;
}

/**
 * Everything the planner needs from the outside — injected so the orchestration
 * is testable in isolation. The orchestrator supplies real implementations
 * (llmManager.generate, this.research, synthesizer.synthesize).
 */
export interface PlannerDeps {
  /** Raw LLM text generation (used for the decompose step). */
  generate: (prompt: string) => Promise<string>;
  /** Research one sub-query through the full pipeline. */
  research: (query: string, level: PlannerLevel) => Promise<{ insight: WebInsight; documentsGathered: number; basis: string }>;
  /** Synthesize a briefing from source documents (reused for the fuse step). */
  synthesize: (query: string, sources: SynthSource[], level: PlannerLevel) => Promise<WebInsight>;
}

class Logger {
  constructor(private ctx: string) {}
  info(msg: string) { console.log(`✅ [${this.ctx}] ${msg}`); }
  warn(msg: string) { console.warn(`⚠️ [${this.ctx}] ${msg}`); }
}

export class ResearchPlanner {
  private log = new Logger('ResearchPlanner');

  constructor(private cfg: DigimWebConfig, private deps: PlannerDeps) {}

  /**
   * Run a full multi-facet investigation. Always resolves. `level` tunes the
   * FINAL fuse depth; facets use cfg.plannerFacetLevel to bound cost.
   */
  async investigate(query: string, opts?: { level?: PlannerLevel }): Promise<InvestigationResult> {
    const t0 = performance.now();
    const level: PlannerLevel = opts?.level || 'deep';
    const cleanQuery = (query || '').trim();
    if (!cleanQuery) {
      throw new Error('investigate requires a non-empty query');
    }

    const plan = await this.decompose(cleanQuery);
    this.log.info(`planned ${plan.length} facet(s) for "${cleanQuery.slice(0, 60)}"`);

    const facets = await this.runFacets(plan);
    const synthesis = await this.fuse(cleanQuery, facets, level);

    return {
      query: cleanQuery,
      level,
      facetsPlanned: plan.length,
      plan,
      facets,
      synthesis,
      sourcesConsulted: synthesis.sources.length,
      processingTimeMs: performance.now() - t0,
    };
  }

  // --------------------------------------------------------------------------
  // 1. DECOMPOSE
  // --------------------------------------------------------------------------

  private async decompose(query: string): Promise<PlanItem[]> {
    const prompt = buildDecomposePrompt(query, this.cfg.plannerMaxSubQueries);
    let raw = '';
    try {
      raw = await this.deps.generate(prompt);
    } catch (err) {
      this.log.warn(`decompose LLM failed (${(err as Error).message}); single-facet fallback`);
      return [{ facet: 'overview', query }];
    }
    const plan = parsePlan(raw, this.cfg.plannerMaxSubQueries);
    if (plan.length === 0) {
      this.log.warn('decompose produced no usable facets; single-facet fallback');
      return [{ facet: 'overview', query }];
    }
    return plan;
  }

  // --------------------------------------------------------------------------
  // 2. RUN FACETS (bounded-concurrency pool, each fault-isolated)
  // --------------------------------------------------------------------------

  private async runFacets(plan: PlanItem[]): Promise<FacetResult[]> {
    const level = this.cfg.plannerFacetLevel as PlannerLevel;
    const results: FacetResult[] = new Array(plan.length);
    let index = 0;

    const worker = async (): Promise<void> => {
      while (index < plan.length) {
        const i = index++;
        const item = plan[i];
        try {
          const r = await this.deps.research(item.query, level);
          results[i] = {
            facet: item.facet,
            query: item.query,
            insight: r.insight,
            documentsGathered: r.documentsGathered,
            basis: r.basis,
          };
        } catch (err) {
          this.log.warn(`facet '${item.facet}' failed (${(err as Error).message})`);
          results[i] = {
            facet: item.facet,
            query: item.query,
            insight: emptyInsight(`Facet "${item.facet}" could not be researched.`),
            documentsGathered: 0,
            basis: 'none',
          };
        }
      }
    };

    const n = Math.max(1, Math.min(this.cfg.plannerConcurrency, plan.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
  }

  // --------------------------------------------------------------------------
  // 3. FUSE (reuse the proven synthesizer; real provenance unioned back in)
  // --------------------------------------------------------------------------

  private async fuse(query: string, facets: FacetResult[], level: PlannerLevel): Promise<WebInsight> {
    const anyContent = facets.some((f) => f.documentsGathered > 0);
    if (!anyContent) {
      return emptyInsight(`No sources were gathered for any facet of "${query}".`);
    }

    // Each facet's briefing becomes a "document" for the fuse synthesis.
    const sources: SynthSource[] = facets
      .filter((f) => (f.insight.summary || '').trim().length > 0)
      .map((f) => ({
        title: `Facet: ${f.facet}`,
        url: f.insight.sources[0]?.url || `facet://${encodeURIComponent(f.facet)}`,
        content: [f.insight.summary, ...f.insight.keyInsights].filter(Boolean).join('\n'),
      }));

    let fused: WebInsight;
    try {
      fused = await this.deps.synthesize(query, sources, level);
    } catch (err) {
      this.log.warn(`fuse synthesis failed (${(err as Error).message}); assembling from facets`);
      fused = fallbackFusion(query, facets);
    }

    // Override with REAL provenance: the union of the facets' actual web sources
    // and entities (the fuse's own source list points at facet:// pseudo-docs).
    fused.sources = dedupeSources(facets.flatMap((f) => f.insight.sources));
    fused.entities = unionEntities(facets.flatMap((f) => f.insight.entities));
    return fused;
  }
}

// ============================================================================
// PURE HELPERS (exported for hermetic testing)
// ============================================================================

export function buildDecomposePrompt(query: string, max: number): string {
  return `You are DINA's research planner. Break the user's QUESTION into up to ${max} focused, NON-overlapping sub-questions ("facets") that together give comprehensive coverage. Think: timeline, causes, effects, key actors, second-order impacts.

QUESTION: "${query}"

${INJECTION_SYSTEM_RULE}

RULES:
- Each facet must be independently searchable and add distinct coverage.
- Prefer ${max} facets for a broad question; fewer for a narrow one.
- Respond with valid JSON ONLY — no markdown, no commentary.

Respond with exactly this shape:
{ "subQueries": [ { "facet": "short label", "query": "a focused search query" } ] }`;
}

/**
 * Parse the decompose response into a clamped, de-duplicated facet list.
 * Accepts { subQueries: [...] }, { facets: [...] }, or a bare array. Never throws.
 */
export function parsePlan(raw: string, max: number): PlanItem[] {
  const obj = tryParseJson(raw);
  if (obj == null) return [];
  const arr: any[] = Array.isArray(obj)
    ? obj
    : Array.isArray(obj.subQueries) ? obj.subQueries
    : Array.isArray(obj.sub_queries) ? obj.sub_queries
    : Array.isArray(obj.facets) ? obj.facets
    : [];

  const seen = new Set<string>();
  const out: PlanItem[] = [];
  for (const it of arr) {
    const query = String((it && (it.query ?? it.q ?? it.question)) ?? '').trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const facet = String((it && (it.facet ?? it.aspect ?? it.topic ?? it.label)) ?? 'aspect').trim() || 'aspect';
    out.push({ facet: facet.slice(0, 80), query: query.slice(0, 300) });
    if (out.length >= max) break;
  }
  return out;
}

/** Dedupe {title,url} sources by normalized URL, preserving order. */
export function dedupeSources(sources: Array<{ title: string; url: string }>): Array<{ title: string; url: string }> {
  const seen = new Set<string>();
  const out: Array<{ title: string; url: string }> = [];
  for (const s of sources || []) {
    const url = (s?.url || '').trim();
    if (!url || url.startsWith('facet://')) continue;
    const key = url.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: s.title || url, url });
  }
  return out;
}

/** Union entities by lower-cased text, keeping the first-seen type. */
export function unionEntities(entities: Array<{ text: string; type: string }>): Array<{ text: string; type: string }> {
  const seen = new Set<string>();
  const out: Array<{ text: string; type: string }> = [];
  for (const e of entities || []) {
    const text = (e?.text || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, type: e.type || 'other' });
  }
  return out;
}

// ----------------------------------------------------------------------------
// INTERNAL
// ----------------------------------------------------------------------------

function tryParseJson(raw: string): any {
  let s = (raw || '').trim();
  if (s.startsWith('```json')) s = s.slice(7);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  s = s.trim();
  // Clamp to the outermost JSON object or array.
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  let end = -1;
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr; end = s.lastIndexOf(']');
  } else if (firstObj !== -1) {
    start = firstObj; end = s.lastIndexOf('}');
  }
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Build a usable fused briefing from facet metadata when the LLM fuse fails. */
function fallbackFusion(query: string, facets: FacetResult[]): WebInsight {
  const withContent = facets.filter((f) => (f.insight.summary || '').trim().length > 0);
  return {
    summary: `Investigation of "${query}" across ${facets.length} facet(s). Automated cross-facet synthesis was unavailable; showing each facet's own summary.`,
    keyInsights: withContent.map((f) => `${f.facet}: ${f.insight.summary}`),
    entities: [],
    topics: [],
    trends: [],
    confidence: 0.3,
    sources: [],
    caveats: ['Cross-facet fusion failed; this is an assembled, non-fused briefing.'],
  };
}

function emptyInsight(reason: string): WebInsight {
  return {
    summary: reason,
    keyInsights: [],
    entities: [],
    topics: [],
    trends: [],
    confidence: 0,
    sources: [],
    caveats: [reason],
  };
}
