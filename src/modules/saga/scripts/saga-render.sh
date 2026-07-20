#!/usr/bin/env bash
# ============================================================================
# saga-render.sh — polished character render (A–Z orchestrator, stills)
# ----------------------------------------------------------------------------
# The still analogue of saga-jutsu-flf.sh: takes a trained character LoRA and
# produces finished 2K shots through every quality gate, with preflight, per-step
# verification, a timestamped LOG, and idempotent resume (--force to redo).
# Drives saga-keyframe.sh + saga-detail.sh + saga-upscale.sh (each single-concern).
#
#   STEP 0  preflight  — tools, engine, nodes, models (base/LoRA/ESRGAN/YOLO), scripts
#   STEP 1  generate   — base shots from the LoRA (portrait / full body / hand seal)
#   STEP 2  face detail — crop+re-render each face at full res (fixes far faces)
#   STEP 3  hand detail — crop+re-render hands (fixes fingers/seals)
#   STEP 4  upscale     — 4x-AnimeSharp → 2K (the "smooth it out at the end" step)
#   STEP 5  report      — verify finals, sizes, optional contact sheet
#
# Usage:
#   LORA=animegabriel.safetensors TRIGGER=animegabriel ./saga-render.sh
#   (SHOTS="name|prompt;name|prompt" overrides the default 3 shots)
# Flags:
#   --check      run STEP 0 preflight only, then exit
#   --force      regenerate artifacts even if they already exist
#   --no-detail  skip face+hand detail (STEP 2-3)
#   --no-upscale skip STEP 4
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
COMFY="${COMFY:-http://127.0.0.1:8188}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KF="$HERE/saga-keyframe.sh"; DTL="$HERE/saga-detail.sh"; UPS="$HERE/saga-upscale.sh"

# ── CONFIG (env-overridable) ────────────────────────────────────────────────
LORA="${LORA:-animegabriel.safetensors}"
TRIGGER="${TRIGGER:-animegabriel}"
LORAW="${LORAW:-0.85}"
SEED="${SEED:-777}"; W="${W:-1024}"; H="${H:-1024}"
PFX="${PFX:-render_${TRIGGER}}"
UPSCALE_MAX="${UPSCALE_MAX:-2048}"
BASE_CKPT="${BASE_CKPT:-animagine-xl-4.0.safetensors}"
ESRGAN="${UPSCALE_MODEL:-4x-AnimeSharp.pth}"
BASE_STYLE="${BASE_STYLE:-solo, 1man, cel shaded anime, 2d, flat colors, detailed anime, soft lighting, masterpiece, best quality}"
# default 3 canonical proof shots: "name|prompt" pairs, ';'-separated
SHOTS="${SHOTS:-portrait|upper body portrait, looking at viewer, neutral expression, plain background;fullbody|full body, standing, confident dynamic pose, plain background;handseal|both hands forming a ninja hand seal, fingers interlocked, close-up on hands}"

FORCE=0; DETAIL=1; UPSCALE=1; CHECK_ONLY=0
while [ $# -gt 0 ]; do case "$1" in
  --check) CHECK_ONLY=1; shift;; --force) FORCE=1; shift;;
  --no-detail) DETAIL=0; shift;; --no-upscale) UPSCALE=0; shift;;
  -h|--help) sed -n '2,33p' "$0"; exit 0;;
  *) echo "unknown arg: $1"; exit 2;;
esac; done

WORK="$SAGA_ROOT/tmp/render"; mkdir -p "$WORK"
LOG="$WORK/run_$(date +%Y%m%d_%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
T0=$(date +%s)
log(){ echo "[$(date +%H:%M:%S)] $*"; }
step(){ echo; echo "════════════ STEP $1 — $2 ════════════"; }
fail(){ echo; echo "❌ FAIL (step ${CUR:-?}): $*" >&2; echo "   log: $LOG" >&2; exit 1; }
have_file(){ [ -s "$1" ]; }
verify_out(){ have_file "$1" || fail "expected output missing/empty: $1"; log "  ✓ $(basename "$1") ($(stat -c%s "$1" 2>/dev/null || echo 0) bytes)"; }

