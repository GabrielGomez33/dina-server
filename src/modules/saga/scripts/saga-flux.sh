#!/usr/bin/env bash
# saga-flux.sh — Flux.1-dev text-to-image (the IMAGE stage of the self-hosted pipeline).
# ============================================================================
# Generates stills on the pod via ComfyUI + Flux.dev fp8 (all-in-one checkpoint:
# transformer + CLIP + VAE in one file). Used to author the Mirror storyboard
# frames, and later to bootstrap the Little One LoRA training set.
# Shares the saga-*.sh interface (-o -s -W -H -p -n ... --check / --dump-graph).
#
# Model (models/checkpoints/): flux1-dev-fp8.safetensors  (override via FLUX_CKPT)
#
# Usage:
#   saga-flux.sh -p "PROMPT" -W 768 -H 1344 -s 1 -o mirror_v1_s1 [--steps 20] [--guidance 3.5] [--batch 1]
#   saga-flux.sh --check            # /object_info preflight, then exit
#   saga-flux.sh -p "..." --dump-graph
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
FLUX_CKPT="${FLUX_CKPT:-flux1-dev-fp8.safetensors}"

OUT="saga_flux"; SEED=0; W=768; H=1344; STEPS=20; GUIDANCE=3.5; BATCH=1
PROMPT=""; NEG=""; DUMP=0; CHECK=0
die(){ echo "❌ $*" >&2; exit 1; }

while [ $# -gt 0 ]; do case "$1" in
  -o|--out) OUT="$2"; shift 2;;  -s|--seed) SEED="$2"; shift 2;;
  -W|--width) W="$2"; shift 2;;  -H|--height) H="$2"; shift 2;;
  -p|--prompt) PROMPT="$2"; shift 2;;  -n|--neg) NEG="$2"; shift 2;;
  --steps) STEPS="$2"; shift 2;;  --guidance) GUIDANCE="$2"; shift 2;;
  --batch) BATCH="$2"; shift 2;;  --ckpt) FLUX_CKPT="$2"; shift 2;;
  --dump-graph) DUMP=1; shift;;  --check) CHECK=1; shift;;
  -h|--help) sed -n '2,22p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
command -v jq >/dev/null || die "jq required"
[ -n "$PROMPT" ] || [ "$CHECK" -eq 1 ] || [ "$DUMP" -eq 1 ] || die "need -p/--prompt"

# Node classes we emit — all ComfyUI core (Flux needs no custom nodes).
NODES='["CheckpointLoaderSimple","CLIPTextEncode","FluxGuidance","ConditioningZeroOut","EmptySD3LatentImage","KSampler","VAEDecode","SaveImage"]'
preflight(){
  local info; info=$(curl -sf "$COMFY/object_info") || die "ComfyUI unreachable at $COMFY"
  local miss=0 n
  for n in $(echo "$NODES" | jq -r '.[]'); do
    echo "$info" | jq -e --arg n "$n" 'has($n)' >/dev/null || { echo "  ✗ missing node: $n" >&2; miss=1; }
  done
  [ "$miss" -eq 0 ] && echo "✔ preflight ok — all Flux node classes present" || return 1
}

# Flux.dev is guidance-distilled: cfg=1.0, guidance via FluxGuidance, negative zeroed.
read -r -d '' GRAPH <<JSON || true
{
 "1": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"$FLUX_CKPT"}},
 "2": {"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$PROMPT" '$s'),"clip":["1",1]}},
 "3": {"class_type":"FluxGuidance","inputs":{"guidance":$GUIDANCE,"conditioning":["2",0]}},
 "4": {"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$NEG" '$s'),"clip":["1",1]}},
 "5": {"class_type":"ConditioningZeroOut","inputs":{"conditioning":["4",0]}},
 "6": {"class_type":"EmptySD3LatentImage","inputs":{"width":$W,"height":$H,"batch_size":$BATCH}},
 "7": {"class_type":"KSampler","inputs":{"model":["1",0],"positive":["3",0],"negative":["5",0],"latent_image":["6",0],"seed":$SEED,"steps":$STEPS,"cfg":1.0,"sampler_name":"euler","scheduler":"simple","denoise":1.0}},
 "8": {"class_type":"VAEDecode","inputs":{"samples":["7",0],"vae":["1",2]}},
 "9": {"class_type":"SaveImage","inputs":{"images":["8",0],"filename_prefix":"$OUT"}}
}
JSON

[ "$DUMP" -eq 1 ] && { echo "$GRAPH"; exit 0; }
preflight || die "preflight failed (see above)"
[ "$CHECK" -eq 1 ] && exit 0

echo "▶ flux: '$OUT'  ${W}x${H}  steps=$STEPS  guidance=$GUIDANCE  seed=$SEED  batch=$BATCH  ckpt=$FLUX_CKPT"
PID=$(curl -sf -X POST "$COMFY/prompt" -d "$(jq -n --argjson p "$GRAPH" '{prompt:$p}')" | jq -r '.prompt_id // empty')
[ -n "$PID" ] || die "graph rejected (run --dump-graph | jq and diff vs /object_info)"
echo "  submitted: $PID"
for _ in $(seq 1 900); do
  done=$(curl -sf "$COMFY/history/$PID" | jq -r --arg p "$PID" '.[$p].status.completed // false' 2>/dev/null)
  [ "$done" = "true" ] && break
  sleep 2
done
OUTDIR="${COMFY_OUT:-$SAGA_ROOT/engine/ComfyUI/output}"
mapfile -t IMGS < <(curl -sf "$COMFY/history/$PID" | jq -r --arg p "$PID" '.[$p].outputs[].images[]?.filename' 2>/dev/null)
[ "${#IMGS[@]}" -gt 0 ] || die "no images produced (check ComfyUI logs / execution_error)"
for f in "${IMGS[@]}"; do echo "✅ still → $OUTDIR/$f"; done
