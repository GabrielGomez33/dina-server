#!/usr/bin/env bash
# ============================================================================
# saga-flux-lora-dataset.sh — prep images into ai-toolkit's FLAT layout
# ----------------------------------------------------------------------------
# The Flux/ai-toolkit counterpart of saga-lora-dataset.sh (which emits the kohya
# "<repeats>_<trigger>/" layout for SDXL). Produces:
#     <out>/
#       <trigger>_001.png   (RGB, alpha flattened, downscaled to <= maxres)
#       <trigger>_001.txt   (caption)
#       ...
# a FLAT folder of image + same-stem .txt pairs — exactly what
# saga-flux-lora-train.sh / ai-toolkit expect. No GPU needed (unless --autotag).
#
#   saga-flux-lora-dataset.sh --raw DIR --trigger l1ttl3one [--out DIR] [--maxres 1024]
#       [--manifest FILE] [--caption "shared tags"] [--autotag]
#
# CAPTIONS — three ways, best first for a self-generated bootstrap set:
#   --manifest FILE : per-image captions we KNOW (we prompted them). One line per
#                     image, in sorted filename order:  <caption text>
#                     (blank line = trigger only). Most accurate: the pose/framing
#                     we asked for becomes the separable caption, so the LoRA learns
#                     "identity = trigger" and "pose = the words", not pose-as-identity.
#   --autotag       : WD14 per-image tags + trigger prepended (reuses the sd-scripts
#                     tagger; needs that venv). Use when captions aren't known.
#   (neither)       : blanket caption = "<trigger>[, <shared tags>]" on every image.
#
# The trigger is ALWAYS prepended so the identity token co-occurs with every image.
# Env: SAGA_ROOT (required)   WD14_REPO, WD14_THRESH (--autotag)
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"

RAW=""; TRIGGER=""; OUT=""; MAXRES=1024; EXTRA=""; MANIFEST=""; AUTOTAG=0
SDROOT="${SD_SCRIPTS:-$SAGA_ROOT/engine/sd-scripts}"; SDPY="$SDROOT/venv/bin/python"
WD14_REPO="${WD14_REPO:-SmilingWolf/wd-v1-4-convnextv2-tagger-v2}"; WD14_THRESH="${WD14_THRESH:-0.35}"
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --raw) RAW="$2"; shift 2;; --trigger) TRIGGER="$2"; shift 2;;
  --out) OUT="$2"; shift 2;; --maxres) MAXRES="$2"; shift 2;;
  --manifest) MANIFEST="$2"; shift 2;; --caption) EXTRA="$2"; shift 2;;
  --autotag) AUTOTAG=1; shift;;
  -h|--help) sed -n '2,34p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done

[ -n "$RAW" ] && [ -d "$RAW" ] || die "need --raw <dir of images>"
[ -n "$TRIGGER" ] || die "need --trigger <token>"
command -v ffmpeg >/dev/null || die "ffmpeg required (resize/convert)"
[ -z "$MANIFEST" ] || [ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST"
{ [ -n "$MANIFEST" ] && [ "$AUTOTAG" = 1 ]; } && die "--manifest and --autotag are mutually exclusive"
TRIGGER=$(echo "$TRIGGER" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g')
[ -n "$TRIGGER" ] || die "trigger reduced to empty after sanitizing"

OUT="${OUT:-$SAGA_ROOT/tmp/lora/${TRIGGER}_flux_dataset}"
rm -rf "$OUT"; mkdir -p "$OUT"
CAP="$TRIGGER"; [ -n "$EXTRA" ] && CAP="$TRIGGER, $EXTRA"

if command -v magick >/dev/null; then ORIENT="magick"; elif command -v convert >/dev/null; then ORIENT="convert"; else ORIENT="ffmpeg"; fi
convert_img(){ # <src> <dst> — RGB, EXIF auto-orient, alpha→black, downscale to <=maxres
  case "$ORIENT" in
    magick)  magick "$1" -auto-orient -resize "${MAXRES}x${MAXRES}>" -background black -flatten "$2" 2>/dev/null;;
    convert) convert "$1" -auto-orient -resize "${MAXRES}x${MAXRES}>" -background black -flatten "$2" 2>/dev/null;;
    *)       ffmpeg -y -autorotate 1 -i "$1" -vf "scale='min($MAXRES,iw)':-2,format=rgb24" "$2" >/dev/null 2>&1;;
  esac
}

