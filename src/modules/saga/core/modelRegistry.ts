// File: src/modules/saga/core/modelRegistry.ts
// ============================================================================
// DINA SAGA — MODEL REGISTRY (pure catalog + resource policy)
// ============================================================================
// One concern: the authoritative catalog of generative capabilities. Each
// ModelProfile ties a job kind to the four things the rest of the system needs
// and MUST agree on:
//
//   • templateId   → which ComfyUI workflow template binds the job
//   • files        → the model file(s) that template consumes (by input name)
//   • vram/lease   → how the GPU ARBITER must schedule it (shared vs exclusive)
//   • defaults     → non-file parameters (steps, cfg, fps, dimensions)
//
// It is the clean seam between two decoupled subsystems:
//   - the GPU arbiter (src/modules/gpu) consumes leaseMode/estVramMb
//   - the generation worker (Phase 2) consumes templateId/files/defaults
// Neither imports the other; both import this catalog.
//
// SAFETY INVARIANTS (enforced at module load — fail fast, and proven in
// tests/modelRegistryTest.ts). These exist to make a detrimental scheduling
// mistake IMPOSSIBLE, not merely unlikely:
//
//   1. vramClass MUST match estVramMb (no mislabelled footprint).
//   2. A HEAVY model (> medium ceiling) MUST take an EXCLUSIVE lease. Scheduling
//      a ~18 GB video model as a *shared* lease alongside Ollama's ~10 GB is a
//      guaranteed OOM — the registry refuses to hold such a profile at all.
//   3. A LIGHT model MUST take a SHARED lease (an exclusive lease for a 7 GB
//      model needlessly evicts Ollama — wasteful, so we forbid it).
//   4. templateId MUST resolve, and every files/defaults key MUST be a declared
//      input of that template (no drift between catalog and template contract).
// ============================================================================

import { getTemplate } from '../systems/workflowTemplates';

export type EngineKind = 'comfyui';
export type JobKind = 'image_gen' | 'video_gen';
export type LeaseMode = 'shared' | 'exclusive';
export type VramClass = 'light' | 'medium' | 'heavy';

/** VRAM class ceilings (MB). Light coexists with Ollama; heavy cannot. */
export const VRAM_LIGHT_MAX_MB = 8000;
export const VRAM_MEDIUM_MAX_MB = 16000;

export interface ModelProfile {
  id: string;
  jobKind: JobKind;
  engine: EngineKind;
  templateId: string;
  /** Model files this profile supplies, keyed by the template input each binds to. */
  files: Record<string, string>;
  estVramMb: number;
  vramClass: VramClass;
  leaseMode: LeaseMode;
  /** Default non-file inputs (steps, cfg, fps, dimensions). */
  defaults?: Record<string, string | number>;
  /** The profile resolve() returns when only a jobKind is given. */
  isDefaultFor?: JobKind;
  /** Graph/node names not yet verified against a live engine (blocks "ready"). */
  provisional?: boolean;
  notes?: string;
}

export class ModelRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRegistryError';
  }
}

/** Pure footprint → class mapping. Single source of truth for the thresholds. */
export function classifyVram(mb: number): VramClass {
  if (mb <= VRAM_LIGHT_MAX_MB) return 'light';
  if (mb <= VRAM_MEDIUM_MAX_MB) return 'medium';
  return 'heavy';
}

/**
 * Validate one profile against every safety invariant. Exported so the harness
 * can prove each guard rejects the exact bad profile it is meant to catch.
 * Throws ModelRegistryError on the first violation.
 */
export function validateProfile(p: ModelProfile): void {
  if (p.vramClass !== classifyVram(p.estVramMb)) {
    throw new ModelRegistryError(
      `${p.id}: vramClass "${p.vramClass}" disagrees with estVramMb ${p.estVramMb} (should be "${classifyVram(p.estVramMb)}")`,
    );
  }
  if (p.vramClass === 'heavy' && p.leaseMode !== 'exclusive') {
    throw new ModelRegistryError(`${p.id}: heavy models must take an EXCLUSIVE lease (a shared lease would OOM against Ollama)`);
  }
  if (p.vramClass === 'light' && p.leaseMode !== 'shared') {
    throw new ModelRegistryError(`${p.id}: light models must take a SHARED lease (exclusive needlessly evicts Ollama)`);
  }
  const template = getTemplate(p.templateId);
  if (!template) throw new ModelRegistryError(`${p.id}: references unknown template "${p.templateId}"`);
  if (template.jobKind !== p.jobKind) {
    throw new ModelRegistryError(`${p.id}: jobKind "${p.jobKind}" disagrees with template ${p.templateId} (${template.jobKind})`);
  }
  const declared = new Set(template.inputs.map((i) => i.name));
  for (const key of Object.keys(p.files)) {
    if (!declared.has(key)) throw new ModelRegistryError(`${p.id}: file input "${key}" is not declared by template ${p.templateId}`);
  }
  for (const key of Object.keys(p.defaults ?? {})) {
    if (!declared.has(key)) throw new ModelRegistryError(`${p.id}: default input "${key}" is not declared by template ${p.templateId}`);
  }
}

