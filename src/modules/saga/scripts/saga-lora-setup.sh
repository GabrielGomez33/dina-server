#!/usr/bin/env bash
# ============================================================================
# saga-lora-setup.sh — install the LoRA trainer (kohya sd-scripts) in its own venv
# ----------------------------------------------------------------------------
# One-time. Installs kohya-ss/sd-scripts (the headless trainer — no GUI) into a
# dedicated venv so it never collides with the ComfyUI env. Run as the `dina`
# user (owns the tree; non-sudo pip). GPU is NOT needed for setup.
#
#   bash saga-lora-setup.sh            # install
#   bash saga-lora-setup.sh --check    # just report what's installed
#
# Env: SAGA_ROOT (required)
#   SD_REF=<git ref>   # pin sd-scripts (default: a known-good commit/branch)
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
SDROOT="$SAGA_ROOT/engine/sd-scripts"
VENV="$SDROOT/venv"
PY="$VENV/bin/python"
SD_REF="${SD_REF:-}"   # empty = default branch; set to pin

die(){ echo "❌ $*" >&2; exit 1; }
log(){ echo "[$(date +%H:%M:%S)] $*"; }

if [ "${1:-}" = "--check" ]; then
  echo "=== sd-scripts install check ==="
  [ -d "$SDROOT" ] && echo "repo   : $SDROOT ($(git -C "$SDROOT" rev-parse --short HEAD 2>/dev/null || echo '?'))" || echo "repo   : ABSENT"
  [ -x "$PY" ] && echo "venv   : $VENV ($("$PY" --version 2>&1))" || echo "venv   : ABSENT"
  [ -x "$PY" ] && { echo -n "torch  : "; "$PY" -c 'import torch;print(torch.__version__,"cuda",torch.cuda.is_available())' 2>&1 | head -1; }
  [ -x "$PY" ] && { echo -n "trainer: "; "$PY" -c 'import library' 2>/dev/null && echo "library import OK" || echo "library MISSING"; }
  [ -f "$SDROOT/sdxl_train_network.py" ] && echo "sdxl   : sdxl_train_network.py present" || echo "sdxl   : ABSENT"
  exit 0
fi

command -v git >/dev/null || die "git required"
command -v python3 >/dev/null || die "python3 required"

log "1/5 clone kohya sd-scripts → $SDROOT"
if [ -d "$SDROOT/.git" ]; then
  log "  already cloned; fetching"; git -C "$SDROOT" fetch --depth 1 origin || die "git fetch failed"
else
  mkdir -p "$(dirname "$SDROOT")"
  git clone https://github.com/kohya-ss/sd-scripts "$SDROOT" || die "git clone failed"
fi
[ -n "$SD_REF" ] && { git -C "$SDROOT" checkout "$SD_REF" || die "checkout $SD_REF failed"; }
[ -f "$SDROOT/sdxl_train_network.py" ] || die "sdxl_train_network.py not found — wrong repo/ref?"

log "2/5 create venv → $VENV"
if [ ! -x "$PY" ]; then
  python3 -m venv "$VENV" || die "venv creation failed (need python3-venv?)"
fi
"$PY" -m pip install --upgrade pip wheel >/dev/null || die "pip upgrade failed"

log "3/5 install torch (cu121; py3.12 needs >=2.2 — default 2.5.1)"
# py3.12 has no torch 2.1.x cu121 wheels; the index carries 2.2.0..2.5.1.
TORCH_VER="${TORCH_VER:-2.5.1}"; TV_VER="${TV_VER:-0.20.1}"
"$PY" -m pip install "torch==${TORCH_VER}" "torchvision==${TV_VER}" --index-url https://download.pytorch.org/whl/cu121 \
  || die "torch install failed (try a different TORCH_VER/TV_VER; index has 2.2.0..2.5.1 for py3.12)"

log "4/5 install sd-scripts requirements + training extras"
# requirements.txt installs the sd-scripts library (library/*) + accelerate/
# transformers/diffusers/etc. Extras: 8-bit Adam (bitsandbytes) + xformers.
( cd "$SDROOT" && "$PY" -m pip install -r requirements.txt ) || die "requirements install failed"
"$PY" -m pip install bitsandbytes || echo "⚠️ bitsandbytes install nonzero — AdamW8bit may be unavailable (train can fall back to AdamW)"
# xformers must match torch; 0.0.28.post3 ↔ torch 2.5.1. Best-effort (train can use --sdpa).
XFORMERS_VER="${XFORMERS_VER:-0.0.28.post3}"
"$PY" -m pip install "xformers==${XFORMERS_VER}" --index-url https://download.pytorch.org/whl/cu121 \
  || echo "⚠️ xformers ${XFORMERS_VER} install nonzero — train can use --sdpa instead"

log "5/5 write a non-interactive single-GPU accelerate config + smoke test"
ACC_DIR="$HOME/.cache/huggingface/accelerate"; mkdir -p "$ACC_DIR"
cat > "$ACC_DIR/default_config.yaml" <<YAML
compute_environment: LOCAL_MACHINE
distributed_type: 'NO'
downcast_bf16: 'no'
gpu_ids: '0'
machine_rank: 0
main_training_function: main
mixed_precision: bf16
num_machines: 1
num_processes: 1
use_cpu: false
YAML
( cd "$SDROOT" && "$PY" sdxl_train_network.py --help >/dev/null 2>&1 ) \
  && log "✅ sdxl_train_network.py runs" || die "trainer smoke test failed — check the requirements install above"

echo
echo "✅ sd-scripts ready at $SDROOT"
echo "   next: gather images → saga-lora-dataset.sh → saga-lora-train.sh"
