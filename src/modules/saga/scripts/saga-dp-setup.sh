#!/usr/bin/env bash
# ============================================================================
# saga-dp-setup.sh — make diffusion-pipe trainable on the SAGA box (idempotent)
# ----------------------------------------------------------------------------
# The installed diffusion-pipe + its vendored HunyuanVideo target an OLDER torch/
# transformers than this box's bleeding-edge stack (torch 2.13+cu130, transformers 5.x).
# That mismatch caused a chain of failures the FIRST time we trained a hunyuan LoRA. This
# script re-applies every fix so the environment is reproducible — run it once after cloning
# diffusion-pipe (or after any of its reinstalls), THEN saga-hunyuan-fetch.sh, THEN train.
#
# What it does (each was a real, diagnosed failure — all idempotent / safe to re-run):
#   1. Verify the CUDA toolkit (nvcc) exists — deepspeed JIT-compiles ops against it.
#   2. Pin transformers < 5   (5.x removed CLIPTextModel.text_model, Llava.language_model, …).
#   3. Ensure torch-family deps present (torchvision, torchaudio) from torch's own cuXX index.
#   4. Patch diffusion-pipe/utils/reduction.py — torch 2.13 removed torch._namedtensor_internals.
#   5. Patch submodules/HunyuanVideo/.../attenion.py — SDPA fallback when flash-attn is absent
#      (no flash-attn build needed on this stack).
#
# ORDERING NOTE: run transformers<5 (this script) BEFORE saga-hunyuan-fetch.sh, so the llava
# text-encoder + tokenizer are extracted/saved in 4.x format (a 5.x tokenizer_config breaks
# the 4.x loader). If you already fetched under 5.x, re-run: saga-hunyuan-fetch.sh --skip-download --force
#
#   saga-dp-setup.sh [--check]
# Env: SAGA_ROOT (required)  DP_ROOT=$SAGA_ROOT/engine/diffusion-pipe
#      DP_PY=$SAGA_ROOT/engine/.venv-dp/bin/python
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
DP_ROOT="${DP_ROOT:-$SAGA_ROOT/engine/diffusion-pipe}"
DP_PY="${DP_PY:-$SAGA_ROOT/engine/.venv-dp/bin/python}"
CHECK=0
die(){ echo "❌ $*" >&2; exit 1; }
[ "${1:-}" = "--check" ] && CHECK=1
[ -x "$DP_PY" ] || die "diffusion-pipe venv python not found: $DP_PY (create it; see docs/VIDEO_BACKENDS.md §4)"
[ -d "$DP_ROOT" ] || die "diffusion-pipe not found at $DP_ROOT"

RED="$DP_ROOT/utils/reduction.py"
ATT="$DP_ROOT/submodules/HunyuanVideo/hyvideo/modules/attenion.py"

report(){ # name test
  if eval "$2" >/dev/null 2>&1; then echo "  ✓ $1"; else echo "  ✗ $1"; return 1; fi
}
if [ "$CHECK" -eq 1 ]; then
  echo "diffusion-pipe environment state:"
  report "CUDA nvcc present"          '[ -n "${CUDA_HOME:-}" ] && [ -x "$CUDA_HOME/bin/nvcc" ] || command -v nvcc'
  report "transformers < 5"           '"$DP_PY" -c "import transformers,sys; sys.exit(0 if int(transformers.__version__.split(\".\")[0])<5 else 1)"'
  report "torchvision importable"     '"$DP_PY" -c "import torchvision"'
  report "torchaudio importable"      '"$DP_PY" -c "import torchaudio"'
  report "reduction.py patched"       'grep -q "except ImportError" "$RED" && grep -q "check_serializing_named_tensor" "$RED"'
  report "attenion.py SDPA fallback"  'grep -q "_sdpa_varlen" "$ATT"'
  exit 0
fi

echo "▶ diffusion-pipe setup (idempotent)…"

# 1) CUDA toolkit -----------------------------------------------------------------
if [ -z "${CUDA_HOME:-}" ]; then
  for c in /usr/local/cuda /usr/local/cuda-13.0 /usr/local/cuda-13 /usr/local/cuda-12.*; do
    [ -x "$c/bin/nvcc" ] && { CUDA_HOME="$c"; break; }
  done
fi
if [ -n "${CUDA_HOME:-}" ] && [ -x "$CUDA_HOME/bin/nvcc" ]; then
  echo "  ✓ CUDA toolkit: $CUDA_HOME ($("$CUDA_HOME/bin/nvcc" --version | sed -n 's/.*release \([0-9.]*\).*/\1/p' | tail -1))"
else
  echo "  ⚠ CUDA toolkit (nvcc) NOT found. deepspeed can't compile ops without it."
  echo "    Ubuntu 24.04: sudo apt install cuda-toolkit-13-0  (repo: developer.download.nvidia.com/compute/cuda/repos/ubuntu2404)"
  echo "    then export CUDA_HOME=/usr/local/cuda-13.0  (see docs/VIDEO_BACKENDS.md §4b). Continuing with pip/patch steps…"
fi

