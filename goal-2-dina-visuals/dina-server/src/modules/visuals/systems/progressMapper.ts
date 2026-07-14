// File: src/modules/visuals/systems/progressMapper.ts
// ============================================================================
// DINA VISUALS — PROGRESS MAPPER (pure logic)
// ============================================================================
// Translates raw ComfyUI websocket events into the locked JobProgress schema
// the frontend consumes. Two hard guarantees, both proven in the harness:
//
//   1. MONOTONIC — overall_pct never decreases, whatever the event stream does
//      (ComfyUI restarts node progress from 0 repeatedly; users must never see
//      the bar move backwards).
//   2. WEIGHTED — the bar reflects TOTAL job work, not the current sub-step:
//      each phase owns a weight slice; overall = completedWeights + phasePct×w.
//
// Pure: no I/O, no clock (timestamps injected), no ComfyUI import.
// ============================================================================

import { JobKind, JobProgress } from '../types';
import { EtaEstimator } from '../core/etaEstimator';

export interface PhaseSpec {
  key: string; // 'load' | 'sample' | 'decode' | 'save' ...
  label: string; // human-facing: "Loading model", "Sampling", ...
  weight: number; // fraction of total work; weights are normalized defensively
}

/** Default phase maps per job kind (tuned by calibration over time). */
export const DEFAULT_PHASES: Record<string, PhaseSpec[]> = {
  image_gen: [
    { key: 'load', label: 'Loading model', weight: 0.15 },
    { key: 'sample', label: 'Sampling', weight: 0.7 },
    { key: 'decode', label: 'Decoding & saving', weight: 0.15 },
  ],
  video_gen: [
    { key: 'load', label: 'Loading model', weight: 0.1 },
    { key: 'sample', label: 'Sampling', weight: 0.75 },
    { key: 'decode', label: 'Decoding frames', weight: 0.1 },
    { key: 'save', label: 'Encoding & saving', weight: 0.05 },
  ],
};

export class ProgressMapper {
  private readonly phases: PhaseSpec[];
  private phaseIdx = 0;
  private phasePct = 0; // 0..100 within the current phase
  private highWater = 0; // monotonic overall_pct floor
  private lastStep: { idx: number; total: number } | undefined;

  constructor(
    private readonly jobId: string,
    private readonly jobKind: JobKind,
    phases?: PhaseSpec[],
    private readonly eta: EtaEstimator | null = null,
  ) {
    const raw = (phases && phases.length > 0 ? phases : DEFAULT_PHASES[jobKind]) ?? [
      { key: 'work', label: 'Working', weight: 1 },
    ];
    // Defensive normalization: junk/zero weights become an even split.
    const sum = raw.reduce((s, p) => s + (Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 0), 0);
    this.phases =
      sum > 0
        ? raw.map((p) => ({ ...p, weight: (Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 0) / sum }))
        : raw.map((p) => ({ ...p, weight: 1 / raw.length }));
  }

  /** Advance to a named phase (unknown names are ignored — never throws). */
  enterPhase(key: string): void {
    const idx = this.phases.findIndex((p) => p.key === key);
    if (idx < 0) return;
    // Never move backwards through phases (a stray late event can't rewind).
    if (idx > this.phaseIdx) {
      this.phaseIdx = idx;
      this.phasePct = 0;
    }
  }

  /** Report step progress within the current phase (ComfyUI progress event). */
  step(idx: number, total: number, observedStepSeconds?: number): void {
    const t = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
    const i = Number.isFinite(idx) ? Math.min(Math.max(0, Math.floor(idx)), t) : 0;
    this.phasePct = t > 0 ? (i / t) * 100 : this.phasePct;
    this.lastStep = t > 0 ? { idx: i, total: t } : this.lastStep;
    if (this.eta && observedStepSeconds !== undefined) this.eta.observeStep(observedStepSeconds);
  }

  /** Mark the whole job complete (drives the bar to exactly 100). */
  complete(): void {
    this.phaseIdx = this.phases.length - 1;
    this.phasePct = 100;
  }

  /** Build the JobProgress event. Monotonicity is enforced here. */
  snapshot(extra?: Partial<JobProgress>): JobProgress {
    const before = this.phases.slice(0, this.phaseIdx).reduce((s, p) => s + p.weight, 0);
    const current = this.phases[this.phaseIdx];
    const overallRaw = (before + (current.weight * this.phasePct) / 100) * 100;
    this.highWater = Math.max(this.highWater, Math.min(100, overallRaw));

    const etaSeconds =
      this.eta && this.lastStep ? this.eta.etaSeconds(this.lastStep.idx, this.lastStep.total) : null;

    return {
      job_id: this.jobId,
      job_kind: this.jobKind,
      phase: current.label,
      pct: round1(Math.min(100, this.phasePct)),
      overall_pct: round1(this.highWater),
      eta_seconds: etaSeconds,
      current_step: this.lastStep,
      ...extra,
    };
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
