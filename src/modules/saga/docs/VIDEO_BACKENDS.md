# SAGA — Swappable Video Backends (Wan · FramePack · LTX-Video)

Goal: keep the entire A–Z pipeline (keyframes → references → per-frame face lock → grade →
shake) and make **only the motion generator swappable**, so the client can pick a model per
shot. Each backend gets its **own video LoRA** of the character (an SDXL image LoRA like
`animegabriel2` CANNOT be used by any video model — LoRAs are architecture-specific).

Status: **planning / install phase.** Wan 2.2 is live. FramePack + LTX drivers are built
against each model's ComfyUI nodes only after install (node schemas are verified live via
`/object_info`, exactly as we did for DWPreprocessor).

---

## 0. Python environments (IMPORTANT — never use the global `pip`)

There is no system `pip`. Each tool has its OWN environment; always call that env's python.

```bash
COMFY_PY="$SAGA_ROOT/engine/ComfyUI/venv/bin/python"     # ComfyUI + all its custom nodes
# install a custom node's requirements INTO ComfyUI's venv:
"$COMFY_PY" -m pip install -r <node>/requirements.txt
# (if pip is somehow missing in the venv:  "$COMFY_PY" -m ensurepip --upgrade )
```
diffusion-pipe (training) gets its **own separate venv** — see §4. Run node installs as the
user that owns the venv (`dina`), not `administrator`/root, so packages land with the right
perms. Restart after installing nodes:  `sudo pm2 restart saga-comfyui` (wait ~15s).

**The `saga-*.sh` tools are NOT on `PATH` by default.** They live in the repo checkout
(`/var/www/dina-server/src/modules/saga/scripts` on this box), not under `$SAGA_ROOT` (the
runtime data tree). Publish them ONCE to a stable run location with the installer, then add
that ONE dir to `PATH`:
```bash
# one-time: publish the tools to $SAGA_ROOT/bin (thin wrappers that run the repo scripts in
# place — they track the repo, so `git pull` updates the tools with NO re-install):
/var/www/dina-server/src/modules/saga/scripts/saga-install.sh
export PATH="$SAGA_ROOT/bin:$PATH"
echo 'export PATH="'"$SAGA_ROOT"'/bin:$PATH"' >> ~/.bashrc   # persist

saga-install.sh --check     # report install state (count, stale/broken, on-PATH)
```
After a `git pull` the wrappers already point at the updated scripts — no action needed. (Use
`saga-install.sh --copy` only if you want a frozen physical snapshot; it drifts and must be
re-run after every pull.) Every `saga-…` command below assumes `$SAGA_ROOT/bin` is on `PATH`.

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
COMFY_PY="$SAGA_ROOT/engine/ComfyUI/venv/bin/python"        # never the global pip — see §0
cd $SAGA_ROOT/engine/ComfyUI/custom_nodes
git clone https://github.com/kijai/ComfyUI-FramePackWrapper
"$COMFY_PY" -m pip install -r ComfyUI-FramePackWrapper/requirements.txt   # into ComfyUI's venv
sudo pm2 restart saga-comfyui                              # reload nodes (wait ~15s)
```
**Models for INFERENCE** (what the `saga-framepack.sh` driver loads — distinct from the
TRAINING weights in §4; verify exact filenames against the repos, versions move):
- FramePack transformer: `lllyasviel/FramePackI2V_HY` → `$SAGA_ROOT/models/diffusion_models/`
- HunyuanVideo VAE: `hunyuan_video_vae_bf16.safetensors` → `models/vae/`
- Text encoders: `llava-llama-3-8b-v1_1` (llm) + `clip-l` → `models/text_encoders/` (or `clip/`)

> ⚠️ Inference weights ≠ training weights. FramePack I2V single-files here let you *generate*
> video; training a HunyuanVideo LoRA needs the full-precision **base** HunyuanVideo tree —
> see §4. They're separate downloads.

**Verify after install:**
```bash
curl -s http://127.0.0.1:8188/object_info | jq -r 'keys[]' | grep -i framepack
```
Paste that output; the driver's node graph is finalized against it (like DWPreprocessor).

---

## 3. Install — LTX-Video (fast, long, efficient)

**ComfyUI nodes:** LTXV core nodes (`LTXVConditioning`, `EmptyLTXVLatentVideo`,
`LTXVScheduler`, …) are **already native** in this ComfyUI build — verified live via
`/object_info` (grep `ltxv`), so **no clone is needed for the base I2V path**. Only clone
`Lightricks/ComfyUI-LTXVideo` if you want the extended node set (spatial upscalers, prompt
enhancers); it is optional.
```bash
COMFY_PY="$SAGA_ROOT/engine/ComfyUI/venv/bin/python"        # never the global pip — see §0
cd $SAGA_ROOT/engine/ComfyUI/custom_nodes
git clone https://github.com/Lightricks/ComfyUI-LTXVideo       # OPTIONAL — extended nodes only
"$COMFY_PY" -m pip install -r ComfyUI-LTXVideo/requirements.txt
sudo pm2 restart saga-comfyui
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

