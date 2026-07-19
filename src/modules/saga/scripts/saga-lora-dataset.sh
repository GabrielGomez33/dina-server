#!/usr/bin/env bash
# ============================================================================
# saga-lora-dataset.sh — prep a raw image folder into the kohya training layout
# ----------------------------------------------------------------------------
# Takes your gathered Exodia images and produces:
#   <out>/<repeats>_<trigger>/
#       <trigger>_001.png   (RGB, downscaled to <= maxres)
#       <trigger>_001.txt   (caption: the trigger token)
#       ...
# Mirrors core/loraDataset.ts (buildDatasetPlan): trigger-prepended captions,
# "<repeats>_<trigger>" folder. No GPU needed.
#
#   saga-lora-dataset.sh --raw DIR --trigger exodia_saga [--repeats 10] [--maxres 1536] [--out DIR] [--caption "extra tags"]
#
# Env: SAGA_ROOT (required)
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"

RAW=""; TRIGGER=""; REPEATS=10; MAXRES=1536; OUT=""; EXTRA=""
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --raw) RAW="$2"; shift 2;; --trigger) TRIGGER="$2"; shift 2;;
  --repeats) REPEATS="$2"; shift 2;; --maxres) MAXRES="$2"; shift 2;;
  --out) OUT="$2"; shift 2;; --caption) EXTRA="$2"; shift 2;;
  -h|--help) sed -n '2,20p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done

[ -n "$RAW" ] && [ -d "$RAW" ] || die "need --raw <dir of images>"
[ -n "$TRIGGER" ] || die "need --trigger <token>"
command -v ffmpeg >/dev/null || die "ffmpeg required (for resize/convert)"
# sanitize trigger to match loraDataset.ts sanitizeStem (alnum + underscore)
TRIGGER=$(echo "$TRIGGER" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g')
[ -n "$TRIGGER" ] || die "trigger reduced to empty after sanitizing"
OUT="${OUT:-$SAGA_ROOT/tmp/lora/${TRIGGER}_dataset}"
DIR="$OUT/${REPEATS}_${TRIGGER}"
CAP="$TRIGGER"; [ -n "$EXTRA" ] && CAP="$TRIGGER, $EXTRA"

rm -rf "$DIR"; mkdir -p "$DIR"
echo "▶ dataset: trigger='$TRIGGER'  repeats=$REPEATS  maxres=$MAXRES"
echo "  raw: $RAW"
echo "  out: $DIR"

# collect images (png/jpg/jpeg/webp/bmp), stable order
# JPEG/PNG preferred; tif/heic accepted if ImageMagick has the delegates.
# Camera RAW (.ARW etc.) is NOT decoded here — export to JPEG first.
mapfile -t SRC < <(find "$RAW" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.bmp' -o -iname '*.tif' -o -iname '*.tiff' -o -iname '*.heic' \) | sort)
[ "${#SRC[@]}" -gt 0 ] || die "no images found in $RAW"

# Convert one image → RGB PNG, downscaled to <=maxres, alpha flattened to black,
# and CRITICALLY apply EXIF orientation so phone photos aren't trained sideways.
# ImageMagick -auto-orient is authoritative; recent ffmpeg auto-applies EXIF too.
if command -v magick >/dev/null; then ORIENT="magick"; elif command -v convert >/dev/null; then ORIENT="convert"; else ORIENT="ffmpeg"; fi
echo "  orientation: EXIF via $ORIENT"
convert_img(){ # <src> <dst>
  case "$ORIENT" in
    magick)  magick "$1" -auto-orient -resize "${MAXRES}x${MAXRES}>" -background black -flatten "$2" 2>/dev/null;;
    convert) convert "$1" -auto-orient -resize "${MAXRES}x${MAXRES}>" -background black -flatten "$2" 2>/dev/null;;
    *)       ffmpeg -y -autorotate 1 -i "$1" -vf "scale='min($MAXRES,iw)':-2,format=rgb24" "$2" >/dev/null 2>&1;;
  esac
}
n=0; bad=0
for f in "${SRC[@]}"; do
  n=$((n+1)); idx=$(printf '%03d' "$n"); base="${TRIGGER}_${idx}"
  if convert_img "$f" "$DIR/${base}.png"; then
    printf '%s' "$CAP" > "$DIR/${base}.txt"
  else
    echo "  ⚠️ skip (convert failed): $f"; bad=$((bad+1)); n=$((n-1))
  fi
done

CNT=$(find "$DIR" -name '*.png' | wc -l)
echo "✅ prepared $CNT images (${bad} skipped) in $DIR"
[ "$CNT" -lt 8 ] && echo "⚠️ only $CNT images — a character LoRA wants 15-30 varied shots; below 8 the trainer will refuse"
echo "  caption (each .txt): \"$CAP\""
echo "  next: saga-lora-train.sh --dataset \"$OUT\" --trigger $TRIGGER --name Exodia"
echo "$OUT"
