# SAGA — The Complete Toolchain

> "Sharpen the blade." This is the full inventory of every tool required to take a project
> from a song + a story to a finished, mouth-synced, upscaled anime video on a **single
> RTX 3090 Ti (24 GB) shared with Ollama**. It is honest about what is solved, what is hard,
> and what we cannot fully reach. Nothing here is aspirational hand-waving — every row names a
> real, runnable tool.

## The one constraint that shapes everything

One 24 GB GPU. Ollama already holds ~10 GB resident (LLM + embeddings). Therefore the pipeline
is **a sequence of stages, not a pile of models loaded at once**. Each stage loads its model,
runs, and releases; the **GPU Arbiter** (already built, `src/modules/gpu`) orders these turns so
they never collide and Ollama still gets served. Image gen (~7 GB) proven to coexist with Ollama
live; the heavy video models require the arbiter to *drain* Ollama for an exclusive turn.

Legend:  ✅ installed & proven · 🟡 built in repo, not yet wired to engine · ⏳ downloading/next · ⬜ planned

---

## Stage 1 — Base image generation

| Capability | Tool | VRAM | Status |
|---|---|---|---|
| Orchestration engine | **ComfyUI** (pinned v0.28.0) | — | ✅ |
| Anime base model | **Animagine XL 4.0** | ~7 GB | ✅ |
| Realistic / various base | **FLUX.1 schnell (fp8)** | ~12 GB | ✅ |
| Prompt hygiene (LLM → clean tags) | `core/promptNormalizer.ts` | — | ✅ |
| Injection-safe graph binding | `systems/workflowTemplates.ts` | — | ✅ |

## Stage 2 — Consistency stack (the pillar)

A text prompt is a probability distribution, not a specification — it cannot pin identity or
count. Each rung below adds determinism. This is where character coherence across a whole video
is won or lost.

| Rung | Gives you | Tool | VRAM | Status |
|---|---|---|---|---|
| Seed lock | Bit-reproducible re-runs | KSampler seed | — | ✅ |
| Reference / identity | "Emulate *this* subject" | **IP-Adapter** (`ComfyUI_IPAdapter_plus` + `ip-adapter-plus_sdxl_vit-h` + CLIP-ViT-H) | +1 GB | ⏳ / 🟡 template built |
| Structural control | Exact pose, framing, single-figure (kills the phantom second entity) | **ControlNet SDXL** (openpose / depth / canny / lineart) | +2.5 GB ea | ⬜ |
| Named character | A repeatable, trainable character | **LoRA** (train via `kohya_ss` / `sd-scripts`) | train ~12 GB | ⬜ |

## Stage 3 — Refinement (turns "6 fingers" into clean)

Bad hands/faces are a **universal** diffusion weakness, not an Animagine defect. Every serious
pipeline has this stage. It is the honest answer to "will the quality be good enough": yes —
*after* refinement, not from a raw first pass.

| Capability | Tool | VRAM | Status |
|---|---|---|---|
| Hand/face auto-repair (detect → inpaint region at hi-res) | **ComfyUI-Impact-Pack** (FaceDetailer) + `hand_yolov8` / `face_yolov8` | +2–4 GB | ⬜ |
| Hi-res fix (more pixels = fewer errors) | latent upscale + 2nd pass | included | ⬜ |
| Final upscale to 1080p→2K | **4x-UltraSharp / Real-ESRGAN**, or **SUPIR** (heavier, best) | 4–12 GB | ⬜ |
| Tiled upscale for large frames | **Ultimate SD Upscale** | scales w/ tile | ⬜ |

## Stage 4 — Motion / video

No open model does a clean 20 s single take. Real approach: **generate in chunks + keyframe +
interpolate + stitch.** Model choice is a quality/VRAM tradeoff:

**Decision: Wan 2.2 TI2V-5B is the video engine** (image→video; animate our proven Animagine
stills). AnimateDiff was evaluated and **dropped** — SDXL motion modules are too weak, and a dead
node is a liability. Output is assembled to mp4 by **VideoHelperSuite (VHS_VideoCombine)**.

| Option | Best for | VRAM (on our card) | Status |
|---|---|---|---|
| **Wan 2.2 TI2V-5B** ← chosen | Image→video, 720p, keeps our stills | ~16–18 GB (heavy → exclusive lease) | ✅ downloaded |
| **VHS_VideoCombine** (output) | frames → mp4 + audio mux | — | 🔧 installing |
| ~~AnimateDiff~~ | dropped — motion too weak | — | ❌ removed |
| **LTX-Video (2B)** | optional fast previs later | ~10 GB | ⬜ |
| **30→60 fps for action** | Frame interpolation, not native render | **RIFE / FILM** (`ComfyUI-Frame-Interpolation`), light | ⬜ |
| Longer clips (~20 s) | chunk + keyframe + stitch | Wan chained segments | ⬜ |

## Stage 5 — Audio (local, realistic, persona-instructable)

