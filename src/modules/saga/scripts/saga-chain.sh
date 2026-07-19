#!/usr/bin/env bash
# ============================================================================
# saga-chain.sh — keyframe-as-EDIT chain (consistency via "edit, don't redraw")
# ----------------------------------------------------------------------------
# The consistency fix borrowed from Nano Banana / video "content anchors": instead
# of generating each keyframe independently (they drift → jump-cuts), we generate
# frame 1 from the LoRA, then make EACH next frame an img2img EDIT of the PREVIOUS
# frame at low denoise — changing only the pose while inheriting the exact
# character, lighting, background and framing. The result is one continuous shot.
#
#   saga-chain.sh --lora F --trigger T [--denoise 0.5] [--reanchor 0]
#      [--poses "p1;p2;...;pN"] [--cfg 2.0] [--lora-weight 2.0] [--style "..."]
#      [--seed 777] [-W 1280] [-H 704] [-o PREFIX] [--fps 4]
#
#   --reanchor N : every Nth frame edits FRAME 1 instead of the previous frame
#                  (caps drift accumulation). 0 = pure chain.
#
# Drives saga-keyframe.sh for frame 1; does the img2img edits inline (one engine,
# clean sequential frame names). Assembles a low-fps preview so you can SEE the flow.
# Env: SAGA_ROOT (required)  COMFY=http://127.0.0.1:8188  ANIME_CKPT=animagine-xl-4.0.safetensors
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
CKPT="${ANIME_CKPT:-animagine-xl-4.0.safetensors}"
HERE="$(cd "$(dirname "$0")" && pwd)"; KF="$HERE/saga-keyframe.sh"

LORA=""; TRIGGER=""; LORAW=2.0; DENOISE=0.5; REANCHOR=0; CFG=2.0; SEED=777; W=1280; H=704; PFX="chain"; FPS=4
STYLE="${STYLE:-retro 1990s anime, cel animation, rough sketchy linework, grainy, muted desaturated colors, hand-drawn, flat colors, 2d}"
OUTFIT="wearing a plain white short-sleeve shirt"; EYES="brown eyes"
NEG="lowres, worst quality, blurry, deformed, bad anatomy, bad hands, extra fingers, fused fingers, mutated hands, extra limbs, boar, dragon, ram, serpent, tiger, animal, creature, mask, hood, blue eyes, glowing eyes, 1girl, woman, text, watermark"
# 10-beat smooth progression (small increments chain best). Override with --poses.
POSES="both hands relaxed, calm;both hands rising in front of the body;both hands at chest height, palms facing;both hands close together at chest, fingers apart;both hands fingertips touching;both hands pressed together, fingers interlocked, ninja hand seal;both hands pressed flat together in prayer position at center;hands pressed together, faint glow between the palms;hands slightly apart, small swirling energy orb forming between the palms;hands cupping a glowing swirling energy orb"
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --lora) LORA="$2"; shift 2;; --trigger) TRIGGER="$2"; shift 2;; --lora-weight) LORAW="$2"; shift 2;;
  --denoise) DENOISE="$2"; shift 2;; --reanchor) REANCHOR="$2"; shift 2;; --cfg) CFG="$2"; shift 2;;
  --poses) POSES="$2"; shift 2;; --style) STYLE="$2"; shift 2;; -n|--neg) NEG="$2"; shift 2;;
  --seed) SEED="$2"; shift 2;; -W|--width) W="$2"; shift 2;; -H|--height) H="$2"; shift 2;;
  -o|--out) PFX="$2"; shift 2;; --fps) FPS="$2"; shift 2;;
  -h|--help) sed -n '2,24p' "$0"; exit 0;;
  *) die "unknown arg: $1";;
esac; done
[ -n "$LORA" ] || die "need --lora <file in models/loras>"
[ -n "$TRIGGER" ] || die "need --trigger <token>"
command -v jq >/dev/null || die "jq required"; command -v ffmpeg >/dev/null || die "ffmpeg required"
[ -f "$SAGA_ROOT/models/loras/$LORA" ] || die "LoRA not found: models/loras/$LORA"
[ -x "$KF" ] || die "not executable: $KF"
curl -sf "$COMFY/system_stats" >/dev/null 2>&1 || die "ComfyUI not reachable at $COMFY — start it: sudo pm2 restart saga-comfyui (wait ~15s)"

# shared consistency prefix on EVERY frame (identity/outfit/eyes/style pinned)
BASE="solo, 1man, $TRIGGER, $OUTFIT, $EYES, $STYLE, medium shot, centered composition, consistent framing, eye level, dark background, dramatic lighting"

