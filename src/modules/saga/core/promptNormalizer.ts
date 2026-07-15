// File: src/modules/saga/core/promptNormalizer.ts
// ============================================================================
// DINA SAGA — PROMPT NORMALIZER (pure logic)
// ============================================================================
// LLM-authored prompts (Dina/Ollama) and hand-typed prompts arrive dirty:
//   • raw danbooru tag form with underscores  → "cinematic_horror_lighting"
//     (the CLIP text encoder wants spaces; underscores measurably degrade output)
//   • doubled/leading/trailing whitespace and stray empty tags from bad joins
//   • duplicate tags when we concatenate a subject anchor + user tags + a
//     quality scaffold that the user may already have included
//
// This module makes prompt assembly DETERMINISTIC so every generation request
// gets the same clean, de-duplicated prompt regardless of who wrote it. It is
// pure string work — no I/O, no model, no config — and fully covered by a proof
// harness (tests/promptSystemsTest.ts).
//
// Design decisions (all asserted in the harness):
//   • Split on commas that are NOT inside parentheses, so A1111/danbooru weight
//     syntax `(masterpiece, best quality:1.3)` survives as one tag.
//   • Underscores → spaces, but ONLY between word characters, so numeric ranges
//     and weight decimals are untouched.
//   • De-dupe is case-insensitive on the fully-normalized tag; FIRST occurrence
//     wins (earlier tags carry more weight in CLIP, so we keep the earliest).
//   • A weighted tag `(dark:1.4)` and a bare `dark` are DISTINCT — we never drop
//     a deliberately-weighted tag in favour of an unweighted duplicate.
// ============================================================================

/** Normalize a single tag: underscores→spaces (between word chars), collapse
 *  internal whitespace, trim. Weight syntax and punctuation are preserved. */
export function normalizeTag(tag: string): string {
  return tag
    // Any underscore touching a word char becomes a space ("3D_ rendered" and
    // "exodia_the" both fix up). Underscores flanked only by non-word chars are
    // left alone, so kaomoji tags like "^_^" survive.
    .replace(/(?<=\w)_|_(?=\w)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a comma-separated prompt into tags WITHOUT breaking commas that live
 *  inside parentheses (weight groups). Depth-aware, single pass. */
export function splitTags(prompt: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < prompt.length; i++) {
    const c = prompt[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      out.push(prompt.slice(start, i));
      start = i + 1;
    }
  }
  out.push(prompt.slice(start));
  return out;
}

/**
 * Full normalization: split → normalize each tag → drop empties → de-dupe
 * (case-insensitive, first wins) → re-join with ", ".
 */
export function normalizePrompt(raw: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const rawTag of splitTags(raw ?? '')) {
    const tag = normalizeTag(rawTag);
    if (!tag) continue; // stray empty from a doubled comma / trailing join
    const key = tag.toLowerCase();
    if (seen.has(key)) continue; // exact duplicate — earliest occurrence already kept
    seen.add(key);
    kept.push(tag);
  }
  return kept.join(', ');
}

export interface PromptParts {
  /** Concrete subject anchor placed FIRST (Animagine keys hard off the head). */
  subjectAnchor?: string;
  /** The user- or Dina-authored body of the prompt. */
  body: string;
  /** Model-appropriate quality scaffold appended LAST (e.g. Animagine boosters). */
  qualitySuffix?: string;
}

/**
 * Assemble a final prompt from parts and normalize the whole. De-dup runs across
 * the seam, so a quality booster the user already typed is not repeated, and a
 * subject tag echoed in the body collapses to one.
 */
export function assemblePrompt(parts: PromptParts): string {
  const joined = [parts.subjectAnchor, parts.body, parts.qualitySuffix]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0)
    .join(', ');
  return normalizePrompt(joined);
}
