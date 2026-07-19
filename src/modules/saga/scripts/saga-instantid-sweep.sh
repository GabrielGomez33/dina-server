#!/usr/bin/env bash
# ============================================================================
# saga-instantid-sweep.sh — identity-strength A/B grid for InstantID (Arm B)
# ----------------------------------------------------------------------------
# ONE reference face, ONE seed, ONE prompt — sweeps ONLY the identity levers so
# every difference you see is the knob, not noise. Built to answer the exact
# failure you flagged: "looks like prompt-gen, not reference-gen" (identity too
# weak → the anime prompt drives the render instead of your face embedding).
#
# Fixes baked in vs. saga-instantid-test.sh:
#   • full-body shot added (was portrait/closeup only)
#   • clothing baked into the prompt + nudity in the negative (was rendering bare)
#   • "brown eyes" pinned so the model stops inventing eye color per-seed
#   • a matrix of --iid-weight / --iid-end (± LoRA booster) at a FIXED seed
#
# Each variant renders a PORTRAIT (best likeness read) and a FULL BODY. Note:
# on a full-body shot the face renders tiny — for a true likeness on those,
# run saga-detail.sh --detect face afterward. Judge identity on the portraits.
#
#   saga-instantid-sweep.sh --face IMG
#      [--lora gabrielgomez1.safetensors --trigger GabrielGomez1]
#      [--seed 777] [--clothing "black t-shirt"] [--eyes "brown eyes"]
#      [--matrix "W:E[:lora] W:E ..."]   [--portrait-only] [-o PREFIX]
#
# Node signatures identical to saga-instantid-test.sh (verified live, cubiq).
# onnxruntime here is CPU-only → face analysis provider = CPU.
# Env: SAGA_ROOT (required)  COMFY=http://127.0.0.1:8188  IID_CKPT=animagine-xl-4.0.safetensors
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
CKPT="${IID_CKPT:-animagine-xl-4.0.safetensors}"
IID_MODEL="${IID_MODEL:-ip-adapter.bin}"
IID_CN="${IID_CN:-instantid_controlnet.safetensors}"

FACE=""; LORA=""; LORAW=0.35; TRIGGER=""
SEED=777; STEPS=30; CFG=5.0; W=1024; H=1024; OUT="iidsweep"
CLOTHING="black t-shirt"; EYES="brown eyes"; PORTRAIT_ONLY=0
# The default matrix answers "identity too weak" head-on: climb weight, then
# release the identity early (end<1) so the anime style still finishes the look.
# Format per entry: WEIGHT:END  or  WEIGHT:END:lora  (":lora" turns on the booster).
MATRIX="0.8:1.0 1.0:1.0 1.0:0.7 1.0:0.8:lora 0.9:0.6:lora"
STYLE="anime, anime screencap, cel shading, clean lineart, flat colors, detailed anime, soft lighting, masterpiece, best quality"
NEG="lowres, bad anatomy, bad hands, worst quality, blurry, multiple people, watermark, text, photo, photograph, realistic, photorealistic, 3d render, real life, nude, nsfw, naked, nudity, nipples, bad eyes, heterochromia"
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --face) FACE="$2"; shift 2;;
  --lora) LORA="$2"; shift 2;; --lora-weight) LORAW="$2"; shift 2;; --trigger) TRIGGER="$2"; shift 2;;
  --seed) SEED="$2"; shift 2;; --steps) STEPS="$2"; shift 2;; --cfg) CFG="$2"; shift 2;;
  --clothing) CLOTHING="$2"; shift 2;; --eyes) EYES="$2"; shift 2;;
  --matrix) MATRIX="$2"; shift 2;; --portrait-only) PORTRAIT_ONLY=1; shift;;
  --style) STYLE="$2"; shift 2;; -n|--neg) NEG="$2"; shift 2;;
  -W|--width) W="$2"; shift 2;; -H|--height) H="$2"; shift 2;; -o|--out) OUT="$2"; shift 2;;
  -h|--help) sed -n '2,38p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
