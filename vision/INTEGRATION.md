# DINA Vision (DIVIS) — Integration Map, Rollback & Client Contract

This is the precise record of *what changed where*, why it is safe, how to roll
it back, and the contract any downstream client uses to call the new capability.

Vision is a **standalone module**. It does not depend on, feed, or know about any
other DINA module. Where this doc references DIGIM or the DUMP protocol, it is
strictly *reuse of proven infrastructure* (message envelope, API request/response
flow, SSRF guard) — never a coupling to another module's domain logic.

---

## 1. New files (self-contained — additive by definition)

```
src/modules/vision/                         # the whole subsystem
  config/visionConfig.ts
  types.ts
  ingestion/imageProbe.ts
  ingestion/imageIngestor.ts
  ingestion/videoIngestor.ts
  ingestion/mediaKind.ts                     # pure image-vs-video detection
  security/imageGuard.ts
  ollama/visionModel.ts
  analysis/promptTemplates.ts
  analysis/structuredParser.ts
  analysis/videoAggregation.ts               # pure cross-frame aggregation
  analysis/imageAnalyzer.ts
  analysis/videoAnalyzer.ts
  storage/visionStore.ts
  visionOrchestrator.ts
  index.ts
migrations/002_vision_schema.ts             # vision_media + vision_analysis
test/vision/visionEdgeCases.ts              # 121 hermetic assertions
vision/                                      # this deliverable/docs package
```

These add code; they cannot change existing behaviour.

---

## 2. Modified files (5 — every edit additive & gated)

### `src/modules/llm/manager.ts`  (+19)
- Added an optional `images?: string[]` to `OllamaGenerateOptions`.
- In `OllamaClient.generate()`, `requestBody.images` is set **only when the array
  is present and non-empty**.
- **Why safe:** every existing text-only caller omits `images`, so the request
  body is byte-for-byte identical to before. This is the single reuse point that
  lets Vision share the hardened NDJSON transport instead of duplicating it.

### `src/modules/llm/llmConfig.ts`  (+16)
- Added vision-model VRAM footprints (llava, llama3.2-vision, qwen2.5vl,
  moondream, …) to `DEFAULT_FOOTPRINTS_MB`.
- **Why safe:** pure data addition to a lookup table; changes no existing entry.

### `src/core/orchestrator/index.ts`  (+135)
- Imported `getVisionOrchestrator` and `VisionError`.
- Added **Phase 5** to `DinaCore.initialize()` — a non-fatal, self-gating vision
  init (no-ops when disabled), wrapped in try/catch so it can never break boot.
- Added `case 'vision':` to the module-routing switch → `processVisionRequest()`.
- Added `processVisionRequest()` + `extractImageInput()` (thin DUMP→module glue;
  maps `VisionError` to a structured error payload).
- Added a best-effort vision shutdown in `DinaCore.shutdown()`.
- **Why safe:** the switch `default` still throws for unknown modules; the new
  case is only reached for `target.module === 'vision'`. Init/shutdown failures
  are swallowed.

### `src/api/routes/index.ts`  (+196)
- Added a **path-scoped** JSON body parser for `/vision` (limit
  `DINA_VISION_MAX_BODY_MB`, default 32 MB) placed **before** the global 10 MB
  parser. `express.json` is a no-op once a body is parsed, so every non-vision
  route keeps the original 10 MB limit unchanged.
- Extended the route-timeout hierarchy so `/vision/analyze*|describe|ocr|ask` get
  the 300 s LLM budget (cold vision-model loads are slow); status/health stay 60 s.
- Added routes: `GET /vision/status`, `POST /vision/{analyze-image,describe,ocr,
  ask,analyze-video}`, `POST /vision/prune` (trusted). Each builds a DUMP message
  through the existing auth/trust machinery and maps the typed error code to HTTP.
- Updated the `/routes` listing + mount log.
- **Why safe:** all new routes are under the new `/vision` prefix; no existing
  route path, parser, or timeout for other paths is altered.

### `package.json`  (+1)
- Added `"test:vision": "ts-node test/vision/visionEdgeCases.ts"`.

---

## 3. No-disruption evidence