diffusion-pipe needs its **own** venv (deepspeed/torch build differ from ComfyUI's — do NOT
install it into the ComfyUI venv). Use a real python3, not the global `pip`:
```bash
cd $SAGA_ROOT/engine
git clone --recurse-submodules https://github.com/tdrussell/diffusion-pipe
python3 -m venv .venv-dp
.venv-dp/bin/python -m pip install --upgrade pip
.venv-dp/bin/python -m pip install -r diffusion-pipe/requirements.txt
# training is then launched through THIS venv (saga-video-lora-train.sh expects `deepspeed`
# on PATH — activate first:  . $SAGA_ROOT/engine/.venv-dp/bin/activate )
```

**Reuse the existing curated dataset** — no re-shoot:
`users/gabrielgomez1/datasets/anime_curated` (the same anime images that trained
`animegabriel2`). diffusion-pipe takes a dataset TOML pointing at that folder + captions.

### 4a. HunyuanVideo base weights (required to train the hunyuan LoRA)

**VERIFIED against `models/hunyuan_video.py` in the installed diffusion-pipe:** this version
loads the **original Tencent HunyuanVideo layout** via a single `ckpt_path` base dir (NOT the
Kijai ComfyUI single-files). The loader hard-derives every sub-path, so you download the
official tree into one folder and the template's `ckpt_path` points at it:
```
$SAGA_ROOT/models/hunyuan-video/          ← ckpt_path
  hunyuan-video-t2v-720p/transformers/mp_rank_00_model_states.pt   (bf16 DiT, ~25GB)
  hunyuan-video-t2v-720p/vae/                                      (default vae_path)
  text_encoder/                            (llava, PREPROCESSED — default llm_path)
  text_encoder_2/                          (clip-l — default clip_path)
```
**One command provisions the whole tree** — `saga-hunyuan-fetch.sh` (idempotent, resumable):
```bash
. $SAGA_ROOT/engine/.venv-dp/bin/activate      # the venv with torch+transformers
$SAGA_ROOT/engine/.venv-dp/bin/python -m pip install -U "huggingface_hub[cli]"  # provides `hf`
# (if the tencent repo is gated:  hf auth login  with a token that accepted its terms)

saga-hunyuan-fetch.sh            # downloads dit+vae+llava+clip, extracts llava, verifies tree
saga-hunyuan-fetch.sh --check    # re-verify anytime (✓/✗ per component; exit 0 = ready)
```
It handles the two sharp edges we hit by hand:
- **`hf` `--include` takes ONE pattern** → it fetches the transformer as an exact filename and
  the vae dir with a single `--include`.
- **The vendored HunyuanVideo llava-preprocess script is broken against newer `transformers`**
  (`AttributeError: LlavaForConditionalGeneration has no attribute 'language_model'` — the
  backbone moved to `model.model.language_model`) **and forces the 16GB model onto the GPU
  (OOM on a shared card)**. The tool extracts the backbone *wherever the installed transformers
  exposes it*, **on CPU** — so it survives version drift and never fights Ollama/ComfyUI for VRAM.

