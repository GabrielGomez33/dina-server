// File: src/modules/saga/core/keyframeChoreography.ts
// ============================================================================
// DINA SAGA — KEYFRAME CHOREOGRAPHY (first-last-frame directed motion)
// ============================================================================
// The fix for the limitation the first full jutsu render exposed: a single text
// prompt to an image→video model CANNOT choreograph precise, discrete poses — it
// improvises. Directed action (a sequence of hand seals → prayer → a contained
// energy sphere) needs the poses PINNED as still keyframes; the video model only
// fills the MOTION between them.
//
// This module is the planner. A Choreography is an ordered list of Keyframes
// (each a still, e.g. one hand seal, posed with ControlNet + IP-Adapter and
// hand-detailed ONCE as a still). Between each adjacent pair we emit ONE
// first-last-frame (FLF2V) render step; an optional per-keyframe hold emits a
// cheap static freeze step. resolveChoreographyPlan validates the whole thing and
// produces the ordered render plan the box orchestrator walks:
//
//   hold(kf0)? → flf(kf0→kf1) → hold(kf1)? → flf(kf1→kf2) → hold(kf2)? → …
//
// Each 'flf' step → one Wan FLF2V generation (TEMPLATE_VIDEO_FLF_WAN_A14B, bound
// start_image=from, end_image=to, length=frameCount). Each 'hold' step → an
// ffmpeg freeze of the still. Concat all steps → RIFE → ESRGAN = the directed
// sequence, frame-exact on the poses YOU authored.
//
// PURE: structure + validation only, no I/O. Grounded in a discovered hard limit:
// Wan generates one ~81-frame window per submit, so a single FLF step is capped
// at MAX_FRAMES_PER_SEGMENT (longer beats must be split into more keyframes).
// Proven in tests/keyframeChoreographyTest.ts.
// ============================================================================

export class ChoreographyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChoreographyError';
  }
}

/** One pinned pose in the sequence. Except on the first keyframe, the flf* fields
 *  describe the MOTION coming INTO this keyframe from the previous one. */
export interface Keyframe {
  id: string;
  imageSourceId: string;   // the still (generation id / filename in ComfyUI input/)
  label?: string;          // 'seal:tiger', 'prayer', 'sphere' — for UI + step labels
  holdS?: number;          // optional static freeze ON this pose (seconds), default 0
  // motion INTO this keyframe from the previous one (ignored on the first keyframe):
  flfDurationS?: number;   // FLF transition length (seconds), default DEFAULT_FLF_S
  motionPrompt?: string;   // optional camera/action hint for the transition
  seed?: number;           // optional per-transition seed
}

export interface Choreography {
  id: string;
  fps: number;
  width: number;
  height: number;
  keyframes: Keyframe[];
}

const FPS_MIN = 8, FPS_MAX = 60;
const RES_MIN = 256, RES_MAX = 1280; // matches the verified Wan window bounds
const DEFAULT_FLF_S = 2;
const MIN_FRAMES_PER_SEGMENT = 8;    // a clip needs enough frames to read as motion
const MAX_FRAMES_PER_SEGMENT = 81;   // Wan's single-window cap (the discovered limit)
const MAX_HOLD_S = 30;               // a static hold longer than this is almost surely a mistake
const EPS = 1e-6;

function finite(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n); }
function framesFor(durationS: number, fps: number): number { return Math.round(durationS * fps); }

/**
 * Validate a choreography. Throws ChoreographyError on any hard violation;
 * returns non-fatal warnings (motion fields on the first keyframe, no holds/no
 * motion degenerate cases).
 */
