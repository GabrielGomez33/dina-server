// File: src/modules/digim/web/graph/temporalParse.ts
// ============================================================================
// DIGIM — TEMPORAL EXPRESSION PARSER (timeline foundation)
// ============================================================================
// The knowledge graph must place events on a timeline that spans ALL of history
// — not just the MySQL DATETIME window (1000–9999 CE). A human-species timeline
// carries dates like "300,000 years ago", "10,000 BCE", "3200 BC", "circa 1500",
// or "18th century" — none of which `Date.parse` accepts and none of which fit a
// DATETIME column.
//
// This PURE module converts a free-form temporal expression into a stable,
// SORTABLE representation the timeline renders directly:
//
//   sortValue : signed decimal year (CE positive, BCE/prehistoric negative).
//               3200 BCE → -3200 ; "300,000 years ago" → refYear-300000.
//               This is the single value the timeline axis sorts/positions by.
//   label     : a clean human string for display ("3200 BCE", "300,000 years ago").
//   iso       : 'YYYY-MM-DD HH:MM:SS' ONLY when the date is a real CE date inside
//               the DATETIME range — otherwise null (so we never write an
//               out-of-range value that MySQL would reject/mangle).
//
// SEPARATION OF CONCERNS: no I/O, no DB, no Date.now side effects passed in — the
// reference year is injected so the function is deterministic and unit-testable.
// Never throws; an unparseable expression yields all-null (the caller treats that
// as "undated").
// ============================================================================

export interface Temporal {
  sortValue: number | null;
  label: string | null;
  iso: string | null;
}

const EMPTY: Temporal = { sortValue: null, label: null, iso: null };

/** DATETIME-storable range (MySQL): 1000..9999 CE. */
function isoIfStorable(year: number, month = 1, day = 1): string | null {
  if (!Number.isFinite(year) || year < 1000 || year > 9999) return null;
  const mm = String(Math.min(12, Math.max(1, month))).padStart(2, '0');
  const dd = String(Math.min(31, Math.max(1, day))).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${mm}-${dd} 00:00:00`;
}

const SCALE: Record<string, number> = {
  thousand: 1e3, k: 1e3,
  million: 1e6, m: 1e6, mya: 1e6,
  billion: 1e9, bn: 1e9, b: 1e9, gya: 1e9,
};

const ORDINAL_CENTURY = /(\d{1,2})(?:st|nd|rd|th)\s+century/;

/**
 * Parse a temporal expression. `refYear` anchors relative ("N years ago")
 * expressions (inject new Date().getFullYear() in production; a constant in tests).
 */
export function parseTemporal(input: unknown, refYear = 2025): Temporal {
  const raw = String(input ?? '').trim();
  if (!raw || raw.toLowerCase() === 'null' || raw.toLowerCase() === 'unknown') return EMPTY;
  const s = raw.toLowerCase().replace(/[,]/g, '').replace(/\s+/g, ' ').trim();
  const approx = /\b(c|ca|circa|around|approx|about|~)\b|^~/.test(s);
  const clean = s.replace(/^~/, '').replace(/\b(c|ca|circa|around|approx|about)\.?\b/g, '').trim();

  // 1) "N [scale] years ago" / "N mya" / "N kya" / "N bya"
  const ago = clean.match(/^([\d.]+)\s*(thousand|million|billion|k|m|bn|b)?\s*(?:years?\s*)?(ago|ya|mya|kya|bya|gya)\b/);
  if (ago) {
    const n = parseFloat(ago[1]);
    if (Number.isFinite(n)) {
      let mult = ago[2] ? SCALE[ago[2]] || 1 : 1;
      const suffix = ago[3];
      if (suffix === 'mya') mult = 1e6;
      else if (suffix === 'kya') mult = 1e3;
      else if (suffix === 'bya' || suffix === 'gya') mult = 1e9;
      const magnitude = n * mult;
      const year = refYear - magnitude;
      return { sortValue: year, label: prettyAgo(n, ago[2], suffix), iso: null };
    }
  }

  // 2) Explicit BCE / BC (optionally with scale, e.g. "1.5 million BC")
  const bce = clean.match(/^([\d.]+)\s*(thousand|million|billion|k|m|bn|b)?\s*(bce|bc|b\.c\.|b\.c\.e\.)\b/);
  if (bce) {
    const n = parseFloat(bce[1]);
    if (Number.isFinite(n)) {
      const mult = bce[2] ? SCALE[bce[2]] || 1 : 1;
      const year = -(n * mult);
      return { sortValue: year, label: `${trimNum(n)}${bce[2] ? ' ' + bce[2] : ''} BCE`, iso: null };
    }
  }

  // 3) Century ("18th century", "5th century BCE")
  const cent = clean.match(ORDINAL_CENTURY);
  if (cent) {
    const c = parseInt(cent[1], 10);
    if (Number.isFinite(c) && c > 0) {
      const isBce = /\b(bce|bc)\b/.test(clean);
      const mid = (c - 1) * 100 + 50;
      const year = isBce ? -mid : mid;
      return { sortValue: year, label: `${cent[1]}${ordinalSuffix(c)} century${isBce ? ' BCE' : ''}`, iso: isBce ? null : isoIfStorable(year) };
    }
  }

  // 4) ISO / partial ISO (YYYY-MM-DD, YYYY-MM) — Date.parse-safe, CE only
  const iso = clean.match(/^(\d{3,4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (iso) {
    const y = parseInt(iso[1], 10), mo = parseInt(iso[2], 10), d = iso[3] ? parseInt(iso[3], 10) : 1;
    const sort = y + (mo - 1) / 12 + (d - 1) / 372;
    return { sortValue: sort, label: raw, iso: isoIfStorable(y, mo, d) };
  }

  // 5) Bare year, optionally CE/AD ("1990", "1990 CE", "AD 1500", "2020s")
  const year = clean.match(/\b(ad\s*)?(\d{1,4})\s*(ce|ad)?s?\b/);
  if (year) {
    const y = parseInt(year[2], 10);
    if (Number.isFinite(y) && y > 0) {
      return { sortValue: y, label: approx ? `circa ${y}` : raw, iso: isoIfStorable(y) };
    }
  }

  return EMPTY;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}
function prettyAgo(n: number, scale?: string, suffix?: string): string {
  const unit = scale ? ` ${scale}` : suffix && suffix !== 'ago' ? ` ${suffix}` : '';
  const yrs = scale || (suffix && suffix !== 'ago') ? '' : '';
  return `${trimNum(n)}${unit}${yrs ? ' ' + yrs : ''} years ago`.replace(/\s+/g, ' ').trim();
}
function ordinalSuffix(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (n % 10) { case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th'; }
}
