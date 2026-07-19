#!/usr/bin/env bash
# ============================================================================
# saga-esrgan-video.sh — ESRGAN video upscale to ~2K (4x-AnimeSharp, per frame)
# ----------------------------------------------------------------------------
# Delivery upscale: extracts frames, runs each through 4x-AnimeSharp (the on-box
# A/B-chosen anime ESRGAN — crisp cel lines, temporally stable), caps the long
# edge to --max, and reassembles at the source fps. Frame-by-frame so it can't
# OOM on a long clip, and uses ONLY verified nodes (UpscaleModelLoader +
# ImageUpscaleWithModel + ImageScale). Slower than a batch graph, but bulletproof.
#
#   saga-esrgan-video.sh <input.mp4> [--method esrgan|lanczos] [--model 4x-AnimeSharp.pth] [--max 2048] [-o out.mp4]
#     --method esrgan  = crisp cel lines (per-frame ESRGAN, slow)   [default]
#     --method lanczos = soft/painterly (single ffmpeg pass, fast, no model)
#
# Env: SAGA_ROOT (required)  COMFY=http://127.0.0.1:8188
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
MODEL="${UPSCALE_MODEL:-4x-AnimeSharp.pth}"
IN=""; MAX=2048; OUT=""; METHOD="esrgan"   # esrgan = crisp cel lines; lanczos = soft (preserves a low-CFG painterly look)
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --model) MODEL="$2"; shift 2;; --max) MAX="$2"; shift 2;; -o|--out) OUT="$2"; shift 2;;
  --method) METHOD="$2"; shift 2;;
  -h|--help) sed -n '2,16p' "$0"; exit 0;;
  -*) die "unknown arg: $1";;
  *) IN="$1"; shift;;
esac; done
[ -n "$IN" ] && [ -f "$IN" ] || die "need <input.mp4>"
for t in ffmpeg ffprobe; do command -v "$t" >/dev/null || die "missing tool: $t"; done
[ "$METHOD" = "esrgan" ] && { for t in jq curl; do command -v "$t" >/dev/null || die "missing tool: $t"; done; }
OUT="${OUT:-${IN%.*}_2k.mp4}"

# target 2K dims (long edge = MAX, /8-aligned) from the stream dimensions
read -r OW OH < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=' ' "$IN" 2>/dev/null || echo "0 0")
GTW=0; GTH=0
if [ "${OW:-0}" -gt 0 ] && [ "${OH:-0}" -gt 0 ]; then
  if [ "$OW" -ge "$OH" ]; then GTW=$MAX; GTH=$(( (OH*MAX/OW+4)/8*8 )); else GTH=$MAX; GTW=$(( (OW*MAX/OH+4)/8*8 )); fi
fi

# SOFT path: single-pass lanczos — keeps the painterly/soft aesthetic that ESRGAN
# "AnimeSharp" would crisp away. Fast (no per-frame ComfyUI), no model needed.
if [ "$METHOD" = "lanczos" ]; then
  [ "$GTW" -gt 0 ] || die "lanczos needs stream dims (ffprobe failed on $IN)"
  echo "▶ soft upscale $(basename "$IN") → ${GTW}x${GTH} (lanczos)" >&2
  ffmpeg -y -i "$IN" -vf "scale=${GTW}:${GTH}:flags=lanczos" -c:v libx264 -pix_fmt yuv420p -crf 16 "$OUT" >/dev/null 2>&1 \
    || die "lanczos upscale failed"
  echo "✅ $OUT" >&2; echo "$OUT"; exit 0
fi
[ "$METHOD" = "esrgan" ] || die "unknown --method: $METHOD (use esrgan|lanczos)"

WORK="$SAGA_ROOT/tmp/.esrgan_vid_$$"; IND="$WORK/in"; OUTD="$WORK/out"; mkdir -p "$IND" "$OUTD"
cleanup(){ rm -rf "$WORK"; }; trap cleanup EXIT
FPS=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$IN" 2>/dev/null); FPS="${FPS:-16}"
echo "▶ esrgan-video $(basename "$IN")  model=$MODEL  cap=${MAX}px  fps=$FPS" >&2
ffmpeg -y -i "$IN" "$IND/f_%05d.png" >/dev/null 2>&1 || die "frame extraction failed"
N=$(find "$IND" -name 'f_*.png' | wc -l); [ "$N" -gt 0 ] || die "no frames extracted"

# 2K cap dims from the first frame (all frames share the size)
FIRST=$(find "$IND" -name 'f_*.png' | sort | head -1)
CAP=1; TW=0; TH=0
if command -v identify >/dev/null 2>&1; then
  read -r OW OH < <(identify -format "%w %h" "$FIRST" 2>/dev/null || echo "0 0")
  if [ "${OW:-0}" -gt 0 ] && [ "${OH:-0}" -gt 0 ]; then
    if [ "$OW" -ge "$OH" ]; then TW=$MAX; TH=$(( (OH*MAX/OW+4)/8*8 )); else TH=$MAX; TW=$(( (OW*MAX/OH+4)/8*8 )); fi
  else CAP=0; fi
