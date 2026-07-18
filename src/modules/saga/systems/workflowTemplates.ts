// File: src/modules/saga/systems/workflowTemplates.ts
// ============================================================================
// DINA SAGA — COMFYUI WORKFLOW TEMPLATE BINDING (pure logic)
// ============================================================================
// ComfyUI executes a JSON node graph. We version graphs as TEMPLATES with
// ${placeholders}; binding substitutes validated inputs and produces the final
// graph. Rules (all proven in the harness):
//
//   • REJECT unknown placeholders left unbound (a half-bound graph must never
//    reach the GPU — fail fast at zero cost).
//   • REJECT inputs not declared by the template (no smuggling arbitrary keys).
//   • Values are type-coerced per declaration; strings are JSON-encoded into
//     the graph so prompt text can never break JSON structure (injection-safe).
//   • Binding is pure string→object work: no I/O, no ComfyUI import.
// ============================================================================

export interface TemplateInputSpec {
  name: string;
  type: 'string' | 'number' | 'integer';
  required: boolean;
  default?: string | number;
  min?: number;
  max?: number;
}

export interface WorkflowTemplate {
  id: string; // 'flux-image@1' — versioned identity
  jobKind: 'image_gen' | 'video_gen';
  inputs: TemplateInputSpec[];
  /** The ComfyUI graph as a JSON string containing ${name} placeholders. */
  graphJson: string;
}

export class WorkflowBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowBindError';
  }
}

const PLACEHOLDER_RE = /"\$\{([A-Za-z_][A-Za-z0-9_]*)\}"|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Bind inputs into a template → parsed ComfyUI graph object. Throws WorkflowBindError. */
export function bindWorkflow(template: WorkflowTemplate, inputs: Record<string, unknown>): Record<string, any> {
  const declared = new Map(template.inputs.map((i) => [i.name, i]));

  // Rule: no undeclared inputs.
  for (const key of Object.keys(inputs)) {
    if (!declared.has(key)) throw new WorkflowBindError(`Input "${key}" is not declared by template ${template.id}`);
  }

  // Resolve every declared input (value → default → error if required).
  const resolved = new Map<string, string | number>();
  for (const spec of template.inputs) {
    let v: unknown = inputs[spec.name];
    if (v === undefined || v === null || v === '') v = spec.default;
    // Note: an empty-string DEFAULT is a legitimate value (e.g. negative
    // prompt) — only undefined/null mean "truly absent" from here on.
    if (v === undefined || v === null) {
      if (spec.required) throw new WorkflowBindError(`Missing required input "${spec.name}" for template ${template.id}`);
      continue;
    }
    resolved.set(spec.name, coerce(spec, v));
  }

  // Substitute. Quoted form "${x}" is replaced by the JSON encoding of the
  // value (string-safe); bare form ${x} only ever receives numbers.
  const bound = template.graphJson.replace(PLACEHOLDER_RE, (match, quotedName, bareName) => {
    const name = (quotedName ?? bareName) as string;
    if (!resolved.has(name)) {
      throw new WorkflowBindError(`Placeholder \${${name}} in template ${template.id} has no bound value`);
    }
    const value = resolved.get(name)!;
    // Quoted form "${x}" is replaced by the value's native JSON encoding:
    // numbers land unquoted (KSampler gets seed:42, not "42"), strings land
    // escaped-and-quoted so prompt text can never break the JSON structure.
    if (quotedName !== undefined) return JSON.stringify(value);
    if (typeof value !== 'number') {
      throw new WorkflowBindError(`Bare placeholder \${${name}} requires a numeric value in template ${template.id}`);
    }
    return String(value);
  });

  // Any placeholder still present means the template declares fewer inputs
  // than it uses — a template authoring bug we refuse to ship to the GPU.
  if (PLACEHOLDER_RE.test(bound)) {
    throw new WorkflowBindError(`Template ${template.id} still contains unbound placeholders after binding`);
  }

  try {
    return JSON.parse(bound);
  } catch (e) {
    throw new WorkflowBindError(`Template ${template.id} produced invalid JSON after binding: ${(e as Error).message}`);
  }
}

