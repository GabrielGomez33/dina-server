// File: src/modules/saga/systems/generationWorker.ts
// ============================================================================
// DINA SAGA — GENERATION WORKER (orchestration; all I/O injected as ports)
// ============================================================================
// The keystone that turns proven primitives into the product. ONE job:
// take a generation request and drive it end-to-end, correctly and safely:
//
//   resolve model profile ─▶ apply fidelity dial + user options ─▶ bind the
//   workflow (fail fast, zero GPU cost) ─▶ acquire the RIGHT GPU lease (shared
//   for light, EXCLUSIVE for heavy — auto-drains Ollama) ─▶ submit to ComfyUI
//   ─▶ stream weighted progress ─▶ record the result ─▶ ALWAYS release the lease.
//
// Every collaborator is a PORT (interface), never a concrete singleton, so the
// worker is decoupled from the arbiter, the DB, the socket, and even ComfyUI —
// and provable with fakes (tests/generationWorkerTest.ts). This is the seam the
// whole Phase-2 product hangs from.
//
// SAFETY PROPERTIES (all proven):
//   • A workflow that fails to bind NEVER acquires the GPU (bind precedes lease).
//   • The GPU lease is released on EVERY exit path — success, engine error,
//     timeout, cancel (finally), so one bad job can't wedge the card.
//   • Model files are authoritative: user inputs can override params but can
//     NEVER swap the model files (no smuggling an arbitrary checkpoint).
//   • Heavy models flow to an exclusive lease; the registry already forbids the
//     unsafe pairing, and the worker carries the profile's decision verbatim.
// ============================================================================

import { resolveProfile, ModelRegistryError, JobKind as GenJobKind } from '../core/modelRegistry';
import { getTemplate, bindWorkflow, WorkflowBindError } from './workflowTemplates';
import { fidelityToParams } from '../core/fidelity';
import { ComfyError, ComfyResult } from './comfyClient';
import { ProgressMapper } from './progressMapper';
import { ProgressSinkPort } from '../types';

// ---- ports (injected; production wires the real arbiter / DB / socket) --------

export type GpuLeaseMode = 'shared' | 'exclusive';
export interface GpuLease {
  release(): void;
}
export interface GpuLeaseProvider {
  acquire(req: { mode: GpuLeaseMode; vramMb: number; priority: number; label?: string }): Promise<GpuLease>;
}

