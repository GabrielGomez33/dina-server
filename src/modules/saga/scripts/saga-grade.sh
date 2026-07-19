#!/usr/bin/env bash
# ============================================================================
# saga-grade.sh — color/grain grade a clip (single concern: the "film look")
# ----------------------------------------------------------------------------
# Pushes a too-clean/"3D"-looking render toward hand-drawn analog anime by adding
# film grain and muting/contrasting the palette. Presets are reusable across the
# whole show's aesthetic — not specific to one clip.
#
#   saga-grade.sh <input.mp4> [--preset lain|grain|none] [-o out.mp4]
#     lain  = desaturated, muted, contrasty + grain (Serial Experiments Lain vibe)
#     grain = grain only, palette untouched
#     none  = passthrough (copy)
#
# Env: SAGA_ROOT (required)
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
IN=""; PRESET="lain"; OUT=""
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --preset) PRESET="$2"; shift 2;; -o|--out) OUT="$2"; shift 2;;
  -h|--help) sed -n '2,16p' "$0"; exit 0;;
  -*) die "unknown arg: $1";;
  *) IN="$1"; shift;;
esac; done
[ -n "$IN" ] && [ -f "$IN" ] || die "need <input.mp4>"
command -v ffmpeg >/dev/null || die "ffmpeg required"
OUT="${OUT:-${IN%.*}_${PRESET}.mp4}"

case "$PRESET" in
  lain)  VF="eq=saturation=0.68:contrast=1.10:brightness=-0.015,noise=alls=14:allf=t+u";;
  grain) VF="noise=alls=12:allf=t+u";;
  none)  cp -f "$IN" "$OUT"; echo "$OUT"; exit 0;;
  *) die "unknown --preset: $PRESET (lain|grain|none)";;
esac

echo "▶ grade $(basename "$IN") [$PRESET]" >&2
ffmpeg -y -i "$IN" -vf "$VF" -c:v libx264 -pix_fmt yuv420p -crf 16 "$OUT" >/dev/null 2>&1 \
  || die "grade failed"
echo "✅ $OUT" >&2
echo "$OUT"
