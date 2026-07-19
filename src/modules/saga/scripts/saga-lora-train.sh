#!/usr/bin/env bash
# ============================================================================
# saga-lora-train.sh — train an SDXL character LoRA (kohya sd-scripts)
# ----------------------------------------------------------------------------
# Drains the GPU (heavy exclusive job — SDXL LoRA needs ~12-16GB, only ~8 free
# with Ollama+ComfyUI up), runs sd-scripts, and drops the .safetensors into
# models/loras/. Defaults mirror core/loraTraining.ts (character: rank 24,
# steps 1800, lr 1e-4, alpha=rank/2). UNet-only for SDXL stability.
#
#   saga-lora-train.sh --dataset DIR --name Exodia [--trigger exodia_saga]
#      [--rank 24] [--steps 1800] [--lr 1e-4] [--res 1024]
#      [--min-free 12000] [--skip-drain] [--no-restore]
#
# --dataset = the dir that CONTAINS the "<repeats>_<trigger>/" folder
#             (i.e. saga-lora-dataset.sh's --out).
# Env: SAGA_ROOT (required)   LORA_BASE=animagine-xl-4.0.safetensors
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
SDROOT="$SAGA_ROOT/engine/sd-scripts"
VENV="$SDROOT/venv"
ACCEL="$VENV/bin/accelerate"
BASE="${LORA_BASE:-animagine-xl-4.0.safetensors}"

DATASET=""; NAME=""; TRIGGER=""; RANK=24; STEPS=1800; LR="1e-4"; RES=1024
MIN_FREE=12000; DRAIN=1; RESTORE=1; OPT="AdamW8bit"
die(){ echo "❌ $*" >&2; exit 1; }
log(){ echo "[$(date +%H:%M:%S)] $*"; }
while [ $# -gt 0 ]; do case "$1" in
  --dataset) DATASET="$2"; shift 2;; --name) NAME="$2"; shift 2;;
  --trigger) TRIGGER="$2"; shift 2;; --rank) RANK="$2"; shift 2;;
  --steps) STEPS="$2"; shift 2;; --lr) LR="$2"; shift 2;; --res) RES="$2"; shift 2;;
  --min-free) MIN_FREE="$2"; shift 2;; --skip-drain) DRAIN=0; shift;;
  --no-restore) RESTORE=0; shift;; --optimizer) OPT="$2"; shift 2;;
  -h|--help) sed -n '2,22p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done

[ -n "$DATASET" ] && [ -d "$DATASET" ] || die "need --dataset <dir containing the N_trigger folder>"
[ -n "$NAME" ] || die "need --name (output LoRA name)"
[ -x "$VENV/bin/python" ] || die "sd-scripts venv missing — run saga-lora-setup.sh first"

# ensure a valid cwd (dataset prep may have rm-rf'd + recreated the caller's dir)
cd "$SAGA_ROOT" 2>/dev/null || cd / || true
# fix Intel oneMKL "Cannot load libtorch_cpu.so" — numpy/torch MKL threading-layer clash
export MKL_THREADING_LAYER="${MKL_THREADING_LAYER:-GNU}"

NAMESTEM=$(echo "$NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g')
ALPHA=$(( RANK / 2 )); [ "$ALPHA" -lt 1 ] && ALPHA=1
WARMUP=$(( STEPS / 20 ))
CKPT="$SAGA_ROOT/models/checkpoints/$BASE"
[ -f "$CKPT" ] || die "base checkpoint not found: $CKPT"

# locate + sanity-check the concept folder
CONCEPT=$(find "$DATASET" -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]+_.+' | head -1)
[ -n "$CONCEPT" ] || die "no '<repeats>_<trigger>' folder inside $DATASET — run saga-lora-dataset.sh"
NIMG=$(find "$CONCEPT" -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \) | wc -l)
NTXT=$(find "$CONCEPT" -type f -iname '*.txt' | wc -l)
[ "$NIMG" -ge 8 ] || die "only $NIMG images in $CONCEPT — a character LoRA needs >=8 (15-30 recommended)"
[ "$NTXT" -ge "$NIMG" ] || log "⚠️ $NTXT captions for $NIMG images — some images have no .txt caption"

