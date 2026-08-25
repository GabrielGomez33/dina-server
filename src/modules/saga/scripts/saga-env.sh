# saga-env.sh — SOURCE this to set up a SAGA working shell on the pod.
# ============================================================================
#   source /workspace/SAGA/scripts/saga-env.sh
#
# One command to make a fresh pod (or a new shell) ready: sets SAGA_ROOT + the
# ComfyUI endpoint, exports the fp8 model-name overrides the scripts expect,
# points the HuggingFace cache at the persistent volume (+ the transfer
# hardening we learned the hard way), activates the Python venv, and puts the
# saga-*.sh scripts on PATH so you can call them by name from anywhere.
#
# Override anything by setting it BEFORE sourcing, e.g.:
#   SAGA_ROOT=/workspace/SAGA SAGA_VENV=/workspace/SAGA/engine/ComfyUI/venv source saga-env.sh
#
# NOTE: this file is meant to be sourced, not executed — it must not `exit` or
# use `set -e` (that would kill your interactive shell).
# ============================================================================

# --- core paths ---
export SAGA_ROOT="${SAGA_ROOT:-/workspace/SAGA}"
export COMFY="${COMFY:-http://127.0.0.1:8188}"
export COMFY_OUT="${COMFY_OUT:-$SAGA_ROOT/engine/ComfyUI/output}"

# --- model filename overrides (the pod ships fp8 builds; scripts default to these names) ---
export FP_MODEL="${FP_MODEL:-FramePackI2V_HY_fp8_e4m3fn.safetensors}"   # FramePack transformer
export FP_LLM="${FP_LLM:-llava_llama3_fp8_scaled.safetensors}"          # FramePack text encoder
# Flux / FLF / upscale model names already match the script defaults; export overrides here only
# if your installed filenames differ (see each script's header for the env var names).

# --- HuggingFace cache on the volume + the transfer hardening (avoids EDQUOT + Xet drops) ---
export HF_HOME="${HF_HOME:-$SAGA_ROOT/hf_home/huggingface}"
export HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}"

# --- put the saga scripts on PATH (idempotent) ---
case ":$PATH:" in
  *":$SAGA_ROOT/scripts:"*) ;;
  *) export PATH="$SAGA_ROOT/scripts:$PATH" ;;
esac

# --- activate the Python venv (auto-detect common locations; override with SAGA_VENV) ---
_saga_activate_venv() {
  local v
  for v in "${SAGA_VENV:-}" \
           "$SAGA_ROOT/engine/ComfyUI/venv" \
           "$SAGA_ROOT/engine/venv" \
           "$SAGA_ROOT/venv" \
           "/workspace/venv"; do
    [ -n "$v" ] && [ -f "$v/bin/activate" ] && { # shellcheck disable=SC1091
      . "$v/bin/activate"; echo "  venv:   $v"; return 0; }
  done
  echo "  venv:   (none auto-found — set SAGA_VENV=/path/to/venv and re-source)"
  return 1
}
_saga_activate_venv

# --- summary so you can see at a glance that it worked ---
echo "✔ SAGA env ready"
echo "  SAGA_ROOT=$SAGA_ROOT"
echo "  COMFY=$COMFY"
echo "  python: $(command -v python 2>/dev/null || echo 'none')"
echo "  ffmpeg: $(command -v ffmpeg >/dev/null 2>&1 && echo yes || echo 'NO — apt-get install -y ffmpeg')"
echo "  scripts on PATH: $SAGA_ROOT/scripts"
# Tip: ComfyUI (only needed for image/video re-renders, not for post/VO/assemble) —
#   cd \"\$SAGA_ROOT/engine/ComfyUI\" && python main.py --listen 127.0.0.1 --port 8188 &