function coerce(spec: TemplateInputSpec, v: unknown): string | number {
  switch (spec.type) {
    case 'string': {
      const s = String(v);
      if (s.length > 8000) throw new WorkflowBindError(`Input "${spec.name}" exceeds 8000 chars`);
      return s;
    }
    case 'number':
    case 'integer': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new WorkflowBindError(`Input "${spec.name}" must be a finite number`);
      const bounded = Math.min(spec.max ?? Number.MAX_SAFE_INTEGER, Math.max(spec.min ?? Number.MIN_SAFE_INTEGER, n));
      return spec.type === 'integer' ? Math.round(bounded) : bounded;
    }
  }
}

// ----------------------------------------------------------------------------
// BUILT-IN TEMPLATES (v1 — minimal, calibration-friendly graphs; the full
// production graphs land with the model registry so node names track installed
// custom nodes). Structure mirrors ComfyUI's API format: {nodeId: {class_type,
// inputs}}.
// ----------------------------------------------------------------------------

export const TEMPLATE_IMAGE_BASIC: WorkflowTemplate = {
  id: 'image-basic@1',
  jobKind: 'image_gen',
  inputs: [
    { name: 'prompt', type: 'string', required: true },
    { name: 'negative', type: 'string', required: false, default: '' },
    { name: 'checkpoint', type: 'string', required: true },
    { name: 'seed', type: 'integer', required: false, default: 0, min: 0 },
    { name: 'steps', type: 'integer', required: false, default: 28, min: 1, max: 150 },
    { name: 'width', type: 'integer', required: false, default: 1024, min: 256, max: 2048 },
    { name: 'height', type: 'integer', required: false, default: 1024, min: 256, max: 2048 },
    { name: 'cfg', type: 'number', required: false, default: 5.5, min: 1, max: 30 },
  ],
  graphJson: JSON.stringify({
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '${checkpoint}' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '${prompt}', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '${negative}', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: '${width}', height: '${height}', batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: '${seed}', steps: '${steps}', cfg: '${cfg}', sampler_name: 'euler',
        scheduler: 'normal', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'dina', images: ['6', 0] } },
  }),
};

// ----------------------------------------------------------------------------
// REFERENCE-CONDITIONED IMAGE (IP-Adapter) — SAGA's consistency workhorse.
//
// Text prompts are a probability distribution, not a specification: they cannot
// pin a subject's identity or count (this is why "solo" fails to stop a second
// figure appearing). IP-Adapter feeds a REFERENCE IMAGE as an image-prompt so
// the model emulates that subject/style, weightable 0..1. This is the first rung
// of the consistency stack and the foundation every downstream video frame will
// lean on for character coherence.
//
// Requires (installed on the engine box, exposed via extra_model_paths.yaml):
//   • custom node  ComfyUI_IPAdapter_plus
//   • models/ipadapter/ip-adapter-plus_sdxl_vit-h.safetensors
//   • models/clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors
// The reference file named by ${referenceImage} must live in ComfyUI's input/
// dir (the worker uploads it via POST /upload/image before submitting).
//
// UnifiedLoader auto-resolves the ipadapter + clip_vision models from the preset,
// so the graph stays free of absolute paths.
// ----------------------------------------------------------------------------
export const TEMPLATE_IMAGE_REFERENCE: WorkflowTemplate = {
  id: 'image-reference@1',
  jobKind: 'image_gen',
  inputs: [
    { name: 'prompt', type: 'string', required: true },
    { name: 'negative', type: 'string', required: false, default: '' },
    { name: 'checkpoint', type: 'string', required: true },
    { name: 'referenceImage', type: 'string', required: true }, // filename in ComfyUI input/
    { name: 'ipAdapterWeight', type: 'number', required: false, default: 0.6, min: 0, max: 1 },
    { name: 'seed', type: 'integer', required: false, default: 0, min: 0 },
    { name: 'steps', type: 'integer', required: false, default: 28, min: 1, max: 150 },
    { name: 'width', type: 'integer', required: false, default: 1024, min: 256, max: 2048 },
    { name: 'height', type: 'integer', required: false, default: 1024, min: 256, max: 2048 },
    { name: 'cfg', type: 'number', required: false, default: 5.5, min: 1, max: 30 },
  ],
  graphJson: JSON.stringify({
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '${checkpoint}' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '${prompt}', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '${negative}', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: '${width}', height: '${height}', batch_size: 1 } },
    '8': { class_type: 'LoadImage', inputs: { image: '${referenceImage}' } },
    // Preprocess the reference for the CLIP vision encoder (center-crop + clean
    // resample). General fidelity win — better features in, better identity out —
    // and subject-agnostic (helps every reference, not just one subject).
    '14': { class_type: 'PrepImageForClipVision', inputs: { image: ['8', 0], interpolation: 'LANCZOS', crop_position: 'center', sharpening: 0 } },
    '9': { class_type: 'IPAdapterUnifiedLoader', inputs: { model: ['1', 0], preset: 'PLUS (high strength)' } },
    '10': {
      class_type: 'IPAdapterAdvanced',
      inputs: {
        model: ['9', 0], ipadapter: ['9', 1], image: ['14', 0],
        weight: '${ipAdapterWeight}', weight_type: 'linear', combine_embeds: 'concat',
        start_at: 0, end_at: 1, embeds_scaling: 'V only',
      },
    },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: '${seed}', steps: '${steps}', cfg: '${cfg}', sampler_name: 'euler',
        scheduler: 'normal', denoise: 1, model: ['10', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'dina_ref', images: ['6', 0] } },
  }),
};

