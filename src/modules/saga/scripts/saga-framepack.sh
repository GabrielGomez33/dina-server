#!/usr/bin/env bash
# ============================================================================
# saga-framepack.sh — render ONE continuous take (FramePack / HunyuanVideo I2V)
# ----------------------------------------------------------------------------
# Single-take motion backend for the swappable VIDEO_BACKEND pipeline (see
# docs/VIDEO_BACKENDS.md). Unlike Wan FLF (keyframe-pair interpolation, ~5s cap),
# FramePack generates ONE long forward take from a single START frame + a motion
# prompt — the "one gen, one scene" path — 15-60s on 24GB via section-based
# anti-drift context. Identity is native when a HunyuanVideo video-LoRA is passed
# (train it with saga-video-lora-train.sh --model hunyuan), so no face-restore hack.
#
# Implements the COMMON driver interface (identical arg surface to saga-flf.sh so
# the jutsu orchestrator dispatches to any backend with the same call):
#   -a/--first IMG        START frame (required)
#   -b/--last  IMG        END frame (accepted for interface parity; FramePack is
#                         forward-I2V from START, so END is IGNORED — logged)
#   -p/--prompt STR   -n/--neg STR
#   -L/--length FRAMES  OR  -d/--duration SEC   (FramePack thinks in seconds)
#   --fps N (default 30 — FramePack's native rate)   --shift F (default 8)
#   -W/--width N   -H/--height N   -s/--seed N   -o/--out NAME
#   --lora FILE  --lora-weight F   HunyuanVideo video-LoRA (models/loras_video/hunyuan)
#   --steps N (default 25)   --cfg F (default 1.0)   --guidance F (default 10.0)
#   --teacache F (default 0.05: motion-first) | --no-teacache (max motion, slowest).
#     RAISE toward 0.15 for speed if the clip is static-tolerant; 0.15 suppresses subtle
#     motion (head/body drift caches away, only blinks survive) — that's the "no movement" bug.
#   --dump-graph            write the graph JSON to stdout and EXIT (no submit) —
#                           inspect/diff against /object_info before a real run
#   --check                 run the /object_info preflight only, then exit
#
# Env (override to match your installed filenames — see docs/VIDEO_BACKENDS.md §2):
#   SAGA_ROOT (required)   COMFY=http://127.0.0.1:8188
#   FP_MODEL=FramePackI2V_HY_bf16.safetensors        (models/diffusion_models)
#   FP_VAE=hunyuan_video_vae_bf16.safetensors        (models/vae)
#   FP_CLIPVISION=sigclip_vision_patch14_384.safetensors  (models/clip_vision)
#   FP_CLIP_L=clip_l.safetensors                     (models/text_encoders)
#   FP_LLM=llava_llama3_fp16.safetensors             (models/text_encoders)
#
# ⚠️ VERIFY-LIVE: FramePackWrapper node input names move between releases. This graph
# is built to the kijai/ComfyUI-FramePackWrapper schema captured via /object_info.
# The --check preflight fails loudly if any node class is absent; --dump-graph lets
# you diff the exact wiring before committing GPU time. Fix mismatches at the node
# map below (NODE_* vars) — do NOT guess silently.
# ============================================================================
set -uo pipefail

COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"

FP_MODEL="${FP_MODEL:-FramePackI2V_HY_bf16.safetensors}"
FP_VAE="${FP_VAE:-hunyuan_video_vae_bf16.safetensors}"
FP_CLIPVISION="${FP_CLIPVISION:-sigclip_vision_patch14_384.safetensors}"
FP_CLIP_L="${FP_CLIP_L:-clip_l.safetensors}"
FP_LLM="${FP_LLM:-llava_llama3_fp16.safetensors}"

# node class names (override if a fork renames them; verified via --check) --------
NODE_MODEL="${FP_NODE_MODEL:-LoadFramePackModel}"          # local loader w/ lora input
NODE_LORA="${FP_NODE_LORA:-FramePackLoraSelect}"
NODE_SAMPLER="${FP_NODE_SAMPLER:-FramePackSampler}"

