#!/usr/bin/env bash
# ============================================================================
# saga-shake.sh — add a handheld CAMERA TREMBLE to a clip (single concern: shake)
# ----------------------------------------------------------------------------
# Cinematic/action energy: oscillates a crop window over time (two out-of-phase
# frequencies = natural handheld jitter), then scales back to full size. Pure post
# geometry — no generation, no dependency on the pipeline.
#
#   saga-shake.sh <in.mp4> [--amp 12] [--fx 8] [--fy 11] [-o out.mp4]
#     --amp  shake amplitude in pixels (bigger = more violent). --fx/--fy = Hz.
# Env: SAGA_ROOT (required)
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
IN=""; AMP=12; FX=8; FY=11; OUT=""
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --amp) AMP="$2"; shift 2;; --fx) FX="$2"; shift 2;; --fy) FY="$2"; shift 2;;
  -o|--out) OUT="$2"; shift 2;; -h|--help) sed -n '2,14p' "$0"; exit 0;;
  -*) die "unknown arg: $1";; *) IN="$1"; shift;;
esac; done
[ -n "$IN" ] && [ -f "$IN" ] || die "need <input.mp4>"
command -v ffmpeg >/dev/null || die "ffmpeg required"; command -v ffprobe >/dev/null || die "ffprobe required"
case "$AMP" in ''|*[!0-9]*) die "--amp must be an integer px (got '$AMP')";; esac
OUT="${OUT:-${IN%.*}_shake.mp4}"
W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width  -of default=nk=1:nw=1 "$IN" 2>/dev/null)
H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nk=1:nw=1 "$IN" 2>/dev/null)
{ [ -n "$W" ] && [ -n "$H" ]; } || die "could not read dimensions of $IN"
CW=$((W-2*AMP)); CH=$((H-2*AMP))
{ [ "$CW" -gt 0 ] && [ "$CH" -gt 0 ]; } || die "--amp $AMP too large for ${W}x${H}"
# crop offset oscillates in [0, 2*AMP]; two out-of-phase sines → handheld feel; scale back.
VF="crop=${CW}:${CH}:x='${AMP}+${AMP}*sin(2*PI*t*${FX})':y='${AMP}+${AMP}*sin(2*PI*t*${FY}+1.3)',scale=${W}:${H}:flags=bicubic"
echo "▶ shake $(basename "$IN")  amp=${AMP}px  fx=${FX}Hz fy=${FY}Hz" >&2
ffmpeg -y -i "$IN" -vf "$VF" -c:v libx264 -pix_fmt yuv420p -crf 16 "$OUT" >/dev/null 2>&1 || die "shake failed"
echo "✅ $OUT" >&2
echo "$OUT"
