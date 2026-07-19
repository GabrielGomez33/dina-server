#!/usr/bin/env bash
# ============================================================================
# saga-anime-batch.sh — batch photo→anime to build a LoRA training dataset
# ----------------------------------------------------------------------------
# Runs a whole folder of your real photos through the SAME img2img engine as
# saga-anime.sh (single source of truth for the graph — this script only
# orchestrates), at the LOCKED winning recipe (denoise 0.46 + the clean-hair
# prompt/negatives you picked), into a flat folder of consistent anime-you
# images. You then curate (delete the off-model ones) and feed the survivors
# straight into saga-lora-dataset.sh → saga-lora-train.sh.
#
# Why locked settings: a LoRA needs a STYLISTICALLY UNIFORM dataset. Same denoise
# + same style + same negatives across every image = one coherent look; the
# VARIETY (angles, expressions) comes from your different source photos, exactly
# what a character LoRA wants. Orientation is fixed first (uploads are sideways).
#
#   saga-anime-batch.sh --raw DIR [--autoland]
#      [--out DIR] [--denoise 0.46] [--prompt "..."] [--add-neg "..."]
#      [--lora F --lora-weight 0.5 --trigger T] [--seed 777] [--limit N]
#
# Idempotent: an image whose output already exists is skipped (safe to re-run).
# Env: SAGA_ROOT (required)  COMFY=http://127.0.0.1:8188
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
COMFY="${COMFY:-http://127.0.0.1:8188}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$SCRIPT_DIR/saga-anime.sh"

# --- Locked d046 winning recipe (defaults; override with flags) ---------------
RAW=""; OUT=""; DENOISE="0.46"; SEED=777; AUTOLAND=0; LIMIT=0
LORA=""; LORAW=0.5; TRIGGER=""
PROMPT="brown eyes, black hair, low cut waves, clean grouped hair, smooth eyebrows, tidy trimmed beard, clean sharp lineart"
ADDNEG="stray hair, flyaway hair, loose hairs, messy hair, frizzy hair, fuzzy edges, scattered hair strands, wispy hair, realistic hair texture, detailed hair strands"
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --raw) RAW="$2"; shift 2;; --out) OUT="$2"; shift 2;;
  --denoise) DENOISE="$2"; shift 2;; --seed) SEED="$2"; shift 2;;
  --prompt) PROMPT="$2"; shift 2;; --add-neg) ADDNEG="$2"; shift 2;;
  --lora) LORA="$2"; shift 2;; --lora-weight) LORAW="$2"; shift 2;; --trigger) TRIGGER="$2"; shift 2;;
  --autoland) AUTOLAND=1; shift;; --limit) LIMIT="$2"; shift 2;;
  -h|--help) sed -n '2,26p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done

[ -n "$RAW" ] && [ -d "$RAW" ] || die "need --raw <dir of your photos>"
[ -x "$ENGINE" ] || [ -f "$ENGINE" ] || die "img2img engine not found: $ENGINE"
command -v jq   >/dev/null || die "jq required"
command -v curl >/dev/null || die "curl required"
curl -sf "$COMFY/system_stats" >/dev/null 2>&1 || die "ComfyUI not reachable at $COMFY (start saga-comfyui)"
[ -z "$LORA" ] || [ -f "$SAGA_ROOT/models/loras/$LORA" ] || die "LoRA not found: models/loras/$LORA"
# orientation tool (only needed if we must fix rotation)
if command -v magick >/dev/null; then ORIENT="magick"; elif command -v convert >/dev/null; then ORIENT="convert"; else ORIENT=""; fi
[ "$AUTOLAND" = "1" ] && [ -z "$ORIENT" ] && die "--autoland needs ImageMagick (sudo apt-get install -y imagemagick)"

OUT="${OUT:-$SAGA_ROOT/tmp/dataset-anime}"
WORK="$SAGA_ROOT/tmp/.anime-batch-src"   # oriented sources (transient)
mkdir -p "$OUT" "$WORK"

