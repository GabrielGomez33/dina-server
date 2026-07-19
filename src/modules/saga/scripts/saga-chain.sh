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
# Drives saga-keyframe.sh for frame 1 and saga-edit.sh for each img2img edit (the
# edit graph lives in ONE place — DRY). Assembles a low-fps preview to SEE the flow.
# Env: SAGA_ROOT (required)  COMFY=http://127.0.0.1:8188  ANIME_CKPT=animagine-xl-4.0.safetensors
# ============================================================================
set -uo pipefail
COMFY="${COMFY:-http://127.0.0.1:8188}"
: "${SAGA_ROOT:?set SAGA_ROOT}"
CKPT="${ANIME_CKPT:-animagine-xl-4.0.safetensors}"
HERE="$(cd "$(dirname "$0")" && pwd)"; KF="$HERE/saga-keyframe.sh"; GRADE_SH="$HERE/saga-grade.sh"; EDIT="$HERE/saga-edit.sh"

LORA=""; TRIGGER=""; LORAW=2.0; DENOISE=0.45; REANCHOR=3; CFG=2.0; SEED=777; W=1280; H=704; PFX="chain"; FPS=4
# CLEAN style for the generation loop. NEVER put grain/rough tags here — in an
# img2img chain they RE-APPLY every frame and snowball into noise. Apply the Lain
# roughness ONCE in post: saga-grade.sh --preset lain-bloom <preview>.
STYLE="${STYLE:-anime, cel shading, clean lineart, flat colors, soft lighting, detailed anime}"
OUTFIT="${OUTFIT:-wearing a plain white short-sleeve shirt}"; EYES="${EYES:-brown eyes}"
GROOMING="${GROOMING:-buzz cut, very short hair, short trimmed beard}"   # pinned so hair/beard stay consistent
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
[ -x "$EDIT" ] || die "not executable: $EDIT (the img2img-edit primitive)"
curl -sf "$COMFY/system_stats" >/dev/null 2>&1 || die "ComfyUI not reachable at $COMFY — start it: sudo pm2 restart saga-comfyui (wait ~15s)"
# saga-edit re-renders each frame with this checkpoint; keep chain's ANIME_CKPT authoritative.
export EDIT_CKPT="$CKPT"

# shared consistency prefix on EVERY frame (identity/outfit/eyes/style pinned)
BASE="solo, 1man, $TRIGGER, $GROOMING, $OUTFIT, $EYES, $STYLE, medium shot, centered composition, consistent framing, eye level, dark background, dramatic lighting"

# img2img EDIT via the shared primitive: re-render <src> toward <pose> at DENOISE,
# keeping LoRA identity/style. The graph + engine plumbing live in saga-edit.sh only.
edit(){ # <src.png> <pose> <out-name>  → writes $SAGA_ROOT/tmp/<out-name>.png
  local src="$1" pose="$2" name="$3"
  "$EDIT" --image "$src" --prompt "$BASE, $pose" --denoise "$DENOISE" \
    --lora "$LORA" --lora-weight "$LORAW" --cfg "$CFG" -s "$SEED" \
    -W "$W" -H "$H" -n "$NEG" -o "$name" >/dev/null || die "edit $name failed"
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
  edit "$src" "$pose" "${PFX}_${idx}"
  [ -s "$dest" ] || die "frame $idx missing"
  prev="$dest"
done

# preview: the frame sequence as a low-fps clip so continuity is visible as motion
PREVIEW="$SAGA_ROOT/tmp/${PFX}_preview.mp4"
ffmpeg -y -framerate "$FPS" -i "$SAGA_ROOT/tmp/${PFX}_%02d.png" -c:v libx264 -pix_fmt yuv420p -crf 16 "$PREVIEW" >/dev/null 2>&1 \
  && echo "  ▶ preview → $PREVIEW (${FPS}fps)" || echo "  ⚠ preview assembly skipped"
# apply the Lain roughness ONCE, in post (never in the generation loop)
if [ -x "$GRADE_SH" ] && [ -s "$PREVIEW" ]; then
  "$GRADE_SH" "$PREVIEW" --preset lain-bloom -o "$SAGA_ROOT/tmp/${PFX}_preview_lain.mp4" >/dev/null 2>&1 \
    && echo "  ▶ graded → $SAGA_ROOT/tmp/${PFX}_preview_lain.mp4 (lain-bloom, applied once in post)"
fi
echo "✅ chain: $N frames → $SAGA_ROOT/tmp/${PFX}_01..${idx}.png"
echo "   Judge: do all frames read as ONE continuous shot (same character/light/framing)?"
echo "   Tune: --denoise up = bigger pose change per frame but more drift; --reanchor 3 caps drift."
