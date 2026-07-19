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
# ISOLATION: each prepared set gets its OWN parent dir so kohya (which trains on
# EVERY "<repeats>_<trigger>/" under --train_data_dir) never mixes two datasets.
# With --user, the parent is auto-allocated as datasets/dataset_<N> (next free
# integer) — the datasetId the front end registers (USER_STORAGE.md §3). A
# dataset.json manifest is written alongside the concept folder. --slot <id>
# pins a specific folder name; --out overrides the whole path.
#
#   saga-lora-dataset.sh --user gabrielgomez1 --raw DIR --trigger animegabriel   # → datasets/dataset_N/
#   saga-lora-dataset.sh --raw DIR --trigger exodia_saga [--out DIR] [--repeats 10] [--maxres 1536] [--caption "extra tags"]
#
# --autotag  WD14 per-image tags (kohya's tagger) + the trigger prepended, so every
#   variable attribute is a SEPARABLE, promptable concept and nothing incidental gets
#   welded into the identity token. Without it, all images share one blanket trigger
#   caption (identity + everything fused). Env: WD14_REPO, WD14_THRESH (default 0.35).
#
# Env: SAGA_ROOT (required)
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"

RAW=""; TRIGGER=""; REPEATS=10; MAXRES=1536; OUT=""; EXTRA=""; ROTATE=0; AUTOLAND=0; USERTOK=""; SLOT=""; AUTOTAG=0; PRUNE=""
# WD14 auto-tagging uses kohya's built-in tagger (already installed for training).
SDROOT="${SD_SCRIPTS:-$SAGA_ROOT/engine/sd-scripts}"; SDPY="$SDROOT/venv/bin/python"
WD14_REPO="${WD14_REPO:-SmilingWolf/wd-v1-4-convnextv2-tagger-v2}"; WD14_THRESH="${WD14_THRESH:-0.35}"
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --raw) RAW="$2"; shift 2;; --trigger) TRIGGER="$2"; shift 2;;
  --repeats) REPEATS="$2"; shift 2;; --maxres) MAXRES="$2"; shift 2;;
  --out) OUT="$2"; shift 2;; --caption) EXTRA="$2"; shift 2;;
  --user) USERTOK="$2"; shift 2;; --slot) SLOT="$2"; shift 2;;
  --autotag) AUTOTAG=1; shift;;      # WD14 per-image tags + trigger prepended (separable attributes)
  --prune) PRUNE="$2"; shift 2;;     # csv of tags to KEEP welded to the trigger (removed from captions, e.g. "beard,dark skin,brown eyes")
  --rotate) ROTATE="$2"; shift 2;;   # 0|90|180|270 clockwise, applied AFTER auto-orient (uniform)
  --autoland) AUTOLAND=1; shift;;    # rotate ONLY landscape (sideways) frames 90 CW; keep portrait/square
  -h|--help) sed -n '2,28p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done

[ -n "$RAW" ] && [ -d "$RAW" ] || die "need --raw <dir of images>"
[ -n "$TRIGGER" ] || die "need --trigger <token>"
command -v ffmpeg >/dev/null || die "ffmpeg required (for resize/convert)"
# sanitize trigger to match loraDataset.ts sanitizeStem (alnum + underscore)
TRIGGER=$(echo "$TRIGGER" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g')
[ -n "$TRIGGER" ] || die "trigger reduced to empty after sanitizing"

TAGGER=""
if [ "$AUTOTAG" = 1 ]; then
  [ -x "$SDPY" ] || die "--autotag needs the sd-scripts venv ($SDPY) — run saga-lora-setup.sh"
  for c in "$SDROOT/finetune/tag_images_by_wd14_tagger.py" "$SDROOT/tag_images_by_wd14_tagger.py"; do
    [ -f "$c" ] && { TAGGER="$c"; break; }
  done
  [ -n "$TAGGER" ] || die "WD14 tagger not found under $SDROOT (expected finetune/tag_images_by_wd14_tagger.py)"
fi

# --user → isolated, numbered parent under the user's datasets/ (front-end datasetId).
if [ -z "$OUT" ] && [ -n "$USERTOK" ]; then
  DSROOT="$SAGA_ROOT/users/$USERTOK/datasets"
  [ -d "$SAGA_ROOT/users/$USERTOK" ] || die "no user tree at $SAGA_ROOT/users/$USERTOK — run saga-user-init.sh first"
  if [ -n "$SLOT" ]; then OUT="$DSROOT/$SLOT"
  else N=1; while [ -e "$DSROOT/dataset_$N" ]; do N=$((N+1)); done; OUT="$DSROOT/dataset_$N"; fi
fi
OUT="${OUT:-$SAGA_ROOT/tmp/lora/${TRIGGER}_dataset}"
DID=$(basename "$OUT")
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
if [ "$AUTOLAND" = "1" ]; then
  [ "$ORIENT" = "ffmpeg" ] && die "--autoland needs ImageMagick (sudo apt-get install -y imagemagick)"
  ROTATE="90>"   # ImageMagick conditional: rotate 90 CW only if width > height (landscape)
  echo "  auto-rotating LANDSCAPE (sideways) frames 90° CW; portrait/square kept as-is"
fi
echo "  orientation: EXIF via $ORIENT${ROTATE:+ + rotate ${ROTATE}}"
tpose(){ case "$1" in 90) echo "transpose=1,";; 180) echo "transpose=1,transpose=1,";; 270) echo "transpose=2,";; *) echo "";; esac; }
convert_img(){ # <src> <dst>  — auto-orient (EXIF) THEN optional manual rotate
  case "$ORIENT" in
    magick)  magick "$1" -auto-orient -rotate "$ROTATE" -resize "${MAXRES}x${MAXRES}>" -background black -flatten "$2" 2>/dev/null;;
    convert) convert "$1" -auto-orient -rotate "$ROTATE" -resize "${MAXRES}x${MAXRES}>" -background black -flatten "$2" 2>/dev/null;;
    *)       ffmpeg -y -autorotate 1 -i "$1" -vf "$(tpose "$ROTATE")scale='min($MAXRES,iw)':-2,format=rgb24" "$2" >/dev/null 2>&1;;
  esac
}
n=0; bad=0
for f in "${SRC[@]}"; do
  n=$((n+1)); idx=$(printf '%03d' "$n"); base="${TRIGGER}_${idx}"
  if convert_img "$f" "$DIR/${base}.png"; then
    # with --autotag the caption is written later by WD14; otherwise blanket trigger
    [ "$AUTOTAG" = 1 ] || printf '%s' "$CAP" > "$DIR/${base}.txt"
  else
    echo "  ⚠️ skip (convert failed): $f"; bad=$((bad+1)); n=$((n-1))
  fi
