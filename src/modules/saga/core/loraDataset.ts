// File: src/modules/saga/core/loraDataset.ts
// ============================================================================
// DINA SAGA — LoRA DATASET BUILDER (pure policy + validation)
// ============================================================================
// The step between "training is approved" (resolveLoraPlan) and "kohya runs":
// take the ACTUAL image list the user supplied and lay out the on-disk kohya
// dataset — the `<repeats>_<trigger>/` folder, one caption `.txt` per image
// (trigger token prepended so the character binds to it), and the repeats/epochs
// math derived to hit the plan's target step count. It also validates dataset
// QUALITY as far as pure logic can (count, unique/typed filenames, caption
// hygiene) and warns on the failure mode that produced our generic-Exodia drift:
// too few / too-similar images → an overfit LoRA that only knows one pose.
//
// PURE: no I/O, no image inspection (that's the box script's job) — it plans the
// layout and the numbers a trainer consumes. Proven in tests/loraDatasetTest.ts.
// ============================================================================

import { LoraTrainingPlan, MAX_TRAINING_IMAGES, LoraTrainingError } from './loraTraining';

export interface DatasetImage {
  filename: string;   // source image filename (lives in the dataset input dir)
  caption?: string;   // optional extra tags; the trigger is prepended automatically
}

export interface LoraDatasetRequest {
  plan: LoraTrainingPlan;    // the resolved, approved training plan
  images: DatasetImage[];
  repeats?: number;          // per-image repeats in the kohya folder (default DEFAULT_REPEATS)
  batchSize?: number;        // default 1
}

export interface DatasetItem {
  image: string;       // source filename
  captionFile: string; // "<stem>.txt"
  caption: string;     // resolved caption text (trigger + tags)
}

export interface LoraDatasetPlan {
  trigger: string;
  folderName: string;  // "<repeats>_<trigger>" — kohya reads repeats from this
  repeats: number;
  batchSize: number;
  epochs: number;      // derived to reach plan.steps
  stepsPerEpoch: number;
  totalSteps: number;  // effective (repeats/epochs rounded)
  imageCount: number;
  items: DatasetItem[];
  warnings: string[];
}

const IMG_EXT = /\.(png|jpe?g|webp|bmp)$/i;
const DEFAULT_REPEATS = 10;
const REPEATS_MIN = 1, REPEATS_MAX = 100;
const BATCH_MIN = 1, BATCH_MAX = 8;
const CAPTION_MAX = 1024;
// per-image "views" (repeats×epochs) sweet spot — outside it, warn.
const VIEWS_UNDER = 40;   // fewer → undertrained
const VIEWS_OVER = 200;   // more → overfit risk

function stemOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  return base.replace(IMG_EXT, '');
}
function cleanCaption(s: string): string {
  return String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build + validate the kohya dataset layout from an approved plan and the actual
 * image list. Throws LoraTrainingError on anything that would break training;
 * returns the layout + step math with quality warnings.
 */
export function buildDatasetPlan(req: LoraDatasetRequest): LoraDatasetPlan {
  const { plan } = req;
  if (!plan || !plan.triggerWord) throw new LoraTrainingError('a resolved training plan (with trigger) is required');
  const images = req.images ?? [];
  if (images.length === 0) throw new LoraTrainingError('no images supplied for the dataset');
  if (images.length > MAX_TRAINING_IMAGES) throw new LoraTrainingError(`too many images (${images.length}); max ${MAX_TRAINING_IMAGES}`);

  const seen = new Set<string>();
  const items: DatasetItem[] = [];
  for (const img of images) {
    const fn = (img.filename ?? '').trim();
    if (!fn) throw new LoraTrainingError('an image is missing a filename');
    if (!IMG_EXT.test(fn)) throw new LoraTrainingError(`unsupported image type: "${fn}" (need png/jpg/jpeg/webp/bmp)`);
    if (fn.includes('..') || fn.startsWith('/')) throw new LoraTrainingError(`unsafe image path: "${fn}"`);
    const stem = stemOf(fn);
    if (seen.has(stem)) throw new LoraTrainingError(`duplicate image stem "${stem}" — caption files would collide`);
    seen.add(stem);

    const extra = cleanCaption(img.caption ?? '');
    if (extra.length > CAPTION_MAX) throw new LoraTrainingError(`caption for "${fn}" exceeds ${CAPTION_MAX} chars`);
    // Trigger first so the character binds to it; keep extra tags sparse on purpose.
    const caption = extra ? `${plan.triggerWord}, ${extra}` : plan.triggerWord;
    items.push({ image: fn, captionFile: `${stem}.txt`, caption });
  }

  const batchSize = clampInt(req.batchSize, 1, BATCH_MIN, BATCH_MAX);
  const repeats = clampInt(req.repeats, DEFAULT_REPEATS, REPEATS_MIN, REPEATS_MAX);
  const imageCount = items.length;

  // kohya: folder "<repeats>_<trigger>" contributes imageCount*repeats samples per
  // epoch. Derive epochs to land near the plan's target step count.
  const stepsPerEpoch = Math.max(1, Math.ceil((imageCount * repeats) / batchSize));
  const epochs = Math.max(1, Math.round(plan.steps / stepsPerEpoch));
  const totalSteps = stepsPerEpoch * epochs;

  const warnings: string[] = [...plan.warnings];
  if (imageCount !== plan.imageCount) {
    warnings.push(`dataset has ${imageCount} images but the plan declared ${plan.imageCount} — step math uses the actual ${imageCount}`);
  }
  const viewsPerImage = repeats * epochs;
  if (viewsPerImage < VIEWS_UNDER) warnings.push(`each image is seen ~${viewsPerImage}× (repeats ${repeats} × epochs ${epochs}) — under ${VIEWS_UNDER} risks undertraining; add steps or repeats`);
  if (viewsPerImage > VIEWS_OVER) warnings.push(`each image is seen ~${viewsPerImage}× — over ${VIEWS_OVER} risks overfitting to these exact frames (the generic-drift trap in reverse); add more varied images`);
  if (imageCount < 12) warnings.push(`only ${imageCount} images — a character LoRA wants variety (poses/angles/framing); too-similar frames overfit to one pose`);
  const withCaptions = items.filter((i) => i.caption !== plan.triggerWord).length;
  if (withCaptions === 0) warnings.push('no per-image tags beyond the trigger — fine for a tight character lock, but a few distinguishing tags (pose/expression) can help flexibility');

  return { trigger: plan.triggerWord, folderName: `${repeats}_${plan.triggerWord}`, repeats, batchSize, epochs, stepsPerEpoch, totalSteps, imageCount, items, warnings };
}

function clampInt(v: number | undefined, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def;
  return Math.min(hi, Math.max(lo, n));
}
