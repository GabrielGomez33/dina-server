#!/usr/bin/env bash
# ============================================================================
# saga-3d-rig.sh — auto-rig a mesh with UniRig (STAGE 3): skeleton → skin → merge.
# ----------------------------------------------------------------------------
# Runs UniRig's three inference stages headlessly and produces a RIGGED GLB
# (armature + per-vertex skin weights) that Blender/bpy can pose (Stage 4).
#   1) generate_skeleton : mesh → predicted skeleton FBX
#   2) generate_skin     : skeleton FBX → skin-weight FBX
#   3) merge             : skin FBX (--source) onto the ORIGINAL mesh (--target) → rigged GLB
#      (merge the SKIN file, not the skeleton — merging a skeleton yields no weights.)
#
#   saga-3d-rig.sh --in little_one_upright.glb --out little_one_rigged.glb
#   saga-3d-rig.sh --in ... --out ... --work /workspace/SAGA/tmp/rigwork --keep
#
# Feed a conventionally-oriented (Y-up) mesh — use saga-3d-orient.py output.
# Env: SAGA_ROOT, UNIRIG_HOME, HF_HOME (weights cache — point at the volume).
# ============================================================================
set -uo pipefail
SAGA_ROOT="${SAGA_ROOT:-/workspace/SAGA}"
UNIRIG_HOME="${UNIRIG_HOME:-$SAGA_ROOT/engine/UniRig}"
export HF_HOME="${HF_HOME:-$SAGA_ROOT/hf_home/huggingface}"
IN=""; OUT=""; WORK=""; KEEP=0
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --in) IN="$2"; shift 2;;  -o|--out) OUT="$2"; shift 2;;
  --work) WORK="$2"; shift 2;;  --keep) KEEP=1; shift;;
  -h|--help) sed -n '2,22p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
[ -n "$IN" ] && [ -f "$IN" ] || die "need --in <mesh.glb> (existing)"
IN="$(readlink -f "$IN")"
OUT="${OUT:-${IN%.*}_rigged.glb}"; OUT="$(readlink -f "$OUT" 2>/dev/null || echo "$OUT")"
WORK="${WORK:-$SAGA_ROOT/tmp/rigwork}"; mkdir -p "$WORK"
[ -d "$UNIRIG_HOME/.venv" ] || die "UniRig venv missing — run saga-unirig-setup.sh first"

# shellcheck disable=SC1091
. "$UNIRIG_HOME/.venv/bin/activate"
cd "$UNIRIG_HOME"

SKEL="$WORK/skeleton.fbx"; SKIN="$WORK/skin.fbx"
run(){ echo "▶ $*" >&2; "$@" || die "stage failed: $1"; }

echo "▶ rig: $(basename "$IN") → $(basename "$OUT")  (work=$WORK, HF_HOME=$HF_HOME)" >&2
run bash launch/inference/generate_skeleton.sh --input "$IN"   --output "$SKEL"
[ -f "$SKEL" ] || die "no skeleton produced ($SKEL)"
run bash launch/inference/generate_skin.sh     --input "$SKEL" --output "$SKIN"
[ -f "$SKIN" ] || die "no skin produced ($SKIN)"
run bash launch/inference/merge.sh --source "$SKIN" --target "$IN" --output "$OUT"
[ -f "$OUT" ] || die "no rigged output produced ($OUT)"

[ "$KEEP" -eq 1 ] || rm -f "$SKEL" "$SKIN"
echo "✅ rigged → $OUT" >&2
echo "$OUT"
