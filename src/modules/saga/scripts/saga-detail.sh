#!/usr/bin/env bash
# ============================================================================
# saga-detail.sh — face + hand detailer (Impact-Pack FaceDetailer + YOLO)
# ----------------------------------------------------------------------------
# Detects the face and/or hands in an image, crops each, re-renders it at full
# resolution WITH the character LoRA, and pastes it back. This is what puts a
# recognizable face on a full-body shot (where the face is too small to render)
# and cleans up hands. denoise ~0.4 fixes without re-inventing.
#
#   saga-detail.sh --image IMG [--detect face|hands|both] [--lora F] [--trigger T]
#      [--lora-weight 0.75] [--denoise 0.4] [--prompt "style/features"] [-o NAME]
#
# Node params verified against live /object_info (2026-07-19).
# Env: SAGA_ROOT (required)  COMFY=http://127.0.0.1:8188  DTL_CKPT=animagine-xl-4.0.safetensors
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
CKPT="${DTL_CKPT:-animagine-xl-4.0.safetensors}"

IMG=""; DETECT="both"; LORA=""; LORAW=0.75; TRIGGER=""; DENOISE=0.4; SEED=0; CFG=6.0; STEPS=20
PROMPT="cel shaded anime, detailed face, detailed hands"; OUT="saga_detail"
NEG="lowres, bad anatomy, bad hands, extra fingers, fused fingers, missing fingers, mutated hands, malformed hands, extra limbs, extra arms, worst quality, blurry, deformed"
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --image) IMG="$2"; shift 2;; --detect) DETECT="$2"; shift 2;;
  --lora) LORA="$2"; shift 2;; --lora-weight) LORAW="$2"; shift 2;; --trigger) TRIGGER="$2"; shift 2;;
  --denoise) DENOISE="$2"; shift 2;; --seed) SEED="$2"; shift 2;; --cfg) CFG="$2"; shift 2;;
  --prompt) PROMPT="$2"; shift 2;; -n|--neg) NEG="$2"; shift 2;; -o|--out) OUT="$2"; shift 2;;
  -h|--help) sed -n '2,18p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
[ -n "$IMG" ] && [ -f "$IMG" ] || die "need --image <file>"
command -v jq >/dev/null || die "jq required"
[ -z "$LORA" ] || [ -f "$SAGA_ROOT/models/loras/$LORA" ] || die "LoRA not found: models/loras/$LORA"
case "$DETECT" in face|hands|both) ;; *) die "--detect must be face|hands|both";; esac
[ -n "$TRIGGER" ] && PROMPT="$TRIGGER, $PROMPT"

CID="sagadtl-$$-$RANDOM"
upload(){ local f="$1"; curl -sf -F "image=@${f}" -F "overwrite=true" "$COMFY/upload/image" | jq -r '.name' || die "upload failed: $f"; }
submit(){ curl -sf -X POST "$COMFY/prompt" --data "$(jq -nc --slurpfile g "$1" --arg c "$CID" '{prompt:$g[0], client_id:$c}')" | jq -r '.prompt_id' || die "submit rejected"; }
wait_done(){ local id="$1" t=0 h st; while :; do h=$(curl -sf "$COMFY/history/$id"); if [ "$(jq -r --arg i "$id" 'has($i)' <<<"$h")" = "true" ]; then st=$(jq -r --arg i "$id" '.[$i].status.status_str // "ok"' <<<"$h"); if [ "$st" = "error" ]; then jq -r --arg i "$id" '.[$i].status.messages[]? | select(.[0]=="execution_error") | .[1] | "  ⤷ node \(.node_id) (\(.node_type)): \(.exception_type): \(.exception_message)"' <<<"$h" >&2; die "execution error for $id"; fi; echo "$h"; return 0; fi; t=$((t+3)); [ "$t" -gt 900 ] && die "timeout for $id"; sleep 3; done; }
fetch_first(){ local h="$1" id="$2" dest="$3" line fn sf ty code base sub src; line=$(jq -r --arg i "$id" '.[$i].outputs[] | ((.images // [])[0]) | select(.!=null) | "\(.filename)\t\(.subfolder)\t\(.type)"' <<<"$h" | head -n1); [ -n "$line" ] || die "no output for $id"; IFS=$'\t' read -r fn sf ty <<<"$line"; code=$(curl -s -o "$dest" -w '%{http_code}' "$COMFY/view?filename=$(jq -rn --arg s "$fn" '$s|@uri')&subfolder=$(jq -rn --arg s "$sf" '$s|@uri')&type=${ty:-output}"); { [ "$code" = "200" ] && [ -s "$dest" ]; } && { echo "$dest"; return 0; }; rm -f "$dest"; for base in "${COMFY_OUT:-}" "$SAGA_ROOT/engine/ComfyUI/output"; do [ -n "$base" ] || continue; sub="$base${sf:+/$sf}"; [ -f "$sub/$fn" ] && { cp -f "$sub/$fn" "$dest"; echo "$dest"; return 0; }; done; src=$(find "$SAGA_ROOT/engine" -name "$fn" -print -quit 2>/dev/null); [ -n "$src" ] && { cp -f "$src" "$dest"; echo "$dest"; return 0; }; die "could not retrieve $fn (http=$code)"; }