You bring the music; SAGA generates **vocals/dialogue** and analyzes the track.

| Capability | Tool | VRAM | Status |
|---|---|---|---|
| Persona-by-description TTS ("old man, sickly, coughing") | **Parler-TTS** (voice described in text) | ~4 GB | ⬜ |
| Voice-clone TTS (natural, expressive) | **F5-TTS** / **XTTS-v2** / **StyleTTS2** | 2–4 GB | ⬜ |
| Vocal stem isolation (for sync/align) | **Demucs** / UVR | ~4 GB | ⬜ |
| Beat / tempo / structure | **librosa** / **madmom** | CPU | ⬜ |
| Word-level timestamps (lyric sync) | **WhisperX** forced alignment | 2–4 GB | ⬜ |

## Stage 6 — Mouth / lip sync (the hardest capability)

Honest: realistic sync is solved; **anime singing-sync is cutting-edge and will be
approximate.** Pipeline: Demucs isolates the vocal → WhisperX gives phoneme/word timing →
drive the mouth.

| Capability | Tool | VRAM | Status |
|---|---|---|---|
| Realistic face lip-sync | **LatentSync** (best) / **Wav2Lip-HD** | 5–8 GB | ⬜ |
| Talking-head from still (head + lips) | **SadTalker** | ~4 GB | ⬜ |
| Anime mouth sync | Viseme mapping (phoneme→mouth-shape) + ControlNet | built on Stage 2 | ⬜ (research) |

## Stage 7 — Pre-production (mostly orchestration, little new VRAM)

| Capability | Tool | Status |
|---|---|---|
| Shot list / scene breakdown | **Dina (Ollama)** structured output | ⬜ |
| Storyboards / concept art | Stage 1 image gen, low-fi | ⬜ |
| Animatic (boards timed to audio) | **ffmpeg** + timing from Stage 5 | ⬜ |
| Previs (rough motion) | **LTX-Video** low-step | ⬜ |

## Stage 8 — Assembly / post

| Capability | Tool | Status |
|---|---|---|
| Concat, mux audio, fps, encode 1080p/2K | **ffmpeg** (h264/h265) | ⬜ |
| Compositing / overlays | ComfyUI or ffmpeg filtergraph | ⬜ |

## SAGA's own infrastructure (the parts we write)

| Piece | Purpose | Status |
|---|---|---|
| **GPU Arbiter** | Time-share the one GPU; drain Ollama for heavy stages | ✅ built (dark) |
| Tenancy / storage / quota | Multi-tenant isolation on disk | ✅ |
| DUMP module + routes | API surface, authz, audit | ✅ |
| Job queue | Durable generation jobs | 🟡 stub (BullMQ planned) |
| Model registry | Which model/template per job kind | ⬜ |
| Calibration runner | Measure real seconds/VRAM per stage → feeds ETA | ⬜ |
| WS progress | Live per-job progress to UI | 🟡 mapper built |
| Refinement + upscale nodes | Stage 3 wrappers | ⬜ |

---

## VRAM budget (why the arbiter is not optional)

| Stage | Peak VRAM | Coexist with Ollama (~10 GB)? |
|---|---|---|
| Image (SDXL) | ~7 GB | ✅ proven live (~13 GB total) |
| Image + IP-Adapter + detailer | ~12–14 GB | ✅ tight but fits |
| Upscale (SUPIR) | ~12 GB | ⚠️ arbiter should drain |
| Video (AnimateDiff / Wan-1.3B / LTX) | ~10–16 GB | ⚠️ arbiter drains Ollama |
| Video (Wan-2.2 / Hunyuan fp8) | 16–24 GB | ❌ exclusive turn required |
| TTS / lip-sync | 2–8 GB | ✅ |

The finished-video pipeline is a **relay**: image → refine → upscale → animate → interpolate →
tts → lipsync → assemble. Each stage hands the GPU to the next. The arbiter is what makes that
relay safe on one card that Ollama is also using.

---

## What will be hard, and what we cannot fully reach

Told straight, so there are no surprises:

- **Anime singing lip-sync** — the frontier. We will get close via viseme mapping, not perfect.
- **A clean 20 s single-take dialogue shot** — no model does this in one pass; we stitch and
  keyframe. Achievable, with seams to manage.
- **Flawless hands in motion** — mitigated by the detailer per keyframe, never guaranteed frame-perfect.
- **Native 2K from a video model** — we render lower and upscale; true-native 2K video is out of
  budget on 24 GB.
- **Real-time** — this is render-farm work: minutes per clip, not live.
- **Human-artist frame-by-frame fidelity** — we close the gap as far as local open-source allows;
  the detailer + consistency + upscale stack gets us to production-grade *stylized* output.

Everything else in the stated goal — anime + all-types video, your music, persona-instructed
local vocals, beat/lyric sync, 1080p→2K, 30/60 fps, full pre-production — is reachable with the
tools above. The work is wiring them into the relay, one proven stage at a time.