# parse shots into parallel arrays
declare -a SNAME SPROMPT
OLDIFS="$IFS"; IFS=';'
for pair in $SHOTS; do
  [ -n "$pair" ] || continue
  nm="${pair%%|*}"; pr="${pair#*|}"
  SNAME+=("$(echo "$nm" | sed -E 's/[^a-zA-Z0-9]+/_/g; s/^_+|_+$//g')"); SPROMPT+=("$pr")
done
IFS="$OLDIFS"
[ "${#SNAME[@]}" -gt 0 ] || fail "no shots parsed from SHOTS"

echo "════════════════════════════════════════════════════"
echo " SAGA — CHARACTER RENDER  lora=$LORA trigger=$TRIGGER  ${#SNAME[@]} shots  seed=$SEED ${W}x${H}→${UPSCALE_MAX}px"
echo " log: $LOG"
echo "════════════════════════════════════════════════════"

# ── STEP 0 — PREFLIGHT ──────────────────────────────────────────────────────
CUR=0; step 0 "preflight checks"
for t in jq curl; do command -v "$t" >/dev/null || fail "missing tool: $t"; done
command -v identify >/dev/null || log "  ⚠ imagemagick 'identify' absent — upscale delivers raw 4x (no 2K cap); no contact sheet"
for s in "$KF" "$DTL" "$UPS"; do [ -f "$s" ] || fail "missing sub-script: $s"; [ -x "$s" ] || fail "not executable: $s (chmod +x)"; done
log "tools + sub-scripts ok"

curl -sf "$COMFY/system_stats" >/dev/null || fail "ComfyUI not reachable at $COMFY (is saga-comfyui up?)"
log "engine reachable at $COMFY"

OI=$(mktemp); curl -sf "$COMFY/object_info" -o "$OI" || fail "cannot fetch /object_info"
KEYS=$(jq -r 'keys[]' "$OI"); rm -f "$OI"
need_node(){ grep -qx "$1" <<<"$KEYS" || fail "required ComfyUI node MISSING: $1"; }
NODES="CheckpointLoaderSimple LoraLoader CLIPTextEncode EmptyLatentImage KSampler VAEDecode SaveImage LoadImage"
[ "$DETAIL" -eq 1 ]  && NODES="$NODES FaceDetailer UltralyticsDetectorProvider"
[ "$UPSCALE" -eq 1 ] && NODES="$NODES UpscaleModelLoader ImageUpscaleWithModel ImageScale"
for n in $NODES; do need_node "$n"; done
log "nodes ok"

have_model(){ find "$SAGA_ROOT/models" -name "$1" -print -quit 2>/dev/null | grep -q .; }
have_model "$BASE_CKPT" || fail "base checkpoint missing under models/: $BASE_CKPT"
[ -f "$SAGA_ROOT/models/loras/$LORA" ] || fail "LoRA not found: models/loras/$LORA (train it: saga-lora-train.sh)"
if [ "$DETAIL" -eq 1 ]; then
  for d in face_yolov8m.pt hand_yolov8s.pt; do have_model "$d" || fail "YOLO detector missing under models/: $d (needed for --detail)"; done
fi
[ "$UPSCALE" -eq 1 ] && { have_model "$ESRGAN" || fail "upscale model missing under models/: $ESRGAN (--no-upscale to skip)"; }
log "models ok (base=$BASE_CKPT, lora=$LORA${UPSCALE:+, esrgan=$ESRGAN})"
echo "✅ preflight passed"
[ "$CHECK_ONLY" -eq 1 ] && { echo "(--check) done."; exit 0; }

reuse(){ [ "$FORCE" -eq 0 ] && have_file "$1"; }

# ── STEP 1 — GENERATE ───────────────────────────────────────────────────────
CUR=1; step 1 "generate base shots from the LoRA"
for i in "${!SNAME[@]}"; do
  nm="${SNAME[$i]}"; pr="${SPROMPT[$i]}"; out="$SAGA_ROOT/tmp/${PFX}_${nm}.png"
  if reuse "$out"; then log "  reuse gen $nm"; else
    log "  gen $nm"
    "$KF" -o "${PFX}_${nm}" -s "$SEED" -W "$W" -H "$H" --lora "$LORA" --lora-weight "$LORAW" --trigger "$TRIGGER" \
      -p "$BASE_STYLE, $pr" || fail "generate $nm failed"
  fi
  verify_out "$out"
done
echo "✅ ${#SNAME[@]} base shots ready"

