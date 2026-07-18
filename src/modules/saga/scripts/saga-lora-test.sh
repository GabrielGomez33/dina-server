#!/usr/bin/env bash
# ============================================================================
# saga-lora-test.sh — validate a trained LoRA (LoRA-only generate, no IP-Adapter)
# ----------------------------------------------------------------------------
# Generates test stills from Animagine + the trained LoRA alone, so you see what
# the LoRA ITSELF learned (identity should now come from the LoRA, not a
# reference). By default renders 3 shots (portrait / full body / hands) at a few
# angles so you can judge whether the character holds across poses.
#
#   saga-lora-test.sh --lora exodia.safetensors --trigger exodia_saga [--weight 0.85]
#      [--prompt "extra tags"] [--seed 777] [--steps 28] [--cfg 5.5]
#
# Env: SAGA_ROOT (required)  COMFY=http://127.0.0.1:8188
#      LORA_CKPT=animagine-xl-4.0.safetensors
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
CKPT="${LORA_CKPT:-animagine-xl-4.0.safetensors}"

LORA=""; TRIGGER=""; WEIGHT=0.85; EXTRA=""; SEED=777; STEPS=28; CFG=5.5; W=1024; H=1024
NEG="lowres, bad anatomy, bad hands, extra fingers, worst quality, blurry, multiple people, 2boys, watermark, text"
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --lora) LORA="$2"; shift 2;; --trigger) TRIGGER="$2"; shift 2;;
  --weight) WEIGHT="$2"; shift 2;; --prompt) EXTRA="$2"; shift 2;;
  --seed) SEED="$2"; shift 2;; --steps) STEPS="$2"; shift 2;; --cfg) CFG="$2"; shift 2;;
  -W|--width) W="$2"; shift 2;; -H|--height) H="$2"; shift 2;; -n|--neg) NEG="$2"; shift 2;;
  -h|--help) sed -n '2,18p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
[ -n "$LORA" ] || die "need --lora <file in models/loras>"
[ -n "$TRIGGER" ] || die "need --trigger <the token the LoRA was trained on>"
command -v jq >/dev/null || die "jq required"
[ -f "$SAGA_ROOT/models/loras/$LORA" ] || die "LoRA not found: models/loras/$LORA"

CID="loratest-$$-$RANDOM"
submit(){ curl -sf -X POST "$COMFY/prompt" --data "$(jq -nc --slurpfile g "$1" --arg c "$CID" '{prompt:$g[0], client_id:$c}')" | jq -r '.prompt_id' || die "submit rejected"; }
wait_done(){ local id="$1" t=0 h st; while :; do h=$(curl -sf "$COMFY/history/$id"); if [ "$(jq -r --arg i "$id" 'has($i)' <<<"$h")" = "true" ]; then st=$(jq -r --arg i "$id" '.[$i].status.status_str // "ok"' <<<"$h"); if [ "$st" = "error" ]; then jq -r --arg i "$id" '.[$i].status.messages[]? | select(.[0]=="execution_error") | .[1] | "  ⤷ node \(.node_id) (\(.node_type)): \(.exception_type): \(.exception_message)"' <<<"$h" >&2; die "execution error for $id"; fi; echo "$h"; return 0; fi; t=$((t+2)); [ "$t" -gt 600 ] && die "timeout for $id"; sleep 2; done; }
fetch_first(){ local h="$1" id="$2" dest="$3" line fn sf ty code base sub src
  line=$(jq -r --arg i "$id" '.[$i].outputs[] | ((.images // [])[0]) | select(.!=null) | "\(.filename)\t\(.subfolder)\t\(.type)"' <<<"$h" | head -n1)
  [ -n "$line" ] || die "no output image for $id"; IFS=$'\t' read -r fn sf ty <<<"$line"
  code=$(curl -s -o "$dest" -w '%{http_code}' "$COMFY/view?filename=$(jq -rn --arg s "$fn" '$s|@uri')&subfolder=$(jq -rn --arg s "$sf" '$s|@uri')&type=${ty:-output}")
  { [ "$code" = "200" ] && [ -s "$dest" ]; } && { echo "$dest"; return 0; }
  rm -f "$dest"
  for base in "${COMFY_OUT:-}" "$SAGA_ROOT/engine/ComfyUI/output"; do [ -n "$base" ] || continue; sub="$base${sf:+/$sf}"; [ -f "$sub/$fn" ] && { cp -f "$sub/$fn" "$dest" && { echo "$dest"; return 0; }; }; done
  src=$(find "$SAGA_ROOT/engine" -name "$fn" -print -quit 2>/dev/null); [ -n "$src" ] && { cp -f "$src" "$dest"; echo "$dest"; return 0; }
  die "could not retrieve $fn (view http=$code)"
}

gen(){ # <out> <prompt>
  local out="$1" prompt="$2" G; G=$(mktemp)
  cat > "$G" <<JSON
{
 "1": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"$CKPT"}},
 "30":{"class_type":"LoraLoader","inputs":{"model":["1",0],"clip":["1",1],"lora_name":"$LORA","strength_model":$WEIGHT,"strength_clip":$WEIGHT}},
 "2": {"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$prompt" '$s'),"clip":["30",1]}},
 "3": {"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$NEG" '$s'),"clip":["30",1]}},
 "4": {"class_type":"EmptyLatentImage","inputs":{"width":$W,"height":$H,"batch_size":1}},
 "5": {"class_type":"KSampler","inputs":{"seed":$SEED,"steps":$STEPS,"cfg":$CFG,"sampler_name":"euler_ancestral","scheduler":"normal","denoise":1,"model":["30",0],"positive":["2",0],"negative":["3",0],"latent_image":["4",0]}},
 "6": {"class_type":"VAEDecode","inputs":{"samples":["5",0],"vae":["1",2]}},
 "7": {"class_type":"SaveImage","inputs":{"filename_prefix":"$out","images":["6",0]}}
}
JSON
  jq -e . "$G" >/dev/null || die "internal: invalid graph"
  local pid; pid=$(submit "$G"); echo "  [$out] submitted: $pid"
  local hist; hist=$(wait_done "$pid")
  fetch_first "$hist" "$pid" "$SAGA_ROOT/tmp/${out}.png" >/dev/null
  echo "  ✅ $SAGA_ROOT/tmp/${out}.png"; rm -f "$G"
}

echo "▶ LoRA test: $LORA @ weight $WEIGHT  trigger='$TRIGGER'  seed=$SEED"
STY="cel shaded anime, 2d, flat colors, dark background, dramatic lighting, masterpiece"
X=""; [ -n "$EXTRA" ] && X=", $EXTRA"
gen loratest_portrait  "$TRIGGER, solo, portrait, upper body, $STY$X"
gen loratest_fullbody  "$TRIGGER, solo, full body, standing, fighting stance, $STY$X"
gen loratest_hands     "$TRIGGER, solo, both hands forming a ninja hand seal, close-up on hands, $STY$X"
echo "✅ 3 test stills in $SAGA_ROOT/tmp/loratest_*.png — try --weight 0.6..1.0 to tune identity strength"
