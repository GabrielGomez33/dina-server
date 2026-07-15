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
    '9': { class_type: 'IPAdapterUnifiedLoader', inputs: { model: ['1', 0], preset: 'PLUS (high strength)' } },
    '10': {
      class_type: 'IPAdapterAdvanced',
      inputs: {
        model: ['9', 0], ipadapter: ['9', 1], image: ['8', 0],
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

const REGISTRY = new Map<string, WorkflowTemplate>([
  [TEMPLATE_IMAGE_BASIC.id, TEMPLATE_IMAGE_BASIC],
  [TEMPLATE_IMAGE_REFERENCE.id, TEMPLATE_IMAGE_REFERENCE],
]);

export function getTemplate(id: string): WorkflowTemplate | undefined {
  return REGISTRY.get(id);
}
export function registerTemplate(t: WorkflowTemplate): void {
  REGISTRY.set(t.id, t);
}