export function validateChoreography(c: Choreography): string[] {
  const warnings: string[] = [];
  if (!c.id) throw new ChoreographyError('choreography needs an id');
  if (!finite(c.fps) || c.fps < FPS_MIN || c.fps > FPS_MAX) throw new ChoreographyError(`fps must be in [${FPS_MIN}, ${FPS_MAX}]`);
  if (!finite(c.width) || c.width < RES_MIN || c.width > RES_MAX) throw new ChoreographyError(`width must be in [${RES_MIN}, ${RES_MAX}] (Wan window)`);
  if (!finite(c.height) || c.height < RES_MIN || c.height > RES_MAX) throw new ChoreographyError(`height must be in [${RES_MIN}, ${RES_MAX}] (Wan window)`);
  if (!Array.isArray(c.keyframes) || c.keyframes.length < 2) throw new ChoreographyError('a choreography needs at least 2 keyframes (FLF interpolates between a first and a last)');

  const seen = new Set<string>();
  c.keyframes.forEach((k, i) => {
    const where = `keyframe ${i} ("${k.id || '?'}")`;
    if (!k.id) throw new ChoreographyError(`${where}: missing id`);
    if (seen.has(k.id)) throw new ChoreographyError(`duplicate keyframe id "${k.id}"`);
    seen.add(k.id);
    if (!k.imageSourceId) throw new ChoreographyError(`${where}: missing imageSourceId (every keyframe is a pinned still)`);

    if (k.holdS !== undefined) {
      if (!finite(k.holdS) || k.holdS < 0) throw new ChoreographyError(`${where}: holdS must be >= 0`);
      if (k.holdS > MAX_HOLD_S) throw new ChoreographyError(`${where}: holdS (${k.holdS}s) exceeds the ${MAX_HOLD_S}s sanity cap`);
      if (k.holdS > EPS && framesFor(k.holdS, c.fps) < 1) throw new ChoreographyError(`${where}: holdS (${k.holdS}s) rounds to 0 frames at ${c.fps}fps`);
    }

    if (i === 0) {
      // The first keyframe has nothing to transition FROM — motion fields are inert.
      if (k.flfDurationS !== undefined || k.motionPrompt || k.seed !== undefined) {
        warnings.push(`${where}: flfDuration/motionPrompt/seed on the first keyframe are ignored (nothing to transition from)`);
      }
    } else {
      const durS = k.flfDurationS ?? DEFAULT_FLF_S;
      if (!finite(durS) || durS <= EPS) throw new ChoreographyError(`${where}: flfDurationS must be > 0`);
      const frames = framesFor(durS, c.fps);
      if (frames < MIN_FRAMES_PER_SEGMENT) throw new ChoreographyError(`${where}: transition (${durS}s @ ${c.fps}fps = ${frames} frames) is below the ${MIN_FRAMES_PER_SEGMENT}-frame minimum`);
      if (frames > MAX_FRAMES_PER_SEGMENT) throw new ChoreographyError(`${where}: transition (${durS}s @ ${c.fps}fps = ${frames} frames) exceeds Wan's ${MAX_FRAMES_PER_SEGMENT}-frame window — split it by adding an intermediate keyframe or lower the duration/fps`);
      if (k.seed !== undefined && (!finite(k.seed) || k.seed < 0)) throw new ChoreographyError(`${where}: seed must be a non-negative number`);
    }
  });

  const anyHold = c.keyframes.some((k) => (k.holdS ?? 0) > EPS);
  if (!anyHold && c.keyframes.length === 2) warnings.push('a 2-keyframe choreography with no holds is a single FLF transition — that is fine, but the timeline/assembler could do it directly');
  return warnings;
}

// ---- render plan (what the box orchestrator walks) ---------------------------

export interface FlfStep {
  kind: 'flf';
  index: number;               // position among flf steps (0-based)
  fromKeyframeId: string;
  toKeyframeId: string;
  firstImageSourceId: string;  // start_image
  lastImageSourceId: string;   // end_image
  durationS: number;
  frameCount: number;          // == template `length`
  motionPrompt?: string;
  seed?: number;
}

export interface HoldStep {
  kind: 'hold';
  keyframeId: string;
  imageSourceId: string;       // the still to freeze
  durationS: number;
  frameCount: number;
}

export type ChoreographyStep = FlfStep | HoldStep;

export interface ChoreographyPlan {
  choreoId: string;
  fps: number;
  width: number;
  height: number;
  totalDurationS: number;
  totalFrames: number;
  flfCount: number;            // number of FLF renders (the GPU cost driver)
  steps: ChoreographyStep[];   // in timeline order
  warnings: string[];
}

/**
 * Validate then resolve a choreography into an ordered render plan. Defaults are
 * materialized here (flfDurationS → DEFAULT_FLF_S) so the orchestrator consumes a
 * fully-explicit plan. Step order is the natural timeline order:
 *   hold(kf0)? → flf(kf0→kf1) → hold(kf1)? → flf(kf1→kf2) → hold(kf2)? → …
 */
export function resolveChoreographyPlan(c: Choreography): ChoreographyPlan {
  const warnings = validateChoreography(c);
  const steps: ChoreographyStep[] = [];
  let flfIndex = 0;

  c.keyframes.forEach((k, i) => {
    if (i > 0) {
      const prev = c.keyframes[i - 1];
      const durationS = k.flfDurationS ?? DEFAULT_FLF_S;
      steps.push({
        kind: 'flf', index: flfIndex++, fromKeyframeId: prev.id, toKeyframeId: k.id,
        firstImageSourceId: prev.imageSourceId, lastImageSourceId: k.imageSourceId,
        durationS, frameCount: framesFor(durationS, c.fps),
        motionPrompt: k.motionPrompt, seed: k.seed,
      });
    }
    if ((k.holdS ?? 0) > EPS) {
      steps.push({ kind: 'hold', keyframeId: k.id, imageSourceId: k.imageSourceId, durationS: k.holdS!, frameCount: framesFor(k.holdS!, c.fps) });
    }
  });

  const totalFrames = steps.reduce((n, s) => n + s.frameCount, 0);
  const totalDurationS = Math.round((totalFrames / c.fps) * 1000) / 1000;
  return {
    choreoId: c.id, fps: c.fps, width: c.width, height: c.height,
    totalDurationS, totalFrames, flfCount: flfIndex, steps, warnings,
  };
}
