// File: src/modules/vision/visionOrchestrator.ts
// ============================================================================
// VISION ORCHESTRATOR
// ============================================================================
// The public facade for DINA's visual perception. It ties ingestion → analysis
// → storage together and exposes a small, stable surface the DINA core routes
// to. It mirrors the DIGIM WebResearchOrchestrator lifecycle exactly:
//
//   • Construction is cheap and I/O-free (safe to build unconditionally).
//   • `enabled` reads straight off the frozen config.
//   • `initialize()` short-circuits when disabled — a disabled deploy pays zero
//     cost and cannot disrupt anything.
//   • Every public operation calls `assertEnabled()` first.
//   • Failures degrade (storage/model-list) rather than crash the process.
// ============================================================================

import { performance } from 'perf_hooks';
import { randomUUID } from 'crypto';
import { getVisionConfig, VisionRuntimeConfig } from './config/visionConfig';
import { VisionModelClient } from './ollama/visionModel';
import { ImageAnalyzer } from './analysis/imageAnalyzer';
import { VideoAnalyzer } from './analysis/videoAnalyzer';
import { ingestImage } from './ingestion/imageIngestor';
import { ingestVideo } from './ingestion/videoIngestor';
import { VisionStore } from './storage/visionStore';
import {
  AnalyzeOptions,
  ImageAnalysisResult,
  RawImageInput,
  RawVideoInput,
  VideoAnalysisResult,
  VisionStatus,
  VisionTask,
  VisionError,
  VISION_TASKS,
  isVisionTask,
} from './types';

export class VisionOrchestrator {
  private readonly model: VisionModelClient;
  private readonly imageAnalyzer: ImageAnalyzer;
  private readonly videoAnalyzer: VideoAnalyzer;
  private readonly store: VisionStore;
  private initialized = false;