// ----------------------------------------------------------------------------
// The catalog. Kept small and honest — a profile appears here only once its
// resource profile is understood. `provisional: true` means the workflow graph
// still needs a live render before we trust it end-to-end.
// ----------------------------------------------------------------------------
const PROFILES: ModelProfile[] = [
  {
    id: 'animagine-xl-4',
    jobKind: 'image_gen',
    engine: 'comfyui',
    templateId: 'image-basic@1',
    files: { checkpoint: 'animagine-xl-4.0.safetensors' },
    estVramMb: 7000,
    vramClass: 'light',
    leaseMode: 'shared',
    defaults: { steps: 28, cfg: 6, width: 1024, height: 1024 },
    isDefaultFor: 'image_gen',
    notes: 'Anime SDXL base — coexists with Ollama (proven live).',
  },
  {
    id: 'animagine-xl-4-ref',
    jobKind: 'image_gen',
    engine: 'comfyui',
    templateId: 'image-reference@1',
    files: { checkpoint: 'animagine-xl-4.0.safetensors' },
    estVramMb: 8000,
    vramClass: 'light',
    leaseMode: 'shared',
    defaults: { steps: 30, cfg: 6, ipAdapterWeight: 0.65 },
    notes: 'Anime SDXL + IP-Adapter reference conditioning (identity lock).',
  },
  {
    id: 'wan2.2-ti2v-5b',
    jobKind: 'video_gen',
    engine: 'comfyui',
    templateId: 'video-i2v-wan@1',
    files: {
      diffusionModel: 'wan2.2_ti2v_5B_fp16.safetensors',
      textEncoder: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      vae: 'wan2.2_vae.safetensors',
    },
    estVramMb: 18000,
    vramClass: 'heavy',
    leaseMode: 'exclusive',
    defaults: { steps: 30, cfg: 5, length: 49, fps: 24, width: 1280, height: 704 },
    isDefaultFor: 'video_gen',
    provisional: true,
    notes: 'Wan 2.2 TI2V-5B image→video 720p. HEAVY → exclusive GPU lease. Graph provisional pending live render.',
  },
];

// Fail fast at import: a bad profile must never reach production.
for (const p of PROFILES) validateProfile(p);

/** All profiles, optionally filtered by job kind. Returns a copy (no mutation). */
export function listProfiles(jobKind?: JobKind): ModelProfile[] {
  return (jobKind ? PROFILES.filter((p) => p.jobKind === jobKind) : PROFILES).map((p) => ({ ...p }));
}

/**
 * Resolve a profile by explicit id, or by job kind (→ the kind's default).
 * Throws ModelRegistryError rather than returning undefined, so callers can
 * never silently proceed without a model.
 */
export function resolveProfile(ref: { id?: string; jobKind?: JobKind }): ModelProfile {
  if (ref.id) {
    const p = PROFILES.find((x) => x.id === ref.id);
    if (!p) throw new ModelRegistryError(`No model profile "${ref.id}"`);
    if (ref.jobKind && p.jobKind !== ref.jobKind) {
      throw new ModelRegistryError(`Profile "${ref.id}" is ${p.jobKind}, not ${ref.jobKind}`);
    }
    return { ...p };
  }
  if (ref.jobKind) {
    const def = PROFILES.find((p) => p.isDefaultFor === ref.jobKind) ?? PROFILES.find((p) => p.jobKind === ref.jobKind);
    if (!def) throw new ModelRegistryError(`No model profile for job kind "${ref.jobKind}"`);
    return { ...def };
  }
  throw new ModelRegistryError('resolveProfile requires an id or a jobKind');
}
