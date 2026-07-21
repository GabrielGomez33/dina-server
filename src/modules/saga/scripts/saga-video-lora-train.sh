#!/usr/bin/env bash
# ============================================================================
# saga-video-lora-train.sh — train a VIDEO-model LoRA for a user (wan|hunyuan|ltx)
# ----------------------------------------------------------------------------
# Platform module (not jutsu-specific): bakes a character's identity into a VIDEO model so
# the motion backend generates them natively (no per-frame face-restore). Mirrors the SDXL
# saga-lora-train.sh. Reuses the user's curated image dataset; fills a diffusion-pipe config
# template per model and launches training. Output → models/loras_video/<model>/<user>.safetensors.
#
#   saga-video-lora-train.sh --user U --model wan|hunyuan|ltx
#     [--dataset DIR]  (default users/<U>/datasets/anime_curated)
#     [--trigger T]    [--rank 32] [--lr 2e-5] [--epochs 100] [--save-every 10]
#     [--resolutions 512,768] [--repeats 10] [--model-root DIR] [--dry-run]
#
# --dry-run generates the configs and prints the command WITHOUT training (safe anywhere).
# Env: SAGA_ROOT (required)   DP_ROOT=$SAGA_ROOT/engine/diffusion-pipe
# VERIFY-LIVE: the config templates carry paths/keys that must match your installed models
#   and the diffusion-pipe release — confirm against that repo's examples/ before a real run.
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMPL="$(cd "$HERE/../training" && pwd)"
DP_ROOT="${DP_ROOT:-$SAGA_ROOT/engine/diffusion-pipe}"

USER=""; MODEL=""; DATASET=""; TRIGGER=""; RANK=32; LR="2e-5"; EPOCHS=100; SAVE_EVERY=10
RESOLUTIONS="512,768"; REPEATS=10; MODEL_ROOT="$SAGA_ROOT/models"; DRY=0
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --user) USER="$2"; shift 2;; --model) MODEL="$2"; shift 2;;
  --dataset) DATASET="$2"; shift 2;; --trigger) TRIGGER="$2"; shift 2;;
  --rank) RANK="$2"; shift 2;; --lr) LR="$2"; shift 2;; --epochs) EPOCHS="$2"; shift 2;;
  --save-every) SAVE_EVERY="$2"; shift 2;; --resolutions) RESOLUTIONS="$2"; shift 2;;
  --repeats) REPEATS="$2"; shift 2;; --model-root) MODEL_ROOT="$2"; shift 2;;
  --dry-run) DRY=1; shift;; -h|--help) sed -n '2,24p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done

# --- validation -------------------------------------------------------------
[ -n "$USER" ] || die "need --user <id>"
case "$MODEL" in wan|hunyuan|ltx) ;; *) die "--model must be wan|hunyuan|ltx (got '$MODEL')";; esac
TMPL_MODEL="$TMPL/lora_${MODEL}.toml.tmpl"; TMPL_DS="$TMPL/dataset.toml.tmpl"
[ -f "$TMPL_MODEL" ] && [ -f "$TMPL_DS" ] || die "missing template(s) under $TMPL"
DATASET="${DATASET:-$SAGA_ROOT/users/$USER/datasets/anime_curated}"
[ -d "$DATASET" ] || die "dataset not found: $DATASET (curate images first, or pass --dataset)"
for n in "$RANK" "$EPOCHS" "$SAVE_EVERY" "$REPEATS"; do case "$n" in ''|*[!0-9]*) die "numeric arg expected, got '$n'";; esac; done
TRIGGER="${TRIGGER:-$USER}"
RES_TOML=$(echo "$RESOLUTIONS" | sed 's/,/, /g')          # 512,768 → 512, 768

OUT_DIR="$SAGA_ROOT/models/loras_video/$MODEL"
CFG_DIR="$SAGA_ROOT/users/$USER/train/video_${MODEL}"
mkdir -p "$OUT_DIR" "$CFG_DIR" || die "cannot create output/config dirs"
DS_OUT="$CFG_DIR/dataset.toml"; CFG_OUT="$CFG_DIR/lora_${MODEL}.toml"

fill(){ sed -e "s#@DATASET@#$DATASET#g" -e "s#@REPEATS@#$REPEATS#g" -e "s#@RESOLUTIONS@#$RES_TOML#g" \
            -e "s#@OUTPUT_DIR@#$OUT_DIR#g" -e "s#@DATASET_TOML@#$DS_OUT#g" \
            -e "s#@EPOCHS@#$EPOCHS#g" -e "s#@SAVE_EVERY@#$SAVE_EVERY#g" \
            -e "s#@MODEL_ROOT@#$MODEL_ROOT#g" -e "s#@RANK@#$RANK#g" -e "s#@LR@#$LR#g" "$1"; }
fill "$TMPL_DS"    > "$DS_OUT"  || die "failed to write $DS_OUT"
fill "$TMPL_MODEL" > "$CFG_OUT" || die "failed to write $CFG_OUT"
# no unfilled placeholders left behind
if grep -q '@[A-Z_]*@' "$DS_OUT" "$CFG_OUT"; then grep -Hn '@[A-Z_]*@' "$DS_OUT" "$CFG_OUT" >&2; die "unfilled placeholder(s) remain"; fi

echo "▶ video-LoRA config ready:"
echo "   model=$MODEL  user=$USER  trigger=$TRIGGER  rank=$RANK  lr=$LR  epochs=$EPOCHS"
echo "   dataset=$DATASET"
echo "   config=$CFG_OUT"
echo "   output=$OUT_DIR/${USER}.safetensors (per diffusion-pipe naming)"
CMD="deepspeed --num_gpus=1 $DP_ROOT/train.py --deepspeed --config $CFG_OUT"
if [ "$DRY" -eq 1 ]; then
  echo "(--dry-run) would run:"; echo "  cd $DP_ROOT && $CMD"; exit 0
fi
[ -f "$DP_ROOT/train.py" ] || die "diffusion-pipe not found at $DP_ROOT (clone it; see docs/VIDEO_BACKENDS.md), or use --dry-run"
command -v deepspeed >/dev/null || die "deepspeed not on PATH (activate the diffusion-pipe venv)"
echo "▶ launching training (one GPU: this pauses ComfyUI-heavy work)…"
( cd "$DP_ROOT" && $CMD ) || die "training failed"
echo "✅ done — LoRA(s) under $OUT_DIR"