The resulting tree (what `models/hunyuan_video.py` loads via `ckpt_path`):
```
$SAGA_ROOT/models/hunyuan-video/          ← ckpt_path (what lora_hunyuan.toml.tmpl points at)
  hunyuan-video-t2v-720p/transformers/mp_rank_00_model_states.pt   (bf16 DiT, ~25GB)
  hunyuan-video-t2v-720p/vae/                                      (default vae_path)
  text_encoder/                            (llava backbone, extracted — default llm_path)
  text_encoder_2/                          (clip-l — default clip_path)
```
> GPU: the llava extraction and the train itself want the card free — stop ComfyUI
> (`sudo pm2 stop saga-comfyui`) and unload Ollama first; `nvidia-smi` should show ~full VRAM.

(LTX and Wan LoRAs likewise need their own full-precision base weights — the GGUF you use for
Wan *inference* cannot train. Get those before `--model ltx` / `--model wan`.)

**Do not hand-write the configs** — `saga-video-lora-train.sh` fills the per-model TOML
templates (`src/modules/saga/training/{dataset,lora_wan,lora_hunyuan,lora_ltx}.toml.tmpl`)
from `@TOKENS@`, validates that no placeholder remains, and launches deepspeed. Output →
`$SAGA_ROOT/models/loras_video/<model>/<user>.safetensors`.
```bash
. $SAGA_ROOT/engine/.venv-dp/bin/activate     # diffusion-pipe venv (deepspeed on PATH)

# preview the generated config + command WITHOUT training (safe anywhere):
saga-video-lora-train.sh --user gabrielgomez1 --model hunyuan --dry-run

# real trains (serial — one 3090 Ti trains OR renders, not both):
saga-video-lora-train.sh --user gabrielgomez1 --model hunyuan   # FramePack
saga-video-lora-train.sh --user gabrielgomez1 --model ltx       # LTX
saga-video-lora-train.sh --user gabrielgomez1 --model wan       # Wan (native identity!)
```
Before a real run, open the generated `users/<user>/train/video_<model>/lora_<model>.toml`
and confirm the `[model]` paths point at your actually-installed weights (the templates carry
`VERIFY-LIVE` markers on every path).
> GPU note: one 3090 Ti = train OR render, not both (ComfyUI pauses during training), same as
> the SDXL LoRA. Trainings run serially.

Trigger word: reuse `animegabriel` for consistency with the existing prompt assembly.

### 4b. Environment setup for diffusion-pipe (run ONCE, in order)

The installed diffusion-pipe + its vendored HunyuanVideo target an OLDER torch/transformers
than this box's bleeding-edge stack (torch 2.13+cu130, transformers 5.x). Bridging that gap is
automated by **`saga-dp-setup.sh`** — run it, then fetch weights, then train:
```bash
. $SAGA_ROOT/engine/.venv-dp/bin/activate
saga-dp-setup.sh              # pin transformers<5, torch-family deps, patch reduction.py + attenion.py
saga-dp-setup.sh --check      # ✓/✗ per fix
saga-hunyuan-fetch.sh         # weights (AFTER transformers<5, so tokenizer saves in 4.x format)
saga-video-lora-train.sh --user gabrielgomez1 --model hunyuan
```
The fixes `saga-dp-setup.sh` applies — each was a real, diagnosed failure on the first train:

