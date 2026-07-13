// File: src/modules/digim/web/graph/entityResolution.ts
// ============================================================================
// DIGIM RELATIONSHIP GRAPH — ENTITY RESOLUTION (Phase 2.4b)
// ============================================================================
//
// The pure heart of the graph: collapse the many surface forms of a thing into
// ONE canonical key, so "The Strait of Hormuz" == "Strait of Hormuz" and
// "Supreme Leader Ali Khamenei" == "Ali Khamenei" become the same node.
//
// Rule-based on purpose: robust, deterministic, dependency-free, and unit-testable
// against the exact aliases the live Iran–USA investigation produced. It can be
// upgraded to embedding-similarity resolution later WITHOUT changing callers —
// they only ever ask for a canonical key.
// ============================================================================

/** Honorifics / titles stripped from the FRONT of a name (longest first). */
const HONORIFICS = [
  'u.s. president', 'us president', 'vice president', 'deputy prime minister',
  'prime minister', 'supreme leader', 'secretary of state', 'secretary',
  'president', 'chancellor', 'ayatollah', 'general', 'senator', 'minister',
  'governor', 'mayor', 'sheikh', 'king', 'queen', 'lord', 'sir', 'dr', 'mr',
  'mrs', 'ms', 'prof', 'professor', 'capt', 'captain', 'col', 'colonel',
].sort((a, b) => b.length - a.length);

/**
 * Canonical dedupe key for an entity name. Lower-cases, strips a leading "the",
 * removes honorific prefixes, and normalizes whitespace/punctuation. Deterministic
 * and idempotent (canon(canon(x)) === canon(x)).
 */
export function canonicalizeEntityName(name: string): string {
  let s = (name || '').toString().normalize('NFKC').toLowerCase().trim();
  if (!s) return '';

  // Normalize fancy quotes/dashes so variants collapse.
  s = s.replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"');
  s = s.replace(/[‐-―]/g, '-');

  // Strip leading "the" and honorific prefixes, repeatedly (handles stacked titles).
  let changed = true;
  while (changed) {
    changed = false;
    const before = s;
    s = s.replace(/^the\s+/, '');
    for (const h of HONORIFICS) {
      if (s === h) continue; // don't nuke a name that IS just the word
      if (s.startsWith(h + ' ')) {
        s = s.slice(h.length + 1).trim();
        break;
      }
    }
    if (s !== before) changed = true;
  }

  // Collapse whitespace; trim surrounding punctuation.
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[\s\-,.:;'"()]+|[\s\-,.:;'"()]+$/g, '').trim();
  return s;
}

/**
 * Normalize a relationship predicate into a stable edge label:
 * "retaliated against" → "retaliated_against", "is the Chokepoint For" →
 * "is_the_chokepoint_for". Bounded to the column width; empty → 'related_to'.
 */
export function normalizePredicate(predicate: string): string {
  let s = (predicate || '')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  // Light normalization: drop a leading article so "the_struck" == "struck".
  s = s.replace(/^(a|an|the)_/, '');
  s = s.slice(0, 120);
  return s || 'related_to';
}

// Quantity/indefinite/pronoun leaders that mark a NON-specific reference —
// "a container ship", "three vessels", "they" — which pollute the graph as
// one-off nodes that never corroborate. Dropped at extraction time.
const QUANTITY_WORDS = new Set([
  'a', 'an', 'some', 'several', 'many', 'multiple', 'various', 'few', 'numerous',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'dozens', 'hundreds', 'thousands',
]);
// NB: deliberately EXCLUDES "us" — it collides with the United States ("US"),
// a critical entity; the pronoun "us" as an extracted graph node is negligible.
const PRONOUNS = new Set([
  'it', 'they', 'them', 'he', 'she', 'him', 'her', 'we', 'you',
  'this', 'that', 'these', 'those', 'who', 'which', 'someone', 'something',
]);

/**
 * True when a name is too generic/non-specific to be a useful graph node — an
 * indefinite instance ("a ship"), a bare quantity ("three vessels"), a pronoun,
 * or an empty/one-char token. Proper named things ("Qatari-flagged vessel
 * al-Rakiyat", "Iran") are kept.
 */
export function isLowValueEntity(name: string): boolean {
  const s = (name || '').toString().trim().toLowerCase();
  if (s.length < 2) return true;
  const first = s.split(/\s+/)[0].replace(/[^a-z0-9]/g, '');
  if (PRONOUNS.has(s) || PRONOUNS.has(first)) return true;
  // Leading indefinite article / quantity → a non-specific instance.
  if (QUANTITY_WORDS.has(first)) return true;
  if (/^\d/.test(s)) return true; // starts with a digit ("3 vessels")
  return false;
}

const VALID_TYPES = new Set([
  'person', 'organization', 'location', 'event', 'technology', 'concept', 'other',
]);

/** Coerce an arbitrary type string to the entity-type enum. */
export function normalizeEntityType(type: string): string {
  const t = (type || '').toString().toLowerCase().trim();
  if (VALID_TYPES.has(t)) return t;
  // Common synonyms → enum.
  if (t === 'org' || t === 'company' || t === 'group' || t === 'institution') return 'organization';
  if (t === 'place' || t === 'country' || t === 'city' || t === 'region' || t === 'geo') return 'location';
  if (t === 'people' || t === 'individual' || t === 'human') return 'person';
  if (t === 'tech' || t === 'product' || t === 'weapon' || t === 'system') return 'technology';
  if (t === 'incident' || t === 'operation' || t === 'attack' || t === 'battle') return 'event';
  return 'other';
}
