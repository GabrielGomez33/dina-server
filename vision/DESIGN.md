# DINA Vision (DIVIS) — Design

This document is the engineering design for the vision subsystem: the mental
model, the module architecture, the data flow, the persistence schema, and the
full configuration surface.

---

## 1. Mental model — from pixels to meaning

| Layer | What it is | In DINA |
|---|---|---|
| **Raw media** | Encoded bytes (JPEG/PNG/WebP/GIF/BMP; MP4/etc.) | Caller sends base64 / bytes / URL |
| **Decoded image** | `H × W × channels` grid of integers | We *probe* geometry from the header; the model decodes pixels |
| **Features** | Edges → textures → parts → objects (learned) | Handled inside the vision model's encoder |
| **Fused tokens** | Image encoded into LLM token space | Ollama vision model internals |
| **Meaning** | Caption, objects, tags, text, colours, answers | The module's structured `ImageAnalysis` |
| **Temporal meaning** | How frames change over time | `VideoAnalyzer` synthesis step |

A single vision model call only ever sees **stills**. "Motion" and "events"
emerge from analysing an ordered set of frames and then asking a *text* model to
reason over the ordered descriptions — which is exactly how `VideoAnalyzer` is
built.

---

## 2. Architecture

The subsystem mirrors the DIGIM web-research pattern: cheap I/O-free
construction, a lazy singleton, an `enabled` gate off frozen config, an
`assertEnabled()` guard on every operation, and an `initialize()` that no-ops
when disabled.

```
src/modules/vision/
├── config/
│   └── visionConfig.ts        Frozen, env-driven config. DISABLED by default.
├── types.ts                   Shared vocabulary (inputs, analyses, VisionError).
├── ingestion/
│   ├── imageProbe.ts          Pure-TS magic-byte format + dimension detection.
│   ├── imageIngestor.ts       RawImageInput (base64|bytes|url) → NormalizedImage.
│   ├── videoIngestor.ts       Frame sampling + per-call frame cap + optional ffmpeg.
│   └── mediaKind.ts           Pure image-vs-video detection for the unified entry.
├── security/
│   └── imageGuard.ts          The fail-closed choke point (size/format/bomb).
├── ollama/
│   └── visionModel.ts         Wraps OllamaClient + installed/VRAM/concurrency guards.
├── analysis/
│   ├── promptTemplates.ts     Task prompts (caption/describe/objects/ocr/tags/vqa/full).
│   ├── structuredParser.ts    Robust JSON extraction + ImageAnalysis coercion.
│   ├── videoAggregation.ts    Pure cross-frame aggregation (union / OCR dedupe / mean).
│   ├── imageAnalyzer.ts       One image → one ImageAnalysis (any task).
│   └── videoAnalyzer.ts       Frames → per-frame task → task-specific aggregation.
├── storage/
│   └── visionStore.ts         Own DB tables + Redis cache + dedup (best-effort).
├── visionOrchestrator.ts      Public facade: analyzeImage/analyzeVideo/describe/ocr/ask.
└── index.ts                   Barrel + getVisionOrchestrator() singleton.
```

Each file has exactly one responsibility. The orchestrator is the only place
that knows about all of them; everything else depends downward only.

---

## 3. Data flow

### Image

```
DUMP vision_analyze_image
  → orchestrator.processVisionRequest()          (core/orchestrator)
    → VisionOrchestrator.analyzeImage()
      1. ingestImage()        base64/bytes/url → bytes
      2. imageGuard           magic bytes, size cap, format allowlist, bomb guard
                              → NormalizedImage { base64, mime, sha256, w, h }
      3. cache lookup         redis  vision:<sha>:<task>:<model>   (hit ⇒ return)
      4. ImageAnalyzer        prompt → VisionModelClient.infer(images:[base64])
                              → structuredParser → ImageAnalysis
      5. store (best-effort)  vision_media (dedup by sha) + vision_analysis
      6. cache store          → ImageAnalysisResult
```

### Video (a series of images — same task set)