| Symptom | Cause | Fix |
|---|---|---|
| `CUDA_HOME does not exist` (deepspeed import) | driver present, **CUDA toolkit absent** | `sudo apt install cuda-toolkit-13-0`; export `CUDA_HOME=/usr/local/cuda-13.0` |
| `No module named 'torchvision' / 'torchaudio'` | torch-family deps missing | install from torch's own `…/whl/cu130` index (never downgrade torch) |
| `CLIPTextModel has no attribute 'text_model'`; `Llava…no attribute 'language_model'`; `TokenizersBackend does not exist` | **transformers 5.x** refactor | pin `transformers<5` (weights already on disk load fine) |
| `No module named 'torch._namedtensor_internals'` | torch 2.13 removed it | patch `utils/reduction.py` with a fallback |
| `flash_attn_varlen_func … 'NoneType' object is not callable` | flash-attn not installed (won't build on cu130) | patch `attenion.py` → **torch SDPA** fallback (block-diagonal via `cu_seqlens`) |
| `cuDNN version incompatibility (found 9.1.0)` | `LD_LIBRARY_PATH` leaked kohya **sd-scripts** venv's old cuDNN | trainer pins this venv's cuDNN first + strips foreign paths |
| `EADDRINUSE port 29500` | crashed prior run held the port | trainer auto-picks a free master port |
| `CUDA out of memory` at first step | activations don't fit 24GB | `activation_checkpointing = true` (the decisive fix) + a SMALL `blocks_to_swap` + `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` |

**Speed / `blocks_to_swap` tuning (important — over-swapping is the #1 way to make a train
needlessly slow).** `activation_checkpointing` alone frees most of the memory; `blocks_to_swap`
offloads transformer blocks to CPU RAM and every offloaded block is a **PCIe round-trip each
step**. Over-swap and the GPU sits at 100% "util" but low power, **stalling on transfers** — a
first-run mistake here left ~13GB VRAM idle (`nvidia-smi` showed 10/23GB) at `blocks_to_swap=30`
and made steps ~20s instead of ~5–10s. **Tune it against `nvidia-smi`:** start low (template
default 10), and if VRAM stays well under ~21GB during a run, drop toward `0` (no swap = fastest);
only raise it if you actually OOM. Also cut wall-clock with **fewer epochs** — 20–30 is plenty
for an identity LoRA; 100 overfits and wastes hours.

`saga-video-lora-train.sh` now sets `CUDA_HOME`, sanitizes `LD_LIBRARY_PATH`, disables wandb,
sets the allocator conf, and picks a free port automatically — so a normal run needs none of
this by hand. LTX/Wan will surface their own analogues; extend `saga-dp-setup.sh` as they land.

---

## 5. Build phases (tracked)

1. ⬜ Install FramePack nodes + HunyuanVideo models on the box; run `saga-framepack.sh --check`.
2. ⬜ Install LTX models (nodes are native); run `saga-ltx.sh --check`.
3. ⬜ `diffusion-pipe` up; train Hunyuan + LTX (+ optional Wan) LoRAs on `anime_curated`.
4. ✅ `saga-framepack.sh` + `saga-ltx.sh` built to the §1 interface. Each has a live
   `/object_info` `--check` preflight (fails loudly on a wrong/missing node) and a
   `--dump-graph` to inspect the exact wiring before GPU time. Graph JSON validated for the
   with-LoRA and no-LoRA paths and the orchestrator's exact call. **Node input names remain
   VERIFY-LIVE** — after install, run `--check` then a short `--dump-graph | jq` diff vs
   `/object_info`; fix any renamed input at the `build_graph` block (FramePack also exposes
   `FP_NODE_*` env overrides for renamed classes).
5. ✅ `VIDEO_BACKEND` dispatch + single-take branch wired into `saga-jutsu-flf.sh`:
   - STEP 0 runs the selected driver's `--check` (fail-fast) and gates the Wan-only node/model
     preflight so framepack/ltx don't demand Wan weights (they still need the SDXL keyframe
     stack, which authors K1).
   - STEP 2: for framepack/ltx, ONE continuous take from K1 + `TAKE_PROMPT` (env-overridable),
     `TAKE_SECONDS` long (default 15) — no FLF stitching, no seams. Reads `VIDEO_LORA`
     (+`VIDEO_LORA_WEIGHT`) from `models/loras_video/<backend>`; warns if unset (identity will
     drift — the "random guy") or missing.
   - STEP 3/4 (assemble/upscale/grade/shake) reused unchanged: a single clip concats to itself.
6. ⬜ Expose backend choice in the front-end (per-shot model selector). **Deferred — front end
   is a long way off. See §7 for the integration scope so nothing is a surprise later.**

Everything else (references, padding, face-restore, grade, shake, cuts/continuous) already
works and is reused as-is.

**Run it (once step 1–3 are done on the box):**
```bash
VIDEO_BACKEND=framepack VIDEO_LORA=gabrielgomez1.safetensors TAKE_SECONDS=15 \
  saga-jutsu-flf.sh …            # one 15s continuous take on FramePack
VIDEO_BACKEND=ltx VIDEO_LORA=gabrielgomez1.safetensors TAKE_SECONDS=20 \
  saga-jutsu-flf.sh …            # one 20s continuous take on LTX
```

