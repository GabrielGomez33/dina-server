# DINA Vision (DIVIS) — Edge Cases & Verification

Two parts:
1. **Handled edge cases** — enumerated, each mapped to the code that handles it
   and the hermetic test that proves it.
2. **Manual live-service runbook** — the integration checks that need a running
   Ollama + MySQL + Redis, written to be reproduced exactly.

---

## 1. Handled edge cases

### Input / format

| # | Edge case | Handling | Proven by |
|---|---|---|---|
| 1 | Empty / whitespace payload | `EMPTY_IMAGE` | `decodeBase64Image — empty/whitespace rejected` |
| 2 | Malformed base64 | `INVALID_BASE64` | `decodeBase64Image — garbage rejected` |
| 3 | Data-URI wrapper (`data:image/png;base64,…`) | Parsed + stripped | `parseDataUri`, `decodeBase64Image — data-URI decodes` |
| 4 | Non-base64 data URI (`data:text/plain,…`) | `INVALID_DATA_URI` | `parseDataUri — non-base64 rejected` |
| 5 | Format spoofing (HTML/SVG claiming to be an image) | Magic-byte check ⇒ `UNSUPPORTED_FORMAT` | `validateImageBuffer — SVG/text rejected` |
| 6 | Disallowed but real format | `FORMAT_NOT_ALLOWED` | `validateImageBuffer — disallowed format rejected` |
| 7 | Zero / negative declared dimensions | `INVALID_DIMENSIONS` | `decompression-bomb — zero dimension rejected` |
| 8 | Truncated / corrupt header | Probe returns `null` dims; byte cap still applies | `imageProbe — single byte / empty → unknown` |

### Resource exhaustion

| # | Edge case | Handling | Proven by |
|---|---|---|---|
| 9 | Oversize payload | Rejected **pre-decode** via base64 length (`IMAGE_TOO_LARGE`) | `size cap — oversize base64 rejected before decode` |
| 10 | Decompression bomb — huge dimension | `IMAGE_DIMENSION_EXCEEDED` from header, no decode | `decompression-bomb — oversize dimension rejected` |
| 11 | Decompression bomb — huge area, small dims | `IMAGE_PIXELS_EXCEEDED` | `decompression-bomb — pixel-area bomb rejected` |
| 12 | Too many / too-large video frames | `sampleFrameIndices` caps count; total-byte cap ⇒ `VIDEO_TOO_LARGE` | `sampleFrameIndices — *`, code review |
| 13 | GPU starvation from concurrent jobs | Semaphore (`DINA_VISION_MAX_CONCURRENT`) | code (`visionModel.ts` Semaphore) |

### Video specifics

| # | Edge case | Handling | Proven by |
|---|---|---|---|
| 14 | More frames than the cap | Uniform down-sampling keeps timeline coverage | `sampleFrameIndices — 10→4 / 1000→12` |
| 15 | Fewer frames than the cap | All kept, in order | `sampleFrameIndices — fewer than cap` |
| 16 | Single frame / zero frames / cap 0 | `[0]` / `[]` / `[]` — no crash | `sampleFrameIndices — single/zero/cap-0` |
| 17 | Raw video but no ffmpeg configured | `FFMPEG_UNAVAILABLE` with a clear "send frames" message | code (`videoIngestor.ts`) |
| 18 | ffmpeg fails / times out / yields nothing | `FFMPEG_FAILED` / `FFMPEG_TIMEOUT` / `FRAME_EXTRACTION_EMPTY`; temp dir always cleaned | code (`videoIngestor.ts`, `finally rm`) |
| 19 | One frame fails mid-video | Isolated to a marker; other frames + synthesis proceed | code (`videoAnalyzer.ts` try/catch) |

### Model output

