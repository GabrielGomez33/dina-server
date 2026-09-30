# saga-pod-init.sh — SOURCE this first on every fresh pod.
# ============================================================================
#   source /workspace/SAGA/scripts/saga-pod-init.sh
#
# We move pod-to-pod frequently (terminate when idle to avoid charges). The
# /workspace volume PERSISTS (all venvs, models, scripts, meshes), but the
# container overlay is EPHEMERAL — so a fresh pod loses: the system GL libraries
# (libEGL/libGL, needed by TRELLIS/nvdiffrast/moderngl/open3d/Blender), PATH,
# and the /usr/local/bin/blender symlink. This restores exactly those, idempotently.
#
# Safe to source (no exit / no set -e). Fast on a warm pod (skips apt when GL is present).
# ============================================================================

export SAGA_ROOT="${SAGA_ROOT:-/workspace/SAGA}"
export HF_HOME="${HF_HOME:-$SAGA_ROOT/hf_home/huggingface}"
export HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}"
export COMFY="${COMFY:-http://127.0.0.1:8188}"

# --- PATH: saga scripts + portable Blender ---
case ":$PATH:" in *":$SAGA_ROOT/scripts:"*) ;; *) export PATH="$SAGA_ROOT/scripts:$PATH";; esac
if [ -x "$SAGA_ROOT/engine/blender/blender" ]; then
  case ":$PATH:" in *":$SAGA_ROOT/engine/blender:"*) ;; *) export PATH="$SAGA_ROOT/engine/blender:$PATH";; esac
  ln -sf "$SAGA_ROOT/engine/blender/blender" /usr/local/bin/blender 2>/dev/null || true
fi

# --- system GL libs (ephemeral; required by trellis/nvdiffrast/moderngl/open3d/blender) ---
# idempotent: only apt-install when libEGL.so.1 is not already resolvable.
if ldconfig -p 2>/dev/null | grep -q 'libEGL\.so\.1'; then
  echo "  ✓ GL libs present"
else
  echo "  installing system GL libs (fresh pod)…"
  if apt-get update -qq >/dev/null 2>&1 && apt-get install -y --no-install-recommends \
       libegl1 libgl1 libgles2 libglvnd0 libglib2.0-0 libxrender1 libxi6 libxxf86vm1 libxfixes3 >/dev/null 2>&1; then
    echo "  ✓ GL libs installed"
  else
    echo "  ⚠ GL lib install failed — run: apt-get update && apt-get install -y libegl1 libgl1 libglib2.0-0"
  fi
fi

# --- summary so you can see the pod is ready at a glance ---
echo "✔ SAGA pod ready  (SAGA_ROOT=$SAGA_ROOT, HF_HOME=$HF_HOME)"
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | sed 's/^/  GPU:    /'
for e in TRELLIS UniRig ComfyUI blender; do
  [ -e "$SAGA_ROOT/engine/$e" ] && echo "  engine: $e ✓" || echo "  engine: $e MISSING (reinstall needed)"
done
command -v blender >/dev/null 2>&1 && echo "  blender:$(blender --version 2>/dev/null | head -1 | sed 's/^/ /')" || echo "  blender: not found"
echo "  venvs:  TRELLIS→ . \$SAGA_ROOT/engine/TRELLIS/.venv/bin/activate   (rig script self-activates UniRig)"
