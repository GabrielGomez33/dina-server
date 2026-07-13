// File: src/modules/visuals/core/methodRegistry.ts
// ============================================================================
// DINA VISUALS — DUMP METHOD REGISTRY (pure logic)
// ============================================================================
// The complete DUMP surface of the visuals module, with per-method payload
// validation done ONCE at the boundary (reject-don't-guess). The orchestrator's
// `case 'visuals'` dispatches by method name; handlers can then trust their
// inputs. Mirrors how mirror methods are enumerated in
// orchestrator.processMirrorRequest(), but as data instead of a switch so the
// surface is testable and self-documenting.
// ============================================================================

export interface FieldSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  required: boolean;
  /** For strings: maximum length accepted (defensive input bound). */
  maxLen?: number;
}

export interface MethodSpec {
  method: string;
  description: string;
  /** Fields expected inside payload.data. */
  fields: FieldSpec[];
  /** True if the method mutates state (audit-log emphasis, no caching). */
  mutating: boolean;
  /** Enqueues a GPU job (runs through the gpuArbiter exclusive path). */
  gpuJob: boolean;
}

export const VISUALS_METHODS: readonly MethodSpec[] = Object.freeze([
  // ---- tenancy / projects ----
  {
    method: 'visuals_create_tenant',
    description: 'Create a tenant (admin only)',
    fields: [
      { name: 'name', type: 'string', required: true, maxLen: 120 },
      { name: 'slug', type: 'string', required: true, maxLen: 80 },
      { name: 'plan', type: 'string', required: false, maxLen: 16 },
    ],
    mutating: true,
    gpuJob: false,
  },
  {
    method: 'visuals_create_project',
    description: 'Create a project under a tenant',
    fields: [
      { name: 'tenantId', type: 'string', required: true, maxLen: 36 },
      { name: 'slug', type: 'string', required: true, maxLen: 80 },
    ],
    mutating: true,
    gpuJob: false,
  },
  {
    method: 'visuals_get_project',
    description: 'Fetch a project (with quota + manifest summary)',
    fields: [
      { name: 'tenantId', type: 'string', required: true, maxLen: 36 },
      { name: 'projectId', type: 'string', required: true, maxLen: 36 },
    ],
    mutating: false,
    gpuJob: false,
  },
  {
    method: 'visuals_delete_project',
    description: 'Soft-delete a project (30d recovery window)',
    fields: [
      { name: 'tenantId', type: 'string', required: true, maxLen: 36 },
      { name: 'projectId', type: 'string', required: true, maxLen: 36 },
    ],
    mutating: true,
    gpuJob: false,
  },
  // ---- generation ----
  {
    method: 'visuals_generate_image',
    description: 'Enqueue an image generation (FLUX/SDXL via ComfyUI)',
    fields: [
      { name: 'tenantId', type: 'string', required: true, maxLen: 36 },
      { name: 'projectId', type: 'string', required: true, maxLen: 36 },
      { name: 'params', type: 'object', required: true },
    ],
    mutating: true,
    gpuJob: true,
  },
  {
    method: 'visuals_generate_video',
    description: 'Enqueue a video generation (Wan/Hunyuan via ComfyUI)',
    fields: [
      { name: 'tenantId', type: 'string', required: true, maxLen: 36 },
      { name: 'projectId', type: 'string', required: true, maxLen: 36 },
      { name: 'params', type: 'object', required: true },
    ],
    mutating: true,
    gpuJob: true,
  },
  {
    method: 'visuals_generate_music_video',
    description: 'Enqueue the orchestrated audio→ShotPlan→video pipeline',
    fields: [
      { name: 'tenantId', type: 'string', required: true, maxLen: 36 },
      { name: 'projectId', type: 'string', required: true, maxLen: 36 },
      { name: 'audioTrackId', type: 'string', required: true, maxLen: 36 },
      { name: 'modes', type: 'object', required: true }, // {beatSync,lyricSync,lipSync}
      { name: 'params', type: 'object', required: false },
    ],
    mutating: true,
    gpuJob: true,
  },
  {
    method: 'visuals_train_lora',
    description: 'Enqueue a LoRA training job for a manifest',
    fields: [
      { name: 'tenantId', type: 'string', required: true, maxLen: 36 },
      { name: 'projectId', type: 'string', required: true, maxLen: 36 },
      { name: 'manifestId', type: 'string', required: true, maxLen: 36 },
    ],
    mutating: true,
    gpuJob: true,
  },
  // ---- audio ----
  {
    method: 'visuals_audio_analyze',
    description: 'Enqueue audio analysis (Demucs + beats + WhisperX); cached per track',
    fields: [
      { name: 'tenantId', type: 'string', required: true, maxLen: 36 },
      { name: 'projectId', type: 'string', required: true, maxLen: 36 },
      { name: 'audioTrackId', type: 'string', required: true, maxLen: 36 },
    ],
    mutating: true,
    gpuJob: false, // mostly CPU; runs in the audio queue
  },
  // ---- jobs / lifecycle ----
  {
    method: 'visuals_job_status',
    description: 'Snapshot of a job (state + last progress event)',
    fields: [
      { name: 'tenantId', type: 'string', required: true, maxLen: 36 },
      { name: 'jobId', type: 'string', required: true, maxLen: 36 },
    ],
    mutating: false,
    gpuJob: false,
  },
  {
    method: 'visuals_job_cancel',
    description: 'Cancel a queued/running job',
    fields: [
      { name: 'tenantId', type: 'string', required: true, maxLen: 36 },
      { name: 'jobId', type: 'string', required: true, maxLen: 36 },
    ],
    mutating: true,
    gpuJob: false,
  },
  {
    method: 'visuals_promote_generation',
    description: 'Promote a generation to exports (TTL-immune)',
    fields: [
      { name: 'tenantId', type: 'string', required: true, maxLen: 36 },
      { name: 'projectId', type: 'string', required: true, maxLen: 36 },
      { name: 'generationId', type: 'string', required: true, maxLen: 36 },
    ],
    mutating: true,
    gpuJob: false,
  },
  {
    method: 'visuals_get_status',
    description: 'Module health (queues, storage, arbiter view)',
    fields: [],
    mutating: false,
    gpuJob: false,
  },
] as MethodSpec[]);

