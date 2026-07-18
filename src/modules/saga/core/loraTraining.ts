// File: src/modules/saga/core/loraTraining.ts
// ============================================================================
// DINA SAGA — LoRA TRAINING PLAN (pure policy + validation)
// ============================================================================
// One concern: turn a user "train a LoRA from these images" request into a
// fully-resolved, VALIDATED training plan — before a single GPU-minute is spent.
// Training is a heavy, ~20-40 minute exclusive-lease job; a bad request (too few
// images, wrong base, missing trigger) must be rejected up front, not discovered
// 20 minutes in. This module is that gate.
//
// It resolves per-KIND defaults (a character LoRA is trained differently from a
// style LoRA), sanitizes the output filename and trigger token (no path/prompt
// injection), clamps every numeric knob to safe bounds, and surfaces warnings
// (e.g. "only 9 images — 15+ recommended") without failing. Pure: no I/O, no
// trainer, no filesystem. Proven in tests/loraTrainingTest.ts.
//
// The base model MUST be an image-generation profile in the registry — you can't
// train a LoRA against a video model — enforced by resolving through it.
// ============================================================================

import { resolveProfile, ModelRegistryError } from './modelRegistry';

export type LoraKind = 'character' | 'clothing' | 'scene' | 'style';

export interface LoraTrainingRequest {
  name: string; // human name; becomes the output filename (sanitized)
  kind: LoraKind;
  baseModelId: string; // must resolve to an image_gen profile (e.g. 'animagine-xl-4')
  imageCount: number; // how many training images were submitted
  triggerWord?: string; // required for character/clothing/scene; derived for style
  // optional expert overrides (clamped):
  rank?: number;
  steps?: number;
  learningRate?: number;
  resolution?: number;
}

export interface LoraTrainingPlan {
  name: string;
  outputName: string; // sanitized `<name>.safetensors`
  kind: LoraKind;
  baseModelId: string;
  baseCheckpoint: string; // resolved from the base profile's files
  triggerWord: string;
  networkDim: number; // "rank"
  networkAlpha: number;
  steps: number;
  learningRate: number;
  resolution: number;
  imageCount: number;
  warnings: string[];
}

export class LoraTrainingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoraTrainingError';
  }
}

interface KindDefault {
  rank: number;
  steps: number;
  lr: number;
  needsTrigger: boolean;
  minImages: number;
  recImages: number;
}

/** Per-kind training defaults. Character/clothing/scene lock a subject (need a
 *  trigger token); style captures an aesthetic across many images (no trigger). */
const KIND_DEFAULTS: Record<LoraKind, KindDefault> = {
  character: { rank: 24, steps: 1800, lr: 1e-4, needsTrigger: true, minImages: 8, recImages: 15 },
  clothing: { rank: 16, steps: 1500, lr: 1e-4, needsTrigger: true, minImages: 8, recImages: 15 },
  scene: { rank: 16, steps: 1500, lr: 1e-4, needsTrigger: true, minImages: 8, recImages: 12 },
  style: { rank: 16, steps: 2000, lr: 8e-5, needsTrigger: false, minImages: 20, recImages: 40 },
};

export const MAX_TRAINING_IMAGES = 300;
const RANK_MIN = 4, RANK_MAX = 128;
const STEPS_MIN = 200, STEPS_MAX = 6000;
const LR_MIN = 1e-6, LR_MAX = 1e-2;
const ALLOWED_RES = [512, 768, 1024];

/** Sanitize to a safe lowercase filename/token stem: alnum + underscore only. */
function sanitizeStem(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function clampInt(v: number | undefined, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Resolve + validate a training request into a plan. Throws LoraTrainingError on
 * anything that would waste GPU time; returns a plan (with non-fatal warnings)
 * otherwise.
 */
export function resolveLoraPlan(req: LoraTrainingRequest): LoraTrainingPlan {
  const d = KIND_DEFAULTS[req.kind];
  if (!d) throw new LoraTrainingError(`Unknown LoRA kind "${req.kind}"`);

  const nameStem = sanitizeStem(req.name);
  if (!nameStem) throw new LoraTrainingError('name is required and must contain alphanumeric characters');

  // Base must be an IMAGE model (can't train a LoRA against a video model).
  let baseCheckpoint: string;
  try {
    const base = resolveProfile({ id: req.baseModelId, jobKind: 'image_gen' });
    baseCheckpoint = base.files.checkpoint;
    if (!baseCheckpoint) throw new LoraTrainingError(`base model "${req.baseModelId}" has no checkpoint file`);
  } catch (e) {
    if (e instanceof LoraTrainingError) throw e;
    const why = e instanceof ModelRegistryError ? e.message : String(e);
    throw new LoraTrainingError(`base model "${req.baseModelId}" is not a valid image model: ${why}`);
  }

  // Dataset size gates.
  if (!Number.isFinite(req.imageCount) || req.imageCount < d.minImages) {
    throw new LoraTrainingError(`${req.kind} LoRA needs at least ${d.minImages} images (got ${req.imageCount})`);
  }
  if (req.imageCount > MAX_TRAINING_IMAGES) {
    throw new LoraTrainingError(`too many images (${req.imageCount}); max ${MAX_TRAINING_IMAGES}`);
  }

  // Trigger token.
  let triggerWord: string;
  if (d.needsTrigger) {
    const t = sanitizeStem(req.triggerWord ?? '');
    if (!t) throw new LoraTrainingError(`a ${req.kind} LoRA requires a triggerWord (a unique token to invoke it)`);
    triggerWord = t;
  } else {
    // style: derive a trigger from the name if none given (still usable as a tag).
    triggerWord = sanitizeStem(req.triggerWord ?? req.name);
  }

  const resolution = ALLOWED_RES.includes(req.resolution as number) ? (req.resolution as number) : 1024;
  const networkDim = clampInt(req.rank, d.rank, RANK_MIN, RANK_MAX);
  const steps = clampInt(req.steps, d.steps, STEPS_MIN, STEPS_MAX);
  const lrRaw = typeof req.learningRate === 'number' && Number.isFinite(req.learningRate) ? req.learningRate : d.lr;
  const learningRate = Math.min(LR_MAX, Math.max(LR_MIN, lrRaw));

  const warnings: string[] = [];
  if (req.imageCount < d.recImages) {
    warnings.push(`only ${req.imageCount} images — ${d.recImages}+ recommended for a strong ${req.kind} LoRA`);
  }
  if (req.resolution !== undefined && !ALLOWED_RES.includes(req.resolution)) {
    warnings.push(`resolution ${req.resolution} not supported; using ${resolution}`);
  }

  return {
    name: req.name,
    outputName: `${nameStem}.safetensors`,
    kind: req.kind,
    baseModelId: req.baseModelId,
    baseCheckpoint,
    triggerWord,
    networkDim,
    networkAlpha: Math.max(1, Math.round(networkDim / 2)), // alpha = rank/2 (a common stable default)
    steps,
    learningRate,
    resolution,
    imageCount: req.imageCount,
    warnings,
  };
}