// ----------------------------------------------------------------------------
// VIDEO — Wan 2.2 TI2V (image→video). The motion half of the relay:
// Animagine+IP-Adapter produce the keyframe, Wan animates it. Wan 5B at ~18 GB
// is a HEAVY model — it takes an EXCLUSIVE GPU lease (drains Ollama) via the
// arbiter; the model registry enforces that pairing.
//
// ⚠️ PROVISIONAL GRAPH: Wan node class names / socket order are verified against
// the LIVE ComfyUI during Phase 2 wiring (same "template in repo → verify live →
// fix" loop that corrected IP-Adapter's weight_type). The BINDING LOGIC below is
// what the harness proves; ComfyUI-node correctness is a separate live gate,
// tracked in VERIFICATION.md. Do not mark this non-provisional until it renders.
// ----------------------------------------------------------------------------
export const TEMPLATE_VIDEO_I2V_WAN: WorkflowTemplate = {
  id: 'video-i2v-wan@1',
  jobKind: 'video_gen',
  inputs: [
    { name: 'diffusionModel', type: 'string', required: true },
    { name: 'textEncoder', type: 'string', required: true },
    { name: 'vae', type: 'string', required: true },
    { name: 'prompt', type: 'string', required: true },
    { name: 'negative', type: 'string', required: false, default: '' },
    { name: 'referenceImage', type: 'string', required: true }, // start frame, in ComfyUI input/
    { name: 'width', type: 'integer', required: false, default: 1280, min: 256, max: 1280 },
    { name: 'height', type: 'integer', required: false, default: 704, min: 256, max: 1280 },
    { name: 'length', type: 'integer', required: false, default: 49, min: 8, max: 161 }, // frames
    { name: 'fps', type: 'integer', required: false, default: 24, min: 8, max: 60 },
    { name: 'seed', type: 'integer', required: false, default: 0, min: 0 },
    { name: 'steps', type: 'integer', required: false, default: 30, min: 1, max: 100 },
    { name: 'cfg', type: 'number', required: false, default: 5, min: 1, max: 20 },
  ],
  graphJson: JSON.stringify({
    '1': { class_type: 'UNETLoader', inputs: { unet_name: '${diffusionModel}', weight_dtype: 'fp8_e4m3fn' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: '${textEncoder}', type: 'wan' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: '${vae}' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: '${prompt}', clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: '${negative}', clip: ['2', 0] } },
    '6': { class_type: 'LoadImage', inputs: { image: '${referenceImage}' } },
    '7': {
      class_type: 'WanImageToVideo',
      inputs: {
        positive: ['4', 0], negative: ['5', 0], vae: ['3', 0], start_image: ['6', 0],
        width: '${width}', height: '${height}', length: '${length}', batch_size: 1,
      },
    },
    '8': {
      class_type: 'KSampler',
      inputs: {
        seed: '${seed}', steps: '${steps}', cfg: '${cfg}', sampler_name: 'uni_pc', scheduler: 'simple',
        denoise: 1, model: ['1', 0], positive: ['7', 0], negative: ['7', 1], latent_image: ['7', 2],
      },
    },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': {
      class_type: 'VHS_VideoCombine',
      inputs: { images: ['9', 0], frame_rate: '${fps}', filename_prefix: 'saga_video', format: 'video/h264-mp4' },
    },
  }),
};

