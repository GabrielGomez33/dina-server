// File: src/modules/saga/core/fidelity.ts
// ============================================================================
// DINA SAGA — FIDELITY SCALE (pure policy)
// ============================================================================
// One user-facing dial, 0..10, that coordinates every "how close to the
// reference" knob at once, so callers never hand-tune raw parameters:
//
//   0  = free drawing  — the reference is a faint suggestion; the model invents
//   10 = near-copy     — identity strong AND geometry pinned; barely deviates
//
// A single level maps to THREE underlying controls that must move together:
//   • ipAdapterWeight     — identity adherence (how hard the look is pulled)
//   • controlnetStrength  — structural lock (how hard the geometry is held)
//   • controlnetEndPercent— how far into denoising the structure stays locked
// plus `denoise` for img2img-refine flows (lower = closer to the source pixels).
//
// This is the seam for the product's workflow: a trained character LoRA holds
// *identity* permanently, ControlNet supplies *pose*, and THIS dial sets *how
// faithfully* the render tracks the reference — style barely changes, positions
// do. Pure, deterministic, and fully proven (tests/fidelityTest.ts).
// ============================================================================

export const FIDELITY_MIN = 0;
export const FIDELITY_MAX = 10;

export interface FidelityParams {
  /** The clamped level actually applied (0..10). */
  level: number;
  /** IP-Adapter weight — identity adherence. */
  ipAdapterWeight: number;
  /** ControlNet strength — structural lock (0 = off). */
  controlnetStrength: number;
  /** Fraction of the denoise schedule ControlNet stays applied (0..1). */
  controlnetEndPercent: number;
  /** Denoise for img2img-refine flows; 1 = full generation, lower = closer to source. */
  denoise: number;
  /** Human-readable band for UI. */
  label: string;
}

export class FidelityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FidelityError';
  }
}

/** Endpoint anchors. Each control is a straight line between its level-0 and
 *  level-10 value; the mapping is monotonic by construction. */
const ANCHORS = {
  ipAdapterWeight: [0.25, 0.9] as const, // faint → strong (capped <1 so structure survives)
  controlnetStrength: [0.0, 1.0] as const, // off → full lock
  controlnetEndPercent: [0.4, 0.95] as const, // brief → almost the whole schedule
  denoise: [1.0, 0.45] as const, // full gen → close to source (inverse)
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
/** Round to 3 dp so outputs are stable/deterministic (no float noise in tests or graphs). */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function labelFor(level: number): string {
  if (level <= 1) return 'free drawing';
  if (level <= 3) return 'loose';
  if (level <= 6) return 'balanced';
  if (level <= 8) return 'strong';
  return 'near-copy';
}

/**
 * Map a 0..10 fidelity level to the coordinated generation parameters.
 * Out-of-range levels are CLAMPED (a UI slider can't exceed its ends); a
 * non-finite level is a programming error and throws.
 */
export function fidelityToParams(level: number): FidelityParams {
  if (typeof level !== 'number' || !Number.isFinite(level)) {
    throw new FidelityError(`fidelity level must be a finite number, got ${level}`);
  }
  const clamped = Math.min(FIDELITY_MAX, Math.max(FIDELITY_MIN, level));
  const t = clamped / FIDELITY_MAX; // 0..1

  return {
    level: clamped,
    ipAdapterWeight: r3(lerp(...ANCHORS.ipAdapterWeight, t)),
    controlnetStrength: r3(lerp(...ANCHORS.controlnetStrength, t)),
    controlnetEndPercent: r3(lerp(...ANCHORS.controlnetEndPercent, t)),
    denoise: r3(lerp(...ANCHORS.denoise, t)),
    label: labelFor(clamped),
  };
}
