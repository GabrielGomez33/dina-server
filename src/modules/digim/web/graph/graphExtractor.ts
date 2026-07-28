// File: src/modules/digim/web/graph/graphExtractor.ts
// ============================================================================
// DIGIM RELATIONSHIP GRAPH — TRIPLE EXTRACTOR (Phase 2.4b-2)
// ============================================================================
//
// Reads gathered documents and emits factual RELATIONSHIP TRIPLES
// (subject —predicate→ object), each tagged with the source it came from. The
// GraphStore then upserts them (entity resolution + corroboration).
//
// SECURITY: documents are UNTRUSTED. Their content is fenced + sanitized via the
// SAME promptGuard used by the synthesizer, and the prompt carries
// INJECTION_SYSTEM_RULE — so a page can't turn extraction into instruction
// execution. The model is told to extract only what the sources explicitly state.
//
// SEPARATION / TESTABILITY: the LLM call is an INJECTED dep; `parseTriples` is a
// pure function (LLM text → validated triples with source URLs) tested without a
// model. Always resolves — a bad/empty response yields [] , never a throw.
// ============================================================================

import { DigimWebConfig } from '../config/webConfig';
import { buildFencedSources, INJECTION_SYSTEM_RULE, FenceableSource } from '../security/promptGuard';
import { isLowValueEntity } from './entityResolution';

export interface ExtractDoc {
  title: string;
  url: string;
  content: string;
}

export interface ExtractedTriple {
  subject: string;
  subjectType: string;
  predicate: string;
  object: string;
  objectType: string;
  occurredAt: string | null;
  confidence: number;
  /** URL of the source that asserted this triple (provenance). */
  sourceUrl: string;
}

export interface ExtractorDeps {
  generate: (prompt: string) => Promise<string>;
}

export class GraphExtractor {
  constructor(private cfg: DigimWebConfig, private deps: ExtractorDeps) {}

  /**
   * Extract relationship triples from the top documents. Default mode is
   * PER-DOCUMENT: each source gets its own focused, fenced prompt, run with
   * bounded concurrency, and the results are unioned + de-duplicated. A small
   * model extracts FAR more completely from one focused document than from a
   * giant concatenated blob (which it truncates and skims) — this is the main
   * lever for graph richness without a bigger model. Set
   * DIGIM_WEB_GRAPH_EXTRACT_PER_DOC=false to fall back to the single batch pass.
   */
  async extract(docs: ExtractDoc[]): Promise<ExtractedTriple[]> {
    if (!docs || docs.length === 0) return [];
    const used = docs.slice(0, this.cfg.graphExtractMaxDocs);
    return this.cfg.graphExtractPerDoc ? this.extractPerDoc(used) : this.extractBatched(used);
  }

