#!/usr/bin/env bash
# ============================================================================
# saga-trellis-setup.sh — install Microsoft TRELLIS for GEOMETRY-ONLY image→mesh
# on the Blackwell pod (RTX PRO 4500, sm_120, torch 2.8+cu128), with ZERO CUDA
# source compiles. This is the STAGE-1 installer for the 3D pose-proxy pipeline.
# ----------------------------------------------------------------------------
# WHY THIS IS SAFE ON BLACKWELL (the whole point):
#   We only need the mesh as a pose proxy — no texture — so saga-trellis.py
#   requests formats=['mesh'] and exports vertices/faces via trimesh, never
#   touching trellis.utils.postprocessing_utils (the module that pulls nvdiffrast
#   and whose to_glb() texture-bake needs nvdiffrast + diff-gaussian-rasterization).
#   That removes every nvcc/JIT build. What remains:
#     • torch 2.8+cu128            (installed fresh into an isolated venv)
#     • spconv (sm_120)            → PREBUILT fafraob wheel  (no build)
#     • FlexiCubes                 → pure-python submodule   (no build)
#     • SDPA sparse attention      → PR #357 patch           (no flash-attn/xformers)
#     • pure-python deps           → pip                     (no build)
#   nvdiffrast is pip-installed only so imports resolve; it JIT-compiles ONLY on
#   a rasterize call, which the geometry-only path never makes → no nvcc, ever.
#
# Runs in its OWN venv ($TRELLIS_HOME/.venv) — must NOT share ComfyUI's venv
# (spconv/torch pins would break ComfyUI).
#
#   bash saga-trellis-setup.sh          # full install, ends with a --check smoke test
#   FORCE=1 bash saga-trellis-setup.sh  # wipe and reinstall the TRELLIS venv/clone
#
# Env overrides: SAGA_ROOT (default /workspace/SAGA), TRELLIS_HOME, PYBIN.
# ============================================================================
set -euo pipefail

SAGA_ROOT="${SAGA_ROOT:-/workspace/SAGA}"
TRELLIS_HOME="${TRELLIS_HOME:-$SAGA_ROOT/engine/TRELLIS}"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAFRAOB="https://github.com/fafraob/spconv-wheels/releases/download/v2.3.8"
step(){ echo "" >&2; echo "── $* ──────────────────────────────────" >&2; }
die(){ echo "❌ $*" >&2; exit 1; }

# ---- pick a Python 3.10–3.13 (fafraob spconv wheels cover cp310..cp313) ----
PYBIN="${PYBIN:-}"
if [ -z "$PYBIN" ]; then
  for c in python3.11 python3.12 python3.10 python3.13 python3; do
    command -v "$c" >/dev/null 2>&1 && { PYBIN="$c"; break; }
  done
fi
[ -n "$PYBIN" ] || die "no python3 found"
PYVER="$("$PYBIN" -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
CP="$("$PYBIN" -c 'import sys;print("cp%d%d"%sys.version_info[:2])')"
case "$CP" in cp310|cp311|cp312|cp313) ;; *) die "python $PYVER unsupported (need 3.10–3.13 for the prebuilt spconv wheels)";; esac
echo "  using $PYBIN (python $PYVER, wheel tag $CP)" >&2

# ---- clean slate on FORCE ----
if [ "${FORCE:-0}" = "1" ]; then
  step "FORCE — removing $TRELLIS_HOME"
  rm -rf "$TRELLIS_HOME"
fi

# ---- clone TRELLIS + submodules (FlexiCubes lives here) ----
step "clone TRELLIS (+ submodules)"
if [ ! -d "$TRELLIS_HOME/.git" ]; then
  mkdir -p "$(dirname "$TRELLIS_HOME")"
  git clone --recurse-submodules https://github.com/microsoft/TRELLIS.git "$TRELLIS_HOME"
else
  echo "  already cloned — updating submodules" >&2
  git -C "$TRELLIS_HOME" submodule update --init --recursive