```
DUMP vision_analyze_video  (or vision_analyze with kind:video/auto)
  → VisionOrchestrator.analyzeVideo({ task, question?, maxFrames? })
    1. ingestVideo()          frames[] (preferred) OR raw video + ffmpeg
                              → clampFrames(maxFrames, cfg.maxVideoFrames)
                              → sampleFrameIndices() spreads picks over the timeline
                              → each frame through imageGuard
    2. VideoAnalyzer.analyze(frames, { task })   per-frame task = the request's task
       a. per-frame analysis  bounded concurrency; a failing frame is ISOLATED
                              (degraded to a marker, never sinks the job)
       b. aggregate BY TASK   describe/full/… → object/tag union + temporal
                                                narrative (text model) + timeline
                              ocr             → de-duplicated transcript + text timeline
                              vqa             → one reconciled answer (text model)
    3. store (best-effort)    → VideoAnalysisResult { task, summary, timeline,
                                                       objects, tags, text?, answer? }
```

### Unified entry (`vision_analyze`)

```
DUMP vision_analyze  { kind: image|video|auto, task, ... }
  → detectMediaKind(media, kind)     explicit wins; 'auto' infers video from
                                     frames / video-mime / duration, else image
  → dispatch to the image or video pipeline above
```

---

## 4. Security model (fail-closed)

The single choke point is `security/imageGuard.ts`. Nothing reaches a model, the
cache, or the DB without passing it. Ordered defences:

1. **Trust bytes, not claims.** `probeImage()` derives the true format from magic
   bytes. A `.png` that is really HTML/SVG/script is rejected as
   `UNSUPPORTED_FORMAT`.
2. **Format allowlist.** Only configured MIME types (JPEG/PNG/WebP/GIF/BMP by
   default) pass.
3. **Size cap, pre-decode.** Base64 length is checked *before* `Buffer.from`,
   using the 4/3 inflation ratio, so an oversize payload is rejected without
   allocating it.
4. **Decompression-bomb guard.** Width/height are read from the header (a few
   bytes) and checked against `maxImageDimension` and `maxImagePixels` **before**
   any pixel decode. A 10-byte header claiming 100000×100000 never allocates.
5. **Strict base64 / data-URI parsing.** Non-base64 data URIs and malformed
   base64 are rejected early.
6. **SSRF for remote URLs.** The remote path is off by default; when on, every
   URL passes DIGIM's `assertUrlSafe()` (blocks private/loopback/link-local/
   metadata IPs, bad schemes, embedded creds) and redirects are refused
   (`redirect: 'error'`) so a 3xx cannot dodge the guard. The body cap is
   re-checked after fetch in case the server lied about `Content-Length`.
7. **GPU safety.** `VisionModelClient` refuses an uninstalled vision model (with
   an actionable `ollama pull` message) and, unless overridden, refuses a model
   that exceeds the VRAM budget (which would silently offload to CPU). A
   semaphore bounds concurrent inferences so vision can't starve the rest of DINA.

All failures raise a typed `VisionError { code, message, httpStatus, details }`
that the API layer maps straight to the correct HTTP status.

---

## 5. Persistence schema

Two tables, created by the module on boot (`visionStore.initSchema()`) and/or by
`migrations/003_vision_schema.ts`. Following the DIGIM convention, `db.ts` does
**not** know about them — the module owns its own tables.

```sql
vision_media                       -- one row per unique media (dedup)
  id            VARCHAR(36) PK
  sha256        CHAR(64)           -- content address
  media_type    ENUM('image','video')
  mime_type     VARCHAR(64)
  byte_length   BIGINT UNSIGNED
  width, height INT UNSIGNED NULL
  frame_count   INT UNSIGNED NULL  -- videos
  user_id       VARCHAR(64) NULL
  created_at    TIMESTAMP
  UNIQUE (sha256, media_type)      -- dedup key

vision_analysis                    -- one row per analysis run
  id                 VARCHAR(36) PK
  media_id           VARCHAR(36)   -- FK → vision_media(id) ON DELETE CASCADE
  sha256, media_type
  task               VARCHAR(32)   -- describe|caption|objects|ocr|tags|vqa|full
  model              VARCHAR(100)
  caption            MEDIUMTEXT     -- denormalised for querying
  result_json        LONGTEXT       -- the full structured ImageAnalysis/VideoAnalysis
  confidence         DECIMAL(5,4)
  processing_time_ms INT UNSIGNED
  user_id            VARCHAR(64) NULL
  created_at         TIMESTAMP
```

**Never stored:** the pixels themselves. We keep intrinsic facts + the structured
result, not the raw media. A retention sweep (`vision_prune`) deletes rows older
than `retentionDays`, cascading analyses.

