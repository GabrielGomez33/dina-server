// File: src/modules/vision/ingestion/videoIngestor.ts
// ============================================================================
// VIDEO INGESTOR
// ============================================================================
// A video is, to a program, an ordered sequence of images (frames) sampled over
// time. DINA "sees" a video by analysing a bounded set of representative frames
// and reasoning about how they change. This ingestor produces that bounded set.
//
// Two acquisition paths, in priority order:
//   1. CLIENT-SUPPLIED FRAMES (preferred, no dependency) — the caller sends an
//      array of frame images with timestamps. DINA validates + samples them.
//   2. SERVER-SIDE EXTRACTION (optional) — only when DINA_VISION_FFMPEG_PATH is
//      configured AND the binary exists. DINA shells out to ffmpeg to pull
//      frames from the raw video. Absent that, raw-video input is refused with a
//      clear message rather than silently doing nothing.
//
// Frame sampling is a pure, deterministic function (uniform coverage of the
// timeline) so it is unit-tested directly with no I/O.
// ============================================================================

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getVisionConfig, VisionRuntimeConfig } from '../config/visionConfig';
import { validateImageBuffer, decodeBase64Image } from '../security/imageGuard';
import { toBuffer } from './imageIngestor';
import { NormalizedImage, RawVideoInput, VideoFrameInput, VisionError } from '../types';

/** A validated frame ready for analysis, carrying its place on the timeline. */
export interface NormalizedFrame {
  image: NormalizedImage;
  index: number;
  timestampSec: number | null;
}

/**
 * PURE: choose up to `max` evenly-spaced indices out of `total` items so the
 * sampled frames cover the whole timeline rather than clustering at the start.
 *
 * Examples:
 *   sampleFrameIndices(10, 4) -> [0, 3, 6, 9]
 *   sampleFrameIndices(3, 5)  -> [0, 1, 2]   (fewer items than the cap)
 *   sampleFrameIndices(1, 4)  -> [0]
 *   sampleFrameIndices(0, 4)  -> []
 */
export function sampleFrameIndices(total: number, max: number): number[] {
  if (!Number.isFinite(total) || total <= 0) return [];
  if (!Number.isFinite(max) || max <= 0) return [];
  const t = Math.floor(total);
  const m = Math.floor(max);
  if (t <= m) return Array.from({ length: t }, (_, i) => i);
  if (m === 1) return [0];

  const indices: number[] = [];
  // Spread m picks across [0, t-1] inclusive of both ends.
  const step = (t - 1) / (m - 1);
  for (let i = 0; i < m; i++) {
    indices.push(Math.round(i * step));
  }
  // De-dupe in the rare rounding-collision case while preserving order.
  return Array.from(new Set(indices));
}

/**
 * Normalize a video request into a bounded, validated, timeline-ordered set of
 * frames. Enforces the frame cap, per-frame image guard, and total byte cap.
 */
export async function ingestVideo(
  input: RawVideoInput,
  cfg: VisionRuntimeConfig = getVisionConfig(),
  opts: { maxFrames?: number } = {}
): Promise<NormalizedFrame[]> {
  if (!cfg.videoEnabled) {
    throw new VisionError('VIDEO_DISABLED', 'Video analysis is disabled (set DINA_VISION_VIDEO_ENABLED=true)', 403);
  }
  if (!input || typeof input !== 'object') {
    throw new VisionError('INVALID_INPUT', 'Video input must be an object', 400);
  }

  // Per-call frame budget, always clamped to the config ceiling so a caller can
  // ask for FEWER frames (faster) but never more than the operator allows.
  const effectiveMax = clampFrames(opts.maxFrames, cfg.maxVideoFrames);

  // Path 1: caller supplied frames.
  if (Array.isArray(input.frames) && input.frames.length > 0) {
    return normalizeSuppliedFrames(input.frames, input.durationSec, cfg, effectiveMax);
  }

  // Path 2: raw video → ffmpeg extraction (only if configured).
  if (input.base64 != null || input.bytes != null) {
    if (!cfg.ffmpegPath) {
      throw new VisionError(
        'FFMPEG_UNAVAILABLE',
        'Raw video was supplied but no ffmpeg is configured. Send pre-extracted frames, or set DINA_VISION_FFMPEG_PATH.',
        400
      );
    }
    return extractFramesWithFfmpeg(input, cfg, effectiveMax);
  }

  throw new VisionError('NO_VIDEO_SOURCE', 'Provide either "frames" (preferred) or raw video "base64"/"bytes".', 400);
}

/** Clamp a requested frame budget to [1, ceiling]; fall back to ceiling when unset/invalid. */
export function clampFrames(requested: number | undefined, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return ceiling;
  return Math.min(Math.max(1, Math.floor(requested)), ceiling);
}

