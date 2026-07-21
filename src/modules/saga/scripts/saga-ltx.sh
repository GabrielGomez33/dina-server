#!/usr/bin/env bash
# ============================================================================
# saga-ltx.sh — render ONE continuous take (LTX-Video I2V)
# ----------------------------------------------------------------------------
# Single-take motion backend for the swappable VIDEO_BACKEND pipeline (see
# docs/VIDEO_BACKENDS.md). LTX-Video is fast and long: ONE forward take from a
# single START frame + a motion prompt — the "one gen, one scene" path — at high
# throughput. Identity is native when an LTX video-LoRA is passed (train it with
# saga-video-lora-train.sh --model ltx), so no face-restore hack.
#
# Implements the COMMON driver interface (same arg surface as saga-flf.sh /
# saga-framepack.sh so the jutsu orchestrator dispatches identically):
#   -a/--first IMG        START frame (required)
#   -b/--last  IMG        accepted for parity; LTX is forward-I2V — END is IGNORED
#   -p/--prompt STR   -n/--neg STR
#   -L/--length FRAMES  OR  -d/--duration SEC
#   --fps N (default 25 — LTX native)   --shift F (unused; kept for parity)
#   -W/--width N   -H/--height N   -s/--seed N   -o/--out NAME
#   --lora FILE  --lora-weight F     LTX video-LoRA (models/loras_video/ltx)
#   --steps N (default 30)   --cfg F (default 3.0)
#   --dump-graph            emit graph JSON and EXIT (no submit) for inspection
#   --check                 run the /object_info preflight only, then exit
#
# LTX frame constraint: latent temporal stride is 8, so frame count must satisfy
# (length-1) % 8 == 0 (…, 121, 161, 201, 241). We round to the nearest valid count
# and log it. Duration→frames uses --fps.
#
# Env (override to match your installed filenames — see docs/VIDEO_BACKENDS.md §3):
#   SAGA_ROOT (required)   COMFY=http://127.0.0.1:8188
#   LTX_CKPT=ltx-video-2b-v0.9.5.safetensors   (models/checkpoints; bundles model+vae)
#   LTX_T5=t5xxl_fp16.safetensors              (models/text_encoders)
#
# ⚠️ VERIFY-LIVE: LTXV nodes are native to this ComfyUI build (confirmed via
# /object_info: LTXVConditioning, LTXVScheduler, EmptyLTXVLatentVideo…). Node input
# names can still move between ComfyUI releases; --check fails loudly on a missing
# class and --dump-graph shows the exact wiring before GPU time is spent.
# ============================================================================
set -uo pipefail

COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"

LTX_CKPT="${LTX_CKPT:-ltx-video-2b-v0.9.5.safetensors}"
LTX_T5="${LTX_T5:-t5xxl_fp16.safetensors}"

OUT="saga_ltx"; SEED=0; W=768; H=1152; FPS=25; SHIFT=5; LEN=""; DUR=""
STEPS=30; CFG=3.0
LORA=""; LORA_W=1.0
PROMPT=""; NEG="worst quality, blurry, jittery, distorted, static, morphing artifacts, extra limbs"
FIRST=""; LAST=""; DUMP=0; CHECK=0

die(){ echo "❌ $*" >&2; exit 1; }
usage(){ sed -n '2,42p' "$0"; exit 0; }

while [ $# -gt 0 ]; do case "$1" in
  -o|--out) OUT="$2"; shift 2;;
  -s|--seed) SEED="$2"; shift 2;;
  -W|--width) W="$2"; shift 2;;
  -H|--height) H="$2"; shift 2;;
  -p|--prompt) PROMPT="$2"; shift 2;;
  -n|--neg) NEG="$2"; shift 2;;
  -a|--first) FIRST="$2"; shift 2;;
  -b|--last) LAST="$2"; shift 2;;
  -d|--duration) DUR="$2"; shift 2;;
  -L|--length) LEN="$2"; shift 2;;
  --fps) FPS="$2"; shift 2;;
  --shift) SHIFT="$2"; shift 2;;
  --steps) STEPS="$2"; shift 2;;
  --cfg) CFG="$2"; shift 2;;
  --lora) LORA="$2"; shift 2;;
  --lora-weight) LORA_W="$2"; shift 2;;
  --dump-graph) DUMP=1; shift;;
  --check) CHECK=1; shift;;
  -h|--help) usage;;
  *) die "unknown arg: $1 (see --help)";;
