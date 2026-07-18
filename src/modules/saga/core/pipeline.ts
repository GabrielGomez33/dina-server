// File: src/modules/saga/core/pipeline.ts
// ============================================================================
// DINA SAGA — PRODUCTION PIPELINE PLANNER (recommend + override + readiness)
// ============================================================================
// The production pipeline is a FIXED ordered set of stages:
//
//   GENERATE → DETAIL → INTERPOLATE → UPSCALE → FILTERS
//
// FLF vs I2V is a MODE of GENERATE, not a separate pipeline — everything
// downstream is identical. This module turns "what should run for this shot?"
// from a hardcoded box-script chain (which silently skipped the hand detailer on
// the first jutsu render) into an explicit, auditable PLAN:
//
//   • RECOMMEND each stage from the shot's content (hands in frame → detail;
//     gen fps < target → interpolate; final (not preview) → upscale; filters
//     chosen → grade). Each recommendation carries a human REASON.
//   • OVERRIDE any recommendation (run what you want, skip what you don't).
//   • READINESS: cross-check every stage's required ComfyUI nodes + model files
//     against an installed snapshot. A stage that is requested but whose model is
//     absent is BLOCKED and surfaced with an install hint — never silently
//     dropped, never silently run against a missing model.
//
// PURE: no I/O. The installed snapshot is injected (a systems adapter builds it
// live from /object_info + the model tree). CURRENT_BOX_READINESS is the audited
// baseline (2026-07-18). Proven in tests/pipelineTest.ts.
// ============================================================================

export type StageId = 'generate' | 'detail' | 'interpolate' | 'upscale' | 'filters';
export type GenerateMode = 'i2v' | 'flf';

export class PipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineError';
  }
}

/** A model file requirement: at least one file in `dir` whose name matches `match`. */
export interface ModelReq {
  dir: string;       // relative to models/, e.g. 'ultralytics/bbox'
  match: string;     // case-insensitive regex source tested against the filename
  purpose: string;   // human description (drives the install hint)
}

export interface StageDef {
  id: StageId;
  name: string;
  order: number;
  optional: boolean;           // generate is mandatory; the rest are opt-in
  requiredNodes: string[];     // ComfyUI class_types this stage needs
  requiredModels: ModelReq[];  // model files this stage needs (empty = node-bundled/external)
  recommend: (ctx: PipelineContext) => { on: boolean; reason: string };
}

/** The shot descriptor the recommendations read. */
export interface PipelineContext {
  generateMode?: GenerateMode;
  handsInFrame?: boolean;
  facesInFrame?: boolean;
  generationFps: number;
  targetFps: number;
  isPreview: boolean;          // preview/draft vs final/export — gates upscale
  filters?: string[];          // cinematography post-filters selected
}

/** What is actually installed on the engine (nodes + model paths 'dir/filename'). */
export interface ReadinessSnapshot {
  nodes: string[];
  models: string[]; // e.g. 'ultralytics/bbox/hand_yolov8s.pt'
}

// ---- stage catalog -----------------------------------------------------------