# oriented copy: EXIF auto-orient, then optionally rotate ONLY landscape frames 90 CW
ROT="0"; [ "$AUTOLAND" = "1" ] && ROT="90>"
orient(){ # <src> <dst>
  if [ -n "$ORIENT" ]; then
    "$ORIENT" "$1" -auto-orient -rotate "$ROT" "$2" 2>/dev/null && return 0
  fi
  cp -f "$1" "$2"   # no ImageMagick and no autoland → pass through unchanged
}

mapfile -t SRC < <(find "$RAW" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.bmp' -o -iname '*.tif' -o -iname '*.tiff' -o -iname '*.heic' \) | sort)
[ "${#SRC[@]}" -gt 0 ] || die "no images found in $RAW"
[ "$LIMIT" -gt 0 ] 2>/dev/null && SRC=("${SRC[@]:0:$LIMIT}")

TAG=$(echo "$DENOISE" | tr -d '.')   # saga-anime.sh names outputs *_d<TAG>.png
echo "▶ batch photo→anime: ${#SRC[@]} images  denoise=$DENOISE  autoland=$AUTOLAND  lora=${LORA:-none}"
echo "  raw:  $RAW"
echo "  out:  $OUT"
echo "  recipe locked: prompt='$PROMPT'"

n=0; made=0; skipped=0; bad=0
for f in "${SRC[@]}"; do
  n=$((n+1)); idx=$(printf '%03d' "$n"); dest="$OUT/anime_${idx}.png"
  if [ -s "$dest" ]; then echo "  [$idx] skip (exists): $(basename "$dest")"; skipped=$((skipped+1)); continue; fi
  src_oriented="$WORK/src_${idx}.png"
  orient "$f" "$src_oriented" || { echo "  [$idx] ⚠ orient failed: $(basename "$f")"; bad=$((bad+1)); continue; }

  echo "  [$idx] $(basename "$f")"
  args=( --image "$src_oriented" --denoise "$DENOISE" --seed "$SEED"
         --prompt "$PROMPT" --add-neg "$ADDNEG" -o "_animebatch_${idx}" )
  [ -n "$LORA" ] && args+=( --lora "$LORA" --lora-weight "$LORAW" )
  [ -n "$TRIGGER" ] && args+=( --trigger "$TRIGGER" )

  if bash "$ENGINE" "${args[@]}" >/dev/null 2>"$WORK/err_${idx}.log"; then
    produced="$SAGA_ROOT/tmp/_animebatch_${idx}_d${TAG}.png"
    if [ -s "$produced" ]; then
      mv -f "$produced" "$dest"; echo "    ✅ $dest"; made=$((made+1))
    else
      echo "    ⚠ engine ran but no output file"; bad=$((bad+1))
    fi
  else
    echo "    ⚠ engine failed (see $WORK/err_${idx}.log):"; sed -n '$p' "$WORK/err_${idx}.log" | sed 's/^/       /'; bad=$((bad+1))
  fi
  rm -f "$src_oriented"
done

CNT=$(find "$OUT" -maxdepth 1 -name 'anime_*.png' | wc -l)
echo
echo "✅ batch done: $made new, $skipped skipped, $bad failed  →  $CNT anime images in $OUT"
echo "   NEXT:"
echo "   1) CURATE: open $OUT and delete every image that isn't on-model (keep 15-30 good ones)."
echo "   2) DATASET: bash $SCRIPT_DIR/saga-lora-dataset.sh --raw \"$OUT\" --trigger AnimeGabriel --repeats 10"
echo "   3) TRAIN:   bash $SCRIPT_DIR/saga-lora-train.sh --dataset <path from step 2> --trigger animegabriel --name animegabriel --rank 32 --steps 2800"
echo "   (anime images are already clean-styled, so training on them has no realism drag.)"