fi
cd "$TRELLIS_HOME"

# ---- apply PR #357: SDPA sparse-attention backend (no flash-attn / no xformers) ----
step "apply SDPA sparse-attention patch (PR #357)"
if grep -rq "SPARSE_ATTN_BACKEND.*sdpa\|'sdpa'" trellis/modules/sparse/attention/ 2>/dev/null; then
  echo "  sdpa sparse backend already present — skipping" >&2
else
  git fetch origin pull/357/head:saga-sdpa 2>/dev/null || die "could not fetch PR #357 (network?) — see docs/CHARACTER_3D.md for the manual patch"
  if git merge --no-edit saga-sdpa 2>/dev/null; then
    echo "  merged PR #357" >&2
  else
    git merge --abort 2>/dev/null || true
    echo "  merge conflicted — applying as a patch instead" >&2
    git diff HEAD saga-sdpa -- trellis/modules/sparse > /tmp/sdpa.patch || true
    git apply --3way /tmp/sdpa.patch || die "PR #357 would not apply cleanly — apply it manually (see docs/CHARACTER_3D.md)"
  fi
fi

# ---- venv (isolated from ComfyUI) ----
step "create isolated venv → $TRELLIS_HOME/.venv"
[ -d .venv ] || "$PYBIN" -m venv .venv
# shellcheck disable=SC1091
. .venv/bin/activate
python -m pip install -U pip wheel setuptools

# ---- torch cu128 FIRST, pinned, so nothing drags it back to a cpu/cu126 build ----
step "torch 2.8.0 + cu128"
pip install torch==2.8.0 torchvision --index-url https://download.pytorch.org/whl/cu128
python - <<'PY'
import torch
assert torch.version.cuda and torch.version.cuda.startswith("12.8"), f"expected cu128, got {torch.version.cuda}"
print(f"  torch {torch.__version__} cuda {torch.version.cuda}")
PY

# ---- spconv (native sm_120) from prebuilt wheels — NO source build. cumm + spconv, same flavor ----
step "spconv sm_120 (prebuilt fafraob wheels)"
pip install \
  "$FAFRAOB/cumm_cu128-0.8.2-${CP}-${CP}-linux_x86_64.whl" \
  "$FAFRAOB/spconv_cu128-2.3.8-${CP}-${CP}-linux_x86_64.whl"

# ---- pure-python deps (NEVER let pip touch torch again) ----
# nvdiffrast is installed ONLY so `import nvdiffrast.torch` resolves if a trellis
# module references it — it compiles lazily on a rasterize call we never make.
step "pure-python deps"
pip install --no-deps \
  pillow imageio imageio-ffmpeg tqdm easydict einops safetensors huggingface_hub \
  opencv-python-headless scipy trimesh xatlas pymeshfix igraph rembg onnxruntime
pip install transformers open3d pyvista            # allowed to pull their own (non-torch) deps
pip install "git+https://github.com/EasternJournalist/utils3d.git"   # if API errors: pin to the commit in TRELLIS/setup.sh
pip install --no-build-isolation "git+https://github.com/NVlabs/nvdiffrast.git"  # install only; no compile until first raster call (never)

# ---- smoke test: import torch + trellis + trimesh, report backends (no GPU work) ----
step "preflight (--check)"
python "$SCRIPTS_DIR/saga-trellis.py" --check

cat >&2 <<EOF

✅ TRELLIS installed (geometry-only, no CUDA source builds).
   venv:   $TRELLIS_HOME/.venv   (source it, or the wrapper below adds it)
   run:    ( . "$TRELLIS_HOME/.venv/bin/activate" && \\
             python "$SCRIPTS_DIR/saga-trellis.py" --ref "\$SAGA_ROOT/refs/little_one_canon.png" -o "\$SAGA_ROOT/tmp/little_one.glb" )
   backends baked into saga-trellis.py: ATTN=sdpa SPARSE_ATTN=sdpa SPCONV_ALGO=native
EOF
