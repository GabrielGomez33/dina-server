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
  const s = (predicate || '')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return s || 'related_to';
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
