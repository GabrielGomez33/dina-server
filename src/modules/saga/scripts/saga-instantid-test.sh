#!/usr/bin/env bash
# ============================================================================
# saga-instantid-test.sh — anime-you via InstantID (Arm B)
# ----------------------------------------------------------------------------
# Animagine (anime STYLE) + your face photo → InstantID (IDENTITY via a
# style-agnostic face embedding + landmark ControlNet). Identity enters on a
# SEPARATE conditioning channel, so it doesn't zero-sum against the anime weights
# the way the realistic LoRA did. LoRA is OFF by default (test InstantID solo
# first); add --lora at LOW weight only as a likeness booster.
#
#   saga-instantid-test.sh --face IMG [--iid-weight 0.8] [--iid-start 0] [--iid-end 1]
#      [--lora F --lora-weight 0.35 --trigger T] [--prompt "scene"] [-o NAME]
#
# Node signatures verified live (cubiq ComfyUI_InstantID). onnxruntime here is
# CPU-only → face analysis provider = CPU.
# Env: SAGA_ROOT (required)  COMFY=http://127.0.0.1:8188  IID_CKPT=animagine-xl-4.0.safetensors
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
CKPT="${IID_CKPT:-animagine-xl-4.0.safetensors}"
IID_MODEL="${IID_MODEL:-ip-adapter.bin}"
IID_CN="${IID_CN:-instantid_controlnet.safetensors}"

FACE=""; IIDW=0.8; IIDS=0.0; IIDE=1.0; LORA=""; LORAW=0.35; TRIGGER=""
SEED=777; STEPS=30; CFG=5.0; W=1024; H=1024; OUT="iid"
STYLE="anime, anime screencap, cel shading, clean lineart, flat colors, detailed anime, soft lighting, masterpiece, best quality"
NEG="lowres, bad anatomy, bad hands, worst quality, blurry, multiple people, watermark, text, photo, photograph, realistic, photorealistic, 3d render, real life"
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --face) FACE="$2"; shift 2;; --iid-weight) IIDW="$2"; shift 2;;
  --iid-start) IIDS="$2"; shift 2;; --iid-end) IIDE="$2"; shift 2;;
  --lora) LORA="$2"; shift 2;; --lora-weight) LORAW="$2"; shift 2;; --trigger) TRIGGER="$2"; shift 2;;
  --prompt) SCENE="$2"; shift 2;; --style) STYLE="$2"; shift 2;; -n|--neg) NEG="$2"; shift 2;;
  --seed) SEED="$2"; shift 2;; --steps) STEPS="$2"; shift 2;; --cfg) CFG="$2"; shift 2;;
  -W|--width) W="$2"; shift 2;; -H|--height) H="$2"; shift 2;; -o|--out) OUT="$2"; shift 2;;
  -h|--help) sed -n '2,18p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
SCENE="${SCENE:-}"
[ -n "$FACE" ] && [ -f "$FACE" ] || die "need --face <a clean, front-facing photo of you>"
command -v jq >/dev/null || die "jq required"
[ -z "$LORA" ] || [ -f "$SAGA_ROOT/models/loras/$LORA" ] || die "LoRA not found: models/loras/$LORA"
[ -n "$TRIGGER" ] && [ -n "$SCENE" ] && SCENE="$TRIGGER, $SCENE" || { [ -n "$TRIGGER" ] && SCENE="$TRIGGER"; }

CID="sagaiid-$$-$RANDOM"
upload(){ curl -sf -F "image=@${1}" -F "overwrite=true" "$COMFY/upload/image" | jq -r '.name' || die "upload failed: $1"; }
submit(){ curl -sf -X POST "$COMFY/prompt" --data "$(jq -nc --slurpfile g "$1" --arg c "$CID" '{prompt:$g[0], client_id:$c}')" | jq -r '.prompt_id' || die "submit rejected"; }
wait_done(){ local id="$1" t=0 h st; while :; do h=$(curl -sf "$COMFY/history/$id"); if [ "$(jq -r --arg i "$id" 'has($i)' <<<"$h")" = "true" ]; then st=$(jq -r --arg i "$id" '.[$i].status.status_str // "ok"' <<<"$h"); if [ "$st" = "error" ]; then jq -r --arg i "$id" '.[$i].status.messages[]? | select(.[0]=="execution_error") | .[1] | "  ⤷ node \(.node_id) (\(.node_type)): \(.exception_type): \(.exception_message)"' <<<"$h" >&2; die "execution error for $id"; fi; echo "$h"; return 0; fi; t=$((t+3)); [ "$t" -gt 900 ] && die "timeout for $id"; sleep 3; done; }
fetch_first(){ local h="$1" id="$2" dest="$3" line fn sf ty code base sub src; line=$(jq -r --arg i "$id" '.[$i].outputs[] | ((.images // [])[0]) | select(.!=null) | "\(.filename)\t\(.subfolder)\t\(.type)"' <<<"$h" | head -n1); [ -n "$line" ] || die "no output for $id"; IFS=$'\t' read -r fn sf ty <<<"$line"; code=$(curl -s -o "$dest" -w '%{http_code}' "$COMFY/view?filename=$(jq -rn --arg s "$fn" '$s|@uri')&subfolder=$(jq -rn --arg s "$sf" '$s|@uri')&type=${ty:-output}"); { [ "$code" = "200" ] && [ -s "$dest" ]; } && { echo "$dest"; return 0; }; rm -f "$dest"; for base in "${COMFY_OUT:-}" "$SAGA_ROOT/engine/ComfyUI/output"; do [ -n "$base" ] || continue; sub="$base${sf:+/$sf}"; [ -f "$sub/$fn" ] && { cp -f "$sub/$fn" "$dest"; echo "$dest"; return 0; }; done; src=$(find "$SAGA_ROOT/engine" -name "$fn" -print -quit 2>/dev/null); [ -n "$src" ] && { cp -f "$src" "$dest"; echo "$dest"; return 0; }; die "could not retrieve $fn (http=$code)"; }