export const STAGES: StageDef[] = [
  {
    id: 'generate', name: 'Generate', order: 0, optional: false,
    requiredNodes: ['UnetLoaderGGUF'], // + the mode node, added dynamically below
    requiredModels: [
      { dir: 'unet', match: 'wan.*a14b.*gguf', purpose: 'Wan A14B GGUF expert' },
      { dir: 'loras', match: 'lightx2v', purpose: 'LightX2V lightning LoRA' },
    ],
    recommend: () => ({ on: true, reason: 'generation is the mandatory first stage' }),
  },
  {
    id: 'detail', name: 'Detail (face/hand)', order: 1, optional: true,
    requiredNodes: ['FaceDetailer', 'UltralyticsDetectorProvider'],
    requiredModels: [{ dir: 'ultralytics/bbox', match: 'yolov8', purpose: 'face/hand YOLO detector' }],
    recommend: (c) => {
      if (c.handsInFrame && c.facesInFrame) return { on: true, reason: 'hands and faces in frame — both are diffusion weak points' };
      if (c.handsInFrame) return { on: true, reason: 'hands in frame — the universal diffusion weakness (denoise 0.3 cleans without re-inventing)' };
      if (c.facesInFrame) return { on: true, reason: 'faces in frame — detail sharpens features' };
      return { on: false, reason: 'no hands/faces flagged in frame — nothing for the detailer to fix' };
    },
  },
  {
    id: 'interpolate', name: 'Interpolate (RIFE)', order: 2, optional: true,
    requiredNodes: ['RIFE VFI'],
    requiredModels: [], // RIFE weights are bundled by the custom node
    recommend: (c) => {
      if (c.targetFps > c.generationFps) return { on: true, reason: `generation ${c.generationFps}fps < target ${c.targetFps}fps — interpolate up to smooth the 4-step lightning steppiness` };
      return { on: false, reason: `generation ${c.generationFps}fps already meets target ${c.targetFps}fps — no interpolation needed` };
    },
  },
  {
    id: 'upscale', name: 'Upscale (anime-ESRGAN)', order: 3, optional: true,
    requiredNodes: ['UpscaleModelLoader', 'ImageUpscaleWithModel'],
    requiredModels: [{ dir: 'upscale_models', match: 'anime|4x', purpose: 'anime ESRGAN upscale model' }],
    recommend: (c) => {
      if (c.isPreview) return { on: false, reason: 'preview/draft — upscaling is the delivery step, never run on previews (wastes GPU)' };
      return { on: true, reason: 'final/export — upscale to delivery resolution (2K)' };
    },
  },
  {
    id: 'filters', name: 'Filters / grade', order: 4, optional: true,
    requiredNodes: [], requiredModels: [], // ffmpeg post-pass, external to ComfyUI
    recommend: (c) => {
      const n = c.filters?.length ?? 0;
      return n > 0
        ? { on: true, reason: `${n} post-filter(s) selected — apply the ffmpeg grade` }
        : { on: false, reason: 'no filters selected' };
    },
  },
];

/** The mode-specific generation node (FLF needs the first-last-frame node). */
function generateModeNode(mode: GenerateMode): string {
  return mode === 'flf' ? 'WanFirstLastFrameToVideo' : 'WanImageToVideo';
}

// ---- readiness ---------------------------------------------------------------

function hasNode(snap: ReadinessSnapshot, node: string): boolean {
  return snap.nodes.includes(node);
}
function hasModel(snap: ReadinessSnapshot, req: ModelReq): boolean {
  const re = new RegExp(req.match, 'i');
  const prefix = req.dir.endsWith('/') ? req.dir : req.dir + '/';
  return snap.models.some((m) => {
    if (!m.startsWith(prefix)) return false;
    const base = m.slice(m.lastIndexOf('/') + 1);
    return re.test(base);
  });
}

export interface MissingItem { kind: 'node' | 'model'; what: string; purpose?: string; }

// ---- plan --------------------------------------------------------------------

export interface StagePlanEntry {
  id: StageId;
  name: string;
  order: number;
  recommended: boolean;         // what the content-recommender said
  reason: string;               // why (recommendation rationale)
  requested: boolean;           // recommended, unless an override flipped it
  source: 'recommended' | 'override';
  enabled: boolean;             // will actually run (requested AND ready)
  blocked: boolean;             // requested but NOT runnable (missing node/model)
  ready: boolean;               // all required nodes + models present
  missing: MissingItem[];       // what's absent (drives install hints)
}

export interface PipelinePlan {
  mode: GenerateMode;
  stages: StagePlanEntry[];     // in canonical pipeline order
  order: StageId[];             // enabled stages, in run order
  ready: boolean;               // no blocked stages
  warnings: string[];
  missing: MissingItem[];       // union of blocked stages' missing items
}

/**
 * Plan the pipeline for a shot. `overrides` force a stage on/off (undefined = use
 * the recommendation). A stage that is requested but not installed comes back
 * `blocked` with its missing items — surfaced, never silently skipped or run.
 */
