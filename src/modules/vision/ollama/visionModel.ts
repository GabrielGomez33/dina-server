// File: src/modules/vision/ollama/visionModel.ts
// ============================================================================
// VISION MODEL CLIENT
// ============================================================================
// The bridge between the Vision subsystem and a local multimodal model served
// by Ollama. It REUSES the hardened OllamaClient (NDJSON parsing, timeouts,
// keep-alive, GPU offload) via the single additive `images` field, rather than
// duplicating that fragile transport. On top of it this adds three concerns the
// shared client shouldn't own:
//
//   1. INSTALLED CHECK   — refuse a vision model that isn't pulled locally, with
//      an actionable message ("ollama pull <model>").
//   2. VRAM GUARD        — reuse the LLM VRAM budget so an oversize vision model
//      is not silently split onto the CPU (which would crater latency).
//   3. CONCURRENCY LIMIT — a small semaphore so many simultaneous image/video
//      jobs cannot pin the GPU and starve the rest of DINA.
// ============================================================================

import { OllamaClient } from '../../llm/manager';
import { estimateTotalVramMb, isOversized, getLlmConfig } from '../../llm/llmConfig';
import { getVisionConfig, VisionRuntimeConfig } from '../config/visionConfig';
import { VisionError } from '../types';

/** A minimal counting semaphore for bounding concurrent inferences. */
class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}

  get inFlight(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export interface VisionInferenceRequest {
  /** Instruction/prompt for the model. */
  prompt: string;
  /** System prompt (role/behaviour). */
  system?: string;
  /** One or more base64 images (bare, no data-URI prefix). */
  images: string[];
  /** Override model (still installed/VRAM checked). */
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface VisionInferenceResult {
  text: string;
  model: string;
  promptEvalCount: number;
  evalCount: number;
  durationMs: number;
}

export class VisionModelClient {
  private readonly ollama: OllamaClient;
  private readonly semaphore: Semaphore;
  private availableModels: string[] = [];
  private modelsLoaded = false;

  constructor(private readonly cfg: VisionRuntimeConfig = getVisionConfig()) {
    // Its own OllamaClient instance, but a vision model can be slow on a cold
    // load, so give it the vision inference timeout as the request timeout too.
    this.ollama = new OllamaClient(undefined, cfg.inferenceTimeoutMs);
    this.semaphore = new Semaphore(cfg.maxConcurrentInferences);
  }

  get activeInferences(): number {
    return this.semaphore.inFlight;
  }

  /** Refresh the installed-model list (best-effort; failures leave it empty). */
  async loadModelList(): Promise<string[]> {
    try {
      this.availableModels = await this.ollama.listModels();
      this.modelsLoaded = true;
    } catch {
      this.availableModels = [];
      this.modelsLoaded = false;
    }
    return this.availableModels;
  }

  /** Is the configured (or given) vision model installed? 'unknown' if list unavailable. */
  isVisionModelInstalled(model?: string): boolean | 'unknown' {
    if (!this.modelsLoaded || this.availableModels.length === 0) return 'unknown';
    return this.isInstalled(model || this.cfg.visionModel, this.availableModels);
  }

  private isInstalled(model: string, available: string[]): boolean {
    if (!model) return false;
    if (available.includes(model)) return true;
    if (!model.includes(':')) return available.some((a) => a === model || a.startsWith(`${model}:`));
    return false;
  }

  /**
   * Resolve the model to send, enforcing installed + VRAM rules. Never silently
   * swaps to a non-vision model — if the requested vision model is missing we
   * throw a clear, actionable error (a text model would just hallucinate).
   */
  private resolveModel(requested?: string): string {
    const model = (requested && requested.trim()) || this.cfg.visionModel;

    if (this.modelsLoaded && this.availableModels.length > 0 && !this.isInstalled(model, this.availableModels)) {
      throw new VisionError(
        'VISION_MODEL_NOT_INSTALLED',
        `Vision model "${model}" is not installed on Ollama. Run: ollama pull ${model}`,
        503,
        { model, available: this.availableModels }
      );
    }

    if (this.cfg.enforceVramBudget) {
      const llmCfg = getLlmConfig();
      if (isOversized(model, llmCfg)) {
        throw new VisionError(
          'VISION_MODEL_OVERSIZED',
          `Vision model "${model}" (~${estimateTotalVramMb(model, llmCfg)}MB) exceeds the VRAM budget ` +
            `(${llmCfg.vramBudgetMb}MB) and would offload to CPU. Choose a smaller vision model ` +
            `or raise DINA_VRAM_BUDGET_MB / disable DINA_VISION_ENFORCE_VRAM.`,
          503,
          { model, estimatedMb: estimateTotalVramMb(model, llmCfg), budgetMb: llmCfg.vramBudgetMb }
        );
      }
    }

    return model;
  }

  /**
   * TEXT-ONLY generation (no images) — used for the video temporal synthesis
   * step, which reasons over per-frame descriptions rather than pixels. Shares
   * the same concurrency semaphore so synthesis can't bypass the GPU budget.
   * The model here is a normal text model and is NOT vision-installed-checked.
   */
  async generateText(
    prompt: string,
    model: string,
    opts: { system?: string; maxTokens?: number; temperature?: number } = {}
  ): Promise<VisionInferenceResult> {
    const release = await this.semaphore.acquire();
    const started = Date.now();
    try {
      const res = await this.ollama.generate(prompt, model, {
        system: opts.system,
        maxTokens: opts.maxTokens ?? this.cfg.maxTokens,
        temperature: opts.temperature ?? this.cfg.temperature,
      });
      return {
        text: res.response || '',
        model,
        promptEvalCount: res.prompt_eval_count || 0,
        evalCount: res.eval_count || 0,
        durationMs: res.total_duration ? Math.round(res.total_duration / 1e6) : Date.now() - started,
      };
    } catch (err: any) {
      throw new VisionError('SYNTHESIS_FAILED', `Text synthesis failed: ${err?.message || err}`, 502, { model });
    } finally {
      release();
    }
  }

  /** Run one multimodal inference. Concurrency-bounded and fully guarded. */
  async infer(req: VisionInferenceRequest): Promise<VisionInferenceResult> {
    if (!req.images || req.images.length === 0) {
      throw new VisionError('NO_IMAGES', 'Vision inference requires at least one image', 400);
    }
    const model = this.resolveModel(req.model);

    const release = await this.semaphore.acquire();
    const started = Date.now();
    try {
      const res = await this.ollama.generate(req.prompt, model, {
        system: req.system,
        images: req.images,
        maxTokens: req.maxTokens ?? this.cfg.maxTokens,
        temperature: req.temperature ?? this.cfg.temperature,
      });
      return {
        text: res.response || '',
        model,
        promptEvalCount: res.prompt_eval_count || 0,
        evalCount: res.eval_count || 0,
        durationMs: res.total_duration ? Math.round(res.total_duration / 1e6) : Date.now() - started,
      };
    } catch (err: any) {
      if (err instanceof VisionError) throw err;
      throw new VisionError('INFERENCE_FAILED', `Vision inference failed: ${err?.message || err}`, 502, { model });
    } finally {
      release();
    }
  }
}
