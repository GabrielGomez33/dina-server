#!/usr/bin/env bash
# ============================================================================
# saga-edit.sh — img2img EDIT one image toward a prompt (single-concern primitive)
# ----------------------------------------------------------------------------
# The reusable "edit, don't redraw" building block: re-render an existing image
# toward a NEW prompt at a given denoise, preserving the source structure. This is
# the ONE place the img2img-edit graph lives — driven by saga-chain (keyframe
# chaining), saga-jutsu-flf (anchor keyframes), and the Phase-5 front-end per-frame
# cleanup. Output name is deterministic and clean (no denoise tag): tmp/<out>.png.
#
#   saga-edit.sh --image SRC --prompt "full positive prompt"
#      [--denoise 0.6] [--lora F --lora-weight 1.0] [--cfg 2.0] [--seed 777]
#      [-W N -H N] [-n NEG] [-o NAME]
#      [-c REF --control-strength 0.85 --control-pre canny --union-type T]
#
# Optional ControlNet: -c/--control REF forces structure (e.g. a hand-sign pose) from a
# reference image via canny → Union Promax, while denoise still edits toward the source.
# Env: EDIT_CN=controlnet-union-sdxl-promax.safetensors
#
# NOTE: --prompt is the COMPLETE positive (caller assembles identity/trigger/style);
# this primitive does not editorialize it. No trigger auto-prepend.
# Env: SAGA_ROOT (required)  COMFY=http://127.0.0.1:8188  EDIT_CKPT=animagine-xl-4.0.safetensors
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
CKPT="${EDIT_CKPT:-animagine-xl-4.0.safetensors}"
CN="${EDIT_CN:-controlnet-union-sdxl-promax.safetensors}"

IMG=""; PROMPT=""; DENOISE=0.6; LORA=""; LORAW=1.0; CFG=2.0; SEED=777; W=0; H=0; OUT="saga_edit"
# optional ControlNet: force structure from a reference while editing (canny → Union Promax)
CONTROL=""; CPRE="canny"; CSTR=0.85; CEND=0.9; UTYPE="canny/lineart/anime_lineart/mlsd"
NEG="lowres, worst quality, blurry, deformed, bad anatomy, bad hands, extra fingers, fused fingers, mutated hands, extra limbs, text, watermark"
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --image) IMG="$2"; shift 2;; -p|--prompt) PROMPT="$2"; shift 2;;
  --denoise) DENOISE="$2"; shift 2;; --lora) LORA="$2"; shift 2;; --lora-weight) LORAW="$2"; shift 2;;
  --cfg) CFG="$2"; shift 2;; -s|--seed) SEED="$2"; shift 2;;
  -W|--width) W="$2"; shift 2;; -H|--height) H="$2"; shift 2;;
  -c|--control) CONTROL="$2"; shift 2;; --control-pre) CPRE="$2"; shift 2;;
  --control-strength) CSTR="$2"; shift 2;; --control-end) CEND="$2"; shift 2;; --union-type) UTYPE="$2"; shift 2;;
  -n|--neg) NEG="$2"; shift 2;; -o|--out) OUT="$2"; shift 2;;
  -h|--help) sed -n '2,20p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
# --- input validation (fail fast, clear messages) ---------------------------
[ -n "$IMG" ] && [ -f "$IMG" ] || die "need --image <existing png>"
[ -n "$PROMPT" ] || die "need --prompt <full positive prompt>"
command -v jq >/dev/null || die "jq required"; command -v curl >/dev/null || die "curl required"
case "$DENOISE" in ''|*[!0-9.]*) die "--denoise must be a number (got '$DENOISE')";; esac
awk -v d="$DENOISE" 'BEGIN{exit !(d>0 && d<=1)}' || die "--denoise must be in (0,1] (got $DENOISE)"
[ -z "$LORA" ] || [ -f "$SAGA_ROOT/models/loras/$LORA" ] || die "LoRA not found: models/loras/$LORA"
if [ -n "$CONTROL" ]; then
  [ -f "$CONTROL" ] || die "--control image not found: $CONTROL"
  find "$SAGA_ROOT/models" -name "$CN" -print -quit 2>/dev/null | grep -q . || die "ControlNet model not found under models/: $CN (set EDIT_CN=)"
