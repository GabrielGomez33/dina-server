# DINA Vision (DIVIS) — Teaching DINA to See

> **Goal #1 — "How can we teach DINA to see? How would a computer/program see an
> image or a video (series of images)? I'd like for her to be able to ingest
> visuals and videos and gather information from them."**

This folder is the **deliverable package** for Goal #1. It documents the design,
the exact changes made to `dina-server`, the edge cases handled, the tests that
prove the logic, and the contract any downstream client uses to call it.

Vision is a **standalone module** — its own concern, no coupling to other
DINA modules. It only *reuses proven infrastructure* (the DUMP protocol, the API
request/response flow, the SSRF guard), never another module's domain logic.

**First-class capabilities:** scene description, text reading (OCR), and visual
question answering (VQA). It runs a **local** vision model on the GPU — no image
bytes leave the box.

The **runtime code** lives where it must to compile and run inside the existing
build (`tsconfig` compiles `src/`):

| Concern | Location |
|---|---|
| Vision subsystem (all module code) | `src/modules/vision/` |
| Database migration | `migrations/002_vision_schema.ts` |
| Hermetic edge-case tests | `test/vision/visionEdgeCases.ts` |
| Design / integration / edge-case docs | `vision/` (this folder) |

- **[DESIGN.md](./DESIGN.md)** — how computers "see", the module architecture, the data flow, the DB schema.
- **[EDGE_CASES.md](./EDGE_CASES.md)** — every edge case, how it is handled, and the manual live-service runbook.
- **[INTEGRATION.md](./INTEGRATION.md)** — the exact file-by-file change map, rollback, and the downstream client contract.

---

## 1. How does a computer "see"?

A human sees meaning. A computer starts with **numbers**.

- **An image is a grid of pixels.** A photo is an `H × W` grid; each pixel is a
  small vector of channel intensities — e.g. `(R, G, B)`, each `0–255`. So an
  image is literally a 3-D array of numbers, `H × W × 3`. Nothing about that
  array "knows" it contains a bicycle.
- **"Seeing" is turning that number-grid into meaning** — objects, scene, text,
  colours, faces, emotions.
  - *Classical computer vision* hand-engineered features from the pixels: edges
    (Sobel/Canny), corners, gradient histograms (HOG), keypoints (SIFT), then
    fed those to a classifier.
  - *Modern deep learning* learns the features. A **CNN** or **Vision
    Transformer (ViT)** learns a hierarchy — edges → textures → parts → objects
    — directly from data.
  - A **Vision-Language Model (VLM)** — LLaVA, Llama-3.2-Vision, Qwen-VL,
    Moondream — goes further: a vision encoder (a CLIP-style ViT) turns the image
    into a sequence of embedding **tokens**, projects them into the *same* token
    space a language model reasons in, and the LLM then produces text
    *conditioned on the image*. That is what lets you ask a model "what is in
    this picture?" and get a sentence back.
- **A video is an ordered sequence of images (frames) over time**, plus audio. A
  program "sees" a video by **sampling frames** (you can't and shouldn't look at
  all 30 fps), analysing each frame as an image, and then **reasoning across
  time** — what changed, what moved, what happened.

### How *DINA* sees

DINA already runs a **local Ollama** stack on a GPU for all its language work.
Ollama can serve **multimodal vision models** (llava, llama3.2-vision, qwen2.5vl,
moondream) via the exact same `/api/generate` endpoint DINA already uses — you
just add an `images: [<base64>]` field to the request. So the most robust,
private, on-prem way to teach DINA to see is:

```
image bytes ──▶ validate & normalize ──▶ base64 ──▶ local vision model (Ollama, GPU)
                                                        │
                                                        ▼
                                      structured info: caption, objects, tags,
                                                     on-image text (OCR), colours
video ──▶ sample frames ──▶ (each frame as an image) ──▶ temporal synthesis (text model)
                                                        │
                                                        ▼
                                     narrative + timeline + objects across time
```

No third-party API, no data leaving the box, GPU-accelerated, and consistent with
the infrastructure DINA already trusts.

---

## 2. What was built

A new **self-contained module** — `src/modules/vision/` — modelled precisely on
the existing DIGIM web-research subsystem (its own config, its own concern, its
own model client, routed through the DUMP protocol). It is:

- **Disabled by default** (`DINA_VISION_ENABLED=false`) — a deploy with the code
  present but the flag unset loads no model, creates no tables, and touches no
  I/O. This is the **"no disruption to the ecosystem"** guarantee, proven by a
  clean `type-check` and `build`.
- **Fail-closed on security** — every image byte passes a guard that trusts
  *magic bytes*, not the caller's claimed type, and rejects oversize payloads and
  decompression bombs *before* any decode.
- **Separated by concern** — ingestion, security, model I/O, analysis, storage,
  and orchestration are distinct files with one responsibility each. No
  intertwined logic.

