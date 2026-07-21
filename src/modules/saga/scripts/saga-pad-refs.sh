#!/usr/bin/env bash
# ============================================================================
# saga-pad-refs.sh — pad control reference images so the subject sits SMALLER in
#                    frame (single concern: geometry-only ref preprocessing)
# ----------------------------------------------------------------------------
# ControlNet (canny/openpose) copies the *composition* of the reference. Tight
# close-up refs → tight, zoomed-in, cropped output. This scales each ref down to a
# fraction of the target canvas and centers it on a neutral background, so the
# subject occupies less of the frame → ControlNet forces a WIDER shot (headroom,
# hands not cropped). Flat padding = no canny edges there → the model fills that
# margin freely from the prompt. Output keeps the SAME filenames so you can point
# SIGN_DIR= at the padded folder with no other change.
#
#   saga-pad-refs.sh --in DIR [--out DIR] [--scale 0.6] [-W 1280 -H 704] [--bg gray]
#     --scale  fraction of the canvas the subject fills (0.4–0.8; smaller = wider shot)
#     --out    default: <in>_padded
#
# Env: SAGA_ROOT (required)
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
IN=""; OUT=""; SCALE="0.6"; W=1280; H=704; BG="gray50"
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --in) IN="$2"; shift 2;; --out) OUT="$2"; shift 2;;
  --scale) SCALE="$2"; shift 2;; -W|--width) W="$2"; shift 2;; -H|--height) H="$2"; shift 2;;
  --bg) BG="$2"; shift 2;; -h|--help) sed -n '2,22p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done

# --- validation (fail fast) -------------------------------------------------
[ -n "$IN" ] && [ -d "$IN" ] || die "need --in <dir of reference pngs>"
command -v convert >/dev/null || die "ImageMagick 'convert' required (apt-get install imagemagick)"
case "$SCALE" in ''|*[!0-9.]*) die "--scale must be a number (got '$SCALE')";; esac
awk -v s="$SCALE" 'BEGIN{exit !(s>0 && s<=1)}' || die "--scale must be in (0,1] (got $SCALE)"
for d in "$W" "$H"; do case "$d" in ''|*[!0-9]*) die "-W/-H must be integers";; esac; done
OUT="${OUT:-${IN%/}_padded}"; mkdir -p "$OUT" || die "cannot create $OUT"

# inner box the subject is scaled to fit within (keeps aspect), then centered on WxH
SW=$(awk -v w="$W" -v s="$SCALE" 'BEGIN{printf "%d", w*s}')
SH=$(awk -v h="$H" -v s="$SCALE" 'BEGIN{printf "%d", h*s}')
[ "$SW" -gt 0 ] && [ "$SH" -gt 0 ] || die "computed inner size invalid ($SW x $SH)"

shopt -s nullglob
mapfile -t FILES < <(printf '%s\n' "$IN"/*.png "$IN"/*.jpg "$IN"/*.jpeg 2>/dev/null | sort -u)
[ "${#FILES[@]}" -gt 0 ] || die "no images (*.png/*.jpg) found in $IN"

echo "▶ pad ${#FILES[@]} refs → $OUT  (subject ${SCALE} of ${W}x${H}, bg=$BG)"
n=0; fail=0
for src in "${FILES[@]}"; do
  [ -f "$src" ] || continue
  dst="$OUT/$(basename "$src")"
  # resize to fit inside SWxSH (no upscale past it), pad to WxH centered on neutral bg
  if convert "$src" -resize "${SW}x${SH}" -background "$BG" -gravity center -extent "${W}x${H}" "$dst" 2>/dev/null; then
    [ -s "$dst" ] && { n=$((n+1)); echo "  ✓ $(basename "$dst")"; } || { fail=$((fail+1)); echo "  ✗ empty output: $(basename "$src")" >&2; }
  else
    fail=$((fail+1)); echo "  ✗ convert failed: $(basename "$src")" >&2
  fi
done
[ "$n" -gt 0 ] || die "padded 0 images"
echo "✅ padded $n image(s) → $OUT${fail:+  (${fail} failed)}"
echo "$OUT"