[ -n "$FACE" ] && [ -f "$FACE" ] || die "need --face <a clean, front-facing photo of you>"
command -v jq >/dev/null || die "jq required"
[ -z "$LORA" ] || [ -f "$SAGA_ROOT/models/loras/$LORA" ] || die "LoRA not found: models/loras/$LORA"
# If any matrix entry asks for :lora, we need the LoRA present.
case "$MATRIX" in *:lora*) [ -n "$LORA" ] || die "matrix requests ':lora' but no --lora given";; esac
TRIG_TAG=""; [ -n "$TRIGGER" ] && TRIG_TAG="$TRIGGER, "

CID="sagaiidsw-$$-$RANDOM"
upload(){ curl -sf -F "image=@${1}" -F "overwrite=true" "$COMFY/upload/image" | jq -r '.name' || die "upload failed: $1"; }
submit(){ curl -sf -X POST "$COMFY/prompt" --data "$(jq -nc --slurpfile g "$1" --arg c "$CID" '{prompt:$g[0], client_id:$c}')" | jq -r '.prompt_id' || die "submit rejected"; }
wait_done(){ local id="$1" t=0 h st; while :; do h=$(curl -sf "$COMFY/history/$id"); if [ "$(jq -r --arg i "$id" 'has($i)' <<<"$h")" = "true" ]; then st=$(jq -r --arg i "$id" '.[$i].status.status_str // "ok"' <<<"$h"); if [ "$st" = "error" ]; then jq -r --arg i "$id" '.[$i].status.messages[]? | select(.[0]=="execution_error") | .[1] | "  ⤷ node \(.node_id) (\(.node_type)): \(.exception_type): \(.exception_message)"' <<<"$h" >&2; die "execution error for $id"; fi; echo "$h"; return 0; fi; t=$((t+3)); [ "$t" -gt 1800 ] && die "timeout for $id"; sleep 3; done; }
fetch_first(){ local h="$1" id="$2" dest="$3" line fn sf ty code base sub src; line=$(jq -r --arg i "$id" '.[$i].outputs[] | ((.images // [])[0]) | select(.!=null) | "\(.filename)\t\(.subfolder)\t\(.type)"' <<<"$h" | head -n1); [ -n "$line" ] || die "no output for $id"; IFS=$'\t' read -r fn sf ty <<<"$line"; code=$(curl -s -o "$dest" -w '%{http_code}' "$COMFY/view?filename=$(jq -rn --arg s "$fn" '$s|@uri')&subfolder=$(jq -rn --arg s "$sf" '$s|@uri')&type=${ty:-output}"); { [ "$code" = "200" ] && [ -s "$dest" ]; } && { echo "$dest"; return 0; }; rm -f "$dest"; for base in "${COMFY_OUT:-}" "$SAGA_ROOT/engine/ComfyUI/output"; do [ -n "$base" ] || continue; sub="$base${sf:+/$sf}"; [ -f "$sub/$fn" ] && { cp -f "$sub/$fn" "$dest"; echo "$dest"; return 0; }; done; src=$(find "$SAGA_ROOT/engine" -name "$fn" -print -quit 2>/dev/null); [ -n "$src" ] && { cp -f "$src" "$dest"; echo "$dest"; return 0; }; die "could not retrieve $fn (http=$code)"; }

echo "▶ InstantID sweep: face=$(basename "$FACE")  seed=$SEED  clothing='$CLOTHING'  eyes='$EYES'  lora=${LORA:-none}@$LORAW"
echo "  matrix: $MATRIX"
FACE_NAME=$(upload "$FACE"); echo "  face uploaded: $FACE_NAME"

