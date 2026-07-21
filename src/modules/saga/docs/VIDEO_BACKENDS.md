# SAGA — Swappable Video Backends (Wan · FramePack · LTX-Video)

Goal: keep the entire A–Z pipeline (keyframes → references → per-frame face lock → grade →
shake) and make **only the motion generator swappable**, so the client can pick a model per
shot. Each backend gets its **own video LoRA** of the character (an SDXL image LoRA like
`animegabriel2` CANNOT be used by any video model — LoRAs are architecture-specific).

Status: **planning / install phase.** Wan 2.2 is live. FramePack + LTX drivers are built
against each model's ComfyUI nodes only after install (node schemas are verified live via
`/object_info`, exactly as we did for DWPreprocessor).

---

## 1. Architecture — one pipeline, pluggable motion

Selector: `VIDEO_BACKEND=wan | framepack | ltx` (in `saga-jutsu-flf.sh`).

Two motion paradigms; everything else is shared:

| Layer | Shared across backends? | Module |
|---|---|---|
| Keyframes (identity + pose refs) | ✅ | `saga-keyframe.sh` / `saga-edit.sh` |
| Reference control (canny/dwpose) + padding | ✅ | `saga-*`, `saga-pad-refs.sh` |
| **Motion generation** | ❌ **swappable** | `saga-flf.sh` (wan) · `saga-framepack.sh` · `saga-ltx.sh` |
| Face-restore, grade, shake, upscale | ✅ | `saga-face-restore.sh`, `saga-grade.sh`, `saga-shake.sh`, … |

**Paradigm A — segmented (Wan FLF):** keyframe pairs (K1→K2→…) each interpolated, then
concatenated. Precise per-seal keyframes; ~5s cap per gen. Current default.

**Paradigm B — single-take (FramePack, LTX):** ONE continuous generation from a *start*
keyframe + a full-jutsu prompt, 15–20s+. Mid-seals are prompt-driven (not frame-pinned).
This is the "one gen, one scene" path. With a video LoRA trained on the character, identity
is native → no drift, no face-restore hack needed.

### Common driver interface (every backend script implements this)
```
saga-<backend>.sh  -a START.png  -p "motion prompt"  -L FRAMES  --fps N  -W N -H N
                   -s SEED  [--lora VIDEO_LORA --lora-weight F]  [-b END.png]  -o NAME
   → writes $SAGA_ROOT/tmp/<NAME>.mp4
```
`-b END.png` (last frame) is optional: Wan requires it (FLF); FramePack/LTX ignore it (I2V
forward from `-a`). The jutsu dispatches to the selected backend with these args, so adding a
backend never touches the orchestrator's other steps.

---

## 2. Install — FramePack (HunyuanVideo, long single-take on low VRAM)

FramePack generates in sections with an anti-drift compressed context → 15–60s on ≤24GB.

**ComfyUI nodes:** `kijai/ComfyUI-FramePackWrapper` (or `ComfyUI-FramePack`).
```bash
cd $SAGA_ROOT/engine/ComfyUI/custom_nodes
git clone https://github.com/kijai/ComfyUI-FramePackWrapper
pip install -r ComfyUI-FramePackWrapper/requirements.txt   # into the ComfyUI venv
```
**Models** (HuggingFace — verify exact filenames against the repos, versions move):
- FramePack transformer: `lllyasviel/FramePackI2V_HY` → `$SAGA_ROOT/models/diffusion_models/`
- HunyuanVideo VAE: `hunyuan_video_vae_bf16.safetensors` → `models/vae/`
- Text encoders: `llava-llama-3-8b-v1_1` (llm) + `clip-l` → `models/text_encoders/` (or `clip/`)

**Verify after install:**
```bash
curl -s http://127.0.0.1:8188/object_info | jq -r 'keys[]' | grep -i framepack
```
Paste that output; the driver's node graph is finalized against it (like DWPreprocessor).

---

## 3. Install — LTX-Video (fast, long, efficient)