echo "▶ InstantID: face=$(basename "$FACE")  iid=$IIDW[$IIDS-$IIDE]  lora=${LORA:-none}@$LORAW  ${W}x${H}"
FACE_NAME=$(upload "$FACE"); echo "  face uploaded: $FACE_NAME"
if [ -n "$LORA" ]; then MODEL='["40",0]'; CLIP='["40",1]'; else MODEL='["1",0]'; CLIP='["1",1]'; fi

gen(){ # <out> <scene-prompt>
  local out="$1" scene="$2" G; G=$(mktemp)
  local POS="$scene, $STYLE"
  {
  cat <<JSON
{
 "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"$CKPT"}},
JSON
  [ -n "$LORA" ] && cat <<JSON
 "40":{"class_type":"LoraLoader","inputs":{"model":["1",0],"clip":["1",1],"lora_name":"$LORA","strength_model":$LORAW,"strength_clip":$LORAW}},
JSON
  cat <<JSON
 "2":{"class_type":"InstantIDModelLoader","inputs":{"instantid_file":"$IID_MODEL"}},
 "3":{"class_type":"InstantIDFaceAnalysis","inputs":{"provider":"CPU"}},
 "4":{"class_type":"ControlNetLoader","inputs":{"control_net_name":"$IID_CN"}},
 "5":{"class_type":"LoadImage","inputs":{"image":"$FACE_NAME"}},
 "6":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$POS" '$s'),"clip":$CLIP}},
 "7":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$NEG" '$s'),"clip":$CLIP}},
 "8":{"class_type":"ApplyInstantID","inputs":{"instantid":["2",0],"insightface":["3",0],"control_net":["4",0],"image":["5",0],"model":$MODEL,"positive":["6",0],"negative":["7",0],"weight":$IIDW,"start_at":$IIDS,"end_at":$IIDE}},
 "9":{"class_type":"EmptyLatentImage","inputs":{"width":$W,"height":$H,"batch_size":1}},
 "10":{"class_type":"KSampler","inputs":{"seed":$SEED,"steps":$STEPS,"cfg":$CFG,"sampler_name":"euler","scheduler":"normal","denoise":1,"model":["8",0],"positive":["8",1],"negative":["8",2],"latent_image":["9",0]}},
 "11":{"class_type":"VAEDecode","inputs":{"samples":["10",0],"vae":["1",2]}},
 "12":{"class_type":"SaveImage","inputs":{"filename_prefix":"$out","images":["11",0]}}
}
JSON
  } > "$G"
  jq -e . "$G" >/dev/null || die "internal: invalid graph"
  local pid; pid=$(submit "$G"); echo "  [$out] submitted: $pid"
  local hist; hist=$(wait_done "$pid")
  fetch_first "$hist" "$pid" "$SAGA_ROOT/tmp/${out}.png" >/dev/null
  echo "  ✅ $SAGA_ROOT/tmp/${out}.png"; rm -f "$G"
}

gen "${OUT}_portrait" "1man, solo, portrait, upper body, ${SCENE:-neutral expression}"
gen "${OUT}_closeup"  "1man, solo, face close-up, ${SCENE:-looking at viewer}"
echo "✅ InstantID stills in $SAGA_ROOT/tmp/${OUT}_*.png — tune --iid-weight (0.6-1.0), --iid-end (0.6-1.0), and add --lora at 0.3-0.4 if identity needs a boost"