OUT="saga_framepack"; SEED=0; W=768; H=1152; FPS=30; SHIFT=8; LEN=""; DUR=""
STEPS=25; CFG=1.0; GUIDANCE=10.0; LWS=9; GPU_KEEP=6.0
# TeaCache: caches transformer steps whose output changes < TEACACHE (L1). It's a SPEED hack,
# but it suppresses SUBTLE continuous motion — only high-delta changes (a blink) survive while
# gradual head/body drift gets cached away, so the clip looks nearly static. 0.15 = fast/static;
# ~0.05 = mostly-full motion, modest speedup; 0 (or --no-teacache) = OFF, max motion, slowest.
# Default lowered to 0.05 so motion is the priority — the anime look tolerates the small speed hit.
TEACACHE="${FP_TEACACHE:-0.05}"
LORA=""; LORA_W=1.0
PROMPT=""; NEG=""
FIRST=""; LAST=""; DUMP=0; CHECK=0

die(){ echo "❌ $*" >&2; exit 1; }
usage(){ sed -n '2,46p' "$0"; exit 0; }

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
  --guidance) GUIDANCE="$2"; shift 2;;
  --teacache) TEACACHE="$2"; shift 2;;
  --no-teacache) TEACACHE="0"; shift;;
  --latent-window) LWS="$2"; shift 2;;
  --gpu-keep) GPU_KEEP="$2"; shift 2;;
  --lora) LORA="$2"; shift 2;;
  --lora-weight) LORA_W="$2"; shift 2;;
  --dump-graph) DUMP=1; shift;;
  --check) CHECK=1; shift;;
  -h|--help) usage;;
  *) die "unknown arg: $1 (see --help)";;
esac; done

command -v jq >/dev/null || die "jq required"

# ---- length: FramePack is time-driven. Derive seconds from -L/fps or -d --------
if [ -n "$DUR" ]; then
  SECONDS_LEN="$DUR"
elif [ -n "$LEN" ]; then
  SECONDS_LEN=$(awk -v l="$LEN" -v f="$FPS" 'BEGIN{printf "%.3f", l/f}')
else
  SECONDS_LEN="5"
fi
# FramePackSampler caps total_second_length at 120; clamp with a warning.
CLAMPED=$(awk -v s="$SECONDS_LEN" 'BEGIN{ if(s<1){print 1} else if(s>120){print 120} else {print s} }')
if [ "$CLAMPED" != "$SECONDS_LEN" ]; then
  echo "⚠️ duration ${SECONDS_LEN}s out of [1,120] — clamping to ${CLAMPED}s" >&2
  SECONDS_LEN="$CLAMPED"
fi

# ---- TeaCache: >0 enables caching at that L1 threshold; 0 (or --no-teacache) OFF (max motion)
TC_ON=$(awk -v t="$TEACACHE" 'BEGIN{print (t+0>0)?"true":"false"}')
[ "$TC_ON" = "false" ] && TEACACHE="0"

# ---- preflight: every node class we emit must exist on this server -------------
preflight(){
  local info missing=() n
  info=$(curl -sf "$COMFY/object_info") || die "cannot reach ComfyUI at $COMFY (is saga-comfyui up?)"
  local needed=("$NODE_MODEL" "$NODE_SAMPLER" "VAELoader" "CLIPVisionLoader"
                "CLIPVisionEncode" "DualCLIPLoader" "CLIPTextEncode" "LoadImage"
                "VAEEncode" "VAEDecode" "VHS_VideoCombine")
  [ -n "$LORA" ] && needed+=("$NODE_LORA")
  for n in "${needed[@]}"; do
    [ "$(jq -r --arg k "$n" 'has($k)' <<<"$info")" = "true" ] || missing+=("$n")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "❌ FramePack preflight failed — missing node class(es):" >&2
    printf '   • %s\n' "${missing[@]}" >&2
    echo "   Install FramePack nodes/models (docs/VIDEO_BACKENDS.md §2) and restart:" >&2
    echo "     sudo pm2 restart saga-comfyui" >&2
    echo "   If a class is merely RENAMED in your fork, override via FP_NODE_MODEL /" >&2
    echo "   FP_NODE_LORA / FP_NODE_SAMPLER env vars." >&2
    return 1
  fi
  echo "✔ preflight ok — all FramePack node classes present"
}

if [ "$CHECK" -eq 1 ]; then preflight || exit 1; exit 0; fi
[ -n "$FIRST" ] || die "need -a/--first (start frame)"
[ -n "$LAST" ] && echo "ℹ FramePack is forward-I2V from START; --last ('$LAST') is ignored (interface parity only)"

