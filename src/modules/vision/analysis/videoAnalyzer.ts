// File: src/modules/vision/analysis/videoAnalyzer.ts
// ============================================================================
// VIDEO ANALYZER
// ============================================================================
// A video is analysed as a bounded sequence of frames plus a temporal
// synthesis. The flow:
//   1. Analyse each sampled frame as an image (bounded concurrency).
//   2. Aggregate per-frame observations (union of objects/tags).
//   3. Ask a TEXT model to synthesise the ordered frame descriptions into one
//      narrative + a timeline — this is where "motion over time" is reasoned
//      about, since a single VLM call only sees stills.
//
// Every frame analysis is isolated: one frame failing (e.g. a transient model
// error) degrades that frame to a marker instead of failing the whole video.
// ============================================================================

import { VisionModelClient } from '../ollama/visionModel';
import { ImageAnalyzer } from './imageAnalyzer';
import { buildVideoSynthesisPrompt } from './promptTemplates';
import { NormalizedFrame } from '../ingestion/videoIngestor';
import { FrameAnalysis, VideoAnalysis, VisionError } from '../types';

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

  async analyze(
    frames: NormalizedFrame[],
    opts: { frameConcurrency: number; synthesisModel: string; model?: string } = {
      frameConcurrency: 2,
      synthesisModel: 'mistral:7b',
    }
  ): Promise<VideoAnalysis> {
    if (!frames || frames.length === 0) {
      throw new VisionError('NO_FRAMES', 'Video analysis requires at least one frame', 400);
    }

    // ---- 1. Per-frame analysis (bounded concurrency, isolated failures) ----
    const frameAnalyses: FrameAnalysis[] = await mapWithConcurrency(
      frames,
      opts.frameConcurrency,
      async (frame): Promise<FrameAnalysis> => {
        try {
          const analysis = await this.imageAnalyzer.analyze(frame.image, 'full', { model: opts.model });
          return { index: frame.index, timestampSec: frame.timestampSec, analysis };
        } catch (err: any) {
          // Isolate: a single frame failing must not sink the whole video.
          return {
            index: frame.index,
            timestampSec: frame.timestampSec,
            analysis: {
              task: 'full',
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

    // ---- 2. Aggregate observations across frames ----
    const objects = unionStrings(frameAnalyses.flatMap((f) => f.analysis.objects));
    const tags = unionStrings(frameAnalyses.flatMap((f) => f.analysis.tags));
    const avgConfidence =
      frameAnalyses.reduce((s, f) => s + (f.analysis.confidence || 0), 0) / frameAnalyses.length;

    // ---- 3. Temporal synthesis via a text model ----
    const descriptions = frameAnalyses.map((f) => f.analysis.caption || '(no description)');
    let summary = '';
    let timeline: Array<{ timestampSec: number | null; description: string }> = [];
    try {
      const synthesis = await this.synthesize(descriptions, opts.synthesisModel);
      summary = synthesis.summary;
      timeline = this.buildTimeline(frameAnalyses, synthesis.timelineLines);
    } catch {
      // Synthesis is best-effort — fall back to a concatenated summary.
      summary = descriptions.filter(Boolean).join(' ');
      timeline = frameAnalyses.map((f) => ({
        timestampSec: f.timestampSec,
        description: f.analysis.caption,
      }));
    }

    return {
      frameCount: frameAnalyses.length,
      frames: frameAnalyses,
      summary,
      timeline,
      objects,
      tags,
      confidence: Number(avgConfidence.toFixed(2)),
    };
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
      // Map synthesised lines onto frame timestamps positionally.
      return lines.map((description, i) => ({
        timestampSec: frames[i]?.timestampSec ?? null,
        description,
      }));
    }
    return frames.map((f) => ({ timestampSec: f.timestampSec, description: f.analysis.caption }));
  }
}

function unionStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(v.trim());
    }
  }
  return out.slice(0, 40);
}
