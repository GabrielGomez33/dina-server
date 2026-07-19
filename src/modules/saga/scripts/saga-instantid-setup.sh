#!/usr/bin/env bash
# ============================================================================
# saga-instantid-setup.sh — install InstantID for ComfyUI (Arm B: identity-across-style)
# ----------------------------------------------------------------------------
# InstantID injects a face identity via an InsightFace embedding + a landmark
# ControlNet, constrained to the face — so a real face survives into anime style
# without a per-person LoRA fighting the base model. Installs: the cubiq
# ComfyUI_InstantID node, insightface + onnxruntime-gpu (into the ComfyUI venv),
# and the InstantID models + antelopev2 face models (~5GB).
#
#   bash saga-instantid-setup.sh            # install
#   bash saga-instantid-setup.sh --check    # report install state
#
# Env: SAGA_ROOT (required)
#   COMFY_DIR=$SAGA_ROOT/engine/ComfyUI   COMFY_VENV=$COMFY_DIR/venv
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
COMFY_DIR="${COMFY_DIR:-$SAGA_ROOT/engine/ComfyUI}"
VENV="${COMFY_VENV:-$COMFY_DIR/venv}"
PY="$VENV/bin/python"
NODE="$COMFY_DIR/custom_nodes/ComfyUI_InstantID"
M="$SAGA_ROOT/models"
IID="$M/instantid"; CN="$M/controlnet"; FACE="$M/insightface/models/antelopev2"

die(){ echo "❌ $*" >&2; exit 1; }
log(){ echo "[$(date +%H:%M:%S)] $*"; }
have(){ [ -s "$1" ]; }
dl(){ # <url> <dest>  (resumable, skip if present)
  have "$2" && { log "  have $(basename "$2")"; return 0; }
  mkdir -p "$(dirname "$2")"
  log "  ↓ $(basename "$2")"
  curl -fL --retry 4 -C - -o "$2" "$1" || die "download failed: $1"
}

if [ "${1:-}" = "--check" ]; then
  echo "=== InstantID install check ==="
  [ -d "$NODE/.git" ] && echo "node   : $NODE ✓" || echo "node   : ABSENT"
  [ -x "$PY" ] && { echo -n "insightface: "; "$PY" -c 'import insightface;print(insightface.__version__)' 2>&1 | head -1; echo -n "onnxruntime: "; "$PY" -c 'import onnxruntime as o;print(o.__version__, o.get_available_providers())' 2>&1 | head -1; } || echo "venv   : ABSENT ($VENV)"
  have "$IID/ip-adapter.bin" && echo "ip-adapter : ✓ ($(du -h "$IID/ip-adapter.bin" | cut -f1))" || echo "ip-adapter : ABSENT"
  have "$CN/instantid_controlnet.safetensors" && echo "controlnet : ✓ ($(du -h "$CN/instantid_controlnet.safetensors" | cut -f1))" || echo "controlnet : ABSENT"
  local_n=$(find "$FACE" -name '*.onnx' 2>/dev/null | wc -l); echo "antelopev2 : $local_n/5 onnx files"
  exit 0
fi

[ -x "$PY" ] || die "ComfyUI venv not found at $VENV (set COMFY_VENV)"
command -v git >/dev/null || die "git required"

log "1/5 clone ComfyUI_InstantID node"
if [ -d "$NODE/.git" ]; then git -C "$NODE" pull --ff-only 2>/dev/null || true; else
  git clone https://github.com/cubiq/ComfyUI_InstantID "$NODE" || die "clone failed"
fi

log "2/5 install python deps into the ComfyUI venv (insightface, onnxruntime-gpu)"
"$PY" -m pip install --upgrade pip >/dev/null 2>&1 || true
"$PY" -m pip install onnxruntime-gpu || echo "⚠️ onnxruntime-gpu failed — try: $PY -m pip install onnxruntime-gpu==1.19.2"
"$PY" -m pip install insightface || die "insightface install failed (needs a C toolchain; try: apt-get install -y build-essential python3-dev, then rerun)"
[ -f "$NODE/requirements.txt" ] && "$PY" -m pip install -r "$NODE/requirements.txt" || true

log "3/5 download InstantID models (~4GB)"
dl "https://huggingface.co/InstantX/InstantID/resolve/main/ip-adapter.bin" "$IID/ip-adapter.bin"
dl "https://huggingface.co/InstantX/InstantID/resolve/main/ControlNetModel/diffusion_pytorch_model.safetensors" "$CN/instantid_controlnet.safetensors"

log "4/5 download antelopev2 face models (~360MB, 5 onnx)"
for f in 1k3d68.onnx 2d106det.onnx genderage.onnx glintr100.onnx scrfd_10g_bnkps.onnx; do
  dl "https://huggingface.co/DIAMONIK7777/antelopev2/resolve/main/$f" "$FACE/$f"
done

log "5/5 verify"
"$PY" -c 'import insightface, onnxruntime' 2>/dev/null || die "insightface/onnxruntime import failed — see step 2"
have "$IID/ip-adapter.bin" && have "$CN/instantid_controlnet.safetensors" || die "InstantID models missing"
[ "$(find "$FACE" -name '*.onnx' | wc -l)" -eq 5 ] || die "antelopev2 incomplete ($(find "$FACE" -name '*.onnx' | wc -l)/5)"

echo
echo "✅ InstantID installed. RESTART ComfyUI so the node loads:"
echo "     sudo pm2 restart saga-comfyui"
echo "   then confirm the nodes exist:"
echo "     curl -sf http://127.0.0.1:8188/object_info | jq -r 'keys[]' | grep -iE 'InstantID|ApplyInstantID|InstantIDFaceAnalysis'"