esac; done

command -v jq >/dev/null || die "jq required"

# ---- length in frames, rounded to a valid LTX count: (N-1) % 8 == 0 ------------
if [ -n "$DUR" ]; then
  LEN=$(awk -v d="$DUR" -v f="$FPS" 'BEGIN{printf "%d", (d*f)+0.5}')
elif [ -z "$LEN" ]; then
  LEN=121   # ~5s @ 25fps
fi
[ "$LEN" -ge 9 ] || die "length $LEN too short (need ≥ 9 frames)"
# round to nearest valid frame count of the form 8k+1
VLEN=$(awk -v n="$LEN" 'BEGIN{ k=int((n-1)/8 + 0.5); v=8*k+1; if(v<9)v=9; print v }')
if [ "$VLEN" != "$LEN" ]; then
  echo "ℹ LTX frame constraint (8k+1): rounding length $LEN → $VLEN" >&2
  LEN="$VLEN"
fi

# ---- preflight: every node class we emit must exist on this server -------------
preflight(){
  local info missing=() n
  info=$(curl -sf "$COMFY/object_info") || die "cannot reach ComfyUI at $COMFY (is saga-comfyui up?)"
  local needed=("CheckpointLoaderSimple" "CLIPLoader" "CLIPTextEncode" "LoadImage"
                "LTXVImgToVideo" "LTXVConditioning" "LTXVScheduler" "SamplerCustom"
                "KSamplerSelect" "VAEDecode" "VHS_VideoCombine")
  [ -n "$LORA" ] && needed+=("LoraLoaderModelOnly")
  for n in "${needed[@]}"; do
    [ "$(jq -r --arg k "$n" 'has($k)' <<<"$info")" = "true" ] || missing+=("$n")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "❌ LTX preflight failed — missing node class(es):" >&2
    printf '   • %s\n' "${missing[@]}" >&2
    echo "   LTXV core is native to recent ComfyUI; if any are missing, update ComfyUI or" >&2
    echo "   install Lightricks/ComfyUI-LTXVideo (docs/VIDEO_BACKENDS.md §3), then:" >&2
    echo "     sudo pm2 restart saga-comfyui" >&2
    return 1
  fi
  echo "✔ preflight ok — all LTX node classes present"
}

if [ "$CHECK" -eq 1 ]; then preflight || exit 1; exit 0; fi
[ -n "$FIRST" ] || die "need -a/--first (start frame)"
[ -n "$LAST" ] && echo "ℹ LTX is forward-I2V from START; --last ('$LAST') is ignored (interface parity only)"

# ---- build graph ---------------------------------------------------------------
# model: checkpoint (model+vae bundled) → optional LoRA on the model → sampler
if [ -n "$LORA" ]; then
  MODEL_SRC='["40",0]'
  LORA_NODE="\"40\":{\"class_type\":\"LoraLoaderModelOnly\",\"inputs\":{\"model\":[\"1\",0],\"lora_name\":\"$LORA\",\"strength_model\":$LORA_W}},"
else
  MODEL_SRC='["1",0]'
  LORA_NODE=""
fi