| # | Edge case | Handling | Proven by |
|---|---|---|---|
| 20 | Model wraps JSON in prose | Balanced-brace extraction | `extractJsonObject — embedded in prose` |
| 21 | Model fences JSON in ` ```json ` | Fence stripped first | `extractJsonObject — fenced json block` |
| 22 | Brace inside a JSON string | Not miscounted (string-aware scan) | `extractJsonObject — brace inside string` |
| 23 | Unbalanced / no JSON at all | `null` ⇒ whole text becomes the caption (never throws) | `parseFullAnalysis — non-JSON fallback` |
| 24 | Wrong field types (string where array expected) | Coerced (comma/newline split) | `parseFullAnalysis — string coerced to array` |
| 25 | Invalid `safety` value | Normalised to `unknown` | `parseFullAnalysis — invalid safety → unknown` |
| 26 | Empty model response | Empty caption, low confidence, no throw | `parseFullAnalysis — empty model text` |
| 27 | OCR with no text | `NO_TEXT` sentinel ⇒ empty text field | `parseSingleTask — OCR NO_TEXT` |

### Configuration / lifecycle / security

| # | Edge case | Handling | Proven by |
|---|---|---|---|
| 28 | Subsystem disabled (default) | `initialize()` no-ops; ops throw `VISION_DISABLED` | `visionConfig — disabled by default` |
| 29 | Garbage / out-of-range env values | Clamped or defaulted; config never throws | `visionConfig — clamping / garbage int` |
| 30 | Vision model not installed | `VISION_MODEL_NOT_INSTALLED` + `ollama pull` hint (never silent text-model swap) | code (`visionModel.ts`) |
| 31 | Vision model too big for VRAM | `VISION_MODEL_OVERSIZED` (would offload to CPU) | code (`visionModel.ts`) |
| 32 | Remote URL fetch when disabled | `REMOTE_DISABLED` | code (`imageIngestor.ts`) |
| 33 | Remote URL to internal/metadata IP | `UNSAFE_URL` via SSRF guard; redirects refused | code (`imageIngestor.ts` + urlGuard) |
| 34 | DB/Redis hiccup during store/cache | Degrades (logs + swallows); analysis still returned | code (`visionStore.ts` try/catch) |
| 35 | Duplicate identical image | Deduped by sha256; cache hit; single media row | `imageGuard — sha256 stable/content-addressed` |
| 36 | Body larger than global 10 MB JSON limit | `/vision/*` gets its own `DINA_VISION_MAX_BODY_MB` (32) parser; other routes unchanged | code (`api/routes/index.ts`) |
| 37 | DUMP sanitizer corrupting base64 | `DinaProtocol.sanitizeMessage` strips `/on\w+\s*=/gi` from **top-level** strings; pixels are carried in a **nested** `media` object the sanitizer never touches | code (`api/routes/index.ts` + `orchestrator.processVisionRequest`) |

**Hermetic result:** `npm run test:vision` → **81 passed, 0 failed**.

---

## 2. Manual live-service runbook

These require a host with Ollama (+ a pulled vision model), MySQL, and Redis —
i.e. a real DINA deployment. Run them after enabling the subsystem.

### 2.0 Prereqs
```bash
ollama pull llava:7b
export DINA_VISION_ENABLED=true
npm run migrate           # or boot once with the flag set
npm run build && sudo pm2 reload ecosystem.config.js
```

### 2.1 Status is reachable and honest
```bash
curl -s .../vision/status | jq '{enabled, visionModel, visionModelInstalled, advisories}'
# EXPECT: enabled=true, visionModelInstalled=true, advisories=["Vision subsystem nominal."]
```

### 2.2 Caption a known image
```bash
B64=$(base64 -w0 test-image.jpg)
curl -s -X POST .../vision/analyze-image -d "{\"base64\":\"$B64\",\"task\":\"caption\"}" | jq '.analysis.caption'
# EXPECT: a factual one-sentence caption describing the image
```

### 2.3 Full structured pass
```bash
curl -s -X POST .../vision/analyze-image -d "{\"base64\":\"$B64\",\"task\":\"full\"}" \
  | jq '{caption:.analysis.caption, objects:.analysis.objects, tags:.analysis.tags, colors:.analysis.colors}'
# EXPECT: populated caption/objects/tags/colors; well-formed arrays
```

### 2.4 OCR a text image
```bash
B64=$(base64 -w0 sign-with-text.png)
curl -s -X POST .../vision/ocr -d "{\"base64\":\"$B64\"}" | jq '.analysis.text'
# EXPECT: the visible text transcribed; "" for an image with no text
```

### 2.5 Visual question answering
```bash
curl -s -X POST .../vision/ask -d "{\"base64\":\"$B64\",\"question\":\"How many people are in this image?\"}" | jq '.analysis.answer'
```

### 2.6 Cache hit (second identical call is fast, cached=true)
```bash
time curl -s -X POST .../vision/analyze-image -d "{\"base64\":\"$B64\",\"task\":\"full\"}" | jq '.cached'   # false, slow
time curl -s -X POST .../vision/analyze-image -d "{\"base64\":\"$B64\",\"task\":\"full\"}" | jq '.cached'   # true, fast
```

### 2.7 Security — oversize / spoofed / bomb (should be rejected, no crash)
```bash
# Spoofed: HTML claiming png
echo -n '<html></html>' | base64 -w0 | xargs -I{} curl -s -X POST .../vision/analyze-image -d '{"base64":"{}"}' | jq '{error,message}'
# EXPECT: HTTP 415 UNSUPPORTED_FORMAT
```

### 2.8 Video — frames path
```bash
# Send 3 frames extracted client-side
curl -s -X POST .../vision/analyze-video \
  -d "{\"frames\":[{\"base64\":\"$F1\",\"timestampSec\":0},{\"base64\":\"$F2\",\"timestampSec\":2},{\"base64\":\"$F3\",\"timestampSec\":4}]}" \
  | jq '{frameCount, summary:.analysis.summary, timeline:.analysis.timeline}'
# EXPECT: frameCount=3, a narrative summary, a timeline
```

### 2.9 GPU residency (no silent CPU offload)
```bash
nvidia-smi   # the vision model should be resident in VRAM during inference
curl -s .../status | jq '.modules.llm_system.gpu'   # state should be 'gpu'
```

### 2.10 Disabled-path sanity (regression guard)
```bash
# With DINA_VISION_ENABLED unset/false:
curl -s .../vision/status | jq '.enabled'                 # false
curl -s -X POST .../vision/describe -d '{"base64":"…"}' | jq '{error}'   # 403 VISION_DISABLED
# And critically: every other module and endpoint behaves exactly as before.
```

Record outcomes (pass/fail + observed output) alongside this file when run in a
real environment, matching the DIGIM `VERIFICATION.md` convention.