done

if [ "$AUTOTAG" = 1 ]; then
  echo "▶ WD14 auto-tagging ($WD14_REPO, thresh $WD14_THRESH) — downloads the tagger on first run"
  # --onnx uses onnxruntime (NOT tensorflow) — lighter, and the backend we install below.
  ( cd "$SDROOT" && "$SDPY" "$TAGGER" "$DIR" --onnx --repo_id "$WD14_REPO" --thresh "$WD14_THRESH" \
      --caption_extension .txt --remove_underscore --batch_size 4 ) \
    || die "WD14 tagging failed. GPU onnxruntime often mismatches this box's CUDA
   (libcudart.so.NN). Tagging is light — use CPU onnxruntime (reliable, no CUDA):
     $SDPY -m pip uninstall -y onnxruntime-gpu
     $SDPY -m pip install onnxruntime huggingface_hub onnx"
  # Prepend the trigger (identity anchor) so it co-occurs with every image's tags;
  # everything else becomes a SEPARABLE, promptable concept — nothing incidental
  # gets welded into the identity token.
  # optional: drop identity-core tags so they stay bound to the trigger (stronger identity)
  prune_tags(){ [ -z "$PRUNE" ] && { cat; return; }
    awk -v prune="$PRUNE" 'BEGIN{ np=split(tolower(prune),P,/ *, */); for(i=1;i<=np;i++) DROP[P[i]]=1 }
      { nt=split($0,T,/ *, */); out="";
        for(i=1;i<=nt;i++){ g=T[i]; gsub(/^ +| +$/,"",g); if(g!="" && !(tolower(g) in DROP)) out=(out==""?g:out", "g) }
        print out }'; }
  tagged=0
  for t in "$DIR"/*.txt; do
    [ -f "$t" ] || continue
    tags=$(tr '\r\n' '  ' < "$t" | sed -E 's/[[:space:]]+$//' | prune_tags)
    printf '%s, %s' "$CAP" "$tags" > "$t"; tagged=$((tagged+1))
  done
  [ "$tagged" -gt 0 ] || die "WD14 wrote no .txt tags"
  echo "  captions: \"$CAP, <wd14 tags>\"${PRUNE:+  (pruned: $PRUNE)} ($tagged files)"
fi

CNT=$(find "$DIR" -name '*.png' | wc -l)

# manifest: front-end/registry record of this dataset (datasetId = parent folder name)
printf '{\n  "datasetId": "%s",\n  "trigger": "%s",\n  "repeats": %s,\n  "images": %s,\n  "caption": "%s",\n  "source": "%s",\n  "created": "%s"\n}\n' \
  "$DID" "$TRIGGER" "$REPEATS" "$CNT" "$CAP" "$RAW" "$(date -Iseconds 2>/dev/null || date)" > "$OUT/dataset.json"

echo "✅ prepared $CNT images (${bad} skipped) in $DIR"
echo "  datasetId: $DID   manifest: $OUT/dataset.json"
[ "$CNT" -lt 8 ] && echo "⚠️ only $CNT images — a character LoRA wants 15-30 varied shots; below 8 the trainer will refuse"
if [ "$AUTOTAG" = 1 ]; then echo "  caption (each .txt): \"$CAP, <per-image WD14 tags>\""; else echo "  caption (each .txt): \"$CAP\""; fi
echo "  next: saga-lora-train.sh --dataset \"$OUT\" --trigger $TRIGGER --name $TRIGGER --rank 32 --steps 2800"
echo "$OUT"
