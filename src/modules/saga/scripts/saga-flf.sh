#!/usr/bin/env bash
# ============================================================================
# saga-flf.sh — render ONE first-last-frame clip (Wan 2.2 FLF2V-A14B lightning)
# ----------------------------------------------------------------------------
# Takes a FIRST frame and a LAST frame and generates the motion between them.
# This is the animate half of the keyframe path: one FLF render per adjacent
# keyframe pair. Mirrors the verified A14B MoE lightning stack (2-expert, dual
# LightX2V 4-step LoRAs, two-stage KSamplerAdvanced) with WanFirstLastFrameToVideo.
#
# Shared param convention with saga-keyframe.sh:
#   -o/--out NAME   -s/--seed N   -W/--width N   -H/--height N
#   -p/--prompt STR   -n/--neg STR
# FLF-specific:
#   -a/--first IMG   -b/--last IMG        the two keyframes (required)
#   -d/--duration SEC   OR   -L/--length FRAMES   (default 33 frames)
#   --fps N (default 16)   --shift F (default 5)
#
# Wan window cap: a single FLF render is ONE ~81-frame window. length is clamped
# to [8,81]; longer beats must be split across more keyframes (see the driver).
#
# Env (override to match your installed filenames — same tree saga-video-a14b.sh uses):
#   SAGA_ROOT (required)   COMFY=http://127.0.0.1:8188
#   FLF_HI=Wan2.2-I2V-A14B-HighNoise-Q6_K.gguf
#   FLF_LO=Wan2.2-I2V-A14B-LowNoise-Q6_K.gguf
#   FLF_HILORA=wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors
#   FLF_LOLORA=wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors
#   FLF_T5=umt5_xxl_fp8_e4m3fn_scaled.safetensors   # confirmed installed (audit 2026-07-18)
#   FLF_VAE=wan_2.1_vae.safetensors
#   FLF_CLIPVISION=CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors
# ============================================================================
set -uo pipefail

COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
HI="${FLF_HI:-Wan2.2-I2V-A14B-HighNoise-Q6_K.gguf}"
LO="${FLF_LO:-Wan2.2-I2V-A14B-LowNoise-Q6_K.gguf}"
HILORA="${FLF_HILORA:-wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors}"
LOLORA="${FLF_LOLORA:-wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors}"
T5="${FLF_T5:-umt5_xxl_fp8_e4m3fn_scaled.safetensors}"
VAE="${FLF_VAE:-wan_2.1_vae.safetensors}"
CLIPV="${FLF_CLIPVISION:-CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors}"

OUT="saga_flf"; SEED=0; W=1280; H=704; FPS=16; SHIFT=5; LEN=33; DUR=""
PROMPT=""; NEG="lowres, bad anatomy, worst quality, blurry, static, jitter, morphing artifacts, extra limbs"
FIRST=""; LAST=""

die(){ echo "❌ $*" >&2; exit 1; }
usage(){ sed -n '2,32p' "$0"; exit 0; }

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
  -h|--help) usage;;
  *) die "unknown arg: $1 (see --help)";;
esac; done

[ -n "$FIRST" ] || die "need -a/--first (start keyframe)"
[ -n "$LAST" ]  || die "need -b/--last (end keyframe)"
command -v jq >/dev/null || die "jq required"

# duration → frames, clamped to one Wan window [8,81]
if [ -n "$DUR" ]; then LEN=$(awk -v d="$DUR" -v f="$FPS" 'BEGIN{printf "%d", (d*f)+0.5}'); fi
[ "$LEN" -lt 8 ] && die "length $LEN < 8 frames (too short to read as motion)"
if [ "$LEN" -gt 81 ]; then
  echo "⚠️ length $LEN > 81 (Wan window) — clamping to 81; split the beat with more keyframes for longer motion" >&2
  LEN=81
fi

