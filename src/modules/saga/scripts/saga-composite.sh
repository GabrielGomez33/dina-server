#!/usr/bin/env bash
# ============================================================================
# saga-composite.sh — overlay a cut-out character onto a background plate (ffmpeg)
# ----------------------------------------------------------------------------
# Deterministic character consistency: when a trained LoRA can't pixel-lock a
# novel character across shots, composite ONE canonical cut-out (transparent PNG)
# into many separately-generated scene backgrounds. The character is then
# pixel-identical in every shot — variance eliminated by construction. Scene
# variety comes from the backgrounds + the character's scale/position; per-scene
# relighting keeps the paste from looking flat.
#
#   saga-composite.sh --bg bg.png --char char_cutout.png -o out.png
#     [--scale 0.45]        character HEIGHT as a fraction of frame height
#     [--x 0.5] [--y 0.92]  character CENTER-x and FEET-y as fractions of frame (0..1)
#     [--tint none|warm|cool]   relight the character to match the scene
#     [--shadow 0|1]        soft contact shadow under the character (default 1)
#     [-W 768 -H 1344]      output frame size (default matches the vertical shots)
#
# char must be a TRANSPARENT PNG (cut out the canonical with rembg:
#   pip install rembg onnxruntime ; rembg i canonical.png char_cutout.png).
# Output is a flat PNG ready for FramePack (which then animates the composite).
# ============================================================================
set -uo pipefail
BG=""; CHAR=""; OUT=""; SCALE="0.45"; PX="0.5"; PY="0.92"; TINT="none"; SHADOW=1; W=768; H=1344
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --bg) BG="$2"; shift 2;; --char) CHAR="$2"; shift 2;; -o|--out) OUT="$2"; shift 2;;
  --scale) SCALE="$2"; shift 2;; --x) PX="$2"; shift 2;; --y) PY="$2"; shift 2;;
  --tint) TINT="$2"; shift 2;; --shadow) SHADOW="$2"; shift 2;;
  -W|--width) W="$2"; shift 2;; -H|--height) H="$2"; shift 2;;
  -h|--help) sed -n '2,26p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
[ -n "$BG" ] && [ -f "$BG" ] || die "need --bg <background.png>"
[ -n "$CHAR" ] && [ -f "$CHAR" ] || die "need --char <transparent cutout.png>"
[ -n "$OUT" ] || die "need -o <out.png>"
command -v ffmpeg >/dev/null || die "ffmpeg required"

# per-scene relight of the character so a cool cut-out doesn't sit flat on warm footage (and vice-versa)
case "$TINT" in
  warm) CT="colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.06:bm=-0.06,eq=brightness=0.02";;
  cool) CT="colorbalance=rs=-0.06:gs=0.00:bs=0.08:rm=-0.04:bm=0.05,eq=brightness=-0.01";;
  none) CT="null";;
  *) die "--tint must be none|warm|cool";;
esac

# The character is scaled to SCALE*H tall (aspect kept). Placed by center-x / feet-y.
# overlay x = frame_w*PX - char_w/2 ; y = frame_h*PY - char_h  (feet land on PY).
CH_H=$(awk -v h="$H" -v s="$SCALE" 'BEGIN{printf "%d", h*s}')
OX="main_w*${PX}-overlay_w/2"; OY="main_h*${PY}-overlay_h"

if [ "$SHADOW" -eq 1 ]; then
  # a soft elliptical contact shadow: blurred, squashed silhouette of the character, low opacity,
  # laid just under the feet before the character itself.
  FILT="[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[bg];
        [1:v]scale=-1:${CH_H}[ch0];[ch0]${CT}[ch];
        [1:v]scale=-1:${CH_H}[shsrc];
        [shsrc]format=rgba,colorchannelmixer=rr=0:gg=0:bb=0:aa=0.35,scale=iw:ih*0.18,boxblur=12:1[shadow];
        [bg][shadow]overlay=x=${OX}:y=main_h*${PY}-overlay_h*0.5[bgs];
        [bgs][ch]overlay=x=${OX}:y=${OY}[out]"
else
  FILT="[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[bg];
        [1:v]scale=-1:${CH_H}[ch0];[ch0]${CT}[ch];
        [bg][ch]overlay=x=${OX}:y=${OY}[out]"
fi

echo "▶ composite: $(basename "$CHAR") @ scale=${SCALE} pos=(${PX},${PY}) tint=${TINT} shadow=${SHADOW} onto $(basename "$BG")" >&2
ffmpeg -y -i "$BG" -i "$CHAR" -filter_complex "$FILT" -map "[out]" -frames:v 1 "$OUT" >/dev/null 2>&1 \
  || die "composite failed (check the cutout is a transparent PNG and sizes are sane)"
echo "✅ $OUT" >&2
echo "$OUT"
