#!/usr/bin/env bash
# saga-flux.sh — Flux.1-dev image gen: txt2img + optional Redux (character) + optional ControlNet (pose).
# ============================================================================
# The IMAGE stage of the self-hosted pipeline. Four DECOUPLED controls (the Gabriel recipe on Flux):
#   • PROMPT  → style (the charcoal look)
#   • --lora NAME → a TRAINED character LoRA: identity baked in, pose still driven by the PROMPT
#   • -a REF  → Redux: character/appearance carried from a reference image (locks composition)
#   • --pose REF → ControlNet: FORCES the pose (structural; the prompt/Redux can't override it)
# Bootstrap path: Redux (-a) clones ONE canonical into a training set → train a LoRA →
# thereafter use --lora, which follows pose prompts (Redux/ControlNet then only for edge cases).
#
# Models:
#   models/checkpoints/flux1-dev-fp8.safetensors      (FLUX_CKPT)  all-in-one fp8
#   models/style_models/flux1-redux-dev.safetensors   (FLUX_REDUX) redux adapter
#   models/clip_vision/sigclip_vision_patch14_384.safetensors (SIGCLIP)
#   models/controlnet/flux-union-pro.safetensors      (FLUX_CN)    ControlNet Union Pro
#
# Usage:
#   saga-flux.sh -p "PROMPT" -o name                                   # txt2img
#   saga-flux.sh -p "PROMPT" -a char.png --redux-strength 0.4 \
#                --pose pose.jpg --pose-strength 0.7 -o name           # character + forced pose
#   saga-flux.sh --pose pose.jpg --check                               # preflight incl. pose nodes
#
# --pose REF preprocesses REF into an OpenPose skeleton (DWPreprocessor) and drives ControlNet.
#   --pose-raw : REF is ALREADY a skeleton image — skip preprocessing.
#   --pose-type openpose|depth|canny   (default openpose)   --pose-strength F (default 0.7)
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
FLUX_CKPT="${FLUX_CKPT:-flux1-dev-fp8.safetensors}"
FLUX_REDUX="${FLUX_REDUX:-flux1-redux-dev.safetensors}"
SIGCLIP="${SIGCLIP:-sigclip_vision_patch14_384.safetensors}"
FLUX_CN="${FLUX_CN:-flux-union-pro.safetensors}"

OUT="saga_flux"; SEED=0; W=768; H=1344; STEPS=20; GUIDANCE=3.5; CFG=1.0; BATCH=1
PROMPT=""; NEG=""; ANCHOR=""; REDUX_STR="0.6"
POSE=""; POSE_TYPE="openpose"; POSE_STR="0.7"; POSE_RAW=0
LORA=""; LORA_STR="0.9"
DUMP=0; CHECK=0
die(){ echo "❌ $*" >&2; exit 1; }

while [ $# -gt 0 ]; do case "$1" in
  -o|--out) OUT="$2"; shift 2;;  -s|--seed) SEED="$2"; shift 2;;
  -W|--width) W="$2"; shift 2;;  -H|--height) H="$2"; shift 2;;
  -p|--prompt) PROMPT="$2"; shift 2;;  -n|--neg) NEG="$2"; shift 2;;
  -a|--anchor) ANCHOR="$2"; shift 2;;  --redux-strength) REDUX_STR="$2"; shift 2;;
  --pose) POSE="$2"; shift 2;;  --pose-type) POSE_TYPE="$2"; shift 2;;
  --pose-strength) POSE_STR="$2"; shift 2;;  --pose-raw) POSE_RAW=1; shift;;
  --lora) LORA="$2"; shift 2;;  --lora-strength) LORA_STR="$2"; shift 2;;
  --steps) STEPS="$2"; shift 2;;  --guidance) GUIDANCE="$2"; shift 2;;  --cfg) CFG="$2"; shift 2;;
  --batch) BATCH="$2"; shift 2;;  --ckpt) FLUX_CKPT="$2"; shift 2;;
  --dump-graph) DUMP=1; shift;;  --check) CHECK=1; shift;;
  -h|--help) sed -n '2,30p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
command -v jq >/dev/null || die "jq required"
[ -n "$PROMPT" ] || [ "$CHECK" -eq 1 ] || [ "$DUMP" -eq 1 ] || die "need -p/--prompt"

