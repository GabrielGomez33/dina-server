// File: src/modules/vision/types.ts
// ============================================================================
// DINA VISION — SHARED TYPES
// ============================================================================
// The canonical vocabulary for the vision subsystem. Kept dependency-free so
// every layer (guard, ingestion, analysis, storage, orchestrator) shares one
// definition and the tests can import types without pulling in I/O.
// ============================================================================

/** The visual task the caller wants performed. */
export type VisionTask =
  | 'describe' // rich natural-language caption
  | 'caption' // one short sentence
  | 'objects' // enumerate salient objects/entities
  | 'ocr' // read text visible in the image
  | 'tags' // keyword/label extraction
  | 'vqa' // visual question answering (requires `question`)
  | 'full'; // caption + objects + tags + ocr + colours in one structured pass

export const VISION_TASKS: readonly VisionTask[] = [
  'describe',
  'caption',
  'objects',
  'ocr',
  'tags',
  'vqa',
  'full',
] as const;

/** Runtime guard: is `x` one of the supported vision tasks? (pure) */
export function isVisionTask(x: unknown): x is VisionTask {
  return typeof x === 'string' && (VISION_TASKS as readonly string[]).includes(x);
}

/** The kind of media a caller is submitting. 'auto' = infer from the payload. */
export type MediaKind = 'image' | 'video' | 'auto';

export const MEDIA_KINDS: readonly MediaKind[] = ['image', 'video', 'auto'] as const;

/** Runtime guard for MediaKind (pure). */
export function isMediaKind(x: unknown): x is MediaKind {
  return typeof x === 'string' && (MEDIA_KINDS as readonly string[]).includes(x);
}

/** How the caller delivered the pixels. Exactly one must be provided. */
export interface RawImageInput {
  /** Base64-encoded image bytes. May be a bare base64 string or a data: URI. */
  base64?: string;
  /** Raw bytes (e.g. from a Buffer). Mutually exclusive with base64/url. */
  bytes?: Buffer | Uint8Array;
  /** Remote https URL — only honoured when DINA_VISION_ALLOW_REMOTE=true. */
  url?: string;
  /** Optional caller-declared MIME (advisory only; verified against magic bytes). */
  mimeType?: string;
  /** Optional caller-supplied filename (advisory; used for logs only). */
  filename?: string;
}

/** A validated, normalized still image ready for inference. */
export interface NormalizedImage {
  /** Bare base64 (no data-URI prefix) — the exact form Ollama's `images` wants. */
  base64: string;
  /** MIME type resolved from MAGIC BYTES (never the caller's claim). */
  mimeType: string;
  /** Decoded byte length. */
  byteLength: number;
  /** sha256 of the raw bytes — used for dedup + cache keys. */
  sha256: string;
  /** Pixel dimensions when they could be probed from the header, else null. */
  width: number | null;
  height: number | null;
}

/** A single video frame plus where it sits on the timeline. */
export interface VideoFrameInput {
  /** Base64 image bytes (bare or data URI) for this frame. */
  base64?: string;
  bytes?: Buffer | Uint8Array;
  /** Timestamp of this frame within the source video, in seconds. */
  timestampSec?: number;
  /** Optional ordinal index; inferred from array position when absent. */
  index?: number;
}

/** Caller's video request: either pre-extracted frames, or bytes to extract from. */
export interface RawVideoInput {
  /** Pre-extracted frames (preferred — needs no ffmpeg). */
  frames?: VideoFrameInput[];
  /** Full-video base64/bytes — only usable when an ffmpeg path is configured. */
  base64?: string;
  bytes?: Buffer | Uint8Array;
  /** Advisory container MIME (e.g. video/mp4). */
  mimeType?: string;
  filename?: string;
  /** Duration hint (seconds) used for even timestamp spacing when unknown. */
  durationSec?: number;
}

/** Colour observed in an image, as reported by the model. */
export interface DetectedColor {
  name: string;
  approxHex?: string;
}

/** Structured result of analysing a single still image. */
export interface ImageAnalysis {
  task: VisionTask;
  /** The model's primary natural-language description. */
  caption: string;
  /** Salient objects / entities the model reports seeing. */
  objects: string[];
  /** Keyword tags/labels. */
  tags: string[];
  /** Text read off the image (OCR), empty when none/none-requested. */
  text: string;
  /** Dominant colours, when reported. */
  colors: DetectedColor[];
  /** For 'vqa': the answer to `question`. */
  answer?: string;
  /** Model's self-reported safety observation ('safe' | 'sensitive' | 'unknown'). */
  safety: 'safe' | 'sensitive' | 'unknown';
  /** Confidence in [0,1] — derived heuristically, never fabricated as precise. */
  confidence: number;
  /** The raw model text, retained for auditing/debugging. */
  raw: string;
}

/** Analysis of one frame in a video job. */
export interface FrameAnalysis {
  index: number;
  timestampSec: number | null;
  analysis: ImageAnalysis;
}

/** Structured result of analysing a video (sequence of frames + temporal synthesis). */
export interface VideoAnalysis {
  /** The task that was applied to every frame + the aggregation. */
  task: VisionTask;
  /** Number of frames actually analysed. */
  frameCount: number;
  /** Per-frame results in timeline order. */
  frames: FrameAnalysis[];
  /** Whole-video narrative synthesised across the frames. */
  summary: string;
  /** Ordered timeline of notable moments/scene changes. */
  timeline: Array<{ timestampSec: number | null; description: string }>;
  /** Union of salient objects seen across frames. */
  objects: string[];
  /** Union of tags across frames. */
  tags: string[];
  /** For task 'ocr': all text read across the video, de-duplicated. */
  text?: string;
  /** For task 'vqa': a single answer synthesised across the frames. */
  answer?: string;
  /** Confidence in [0,1]. */
  confidence: number;
}

/** Options accepted by the orchestrator's analyze* methods. */
export interface AnalyzeOptions {
  task?: VisionTask;
  /** Required when task === 'vqa'. */
  question?: string;
  /** Skip cache read/write for this call. */
  forceRefresh?: boolean;
  /** Override the configured vision model (still VRAM-guarded). */
  model?: string;
  /** Identity for storage/audit. */
  userId?: string;
  /**
   * Video only: cap the number of frames analysed for THIS call. Clamped to
   * [1, config.maxVideoFrames]; when absent the config default is used. Lets a
   * caller trade depth for latency without a config change.
   */
  maxFrames?: number;
}

/** What analyzeImage returns to the orchestrator's callers. */
export interface ImageAnalysisResult {
  mediaId: string;
  sha256: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  task: VisionTask;
  analysis: ImageAnalysis;
  model: string;
  cached: boolean;
  processingTimeMs: number;
  generatedAt: string;
}

/** What analyzeVideo returns. */
export interface VideoAnalysisResult {
  mediaId: string;
  frameCount: number;
  task: VisionTask;
  analysis: VideoAnalysis;
  model: string;
  cached: boolean;
  processingTimeMs: number;
  generatedAt: string;
}

/** Health/status snapshot for the subsystem. */
export interface VisionStatus {
  enabled: boolean;
  initialized: boolean;
  visionModel: string;
  visionModelInstalled: boolean | 'unknown';
  synthesisModel: string;
  videoEnabled: boolean;
  persistenceEnabled: boolean;
  allowRemote: boolean;
  activeInferences: number;
  advisories: string[];
}

/** A typed error the vision subsystem raises for caller-facing failures. */
export class VisionError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  public readonly details?: Record<string, any>;
  constructor(code: string, message: string, httpStatus = 400, details?: Record<string, any>) {
    super(message);
    this.name = 'VisionError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}
