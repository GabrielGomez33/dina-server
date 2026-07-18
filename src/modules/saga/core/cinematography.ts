// File: src/modules/saga/core/cinematography.ts
// ============================================================================
// DINA SAGA — CINEMATOGRAPHY VOCABULARY (pure policy)
// ============================================================================
// Cinematography is handled in THREE places, and this module is the single map
// that routes a friendly term the user picks to the right mechanism, so the UI
// can expose "closeup / dutch angle / orbit / vintage / invert" without the user
// knowing (or caring) whether each is a prompt tag or an ffmpeg post-filter:
//
//   • shot FRAMING, camera ANGLE, OPTICAL look  → PROMPT tags (image/keyframe gen)
//   • camera MOTION                              → video-prompt fragment (motion)
//   • FILTERS / grades (vintage, invert, grain)  → POST ffmpeg filter chain
//
// Pure: no I/O. Every term is catalogued with its mechanism (`kind`), so callers
// route deterministically. Proven in tests/cinematographyTest.ts.
// ============================================================================

import { normalizePrompt } from './promptNormalizer';

export type CineKind = 'prompt' | 'camera' | 'post';

export type ShotFraming = 'extreme-closeup' | 'closeup' | 'medium' | 'wide' | 'establishing';
export type CameraAngle = 'eye-level' | 'low-angle' | 'high-angle' | 'dutch' | 'over-shoulder' | 'pov' | 'birds-eye';
export type OpticalLook = 'bokeh' | 'deep-focus' | 'lens-flare' | 'rim-light' | 'volumetric';
export type CameraMotion =
  | 'static' | 'pan-left' | 'pan-right' | 'tilt-up' | 'tilt-down'
  | 'push-in' | 'pull-out' | 'orbit' | 'crane' | 'handheld' | 'tracking';
export type PostFilter = 'negative' | 'grayscale' | 'sepia' | 'vintage' | 'film-grain' | 'vignette' | 'warm' | 'cool';

export class CinematographyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CinematographyError';
  }
}

interface CineEntry {
  kind: CineKind;
  /** For prompt/camera: danbooru-style tags. */
  tags?: string;
  /** For post: an ffmpeg -vf filter fragment. */
  ffmpeg?: string;
  description: string;
}

// ---- catalogs (also drive the UI's enumerable options) -----------------------

export const FRAMING: Record<ShotFraming, CineEntry> = {
  'extreme-closeup': { kind: 'prompt', tags: 'extreme close-up, face closeup', description: 'Fills frame with a detail (eyes, hands).' },
  closeup: { kind: 'prompt', tags: 'close-up, portrait', description: 'Head and shoulders.' },
  medium: { kind: 'prompt', tags: 'upper body, cowboy shot', description: 'Waist up.' },
  wide: { kind: 'prompt', tags: 'wide shot, full body', description: 'Whole subject in the scene.' },
  establishing: { kind: 'prompt', tags: 'wide shot, establishing shot, scenery', description: 'Sets the location.' },
};

export const ANGLE: Record<CameraAngle, CineEntry> = {
  'eye-level': { kind: 'prompt', tags: '', description: 'Neutral, natural.' },
  'low-angle': { kind: 'prompt', tags: 'from below', description: 'Looking up — makes the subject imposing/heroic.' },
  'high-angle': { kind: 'prompt', tags: 'from above', description: 'Looking down — makes the subject small/vulnerable.' },
  dutch: { kind: 'prompt', tags: 'dutch angle, tilted horizon', description: 'Tilted frame — unease/tension.' },
  'over-shoulder': { kind: 'prompt', tags: 'over the shoulder, from behind', description: 'Frames past a foreground character.' },
  pov: { kind: 'prompt', tags: 'pov, first-person view', description: "Through the character's eyes." },
  'birds-eye': { kind: 'prompt', tags: "from above, bird's eye view, directly overhead", description: 'Straight down.' },
};

export const OPTICS: Record<OpticalLook, CineEntry> = {
  bokeh: { kind: 'prompt', tags: 'depth of field, bokeh, blurry background, shallow focus', description: 'Subject sharp, background creamy.' },
  'deep-focus': { kind: 'prompt', tags: 'everything in focus, deep depth of field, sharp', description: 'Whole frame sharp.' },
  'lens-flare': { kind: 'prompt', tags: 'lens flare', description: 'Bright optical streaks.' },
  'rim-light': { kind: 'prompt', tags: 'rim lighting, backlight, glowing edge', description: 'Bright outline separating subject from background.' },
  volumetric: { kind: 'prompt', tags: 'volumetric lighting, god rays, light shafts', description: 'Visible beams of light.' },
};

