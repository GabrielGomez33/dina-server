#!/usr/bin/env bash
# ============================================================================
# saga-hunyuan-fetch.sh — provision HunyuanVideo TRAINING base weights (diffusion-pipe)
# ----------------------------------------------------------------------------
# One idempotent, resumable command to lay down the exact tree that the installed
# diffusion-pipe's models/hunyuan_video.py loads via `ckpt_path`:
#
#   <dest>/hunyuan-video-t2v-720p/transformers/mp_rank_00_model_states.pt   (bf16 DiT)
#   <dest>/hunyuan-video-t2v-720p/vae/                                      (default vae_path)
#   <dest>/text_encoder/      (llava text backbone — VERSION-PROOF extraction, see below)
#   <dest>/text_encoder_2/    (clip-l)
#
# WHY THIS EXISTS (don't delete and hand-run again): the vendored HunyuanVideo
# preprocess script (submodules/HunyuanVideo/.../preprocess_text_encoder_tokenizer_utils.py)
# hardcodes `model.language_model` and `.to(0)`. Against a NEWER transformers the llava
# submodule moved to `model.model.language_model`, so that script dies with
# `AttributeError: ... has no attribute 'language_model'`; it also OOMs by forcing the
# 16GB model onto a shared GPU. This tool locates the language model wherever the installed
# transformers puts it and extracts it on CPU — so it keeps working across version drift and
# never fights Ollama/ComfyUI for VRAM.
#
#   saga-hunyuan-fetch.sh [--dest DIR] [--check] [--skip-download] [--force]
#     --dest DIR       target (default $SAGA_ROOT/models/hunyuan-video)
#     --check          verify the tree only (✓/✗ per component), exit 0 if complete
#     --skip-download  only (re)run the llava preprocess + verify (weights already pulled)
#     --force          re-download / re-extract even if present
#
# Env: SAGA_ROOT (required)
#      DP_ROOT=$SAGA_ROOT/engine/diffusion-pipe      (for the submodule + venv python)
#      DP_PY  =$SAGA_ROOT/engine/.venv-dp/bin/python  (the venv with torch+transformers)
# Needs: the `hf` CLI (huggingface_hub[cli]) on PATH, logged in if the repo is gated
#        (`hf auth login`). ~45GB, resumable.
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
DP_ROOT="${DP_ROOT:-$SAGA_ROOT/engine/diffusion-pipe}"
DP_PY="${DP_PY:-$SAGA_ROOT/engine/.venv-dp/bin/python}"
DEST="$SAGA_ROOT/models/hunyuan-video"
CHECK=0; SKIP_DL=0; FORCE=0

die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --dest) DEST="$2"; shift 2;;
  --check) CHECK=1; shift;;
  --skip-download) SKIP_DL=1; shift;;
  --force) FORCE=1; shift;;
  -h|--help) sed -n '2,38p' "$0"; exit 0;;
  *) die "unknown arg: $1 (see --help)";;
esac; done

DIT="$DEST/hunyuan-video-t2v-720p/transformers/mp_rank_00_model_states.pt"
VAE="$DEST/hunyuan-video-t2v-720p/vae"
LLAVA_RAW="$DEST/llava-raw"
TENC="$DEST/text_encoder"
TENC2="$DEST/text_encoder_2"

verify(){ # prints ✓/✗ per component; returns 0 only if all present
  local ok=0
  [ -f "$DIT" ]   && echo "  ✓ dit   ($DIT)"   || { echo "  ✗ dit   MISSING: $DIT"; ok=1; }
  [ -d "$VAE" ] && [ -n "$(ls -A "$VAE" 2>/dev/null)" ] && echo "  ✓ vae   ($VAE)"   || { echo "  ✗ vae   MISSING: $VAE"; ok=1; }
  [ -f "$TENC/config.json" ]  && echo "  ✓ llava ($TENC)"  || { echo "  ✗ llava MISSING: $TENC/config.json"; ok=1; }
  [ -f "$TENC2/config.json" ] && echo "  ✓ clip  ($TENC2)" || { echo "  ✗ clip  MISSING: $TENC2/config.json"; ok=1; }
  return $ok
}

if [ "$CHECK" -eq 1 ]; then
  echo "HunyuanVideo training-weights tree: $DEST"; verify; s=$?
  [ $s -eq 0 ] && { echo "  ✅ complete — ckpt_path='$DEST' is ready to train"; du -sh "$DEST" 2>/dev/null; } || echo "  ⚠ incomplete — run: saga-hunyuan-fetch.sh"
  exit $s