# Flux-dev IGNORES the negative at cfg=1 (guidance-distilled). At cfg>1 the negative is live —
# so raise --cfg to purge the fake artist signatures/watermarks Flux loves to stamp on "drawings".
if awk -v c="$CFG" 'BEGIN{exit !(c>1.0)}'; then
  [ -n "$NEG" ] || NEG="watermark, signature, text, words, letters, autograph, artist name, logo, stamp, label, border, frame, blurry, jpeg artifacts, low quality"
  NEG_BASE='["4",0]'    # real negative conditioning
else
  NEG_BASE='["5",0]'    # zeroed (distilled default)
fi

upload(){ local f="$1"; [ -f "$f" ] || die "file not found: $f"; curl -sf -F "image=@${f}" -F "overwrite=true" "$COMFY/upload/image" | jq -r '.name'; }

NODES='["CheckpointLoaderSimple","CLIPTextEncode","FluxGuidance","ConditioningZeroOut","EmptySD3LatentImage","KSampler","VAEDecode","SaveImage"]'
[ -n "$LORA" ]   && NODES=$(echo "$NODES" | jq -c '. + ["LoraLoaderModelOnly"]')
[ -n "$ANCHOR" ] && NODES=$(echo "$NODES" | jq -c '. + ["StyleModelLoader","CLIPVisionLoader","LoadImage","CLIPVisionEncode","StyleModelApply"]')
[ -n "$POSE" ]   && NODES=$(echo "$NODES" | jq -c '. + ["ControlNetLoader","SetUnionControlNetType","ControlNetApplyAdvanced","LoadImage"]')
{ [ -n "$POSE" ] && [ "$POSE_RAW" -eq 0 ]; } && NODES=$(echo "$NODES" | jq -c '. + ["DWPreprocessor"]')
preflight(){
  local info miss=0 n; info=$(curl -sf "$COMFY/object_info") || die "ComfyUI unreachable at $COMFY"
  for n in $(echo "$NODES" | jq -r '.[]' | sort -u); do
    echo "$info" | jq -e --arg n "$n" 'has($n)' >/dev/null || { echo "  ✗ missing node: $n" >&2; miss=1; }
  done
  [ "$miss" -eq 0 ] && echo "✔ preflight ok — all node classes present$([ -n "$ANCHOR" ] && echo ' (+redux)')$([ -n "$POSE" ] && echo ' (+pose)')" || return 1
}

# ---- LoRA (character identity) chain: model-only, inserted between checkpoint and KSampler ----
# A trained character LoRA follows pose prompts (unlike Redux, which locks composition), so this
# is the on-model path once the LoRA exists. Text encoders stay frozen → LoraLoaderModelOnly.
LORAJSON=""; MODEL_SRC='["1",0]'
if [ -n "$LORA" ]; then
  MODEL_SRC='["30",0]'
  LORAJSON=',
 "30":{"class_type":"LoraLoaderModelOnly","inputs":{"model":["1",0],"lora_name":"'"$LORA"'","strength_model":'"$LORA_STR"'}}'
fi

# ---- Redux (character) chain: positive text conditioning is augmented before FluxGuidance ----
REDUX=""; FG_COND='["2",0]'
if [ -n "$ANCHOR" ]; then
  { [ "$CHECK" -eq 1 ] || [ "$DUMP" -eq 1 ]; } || A=$(upload "$ANCHOR"); A="${A:-ANCHOR.png}"
  FG_COND='["13",0]'
  REDUX=',
 "10":{"class_type":"StyleModelLoader","inputs":{"style_model_name":"'"$FLUX_REDUX"'"}},
 "11":{"class_type":"CLIPVisionLoader","inputs":{"clip_name":"'"$SIGCLIP"'"}},
 "12":{"class_type":"LoadImage","inputs":{"image":"'"$A"'"}},
 "14":{"class_type":"CLIPVisionEncode","inputs":{"clip_vision":["11",0],"image":["12",0],"crop":"center"}},
 "13":{"class_type":"StyleModelApply","inputs":{"conditioning":["2",0],"style_model":["10",0],"clip_vision_output":["14",0],"strength":'"$REDUX_STR"',"strength_type":"multiply"}}'
fi

