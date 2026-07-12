// File: src/modules/vision/analysis/videoAnalyzer.ts
// ============================================================================
// VIDEO ANALYZER
// ============================================================================
// A video is just a series of images, so analysing one = analysing each sampled
// frame with the SAME task the caller asked for, then AGGREGATING the per-frame
// results across time. The task drives both halves:
//
//   task            per-frame call     aggregation
//   ─────────────   ───────────────    ─────────────────────────────────────────
//   describe/full/  'full'             temporal narrative (text model) + object/
//   caption/objects/                   tag union + timeline
//   tags
//   ocr             'ocr'              de-duplicated transcript + text timeline
//   vqa             'vqa' (+question)  one reconciled answer (text model)
//
// Robustness: every per-frame call is ISOLATED — one frame failing (transient
// model error) degrades to a marker instead of sinking the whole video. The
// cross-frame synthesis is best-effort with a deterministic fallback, so a
// synthesis failure never fails the request.
// ============================================================================

import { VisionModelClient } from '../ollama/visionModel';
import { ImageAnalyzer } from './imageAnalyzer';
import { buildVideoSynthesisPrompt, buildVideoAnswerPrompt } from './promptTemplates';
import { unionStrings, aggregateOcr, meanConfidence } from './videoAggregation';
import { NormalizedFrame } from '../ingestion/videoIngestor';
import { FrameAnalysis, VideoAnalysis, VisionTask, VisionError } from '../types';

export interface VideoAnalyzeOptions {
  task: VisionTask;
  question?: string;
  frameConcurrency: number;
  synthesisModel: string;
  model?: string;
}

