#!/usr/bin/env bash
# ============================================================================
# saga-upscale.sh — ESRGAN still upscale (single concern: polish a PNG to ~2K)
# ----------------------------------------------------------------------------
# Runs an image through 4x-AnimeSharp (the anime-ESRGAN chosen by the on-box A/B,
# VERIFICATION.md) via UpscaleModelLoader + ImageUpscaleWithModel, then caps the
# long edge to --max (default 2048) so the deliverable is a crisp 2K, not a raw
# 4x. Cel lines stay sharp. Used standalone or as saga-render.sh's polish step.
#
#   saga-upscale.sh --image IMG [--model 4x-AnimeSharp.pth] [--max 2048] [-o NAME]
#
# Env: SAGA_ROOT (required)  COMFY=http://127.0.0.1:8188
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
IMG=""; MODEL="${UPSCALE_MODEL:-4x-AnimeSharp.pth}"; MAX=2048; OUT="saga_upscaled"
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --image) IMG="$2"; shift 2;; --model) MODEL="$2"; shift 2;;
  --max) MAX="$2"; shift 2;; -o|--out) OUT="$2"; shift 2;;
  -h|--help) sed -n '2,16p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
[ -n "$IMG" ] && [ -f "$IMG" ] || die "need --image <png>"
command -v jq >/dev/null || die "jq required"

# Target dims = original scaled so its long edge == MAX (/8-aligned). Computed from
# the ORIGINAL; the 4x ESRGAN output is downsampled to it → crisp. Skip cap if no identify.
CAP=1; TW=0; TH=0
if command -v identify >/dev/null 2>&1; then
  read -r OW OH < <(identify -format "%w %h" "$IMG[0]" 2>/dev/null || echo "0 0")
  if [ "${OW:-0}" -gt 0 ] && [ "${OH:-0}" -gt 0 ]; then
    if [ "$OW" -ge "$OH" ]; then TW=$MAX; TH=$(( (OH*MAX/OW + 4)/8*8 )); else TH=$MAX; TW=$(( (OW*MAX/OH + 4)/8*8 )); fi
    [ "$TW" -lt 8 ] && TW=8; [ "$TH" -lt 8 ] && TH=8
  else CAP=0; fi
else CAP=0; echo "  ⚠ imagemagick 'identify' absent — delivering raw 4x (no 2K cap)"; fi

CID="sagaups-$$-$RANDOM"
upload(){ curl -sf -F "image=@${1}" -F "overwrite=true" "$COMFY/upload/image" | jq -r '.name' || die "upload failed: $1"; }
submit(){ curl -sf -X POST "$COMFY/prompt" --data "$(jq -nc --slurpfile g "$1" --arg c "$CID" '{prompt:$g[0], client_id:$c}')" | jq -r '.prompt_id' || die "submit rejected"; }
wait_done(){ local id="$1" t=0 h st; while :; do h=$(curl -sf "$COMFY/history/$id"); if [ "$(jq -r --arg i "$id" 'has($i)' <<<"$h")" = "true" ]; then st=$(jq -r --arg i "$id" '.[$i].status.status_str // "ok"' <<<"$h"); if [ "$st" = "error" ]; then jq -r --arg i "$id" '.[$i].status.messages[]? | select(.[0]=="execution_error") | .[1] | "  ⤷ node \(.node_id) (\(.node_type)): \(.exception_type): \(.exception_message)"' <<<"$h" >&2; die "execution error for $id"; fi; echo "$h"; return 0; fi; t=$((t+3)); [ "$t" -gt 900 ] && die "timeout for $id"; sleep 3; done; }
fetch_first(){ local h="$1" id="$2" dest="$3" line fn sf ty code base sub src; line=$(jq -r --arg i "$id" '.[$i].outputs[] | ((.images // [])[0]) | select(.!=null) | "\(.filename)\t\(.subfolder)\t\(.type)"' <<<"$h" | head -n1); [ -n "$line" ] || die "no output for $id"; IFS=$'\t' read -r fn sf ty <<<"$line"; code=$(curl -s -o "$dest" -w '%{http_code}' "$COMFY/view?filename=$(jq -rn --arg s "$fn" '$s|@uri')&subfolder=$(jq -rn --arg s "$sf" '$s|@uri')&type=${ty:-output}"); { [ "$code" = "200" ] && [ -s "$dest" ]; } && { echo "$dest"; return 0; }; rm -f "$dest"; for base in "${COMFY_OUT:-}" "$SAGA_ROOT/engine/ComfyUI/output"; do [ -n "$base" ] || continue; sub="$base${sf:+/$sf}"; [ -f "$sub/$fn" ] && { cp -f "$sub/$fn" "$dest"; echo "$dest"; return 0; }; done; src=$(find "$SAGA_ROOT/engine" -name "$fn" -print -quit 2>/dev/null); [ -n "$src" ] && { cp -f "$src" "$dest"; echo "$dest"; return 0; }; die "could not retrieve $fn (http=$code)"; }

IMG_NAME=$(upload "$IMG")
G=$(mktemp)
{
cat <<JSON
{
 "1":{"class_type":"UpscaleModelLoader","inputs":{"model_name":"$MODEL"}},
 "2":{"class_type":"LoadImage","inputs":{"image":"$IMG_NAME"}},
 "3":{"class_type":"ImageUpscaleWithModel","inputs":{"upscale_model":["1",0],"image":["2",0]}},
JSON
if [ "$CAP" = "1" ]; then cat <<JSON
 "4":{"class_type":"ImageScale","inputs":{"image":["3",0],"upscale_method":"lanczos","width":$TW,"height":$TH,"crop":"disabled"}},
 "5":{"class_type":"SaveImage","inputs":{"filename_prefix":"$OUT","images":["4",0]}}
}
JSON
else cat <<JSON
 "5":{"class_type":"SaveImage","inputs":{"filename_prefix":"$OUT","images":["3",0]}}
}
JSON
fi
} > "$G"
jq -e . "$G" >/dev/null || die "internal: invalid graph"
echo "▶ upscale $(basename "$IMG") via $MODEL${CAP:+ → cap ${TW}x${TH}}"
PID=$(submit "$G"); HIST=$(wait_done "$PID")
DEST="$SAGA_ROOT/tmp/${OUT}.png"
fetch_first "$HIST" "$PID" "$DEST" >/dev/null; rm -f "$G"
echo "✅ $DEST"
echo "$DEST"
