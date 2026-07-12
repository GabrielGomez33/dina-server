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

  /** Extract triples from the top documents in ONE batched, fenced LLM call. */
  async extract(docs: ExtractDoc[]): Promise<ExtractedTriple[]> {
    if (!docs || docs.length === 0) return [];
    const used = docs.slice(0, this.cfg.graphExtractMaxDocs);
    const sourceUrls = used.map((d) => d.url);

    const fenceable: FenceableSource[] = used.map((d) => ({ title: d.title, url: d.url, content: d.content }));
    const { block, flags } = buildFencedSources(fenceable, this.cfg.synthesisPerDocChars);
    if (flags.length > 0) {
      console.warn(`⚠️ [graphExtractor] injection patterns flagged in ${flags.length} source(s)`);
    }

    const prompt = buildExtractPrompt(block, this.cfg.graphMaxTriples);
    let raw: string;
    try {
      raw = await this.deps.generate(prompt);
    } catch (err) {
      console.warn(`⚠️ [graphExtractor] extraction LLM failed: ${(err as Error).message}`);
      return [];
    }
    return parseTriples(raw, sourceUrls, this.cfg.graphMaxTriples);
  }
}

// ============================================================================
// PROMPT + PURE PARSER (exported for hermetic testing)
// ============================================================================

export function buildExtractPrompt(fencedSources: string, maxTriples: number): string {
  return `You are DINA's knowledge-graph extractor. From the numbered SOURCES, extract factual RELATIONSHIP TRIPLES — (subject, predicate, object) — capturing who did what to whom, causes and effects, and events with dates.

${INJECTION_SYSTEM_RULE}

RULES:
- Extract ONLY relationships explicitly stated in the sources. Never invent.
- subject/object are concrete entities (people, organizations, locations, events, technologies, concepts).
- predicate is a short verb phrase ("launched", "sanctioned", "retaliated against", "chokepoint for").
- If an entity is an event with a date, set its type to "event" and include occurredAt (ISO, e.g. 2026-02-28).
- Tag each triple with the SOURCE NUMBER it came from.
- Up to ${maxTriples} triples. Respond with valid JSON ONLY — no markdown, no commentary.

Respond with exactly this shape:
{ "triples": [ { "subject": "", "subjectType": "person|organization|location|event|technology|concept|other", "predicate": "", "object": "", "objectType": "person|organization|location|event|technology|concept|other", "occurredAt": "YYYY-MM-DD or null", "source": 1, "confidence": 0.0 } ] }

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

function normalizeIso(v: any): string | null {
  const s = str(v);
  if (!s || s.toLowerCase() === 'null') return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
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