# 2) transformers < 5 -------------------------------------------------------------
TVER="$("$DP_PY" -c 'import transformers;print(transformers.__version__)' 2>/dev/null || echo none)"
if [ "$TVER" = none ] || [ "${TVER%%.*}" -ge 5 ] 2>/dev/null; then
  echo "  ▶ pinning transformers<5 (have: $TVER)…"
  "$DP_PY" -m pip install "transformers<5" || die "failed to pin transformers<5"
else
  echo "  ✓ transformers $TVER (<5)"
fi

# 3) torch-family deps (matched to torch's CUDA build) ----------------------------
TORCH_TAG="$("$DP_PY" -c 'import torch;print(torch.__version__)' 2>/dev/null)"   # e.g. 2.13.0+cu130
IDX=""; case "$TORCH_TAG" in *+cu*) IDX="https://download.pytorch.org/whl/${TORCH_TAG##*+}";; esac
for mod in torchvision torchaudio; do
  if "$DP_PY" -c "import $mod" >/dev/null 2>&1; then echo "  ✓ $mod present"; else
    echo "  ▶ installing $mod ${IDX:+from $IDX}…"
    "$DP_PY" -m pip install $mod ${IDX:+--index-url "$IDX"} || echo "    ⚠ $mod install failed — install manually to match $TORCH_TAG"
  fi
done

# 4) reduction.py — torch._namedtensor_internals fallback -------------------------
if [ -f "$RED" ] && ! grep -q 'except ImportError' "$RED"; then
  echo "  ▶ patching reduction.py (torch._namedtensor_internals fallback)…"
  cp "$RED" "$RED.bak"
  "$DP_PY" - "$RED" <<'PY' || die "reduction.py patch failed"
import sys
f=sys.argv[1]; s=open(f).read()
old="from torch._namedtensor_internals import check_serializing_named_tensor"
new=("try:\n    from torch._namedtensor_internals import check_serializing_named_tensor\n"
     "except ImportError:\n    try:\n        from torch.multiprocessing.reductions import check_serializing_named_tensor\n"
     "    except ImportError:\n        def check_serializing_named_tensor(tensor):\n"
     "            if getattr(tensor,'has_names',lambda:False)():\n"
     "                raise RuntimeError(\"Named tensors don't support serialization.\")\n")
if old in s: open(f,'w').write(s.replace(old,new)); print("    patched")
else: print("    (import line absent — already handled?)")
PY
else
  echo "  ✓ reduction.py already patched (or absent)"
fi

# 5) attenion.py — SDPA fallback for flash_attn_varlen_func ------------------------
if [ -f "$ATT" ] && ! grep -q '_sdpa_varlen' "$ATT"; then
  echo "  ▶ patching attenion.py (torch-SDPA fallback for flash-attn)…"
  cp "$ATT" "$ATT.bak"
  "$DP_PY" - "$ATT" <<'PY' || die "attenion.py patch failed"
import sys
f=sys.argv[1]; s=open(f).read()
helper='''
def _sdpa_varlen(q, k, v, cu_seqlens_q, cu_seqlens_kv):
    # Fallback for flash_attn_varlen_func using torch SDPA (no flash-attn needed).
    # q,k,v: [total_tokens, heads, dim]; block-diagonal per cu_seqlens segment.
    cq = cu_seqlens_q.tolist(); ck = cu_seqlens_kv.tolist(); outs=[]
    for i in range(len(cq)-1):
        qs,qe=cq[i],cq[i+1]; ks,ke=ck[i],ck[i+1]
        if qe<=qs: continue
        qi=q[qs:qe].transpose(0,1).unsqueeze(0); ki=k[ks:ke].transpose(0,1).unsqueeze(0); vi=v[ks:ke].transpose(0,1).unsqueeze(0)
        outs.append(F.scaled_dot_product_attention(qi,ki,vi).squeeze(0).transpose(0,1))
    return torch.cat(outs, dim=0)

'''
m="def attention(\n"; assert m in s, "attention() not found"
s=s.replace(m, helper+"\ndef attention(\n", 1)
old=('    elif mode == "flash":\n        x = flash_attn_varlen_func(\n            q,\n            k,\n            v,\n'
     '            cu_seqlens_q,\n            cu_seqlens_kv,\n            max_seqlen_q,\n            max_seqlen_kv,\n        )')
new=('    elif mode == "flash":\n        if flash_attn_varlen_func is None:\n'
     '            x = _sdpa_varlen(q, k, v, cu_seqlens_q, cu_seqlens_kv)\n        else:\n'
     '            x = flash_attn_varlen_func(\n                q,\n                k,\n                v,\n'
     '                cu_seqlens_q,\n                cu_seqlens_kv,\n                max_seqlen_q,\n                max_seqlen_kv,\n            )')
assert old in s, "flash branch not found verbatim (attenion.py changed upstream — patch by hand)"
open(f,'w').write(s.replace(old,new,1)); print("    patched")
PY
else
  echo "  ✓ attenion.py already has SDPA fallback (or absent)"
fi

echo "✅ diffusion-pipe setup complete. Verify: saga-dp-setup.sh --check"
echo "   Next: saga-hunyuan-fetch.sh  →  saga-video-lora-train.sh --user <U> --model hunyuan"