// ----------------------------------------------------------------------------
// VIDEO — Wan 2.2 I2V-A14B (GGUF Q6_K) + dual 4-step LightX2V lightning LoRAs.
// The PRIMARY anime-video path. VERIFIED LIVE 2026-07-17: rendered end-to-end on
// the first submit (18-node two-expert MoE graph) → saga_a14b_00001.mp4 in 126s.
//
// A14B is a Mixture-of-Experts: a HIGH-noise expert denoises the early steps, a
// LOW-noise expert the late steps. Each carries its own lightning LoRA, and each
// gets a ModelSamplingSD3 shift. Sampling is a two-stage KSamplerAdvanced handoff
// (steps 0→2 high, 2→end low), 4 steps total at CFG 1 (the lightning recipe —
// hardcoded here because it defines this template). Experts load sequentially, so
// at Q6_K peak stays ~one expert (~11GB) → resident on 24GB (drained). Uses the
// Wan 2.1 VAE (not the 2.2 VAE) and CLIP-ViT-H for the image conditioning.
// ----------------------------------------------------------------------------
export const TEMPLATE_VIDEO_I2V_WAN_A14B: WorkflowTemplate = {
  id: 'video-i2v-wan-a14b@1',
  jobKind: 'video_gen',
  inputs: [
    { name: 'highNoiseUnet', type: 'string', required: true },
    { name: 'lowNoiseUnet', type: 'string', required: true },
    { name: 'highLora', type: 'string', required: true },
    { name: 'lowLora', type: 'string', required: true },
    { name: 'textEncoder', type: 'string', required: true },
    { name: 'vae', type: 'string', required: true },
    { name: 'clipVision', type: 'string', required: true },
    { name: 'prompt', type: 'string', required: true },
    { name: 'negative', type: 'string', required: false, default: '' },
    { name: 'referenceImage', type: 'string', required: true },
    { name: 'width', type: 'integer', required: false, default: 1280, min: 256, max: 1280 },
    { name: 'height', type: 'integer', required: false, default: 704, min: 256, max: 1280 },
    { name: 'length', type: 'integer', required: false, default: 33, min: 8, max: 121 },
    { name: 'fps', type: 'integer', required: false, default: 16, min: 8, max: 60 },
    { name: 'seed', type: 'integer', required: false, default: 0, min: 0 },
    { name: 'shift', type: 'number', required: false, default: 5, min: 1, max: 12 },
  ],
  graphJson: JSON.stringify({
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: '${highNoiseUnet}' } },
    '2': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: '${lowNoiseUnet}' } },
    '3': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: '${highLora}', strength_model: 1.0 } },
    '4': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['2', 0], lora_name: '${lowLora}', strength_model: 1.0 } },
    '5': { class_type: 'ModelSamplingSD3', inputs: { model: ['3', 0], shift: '${shift}' } },
    '6': { class_type: 'ModelSamplingSD3', inputs: { model: ['4', 0], shift: '${shift}' } },
    '7': { class_type: 'CLIPLoader', inputs: { clip_name: '${textEncoder}', type: 'wan' } },
    '8': { class_type: 'VAELoader', inputs: { vae_name: '${vae}' } },
    '9': { class_type: 'CLIPVisionLoader', inputs: { clip_name: '${clipVision}' } },
    '10': { class_type: 'LoadImage', inputs: { image: '${referenceImage}' } },
    '11': { class_type: 'CLIPVisionEncode', inputs: { clip_vision: ['9', 0], image: ['10', 0], crop: 'center' } },
    '12': { class_type: 'CLIPTextEncode', inputs: { text: '${prompt}', clip: ['7', 0] } },
    '13': { class_type: 'CLIPTextEncode', inputs: { text: '${negative}', clip: ['7', 0] } },
    '14': {
      class_type: 'WanImageToVideo',
      inputs: { positive: ['12', 0], negative: ['13', 0], vae: ['8', 0], clip_vision_output: ['11', 0], start_image: ['10', 0], width: '${width}', height: '${height}', length: '${length}', batch_size: 1 },
    },
    '15': {
      class_type: 'KSamplerAdvanced',
      inputs: { add_noise: 'enable', noise_seed: '${seed}', steps: 4, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', start_at_step: 0, end_at_step: 2, return_with_leftover_noise: 'enable', model: ['5', 0], positive: ['14', 0], negative: ['14', 1], latent_image: ['14', 2] },
    },
    '16': {
      class_type: 'KSamplerAdvanced',
      inputs: { add_noise: 'disable', noise_seed: '${seed}', steps: 4, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: 'disable', model: ['6', 0], positive: ['14', 0], negative: ['14', 1], latent_image: ['15', 0] },
    },
    '17': { class_type: 'VAEDecode', inputs: { samples: ['16', 0], vae: ['8', 0] } },
    '18': { class_type: 'VHS_VideoCombine', inputs: { images: ['17', 0], frame_rate: '${fps}', loop_count: 0, filename_prefix: 'saga_a14b', format: 'video/h264-mp4', pingpong: false, save_output: true } },
  }),
};