/** Run tasks with a fixed concurrency cap, preserving input order in the output. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(Math.max(1, limit), items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export class VideoAnalyzer {
  constructor(
    private readonly model: VisionModelClient,
    private readonly imageAnalyzer: ImageAnalyzer
  ) {}

  async analyze(frames: NormalizedFrame[], opts: VideoAnalyzeOptions): Promise<VideoAnalysis> {
    if (!frames || frames.length === 0) {
      throw new VisionError('NO_FRAMES', 'Video analysis requires at least one frame', 400);
    }
    const task = opts.task;
    if (task === 'vqa' && (!opts.question || opts.question.trim().length === 0)) {
      throw new VisionError('MISSING_QUESTION', 'Video task "vqa" requires a non-empty question', 400);
    }

    // Each frame is analysed with the per-frame task best suited to the request.
    // For the description-family tasks we use 'full' so we also collect
    // objects/tags/colours for aggregation; ocr/vqa use their own task.
    const perFrameTask: VisionTask = task === 'ocr' ? 'ocr' : task === 'vqa' ? 'vqa' : 'full';

    // ---- 1. Per-frame analysis (bounded concurrency, isolated failures) ----
    const frameAnalyses: FrameAnalysis[] = await mapWithConcurrency(
      frames,
      opts.frameConcurrency,
      async (frame): Promise<FrameAnalysis> => {
        try {
          const analysis = await this.imageAnalyzer.analyze(frame.image, perFrameTask, {
            question: opts.question,
            model: opts.model,
          });
          return { index: frame.index, timestampSec: frame.timestampSec, analysis };
        } catch (err: any) {
          return {
            index: frame.index,
            timestampSec: frame.timestampSec,
            analysis: {
              task: perFrameTask,
              caption: `[frame analysis failed: ${err?.message || 'unknown error'}]`,
              objects: [],
              tags: [],
              text: '',
              colors: [],
              safety: 'unknown',
              confidence: 0.1,
              raw: '',
            },
          };
        }
      }
    );

    const confidence = meanConfidence(frameAnalyses.map((f) => f.analysis.confidence));

    // ---- 2. Task-specific aggregation ----
    if (task === 'ocr') {
      return this.aggregateOcrTask(task, frameAnalyses, confidence);
    }
    if (task === 'vqa') {
      return this.aggregateVqaTask(task, opts.question!, frameAnalyses, opts.synthesisModel, confidence);
    }
    return this.aggregateDescribeTask(task, frameAnalyses, opts.synthesisModel, confidence);
  }

  // ---- OCR: de-duplicated transcript + text timeline ----
  private aggregateOcrTask(task: VisionTask, frames: FrameAnalysis[], confidence: number): VideoAnalysis {
    const { text, timeline } = aggregateOcr(
      frames.map((f) => ({ timestampSec: f.timestampSec, text: f.analysis.text || '' }))
    );
    const summary = text
      ? `Text read from ${timeline.length} of ${frames.length} sampled frame(s).`
      : 'No legible text detected in the sampled frames.';
    return {
      task,
      frameCount: frames.length,
      frames,
      summary,
      timeline,
      objects: [],
      tags: [],
      text,
      confidence,
    };
  }

  // ---- VQA: reconcile per-frame answers into one ----
  private async aggregateVqaTask(
    task: VisionTask,
    question: string,
    frames: FrameAnalysis[],
    synthesisModel: string,
    confidence: number
  ): Promise<VideoAnalysis> {
    const perFrameAnswers = frames.map((f) => (f.analysis.answer || f.analysis.caption || '').trim());
    let answer: string;
    try {
      const prompt = buildVideoAnswerPrompt(question, perFrameAnswers.map((a) => a || '(no answer)'));
      const res = await this.model.generateText(prompt, synthesisModel);
      answer = res.text.trim();
    } catch {
      // Fallback: surface the distinct frame answers.
      answer = unionStrings(perFrameAnswers.filter(Boolean)).join(' ');
    }
    const timeline = frames.map((f) => ({
      timestampSec: f.timestampSec,
      description: (f.analysis.answer || f.analysis.caption || '').trim(),
    }));
    return {
      task,
      frameCount: frames.length,
      frames,
      summary: answer,
      timeline,
      objects: [],
      tags: [],
      answer,
      confidence,
    };
  }

  // ---- describe / caption / full / objects / tags: temporal narrative ----
  private async aggregateDescribeTask(
    task: VisionTask,
    frames: FrameAnalysis[],
    synthesisModel: string,
    confidence: number
  ): Promise<VideoAnalysis> {
    const objects = unionStrings(frames.flatMap((f) => f.analysis.objects));
    const tags = unionStrings(frames.flatMap((f) => f.analysis.tags));
    const descriptions = frames.map((f) => f.analysis.caption || '(no description)');

    let summary = '';
    let timeline: Array<{ timestampSec: number | null; description: string }> = [];
    try {
      const synthesis = await this.synthesize(descriptions, synthesisModel);
      summary = synthesis.summary;
      timeline = this.buildTimeline(frames, synthesis.timelineLines);
    } catch {
      summary = descriptions.filter(Boolean).join(' ');
      timeline = frames.map((f) => ({ timestampSec: f.timestampSec, description: f.analysis.caption }));
    }

    return { task, frameCount: frames.length, frames, summary, timeline, objects, tags, confidence };
  }

  /** Call the text model to synthesise per-frame descriptions into a narrative. */
  private async synthesize(
    descriptions: string[],
    synthesisModel: string
  ): Promise<{ summary: string; timelineLines: string[] }> {
    const prompt = buildVideoSynthesisPrompt(descriptions);
    const res = await this.model.generateText(prompt, synthesisModel);
    return this.splitSynthesis(res.text);
  }

  private splitSynthesis(text: string): { summary: string; timelineLines: string[] } {
    const idx = text.search(/TIMELINE:/i);
    if (idx === -1) return { summary: text.trim(), timelineLines: [] };
    const summary = text.slice(0, idx).trim();
    const timelineBlock = text.slice(idx + 'TIMELINE:'.length);
    const timelineLines = timelineBlock
      .split('\n')
      .map((l) => l.replace(/^[\s*\-•]+/, '').trim())
      .filter((l) => l.length > 0);
    return { summary, timelineLines };
  }

  private buildTimeline(
    frames: FrameAnalysis[],
    lines: string[]
  ): Array<{ timestampSec: number | null; description: string }> {
    if (lines.length > 0) {
      return lines.map((description, i) => ({
        timestampSec: frames[i]?.timestampSec ?? null,
        description,
      }));
    }
    return frames.map((f) => ({ timestampSec: f.timestampSec, description: f.analysis.caption }));
  }
}