# ---- ControlNet (pose) chain: applied to positive+negative AFTER FluxGuidance ----
POSEJSON=""; KS_POS='["3",0]'; KS_NEG="$NEG_BASE"
if [ -n "$POSE" ]; then
  { [ "$CHECK" -eq 1 ] || [ "$DUMP" -eq 1 ]; } || PZ=$(upload "$POSE"); PZ="${PZ:-POSE.png}"
  local_cn_img='["23",0]'; PRE=''
  if [ "$POSE_RAW" -eq 1 ]; then local_cn_img='["22",0]'   # REF is already a skeleton
  else PRE=',
 "23":{"class_type":"DWPreprocessor","inputs":{"image":["22",0],"detect_hand":"enable","detect_body":"enable","detect_face":"disable","resolution":768}}'
  fi
  POSEJSON=',
 "20":{"class_type":"ControlNetLoader","inputs":{"control_net_name":"'"$FLUX_CN"'"}},
 "21":{"class_type":"SetUnionControlNetType","inputs":{"control_net":["20",0],"type":"'"$POSE_TYPE"'"}},
 "22":{"class_type":"LoadImage","inputs":{"image":"'"$PZ"'"}}'"$PRE"',
 "24":{"class_type":"ControlNetApplyAdvanced","inputs":{"positive":["3",0],"negative":'"$NEG_BASE"',"control_net":["21",0],"image":'"$local_cn_img"',"vae":["1",2],"strength":'"$POSE_STR"',"start_percent":0.0,"end_percent":1.0}}'
  KS_POS='["24",0]'; KS_NEG='["24",1]'
fi

GRAPH='{
 "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"'"$FLUX_CKPT"'"}},
 "2":{"class_type":"CLIPTextEncode","inputs":{"text":'"$(jq -Rn --arg s "$PROMPT" '$s')"',"clip":["1",1]}},
 "3":{"class_type":"FluxGuidance","inputs":{"guidance":'"$GUIDANCE"',"conditioning":'"$FG_COND"'}},
 "4":{"class_type":"CLIPTextEncode","inputs":{"text":'"$(jq -Rn --arg s "$NEG" '$s')"',"clip":["1",1]}},
 "5":{"class_type":"ConditioningZeroOut","inputs":{"conditioning":["4",0]}},
 "6":{"class_type":"EmptySD3LatentImage","inputs":{"width":'"$W"',"height":'"$H"',"batch_size":'"$BATCH"'}},
 "7":{"class_type":"KSampler","inputs":{"model":'"$MODEL_SRC"',"positive":'"$KS_POS"',"negative":'"$KS_NEG"',"latent_image":["6",0],"seed":'"$SEED"',"steps":'"$STEPS"',"cfg":'"$CFG"',"sampler_name":"euler","scheduler":"simple","denoise":1.0}},
 "8":{"class_type":"VAEDecode","inputs":{"samples":["7",0],"vae":["1",2]}},
 "9":{"class_type":"SaveImage","inputs":{"images":["8",0],"filename_prefix":"'"$OUT"'"}}'"$LORAJSON$REDUX$POSEJSON"'
}'

[ "$DUMP" -eq 1 ] && { echo "$GRAPH"; exit 0; }
preflight || die "preflight failed (see above)"
[ "$CHECK" -eq 1 ] && exit 0
echo "$GRAPH" | jq -e . >/dev/null || die "internal: malformed graph JSON"

echo "▶ flux${LORA:+ +lora}${ANCHOR:+ +redux}${POSE:+ +pose}: '$OUT'  ${W}x${H}  g=$GUIDANCE  seed=$SEED${LORA:+  lora=$(basename "$LORA")@${LORA_STR}}${ANCHOR:+  char=$(basename "$ANCHOR")@${REDUX_STR}}${POSE:+  pose=$(basename "$POSE")@${POSE_STR}/${POSE_TYPE}}"
PID=$(curl -sf -X POST "$COMFY/prompt" -d "$(jq -n --argjson p "$GRAPH" '{prompt:$p}')" | jq -r '.prompt_id // empty')
[ -n "$PID" ] || die "graph rejected (run --dump-graph | jq and diff vs /object_info)"
echo "  submitted: $PID"
for _ in $(seq 1 900); do
  done=$(curl -sf "$COMFY/history/$PID" | jq -r --arg p "$PID" '.[$p].status.completed // false' 2>/dev/null)
  [ "$done" = "true" ] && break; sleep 2
done
OUTDIR="${COMFY_OUT:-$SAGA_ROOT/engine/ComfyUI/output}"
mapfile -t IMGS < <(curl -sf "$COMFY/history/$PID" | jq -r --arg p "$PID" '.[$p].outputs[].images[]?.filename' 2>/dev/null)
[ "${#IMGS[@]}" -gt 0 ] || die "no images produced (check ComfyUI logs / execution_error)"
for f in "${IMGS[@]}"; do echo "✅ still → $OUTDIR/$f"; done
