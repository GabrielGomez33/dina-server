# SAGA — Anime Pipeline Research (2025–2026)

> Source: deep-research pass (106 agents, 24 sources fetched, 26 claims → 22 confirmed / 3 refuted
> via 3-vote adversarial verification). Each item is tagged **[VERIFIED]** (survived adversarial
> verification, cited primary source) or **[LEAD]** (search-surfaced, single-source, *did not*
> survive verification — we validate these ourselves on the box). Honesty about which is which is
> the whole point.

## Executive read

The evidence is strong and citable for **anime image base models, refinement, upscaling, and
interpolation**. It is genuinely sparse for the **video core, character-consistency method, and
speed-distillation numbers** — nearly all such claims rested on single blog posts and were refuted
or dropped. So: the image pipeline we standardize on citations; the video pipeline we standardize
on our own measured tests.

---

## A. Anime IMAGE pipeline — evidence-backed

### Base model [VERIFIED]
Two SDXL-derived anime families are the current standard:
- **Animagine XL 4.0** — retrained from SDXL 1.0 on ~8.4M anime images. Settings: **Euler a,
  25–28 steps, CFG 5–6, 1024×1024**, Danbooru-tag prompting + quality tags (`masterpiece, high
  score, great score`). (huggingface.co/cagliostrolab/animagine-xl-4.0)
- **Illustrious XL / NoobAI-XL** — SDXL anime family; **CFG ~5 (4.0–6.5), 24–28 steps (30+ hi-res),
  `euler_ancestral` or `DPM++ 2M Karras`**, 1024 baseline + 832×1216 / 1216×832 / 1344×768 buckets.
  (github.com/regiellis/ComfyUI-EasyIllustrious)

**[LEAD]** Community sources rate **Illustrious XL the superior 2025 base** (Danbooru2023 dataset,
strong character knowledge *without* LoRA) with the largest character-LoRA ecosystem; NoobAI-XL a
close alternative. Not verified — **decision: download Illustrious and A/B it against Animagine on
the box before standardizing.**

### Refinement (hands/faces) [VERIFIED]
`ComfyUI-Impact-Pack` → **FaceDetailer** driven by SAM/BBOX/SEGM detectors, plus **IterativeUpscale**.
The `hand_yolov8` / `face_yolov8` detectors are **NOT** in the main pack — they need
`ComfyUI-Impact-Subpack` (`UltralyticsDetectorProvider`). *(We already installed both.)*
(github.com/ltdrdata/ComfyUI-Impact-Pack, /ComfyUI-Impact-Subpack)

### Upscaling to 1080p→2K [VERIFIED]
**SUPIR** (`ComfyUI-SUPIR`): 512→3072 on 24 GB; with an **fp8 UNet** → 512→2048 under 10 GB. Key
constraint for us: **fp8 on the VAE causes artifacts — use `tiled_vae` instead.** Checkpoints v0Q
(quality, default) / v0F (detail). Requires an SDXL base loaded alongside. (github.com/kijai/ComfyUI-SUPIR)

### Recommended image pipeline
`Illustrious/Animagine base (CFG 5, 26 steps, DPM++ 2M Karras)` → `FaceDetailer (face + hand_yolov8)`
→ `SUPIR fp8 + tiled_vae` upscale. Reference identity via IP-Adapter (have it); pose via ControlNet
(have it); recurring characters via a trained LoRA (see §C).

---

## B. True anime VIDEO pipeline — leads, to be validated on the box

**No video claim survived adversarial verification** — treat all as hypotheses to test.

- **[LEAD] AnimateDiff is an SD1.5 motion adapter and does NOT support SDXL natively** (reported
  broken/disappointing on SDXL). Implication: an AnimateDiff route means an **SD1.5 anime checkpoint**
  (older, lower-res) — a real style/quality tradeoff. (civitai.com/articles/19005)
- **[LEAD] Wan 2.2 + an anime-style LoRA** is the community's current "true anime motion on SDXL-era
  quality" answer; anime-style Wan 2.2 i2v LoRAs exist. (civitai.com/models/2222779)
- **[LEAD] LightX2V / Wan2.2-Lightning speed LoRA collapses Wan 2.2 to ~4 steps at CFG ~1** — the
  single biggest video speedup on a 24 GB card. (nextdiffusion.ai/…wan2-2-lightx2v-lora)

**Decision (empirical):** test **Path 1 — Wan 2.2 + anime-style LoRA + LightX2V speed LoRA** first
(we already run Wan; least divergent; the speed LoRA targets our 373 s → ~1 min problem *and* an
anime LoRA targets the "not anime" problem). If it can't hold flat 2D, fall back to **Path 2 —
AnimateDiff on an SD1.5 anime checkpoint**. Character consistency across frames is carried by the
image-side LoRA/reference, not the video model.

---

## C. Character consistency — leads, to be validated

**No consistency claim survived verification.** The practitioner consensus (unverified) is the
familiar ladder we already documented: IP-Adapter (identity nudge) < ControlNet (pose lock) <
**trained character LoRA (kohya_ss/sd-scripts) = the reliable answer for a recurring character**.
Matches `TOOLCHAIN.md` / `REFERENCE_FIDELITY.md`. **Decision: unchanged — a per-character LoRA is
the consistency backbone; validate the training workflow when we build the first real character.**

---

## D. Speed optimizations

- **[VERIFIED, negative]** The claim that **TeaCache is incompatible with GGUF / SageAttention was
  REFUTED** (0-3). So these are *stackable*; we just have no verified speedup numbers.
  (github.com/kijai/ComfyUI-KJNodes/issues/267)
- **[VERIFIED]** SUPIR: **fp8 UNet + tiled_vae** is the memory-safe config (fp8 VAE = artifacts).
- **[LEAD]** LightX2V/Lightning distillation LoRA → ~4 steps for Wan (validate the speedup + quality).
- **[UNVERIFIED]** CausVid / LCM / Hyper-SD / DMD2 / SageAttention / FlashAttention / torch.compile —
  no surviving figures. **Decision: measure each on the box before making any a default.**

## E. Frame interpolation [VERIFIED]
`ComfyUI-Frame-Interpolation`: **RIFE** (v4.0–4.9) and **FILM** are the flexible-multiplier standards
(newer STMFNet/FLAVR/ATM-VFI are 2×-only). Use `clear_cache_after_n_frames` for OOM safety on a
shared card. Belongs as the **final** post-generation step. (github.com/Fannovel16/ComfyUI-Frame-Interpolation)

---

## What this changes in our build

Nothing architectural — the registry/templates/fidelity/worker are model-agnostic by design. It
changes *which profiles we add and validate*:
1. **Image:** add an **Illustrious** profile; A/B vs Animagine; then wire the **detailer** + **SUPIR**
   stages as templates (all installed).
2. **Video:** add a **LightX2V speed LoRA** + an **anime-style LoRA** to the Wan path and measure
   (speed + true-2D); fall back to AnimateDiff-SD1.5 only if needed.
3. **Speed defaults:** fp8+tiled_vae (safe now); everything else measured before it becomes a default.

Every "recommended default" above becomes a calibrated value in `modelRegistry` **only after we
measure it on the box** — no unverified number ships as a default.