/** Validate + sample caller-supplied frames. */
async function normalizeSuppliedFrames(
  frames: VideoFrameInput[],
  durationSec: number | undefined,
  cfg: VisionRuntimeConfig,
  maxFrames: number
): Promise<NormalizedFrame[]> {
  const picks = sampleFrameIndices(frames.length, maxFrames);
  const out: NormalizedFrame[] = [];
  let totalBytes = 0;

  for (const pick of picks) {
    const frame = frames[pick];
    if (!frame || (frame.base64 == null && frame.bytes == null)) {
      throw new VisionError('INVALID_FRAME', `Frame ${pick} has no base64/bytes payload`, 400);
    }
    const buf = frame.base64 != null ? decodeBase64Image(frame.base64, cfg) : toBuffer(frame.bytes!);
    const image = validateImageBuffer(buf, cfg);

    totalBytes += image.byteLength;
    if (totalBytes > cfg.maxVideoBytes) {
      throw new VisionError('VIDEO_TOO_LARGE', `Frames exceed the ${cfg.maxVideoBytes}-byte total limit`, 413);
    }

    const timestampSec =
      typeof frame.timestampSec === 'number' && Number.isFinite(frame.timestampSec)
        ? frame.timestampSec
        : inferTimestamp(pick, frames.length, durationSec);

    out.push({ image, index: pick, timestampSec });
  }

  return out;
}

/** Best-effort even-spacing timestamp when the caller didn't provide one. */
function inferTimestamp(index: number, total: number, durationSec?: number): number | null {
  if (!durationSec || total <= 1) return null;
  return Number(((index / (total - 1)) * durationSec).toFixed(3));
}

/**
 * Extract frames from a raw video using a configured ffmpeg binary. Writes the
 * video to a private temp dir, samples at the configured fps (capped at the
 * frame limit), reads the JPEGs back, then cleans up. Fully bounded and always
 * removes its temp dir.
 */
async function extractFramesWithFfmpeg(
  input: RawVideoInput,
  cfg: VisionRuntimeConfig,
  maxFrames: number
): Promise<NormalizedFrame[]> {
  const videoBuf = input.base64 != null ? Buffer.from(stripDataUri(input.base64), 'base64') : toBuffer(input.bytes!);
  if (videoBuf.length === 0) {
    throw new VisionError('EMPTY_VIDEO', 'Video payload is empty', 400);
  }
  if (videoBuf.length > cfg.maxVideoBytes) {
    throw new VisionError('VIDEO_TOO_LARGE', `Video is ${videoBuf.length} bytes (> limit)`, 413);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dina-vision-'));
  const inPath = path.join(workDir, 'in.bin');
  const pattern = path.join(workDir, 'frame-%04d.jpg');

  try {
    await fs.writeFile(inPath, videoBuf);

    // -vf fps=<rate> samples evenly; -frames:v caps the count hard.
    const args = [
      '-nostdin',
      '-loglevel', 'error',
      '-i', inPath,
      '-vf', `fps=${cfg.frameSampleFps}`,
      '-frames:v', String(maxFrames),
      '-f', 'image2',
      pattern,
    ];

    await runFfmpeg(cfg.ffmpegPath, args, cfg.inferenceTimeoutMs);

    const files = (await fs.readdir(workDir))
      .filter((f) => f.startsWith('frame-') && f.endsWith('.jpg'))
      .sort();

    if (files.length === 0) {
      throw new VisionError('FRAME_EXTRACTION_EMPTY', 'ffmpeg produced no frames from the video', 422);
    }

    const out: NormalizedFrame[] = [];
    let totalBytes = 0;
    for (let i = 0; i < files.length; i++) {
      const buf = await fs.readFile(path.join(workDir, files[i]));
      const image = validateImageBuffer(buf, cfg);
      totalBytes += image.byteLength;
      if (totalBytes > cfg.maxVideoBytes) break;
      const timestampSec = cfg.frameSampleFps > 0 ? Number((i / cfg.frameSampleFps).toFixed(3)) : null;
      out.push({ image, index: i, timestampSec });
    }
    return out;
  } finally {
    // Always clean up, even on error.
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function stripDataUri(s: string): string {
  const m = /^data:[^,]*,(.*)$/is.exec(s.trim());
  return (m ? m[1] : s).replace(/\s+/g, '');
}

/** Run ffmpeg with a hard timeout; reject on non-zero exit or spawn error. */
function runFfmpeg(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new VisionError('FFMPEG_TIMEOUT', `ffmpeg timed out after ${timeoutMs}ms`, 504));
    }, timeoutMs);

    child.stderr?.on('data', (d) => {
      if (stderr.length < 4096) stderr += d.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new VisionError('FFMPEG_SPAWN_FAILED', `Could not run ffmpeg: ${err.message}`, 500));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new VisionError('FFMPEG_FAILED', `ffmpeg exited ${code}: ${stderr.slice(0, 500)}`, 422));
    });
  });
}
