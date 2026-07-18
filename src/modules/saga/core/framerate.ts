// File: src/modules/saga/core/framerate.ts
// ============================================================================
// DINA SAGA — FRAMERATE POLICY (pure logic)
// ============================================================================
// Framerate is a creative choice with real tradeoffs, not a "higher = better"
// slider. This module encodes the options and their pros/cons, and plans the
// two coupled numbers a video shot needs:
//
//   generationFps      — how many frames the model actually renders (cost)
//   interpolationFactor— RIFE multiplier applied after (generationFps × factor)
//   finalFps           — what the viewer sees
//
// The non-obvious truth it enforces: for HAND-DRAWN ANIME, 24-30 fps usually
// looks MORE correct than 60. 60 fps ("ultra-fluid") triggers the soap-opera
// effect and reads as uncanny/un-anime. 60 earns its place only for fluid-action
// shots. Rendering at a low fps (e.g. 12, "on twos") and interpolating up is also
// cheaper than rendering every frame. Pure: no I/O. Proven in tests/framerateTest.ts.
// ============================================================================

export type MotionStyle = 'anime-authentic' | 'standard' | 'fluid-action';

/** RIFE stays reliable up to ~4×; beyond that fast motion shows interpolation artifacts. */
export const MAX_INTERPOLATION = 4;

export interface FpsFacts {
  fps: number;
  label: string;
  pros: string[];
  cons: string[];
}

/** Generation-fps options (what the model renders). Fewer frames = cheaper. */
export const GENERATION_FPS_FACTS: FpsFacts[] = [
  { fps: 8, label: 'ultra-low (source only)', pros: ['cheapest to render', 'ideal purely as an interpolation source'], cons: ['choppy on its own', 'fast motion breaks up'] },
  { fps: 12, label: "anime 'on twos'", pros: ['authentic hand-drawn anime cadence', 'cheap', 'pairs perfectly with 2× → 24'], cons: ['not fluid for fast action'] },
  { fps: 16, label: 'balanced (A14B default)', pros: ['good motion/cost balance', 'solid interpolation source'], cons: ['slightly more compute than 12'] },
  { fps: 24, label: 'film standard', pros: ['smooth natively', 'cinematic'], cons: ['more frames → slower & costlier', 'reads as "motion" more than "anime"'] },
];

/** Final-fps options (what the viewer sees). */
export const FINAL_FPS_FACTS: FpsFacts[] = [
  { fps: 24, label: 'cinematic / authentic anime', pros: ['the anime & film standard', 'reads as real animation'], cons: ['not ultra-smooth'] },
  { fps: 30, label: 'smooth standard', pros: ['smoother than 24 without looking synthetic', 'safe default for most shots'], cons: ['marginally more compute'] },
  { fps: 48, label: 'high-fluidity', pros: ['very smooth', 'good for fast action'], cons: ['starts to look "too real" for anime'] },
  { fps: 60, label: 'ultra-fluid', pros: ['maximally smooth', 'best for high-action motion'], cons: ['SOAP-OPERA EFFECT — often uncanny / un-anime', 'most compute', 'interpolation artifacts more visible on fast motion'] },
];

export class FramerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FramerateError';
  }
}

export interface FramePlan {
  motion: MotionStyle;
  generationFps: number;
  interpolationFactor: number; // 1 = no interpolation
  finalFps: number; // generationFps × interpolationFactor
  interpolate: boolean;
  rationale: string;
  pros: string[];
  cons: string[];
  warnings: string[];
}

/** Preferred generation fps per motion style, in priority order. */
const GEN_PREFS: Record<MotionStyle, number[]> = {
  'anime-authentic': [12, 8, 24, 16], // favour "on twos"
  standard: [16, 12, 24, 8],
  'fluid-action': [24, 16, 12, 8], // capture more real motion before interpolating
};

function factsFor(list: FpsFacts[], fps: number): FpsFacts | undefined {
  return list.find((f) => f.fps === fps);
}

/**
 * Plan generation fps + interpolation factor to reach a target finalFps for a
 * given motion style, with the pros/cons and any creative warnings (e.g. 60 fps
 * on authentic anime). Deterministic. Throws on a nonsensical target.
 */
export function planFramerate(finalFps: number, motion: MotionStyle = 'standard'): FramePlan {
  if (!Number.isFinite(finalFps) || finalFps < 8 || finalFps > 120) {
    throw new FramerateError(`finalFps must be between 8 and 120 (got ${finalFps})`);
  }
  const target = Math.round(finalFps);

  // 1) Prefer a generation fps for this motion that divides the target with a
  //    sane interpolation factor.
  let generationFps = 0, interpolationFactor = 1;
  for (const g of GEN_PREFS[motion]) {
    if (target % g === 0) {
      const f = target / g;
      if (f >= 1 && f <= MAX_INTERPOLATION) { generationFps = g; interpolationFactor = f; break; }
    }
  }
  // 2) Fallback: choose the smallest interpolation factor (least aggressive) that
  //    yields an integer generation fps.
  if (!generationFps) {
    for (const f of [2, 3, 4, 1]) {
      if (target % f === 0) { interpolationFactor = f; generationFps = target / f; break; }
    }
    if (!generationFps) { generationFps = target; interpolationFactor = 1; }
  }

  const actualFinal = generationFps * interpolationFactor;
  const interpolate = interpolationFactor > 1;

  const warnings: string[] = [];
  if (target >= 48 && motion === 'anime-authentic') {
    warnings.push(`${target}fps on hand-drawn anime can look over-smooth (soap-opera effect); 24-30fps is more authentic`);
  }
  if (interpolationFactor > 3) {
    warnings.push(`interpolation ×${interpolationFactor} is aggressive; fast motion may show artifacts — consider a higher generation fps`);
  }
  if (actualFinal !== target) {
    warnings.push(`target ${target}fps not cleanly reachable; using ${actualFinal}fps (${generationFps}×${interpolationFactor})`);
  }

  const gf = factsFor(GENERATION_FPS_FACTS, generationFps);
  const ff = factsFor(FINAL_FPS_FACTS, actualFinal);
  const pros = [...(ff?.pros ?? []), ...(interpolate ? ['cheaper: render few frames, interpolate the rest'] : [])];
  const cons = [...(ff?.cons ?? []), ...(gf?.cons ?? [])];

  return {
    motion,
    generationFps,
    interpolationFactor,
    finalFps: actualFinal,
    interpolate,
    rationale: interpolate
      ? `render ${generationFps}fps → RIFE ×${interpolationFactor} → ${actualFinal}fps`
      : `render ${generationFps}fps natively (no interpolation)`,
    pros,
    cons,
    warnings,
  };
}
