// File: src/modules/vision/analysis/videoAggregation.ts
// ============================================================================
// VIDEO AGGREGATION HELPERS (pure)
// ============================================================================
// A video is a series of images, so "analysing a video" is mostly analysing
// each frame and then AGGREGATING the per-frame results into one answer. That
// aggregation is pure, deterministic logic with no I/O — which means it can be
// unit-tested directly and reasoned about in isolation from the model calls.
//
// Kept separate from videoAnalyzer.ts (which does the model I/O) so the maths is
// provable on its own.
// ============================================================================

/** Case-insensitive de-duplicating union of strings, order-preserving, capped. */
export function unionStrings(values: string[], cap = 40): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const key = v.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(v.trim());
    }
    if (out.length >= cap) break;
  }
  return out;
}

/** A per-frame OCR reading positioned on the timeline. */
export interface FrameText {
  timestampSec: number | null;
  text: string;
}

/**
 * Aggregate per-frame OCR into one de-duplicated transcript plus a timeline of
 * only the frames that actually contained text. De-duplication is line-level and
 * case-insensitive so a caption/subtitle that persists across many frames is not
 * repeated dozens of times.
 */
export function aggregateOcr(frames: FrameText[]): {
  text: string;
  timeline: Array<{ timestampSec: number | null; description: string }>;
} {
  const seenLines = new Set<string>();
  const combinedLines: string[] = [];
  const timeline: Array<{ timestampSec: number | null; description: string }> = [];

  for (const f of frames) {
    const raw = (f?.text || '').trim();
    if (!raw) continue;

    // This frame has text → it's a timeline moment.
    timeline.push({ timestampSec: f.timestampSec ?? null, description: raw });

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seenLines.has(key)) {
        seenLines.add(key);
        combinedLines.push(trimmed);
      }
    }
  }

  return { text: combinedLines.join('\n'), timeline };
}

/** Mean of a numeric list, 0 for empty. Rounded to 2 dp. */
export function meanConfidence(values: number[]): number {
  const nums = values.filter((n) => Number.isFinite(n));
  if (nums.length === 0) return 0;
  return Number((nums.reduce((s, n) => s + n, 0) / nums.length).toFixed(2));
}