# ---- build graph ---------------------------------------------------------------
# model chain: [loader] (+ optional [lora]->loader.lora) -> sampler.model
# The LoRA select node feeds the loader's `lora` input (FramePackWrapper convention).
if [ -n "$LORA" ]; then
  LORA_NODE="\"40\":{\"class_type\":\"$NODE_LORA\",\"inputs\":{\"lora\":\"$LORA\",\"strength\":$LORA_W,\"fuse_lora\":false}},"
  MODEL_INPUTS="{\"model\":\"$FP_MODEL\",\"base_precision\":\"bf16\",\"quantization\":\"disabled\",\"attention_mode\":\"sdpa\",\"load_device\":\"offload_device\",\"lora\":[\"40\",0]}"
else
  LORA_NODE=""
  MODEL_INPUTS="{\"model\":\"$FP_MODEL\",\"base_precision\":\"bf16\",\"quantization\":\"disabled\",\"attention_mode\":\"sdpa\",\"load_device\":\"offload_device\"}"
fi

build_graph(){ cat <<JSON
{
 $LORA_NODE
 "1": {"class_type":"$NODE_MODEL","inputs":$MODEL_INPUTS},
 "2": {"class_type":"VAELoader","inputs":{"vae_name":"$FP_VAE"}},
 "3": {"class_type":"CLIPVisionLoader","inputs":{"clip_name":"$FP_CLIPVISION"}},
 "4": {"class_type":"DualCLIPLoader","inputs":{"clip_name1":"$FP_CLIP_L","clip_name2":"$FP_LLM","type":"hunyuan_video"}},
 "5": {"class_type":"LoadImage","inputs":{"image":"$A"}},
 "13":{"class_type":"ImageScale","inputs":{"image":["5",0],"upscale_method":"bicubic","width":$W,"height":$H,"crop":"center"}},
 "6": {"class_type":"CLIPVisionEncode","inputs":{"clip_vision":["3",0],"image":["13",0],"crop":"center"}},
 "7": {"class_type":"VAEEncode","inputs":{"pixels":["13",0],"vae":["2",0]}},
 "8": {"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$PROMPT" '$s'),"clip":["4",0]}},
 "9": {"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$NEG" '$s'),"clip":["4",0]}},
 "10":{"class_type":"$NODE_SAMPLER","inputs":{"model":["1",0],"positive":["8",0],"negative":["9",0],"start_latent":["7",0],"image_embeds":["6",0],"steps":$STEPS,"cfg":$CFG,"guidance_scale":$GUIDANCE,"shift":$SHIFT,"seed":$SEED,"latent_window_size":$LWS,"gpu_memory_preservation":$GPU_KEEP,"total_second_length":$SECONDS_LEN,"use_teacache":$TC_ON,"teacache_rel_l1_thresh":$TEACACHE,"sampler":"unipc_bh1"}},
 "11":{"class_type":"VAEDecode","inputs":{"samples":["10",0],"vae":["2",0]}},
 "12":{"class_type":"VHS_VideoCombine","inputs":{"images":["11",0],"frame_rate":$FPS,"loop_count":0,"filename_prefix":"$OUT","format":"video/h264-mp4","pingpong":false,"save_output":true}}
}
JSON
}

# ---- ComfyUI I/O helpers (shared convention with saga-flf.sh) ------------------
CID="sagafp-$$-$RANDOM"
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

# ---- --dump-graph: emit the wiring with a placeholder start, then exit ----------
if [ "$DUMP" -eq 1 ]; then
  A="${FIRST:-START.png}"
  G=$(build_graph)
  jq -e . >/dev/null <<<"$G" || { echo "$G"; die "graph is not valid JSON (see above)"; }
  echo "$G"; exit 0
fi

preflight || die "preflight failed (see above)"

echo "▶ framepack: '$OUT'  ${W}x${H}  ${SECONDS_LEN}s @ ${FPS}fps  seed=$SEED  steps=$STEPS  teacache=$([ "$TC_ON" = true ] && echo "$TEACACHE" || echo off)${LORA:+  lora=$LORA@$LORA_W}"
A=$(upload "$FIRST"); echo "  start: $A"

GRAPH=$(mktemp)
build_graph > "$GRAPH"
jq -e . "$GRAPH" >/dev/null || { cat "$GRAPH" >&2; die "internal: built invalid JSON graph"; }
PID=$(submit "$GRAPH"); echo "  submitted: $PID"
HIST=$(wait_done "$PID")
DEST="${SAGA_ROOT}/tmp/${OUT}.mp4"
fetch_first "$HIST" "$PID" "$DEST" >/dev/null
rm -f "$GRAPH"
echo "✅ framepack take → $DEST"
echo "$DEST"