export const CAMERA: Record<CameraMotion, CineEntry> = {
  static: { kind: 'camera', tags: 'static camera, locked-off shot', description: 'No camera movement.' },
  'pan-left': { kind: 'camera', tags: 'camera slowly pans left', description: 'Rotate horizontally left.' },
  'pan-right': { kind: 'camera', tags: 'camera slowly pans right', description: 'Rotate horizontally right.' },
  'tilt-up': { kind: 'camera', tags: 'camera tilts up', description: 'Rotate vertically up.' },
  'tilt-down': { kind: 'camera', tags: 'camera tilts down', description: 'Rotate vertically down.' },
  'push-in': { kind: 'camera', tags: 'camera slowly pushes in, dolly in', description: 'Move toward the subject.' },
  'pull-out': { kind: 'camera', tags: 'camera slowly pulls back, dolly out', description: 'Move away from the subject.' },
  orbit: { kind: 'camera', tags: 'camera orbits around the subject, rotating shot', description: 'Circle the subject (a "twirl").' },
  crane: { kind: 'camera', tags: 'crane shot, camera rises up', description: 'Sweeping vertical move.' },
  handheld: { kind: 'camera', tags: 'handheld camera, subtle camera shake', description: 'Organic, documentary feel.' },
  tracking: { kind: 'camera', tags: 'tracking shot, camera follows the subject', description: 'Move alongside the subject.' },
};

export const FILTERS: Record<PostFilter, CineEntry> = {
  negative: { kind: 'post', ffmpeg: 'negate', description: 'Invert all colors.' },
  grayscale: { kind: 'post', ffmpeg: 'hue=s=0', description: 'Black and white.' },
  sepia: { kind: 'post', ffmpeg: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131', description: 'Warm brown antique tone.' },
  vintage: { kind: 'post', ffmpeg: 'curves=preset=vintage,noise=alls=8:allf=t,vignette', description: 'Faded film + grain + vignette.' },
  'film-grain': { kind: 'post', ffmpeg: 'noise=alls=15:allf=t', description: 'Analog film grain.' },
  vignette: { kind: 'post', ffmpeg: 'vignette', description: 'Darkened corners.' },
  warm: { kind: 'post', ffmpeg: 'colortemperature=temperature=4500', description: 'Warmer color grade.' },
  cool: { kind: 'post', ffmpeg: 'colortemperature=temperature=7500', description: 'Cooler color grade.' },
};

// ---- composition -------------------------------------------------------------

export interface ShotDirection {
  framing?: ShotFraming;
  angle?: CameraAngle;
  optics?: OpticalLook[];
  motion?: CameraMotion;
  filters?: PostFilter[];
}

function lookup<T extends string>(cat: Record<string, CineEntry>, key: T | undefined, catName: string): CineEntry | undefined {
  if (key === undefined) return undefined;
  const e = cat[key];
  if (!e) throw new CinematographyError(`unknown ${catName} "${key}"`);
  return e;
}

/**
 * Build the PROMPT fragment (framing + angle + optics) to append to a generation
 * prompt. Subject-agnostic — pure camera/optics language, normalized & de-duped.
 */
export function composeShotPrompt(d: ShotDirection): string {
  const parts = [
    lookup(FRAMING, d.framing, 'framing')?.tags,
    lookup(ANGLE, d.angle, 'angle')?.tags,
    ...(d.optics ?? []).map((o) => lookup(OPTICS, o, 'optical look')!.tags),
  ].filter((t): t is string => !!t && t.length > 0);
  return normalizePrompt(parts.join(', '));
}

/** Build the camera-MOTION fragment for the video prompt. */
export function composeCameraMotion(motion: CameraMotion | undefined): string {
  return lookup(CAMERA, motion, 'camera motion')?.tags ?? '';
}

/**
 * Build the POST ffmpeg `-vf` filter chain (comma-joined) from selected filters,
 * in order. Empty selection → empty string (caller skips the post pass).
 */
export function composeFilterChain(filters: PostFilter[] | undefined): string {
  return (filters ?? []).map((f) => lookup(FILTERS, f, 'post filter')!.ffmpeg!).join(',');
}

/** Which mechanism a term routes to — the whole point (UI/worker dispatch). */
export function kindOf(term: string): CineKind {
  for (const cat of [FRAMING, ANGLE, OPTICS, CAMERA, FILTERS] as Record<string, CineEntry>[]) {
    if (cat[term]) return cat[term].kind;
  }
  throw new CinematographyError(`unknown cinematography term "${term}"`);
}