---

## 6. Meanwhile: ~10s on Wan 2.2

Wan alone caps ~5s/81f per gen. ~10s options without a new model:
- **RIFLEx** (RoPE frequency extrapolation) node → ~2× length from the same Wan model + LoRA,
  modest quality cost. Install `ComfyUI-RIFLEx` (or the built-in RIFLEx option), set the
  extrapolation factor, raise the FLF `-L` toward ~160f. VRAM climbs with frame count — 10s
  (160f) at 1280×704 on 24GB is near the ceiling; drop to 960×544 if it OOMs.
- Or generate 81f and interpolate ×2 (`INTERPOLATE=1`) for smoothness at the same duration
  (not more content).

---

## 7. Front-end integration (DEFERRED — notes only, not started)

The front end is a long way off; this section just records what it will touch so it isn't a
surprise. **The bash scripts do NOT change** — they're the stable single-concern primitives the
TS layer already spawns (see `core/pipeline.ts`, `systems/workflowTemplates.ts`,
`systems/generationWorker.ts`). The work is at the TypeScript orchestration layer + CI, not here.

**Gap as of this writing:** the TS SAGA module has **zero awareness** of `VIDEO_BACKEND` /
`framepack` / `ltx` / `loras_video/` (grep confirms). So before any UI can offer a model
selector or "use my video LoRA", these must be registered server-side.

What the front end will require (all additive):

| Area | File(s) | What to add |
|---|---|---|
| Backend + LoRA registry | `core/modelRegistry.ts`, `core/methodRegistry.ts` | register `framepack`+`ltx` as selectable video backends; surface `models/loras_video/<backend>/*.safetensors` |
| **Identity method** selector | `core/methodRegistry.ts` + jutsu `--identity` | expose **`lora`** (trained per-user identity) vs **`instantid`** (`--zero-shot --face <photo>`, no training). LoRA = strongest, one train per user; zero-shot = instant, **the path that scales to many users**. Already wired in `saga-jutsu-flf.sh`; the UI just picks which. |
| Dispatch | `core/pipeline.ts`, `systems/workflowTemplates.ts`, `systems/generationWorker.ts` | pass `VIDEO_BACKEND`/`VIDEO_LORA`/`TAKE_SECONDS` env and call `saga-framepack.sh`/`saga-ltx.sh` (already spawns `saga-*.sh`) |
| Video-LoRA training | `core/loraTraining.ts` | new job type: `saga-dp-setup.sh` → `saga-hunyuan-fetch.sh` → `saga-video-lora-train.sh` (alongside the SDXL flow) |
| Queue / GPU | `systems/jobQueue.ts` + GPU arbiter | register video-LoRA training as a **long, GPU-exclusive** job (serialize vs render + Ollama) |
| Routes | saga routes (`routeContractTest`) | expose the per-shot data model (keyframe = prompt+reference; per-shot model selector) from `USER_STORAGE.md §7.10`; new endpoints ⇒ new route-contract tests |
| Progress (optional) | scripts + `systems/progressMapper.ts` | optionally add a `--json` progress mode to the scripts for clean UI streaming; else `progressMapper` parses existing `steps: N loss: …` lines |
| UI | `ui/` (has `tokens.css`, `styleguide.html`) | build the client against the design tokens already present |

**CI note:** quality gates are `tsc --noEmit` (strict) → `npm run build` → `npm audit
--audit-level=high` (no jest gate). Any TS added must pass strict type-check. `npm run build` is
`tsc → dist/` (the **server** only); an in-repo browser UI needs a **separate front-end build
step added to `.github/workflows/ci-cd.yml`**, and its deps must stay clean for `npm audit`.

Bottom line: front-end enablement = (a) add a UI build to CI, (b) register the new backends +
video-LoRA training into the existing TS registries/worker/routes, (c) build the UI. The scripts
and training pipeline proven in §4/§4b are the untouched foundation underneath.