fi

# ---- downloads (skippable / idempotent) ------------------------------------
if [ "$SKIP_DL" -eq 0 ]; then
  command -v hf >/dev/null || die "'hf' CLI not found. Install: $DP_PY -m pip install -U 'huggingface_hub[cli]'"
  mkdir -p "$DEST" || die "cannot create $DEST"

  if [ "$FORCE" -eq 1 ] || [ ! -f "$DIT" ]; then
    echo "▶ transformer (bf16 DiT, ~25GB — resumable)…"
    hf download tencent/HunyuanVideo \
      hunyuan-video-t2v-720p/transformers/mp_rank_00_model_states.pt --local-dir "$DEST" \
      || die "transformer download failed (gated? run: hf auth login)"
  else echo "▶ transformer present — skip (use --force to redo)"; fi

  if [ "$FORCE" -eq 1 ] || [ ! -d "$VAE" ] || [ -z "$(ls -A "$VAE" 2>/dev/null)" ]; then
    echo "▶ vae…"
    hf download tencent/HunyuanVideo --include "hunyuan-video-t2v-720p/vae/*" --local-dir "$DEST" \
      || die "vae download failed"
  else echo "▶ vae present — skip"; fi

  if [ "$FORCE" -eq 1 ] || [ ! -d "$LLAVA_RAW" ] || [ -z "$(ls -A "$LLAVA_RAW" 2>/dev/null)" ]; then
    echo "▶ llava (raw, ~16GB — resumable)…"
    hf download xtuner/llava-llama-3-8b-v1_1-transformers --local-dir "$LLAVA_RAW" \
      || die "llava download failed"
  else echo "▶ llava raw present — skip"; fi

  if [ "$FORCE" -eq 1 ] || [ ! -f "$TENC2/config.json" ]; then
    echo "▶ clip-l…"
    hf download openai/clip-vit-large-patch14 --local-dir "$TENC2" || die "clip download failed"
  else echo "▶ clip present — skip"; fi
fi

# ---- llava preprocess: VERSION-PROOF, CPU-only (the whole reason this tool exists) ----
if [ "$FORCE" -eq 1 ] || [ ! -f "$TENC/config.json" ]; then
  [ -x "$DP_PY" ] || die "diffusion-pipe venv python not found: $DP_PY (set DP_PY=…)"
  [ -d "$LLAVA_RAW" ] || die "llava-raw missing at $LLAVA_RAW (download it, or drop --skip-download)"
  echo "▶ extracting llava text backbone → text_encoder/ (CPU, transformers-version-proof)…"
  HV_RAW="$LLAVA_RAW" HV_OUT="$TENC" CUDA_VISIBLE_DEVICES="" "$DP_PY" - <<'PY' || die "llava preprocess failed"
import os, torch
from transformers import AutoProcessor, LlavaForConditionalGeneration
inp, out = os.environ["HV_RAW"], os.environ["HV_OUT"]
m = LlavaForConditionalGeneration.from_pretrained(inp, torch_dtype=torch.float16, low_cpu_mem_usage=True)
# Locate the Llama text backbone wherever THIS transformers version exposes it.
lm = None
for path in ("language_model", "model.language_model", "model"):
    obj = m; ok = True
    for a in path.split("."):
        if hasattr(obj, a): obj = getattr(obj, a)
        else: ok = False; break
    if ok and obj is not m:
        lm = obj; print("  found language model at m.%s (%s)" % (path, type(obj).__name__)); break
assert lm is not None, "could not locate the llama backbone; attrs=%s" % [a for a in dir(m) if not a.startswith('_')][:60]
os.makedirs(out, exist_ok=True)
lm.save_pretrained(out)
AutoProcessor.from_pretrained(inp).tokenizer.save_pretrained(out)
print("  wrote", out)
PY
else
  echo "▶ text_encoder present — skip preprocess (use --force to redo)"
fi

echo "▶ verifying tree:"
verify; s=$?
if [ $s -eq 0 ]; then
  echo "✅ HunyuanVideo training weights ready — ckpt_path='$DEST'"
  echo "   (optional) remove the raw llava to reclaim ~16GB:  rm -rf '$LLAVA_RAW'"
else
  die "tree incomplete (see ✗ above)"
fi
