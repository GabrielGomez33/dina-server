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
   - **Reusable technique — per-frame face detailer for FAR faces (proven in stills, carries to video):**
     img2img/gen preserves identity from the *pixels available*, so when the subject is far from
     camera the small face drifts to a generic one (confirmed on the hand-sign stills: closer =
     more faithful, farther = needs more identity). The fix that worked on stills — crop the face
     with a YOLO/SAM detector, re-render it at FULL resolution with the character LoRA, paste back
     (`saga-detail.sh --detect face`) — is per-*image*, so it applies to video frame-by-frame.
     Apply it on the **FLF keyframes** (not every tween — interpolation carries the corrected face
     across the segment) as a polish pass, keeping the detailer LoRA weight modest so the face stays
     anime. This is the video analogue of ADetailer-per-frame; it's a polish stage, not choreography.
3. **Speed defaults:** fp8+tiled_vae (safe now); everything else measured before it becomes a default.

Every "recommended default" above becomes a calibrated value in `modelRegistry` **only after we
measure it on the box** — no unverified number ships as a default.

## Prompt hygiene & the per-keyframe consistency layer (general, future-facing)

Recurring keyframe failures were all the same shape — no *shared* layer enforcing consistency and
suppressing artifact classes across every keyframe. The durable fixes (in `saga-jutsu-flf.sh`, and
worth replicating in any multi-keyframe driver):

- **Pose-words that name an entity summon that entity.** "boar seal / dragon seal" rendered ghostly
  boars/dragons in the background. **Describe poses geometrically** (finger positions), keep the
  entity name in a comment only. Force *exact* poses with ControlNet, never by naming them.
- **A single shared NEGATIVE feeds every keyframe AND the detailer.** It guards failure *classes*,
  not instances: hand mutations (`mutated/malformed hands, extra limbs`), entity bleed
  (`animal, creature, <the seal animals>`), wrong eye color (`blue/green/glowing eyes, heterochromia`),
  costume drift (`mask, hood, helmet`), wrong sex (`1girl`), `text/watermark`. Extend via `NEG=`.
- **Character attributes are PINNED across all keyframes** via env (`OUTFIT`, `EYES`) prepended to a
  shared BASE — so wardrobe/eye-color can't drift frame to frame. Keep the pin SIMPLE and matched to
  what the LoRA learned; vague/exotic outfits make the model invent a new costume per keyframe
  (`high-collar` → face mask).
- **Global sub-script defaults** (`saga-keyframe`, `saga-detail`) carry the universal hand/anatomy
  negatives so *every* generation benefits, not just the jutsu; scene-specific negatives layer on top.

Principle: consistency and artifact-suppression belong in a **shared layer applied to every frame**,
configurable per character/scene — not hand-patched per keyframe after the fact.

### Keyframe generation modes: anchor-chain (default) vs independent

Two ways to produce the keyframe set, selectable in `saga-jutsu-flf.sh` STEP 1 via
`KEYFRAME_MODE` (`--independent` flag flips it):

- **anchor-chain (default)** — "edit, don't redraw" (borrowed from Nano Banana / video content
  anchors). Generate K1 fully from the LoRA, then make every other keyframe an **img2img EDIT of the
  CLEAN K1** at `CHAIN_DENOISE` (~0.55): identity, outfit, framing and lighting are inherited from the
  anchor and only the hand pose changes. Editing the *same clean anchor* each time (never the previous,
  already-drifting frame) means error can't accumulate — the observed "no chaos" behavior. FLF still
  supplies the motion *between* keyframes; the chain only makes the keyframes mutually consistent.
- **independent (`--independent`)** — every keyframe generated from scratch (LoRA identity + pose
  prompt). More pose freedom, but higher inter-keyframe variance (jump-cut risk between beats).

Both modes share the *same* pose list (single source of truth) and the *same* `hand_fix` detailer,
so the only thing that varies is how the pixels for each keyframe are produced.

**One edit graph, three callers (DRY).** The img2img-edit graph lives in exactly one place —
`saga-edit.sh`, a single-concern primitive ("re-render one image toward a prompt at a denoise").
It is driven by (1) `saga-chain.sh` for keyframe chaining, (2) `saga-jutsu-flf.sh` anchor keyframes,
and (3) the planned front-end per-frame cleanup (Phase 5). `--prompt` is the *complete* positive —
the caller assembles identity/trigger/style; the primitive does not editorialize. This means a fix or
tuning to the edit path (sampler, VAE routing, resize) happens once and every caller inherits it.