### Capabilities

**This milestone — full image analysis** (the three first-class tasks + a
combined structured pass):

| DUMP method | HTTP route | What it does |
|---|---|---|
| `vision_analyze_image` | `POST /vision/analyze-image` | Full structured pass: caption + objects + tags + OCR text + colours |
| `vision_describe` | `POST /vision/describe` | Rich natural-language **scene description** |
| `vision_ocr` | `POST /vision/ocr` | **Read text** visible in the image (OCR) |
| `vision_ask` | `POST /vision/ask` | **Visual question answering** (VQA) |
| `vision_status` | `GET /vision/status` | Subsystem status & advisories |
| `vision_prune` | `POST /vision/prune` | Retention sweep (trusted only) |

**Scaffolded but dormant — video (next phase, out of this milestone's scope):**
the `vision_analyze_video` path (frame sampling → per-frame analysis → temporal
synthesis) is built and unit-tested but is intentionally **not part of the image
milestone**. It exists as isolated, gated code so a later phase can turn it on
without a rewrite; it can also be removed cleanly if you'd rather keep the module
image-only for now.

---

## 3. How to enable it (operator guide)

1. **Install a vision model** in Ollama on the DINA host:
   ```bash
   ollama pull qwen2.5vl:7b    # ~7 GB — strong at describe + OCR + VQA (the default)
   # alternatives: ollama pull llama3.2-vision:11b   (higher accuracy, ~9.5 GB)
   #               ollama pull minicpm-v              (lighter, OCR-focused, ~6 GB)
   ```
2. **Provision the schema** (either boot with the flag, or run the migration):
   ```bash
   npm run migrate            # applies migrations/002_vision_schema.ts
   ```
3. **Set the flag** (PM2 env block / `.env`):
   ```bash
   DINA_VISION_ENABLED=true
   DINA_VISION_MODEL=qwen2.5vl:7b   # optional; this is the default
   ```
4. **Restart** and check status:
   ```bash
   curl -s https://localhost:8445/dina/api/v1/vision/status | jq
   ```

Every knob (limits, timeouts, models, remote-fetch, persistence) is an env var —
see [DESIGN.md § Configuration](./DESIGN.md#configuration).

### Example request

```bash
curl -X POST https://localhost:8445/dina/api/v1/vision/analyze-image \
  -H 'Content-Type: application/json' \
  -H 'x-user-key: <key>' \
  -d '{ "base64": "data:image/jpeg;base64,/9j/4AAQ...", "task": "full" }'
```

```jsonc
{
  "mediaId": "…", "sha256": "…", "mimeType": "image/jpeg",
  "width": 1920, "height": 1080, "task": "full", "model": "qwen2.5vl:7b",
  "cached": false, "processingTimeMs": 3120,
  "analysis": {
    "caption": "A red bicycle leaning against a brick wall in daylight.",
    "objects": ["bicycle", "brick wall"],
    "tags": ["outdoor", "urban", "bicycle"],
    "text": "",
    "colors": [{ "name": "red", "approxHex": "#c0392b" }],
    "safety": "safe",
    "confidence": 0.85
  }
}
```

---

## 4. Proofs (this is verifiable, not asserted)

All of the following were run in this environment against the pinned toolchain:

| Proof | Command | Result |
|---|---|---|
| **No build disruption** — the whole project still type-checks after every change | `npm run type-check` | **exit 0, clean** |
| **Full compile+emit** — the whole project (incl. vision) emits to JS | `npm run build` | **exit 0** |
| **Pure-logic correctness** — 81 hermetic assertions over probing, the security guard, frame sampling, and parsing | `npm run test:vision` | **81 passed, 0 failed** |
| **Minimal blast radius** — only 5 existing files touched, all additive | `git diff --stat` | **+363 / −4** |

The live-service paths (real model inference, DB persistence, remote fetch)
require a running Ollama + MySQL + Redis and are covered by the reproducible
manual runbook in [EDGE_CASES.md](./EDGE_CASES.md#manual-live-service-runbook).

---

## 5. Why this is safe to ship next to everything else

- **Off by default** → present-but-dormant; zero behavioural change until an
  operator opts in.
- **One additive field** on the shared `OllamaClient` (`images?`), attached to
  the request body only when non-empty → every existing text-only call is
  byte-for-byte identical to before.
- **Owns its own tables** (like DIGIM) → no change to `db.ts` schema.
- **Its own model client + concurrency semaphore** → vision jobs cannot starve
  chat/analysis of the GPU.
- **Reuses the hardened SSRF guard** for remote URLs rather than duplicating
  security-critical code.

See [INTEGRATION.md](./INTEGRATION.md) for the line-by-line change map and the
rollback procedure (delete the module + revert 5 files).
