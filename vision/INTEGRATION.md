# DINA Vision (DIVIS) — Integration Map, Rollback & mirror-server Contract

This is the precise record of *what changed where*, why it is safe, how to roll
it back, and the contract a `mirror-server` client uses to call the new
capability.

---

## 1. New files (self-contained — additive by definition)

```
src/modules/vision/                         # the whole subsystem
  config/visionConfig.ts
  types.ts
  ingestion/imageProbe.ts
  ingestion/imageIngestor.ts
  ingestion/videoIngestor.ts
  security/imageGuard.ts
  ollama/visionModel.ts
  analysis/promptTemplates.ts
  analysis/structuredParser.ts
  analysis/imageAnalyzer.ts
  analysis/videoAnalyzer.ts
  storage/visionStore.ts
  visionOrchestrator.ts
  index.ts
migrations/002_vision_schema.ts             # vision_media + vision_analysis
test/vision/visionEdgeCases.ts              # 81 hermetic assertions
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

## 5. mirror-server contract (downstream client)

> **Note:** this session had repository access to `dina-server` only, so the
> mirror-server code changes are *specified* here rather than applied. They are a
> thin client — mirror-server already talks to dina-server over HTTP with the
> same auth headers used by its other calls.

To let a Mirror user submit a photo/video and get visual insight, mirror-server
calls the new endpoints exactly like it calls `/mirror/synthesize-insights`:

**Describe / analyse an image**
```
POST {DINA_BASE}/dina/api/v1/vision/analyze-image
Headers: x-user-key / x-dina-key (existing auth), Content-Type: application/json
Body:    { "base64": "<data-uri-or-bare-base64>", "task": "full" }
```
Response: `{ analysis: { caption, objects[], tags[], text, colors[], safety, confidence }, ... }`

**OCR**
```
POST .../vision/ocr        Body: { "base64": "<img>" }        → analysis.text
```
**VQA**
```
POST .../vision/ask        Body: { "base64": "<img>", "question": "…" }   → analysis.answer
```
**Video**
```
POST .../vision/analyze-video
Body: { "frames": [ { "base64": "<jpg>", "timestampSec": 0 }, … ], "task": "full" }
```
Client should extract frames in the browser (`<video>` → `<canvas>` → `toDataURL`)
and send a bounded set — this needs no ffmpeg on either server.

### Suggested mirror-server wiring (specification)
- Add a `DinaVisionConnector` alongside the existing `DINALLMConnector`, POSTing
  to the routes above with the service auth already in use.
- Feed the returned `analysis` into the Mirror insight pipeline as a new modality
  (the existing `MirrorUserSubmission.faceAnalysis` is numeric/pre-computed; a
  vision `caption`/`objects`/`tags` payload is complementary raw perception).
- Respect the documented limits (image ≤ `DINA_VISION_MAX_IMAGE_BYTES`, body ≤
  `DINA_VISION_MAX_BODY_MB`); downscale large images client-side first.

### Error handling
Every failure returns the typed shape the client can branch on:
```json
{ "error": "IMAGE_TOO_LARGE", "message": "…", "details": { "limit": 12582912 } }
```
with the matching HTTP status (400/403/413/415/503/504). No 500s for
caller-input problems.