# per-shot current artifact (advances through detail/upscale)
declare -a CURART
for i in "${!SNAME[@]}"; do CURART[$i]="$SAGA_ROOT/tmp/${PFX}_${SNAME[$i]}.png"; done

# ── STEP 2 — FACE DETAIL ────────────────────────────────────────────────────
if [ "$DETAIL" -eq 1 ]; then
  CUR=2; step 2 "face detail (full-res face on every shot)"
  for i in "${!SNAME[@]}"; do
    nm="${SNAME[$i]}"; src="${CURART[$i]}"; out="$SAGA_ROOT/tmp/${PFX}_${nm}_face.png"
    if reuse "$out"; then log "  reuse face $nm"; else
      log "  face-detail $nm"
      "$DTL" --image "$src" --detect face --lora "$LORA" --lora-weight "$LORAW" --trigger "$TRIGGER" \
        --prompt "cel shaded anime, detailed face" -o "${PFX}_${nm}_face" || fail "face detail $nm failed"
    fi
    verify_out "$out"; CURART[$i]="$out"
  done
  echo "✅ faces detailed"

  # ── STEP 3 — HAND DETAIL ──────────────────────────────────────────────────
  CUR=3; step 3 "hand detail (fingers/seals)"
  for i in "${!SNAME[@]}"; do
    nm="${SNAME[$i]}"; src="${CURART[$i]}"; out="$SAGA_ROOT/tmp/${PFX}_${nm}_dtl.png"
    if reuse "$out"; then log "  reuse hands $nm"; else
      log "  hand-detail $nm"
      "$DTL" --image "$src" --detect hands --lora "$LORA" --lora-weight "$LORAW" --trigger "$TRIGGER" \
        --prompt "cel shaded anime, detailed hands, correct fingers" -o "${PFX}_${nm}_dtl" || fail "hand detail $nm failed"
    fi
    verify_out "$out"; CURART[$i]="$out"
  done
  echo "✅ hands detailed"
else
  CUR=2; step 2 "detail"; log "(--no-detail) skipped STEP 2-3"
fi

# ── STEP 4 — UPSCALE ────────────────────────────────────────────────────────
if [ "$UPSCALE" -eq 1 ]; then
  CUR=4; step 4 "upscale → ${UPSCALE_MAX}px (4x-AnimeSharp)"
  for i in "${!SNAME[@]}"; do
    nm="${SNAME[$i]}"; src="${CURART[$i]}"; out="$SAGA_ROOT/tmp/${PFX}_${nm}_2k.png"
    if reuse "$out"; then log "  reuse upscale $nm"; else
      log "  upscale $nm"
      "$UPS" --image "$src" --model "$ESRGAN" --max "$UPSCALE_MAX" -o "${PFX}_${nm}_2k" || fail "upscale $nm failed"
    fi
    verify_out "$out"; CURART[$i]="$out"
  done
  echo "✅ upscaled to ${UPSCALE_MAX}px"
else
  CUR=4; step 4 "upscale"; log "(--no-upscale) skipped"
fi

# ── STEP 5 — REPORT ─────────────────────────────────────────────────────────
CUR=5; step 5 "report"
echo "final artifacts:"
declare -a FINALS
for i in "${!SNAME[@]}"; do
  f="${CURART[$i]}"; FINALS+=("$f")
  dim="?x?"; command -v identify >/dev/null && dim=$(identify -format "%wx%h" "$f[0]" 2>/dev/null || echo "?x?")
  printf "  %-12s %s  (%s, %s bytes)\n" "${SNAME[$i]}" "$f" "$dim" "$(stat -c%s "$f" 2>/dev/null || echo 0)"
done
CONTACT=""
if command -v montage >/dev/null 2>&1; then
  CONTACT="$SAGA_ROOT/tmp/${PFX}_contact.png"
  montage "${FINALS[@]}" -tile "${#FINALS[@]}x1" -geometry 512x512+6+6 -background '#111' "$CONTACT" 2>/dev/null \
    && log "contact sheet → $CONTACT" || CONTACT=""
fi

DT=$(( $(date +%s) - T0 ))
echo
echo "════════════════════════════════════════════════════"
echo " ✅ DONE in ${DT}s — ${#SNAME[@]} finished shots${CONTACT:+; review $CONTACT}"
echo " log: $LOG"
echo "════════════════════════════════════════════════════"