CID="sagaflf-$$-$RANDOM"
upload(){ local f="$1"; [ -f "$f" ] || die "file not found: $f"; curl -sf -F "image=@${f}" -F "overwrite=true" "$COMFY/upload/image" | jq -r '.name' || die "upload failed: $f"; }
submit(){ curl -sf -X POST "$COMFY/prompt" --data "$(jq -nc --slurpfile g "$1" --arg c "$CID" '{prompt:$g[0], client_id:$c}')" | jq -r '.prompt_id' || die "submit rejected — check node errors"; }
wait_done(){ local id="$1" t=0 h st; while :; do h=$(curl -sf "$COMFY/history/$id"); if [ "$(jq -r --arg i "$id" 'has($i)' <<<"$h")" = "true" ]; then st=$(jq -r --arg i "$id" '.[$i].status.status_str // "ok"' <<<"$h"); [ "$st" = "error" ] && die "execution error for $id"; echo "$h"; return 0; fi; t=$((t+3)); [ "$t" -gt 1800 ] && die "timeout waiting for $id"; sleep 3; done; }
fetch_first(){ # tries HTTP /view, then disk (script is local to the box)
  local h="$1" id="$2" dest="$3" line fn sf ty code base sub src
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

echo "▶ flf: '$OUT'  ${W}x${H}  length=${LEN}f @ ${FPS}fps ($(awk -v l="$LEN" -v f="$FPS" 'BEGIN{printf "%.2f", l/f}')s)  seed=$SEED"
A=$(upload "$FIRST"); echo "  first: $A"
B=$(upload "$LAST");  echo "  last:  $B"

GRAPH=$(mktemp)
cat > "$GRAPH" <<JSON
{
 "1": {"class_type":"UnetLoaderGGUF","inputs":{"unet_name":"$HI"}},
 "2": {"class_type":"UnetLoaderGGUF","inputs":{"unet_name":"$LO"}},
 "3": {"class_type":"LoraLoaderModelOnly","inputs":{"model":["1",0],"lora_name":"$HILORA","strength_model":1.0}},
 "4": {"class_type":"LoraLoaderModelOnly","inputs":{"model":["2",0],"lora_name":"$LOLORA","strength_model":1.0}},
 "5": {"class_type":"ModelSamplingSD3","inputs":{"model":["3",0],"shift":$SHIFT}},
 "6": {"class_type":"ModelSamplingSD3","inputs":{"model":["4",0],"shift":$SHIFT}},
 "7": {"class_type":"CLIPLoader","inputs":{"clip_name":"$T5","type":"wan"}},
 "8": {"class_type":"VAELoader","inputs":{"vae_name":"$VAE"}},
 "9": {"class_type":"CLIPVisionLoader","inputs":{"clip_name":"$CLIPV"}},
 "10":{"class_type":"LoadImage","inputs":{"image":"$A"}},
 "19":{"class_type":"LoadImage","inputs":{"image":"$B"}},
 "11":{"class_type":"CLIPVisionEncode","inputs":{"clip_vision":["9",0],"image":["10",0],"crop":"center"}},
 "12":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$PROMPT" '$s'),"clip":["7",0]}},
 "13":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$NEG" '$s'),"clip":["7",0]}},
 "14":{"class_type":"WanFirstLastFrameToVideo","inputs":{"positive":["12",0],"negative":["13",0],"vae":["8",0],"clip_vision_output":["11",0],"start_image":["10",0],"end_image":["19",0],"width":$W,"height":$H,"length":$LEN,"batch_size":1}},
 "15":{"class_type":"KSamplerAdvanced","inputs":{"add_noise":"enable","noise_seed":$SEED,"steps":4,"cfg":1.0,"sampler_name":"euler","scheduler":"simple","start_at_step":0,"end_at_step":2,"return_with_leftover_noise":"enable","model":["5",0],"positive":["14",0],"negative":["14",1],"latent_image":["14",2]}},
 "16":{"class_type":"KSamplerAdvanced","inputs":{"add_noise":"disable","noise_seed":$SEED,"steps":4,"cfg":1.0,"sampler_name":"euler","scheduler":"simple","start_at_step":2,"end_at_step":10000,"return_with_leftover_noise":"disable","model":["6",0],"positive":["14",0],"negative":["14",1],"latent_image":["15",0]}},
 "17":{"class_type":"VAEDecode","inputs":{"samples":["16",0],"vae":["8",0]}},
 "18":{"class_type":"VHS_VideoCombine","inputs":{"images":["17",0],"frame_rate":$FPS,"loop_count":0,"filename_prefix":"$OUT","format":"video/h264-mp4","pingpong":false,"save_output":true}}
}
JSON

jq -e . "$GRAPH" >/dev/null || die "internal: built invalid JSON graph"
PID=$(submit "$GRAPH"); echo "  submitted: $PID"
HIST=$(wait_done "$PID")
DEST="${SAGA_ROOT}/tmp/${OUT}.mp4"
fetch_first "$HIST" "$PID" "$DEST" >/dev/null
rm -f "$GRAPH"
echo "✅ flf clip → $DEST"
echo "$DEST"