build_graph(){ cat <<JSON
{
 $LORA_NODE
 "1": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"$LTX_CKPT"}},
 "2": {"class_type":"CLIPLoader","inputs":{"clip_name":"$LTX_T5","type":"ltxv"}},
 "3": {"class_type":"LoadImage","inputs":{"image":"$A"}},
 "4": {"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$PROMPT" '$s'),"clip":["2",0]}},
 "5": {"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$NEG" '$s'),"clip":["2",0]}},
 "6": {"class_type":"LTXVImgToVideo","inputs":{"positive":["4",0],"negative":["5",0],"vae":["1",2],"image":["3",0],"width":$W,"height":$H,"length":$LEN,"batch_size":1}},
 "7": {"class_type":"LTXVConditioning","inputs":{"positive":["6",0],"negative":["6",1],"frame_rate":$FPS}},
 "8": {"class_type":"LTXVScheduler","inputs":{"steps":$STEPS,"max_shift":2.05,"base_shift":0.95,"stretch":true,"terminal":0.1,"latent":["6",2]}},
 "9": {"class_type":"KSamplerSelect","inputs":{"sampler_name":"euler"}},
 "10":{"class_type":"SamplerCustom","inputs":{"model":$MODEL_SRC,"add_noise":true,"noise_seed":$SEED,"cfg":$CFG,"positive":["7",0],"negative":["7",1],"sampler":["9",0],"sigmas":["8",0],"latent_image":["6",2]}},
 "11":{"class_type":"VAEDecode","inputs":{"samples":["10",0],"vae":["1",2]}},
 "12":{"class_type":"VHS_VideoCombine","inputs":{"images":["11",0],"frame_rate":$FPS,"loop_count":0,"filename_prefix":"$OUT","format":"video/h264-mp4","pingpong":false,"save_output":true}}
}
JSON
}

# ---- ComfyUI I/O helpers (shared convention with saga-flf.sh) ------------------
CID="sagaltx-$$-$RANDOM"
upload(){ local f="$1"; [ -f "$f" ] || die "file not found: $f"; curl -sf -F "image=@${f}" -F "overwrite=true" "$COMFY/upload/image" | jq -r '.name' || die "upload failed: $f"; }
submit(){ curl -sf -X POST "$COMFY/prompt" --data "$(jq -nc --slurpfile g "$1" --arg c "$CID" '{prompt:$g[0], client_id:$c}')" | jq -r '.prompt_id' || die "submit rejected — check node errors"; }
wait_done(){ local id="$1" t=0 h st; while :; do h=$(curl -sf "$COMFY/history/$id"); if [ "$(jq -r --arg i "$id" 'has($i)' <<<"$h")" = "true" ]; then st=$(jq -r --arg i "$id" '.[$i].status.status_str // "ok"' <<<"$h"); if [ "$st" = "error" ]; then jq -r --arg i "$id" '.[$i].status.messages[]? | select(.[0]=="execution_error") | .[1] | "  ⤷ node \(.node_id) (\(.node_type)): \(.exception_type): \(.exception_message)"' <<<"$h" >&2; die "execution error for $id"; fi; echo "$h"; return 0; fi; t=$((t+3)); [ "$t" -gt 3600 ] && die "timeout waiting for $id"; sleep 3; done; }
fetch_first(){ local h="$1" id="$2" dest="$3" line fn sf ty code base sub src
  line=$(jq -r --arg i "$id" '.[$i].outputs[] | ((.gifs // .images // [])[0]) | select(.!=null) | "\(.filename)\t\(.subfolder)\t\(.type)"' <<<"$h" | head -n1)
  [ -n "$line" ] || die "no output video in history for $id"
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

# ---- --dump-graph --------------------------------------------------------------
if [ "$DUMP" -eq 1 ]; then
  A="${FIRST:-START.png}"
  G=$(build_graph)
  jq -e . >/dev/null <<<"$G" || { echo "$G"; die "graph is not valid JSON (see above)"; }
  echo "$G"; exit 0
fi

preflight || die "preflight failed (see above)"

echo "▶ ltx: '$OUT'  ${W}x${H}  ${LEN}f @ ${FPS}fps ($(awk -v l="$LEN" -v f="$FPS" 'BEGIN{printf "%.2f", l/f}')s)  seed=$SEED  steps=$STEPS${LORA:+  lora=$LORA@$LORA_W}"
A=$(upload "$FIRST"); echo "  start: $A"

GRAPH=$(mktemp)
build_graph > "$GRAPH"
jq -e . "$GRAPH" >/dev/null || { cat "$GRAPH" >&2; die "internal: built invalid JSON graph"; }
PID=$(submit "$GRAPH"); echo "  submitted: $PID"
HIST=$(wait_done "$PID")
DEST="${SAGA_ROOT}/tmp/${OUT}.mp4"
fetch_first "$HIST" "$PID" "$DEST" >/dev/null
rm -f "$GRAPH"
echo "✅ ltx take → $DEST"
echo "$DEST"
