#!/usr/bin/env bash
# ============================================================================
# saga-unirig-setup.sh — install VAST-AI UniRig (auto-rigging) on the Blackwell pod.
# ----------------------------------------------------------------------------
# STAGE-3 installer. UniRig predicts a skeleton + skin weights for an arbitrary
# mesh (MIT). The Blackwell (sm_120) unlock is: DON'T compile flash-attn — use
# the SDPA shim from the tested (unmerged) PR #70, which also flips the model
# configs to eager attention and adds CPU fallbacks. The other exotic deps have
# sm_120 wheels: spconv (fafraob) and torch_scatter/torch_cluster (official PyG cu128).
#
# Its OWN venv, Python 3.11 (UniRig pins bpy==4.2 = Blender-as-module, cp311 only).
# UniRig calls `import bpy`, NOT our standalone Blender — separate, no conflict.
#
#   bash saga-unirig-setup.sh            # full install + import smoke test
#   FORCE=1 bash saga-unirig-setup.sh    # wipe and reinstall
#
# Env: SAGA_ROOT, UNIRIG_HOME, PYBIN. First rig run downloads ~11.5 GB weights
# from HF VAST-AI/UniRig — set HF_HOME to the volume (mind the quota).
# ============================================================================
set -euo pipefail
SAGA_ROOT="${SAGA_ROOT:-/workspace/SAGA}"
UNIRIG_HOME="${UNIRIG_HOME:-$SAGA_ROOT/engine/UniRig}"
FAFRAOB="https://github.com/fafraob/spconv-wheels/releases/download/v2.3.8"
PYG_INDEX="https://data.pyg.org/whl/torch-2.8.0+cu128.html"
step(){ echo "" >&2; echo "── $* ───────────────────────────────" >&2; }
die(){ echo "❌ $*" >&2; exit 1; }

# Python 3.11 is mandatory (bpy==4.2 ships cp311 only)
PYBIN="${PYBIN:-}"
if [ -z "$PYBIN" ]; then for c in python3.11 python3; do command -v "$c" >/dev/null 2>&1 && { PYBIN="$c"; break; }; done; fi
[ -n "$PYBIN" ] || die "no python found"
PYVER="$("$PYBIN" -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
[ "$PYVER" = "3.11" ] || die "need Python 3.11 for bpy==4.2 (got $PYVER); install python3.11 or set PYBIN"

[ "${FORCE:-0}" = "1" ] && { step "FORCE — removing $UNIRIG_HOME"; rm -rf "$UNIRIG_HOME"; }

# ---- clone UniRig and switch to the Blackwell PR (#70: SDPA flash-attn shim + eager configs + CPU fallbacks) ----
step "clone UniRig + apply Blackwell PR #70"
if [ ! -d "$UNIRIG_HOME/.git" ]; then
  mkdir -p "$(dirname "$UNIRIG_HOME")"
  git clone https://github.com/VAST-AI-Research/UniRig "$UNIRIG_HOME"
fi
cd "$UNIRIG_HOME"
if git rev-parse --verify blackwell >/dev/null 2>&1; then
  git checkout blackwell
elif git fetch origin pull/70/head:blackwell 2>/dev/null; then
  git checkout blackwell; echo "  on PR #70 branch (blackwell)" >&2
else
  echo "  ⚠ could not fetch PR #70 — staying on main; will install a local SDPA flash-attn shim instead" >&2
fi

# ---- venv ----
step "venv → $UNIRIG_HOME/.venv (python $PYVER)"
[ -d .venv ] || "$PYBIN" -m venv .venv
# shellcheck disable=SC1091
. .venv/bin/activate
python -m pip install -U pip wheel setuptools

# ---- torch cu128 FIRST ----
step "torch 2.8.0 + cu128"
pip install torch==2.8.0 torchvision --index-url https://download.pytorch.org/whl/cu128

# ---- requirements WITHOUT flash_attn (never let pip try to build it on sm_120) ----
step "requirements (flash_attn stripped)"
[ -f requirements.txt ] || die "no requirements.txt in UniRig clone"
grep -viE '^\s*flash[-_]attn' requirements.txt > /tmp/unirig_req.txt || true
pip install -r /tmp/unirig_req.txt

