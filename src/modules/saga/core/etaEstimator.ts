// File: src/modules/saga/core/etaEstimator.ts
// ============================================================================
// DINA SAGA — ETA ESTIMATION (pure logic)
// ============================================================================
// The progress bar's credibility depends on measured numbers, not published
// benchmarks (READINESS.md GAP 4). This module is pure math over two inputs:
//
//   1. CALIBRATION — per-(jobKind, model, resolution) seconds-per-step measured
//      on THIS box (stored in saga_calibration, seeded by the calibration
//      run, refreshed after every completed job).
//   2. LIVE OBSERVATION — the actual step rate of the running job, blended in
//      via EWMA so the ETA converges on reality within a few steps.
//
// Estimates never go negative, never divide by zero, and degrade gracefully to
// "null ETA" (the UI shows "estimating…") rather than inventing numbers.
// ============================================================================

export interface CalibrationSample {
  jobKind: string; // 'image_gen' | 'video_gen' | ...
  model: string;
  resolution: string; // '480p' | '720p' | '1024x1024' ...
  /** Measured seconds per sampling step. */
  sPerStep: number;
  /** Fixed overhead seconds (model load + VAE decode + save). */
  overheadS: number;
}

export class EtaEstimator {
  /** EWMA smoothing for live rate; higher alpha = trust live signal faster. */
  private readonly alpha: number;
  private liveSPerStep: number | null = null;

  constructor(
    private readonly calibration: CalibrationSample | null,
    alpha = 0.3,
  ) {
    this.alpha = clamp01(alpha, 0.3);
  }

  /** Feed an observed step duration (seconds). Ignores junk input. */
  observeStep(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.liveSPerStep =
      this.liveSPerStep === null ? seconds : this.alpha * seconds + (1 - this.alpha) * this.liveSPerStep;
  }

  /** Current best seconds-per-step: live EWMA if we have it, else calibration, else null. */
  ratePerStep(): number | null {
    if (this.liveSPerStep !== null) return this.liveSPerStep;
    if (this.calibration && Number.isFinite(this.calibration.sPerStep) && this.calibration.sPerStep > 0) {
      return this.calibration.sPerStep;
    }
    return null;
  }

  /**
   * ETA in whole seconds for the remaining work, or null when we genuinely
   * don't know (no calibration and no observations yet).
   */
  etaSeconds(currentStep: number, totalSteps: number, includeOverhead = false): number | null {
    const rate = this.ratePerStep();
    if (rate === null) return null;
    const total = Number.isFinite(totalSteps) && totalSteps > 0 ? Math.floor(totalSteps) : 0;
    const done = Number.isFinite(currentStep) ? Math.min(Math.max(0, Math.floor(currentStep)), total) : 0;
    const remainingSteps = total - done;
    const overhead = includeOverhead && this.calibration ? Math.max(0, this.calibration.overheadS) : 0;
    return Math.max(0, Math.round(remainingSteps * rate + overhead));
  }
}

/**
 * Merge a fresh measurement into a stored calibration row (EWMA, so one
 * anomalous run can't wreck the table). Pure — caller persists the result.
 */
export function mergeCalibration(existing: CalibrationSample | null, fresh: CalibrationSample, alpha = 0.25): CalibrationSample {
  const a = clamp01(alpha, 0.25);
  if (
    !existing ||
    existing.jobKind !== fresh.jobKind ||
    existing.model !== fresh.model ||
    existing.resolution !== fresh.resolution
  ) {
    return sanitize(fresh);
  }
  const f = sanitize(fresh);
  const e = sanitize(existing);
  return {
    ...e,
    sPerStep: a * f.sPerStep + (1 - a) * e.sPerStep,
    overheadS: a * f.overheadS + (1 - a) * e.overheadS,
  };
}

function sanitize(s: CalibrationSample): CalibrationSample {
  return {
    ...s,
    sPerStep: Number.isFinite(s.sPerStep) && s.sPerStep > 0 ? s.sPerStep : 1,
    overheadS: Number.isFinite(s.overheadS) && s.overheadS >= 0 ? s.overheadS : 0,
  };
}

function clamp01(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 && v < 1 ? v : fallback;
}
