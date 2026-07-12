// File: src/modules/vision/ingestion/mediaKind.ts
// ============================================================================
// MEDIA KIND DETECTION (pure)
// ============================================================================
// The unified /vision/analyze entry point lets a caller specify WHAT they're
// sending — an image or a video — or leave it to DINA to infer. This is that
// inference: a small, deterministic, side-effect-free decision so it can be
// unit-tested and reasoned about on its own.
//
// Explicit wins: if the caller says 'image' or 'video', we honour it. Only for
// 'auto' (or an absent hint) do we infer from the shape of the payload.
// ============================================================================

import { MediaKind } from '../types';

export interface MediaShape {
  /** Present + non-empty ⇒ a video (a series of frames). */
  frames?: unknown;
  /** A container MIME like "video/mp4" ⇒ video. */
  mimeType?: unknown;
  /** A duration hint ⇒ video. */
  durationSec?: unknown;
  /** Image sources — presence alone does not force 'image' (video may also carry base64). */
  base64?: unknown;
  url?: unknown;
}

/**
 * Resolve the effective media kind to 'image' or 'video'.
 * @param shape   the request payload (only the discriminating fields matter)
 * @param hint    an explicit MediaKind ('image' | 'video' | 'auto'); default 'auto'
 */
export function detectMediaKind(shape: MediaShape, hint: MediaKind = 'auto'): 'image' | 'video' {
  if (hint === 'image') return 'image';
  if (hint === 'video') return 'video';

  // ---- auto-infer ----
  if (Array.isArray(shape?.frames) && shape.frames.length > 0) return 'video';
  if (typeof shape?.mimeType === 'string' && shape.mimeType.toLowerCase().startsWith('video/')) return 'video';
  if (typeof shape?.durationSec === 'number' && Number.isFinite(shape.durationSec) && shape.durationSec > 0) {
    return 'video';
  }
  // Default: a single still image.
  return 'image';
}
