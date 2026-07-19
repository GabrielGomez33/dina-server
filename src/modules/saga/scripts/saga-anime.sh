#!/usr/bin/env bash
# ============================================================================
# saga-anime.sh — realistic photo → anime via IMG2IMG (the Pixlio approach)
# ----------------------------------------------------------------------------
# This is the block we were missing. Every other SAGA script is txt2img (invent
# an image from a prompt, optionally steered by a face embedding) — which is why
# InstantID read as "prompt-gen, not reference-gen." Photo-to-anime services
# (Pixlio et al.) do the OPPOSITE: img2img. Your PHOTO is the canvas; the anime
# checkpoint restyles its surface while DENOISE controls how far it drifts from
# the original. Composition, pose, clothing, and — crucially — your real facial
# geometry are preserved because they come from the pixels, not a prompt.
#
# denoise is THE knob:
#   0.40–0.50  barely stylized, very faithful (still reads photo-ish)
#   0.55–0.65  the sweet spot — clearly anime, structure intact  ← Pixlio-like
#   0.70–0.80  strong anime restyle, starts to drift from your face
#
# Default runs a DENOISE SWEEP so you pick the fidelity/style balance by eye.
# No new models needed — uses the Animagine checkpoint already on the box.
#
#   saga-anime.sh --image PHOTO
#      [--prompt "brown eyes, black hair, low cut waves"]    # detail hints only
#      [--denoise 0.6]                 # single value instead of the sweep
#      [--sweep "0.45 0.55 0.65 0.75"] # override the sweep points
#      [--lora F --lora-weight 0.5 --trigger T]   # optional identity booster
#      [--style "..."] [--seed 777] [--steps 30] [--cfg 6.5] [-o NAME]
#
# VAEEncode's image input is named "pixels" (verified). SDXL is happiest near
# ~1MP, so the photo is scaled to a 1024 long-edge (aspect preserved, /8-aligned)
# before encoding — avoids the anatomy-doubling that >1024 latents cause.
# Env: SAGA_ROOT (required)  COMFY=http://127.0.0.1:8188  ANIME_CKPT=animagine-xl-4.0.safetensors
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
CKPT="${ANIME_CKPT:-animagine-xl-4.0.safetensors}"

IMG=""; PROMPT=""; DENOISE=""; SWEEP="0.45 0.55 0.65 0.75"
LORA=""; LORAW=0.5; TRIGGER=""; SEED=777; STEPS=30; CFG=6.5; OUT="saga_anime"
STYLE="anime, anime screencap, cel shading, clean lineart, flat colors, detailed anime, masterpiece, best quality"
NEG="lowres, bad anatomy, bad hands, extra fingers, worst quality, blurry, deformed, multiple people, watermark, text, signature, photorealistic, 3d render"
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --image) IMG="$2"; shift 2;; --prompt) PROMPT="$2"; shift 2;;
  --denoise) DENOISE="$2"; shift 2;; --sweep) SWEEP="$2"; shift 2;;
  --lora) LORA="$2"; shift 2;; --lora-weight) LORAW="$2"; shift 2;; --trigger) TRIGGER="$2"; shift 2;;
  --style) STYLE="$2"; shift 2;; -n|--neg) NEG="$2"; shift 2;;
  --seed) SEED="$2"; shift 2;; --steps) STEPS="$2"; shift 2;; --cfg) CFG="$2"; shift 2;;
  -o|--out) OUT="$2"; shift 2;;
  -h|--help) sed -n '2,40p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
[ -n "$IMG" ] && [ -f "$IMG" ] || die "need --image <your photo>"
command -v jq >/dev/null || die "jq required"
[ -z "$LORA" ] || [ -f "$SAGA_ROOT/models/loras/$LORA" ] || die "LoRA not found: models/loras/$LORA"
[ -n "$DENOISE" ] && SWEEP="$DENOISE"   # single value overrides the sweep
# Detail hints + trigger are prepended; STYLE pushes the anime restyle.
FULLPROMPT="$STYLE"; [ -n "$PROMPT" ] && FULLPROMPT="$PROMPT, $STYLE"
[ -n "$TRIGGER" ] && FULLPROMPT="$TRIGGER, $FULLPROMPT"

# Scale to a 1024 long edge, /8-aligned, aspect preserved. identify → fallback 1024².
TW=1024; TH=1024
if command -v identify >/dev/null 2>&1; then
  read -r SW SH < <(identify -format "%w %h" "$IMG[0]" 2>/dev/null || echo "1024 1024")
  if [ "${SW:-0}" -gt 0 ] && [ "${SH:-0}" -gt 0 ]; then
    if [ "$SW" -ge "$SH" ]; then TW=1024; TH=$(( (SH*1024/SW + 4) / 8 * 8 ));
    else TH=1024; TW=$(( (SW*1024/SH + 4) / 8 * 8 )); fi
    [ "$TW" -lt 8 ] && TW=8; [ "$TH" -lt 8 ] && TH=8
  fi
else echo "  ⚠ imagemagick 'identify' not found — scaling to 1024x1024 (fine for square photos)"; fi

