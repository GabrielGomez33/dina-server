#!/usr/bin/env bash
# ============================================================================
# saga-keyframe.sh — pose ONE keyframe still (Animagine + IP-Adapter identity +
#                    ControlNet Union Promax pose-forcing)
# ----------------------------------------------------------------------------
# Produces one pinned pose still for the FLF path. Identity comes from an Exodia
# reference image (IP-Adapter); the exact hand configuration comes from a control
# image (a cropped seal from the reference sheet) through ControlNet Union Promax.
# This is the "author the pose as a still, fix it ONCE" half of the keyframe path.
#
# Identity can come from a trained LoRA (preferred — no pose prior), an IP-Adapter
# reference image, both, or neither. With a LoRA there's no reference-pose prior
# fighting the ControlNet, so seal poses actually take.
#
# Shared param convention with saga-flf.sh:
#   -o/--out NAME   -s/--seed N   -W/--width N   -H/--height N
#   -p/--prompt STR   -n/--neg STR
# Identity:
#   --lora FILE                LoRA in models/loras (e.g. exodia.safetensors)
#   --lora-weight F            LoRA strength (default 0.85)
#   --trigger TOKEN            prepended to the prompt (the LoRA's trigger word)
#   -r/--ref IMG               IP-Adapter reference image (optional; identity/style)
#   --ip-weight F              IP-Adapter weight 0..1 (default 0.65)
# Pose:
#   -c/--control IMG           control image (a cropped seal)
#   --control-pre MODE         none|dwpose|openpose   (default dwpose)
#   --control-strength F       ControlNet strength 0..1 (default 0.8)
#   --steps N (default 28)   --cfg F (default 5.5)
#
# Env (override model filenames if yours differ):
#   SAGA_ROOT (required)   COMFY=http://127.0.0.1:8188
#   KF_CKPT=animagine-xl-4.0.safetensors
#   KF_CN=controlnet-union-sdxl-promax.safetensors
#
# ⚠️ VERIFY-LIVE NOTE: Union Promax on some ComfyUI builds needs a
# SetUnionControlNetType node between ControlNetLoader and ControlNetApplyAdvanced.
# If the submit errors on the control net type, see the NOTE block near node 23.
# ============================================================================
set -uo pipefail

COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
CKPT="${KF_CKPT:-animagine-xl-4.0.safetensors}"
CN="${KF_CN:-controlnet-union-sdxl-promax.safetensors}"

OUT="saga_kf"; SEED=0; W=1280; H=704; STEPS=28; CFG=5.5
PROMPT=""; NEG="lowres, bad anatomy, bad hands, extra fingers, fused fingers, missing fingers, worst quality, blurry, multiple people, 2boys"
REF=""; CONTROL=""; CPRE="dwpose"; CSTR=0.8; IPW=0.65
LORA=""; LORAW=0.85; TRIGGER=""

die(){ echo "❌ $*" >&2; exit 1; }
usage(){ sed -n '2,30p' "$0"; exit 0; }

while [ $# -gt 0 ]; do case "$1" in
  -o|--out) OUT="$2"; shift 2;;
  -s|--seed) SEED="$2"; shift 2;;
  -W|--width) W="$2"; shift 2;;
  -H|--height) H="$2"; shift 2;;
  -p|--prompt) PROMPT="$2"; shift 2;;
  -n|--neg) NEG="$2"; shift 2;;
  -r|--ref) REF="$2"; shift 2;;
  -c|--control) CONTROL="$2"; shift 2;;
  --control-pre) CPRE="$2"; shift 2;;
  --control-strength) CSTR="$2"; shift 2;;
  --ip-weight) IPW="$2"; shift 2;;
  --lora) LORA="$2"; shift 2;;
  --lora-weight) LORAW="$2"; shift 2;;
  --trigger) TRIGGER="$2"; shift 2;;
  --steps) STEPS="$2"; shift 2;;
  --cfg) CFG="$2"; shift 2;;
  -h|--help) usage;;
  *) die "unknown arg: $1 (see --help)";;
esac; done

[ -n "$PROMPT" ] || die "need -p/--prompt"
command -v jq >/dev/null || die "jq required"
[ -z "$LORA" ] || [ -f "$SAGA_ROOT/models/loras/$LORA" ] || die "LoRA not found: models/loras/$LORA"
[ -n "$REF" ] || [ -n "$LORA" ] || echo "⚠️ no --lora and no --ref: plain generation (no identity lock)" >&2
[ -n "$TRIGGER" ] && PROMPT="$TRIGGER, $PROMPT"