OUTDIR="$SAGA_ROOT/tmp/lora/${NAMESTEM}_out"; mkdir -p "$OUTDIR"
LOG="$OUTDIR/train_$(date +%Y%m%d_%H%M%S).log"; exec > >(tee -a "$LOG") 2>&1
T0=$(date +%s)

echo "════════════════════════════════════════════════════"
echo " SAGA — LoRA TRAIN '$NAME'  rank=$RANK steps=$STEPS lr=$LR res=$RES"
echo " dataset: $CONCEPT ($NIMG images)  base: $BASE"
echo " log: $LOG"
echo "════════════════════════════════════════════════════"

free_vram(){ nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -1 | tr -d ' '; }

if [ "$DRAIN" -eq 1 ]; then
  log "draining GPU (heavy exclusive job)…"
  if command -v ollama >/dev/null; then
    ollama ps 2>/dev/null | tail -n +2 | awk '{print $1}' | while read -r m; do
      [ -n "$m" ] && ollama stop "$m" >/dev/null 2>&1 && log "  ollama stop $m"; done
  fi
  ( sudo -n pm2 stop saga-comfyui >/dev/null 2>&1 && log "  paused saga-comfyui (sudo)" ) \
    || ( pm2 stop saga-comfyui >/dev/null 2>&1 && log "  paused saga-comfyui" ) \
    || log "  (could not auto-stop saga-comfyui — stop it manually if VRAM is short)"
  sleep 4
fi
FREE=$(free_vram); log "GPU free: ${FREE} MiB (need >= ${MIN_FREE})"
if [ "${FREE:-0}" -lt "$MIN_FREE" ]; then
  die "insufficient free VRAM (${FREE} < ${MIN_FREE}). Stop saga-comfyui / free the card, or pass --skip-drain --min-free <n> to override."
fi

restore(){ [ "$RESTORE" -eq 1 ] || return 0; ( sudo -n pm2 start saga-comfyui >/dev/null 2>&1 || pm2 start saga-comfyui >/dev/null 2>&1 ) && log "restarted saga-comfyui" || true; }
trap restore EXIT

log "launching sd-scripts (SDXL, UNet-only, ${OPT}, --sdpa, bf16, --no_half_vae)…"
"$ACCEL" launch --num_cpu_threads_per_process=4 "$SDROOT/sdxl_train_network.py" \
  --pretrained_model_name_or_path="$CKPT" \
  --train_data_dir="$DATASET" \
  --output_dir="$OUTDIR" --output_name="$NAMESTEM" \
  --resolution="${RES},${RES}" \
  --network_module=networks.lora --network_dim="$RANK" --network_alpha="$ALPHA" \
  --network_train_unet_only \
  --train_batch_size=1 --max_train_steps="$STEPS" \
  --learning_rate="$LR" --unet_lr="$LR" \
  --optimizer_type="$OPT" --lr_scheduler=cosine --lr_warmup_steps="$WARMUP" \
  --mixed_precision=bf16 --save_precision=fp16 \
  --cache_latents --cache_latents_to_disk --gradient_checkpointing --sdpa --no_half_vae \
  --enable_bucket --min_bucket_reso=512 --max_bucket_reso=2048 --bucket_reso_steps=64 \
  --min_snr_gamma=5 --caption_extension=.txt \
  --save_model_as=safetensors --save_every_n_epochs=1 --seed=42 \
  || die "training failed (see log above)"

RESULT="$OUTDIR/${NAMESTEM}.safetensors"
[ -f "$RESULT" ] || die "training finished but $RESULT is missing"
DEST="$SAGA_ROOT/models/loras/${NAMESTEM}.safetensors"
cp -f "$RESULT" "$DEST" || die "could not copy result to $DEST"

DT=$(( $(date +%s) - T0 ))
echo
echo "════════════════════════════════════════════════════"
echo " ✅ LoRA trained in ${DT}s → $DEST"
echo "    trigger: ${TRIGGER:-<in captions>}   ($(stat -c%s "$DEST" 2>/dev/null) bytes)"
echo " test it: saga-keyframe.sh with the LoRA + trigger (wiring next)"
echo " log: $LOG"
echo "════════════════════════════════════════════════════"
