// File: src/modules/vision/analysis/imageAnalyzer.ts
// ============================================================================
// IMAGE ANALYZER
// ============================================================================
// Orchestrates a single still-image understanding pass: pick the prompt for the
// task, run one multimodal inference, and parse the model's text into a typed
// ImageAnalysis. Stateless and side-effect-free apart from the model call, so
// the orchestrator can layer caching/storage around it cleanly.
// ============================================================================

import { VisionModelClient } from '../ollama/visionModel';
import { buildPrompt, VISION_SYSTEM_PROMPT } from './promptTemplates';
import { parseFullAnalysis, parseSingleTask } from './structuredParser';
import { ImageAnalysis, NormalizedImage, VisionTask, VisionError } from '../types';

export class ImageAnalyzer {
  constructor(private readonly model: VisionModelClient) {}

  /**
   * Analyse one normalized image for the given task.
   * @param image  validated image (already through the guard)
   * @param task   the visual task
   * @param opts   question (for VQA), model override
   */
  async analyze(
    image: NormalizedImage,
    task: VisionTask,
    opts: { question?: string; model?: string } = {}
  ): Promise<ImageAnalysis> {
    if (task === 'vqa' && (!opts.question || opts.question.trim().length === 0)) {
      throw new VisionError('MISSING_QUESTION', 'Task "vqa" requires a non-empty question', 400);
    }

    const prompt = buildPrompt(task, opts.question);
    const result = await this.model.infer({
      prompt,
      system: VISION_SYSTEM_PROMPT,
      images: [image.base64],
      model: opts.model,
    });

    if (task === 'full') {
      return parseFullAnalysis(result.text, 'full');
    }
    return parseSingleTask(task, result.text, opts.question);
  }
}