fi
curl -sf "$COMFY/system_stats" >/dev/null 2>&1 || die "ComfyUI not reachable at $COMFY (sudo pm2 restart saga-comfyui?)"

CID="sagaedit-$$-$RANDOM"
upload(){ curl -sf -F "image=@${1}" -F "overwrite=true" "$COMFY/upload/image" | jq -r '.name' || die "upload failed: $1"; }
submit(){ local resp id; resp=$(curl -s -X POST "$COMFY/prompt" --data "$(jq -nc --slurpfile g "$1" --arg c "$CID" '{prompt:$g[0], client_id:$c}')"); id=$(jq -r '.prompt_id // empty' <<<"$resp" 2>/dev/null); [ -n "$id" ] && { echo "$id"; return 0; }; jq -rc '.error // .node_errors // .' <<<"$resp" 2>/dev/null | head -c 600 | sed 's/^/  ⤷ ComfyUI: /' >&2; echo >&2; die "submit rejected"; }
wait_done(){ local id="$1" t=0 h st; while :; do h=$(curl -sf "$COMFY/history/$id"); if [ "$(jq -r --arg i "$id" 'has($i)' <<<"$h")" = "true" ]; then st=$(jq -r --arg i "$id" '.[$i].status.status_str // "ok"' <<<"$h"); if [ "$st" = "error" ]; then jq -r --arg i "$id" '.[$i].status.messages[]? | select(.[0]=="execution_error") | .[1] | "  ⤷ node \(.node_id) (\(.node_type)): \(.exception_type): \(.exception_message)"' <<<"$h" >&2; die "execution error for $id"; fi; echo "$h"; return 0; fi; t=$((t+3)); [ "$t" -gt 900 ] && die "timeout for $id"; sleep 3; done; }
fetch_first(){ local h="$1" id="$2" dest="$3" line fn sf ty code base sub src; line=$(jq -r --arg i "$id" '.[$i].outputs[] | ((.images // [])[0]) | select(.!=null) | "\(.filename)\t\(.subfolder)\t\(.type)"' <<<"$h" | head -n1); [ -n "$line" ] || die "no output for $id"; IFS=$'\t' read -r fn sf ty <<<"$line"; code=$(curl -s -o "$dest" -w '%{http_code}' "$COMFY/view?filename=$(jq -rn --arg s "$fn" '$s|@uri')&subfolder=$(jq -rn --arg s "$sf" '$s|@uri')&type=${ty:-output}"); { [ "$code" = "200" ] && [ -s "$dest" ]; } && return 0; for base in "${COMFY_OUT:-}" "$SAGA_ROOT/engine/ComfyUI/output"; do [ -n "$base" ] || continue; sub="$base${sf:+/$sf}"; [ -f "$sub/$fn" ] && { cp -f "$sub/$fn" "$dest"; return 0; }; done; src=$(find "$SAGA_ROOT/engine" -name "$fn" -print -quit 2>/dev/null); [ -n "$src" ] && { cp -f "$src" "$dest"; return 0; }; die "could not retrieve $fn (http=$code)"; }

IMG_NAME=$(upload "$IMG")
# optional resize to W×H (keeps a chain/keyframe sequence uniform); else source size
if [ "$W" -gt 0 ] && [ "$H" -gt 0 ]; then
  SRC='["3",0]'; SCALE=" \"3\":{\"class_type\":\"ImageScale\",\"inputs\":{\"image\":[\"2\",0],\"upscale_method\":\"lanczos\",\"width\":$W,\"height\":$H,\"crop\":\"disabled\"}},"