# <out> <scene-prompt> <iid-weight> <iid-end> <use-lora:0|1>
gen(){
  local out="$1" scene="$2" iidw="$3" iide="$4" uselora="$5" G model clip lora_node
  G=$(mktemp)
  if [ "$uselora" = "1" ]; then model='["40",0]'; clip='["40",1]'; else model='["1",0]'; clip='["1",1]'; fi
  local POS="$scene, $STYLE"
  {
  cat <<JSON
{
 "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"$CKPT"}},
JSON
  [ "$uselora" = "1" ] && cat <<JSON
 "40":{"class_type":"LoraLoader","inputs":{"model":["1",0],"clip":["1",1],"lora_name":"$LORA","strength_model":$LORAW,"strength_clip":$LORAW}},
JSON
  cat <<JSON
 "2":{"class_type":"InstantIDModelLoader","inputs":{"instantid_file":"$IID_MODEL"}},
 "3":{"class_type":"InstantIDFaceAnalysis","inputs":{"provider":"CPU"}},
 "4":{"class_type":"ControlNetLoader","inputs":{"control_net_name":"$IID_CN"}},
 "5":{"class_type":"LoadImage","inputs":{"image":"$FACE_NAME"}},
 "6":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$POS" '$s'),"clip":$clip}},
 "7":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$NEG" '$s'),"clip":$clip}},
 "8":{"class_type":"ApplyInstantID","inputs":{"instantid":["2",0],"insightface":["3",0],"control_net":["4",0],"image":["5",0],"model":$model,"positive":["6",0],"negative":["7",0],"weight":$iidw,"start_at":0.0,"end_at":$iide}},
 "9":{"class_type":"EmptyLatentImage","inputs":{"width":$W,"height":$H,"batch_size":1}},
 "10":{"class_type":"KSampler","inputs":{"seed":$SEED,"steps":$STEPS,"cfg":$CFG,"sampler_name":"euler","scheduler":"normal","denoise":1,"model":["8",0],"positive":["8",1],"negative":["8",2],"latent_image":["9",0]}},
 "11":{"class_type":"VAEDecode","inputs":{"samples":["10",0],"vae":["1",2]}},
 "12":{"class_type":"SaveImage","inputs":{"filename_prefix":"$out","images":["11",0]}}
}
JSON
  } > "$G"
  jq -e . "$G" >/dev/null || die "internal: invalid graph"
  local pid; pid=$(submit "$G"); echo "    [$out] submitted: $pid"
  local hist; hist=$(wait_done "$pid")
  fetch_first "$hist" "$pid" "$SAGA_ROOT/tmp/${out}.png" >/dev/null
  echo "    ✅ $SAGA_ROOT/tmp/${out}.png"; rm -f "$G"
}

PORTRAIT="${TRIG_TAG}1man, solo, portrait, upper body, wearing $CLOTHING, $EYES, neutral expression, looking at viewer"
FULLBODY="${TRIG_TAG}1man, solo, full body, standing, wearing $CLOTHING, $EYES, plain background"

n=0
for entry in $MATRIX; do
  n=$((n+1))
  IFS=':' read -r wv ev lv <<<"$entry"
  uselora=0; [ "${lv:-}" = "lora" ] && uselora=1
  tag="w${wv}_e${ev}"; [ "$uselora" = "1" ] && tag="${tag}_lora"
  echo "── variant $n/$(set -- $MATRIX; echo $#): iid-weight=$wv  iid-end=$ev  lora=$([ "$uselora" = 1 ] && echo on || echo off)"
  gen "${OUT}_${tag}_portrait" "$PORTRAIT" "$wv" "$ev" "$uselora"
  [ "$PORTRAIT_ONLY" = "1" ] || gen "${OUT}_${tag}_fullbody" "$FULLBODY" "$wv" "$ev" "$uselora"
done

echo
echo "✅ sweep done → $SAGA_ROOT/tmp/${OUT}_*.png"
echo "   Judge the *_portrait shots for likeness (full-body faces render tiny — run"
echo "   saga-detail.sh --detect face on the winner to sharpen the face there)."
echo "   Tell me which tag reads closest to you and I'll narrow the next sweep around it."