CID="sagaanime-$$-$RANDOM"
upload(){ curl -sf -F "image=@${1}" -F "overwrite=true" "$COMFY/upload/image" | jq -r '.name' || die "upload failed: $1"; }
submit(){ curl -sf -X POST "$COMFY/prompt" --data "$(jq -nc --slurpfile g "$1" --arg c "$CID" '{prompt:$g[0], client_id:$c}')" | jq -r '.prompt_id' || die "submit rejected"; }
wait_done(){ local id="$1" t=0 h st; while :; do h=$(curl -sf "$COMFY/history/$id"); if [ "$(jq -r --arg i "$id" 'has($i)' <<<"$h")" = "true" ]; then st=$(jq -r --arg i "$id" '.[$i].status.status_str // "ok"' <<<"$h"); if [ "$st" = "error" ]; then jq -r --arg i "$id" '.[$i].status.messages[]? | select(.[0]=="execution_error") | .[1] | "  ⤷ node \(.node_id) (\(.node_type)): \(.exception_type): \(.exception_message)"' <<<"$h" >&2; die "execution error for $id"; fi; echo "$h"; return 0; fi; t=$((t+3)); [ "$t" -gt 1800 ] && die "timeout for $id"; sleep 3; done; }
fetch_first(){ local h="$1" id="$2" dest="$3" line fn sf ty code base sub src; line=$(jq -r --arg i "$id" '.[$i].outputs[] | ((.images // [])[0]) | select(.!=null) | "\(.filename)\t\(.subfolder)\t\(.type)"' <<<"$h" | head -n1); [ -n "$line" ] || die "no output for $id"; IFS=$'\t' read -r fn sf ty <<<"$line"; code=$(curl -s -o "$dest" -w '%{http_code}' "$COMFY/view?filename=$(jq -rn --arg s "$fn" '$s|@uri')&subfolder=$(jq -rn --arg s "$sf" '$s|@uri')&type=${ty:-output}"); { [ "$code" = "200" ] && [ -s "$dest" ]; } && { echo "$dest"; return 0; }; rm -f "$dest"; for base in "${COMFY_OUT:-}" "$SAGA_ROOT/engine/ComfyUI/output"; do [ -n "$base" ] || continue; sub="$base${sf:+/$sf}"; [ -f "$sub/$fn" ] && { cp -f "$sub/$fn" "$dest"; echo "$dest"; return 0; }; done; src=$(find "$SAGA_ROOT/engine" -name "$fn" -print -quit 2>/dev/null); [ -n "$src" ] && { cp -f "$src" "$dest"; echo "$dest"; return 0; }; die "could not retrieve $fn (http=$code)"; }

echo "▶ photo→anime (img2img): $(basename "$IMG")  scaled→${TW}x${TH}  lora=${LORA:-none}@$LORAW  sweep=[$SWEEP]"
IMG_NAME=$(upload "$IMG"); echo "  uploaded: $IMG_NAME"
if [ -n "$LORA" ]; then MODEL='["40",0]'; CLIP='["40",1]'; else MODEL='["1",0]'; CLIP='["1",1]'; fi

gen(){ # <out> <denoise>
  local out="$1" den="$2" G; G=$(mktemp)
  {
  cat <<JSON
{
 "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"$CKPT"}},
JSON
  [ -n "$LORA" ] && cat <<JSON
 "40":{"class_type":"LoraLoader","inputs":{"model":["1",0],"clip":["1",1],"lora_name":"$LORA","strength_model":$LORAW,"strength_clip":$LORAW}},
JSON
  cat <<JSON
 "2":{"class_type":"LoadImage","inputs":{"image":"$IMG_NAME"}},
 "3":{"class_type":"ImageScale","inputs":{"image":["2",0],"upscale_method":"lanczos","width":$TW,"height":$TH,"crop":"disabled"}},
 "4":{"class_type":"VAEEncode","inputs":{"pixels":["3",0],"vae":["1",2]}},
 "5":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$FULLPROMPT" '$s'),"clip":$CLIP}},
 "6":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$NEG" '$s'),"clip":$CLIP}},
 "7":{"class_type":"KSampler","inputs":{"seed":$SEED,"steps":$STEPS,"cfg":$CFG,"sampler_name":"dpmpp_2m","scheduler":"karras","denoise":$den,"model":$MODEL,"positive":["5",0],"negative":["6",0],"latent_image":["4",0]}},
 "8":{"class_type":"VAEDecode","inputs":{"samples":["7",0],"vae":["1",2]}},
 "9":{"class_type":"SaveImage","inputs":{"filename_prefix":"$out","images":["8",0]}}
}
JSON
  } > "$G"
  jq -e . "$G" >/dev/null || die "internal: invalid graph"
  local pid; pid=$(submit "$G"); echo "    [$out] submitted: $pid"
  local hist; hist=$(wait_done "$pid")
  fetch_first "$hist" "$pid" "$SAGA_ROOT/tmp/${out}.png" >/dev/null
  echo "    ✅ $SAGA_ROOT/tmp/${out}.png"; rm -f "$G"
}

for den in $SWEEP; do
  tag=$(echo "$den" | tr -d '.')
  echo "── denoise=$den"
  gen "${OUT}_d${tag}" "$den"
done
echo
echo "✅ photo→anime → $SAGA_ROOT/tmp/${OUT}_d*.png"
echo "   Lower denoise = more faithful to your photo; higher = more anime. Pick the"
echo "   one that reads most like you AND clearly anime — then run saga-detail.sh"
echo "   --detect face on it to sharpen the eyes/face, and we lock that denoise in."
