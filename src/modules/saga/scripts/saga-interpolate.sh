#!/usr/bin/env bash
# ============================================================================
# saga-interpolate.sh — smooth motion by frame interpolation (ffmpeg minterpolate)
# ----------------------------------------------------------------------------
# Motion-compensated interpolation to raise a clip's fps (e.g. 16 → 32) so the
# FLF/step motion reads smoother. Pure ffmpeg — no ComfyUI node dependency, so it
# always runs. (RIFE VFI is higher quality but its node isn't confirmed on the box;
# swap it in here later if installed.)
#
#   saga-interpolate.sh <input.mp4> [--fps 32] [-o out.mp4]
#
# Env: SAGA_ROOT (required)
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
IN=""; FPS=32; OUT=""
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --fps) FPS="$2"; shift 2;; -o|--out) OUT="$2"; shift 2;;
  -h|--help) sed -n '2,16p' "$0"; exit 0;;
  -*) die "unknown arg: $1";;
  *) IN="$1"; shift;;
esac; done
[ -n "$IN" ] && [ -f "$IN" ] || die "need <input.mp4>"
command -v ffmpeg >/dev/null || die "ffmpeg required"
OUT="${OUT:-${IN%.*}_${FPS}fps.mp4}"

echo "▶ interpolate $(basename "$IN") → ${FPS}fps (minterpolate)" >&2
# mci + aobmc + bidirectional ME: best-quality minterpolate mode.
ffmpeg -y -i "$IN" \
  -vf "minterpolate=fps=${FPS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1" \
  -c:v libx264 -pix_fmt yuv420p -crf 16 "$OUT" >/dev/null 2>&1 \
  || die "minterpolate failed (try a lower --fps, or an mp4 with a clean CFR stream)"
echo "✅ $OUT" >&2
echo "$OUT"