| Check | Command | Result |
|---|---|---|
| Type-check clean | `npm run type-check` | exit 0 |
| Full build emits | `npm run build` | exit 0 |
| Vision logic | `npm run test:vision` | 81 passed, 0 failed |
| Blast radius | `git diff --stat` | 5 files, +363/−4 |

The default runtime is unchanged: with `DINA_VISION_ENABLED` unset, Phase 5
prints one `ℹ️ Vision disabled` line and does nothing else — no model load, no
tables, no I/O.

---

## 4. Rollback

Two levels:

1. **Operational (instant):** unset `DINA_VISION_ENABLED`. The subsystem goes
   inert; nothing else changes. No redeploy required beyond the env flip.
2. **Code (full revert):**
   ```bash
   rm -rf src/modules/vision test/vision vision migrations/002_vision_schema.ts
   git checkout -- src/modules/llm/manager.ts src/modules/llm/llmConfig.ts \
                   src/core/orchestrator/index.ts src/api/routes/index.ts package.json
   npm run type-check   # back to the original clean baseline
   ```
   To drop the tables (only if they were created): `npm run migrate:down` while
   002 is the latest applied migration, or `DROP TABLE vision_analysis, vision_media;`.

---

## 5. Downstream client contract

Any client (a web frontend, a CLI, another service) calls the vision module the
same way — an authenticated HTTP POST. The module is self-contained; a caller
sends image bytes and gets a structured result back. Nothing about the caller is
baked into the module.

**Describe a scene**
```
POST {DINA_BASE}/dina/api/v1/vision/describe
Headers: x-user-key / x-dina-key (existing auth), Content-Type: application/json
Body:    { "base64": "<data-uri-or-bare-base64>" }
```
Response: `{ analysis: { caption, ... }, ... }`

**Full structured analysis** (caption + objects + tags + OCR text + colours)
```
POST .../vision/analyze-image   Body: { "base64": "<img>", "task": "full" }
```
Response: `{ analysis: { caption, objects[], tags[], text, colors[], safety, confidence }, ... }`

**Read text (OCR)**
```
POST .../vision/ocr             Body: { "base64": "<img>" }        → analysis.text
```
**Answer a question (VQA)**
```
POST .../vision/ask             Body: { "base64": "<img>", "question": "…" }   → analysis.answer
```

**Analyze a video** (a series of frames — same task set, aggregated over time)
```
POST .../vision/analyze-video
Body: { "frames": [ { "base64": "<jpg>", "timestampSec": 0 }, … ],
        "task": "describe", "max_frames": 8 }
```
Response: `{ frameCount, task, analysis: { summary, timeline[], objects[], tags[], text?, answer? } }`

**Unified** — say the kind + task in one place; kind `auto` infers image vs video
```
POST .../vision/analyze
Body: { "kind": "auto", "task": "ocr", "base64": "<img>" }              // image
Body: { "kind": "video", "task": "vqa", "question": "…", "frames": [ … ] }  // video
```

Notes for callers:
- Send bytes as `base64` (a `data:` URI is accepted). The routes nest media
  internally so the DUMP sanitizer can never corrupt the bytes.
- A video is just a series of images — the same tasks apply per-frame: `describe`
  /`full` → narrative + timeline, `ocr` → de-duplicated transcript, `vqa` → one
  reconciled answer. `max_frames` trades depth for latency (clamped to the
  operator ceiling `DINA_VISION_MAX_VIDEO_FRAMES`).
- Extract video frames client-side (`<video>`→`<canvas>`→`toDataURL`); no ffmpeg
  is needed on the server unless you send raw video with `DINA_VISION_FFMPEG_PATH` set.
- Respect the documented limits (image ≤ `DINA_VISION_MAX_IMAGE_BYTES`, HTTP body
  ≤ `DINA_VISION_MAX_BODY_MB`); downscale very large media client-side first.
- `task: "vqa"` requires a `question`; an unknown `task` returns `INVALID_TASK`
  (400) listing the allowed values.

### Error handling
Every failure returns the typed shape the client can branch on:
```json
{ "error": "IMAGE_TOO_LARGE", "message": "…", "details": { "limit": 12582912 } }
```
with the matching HTTP status (400/403/413/415/503/504). No 500s for
caller-input problems.