/** Minimal structural view of ComfyClient — tests pass a fake, prod passes the real client. */
export interface ComfyExecutor {
  executeWorkflow(
    graph: Record<string, any>,
    handlers?: { onStep?: (value: number, max: number) => void; onNode?: (nodeId: string) => void; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ComfyResult>;
}

export interface GenerationStore {
  markRunning(generationId: string): Promise<void>;
  markSucceeded(generationId: string, outputs: { files: string[]; elapsedMs: number }): Promise<void>;
  markFailed(generationId: string, code: string, message: string): Promise<void>;
}

export interface GenerationRequest {
  generationId: string;
  jobKind: GenJobKind; // 'image_gen' | 'video_gen' (registry-narrow; a video/image job)
  modelId?: string; // explicit model, else the jobKind default
  fidelityLevel?: number; // 0..10 dial (optional)
  priority?: number; // 1..10 (arbiter ordering)
  /** User-supplied, template-bound inputs: prompt, referenceImage, width, height, fps, seed, … */
  inputs?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface GenerationResult {
  ok: boolean;
  generationId: string;
  files?: string[];
  elapsedMs?: number;
  leaseMode?: GpuLeaseMode;
  error?: { code: string; message: string };
}

/** Maps a fidelity param name → the template input it binds to (applied only
 *  when the resolved template actually declares that input). */
const FIDELITY_TO_INPUT: Record<string, 'ipAdapterWeight' | 'controlnetStrength' | 'controlnetEndPercent' | 'denoise'> = {
  ipAdapterWeight: 'ipAdapterWeight',
  controlnet_strength: 'controlnetStrength',
  controlnet_end_percent: 'controlnetEndPercent',
  denoise: 'denoise',
};

export class GenerationWorker {
  constructor(
    private readonly deps: {
      comfy: ComfyExecutor;
      gpu: GpuLeaseProvider;
      store: GenerationStore;
      sink: ProgressSinkPort;
    },
  ) {}

  async run(req: GenerationRequest): Promise<GenerationResult> {
    const { generationId } = req;
    const priority = clampPriority(req.priority);

    // 1. Resolve the model profile (unknown → fail, never proceed model-less).
    let profile;
    try {
      profile = resolveProfile({ id: req.modelId, jobKind: req.jobKind });
    } catch (e) {
      return this.fail(generationId, e instanceof ModelRegistryError ? 'MODEL_NOT_FOUND' : 'PROCESSING_ERROR', asMsg(e));
    }

    const template = getTemplate(profile.templateId);
    if (!template) {
      return this.fail(generationId, 'PROCESSING_ERROR', `template ${profile.templateId} missing`);
    }

    // 2. Compose inputs. Precedence (low→high): defaults < fidelity < user < FILES.
    //    Files last so the user can tune params but never swap model files.
    const declared = new Set(template.inputs.map((i) => i.name));
    const fidelityInputs: Record<string, number> = {};
    if (req.fidelityLevel !== undefined) {
      const fp = fidelityToParams(req.fidelityLevel);
      for (const [fidKey, inputName] of Object.entries(FIDELITY_TO_INPUT)) {
        if (declared.has(inputName)) fidelityInputs[inputName] = (fp as any)[inputName];
        void fidKey;
      }
    }
    const inputs: Record<string, unknown> = {
      ...(profile.defaults ?? {}),
      ...fidelityInputs,
      ...(req.inputs ?? {}),
      ...profile.files, // authoritative — cannot be overridden by user inputs
    };

    // 3. Bind BEFORE touching the GPU — a half-bound graph must never cost a lease.
    let graph: Record<string, any>;
    try {
      graph = bindWorkflow(template, inputs);
    } catch (e) {
      const code = e instanceof WorkflowBindError ? 'INVALID_REQUEST' : 'PROCESSING_ERROR';
      return this.fail(generationId, code, asMsg(e));
    }

    // 4. Mark running, then acquire the lease the profile demands.
    await this.deps.store.markRunning(generationId);
    const mapper = new ProgressMapper(generationId, req.jobKind);
    mapper.enterPhase('load');
    this.deps.sink.emit(mapper.snapshot({ message: `Loading ${profile.id}` }));

    let lease: GpuLease;
    try {
      lease = await this.deps.gpu.acquire({
        mode: profile.leaseMode,
        vramMb: profile.estVramMb,
        priority,
        label: `${req.jobKind}:${generationId}`,
      });
    } catch (e) {
      await this.deps.store.markFailed(generationId, 'GPU_UNAVAILABLE', asMsg(e));
      return { ok: false, generationId, leaseMode: profile.leaseMode, error: { code: 'GPU_UNAVAILABLE', message: asMsg(e) } };
    }

    // 5. Execute under the lease; release on EVERY path.
    try {
      const result = await this.deps.comfy.executeWorkflow(graph, {
        signal: req.signal,
        onStep: (value, max) => {
          mapper.enterPhase('sample');
          mapper.step(value, max);
          this.deps.sink.emit(mapper.snapshot());
        },
      });
      mapper.complete();
      this.deps.sink.emit(mapper.snapshot({ message: 'done' }));

      const files = extractOutputFiles(result.outputs);
      await this.deps.store.markSucceeded(generationId, { files, elapsedMs: result.elapsedMs });
      return { ok: true, generationId, files, elapsedMs: result.elapsedMs, leaseMode: profile.leaseMode };
    } catch (e) {
      const { code, message } = classifyError(e);
      await this.deps.store.markFailed(generationId, code, message);
      return { ok: false, generationId, leaseMode: profile.leaseMode, error: { code, message } };
    } finally {
      lease.release();
    }
  }

  private async fail(generationId: string, code: string, message: string): Promise<GenerationResult> {
    await this.deps.store.markFailed(generationId, code, message);
    return { ok: false, generationId, error: { code, message } };
  }
}

// ---- helpers ------------------------------------------------------------------

/** Collect every output filename ComfyUI reported (SaveImage → images[],
 *  VHS_VideoCombine → gifs[]), across all output nodes. */
export function extractOutputFiles(outputs: Record<string, any>): string[] {
  const files: string[] = [];
  for (const node of Object.values(outputs ?? {})) {
    for (const key of ['images', 'gifs']) {
      const arr = (node as any)?.[key];
      if (Array.isArray(arr)) for (const item of arr) if (item?.filename) files.push(String(item.filename));
    }
  }
  return files;
}

function classifyError(e: unknown): { code: string; message: string } {
  if (e instanceof ComfyError) {
    const map: Record<string, string> = {
      submit: 'ENGINE_REJECTED',
      execution: 'ENGINE_ERROR',
      timeout: 'TIMEOUT',
      stall: 'STALLED',
      aborted: 'CANCELLED',
      transport: 'ENGINE_UNREACHABLE',
    };
    return { code: map[e.kind] ?? 'ENGINE_ERROR', message: e.message };
  }
  return { code: 'PROCESSING_ERROR', message: asMsg(e) };
}

function clampPriority(p: number | undefined): number {
  if (typeof p !== 'number' || !Number.isFinite(p)) return 5;
  return Math.min(10, Math.max(1, Math.round(p)));
}

function asMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