CID="sagakf-$$-$RANDOM"

# --- helpers (shared shape with saga-flf.sh) --------------------------------
upload(){ # <path> -> echoes uploaded name
  local f="$1"; [ -f "$f" ] || die "file not found: $f"
  curl -sf -F "image=@${f}" -F "overwrite=true" "$COMFY/upload/image" \
    | jq -r '.name' || die "upload failed: $f"
}
submit(){ # <graph-json-file> -> echoes prompt_id
  curl -sf -X POST "$COMFY/prompt" \
    --data "$(jq -nc --slurpfile g "$1" --arg c "$CID" '{prompt:$g[0], client_id:$c}')" \
    | jq -r '.prompt_id' || die "submit rejected — check node errors above"
}
wait_done(){ # <prompt_id>
  local id="$1" t=0
  while :; do
    local h; h=$(curl -sf "$COMFY/history/$id")
    if [ "$(jq -r --arg i "$id" 'has($i)' <<<"$h")" = "true" ]; then
      local st; st=$(jq -r --arg i "$id" '.[$i].status.status_str // "ok"' <<<"$h")
      if [ "$st" = "error" ]; then
        jq -r --arg i "$id" '.[$i].status.messages[]? | select(.[0]=="execution_error") | .[1] | "  ⤷ node \(.node_id) (\(.node_type)): \(.exception_type): \(.exception_message)"' <<<"$h" >&2
        die "ComfyUI reported an execution error for $id"
      fi
      echo "$h"; return 0
    fi
    t=$((t+2)); [ "$t" -gt 900 ] && die "timeout waiting for $id"
    sleep 2
  done
}
fetch_first(){ # <history-json> <prompt_id> <dest>   [tries HTTP /view, then disk]
  local h="$1" id="$2" dest="$3" line fn sf ty code base sub src
  line=$(jq -r --arg i "$id" '.[$i].outputs[] | ((.images // .gifs // [])[0]) | select(.!=null) | "\(.filename)\t\(.subfolder)\t\(.type)"' <<<"$h" | head -n1)
  [ -n "$line" ] || die "no output image in history for $id"
  IFS=$'\t' read -r fn sf ty <<<"$line"
  code=$(curl -s -o "$dest" -w '%{http_code}' "$COMFY/view?filename=$(jq -rn --arg s "$fn" '$s|@uri')&subfolder=$(jq -rn --arg s "$sf" '$s|@uri')&type=${ty:-output}")
  { [ "$code" = "200" ] && [ -s "$dest" ]; } && { echo "$dest"; return 0; }
  rm -f "$dest"
  for base in "${COMFY_OUT:-}" "$SAGA_ROOT/engine/ComfyUI/output" "$SAGA_ROOT/engine/ComfyUI/temp"; do
    [ -n "$base" ] || continue; sub="$base${sf:+/$sf}"
    [ -f "$sub/$fn" ] && { cp -f "$sub/$fn" "$dest" && { echo "$dest"; return 0; }; }
  done
  src=$(find "$SAGA_ROOT/engine" -name "$fn" -print -quit 2>/dev/null)
  [ -n "$src" ] && { cp -f "$src" "$dest" && { echo "$dest"; return 0; }; }
  die "could not retrieve $fn (view http=$code; not found on disk). Set COMFY_OUT to your ComfyUI output dir."
}

echo "▶ keyframe: '$OUT'  seed=$SEED  ${W}x${H}  lora=${LORA:-none}@$LORAW  ref=${REF:+ip@$IPW}  control=${CONTROL:-none}/$CPRE@$CSTR"
REF_NAME=""; [ -n "$REF" ] && { REF_NAME=$(upload "$REF"); echo "  ref uploaded: $REF_NAME"; }
CTRL_NAME=""; [ -n "$CONTROL" ] && { CTRL_NAME=$(upload "$CONTROL"); echo "  control uploaded: $CTRL_NAME"; }

# Identity routing: a LoRA (node 40) rewires model+clip; IP-Adapter (nodes
# 8/14/9/10) further wraps the model. KMODEL is what the sampler consumes.
if [ -n "$LORA" ]; then MODEL='["40",0]'; CLIP='["40",1]'; else MODEL='["1",0]'; CLIP='["1",1]'; fi