echo "▶ detail: $(basename "$IMG")  detect=$DETECT  lora=${LORA:-none}@$LORAW  denoise=$DENOISE"
IMG_NAME=$(upload "$IMG"); echo "  uploaded: $IMG_NAME"
if [ -n "$LORA" ]; then MODEL='["40",0]'; CLIP='["40",1]'; else MODEL='["1",0]'; CLIP='["1",1]'; fi

# one FaceDetailer node bound to a given detector + input-image source
fd_node(){ # <nodeId> <img_src> <detector_src>
  cat <<JSON
 "$1":{"class_type":"FaceDetailer","inputs":{
   "image":$2,"model":$MODEL,"clip":$CLIP,"vae":["1",2],"positive":["2",0],"negative":["3",0],"bbox_detector":$3,
   "guide_size":512,"guide_size_for":true,"max_size":1024,"seed":$SEED,"steps":$STEPS,"cfg":$CFG,
   "sampler_name":"euler_ancestral","scheduler":"normal","denoise":$DENOISE,"feather":5,
   "noise_mask":true,"force_inpaint":true,"bbox_threshold":0.5,"bbox_dilation":10,"bbox_crop_factor":3.0,
   "sam_detection_hint":"center-1","sam_dilation":0,"sam_threshold":0.93,"sam_bbox_expansion":0,
   "sam_mask_hint_threshold":0.7,"sam_mask_hint_use_negative":"False","drop_size":10,"wildcard":"","cycle":1}},
JSON
}

GRAPH=$(mktemp)
{
cat <<JSON
{
 "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"$CKPT"}},
JSON
[ -n "$LORA" ] && cat <<JSON
 "40":{"class_type":"LoraLoader","inputs":{"model":["1",0],"clip":["1",1],"lora_name":"$LORA","strength_model":$LORAW,"strength_clip":$LORAW}},
JSON
cat <<JSON
 "2":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$PROMPT" '$s'),"clip":$CLIP}},
 "3":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$NEG" '$s'),"clip":$CLIP}},
 "8":{"class_type":"LoadImage","inputs":{"image":"$IMG_NAME"}},
JSON

LAST='["8",0]'
if [ "$DETECT" = "face" ] || [ "$DETECT" = "both" ]; then
  echo ' "50":{"class_type":"UltralyticsDetectorProvider","inputs":{"model_name":"bbox/face_yolov8m.pt"}},'
  fd_node 51 "$LAST" '["50",0]'; LAST='["51",0]'
fi
if [ "$DETECT" = "hands" ] || [ "$DETECT" = "both" ]; then
  echo ' "52":{"class_type":"UltralyticsDetectorProvider","inputs":{"model_name":"bbox/hand_yolov8s.pt"}},'
  fd_node 53 "$LAST" '["52",0]'; LAST='["53",0]'
fi
cat <<JSON
 "7":{"class_type":"SaveImage","inputs":{"filename_prefix":"$OUT","images":$LAST}}
}
JSON
} > "$GRAPH"

jq -e . "$GRAPH" >/dev/null || die "internal: invalid graph"
PID=$(submit "$GRAPH"); echo "  submitted: $PID"
HIST=$(wait_done "$PID")
DEST="$SAGA_ROOT/tmp/${OUT}.png"
fetch_first "$HIST" "$PID" "$DEST" >/dev/null
rm -f "$GRAPH"
echo "✅ detailed → $DEST"
echo "$DEST"
