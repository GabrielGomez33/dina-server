// File: src/modules/vision/config/visionConfig.ts
// ============================================================================
// DINA VISION (DIVIS) RUNTIME CONFIGURATION (single source of truth)
// ============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// The Vision subsystem lets DINA "see": it ingests images and videos, runs a
// local multimodal (vision-language) model through Ollama, and extracts
// structured information (caption, objects, tags, colours, on-image text, and
// answers to visual questions). Every knob that governs *what it accepts*,
// *how hard it works the GPU*, and *what it is allowed to reach* lives here —
// env-driven, with conservative, safe-by-default values.
//
// This mirrors `src/modules/llm/llmConfig.ts` and
// `src/modules/digim/web/config/webConfig.ts`: a pure, side-effect-free, frozen
// singleton that is safe to import from anywhere.
//
// ENTERPRISE / SAFETY NOTES
// -------------------------
// * The subsystem is DISABLED by default (`enabled=false`). Nothing loads a
//   vision model, touches the DB, or accepts media until an operator sets
//   DINA_VISION_ENABLED=true. This guarantees "no disruption" on first deploy.
// * Remote-image fetching is OFF by default (`allowRemote=false`). When on, all
//   URLs pass the DIGIM SSRF guard before a single byte is fetched.
// * Every size/dimension/count/timeout is bounded and clamped so a hostile or
//   buggy caller cannot exhaust memory, disk, or GPU.
// * Nothing here performs I/O; importing it is free of side effects.
// ============================================================================

export interface VisionRuntimeConfig {
  // ---- Master switch ----
  /** When false (default) the whole vision subsystem is inert. */
  enabled: boolean;

  // ---- Model selection ----
  /** Ollama vision-language model used for image understanding. */
  visionModel: string;
  /**
   * Text model used to synthesise a video's per-frame analyses into one
   * temporal narrative. Defaults to the shared analysis-tier model.
   */
  synthesisModel: string;
  /** Max tokens generated per vision inference call. */
  maxTokens: number;
  /** Sampling temperature for vision inference (low = more factual/deterministic). */
  temperature: number;
  /** Hard timeout (ms) for a single vision inference call. */
  inferenceTimeoutMs: number;
  /**
   * When true, refuse to auto-run a vision model whose estimated VRAM footprint
   * exceeds the LLM VRAM budget (would offload to CPU). Reuses the LLM budget.
   */
  enforceVramBudget: boolean;

  // ---- Image ingestion limits ----
  /** Hard cap on a single decoded image payload (bytes). */
  maxImageBytes: number;
  /** Max width/height (px) accepted — guards against decompression bombs. */
  maxImageDimension: number;
  /** Max total pixels (w*h) accepted — a tighter bomb guard than dimension alone. */
  maxImagePixels: number;
  /** MIME types accepted for still images (validated by MAGIC BYTES, not by claim). */
  allowedImageMimeTypes: string[];

  // ---- Video ingestion limits ----
  /** When false, video endpoints are rejected (image-only deployment). */
  videoEnabled: boolean;
  /** Max frames analysed per video (bounds GPU work + latency). */
  maxVideoFrames: number;
  /** Frames-per-second to sample when DINA extracts frames itself (ffmpeg path). */
  frameSampleFps: number;
  /** Max total bytes across all supplied/extracted frames of one video. */
  maxVideoBytes: number;
  /**
   * Path to an ffmpeg binary for server-side frame extraction. Empty (default)
   * → DINA never shells out; callers must supply pre-extracted frames. This
   * keeps ffmpeg an OPTIONAL enhancement, not a hard dependency.
   */
  ffmpegPath: string;

  // ---- Concurrency ----
  /** Max vision inferences in flight at once across the whole process. */
  maxConcurrentInferences: number;
  /** Frames analysed concurrently within a single video job. */
  frameConcurrency: number;

  // ---- Remote fetching (SSRF-guarded, OFF by default) ----
  /** When true, callers may pass an https URL and DINA fetches the image. */
  allowRemote: boolean;
  /** Per-request timeout (ms) for a remote image fetch. */
  remoteFetchTimeoutMs: number;

  // ---- Storage / caching ----
  /** When true, analyses are persisted to MySQL (vision_* tables). */
  persistenceEnabled: boolean;
  /** TTL (hours) for a cached analysis keyed by content hash + task. */
  cacheTtlHours: number;
  /** Days to retain stored media metadata + analyses before cleanup eligibility. */
  retentionDays: number;
}