export function planPipeline(
  ctx: PipelineContext,
  overrides: Partial<Record<StageId, boolean>> = {},
  snapshot: ReadinessSnapshot = CURRENT_BOX_READINESS,
): PipelinePlan {
  if (!Number.isFinite(ctx.generationFps) || ctx.generationFps <= 0) throw new PipelineError('generationFps must be a positive number');
  if (!Number.isFinite(ctx.targetFps) || ctx.targetFps <= 0) throw new PipelineError('targetFps must be a positive number');
  for (const k of Object.keys(overrides)) {
    if (!STAGES.some((s) => s.id === k)) throw new PipelineError(`unknown stage in overrides: "${k}"`);
  }
  const mode: GenerateMode = ctx.generateMode ?? 'i2v';

  const warnings: string[] = [];
  const stages: StagePlanEntry[] = [];

  for (const def of [...STAGES].sort((a, b) => a.order - b.order)) {
    const rec = def.recommend(ctx);
    const override = overrides[def.id];
    const requested = override ?? rec.on;
    const source: 'recommended' | 'override' = override === undefined ? 'recommended' : 'override';

    // mandatory stages can't be overridden off
    if (!def.optional && override === false) throw new PipelineError(`stage "${def.id}" is mandatory and cannot be disabled`);

    // readiness
    const requiredNodes = def.id === 'generate' ? [...def.requiredNodes, generateModeNode(mode)] : def.requiredNodes;
    const missing: MissingItem[] = [];
    for (const n of requiredNodes) if (!hasNode(snapshot, n)) missing.push({ kind: 'node', what: n });
    for (const m of def.requiredModels) if (!hasModel(snapshot, m)) missing.push({ kind: 'model', what: `${m.dir}/ (${m.match})`, purpose: m.purpose });
    const ready = missing.length === 0;

    const enabled = requested && ready;
    const blocked = requested && !ready;

    stages.push({ id: def.id, name: def.name, order: def.order, recommended: rec.on, reason: rec.reason, requested, source, enabled, blocked, ready, missing });

    // advisory warnings
    if (def.id === 'upscale' && requested && ctx.isPreview) warnings.push('upscale is enabled on a PREVIEW — this wastes GPU; upscaling is the delivery step');
    if (def.id === 'interpolate' && override === true && ctx.targetFps <= ctx.generationFps) warnings.push('interpolate forced on, but generation fps already meets target — it will be a no-op');
    if (def.id === 'detail' && override === true && !ctx.handsInFrame && !ctx.facesInFrame) warnings.push('detail forced on, but no hands/faces flagged — the detector may find nothing');
    if (blocked) warnings.push(`stage "${def.id}" is requested but not runnable — ${missing.map((x) => x.what).join(', ')} missing`);
  }

  const missing = stages.filter((s) => s.blocked).flatMap((s) => s.missing);
  return {
    mode,
    stages,
    order: stages.filter((s) => s.enabled).map((s) => s.id),
    ready: stages.every((s) => !s.blocked),
    warnings,
    missing,
  };
}

// ---- audited baseline (SAGA box, 2026-07-18) ---------------------------------
// Snapshot from saga-audit.sh: every pipeline stage's nodes + models present.
// A live systems adapter rebuilds this from /object_info + the model tree; this
// constant is the known-good default so a caller without a live probe still gets
// truth-as-of-audit rather than assumptions.
export const CURRENT_BOX_READINESS: ReadinessSnapshot = {
  nodes: [
    'WanFirstLastFrameToVideo', 'WanImageToVideo', 'UnetLoaderGGUF',
    'FaceDetailer', 'UltralyticsDetectorProvider',
    'ControlNetLoader', 'ControlNetApplyAdvanced', 'DWPreprocessor', 'OpenposePreprocessor',
    'RIFE VFI',
    'UpscaleModelLoader', 'ImageUpscaleWithModel',
    'IPAdapterUnifiedLoader', 'IPAdapterAdvanced',
  ],
  models: [
    'checkpoints/animagine-xl-4.0.safetensors',
    'unet/Wan2.2-I2V-A14B-HighNoise-Q6_K.gguf',
    'unet/Wan2.2-I2V-A14B-LowNoise-Q6_K.gguf',
    'diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
    'loras/wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors',
    'loras/wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors',
    'vae/wan_2.1_vae.safetensors',
    'clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors',
    'ipadapter/ip-adapter-plus_sdxl_vit-h.safetensors',
    'controlnet/controlnet-union-sdxl-promax.safetensors',
    'upscale_models/4x-AnimeSharp.pth',
    'ultralytics/bbox/face_yolov8m.pt',
    'ultralytics/bbox/hand_yolov8s.pt',
  ],
};