# ---- flash-attn SDPA shim (PR #70's installer if present, else a local fallback shim) ----
step "flash-attn SDPA shim (no compile)"
if python -c "import flash_attn" >/dev/null 2>&1; then
  echo "  flash_attn already importable — skipping shim" >&2
elif [ -f install_flash_attn_shim.py ]; then
  python install_flash_attn_shim.py && echo "  installed PR #70 shim" >&2
else
  # minimal fallback: satisfy `from flash_attn.modules.mha import MHA` and flash_attn_func via SDPA
  SP="$(python -c 'import site;print(site.getsitepackages()[0])')"
  mkdir -p "$SP/flash_attn/modules"
  cat > "$SP/flash_attn/__init__.py" <<'PY'
import torch, torch.nn.functional as F
def flash_attn_func(q,k,v,dropout_p=0.0,softmax_scale=None,causal=False,**kw):
    return F.scaled_dot_product_attention(q.transpose(1,2),k.transpose(1,2),v.transpose(1,2),
        dropout_p=dropout_p,is_causal=causal,scale=softmax_scale).transpose(1,2)
__version__="2.0.0-sdpa-shim"
PY
  cat > "$SP/flash_attn/modules/__init__.py" <<'PY'
PY
  cat > "$SP/flash_attn/modules/mha.py" <<'PY'
import torch, torch.nn as nn, torch.nn.functional as F
class MHA(nn.Module):
    """SDPA-backed drop-in for flash_attn.modules.mha.MHA (self-attn subset UniRig uses)."""
    def __init__(self, embed_dim, num_heads, cross_attn=False, qkv_proj_bias=True, out_proj_bias=True,
                 dropout=0.0, causal=False, softmax_scale=None, **kw):
        super().__init__()
        self.embed_dim=embed_dim; self.num_heads=num_heads; self.head_dim=embed_dim//num_heads
        self.causal=causal; self.softmax_scale=softmax_scale; self.dropout=dropout; self.cross_attn=cross_attn
        self.Wqkv=nn.Linear(embed_dim, 3*embed_dim, bias=qkv_proj_bias)
        self.out_proj=nn.Linear(embed_dim, embed_dim, bias=out_proj_bias)
    def forward(self, x, x_kv=None, **kw):
        B,S,_=x.shape
        qkv=self.Wqkv(x).view(B,S,3,self.num_heads,self.head_dim).permute(2,0,3,1,4)
        q,k,v=qkv[0],qkv[1],qkv[2]
        o=F.scaled_dot_product_attention(q,k,v,dropout_p=self.dropout if self.training else 0.0,
            is_causal=self.causal, scale=self.softmax_scale)
        return self.out_proj(o.transpose(1,2).reshape(B,S,self.embed_dim))
PY
  echo "  wrote local SDPA shim to $SP/flash_attn (fallback)" >&2
fi

# ---- spconv sm_120 (fafraob prebuilt) + PyG compiled ops (official cu128) ----
step "spconv (sm_120) + torch_scatter/torch_cluster (cu128)"
pip install \
  "$FAFRAOB/cumm_cu128-0.8.2-cp311-cp311-linux_x86_64.whl" \
  "$FAFRAOB/spconv_cu128-2.3.8-cp311-cp311-linux_x86_64.whl"
pip install torch_scatter torch_cluster -f "$PYG_INDEX" --no-cache-dir \
  || echo "  ⚠ PyG cu128 wheels failed — if runtime hits 'no kernel image', PR #70 has a CPU fallback" >&2

# ---- numpy pin LAST (UniRig README insists) ----
step "numpy pin"
pip install "numpy==1.26.4"

# ---- import smoke test ----
step "smoke test"
python - <<'PY'
import importlib, sys
ok=True
for m in ["torch","spconv.pytorch","torch_scatter","torch_cluster","flash_attn","flash_attn.modules.mha","bpy","transformers"]:
    try: importlib.import_module(m); print("  ✔",m)
    except Exception as e: ok=False; print("  ✗",m,"→",e)
import torch; print("  cuda:",torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")
sys.exit(0 if ok else 1)
PY
echo "" >&2
echo "✅ UniRig installed. venv: $UNIRIG_HOME/.venv" >&2
echo "   next: saga-3d-rig.sh --in <upright.glb> --out <rigged.glb>  (first run pulls ~11.5 GB weights)" >&2