else SRC='["2",0]'; SCALE=""; fi
if [ -n "$LORA" ]; then MODEL='["40",0]'; CLIP='["40",1]'; else MODEL='["1",0]'; CLIP='["1",1]'; fi

# optional ControlNet: force structure from a reference image while editing. Positive/
# negative are routed through ControlNetApplyAdvanced (nodes 20-24), else straight from
# the CLIP encoders. Mirrors saga-keyframe's control subgraph so both paths behave identically.
CTRL_NAME=""; KPOS='["5",0]'; KNEG='["6",0]'; CANNY_NODE=""; UNION_NODE=""
if [ -n "$CONTROL" ]; then
  CTRL_NAME=$(upload "$CONTROL")
  case "$CPRE" in
    none) PRE_SRC='["20",0]';;
    *)    PRE_SRC='["21",0]'; CANNY_NODE="\"21\":{\"class_type\":\"Canny\",\"inputs\":{\"image\":[\"20\",0],\"low_threshold\":0.2,\"high_threshold\":0.5}},";;
  esac
  if [ "$UTYPE" = "none" ]; then CNSRC='["22",0]'; else CNSRC='["24",0]'; UNION_NODE="\"24\":{\"class_type\":\"SetUnionControlNetType\",\"inputs\":{\"control_net\":[\"22\",0],\"type\":\"$UTYPE\"}},"; fi
  KPOS='["23",0]'; KNEG='["23",1]'
fi

G=$(mktemp)
{
cat <<JSON
{
 "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"$CKPT"}},
JSON
[ -n "$LORA" ] && cat <<JSON
 "40":{"class_type":"LoraLoader","inputs":{"model":["1",0],"clip":["1",1],"lora_name":"$LORA","strength_model":$LORAW,"strength_clip":$LORAW}},
JSON
cat <<JSON
 "2":{"class_type":"LoadImage","inputs":{"image":"$IMG_NAME"}},$SCALE
 "4":{"class_type":"VAEEncode","inputs":{"pixels":$SRC,"vae":["1",2]}},
 "5":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$PROMPT" '$s'),"clip":$CLIP}},
 "6":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$NEG" '$s'),"clip":$CLIP}},
JSON
[ -n "$CONTROL" ] && cat <<JSON
 "20":{"class_type":"LoadImage","inputs":{"image":"$CTRL_NAME"}},
 $CANNY_NODE
 "22":{"class_type":"ControlNetLoader","inputs":{"control_net_name":"$CN"}},
 $UNION_NODE
 "23":{"class_type":"ControlNetApplyAdvanced","inputs":{"positive":["5",0],"negative":["6",0],"control_net":$CNSRC,"image":$PRE_SRC,"strength":$CSTR,"start_percent":0.0,"end_percent":$CEND,"vae":["1",2]}},
JSON
cat <<JSON
 "7":{"class_type":"KSampler","inputs":{"seed":$SEED,"steps":30,"cfg":$CFG,"sampler_name":"dpmpp_2m","scheduler":"karras","denoise":$DENOISE,"model":$MODEL,"positive":$KPOS,"negative":$KNEG,"latent_image":["4",0]}},
 "8":{"class_type":"VAEDecode","inputs":{"samples":["7",0],"vae":["1",2]}},
 "9":{"class_type":"SaveImage","inputs":{"filename_prefix":"$OUT","images":["8",0]}}
}
JSON
} > "$G"
jq -e . "$G" >/dev/null || die "internal: invalid edit graph"
echo "▶ edit: $(basename "$IMG") → $OUT  denoise=$DENOISE  lora=${LORA:-none}@$LORAW${CONTROL:+  ctrl=$(basename "$CONTROL")@$CSTR}"
PID=$(submit "$G"); HIST=$(wait_done "$PID")
fetch_first "$HIST" "$PID" "$SAGA_ROOT/tmp/${OUT}.png"; rm -f "$G"
echo "  ✅ $SAGA_ROOT/tmp/${OUT}.png"