CID="sagachain-$$-$RANDOM"
upload(){ curl -sf -F "image=@${1}" -F "overwrite=true" "$COMFY/upload/image" | jq -r '.name' || die "upload failed: $1"; }
submit(){ curl -sf -X POST "$COMFY/prompt" --data "$(jq -nc --slurpfile g "$1" --arg c "$CID" '{prompt:$g[0], client_id:$c}')" | jq -r '.prompt_id' || die "submit rejected"; }
wait_done(){ local id="$1" t=0 h st; while :; do h=$(curl -sf "$COMFY/history/$id"); if [ "$(jq -r --arg i "$id" 'has($i)' <<<"$h")" = "true" ]; then st=$(jq -r --arg i "$id" '.[$i].status.status_str // "ok"' <<<"$h"); if [ "$st" = "error" ]; then jq -r --arg i "$id" '.[$i].status.messages[]? | select(.[0]=="execution_error") | .[1] | "  ⤷ \(.node_type): \(.exception_message)"' <<<"$h" >&2; die "execution error for $id"; fi; echo "$h"; return 0; fi; t=$((t+3)); [ "$t" -gt 900 ] && die "timeout for $id"; sleep 3; done; }
fetch_first(){ local h="$1" id="$2" dest="$3" line fn sf ty code base sub src; line=$(jq -r --arg i "$id" '.[$i].outputs[] | ((.images // [])[0]) | select(.!=null) | "\(.filename)\t\(.subfolder)\t\(.type)"' <<<"$h" | head -n1); [ -n "$line" ] || die "no output for $id"; IFS=$'\t' read -r fn sf ty <<<"$line"; code=$(curl -s -o "$dest" -w '%{http_code}' "$COMFY/view?filename=$(jq -rn --arg s "$fn" '$s|@uri')&subfolder=$(jq -rn --arg s "$sf" '$s|@uri')&type=${ty:-output}"); { [ "$code" = "200" ] && [ -s "$dest" ]; } && return 0; for base in "${COMFY_OUT:-}" "$SAGA_ROOT/engine/ComfyUI/output"; do [ -n "$base" ] || continue; sub="$base${sf:+/$sf}"; [ -f "$sub/$fn" ] && { cp -f "$sub/$fn" "$dest"; return 0; }; done; src=$(find "$SAGA_ROOT/engine" -name "$fn" -print -quit 2>/dev/null); [ -n "$src" ] && { cp -f "$src" "$dest"; return 0; }; die "could not retrieve $fn (http=$code)"; }

# img2img EDIT: re-render <src> toward <pose> at DENOISE, keeping LoRA identity/style
edit(){ # <src.png> <pose> <dest.png>
  local src="$1" pose="$2" dest="$3" name G pid hist; name=$(upload "$src")
  local POS="$BASE, $pose"
  G=$(mktemp)
  cat > "$G" <<JSON
{
 "1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"$CKPT"}},
 "40":{"class_type":"LoraLoader","inputs":{"model":["1",0],"clip":["1",1],"lora_name":"$LORA","strength_model":$LORAW,"strength_clip":$LORAW}},
 "2":{"class_type":"LoadImage","inputs":{"image":"$name"}},
 "4":{"class_type":"VAEEncode","inputs":{"pixels":["2",0],"vae":["1",2]}},
 "5":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$POS" '$s'),"clip":["40",1]}},
 "6":{"class_type":"CLIPTextEncode","inputs":{"text":$(jq -Rn --arg s "$NEG" '$s'),"clip":["40",1]}},
 "7":{"class_type":"KSampler","inputs":{"seed":$SEED,"steps":30,"cfg":$CFG,"sampler_name":"dpmpp_2m","scheduler":"karras","denoise":$DENOISE,"model":["40",0],"positive":["5",0],"negative":["6",0],"latent_image":["4",0]}},
 "8":{"class_type":"VAEDecode","inputs":{"samples":["7",0],"vae":["1",2]}},
 "9":{"class_type":"SaveImage","inputs":{"filename_prefix":"chainedit","images":["8",0]}}
}
JSON
  jq -e . "$G" >/dev/null || die "internal: invalid edit graph"
  pid=$(submit "$G"); hist=$(wait_done "$pid"); fetch_first "$hist" "$pid" "$dest"; rm -f "$G"
}

IFS=';' read -ra P <<<"$POSES"
N=${#P[@]}
echo "▶ chain: lora=$LORA@$LORAW  denoise=$DENOISE  reanchor=$REANCHOR  frames=$N  ${W}x${H}"
mkdir -p "$SAGA_ROOT/tmp"

# frame 1 — generated from the LoRA (the anchor)
F1="$SAGA_ROOT/tmp/${PFX}_01.png"
echo "  [01] anchor (txt2img): ${P[0]}"
"$KF" -o "${PFX}_01" -s "$SEED" -W "$W" -H "$H" --lora "$LORA" --lora-weight "$LORAW" --trigger "$TRIGGER" ${CFG:+--cfg "$CFG"} -n "$NEG" -p "$BASE, ${P[0]}" || die "frame 1 failed"
[ -s "$F1" ] || die "frame 1 missing"

# frames 2..N — each an EDIT of the previous (or of frame 1 when re-anchoring)
prev="$F1"
for ((i=2;i<=N;i++)); do
  idx=$(printf '%02d' "$i"); dest="$SAGA_ROOT/tmp/${PFX}_${idx}.png"; pose="${P[$((i-1))]}"
  src="$prev"; tag="edit(prev)"
  if [ "$REANCHOR" -gt 0 ] && [ $(( (i-1) % REANCHOR )) -eq 0 ]; then src="$F1"; tag="edit(anchor)"; fi
  echo "  [$idx] $tag: $pose"
  edit "$src" "$pose" "$dest"
  [ -s "$dest" ] || die "frame $idx missing"
  prev="$dest"
done

# preview: the frame sequence as a low-fps clip so continuity is visible as motion
PREVIEW="$SAGA_ROOT/tmp/${PFX}_preview.mp4"
ffmpeg -y -framerate "$FPS" -i "$SAGA_ROOT/tmp/${PFX}_%02d.png" -c:v libx264 -pix_fmt yuv420p -crf 16 "$PREVIEW" >/dev/null 2>&1 \
  && echo "  ▶ preview → $PREVIEW (${FPS}fps)" || echo "  ⚠ preview assembly skipped"
echo "✅ chain: $N frames → $SAGA_ROOT/tmp/${PFX}_01..${idx}.png"
echo "   Judge: do all frames read as ONE continuous shot (same character/light/framing)?"
echo "   Tune: --denoise up = bigger pose change per frame but more drift; --reanchor 3 caps drift."
