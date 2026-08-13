#!/usr/bin/env bash
# saga-flux.sh — Flux.1-dev text-to-image, + optional Flux REDUX reference (IMAGE stage).
# ============================================================================
# Generates stills on the pod via ComfyUI + Flux.dev fp8 (all-in-one checkpoint).
# With -a <reference>, applies FLUX REDUX: the reference image's character/style is
# carried into the new generation (the image analog of anime keyframe anchoring) so
# a made-up character stays on-model across shots — and to build a CONSISTENT dataset
# for the Little One LoRA.
#
# Models:
#   models/checkpoints/flux1-dev-fp8.safetensors     (FLUX_CKPT)   — all-in-one fp8
#   models/style_models/flux1-redux-dev.safetensors  (FLUX_REDUX)  — redux adapter (129MB)
#   models/clip_vision/sigclip_vision_patch14_384.safetensors (SIGCLIP) — shared w/ FramePack
#
# Usage:
#   saga-flux.sh -p "PROMPT" -W 768 -H 1344 -s 1 -o name              # plain txt2img
#   saga-flux.sh -p "PROMPT" -a ref.png --redux-strength 0.6 -o name  # + redux anchor
#   saga-flux.sh --check [-a ref.png]     # /object_info preflight (add -a to check redux nodes)
#   saga-flux.sh -p "..." [-a ref.png] --dump-graph
#
# --redux-strength: 1.0 = reference dominates (ignores prompt); ~0.5-0.7 = keep the
#   character while the prompt still drives the new scene/composition. Tune to taste.
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
FLUX_CKPT="${FLUX_CKPT:-flux1-dev-fp8.safetensors}"
FLUX_REDUX="${FLUX_REDUX:-flux1-redux-dev.safetensors}"
SIGCLIP="${SIGCLIP:-sigclip_vision_patch14_384.safetensors}"

OUT="saga_flux"; SEED=0; W=768; H=1344; STEPS=20; GUIDANCE=3.5; BATCH=1
PROMPT=""; NEG=""; ANCHOR=""; REDUX_STR="0.6"; DUMP=0; CHECK=0
die(){ echo "❌ $*" >&2; exit 1; }

while [ $# -gt 0 ]; do case "$1" in
  -o|--out) OUT="$2"; shift 2;;  -s|--seed) SEED="$2"; shift 2;;
  -W|--width) W="$2"; shift 2;;  -H|--height) H="$2"; shift 2;;
  -p|--prompt) PROMPT="$2"; shift 2;;  -n|--neg) NEG="$2"; shift 2;;
  -a|--anchor) ANCHOR="$2"; shift 2;;  --redux-strength) REDUX_STR="$2"; shift 2;;
  --steps) STEPS="$2"; shift 2;;  --guidance) GUIDANCE="$2"; shift 2;;
  --batch) BATCH="$2"; shift 2;;  --ckpt) FLUX_CKPT="$2"; shift 2;;
  --dump-graph) DUMP=1; shift;;  --check) CHECK=1; shift;;
  -h|--help) sed -n '2,26p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
command -v jq >/dev/null || die "jq required"
[ -n "$PROMPT" ] || [ "$CHECK" -eq 1 ] || [ "$DUMP" -eq 1 ] || die "need -p/--prompt"

upload(){ local f="$1"; [ -f "$f" ] || die "file not found: $f"; curl -sf -F "image=@${f}" -F "overwrite=true" "$COMFY/upload/image" | jq -r '.name'; }

NODES='["CheckpointLoaderSimple","CLIPTextEncode","FluxGuidance","ConditioningZeroOut","EmptySD3LatentImage","KSampler","VAEDecode","SaveImage"]'
[ -n "$ANCHOR" ] && NODES=$(echo "$NODES" | jq -c '. + ["StyleModelLoader","CLIPVisionLoader","LoadImage","CLIPVisionEncode","StyleModelApply"]')
preflight(){
  local info miss=0 n; info=$(curl -sf "$COMFY/object_info") || die "ComfyUI unreachable at $COMFY"
  for n in $(echo "$NODES" | jq -r '.[]'); do
    echo "$info" | jq -e --arg n "$n" 'has($n)' >/dev/null || { echo "  ✗ missing node: $n" >&2; miss=1; }
  done
  [ "$miss" -eq 0 ] && echo "✔ preflight ok — all node classes present$([ -n "$ANCHOR" ] && echo ' (+redux)')" || return 1
}

# Positive conditioning: plain text, OR redux-augmented when anchored.
POS='["2",0]'; REDUX=""
if [ -n "$ANCHOR" ]; then
  { [ "$CHECK" -eq 1 ] || [ "$DUMP" -eq 1 ]; } || A=$(upload "$ANCHOR")
  A="${A:-ANCHOR.png}"; POS='["13",0]'
  REDUX=',
 "10":{"class_type":"StyleModelLoader","inputs":{"style_model_name":"'"$FLUX_REDUX"'"}},
 "11":{"class_type":"CLIPVisionLoader","inputs":{"clip_name":"'"$SIGCLIP"'"}},
 "12":{"class_type":"LoadImage","inputs":{"image":"'"$A"'"}},
 "14":{"class_type":"CLIPVisionEncode","inputs":{"clip_vision":["11",0],"image":["12",0],"crop":"center"}},
 "13":{"class_type":"StyleModelApply","inputs":{"conditioning":["2",0],"style_model":["10",0],"clip_vision_output":["14",0],"strength":'"$REDUX_STR"',"strength_type":"multiply"}}'
fi

GRAPH='{
 "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"'"$FLUX_CKPT"'"}},
 "2":{"class_type":"CLIPTextEncode","inputs":{"text":'"$(jq -Rn --arg s "$PROMPT" '$s')"',"clip":["1",1]}},
 "3":{"class_type":"FluxGuidance","inputs":{"guidance":'"$GUIDANCE"',"conditioning":'"$POS"'}},
 "4":{"class_type":"CLIPTextEncode","inputs":{"text":'"$(jq -Rn --arg s "$NEG" '$s')"',"clip":["1",1]}},
 "5":{"class_type":"ConditioningZeroOut","inputs":{"conditioning":["4",0]}},
 "6":{"class_type":"EmptySD3LatentImage","inputs":{"width":'"$W"',"height":'"$H"',"batch_size":'"$BATCH"'}},
 "7":{"class_type":"KSampler","inputs":{"model":["1",0],"positive":["3",0],"negative":["5",0],"latent_image":["6",0],"seed":'"$SEED"',"steps":'"$STEPS"',"cfg":1.0,"sampler_name":"euler","scheduler":"simple","denoise":1.0}},
 "8":{"class_type":"VAEDecode","inputs":{"samples":["7",0],"vae":["1",2]}},
 "9":{"class_type":"SaveImage","inputs":{"images":["8",0],"filename_prefix":"'"$OUT"'"}}'"$REDUX"'
}'

[ "$DUMP" -eq 1 ] && { echo "$GRAPH"; exit 0; }
preflight || die "preflight failed (see above)"
[ "$CHECK" -eq 1 ] && exit 0
echo "$GRAPH" | jq -e . >/dev/null || die "internal: malformed graph JSON"

echo "▶ flux${ANCHOR:+ +redux}: '$OUT'  ${W}x${H}  steps=$STEPS  guidance=$GUIDANCE  seed=$SEED${ANCHOR:+  anchor=$(basename "$ANCHOR")@${REDUX_STR}}"
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