  constructor(private readonly cfg: VisionRuntimeConfig = getVisionConfig()) {
    // Cheap, no I/O. Only real work happens in initialize() when enabled.
    this.model = new VisionModelClient(cfg);
    this.imageAnalyzer = new ImageAnalyzer(this.model);
    this.videoAnalyzer = new VideoAnalyzer(this.model, this.imageAnalyzer);
    this.store = new VisionStore(cfg);
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  /** Idempotent, non-fatal init. No-ops entirely when the subsystem is disabled. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.cfg.enabled) {
      console.log('👁️ [vision] Disabled — initialize() is a no-op (set DINA_VISION_ENABLED=true).');
      return;
    }
    try {
      await this.store.initSchema();
      await this.model.loadModelList();
      const installed = this.model.isVisionModelInstalled();
      if (installed === false) {
        console.warn(
          `⚠️ [vision] Configured vision model "${this.cfg.visionModel}" is NOT installed. ` +
            `Run: ollama pull ${this.cfg.visionModel}`
        );
      }
      this.initialized = true;
      console.log(`✅ [vision] Initialized (model=${this.cfg.visionModel}, installed=${installed}).`);
    } catch (err) {
      // Never let vision break DINA startup — degrade to "enabled but not ready".
      this.initialized = false;
      console.warn(`⚠️ [vision] Initialization degraded (continuing): ${(err as Error).message}`);
    }
  }

  private assertEnabled(): void {
    if (!this.cfg.enabled) {
      throw new VisionError('VISION_DISABLED', 'DINA Vision is disabled (set DINA_VISION_ENABLED=true to enable)', 403);
    }
  }

  /**
   * Resolve + VALIDATE the requested task. An unknown task is rejected with a
   * helpful error listing the allowed values rather than silently defaulting —
   * fail loud on bad input, don't guess.
   */
  private resolveTask(task?: VisionTask | string): VisionTask {
    if (task === undefined || task === null || task === '') return 'full';
    if (!isVisionTask(task)) {
      throw new VisionError(
        'INVALID_TASK',
        `Unknown task "${task}". Allowed: ${VISION_TASKS.join(', ')}`,
        400,
        { allowed: VISION_TASKS }
      );
    }
    return task;
  }

  // ------------------------------------------------------------------
  // IMAGE
  // ------------------------------------------------------------------

  async analyzeImage(input: RawImageInput, opts: AnalyzeOptions = {}): Promise<ImageAnalysisResult> {
    this.assertEnabled();
    const started = performance.now();
    const task = this.resolveTask(opts.task);

    // 1. Ingest + validate (throws VisionError on any unsafe/invalid input).
    const image = await ingestImage(input, this.cfg);
    const model = (opts.model && opts.model.trim()) || this.cfg.visionModel;

    // 2. Cache: same bytes + same task + same model → reuse.
    if (!opts.forceRefresh && task !== 'vqa') {
      const cached = await this.store.getCachedImage(image.sha256, task, model);
      if (cached) {
        return { ...cached, cached: true, processingTimeMs: Math.round(performance.now() - started) };
      }
    }

    // 3. Analyse.
    const analysis = await this.imageAnalyzer.analyze(image, task, { question: opts.question, model });

    // 4. Persist (best-effort) + assemble result.
    const mediaId = await this.store.recordMedia({
      id: randomUUID(),
      sha256: image.sha256,
      mediaType: 'image',
      mimeType: image.mimeType,
      byteLength: image.byteLength,
      width: image.width,
      height: image.height,
      userId: opts.userId,
    });

    const result: ImageAnalysisResult = {
      mediaId,
      sha256: image.sha256,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      task,
      analysis,
      model,
      cached: false,
      processingTimeMs: Math.round(performance.now() - started),
      generatedAt: new Date().toISOString(),
    };

    await this.store.recordImageAnalysis(randomUUID(), result, opts.userId);
    // VQA answers are question-specific; don't pollute the content cache with them.
    if (task !== 'vqa') await this.store.cacheImage(result);

    return result;
  }

  // ------------------------------------------------------------------
  // VIDEO
  // ------------------------------------------------------------------

  async analyzeVideo(input: RawVideoInput, opts: AnalyzeOptions = {}): Promise<VideoAnalysisResult> {
    this.assertEnabled();
    if (!this.cfg.videoEnabled) {
      throw new VisionError('VIDEO_DISABLED', 'Video analysis is disabled (set DINA_VISION_VIDEO_ENABLED=true)', 403);
    }
    const started = performance.now();
    const task = this.resolveTask(opts.task);
    const model = (opts.model && opts.model.trim()) || this.cfg.visionModel;

    // 'vqa' over a video needs a question, same as an image.
    if (task === 'vqa' && (!opts.question || opts.question.trim().length === 0)) {
      throw new VisionError('MISSING_QUESTION', 'Task "vqa" requires a non-empty question', 400);
    }

    // 1. Ingest → bounded, validated, timeline-ordered frames (per-call frame cap).
    const frames = await ingestVideo(input, this.cfg, { maxFrames: opts.maxFrames });

    // 2. Analyse each frame with the requested task + aggregate across time.
    const analysis = await this.videoAnalyzer.analyze(frames, {
      task,
      question: opts.question,
      frameConcurrency: this.cfg.frameConcurrency,
      synthesisModel: this.cfg.synthesisModel,
      model,
    });

    // 3. Persist (best-effort) + assemble.
    const mediaId = await this.store.recordMedia({
      id: randomUUID(),
      sha256: randomUUID().replace(/-/g, ''), // videos have no single content hash
      mediaType: 'video',
      mimeType: input.mimeType,
      frameCount: analysis.frameCount,
      userId: opts.userId,
    });

    const result: VideoAnalysisResult = {
      mediaId,
      frameCount: analysis.frameCount,
      task,
      analysis,
      model,
      cached: false,
      processingTimeMs: Math.round(performance.now() - started),
      generatedAt: new Date().toISOString(),
    };

    await this.store.recordVideoAnalysis(randomUUID(), result, opts.userId);
    return result;
  }

  // ------------------------------------------------------------------
  // CONVENIENCE WRAPPERS (thin, task-fixed)
  // ------------------------------------------------------------------

  async describe(input: RawImageInput, opts: AnalyzeOptions = {}): Promise<ImageAnalysisResult> {
    return this.analyzeImage(input, { ...opts, task: 'describe' });
  }

  async ocr(input: RawImageInput, opts: AnalyzeOptions = {}): Promise<ImageAnalysisResult> {
    return this.analyzeImage(input, { ...opts, task: 'ocr' });
  }

  async ask(input: RawImageInput, question: string, opts: AnalyzeOptions = {}): Promise<ImageAnalysisResult> {
    return this.analyzeImage(input, { ...opts, task: 'vqa', question });
  }

  // ------------------------------------------------------------------
  // STATUS / LIFECYCLE
  // ------------------------------------------------------------------

  getStatus(): VisionStatus {
    const advisories: string[] = [];
    const installed = this.model.isVisionModelInstalled();
    if (!this.cfg.enabled) {
      advisories.push('Vision is disabled. Set DINA_VISION_ENABLED=true to activate.');
    } else if (installed === false) {
      advisories.push(`Vision model "${this.cfg.visionModel}" is not installed. Run: ollama pull ${this.cfg.visionModel}`);
    } else if (installed === 'unknown') {
      advisories.push('Vision model install state is unknown (Ollama model list unavailable).');
    } else {
      advisories.push('Vision subsystem nominal.');
    }

    return {
      enabled: this.cfg.enabled,
      initialized: this.initialized,
      visionModel: this.cfg.visionModel,
      visionModelInstalled: installed,
      synthesisModel: this.cfg.synthesisModel,
      videoEnabled: this.cfg.videoEnabled,
      persistenceEnabled: this.cfg.persistenceEnabled,
      allowRemote: this.cfg.allowRemote,
      activeInferences: this.model.activeInferences,
      advisories,
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; status: VisionStatus }> {
    const status = this.getStatus();
    // "Healthy" = disabled (intentionally inert) OR enabled+initialized.
    const healthy = !this.cfg.enabled || this.initialized;
    return { healthy, status };
  }

  async prune(): Promise<{ deleted: number }> {
    this.assertEnabled();
    return this.store.pruneOld();
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    console.log('👁️ [vision] Shutdown complete.');
  }
}