const BY_NAME = new Map(VISUALS_METHODS.map((m) => [m.method, m]));

export function isVisualsMethod(method: string): boolean {
  return BY_NAME.has(method);
}

export function getMethodSpec(method: string): MethodSpec | undefined {
  return BY_NAME.get(method);
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate payload.data against a method's spec. Strict on required fields and
 * basic types; bounds string lengths (defensive input caps, like mirror's
 * substring(0, 10000) sanitization but declared, not ad-hoc).
 */
export function validatePayload(method: string, data: unknown): ValidationResult {
  const spec = BY_NAME.get(method);
  if (!spec) return { valid: false, errors: [`Unknown visuals method: ${method}`] };

  const errors: string[] = [];
  const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;

  for (const f of spec.fields) {
    const v = obj[f.name];
    if (v === undefined || v === null || (f.type === 'string' && String(v).trim() === '')) {
      if (f.required) errors.push(`Missing required field: ${f.name}`);
      continue;
    }
    switch (f.type) {
      case 'string':
        if (typeof v !== 'string') errors.push(`Field ${f.name} must be a string`);
        else if (f.maxLen && v.length > f.maxLen) errors.push(`Field ${f.name} exceeds max length ${f.maxLen}`);
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`Field ${f.name} must be a finite number`);
        break;
      case 'boolean':
        if (typeof v !== 'boolean') errors.push(`Field ${f.name} must be a boolean`);
        break;
      case 'object':
        if (typeof v !== 'object' || Array.isArray(v)) errors.push(`Field ${f.name} must be an object`);
        break;
    }
  }
  return { valid: errors.length === 0, errors };
}