**ComfyUI nodes:** native LTXV support ships with recent ComfyUI; plus
`Lightricks/ComfyUI-LTXVideo` for the full node set.
```bash
cd $SAGA_ROOT/engine/ComfyUI/custom_nodes
git clone https://github.com/Lightricks/ComfyUI-LTXVideo
pip install -r ComfyUI-LTXVideo/requirements.txt
```
**Models** (HF `Lightricks/LTX-Video` — pick one tier):
- `ltxv-13b-0.9.x.safetensors` (higher quality) or `ltx-video-2b-v0.9.5.safetensors` (faster)
  → `models/checkpoints/`
- T5-XXL text encoder (`google/t5-v1_1-xxl` or the packaged `PixArt` T5) → `models/text_encoders/`

**Verify:**
```bash
curl -s http://127.0.0.1:8188/object_info | jq -r 'keys[]' | grep -iE 'ltxv|ltx'
```

---

## 4. Video LoRA training (the identity unlock)

One tool covers all three video models: **`diffusion-pipe`** (tdrussell) — trains Wan,
HunyuanVideo (FramePack), and LTX-Video LoRAs from an **image** dataset (fine for character
identity). (`kohya-ss/musubi-tuner` is an alternative for Wan + Hunyuan.)

```bash
cd $SAGA_ROOT/engine
git clone https://github.com/tdrussell/diffusion-pipe
python -m venv .venv-dp && . .venv-dp/bin/activate && pip install -r diffusion-pipe/requirements.txt
```

**Reuse the existing curated dataset** — no re-shoot:
`users/gabrielgomez1/datasets/anime_curated` (the same anime images that trained
`animegabriel2`). diffusion-pipe takes a dataset TOML pointing at that folder + captions.

Per-model config (one TOML each; set the model path + `type = 'hunyuan-video' | 'ltx-video' | 'wan'`):
```
# dataset.toml (shared)
[[directory]]
path = '/mnt/.../users/gabrielgomez1/datasets/anime_curated'
num_repeats = 10
resolutions = [512, 768]
```
Train (per model), output → `$SAGA_ROOT/models/loras_video/<model>/gabrielgomez1.safetensors`:
```bash
deepspeed --num_gpus=1 train.py --deepspeed --config configs/hunyuan_gabriel.toml   # FramePack
deepspeed --num_gpus=1 train.py --deepspeed --config configs/ltx_gabriel.toml       # LTX
deepspeed --num_gpus=1 train.py --deepspeed --config configs/wan_gabriel.toml        # Wan (native identity!)
```
> GPU note: one 3090 Ti = train OR render, not both (ComfyUI pauses during training), same as
> the SDXL LoRA. Trainings run serially.

Trigger word: reuse `animegabriel` for consistency with the existing prompt assembly.

---

## 5. Build phases (tracked)

1. ⬜ Install FramePack nodes + HunyuanVideo models on the box; paste `/object_info` FramePack keys.
2. ⬜ Install LTX nodes + models; paste `/object_info` LTX keys.
3. ⬜ `diffusion-pipe` up; train Hunyuan + LTX (+ optional Wan) LoRAs on `anime_curated`.
4. ⬜ Build `saga-framepack.sh` + `saga-ltx.sh` to the §1 interface, graphs finalized vs `/object_info`.
5. ⬜ Add `VIDEO_BACKEND` dispatch + single-take branch to `saga-jutsu-flf.sh` (start-frame + full-jutsu prompt).
6. ⬜ Expose backend choice in the front-end (per-shot model selector).

Everything else (references, padding, face-restore, grade, shake, cuts/continuous) already
works and is reused as-is.

---

## 6. Meanwhile: ~10s on Wan 2.2

Wan alone caps ~5s/81f per gen. ~10s options without a new model:
- **RIFLEx** (RoPE frequency extrapolation) node → ~2× length from the same Wan model + LoRA,
  modest quality cost. Install `ComfyUI-RIFLEx` (or the built-in RIFLEx option), set the
  extrapolation factor, raise the FLF `-L` toward ~160f. VRAM climbs with frame count — 10s
  (160f) at 1280×704 on 24GB is near the ceiling; drop to 960×544 if it OOMs.
- Or generate 81f and interpolate ×2 (`INTERPOLATE=1`) for smoothness at the same duration
  (not more content).