The **hot cache** is Redis via the existing exact-cache API, keyed
`vision:<sha256>:<task>:<model>`, TTL `cacheTtlHours`. Because the key is the
content hash, re-analysing identical bytes for the same task is a fast hit. VQA
answers are question-specific and are intentionally **not** cached by content.

---

## 6. Configuration

All env vars, safe/bounded defaults. Full table:

| Env var | Default | Meaning |
|---|---|---|
| `DINA_VISION_ENABLED` | `false` | **Master switch.** Off ⇒ subsystem inert. |
| `DINA_VISION_MODEL` | `qwen2.5vl:7b` | Ollama vision model (strong at describe + OCR + VQA). |
| `DINA_VISION_SYNTHESIS_MODEL` | `DINA_ANALYSIS_MODEL` / `mistral:7b` | Text model for video synthesis. |
| `DINA_VISION_MAX_TOKENS` | `1024` | Max tokens per inference. |
| `DINA_VISION_TEMPERATURE` | `0.2` | Low ⇒ factual/deterministic. |
| `DINA_VISION_INFERENCE_TIMEOUT_MS` | `120000` | Per-inference hard timeout. |
| `DINA_VISION_ENFORCE_VRAM` | `true` | Refuse oversize (CPU-offloading) models. |
| `DINA_VISION_MAX_IMAGE_BYTES` | `12 MiB` | Per-image byte cap. |
| `DINA_VISION_MAX_IMAGE_DIMENSION` | `8192` | Max width/height (bomb guard). |
| `DINA_VISION_MAX_IMAGE_PIXELS` | `40,000,000` | Max area (bomb guard). |
| `DINA_VISION_ALLOWED_MIME` | jpeg,png,webp,gif,bmp | Format allowlist. |
| `DINA_VISION_VIDEO_ENABLED` | `true` | Allow video endpoints. |
| `DINA_VISION_MAX_VIDEO_FRAMES` | `12` | Frames analysed per video. |
| `DINA_VISION_FRAME_SAMPLE_FPS` | `0.5` | ffmpeg sample rate. |
| `DINA_VISION_MAX_VIDEO_BYTES` | `64 MiB` | Total video/frames byte cap. |
| `DINA_VISION_FFMPEG_PATH` | `''` | ffmpeg binary (empty ⇒ client supplies frames). |
| `DINA_VISION_MAX_CONCURRENT` | `2` | Concurrent inferences (semaphore). |
| `DINA_VISION_FRAME_CONCURRENCY` | `2` | Concurrent frames within one video. |
| `DINA_VISION_ALLOW_REMOTE` | `false` | Allow SSRF-guarded remote URL fetch. |
| `DINA_VISION_REMOTE_TIMEOUT_MS` | `15000` | Remote fetch timeout. |
| `DINA_VISION_PERSISTENCE` | `true` | Persist to MySQL. |
| `DINA_VISION_CACHE_TTL_HOURS` | `24` | Redis analysis cache TTL. |
| `DINA_VISION_RETENTION_DAYS` | `30` | Media retention before prune. |
| `DINA_VISION_MAX_BODY_MB` | `32` | HTTP body limit for `/vision/*` routes only. |

Every integer/float is clamped to a sane range in `visionConfig.ts`, and bad
input falls back to the default — the config never throws.

---

## 7. Model choice guidance

The three first-class tasks are **scene description, text reading (OCR), and
visual question answering**. OCR is the discriminator: it rules out llava as the
default (a strong describer but a weak reader). The default is chosen to do all
three well on a single 24 GB card alongside the small chat model.

| Model | ~VRAM | Notes |
|---|---|---|
| `qwen2.5vl:7b` | ~7 GB | **Default.** Strong at describe **and** OCR **and** VQA; the best all-rounder in this size. |
| `llama3.2-vision:11b` | ~9.5 GB | "Turn up quality" alternative — excellent reasoning + OCR, more VRAM. |
| `minicpm-v` | ~6 GB | Lighter, OCR-focused; punches above its size on text reading. |
| `llava:7b` | ~5.5 GB | Good scene descriptions but weak OCR — not ideal now that OCR is first-class. |
| `moondream` | ~1.9 GB | Tiny/fast, captions only; weakest reasoning/OCR. |

The model is a single env var (`DINA_VISION_MODEL`), so different models can be
A/B'd on real images without a code change. Footprints for all of these were
added to `llmConfig.ts` so the shared VRAM guard reasons about them; anything
that would offload to CPU is refused unless `DINA_VISION_ENFORCE_VRAM=false`.