# --- build graph ------------------------------------------------------------
GRAPH=$(mktemp)
{
cat <<JSON
{
 "1": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"$CKPT"}},
JSON
[ -n "$LORA" ] && cat <<JSON
 "40":{"class_type":"LoraLoader","inputs":{"model":["1",0],"clip":["1",1],"lora_name":"$LORA","strength_model":$LORAW,"strength_clip":$LORAW}},
JSON
cat <<JSON
 "2": {"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$PROMPT" '$s'),"clip":$CLIP}},
 "3": {"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$NEG" '$s'),"clip":$CLIP}},
 "4": {"class_type":"EmptyLatentImage","inputs":{"width":$W,"height":$H,"batch_size":1}},
JSON

# IP-Adapter only when a reference image is supplied.
if [ -n "$REF_NAME" ]; then
cat <<JSON
 "8": {"class_type":"LoadImage","inputs":{"image":"$REF_NAME"}},
 "14":{"class_type":"PrepImageForClipVision","inputs":{"image":["8",0],"interpolation":"LANCZOS","crop_position":"center","sharpening":0}},
 "9": {"class_type":"IPAdapterUnifiedLoader","inputs":{"model":$MODEL,"preset":"PLUS (high strength)"}},
 "10":{"class_type":"IPAdapterAdvanced","inputs":{"model":["9",0],"ipadapter":["9",1],"image":["14",0],"weight":$IPW,"weight_type":"linear","combine_embeds":"concat","start_at":0,"end_at":1,"embeds_scaling":"V only"}},
JSON
  KMODEL='["10",0]'
else
  KMODEL="$MODEL"
fi

if [ -n "$CTRL_NAME" ]; then
  # preprocessor selection (confirmed nodes: DWPreprocessor / OpenposePreprocessor)
  case "$CPRE" in
    none)     PRE_SRC='["20",0]';;
    openpose) echo ' "21":{"class_type":"OpenposePreprocessor","inputs":{"image":["20",0],"detect_hand":"enable","detect_body":"enable","detect_face":"disable","resolution":768}},'; PRE_SRC='["21",0]';;
    *)        echo ' "21":{"class_type":"DWPreprocessor","inputs":{"image":["20",0],"detect_hand":"enable","detect_body":"enable","detect_face":"disable","resolution":768}},'; PRE_SRC='["21",0]';;
  esac
cat <<JSON
 "20":{"class_type":"LoadImage","inputs":{"image":"$CTRL_NAME"}},
 "22":{"class_type":"ControlNetLoader","inputs":{"control_net_name":"$CN"}},
 "23":{"class_type":"ControlNetApplyAdvanced","inputs":{"positive":["2",0],"negative":["3",0],"control_net":["22",0],"image":$PRE_SRC,"strength":$CSTR,"start_percent":0.0,"end_percent":0.9,"vae":["1",2]}},
JSON
  # NOTE: if Union Promax is rejected without a type, insert between 22 and 23:
  #   "24":{"class_type":"SetUnionControlNetType","inputs":{"control_net":["22",0],"type":"openpose"}}
  #   then point 23.control_net to ["24",0].
  POS='["23",0]'; NEGC='["23",1]'
else
  POS='["2",0]'; NEGC='["3",0]'
fi

cat <<JSON
 "5": {"class_type":"KSampler","inputs":{"seed":$SEED,"steps":$STEPS,"cfg":$CFG,"sampler_name":"euler_ancestral","scheduler":"normal","denoise":1,"model":$KMODEL,"positive":$POS,"negative":$NEGC,"latent_image":["4",0]}},
 "6": {"class_type":"VAEDecode","inputs":{"samples":["5",0],"vae":["1",2]}},
 "7": {"class_type":"SaveImage","inputs":{"filename_prefix":"$OUT","images":["6",0]}}
}
JSON
} > "$GRAPH"

jq -e . "$GRAPH" >/dev/null || die "internal: built invalid JSON graph"
PID=$(submit "$GRAPH"); echo "  submitted: $PID"
HIST=$(wait_done "$PID")
DEST="${SAGA_ROOT}/tmp/${OUT}.png"
fetch_first "$HIST" "$PID" "$DEST" >/dev/null
rm -f "$GRAPH"
echo "✅ keyframe → $DEST"
echo "$DEST"