else CAP=0; fi

CID="sagaesrv-$$-$RANDOM"
upload(){ curl -sf -F "image=@${1}" -F "overwrite=true" "$COMFY/upload/image" | jq -r '.name'; }
submit(){ curl -sf -X POST "$COMFY/prompt" --data "$(jq -nc --slurpfile g "$1" --arg c "$CID" '{prompt:$g[0], client_id:$c}')" | jq -r '.prompt_id'; }
wait_done(){ local id="$1" t=0 h st; while :; do h=$(curl -sf "$COMFY/history/$id"); if [ "$(jq -r --arg i "$id" 'has($i)' <<<"$h")" = "true" ]; then st=$(jq -r --arg i "$id" '.[$i].status.status_str // "ok"' <<<"$h"); [ "$st" = "error" ] && return 1; echo "$h"; return 0; fi; t=$((t+2)); [ "$t" -gt 300 ] && return 1; sleep 2; done; }
fetch_first(){ local h="$1" id="$2" dest="$3" line fn sf ty code base sub; line=$(jq -r --arg i "$id" '.[$i].outputs[] | ((.images // [])[0]) | select(.!=null) | "\(.filename)\t\(.subfolder)\t\(.type)"' <<<"$h" | head -n1); [ -n "$line" ] || return 1; IFS=$'\t' read -r fn sf ty <<<"$line"; code=$(curl -s -o "$dest" -w '%{http_code}' "$COMFY/view?filename=$(jq -rn --arg s "$fn" '$s|@uri')&subfolder=$(jq -rn --arg s "$sf" '$s|@uri')&type=${ty:-output}"); { [ "$code" = "200" ] && [ -s "$dest" ]; } && return 0; for base in "${COMFY_OUT:-}" "$SAGA_ROOT/engine/ComfyUI/output"; do [ -n "$base" ] || continue; sub="$base${sf:+/$sf}"; [ -f "$sub/$fn" ] && { cp -f "$sub/$fn" "$dest"; return 0; }; done; return 1; }

up_frame(){ # <src.png> <dest.png>
  local src="$1" dest="$2" name G pid hist; name=$(upload "$src") || return 1
  G=$(mktemp)
  { cat <<JSON
{
 "1":{"class_type":"UpscaleModelLoader","inputs":{"model_name":"$MODEL"}},
 "2":{"class_type":"LoadImage","inputs":{"image":"$name"}},
 "3":{"class_type":"ImageUpscaleWithModel","inputs":{"upscale_model":["1",0],"image":["2",0]}},
JSON
  if [ "$CAP" = "1" ]; then cat <<JSON
 "4":{"class_type":"ImageScale","inputs":{"image":["3",0],"upscale_method":"lanczos","width":$TW,"height":$TH,"crop":"disabled"}},
 "5":{"class_type":"SaveImage","inputs":{"filename_prefix":"esrv","images":["4",0]}}
}
JSON
  else cat <<JSON
 "5":{"class_type":"SaveImage","inputs":{"filename_prefix":"esrv","images":["3",0]}}
}
JSON
  fi; } > "$G"
  jq -e . "$G" >/dev/null || { rm -f "$G"; return 1; }
  pid=$(submit "$G"); rm -f "$G"; [ -n "$pid" ] && [ "$pid" != "null" ] || return 1
  hist=$(wait_done "$pid") || return 1
  fetch_first "$hist" "$pid" "$dest"
}

i=0; bad=0
for f in $(find "$IND" -name 'f_*.png' | sort); do
  i=$((i+1)); base=$(basename "$f"); dest="$OUTD/$base"
  if ! up_frame "$f" "$dest"; then
    # keep the clip complete: scale the source frame to target instead of dropping
    if [ "$CAP" = "1" ]; then ffmpeg -y -i "$f" -vf "scale=${TW}:${TH}:flags=lanczos" "$dest" >/dev/null 2>&1 || cp -f "$f" "$dest"; else cp -f "$f" "$dest"; fi
    bad=$((bad+1)); echo "  ⚠ frame $i fell back (esrgan failed)" >&2
  fi
  [ $((i % 25)) -eq 0 ] && echo "  … $i/$N frames" >&2
done
[ "$(find "$OUTD" -name 'f_*.png' | wc -l)" -eq "$N" ] || die "frame count mismatch after upscale"

ffmpeg -y -framerate "$FPS" -i "$OUTD/f_%05d.png" -c:v libx264 -pix_fmt yuv420p -crf 16 "$OUT" >/dev/null 2>&1 || die "reassembly failed"
echo "✅ $OUT  ($N frames, $bad fallbacks)" >&2
echo "$OUT"