mapfile -t SRC < <(find "$RAW" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.bmp' \) | sort)
[ "${#SRC[@]}" -gt 0 ] || die "no images found in $RAW"

# manifest lines (per-image captions), read in the SAME sorted order as SRC
MLINES=()
if [ -n "$MANIFEST" ]; then
  mapfile -t MLINES < "$MANIFEST"
  [ "${#MLINES[@]}" -ge "${#SRC[@]}" ] || die "manifest has ${#MLINES[@]} lines but ${#SRC[@]} images — one caption line per image (sorted-filename order)"
fi

echo "▶ flux dataset: trigger='$TRIGGER'  maxres=$MAXRES  images=${#SRC[@]}"
echo "  raw: $RAW"; echo "  out: $OUT"
echo "  captions: $([ -n "$MANIFEST" ] && echo "manifest ($MANIFEST)" || { [ "$AUTOTAG" = 1 ] && echo 'WD14 autotag' || echo "blanket \"$CAP\""; })"

n=0; bad=0
for f in "${SRC[@]}"; do
  n=$((n+1)); idx=$(printf '%03d' "$n"); base="${TRIGGER}_${idx}"
  if convert_img "$f" "$OUT/${base}.png"; then
    if [ -n "$MANIFEST" ]; then
      line="${MLINES[$((n-1))]}"; line="$(echo "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
      # always lead with the trigger; append the known pose/framing caption
      [ -n "$line" ] && printf '%s, %s' "$TRIGGER" "$line" > "$OUT/${base}.txt" \
                     || printf '%s' "$TRIGGER" > "$OUT/${base}.txt"
    elif [ "$AUTOTAG" != 1 ]; then
      printf '%s' "$CAP" > "$OUT/${base}.txt"
    fi
  else
    echo "  ⚠️ skip (convert failed): $f"; bad=$((bad+1)); n=$((n-1))
  fi
done

if [ "$AUTOTAG" = 1 ]; then
  [ -x "$SDPY" ] || die "--autotag needs the sd-scripts venv ($SDPY) — run saga-lora-setup.sh"
  TAGGER=""; for c in "$SDROOT/finetune/tag_images_by_wd14_tagger.py" "$SDROOT/tag_images_by_wd14_tagger.py"; do
    [ -f "$c" ] && { TAGGER="$c"; break; }; done
  [ -n "$TAGGER" ] || die "WD14 tagger not found under $SDROOT"
  echo "▶ WD14 auto-tagging ($WD14_REPO, thresh $WD14_THRESH)"
  NVLIBS=$("$SDPY" -c 'import os,glob,nvidia; b=os.path.dirname(nvidia.__file__); print(":".join(sorted(glob.glob(os.path.join(b,"*","lib")))))' 2>/dev/null || true)
  ( cd "$SDROOT" && LD_LIBRARY_PATH="${NVLIBS}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
      "$SDPY" "$TAGGER" "$OUT" --onnx --repo_id "$WD14_REPO" --thresh "$WD14_THRESH" \
      --caption_extension .txt --remove_underscore --batch_size 1 ) \
    || die "WD14 tagging failed (see saga-lora-dataset.sh notes for the onnxruntime-gpu pin)"
  for t in "$OUT"/*.txt; do
    [ -f "$t" ] || continue
    tags=$(tr '\r\n' '  ' < "$t" | sed -E 's/[[:space:]]+$//')
    printf '%s, %s' "$CAP" "$tags" > "$t"
  done
fi

CNT=$(find "$OUT" -maxdepth 1 -name '*.png' | wc -l)
echo "✅ prepared $CNT images (${bad} skipped) → $OUT"
[ "$CNT" -lt 8 ] && echo "⚠️ only $CNT images — a character LoRA wants 15-30 varied shots; the trainer refuses below 8"
echo "  next: saga-flux-lora-train.sh --dataset \"$OUT\" --name ${TRIGGER} --trigger ${TRIGGER}"
echo "$OUT"