// ----------------------------------------------------------------------------
// VIDEO — Wan 2.2 FLF2V-A14B (FIRST-LAST-FRAME → video). Directed-motion path.
// Identical MoE lightning stack to the verified A14B I2V template above, with ONE
// structural change: the motion node is WanFirstLastFrameToVideo and it takes BOTH
// a start_image (${referenceImage}) AND an end_image (${endImage}). The model
// generates the in-between motion that morphs the first pose into the last — so a
// keyframeChoreography emits one bind of this per adjacent keyframe pair. Identity
// is anchored on the START frame's CLIP-Vision (the pose we're moving away from).
//
// ⚠️ PROVISIONAL GRAPH: WanFirstLastFrameToVideo class name + socket order are
// verified against LIVE ComfyUI before use (same "template in repo → verify live →
// fix" loop that corrected IP-Adapter's weight_type and validated the I2V graph).
// The BINDING is what the harness proves here; ComfyUI-node correctness is a
// separate live gate, tracked in VERIFICATION.md. Do not mark non-provisional
// until it renders on the box.
// ----------------------------------------------------------------------------
export const TEMPLATE_VIDEO_FLF_WAN_A14B: WorkflowTemplate = {
  id: 'video-flf-wan-a14b@1',
  jobKind: 'video_gen',
  inputs: [
    { name: 'highNoiseUnet', type: 'string', required: true },
    { name: 'lowNoiseUnet', type: 'string', required: true },
    { name: 'highLora', type: 'string', required: true },
    { name: 'lowLora', type: 'string', required: true },
    { name: 'textEncoder', type: 'string', required: true },
    { name: 'vae', type: 'string', required: true },
    { name: 'clipVision', type: 'string', required: true },
    { name: 'prompt', type: 'string', required: false, default: '' }, // motion hint; poses carry the content
    { name: 'negative', type: 'string', required: false, default: '' },
    { name: 'referenceImage', type: 'string', required: true }, // START frame (in ComfyUI input/)
    { name: 'endImage', type: 'string', required: true },       // LAST frame (in ComfyUI input/)
    { name: 'width', type: 'integer', required: false, default: 1280, min: 256, max: 1280 },
    { name: 'height', type: 'integer', required: false, default: 704, min: 256, max: 1280 },
    { name: 'length', type: 'integer', required: false, default: 33, min: 8, max: 81 }, // one Wan window
    { name: 'fps', type: 'integer', required: false, default: 16, min: 8, max: 60 },
    { name: 'seed', type: 'integer', required: false, default: 0, min: 0 },
    { name: 'shift', type: 'number', required: false, default: 5, min: 1, max: 12 },
  ],
  graphJson: JSON.stringify({
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: '${highNoiseUnet}' } },
    '2': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: '${lowNoiseUnet}' } },
    '3': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: '${highLora}', strength_model: 1.0 } },
    '4': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['2', 0], lora_name: '${lowLora}', strength_model: 1.0 } },
    '5': { class_type: 'ModelSamplingSD3', inputs: { model: ['3', 0], shift: '${shift}' } },
    '6': { class_type: 'ModelSamplingSD3', inputs: { model: ['4', 0], shift: '${shift}' } },
    '7': { class_type: 'CLIPLoader', inputs: { clip_name: '${textEncoder}', type: 'wan' } },
    '8': { class_type: 'VAELoader', inputs: { vae_name: '${vae}' } },
    '9': { class_type: 'CLIPVisionLoader', inputs: { clip_name: '${clipVision}' } },
    '10': { class_type: 'LoadImage', inputs: { image: '${referenceImage}' } },
    '19': { class_type: 'LoadImage', inputs: { image: '${endImage}' } },
    '11': { class_type: 'CLIPVisionEncode', inputs: { clip_vision: ['9', 0], image: ['10', 0], crop: 'center' } },
    '12': { class_type: 'CLIPTextEncode', inputs: { text: '${prompt}', clip: ['7', 0] } },
    '13': { class_type: 'CLIPTextEncode', inputs: { text: '${negative}', clip: ['7', 0] } },
    '14': {
      class_type: 'WanFirstLastFrameToVideo',
      inputs: { positive: ['12', 0], negative: ['13', 0], vae: ['8', 0], clip_vision_output: ['11', 0], start_image: ['10', 0], end_image: ['19', 0], width: '${width}', height: '${height}', length: '${length}', batch_size: 1 },
    },
    '15': {
      class_type: 'KSamplerAdvanced',
      inputs: { add_noise: 'enable', noise_seed: '${seed}', steps: 4, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', start_at_step: 0, end_at_step: 2, return_with_leftover_noise: 'enable', model: ['5', 0], positive: ['14', 0], negative: ['14', 1], latent_image: ['14', 2] },
    },
    '16': {
      class_type: 'KSamplerAdvanced',
      inputs: { add_noise: 'disable', noise_seed: '${seed}', steps: 4, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: 'disable', model: ['6', 0], positive: ['14', 0], negative: ['14', 1], latent_image: ['15', 0] },
    },
    '17': { class_type: 'VAEDecode', inputs: { samples: ['16', 0], vae: ['8', 0] } },
    '18': { class_type: 'VHS_VideoCombine', inputs: { images: ['17', 0], frame_rate: '${fps}', loop_count: 0, filename_prefix: 'saga_flf', format: 'video/h264-mp4', pingpong: false, save_output: true } },
  }),
};

const REGISTRY = new Map<string, WorkflowTemplate>([
  [TEMPLATE_IMAGE_BASIC.id, TEMPLATE_IMAGE_BASIC],
  [TEMPLATE_IMAGE_REFERENCE.id, TEMPLATE_IMAGE_REFERENCE],
  [TEMPLATE_VIDEO_I2V_WAN.id, TEMPLATE_VIDEO_I2V_WAN],
  [TEMPLATE_VIDEO_I2V_WAN_A14B.id, TEMPLATE_VIDEO_I2V_WAN_A14B],
  [TEMPLATE_VIDEO_FLF_WAN_A14B.id, TEMPLATE_VIDEO_FLF_WAN_A14B],
]);

export function getTemplate(id: string): WorkflowTemplate | undefined {
  return REGISTRY.get(id);
}
export function registerTemplate(t: WorkflowTemplate): void {
  REGISTRY.set(t.id, t);
}
