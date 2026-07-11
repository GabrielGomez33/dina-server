// File: src/modules/digim/web/tools/thinContent.ts
// ============================================================================
// DIGIM WEB-RESEARCH — THIN-CONTENT ("EMPTY SHELL") DETECTION (Phase 2.2)
// ============================================================================
//
// Decides whether an HTTP-fetched page looks like a JavaScript shell whose real
// content is painted client-side (React/Vue/Angular/Next/Nuxt). Such pages come
// back from a plain fetch() as near-empty HTML — the content never rendered.
// When BOTH conditions hold, the registry escalates to the headless browser.
//
// This is a PURE function on purpose: it is the escalation trigger, and it must
// be unit-testable exhaustively WITHOUT launching Chromium. It is deliberately
// CONSERVATIVE (both conditions required) so a legitimately short article never
// triggers a costly, risky browser launch.
//
// It works on the RAW HTML, not the extracted text — a lightweight scan, so it
// never double-runs the full extractor.
// ============================================================================

export interface ThinContentVerdict {
  /** True ⇔ looks like an unrendered SPA shell worth escalating to the browser. */
  thin: boolean;
  reason: string;
  /** Approx count of visible (non-markup) text characters. */
  textChars: number;
  /** Whether a single-page-app signature was detected. */
  spaSignature: boolean;
}

// Framework root markers + hydration globals that strongly imply client-side
// rendering. Matching ANY one is the "SPA signature".
const SPA_MARKERS: RegExp[] = [
  /<div[^>]+id=["'](root|app|__next|__nuxt|__layout|q-app)["']/i,
  /<app-root[\s>]/i,
  /\sng-version=/i,
  /\sdata-reactroot/i,
  /__NEXT_DATA__/,
  /window\.__NUXT__/,
  /window\.__INITIAL_STATE__/,
  /data-server-rendered=["']false["']/i,
];

/**
 * Assess whether `html` is a thin SPA shell.
 *
 * @param html          raw response body
 * @param minTextChars  visible-text floor below which the page is "text-poor"
 */
export function assessThinContent(html: string, minTextChars: number): ThinContentVerdict {
  if (typeof html !== 'string' || html.length === 0) {
    return { thin: true, reason: 'empty body', textChars: 0, spaSignature: false };
  }

  const textChars = visibleTextLength(html);
  const spaSignature = SPA_MARKERS.some((re) => re.test(html));

  // Script-heavy AND text-poor is a secondary SPA signal even without a known
  // framework marker (covers hand-rolled/obscure client-rendered apps).
  const scriptCount = countMatches(html, /<script[\s>]/gi);
  const scriptHeavy = scriptCount >= 5 && textChars < minTextChars;

  const textPoor = textChars < minTextChars;
  const thin = textPoor && (spaSignature || scriptHeavy);

  let reason: string;
  if (!textPoor) {
    reason = `sufficient text (${textChars} chars ≥ ${minTextChars})`;
  } else if (thin) {
    reason = spaSignature
      ? `SPA shell: ${textChars} visible chars + framework marker`
      : `SPA shell: ${textChars} visible chars + ${scriptCount} scripts, text-poor`;
  } else {
    reason = `text-poor (${textChars} chars) but no SPA signature — not escalating`;
  }

  return { thin, reason, textChars, spaSignature };
}

// ----------------------------------------------------------------------------
// HELPERS (dependency-free — mirrors contentExtractor's heuristic style)
// ----------------------------------------------------------------------------

/** Rough count of human-visible text: strip script/style/markup, count non-ws. */
function visibleTextLength(html: string): number {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' '); // entities count as separators, not content
  // Count non-whitespace characters.
  let n = 0;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) n++;
  }
  return n;
}

function countMatches(s: string, re: RegExp): number {
  const m = s.match(re);
  return m ? m.length : 0;
}