  /** Per-document extraction with a bounded-concurrency pool + cross-doc dedup. */
  private async extractPerDoc(docs: ExtractDoc[]): Promise<ExtractedTriple[]> {
    const all: ExtractedTriple[] = [];
    const seen = new Set<string>();
    const cap = this.cfg.graphMaxTriples * Math.max(2, Math.min(docs.length, 6)); // union bound
    let idx = 0;

    const add = (triples: ExtractedTriple[]) => {
      for (const t of triples) {
        const key = `${t.subject.toLowerCase()}|${t.predicate.toLowerCase()}|${t.object.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(t);
      }
    };

    const worker = async (): Promise<void> => {
      while (idx < docs.length && all.length < cap) {
        const doc = docs[idx++];
        add(await this.extractOne(doc));
      }
    };

    const n = Math.max(1, Math.min(this.cfg.graphExtractConcurrency, docs.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
    console.log(`🕸️ [graphExtractor] per-doc: ${all.length} unique triple(s) from ${docs.length} doc(s)`);
    return all.slice(0, cap);
  }

  /** One document → triples (focused, fenced, fault-isolated). */
  private async extractOne(doc: ExtractDoc): Promise<ExtractedTriple[]> {
    const { block, flags } = buildFencedSources(
      [{ title: doc.title, url: doc.url, content: doc.content }],
      this.cfg.synthesisPerDocChars,
    );
    if (flags.length > 0) console.warn(`⚠️ [graphExtractor] injection patterns flagged in source ${doc.url}`);
    const prompt = buildExtractPrompt(block, this.cfg.graphMaxTriples);
    try {
      const raw = await this.deps.generate(prompt);
      return parseTriples(raw, [doc.url], this.cfg.graphMaxTriples);
    } catch (err) {
      console.warn(`⚠️ [graphExtractor] extractOne failed for ${doc.url}: ${(err as Error).message}`);
      return [];
    }
  }

  /** Legacy single-call path over all docs (fallback; ONE fenced LLM call). */
  private async extractBatched(docs: ExtractDoc[]): Promise<ExtractedTriple[]> {
    const sourceUrls = docs.map((d) => d.url);
    const fenceable: FenceableSource[] = docs.map((d) => ({ title: d.title, url: d.url, content: d.content }));
    const { block, flags } = buildFencedSources(fenceable, this.cfg.synthesisPerDocChars);
    if (flags.length > 0) {
      console.warn(`⚠️ [graphExtractor] injection patterns flagged in ${flags.length} source(s)`);
    }
    const prompt = buildExtractPrompt(block, this.cfg.graphMaxTriples);
    try {
      const raw = await this.deps.generate(prompt);
      return parseTriples(raw, sourceUrls, this.cfg.graphMaxTriples);
    } catch (err) {
      console.warn(`⚠️ [graphExtractor] extraction LLM failed: ${(err as Error).message}`);
      return [];
    }
  }
}

// ============================================================================
// PROMPT + PURE PARSER (exported for hermetic testing)
// ============================================================================

export function buildExtractPrompt(fencedSources: string, maxTriples: number): string {
  return `You are DINA's knowledge-graph extractor. From the numbered SOURCES, extract factual RELATIONSHIP TRIPLES — (subject, predicate, object) — capturing who/what did what to whom, causes and effects, correlations, definitions, and events with dates. Build a COMPLETE map of the source, not just a few highlights.

${INJECTION_SYSTEM_RULE}

RULES:
- Extract ONLY relationships explicitly stated in the sources. Never invent.
- BE THOROUGH: a substantive source supports MANY triples (often 8–20+). Extract
  every distinct relationship it states — do not stop at the few most obvious.
- subject/object may be a NAMED entity (person, organization, country, named
  event/operation, technology) OR a SIGNIFICANT CONCEPT the topic turns on
  (e.g. "poverty rate", "incarceration", "unemployment", "spacetime", "a 4D
  hypercube", "monetary policy"). Capture concepts as type "concept" — for
  abstract topics they are the most important nodes.
- SKIP only vague, unusable references: bare pronouns ("they", "it"), indefinite
  quantities with no identity ("a ship", "three vessels"), and filler. Name the
  actual entity/concept or omit the triple.
- Capture causal + statistical links explicitly: prefer predicates like
  "correlates with", "contributes to", "increases", "reduces", "associated with",
  "caused by", "measured by", "defined as", "leads to".
- predicate must be a SHORT CANONICAL verb phrase of 1–3 words, lower-case, reused
  consistently: prefer "sanctioned", "struck", "launched strikes on", "blockaded",
  "attacked", "negotiated with", "chokepoint for". Do NOT write long descriptive
  clauses — collapse "launched a series of powerful strikes against" to "struck".
- occurredAt = WHEN the relationship/fact happened, whenever the source states a
  time. Put the TIME HERE — never as the subject or object. Valid forms, all
  written with DIGITS:
    • modern: "2019", "2026-02", "2026-02-28"
    • BCE / ancient: "3200 BCE", "10000 BCE", "44 BCE", "5th century BCE"
    • deep time / prehistory: "300000 years ago", "3.3 million years ago",
      "2.5 mya", "13.8 billion years ago" (use digits, not words — write "5
      million years ago", NOT "five million years ago")
  Capture the year of a study, report, statistic, ruling, discovery, law, or event
  (e.g. "a 2019 study found…" → "2019"). If the FACT itself is a dated happening —
  a species emerging, an era beginning, a discovery — put that date in occurredAt
  (e.g. "Homo sapiens emerged ~300,000 years ago" → occurredAt "300000 years ago",
  object "Africa", NOT object "300,000 years ago"). PREFER capturing a time over
  null; null ONLY when the source gives no time. This drives the timeline, so date
  generously — but never invent a time the source doesn't give.
- Use subjectType/objectType "event" for named, dated happenings; other entities
  keep their natural type — a triple can still carry occurredAt regardless of type.
- Tag each triple with the SOURCE NUMBER it came from.
- Up to ${maxTriples} triples. Respond with valid JSON ONLY — no markdown, no commentary.

Respond with exactly this shape:
{ "triples": [ { "subject": "", "subjectType": "person|organization|location|event|technology|concept|other", "predicate": "", "object": "", "objectType": "person|organization|location|event|technology|concept|other", "occurredAt": "a TIME in digits (e.g. 2019, 3200 BCE, 300000 years ago) — null ONLY if the source gives no time", "source": 1, "confidence": 0.0 } ] }

SOURCES:
${fencedSources}`;
}

/**
 * Parse the extraction response into validated triples, mapping each triple's
 * 1-based `source` number to its URL. Never throws; drops malformed triples.
 */
export function parseTriples(raw: string, sourceUrls: string[], max: number): ExtractedTriple[] {
  const obj = tryParseJson(raw);
  let arr: any[] = [];
  if (obj != null) {
    arr = Array.isArray(obj) ? obj : Array.isArray(obj.triples) ? obj.triples : [];
  }
  // Truncation-resilient fallback: a response cut off at the token limit yields an
  // unterminated array that JSON.parse rejects — salvage the COMPLETE triple
  // objects (a partial trailing object simply has no closing brace and is skipped).
  if (arr.length === 0) {
    arr = salvageTripleObjects(raw);
  }

  const out: ExtractedTriple[] = [];
  for (const t of arr) {
    const subject = str(t?.subject);
    const predicate = str(t?.predicate);
    const object = str(t?.object);
    if (!subject || !predicate || !object) continue;
    if (subject.toLowerCase() === object.toLowerCase()) continue; // no self-loops
    // Drop generic/indefinite/pronoun references ("a ship", "three vessels",
    // "they") — they pollute the graph as one-off nodes that never corroborate.
    if (isLowValueEntity(subject) || isLowValueEntity(object)) continue;

    // Map 1-based source number → URL (fall back to '' when out of range/absent).
    const srcNum = Number(t?.source);
    const sourceUrl = Number.isInteger(srcNum) && srcNum >= 1 && srcNum <= sourceUrls.length
      ? sourceUrls[srcNum - 1]
      : '';

    out.push({
      subject: subject.slice(0, 255),
      subjectType: str(t?.subjectType) || 'other',
      predicate: predicate.slice(0, 120),
      object: object.slice(0, 255),
      objectType: str(t?.objectType) || 'other',
      occurredAt: normalizeIso(t?.occurredAt),
      confidence: clamp01(Number(t?.confidence)),
      sourceUrl,
    });
    if (out.length >= max) break;
  }
  return out;
}

// ----------------------------------------------------------------------------
// INTERNAL
// ----------------------------------------------------------------------------

/**
 * Recover complete flat triple objects from a (possibly truncated) response.
 * Triple objects contain no nested braces, so `{...}` with no inner `{`/`}`
 * matches each complete one; a cut-off trailing object lacks its `}` and is
 * skipped — so a token-limit truncation degrades to "fewer triples", never zero.
 */
function salvageTripleObjects(raw: string): any[] {
  const out: any[] = [];
  const matches = (raw || '').match(/\{[^{}]*\}/g) || [];
  for (const m of matches) {
    if (!/"subject"\s*:/.test(m)) continue;
    try {
      out.push(JSON.parse(m));
    } catch {
      /* skip a malformed fragment */
    }
  }
  return out;
}

function str(v: any): string {
  return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim());
}

/**
 * Preserve the LLM's raw temporal expression FAITHFULLY — do NOT coerce it to an
 * ISO date here. Prehistoric / BCE / century / "N years ago" expressions (the
 * bread-and-butter of a human-species or deep-history timeline) are not
 * Date.parse-able and would be silently dropped by any ISO coercion. The store
 * (graphStore.normalizeTemporal → parseTemporal) is the single place that turns
 * this string into a sortable year + storable ISO. Separation of concerns:
 * extractor captures, store normalizes. Empty / "null" / "unknown" → null.
 */
function normalizeIso(v: any): string | null {
  const s = str(v);
  if (!s) return null;
  const low = s.toLowerCase();
  if (low === 'null' || low === 'unknown' || low === 'n/a' || low === 'none') return null;
  return s.slice(0, 120);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function tryParseJson(raw: string): any {
  let s = (raw || '').trim();
  if (s.startsWith('```json')) s = s.slice(7);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  s = s.trim();
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1, end = -1;
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) { start = firstArr; end = s.lastIndexOf(']'); }
  else if (firstObj !== -1) { start = firstObj; end = s.lastIndexOf('}'); }
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}