// ----------------------------------------------------------------------------
// ENV PARSING HELPERS (defensive — never throw on bad input)
// ----------------------------------------------------------------------------

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.trim().length > 0 ? v.trim() : fallback;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Parse a comma-separated env var into a de-duplicated, trimmed, lower-cased list. */
function envCsv(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) return dedupe(fallback);
  const parts = v.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  return parts.length > 0 ? dedupe(parts) : dedupe(fallback);
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function clampFloat(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

// ----------------------------------------------------------------------------
// CONFIG SINGLETON (frozen) — built once at first access.
// ----------------------------------------------------------------------------

function buildConfig(): VisionRuntimeConfig {
  const synthesisModel = envStr('DINA_VISION_SYNTHESIS_MODEL', envStr('DINA_ANALYSIS_MODEL', 'mistral:7b'));

  return Object.freeze({
    enabled: envBool('DINA_VISION_ENABLED', false),

    // llava:7b (~5.5GB) is a solid, widely-available default that fits a 24GB
    // card alongside the small chat model. Override for llama3.2-vision / qwen2.5vl.
    visionModel: envStr('DINA_VISION_MODEL', 'llava:7b'),
    synthesisModel,
    maxTokens: clampInt(envInt('DINA_VISION_MAX_TOKENS', 1024), 64, 8192),
    temperature: clampFloat(envFloat('DINA_VISION_TEMPERATURE', 0.2), 0, 2),
    inferenceTimeoutMs: clampInt(envInt('DINA_VISION_INFERENCE_TIMEOUT_MS', 120000), 5000, 600000),
    enforceVramBudget: envBool('DINA_VISION_ENFORCE_VRAM', true),

    maxImageBytes: clampInt(envInt('DINA_VISION_MAX_IMAGE_BYTES', 12 * 1024 * 1024), 1024, 64 * 1024 * 1024),
    maxImageDimension: clampInt(envInt('DINA_VISION_MAX_IMAGE_DIMENSION', 8192), 16, 32768),
    maxImagePixels: clampInt(envInt('DINA_VISION_MAX_IMAGE_PIXELS', 40_000_000), 256, 200_000_000),
    allowedImageMimeTypes: envCsv('DINA_VISION_ALLOWED_MIME', [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/bmp',
    ]),

    videoEnabled: envBool('DINA_VISION_VIDEO_ENABLED', true),
    maxVideoFrames: clampInt(envInt('DINA_VISION_MAX_VIDEO_FRAMES', 12), 1, 120),
    frameSampleFps: clampFloat(envFloat('DINA_VISION_FRAME_SAMPLE_FPS', 0.5), 0.01, 30),
    maxVideoBytes: clampInt(envInt('DINA_VISION_MAX_VIDEO_BYTES', 64 * 1024 * 1024), 1024, 512 * 1024 * 1024),
    ffmpegPath: envStr('DINA_VISION_FFMPEG_PATH', ''),

    maxConcurrentInferences: clampInt(envInt('DINA_VISION_MAX_CONCURRENT', 2), 1, 16),
    frameConcurrency: clampInt(envInt('DINA_VISION_FRAME_CONCURRENCY', 2), 1, 8),

    allowRemote: envBool('DINA_VISION_ALLOW_REMOTE', false),
    remoteFetchTimeoutMs: clampInt(envInt('DINA_VISION_REMOTE_TIMEOUT_MS', 15000), 1000, 120000),

    persistenceEnabled: envBool('DINA_VISION_PERSISTENCE', true),
    cacheTtlHours: clampInt(envInt('DINA_VISION_CACHE_TTL_HOURS', 24), 0, 720),
    retentionDays: clampInt(envInt('DINA_VISION_RETENTION_DAYS', 30), 1, 3650),
  });
}

let _config: VisionRuntimeConfig | null = null;

/** Returns the process-wide, immutable Vision runtime config. */
export function getVisionConfig(): VisionRuntimeConfig {
  if (!_config) {
    _config = buildConfig();
    logConfigOnce(_config);
  }
  return _config;
}

/**
 * TEST-ONLY: force a rebuild of the config from the current environment.
 * Never call this in production code paths — it exists so edge-case tests can
 * flip env vars and observe the effect without a fresh process.
 */
export function __rebuildVisionConfigForTests(): VisionRuntimeConfig {
  _config = buildConfig();
  return _config;
}

let _logged = false;
function logConfigOnce(cfg: VisionRuntimeConfig): void {
  if (_logged) return;
  _logged = true;
  console.log('👁️ [visionConfig] Vision runtime configuration loaded:');
  console.log(`   • enabled=${cfg.enabled}  model=${cfg.visionModel}  synthesis=${cfg.synthesisModel}`);
  console.log(`   • image: maxBytes=${cfg.maxImageBytes} maxDim=${cfg.maxImageDimension} maxPixels=${cfg.maxImagePixels}`);
  console.log(`   • video: enabled=${cfg.videoEnabled} maxFrames=${cfg.maxVideoFrames} ffmpeg=${cfg.ffmpegPath || '(none — client supplies frames)'}`);
  console.log(`   • remote=${cfg.allowRemote}  persistence=${cfg.persistenceEnabled}  cacheTtlH=${cfg.cacheTtlHours}`);
  if (!cfg.enabled) {
    console.log('   • ℹ️ DINA Vision is DISABLED (set DINA_VISION_ENABLED=true to activate).');
  }
}
