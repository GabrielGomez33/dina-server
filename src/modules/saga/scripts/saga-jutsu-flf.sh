#!/usr/bin/env bash
# ============================================================================
# saga-jutsu-flf.sh — the 20s jutsu, keyframe-directed (A–Z orchestrator)
# ----------------------------------------------------------------------------
# 5 seals → hands together (prayer) → on separation a purple rasengan orb grows,
# flowing with energy. 8 keyframes, 7 FLF transitions + 3 holds = 320 frames @
# 16fps = 20.0s exactly. Every FLF segment fits Wan's ~81-frame window.
#
# Runs the whole pipeline in numbered STEPS with preflight checks, per-step
# output verification, a timestamped LOG, and idempotent resume (existing
# artifacts are reused unless --force). Drives saga-keyframe.sh + saga-flf.sh.
#
#   STEP 0  preflight  — tools, engine, nodes, models, inputs
#   STEP 1  keyframes  — 8 pose stills, hands (and optionally face) detailed in place
#   STEP 2  motion     — 3 holds + 7 FLF transitions
#   STEP 3  assemble   — concat → 20s master
#   STEP 4  polish     — ESRGAN 2K upscale (4x-AnimeSharp) → frame interpolation
#
# Usage:
#   LORA=exodia.safetensors TRIGGER=exodia_saga ./saga-jutsu-flf.sh
#   (add USE_CONTROL=1 + SEAL1..SEAL5=... to force seal poses via ControlNet)
#   Identity source (keyframes):  IDENTITY=lora (default) | instantid
#     LoRA-only:   LORA=animegabriel.safetensors TRIGGER=animegabriel LORAW=1.6 CFG=2.0 ./saga-jutsu-flf.sh
#     InstantID:   IDENTITY=instantid FACE=/path/to/face.png LORA=animegabriel.safetensors TRIGGER=animegabriel ./saga-jutsu-flf.sh
#   CFG= sets the keyframe guidance (low = the soft look); IIDW/IIDE tune InstantID.
# Flags:
#   --check     run STEP 0 preflight only, then exit
#   --force     regenerate artifacts even if they already exist
#   --clean     delete THIS pipeline's prior artifacts (keyframes/segments/master/
#               polish) before running — frees disk + guarantees a fresh render.
#               Only touches jutsu_*/s0*/hold/master/2k/final; nothing else in tmp.
#   --no-polish skip STEP 4
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
COMFY="${COMFY:-http://127.0.0.1:8188}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KF="$HERE/saga-keyframe.sh"; FLF="$HERE/saga-flf.sh"; IIDKF="$HERE/saga-instantid-keyframe.sh"; DTL="$HERE/saga-detail.sh"; GRADE_SH="$HERE/saga-grade.sh"

# ── CONFIG (edit or pass via env) ───────────────────────────────────────────
# Identity now comes from the trained LoRA (no IP-Adapter pose-prior fighting the
# seals). Seal control is OPTIONAL (USE_CONTROL=1 + canny once wired); by default
# the LoRA + a descriptive seal prompt drives the pose.
LORA="${LORA:-exodia.safetensors}"
TRIGGER="${TRIGGER:-exodia_saga}"
LORAW="${LORAW:-0.85}"
CFG="${CFG:-}"                       # empty = keyframe default; set (e.g. 2.0) for the soft low-CFG identity look
IDENTITY="${IDENTITY:-lora}"         # lora | instantid  (instantid keyframes need FACE + InstantID installed)
FACE="${FACE:-}"                     # required when IDENTITY=instantid: a front-facing photo
IIDW="${IIDW:-0.8}"; IIDE="${IIDE:-0.9}"   # InstantID face weight / end (only used when IDENTITY=instantid)
DETAIL="${DETAIL:-hands}"           # none | hands | both — fix hands (and optionally face) on each keyframe BEFORE FLF
# PINNED across ALL keyframes for wardrobe continuity. Keep it SIMPLE and match
# what the LoRA already learned (e.g. the shirt in the training photos) — vague or
# exotic outfits ("high-collar", "gi", "armor") make the model invent a different
# costume per keyframe, and "high-collar" in particular reads as a face mask.
OUTFIT="${OUTFIT:-wearing a plain white short-sleeve shirt}"
POLISH_FPS="${POLISH_FPS:-32}"      # STEP 4 interpolation target fps
UPSCALE_MODE="${UPSCALE_MODE:-esrgan}"   # esrgan (crisp cel lines) | lanczos (soft/painterly — matches a low-CFG look)
EYES="${EYES:-brown eyes}"          # PINNED eye color across ALL keyframes (prevents eye-color drift)
# Visual style for keyframes — default leans rough/analog anime (Serial Experiments
# Lain-ish): grainy, muted, hand-drawn — counters the smooth "3D" render look.
STYLE="${STYLE:-retro 1990s anime, cel animation, rough sketchy linework, grainy, muted desaturated colors, film grain, hand-drawn, flat colors, 2d}"
GRADE="${GRADE:-lain}"              # none | grain | lain — post grade; also UNIFIES color across FLF segments (reduces visible seams)
INTERPOLATE="${INTERPOLATE:-0}"     # 1 = interpolate to POLISH_FPS. OFF by default: minterpolate ghosts fast motion (the trailing light-rays)
# Shared negative fed to EVERY keyframe AND the hand-fixer. Guards the recurring
# FAILURE CLASSES (not just this scene): hand mutations, seal-name animals bleeding
# into the background, wrong eye colors, mask/costume drift, wrong sex, text.
# Extend/override per scene or character via NEG=.  (Want the ghostly seal-spirit
# animals as an intentional effect? Drop the animal words from NEG and add them
# to a keyframe's prompt.)
NEG="${NEG:-lowres, worst quality, blurry, deformed, bad anatomy, bad hands, extra fingers, fused fingers, missing fingers, mutated hands, malformed hands, extra limbs, extra arms, boar, dragon, ram, serpent, tiger, snake, animal, creature, monster, mask, face covering, hood, helmet, blue eyes, green eyes, glowing eyes, heterochromia, watch, wristwatch, jewelry, bracelet, necklace, 1girl, woman, female, text, watermark, signature}"
USE_CONTROL="${USE_CONTROL:-0}"     # 1 = force seals via ControlNet from the crops below
SEAL1="${SEAL1:-$SAGA_ROOT/tmp/seal_tiger.png}"
SEAL2="${SEAL2:-$SAGA_ROOT/tmp/seal_serpent.png}"
SEAL3="${SEAL3:-$SAGA_ROOT/tmp/seal_dragon.png}"
SEAL4="${SEAL4:-$SAGA_ROOT/tmp/seal_ram.png}"
SEAL5="${SEAL5:-$SAGA_ROOT/tmp/seal_boar.png}"
SEED="${SEED:-777}"; W="${W:-1280}"; H="${H:-704}"; FPS="${FPS:-16}"

# confirmed installed filenames (audit 2026-07-18); saga-flf.sh reads these via env
export FLF_T5="${FLF_T5:-umt5_xxl_fp8_e4m3fn_scaled.safetensors}"

FORCE=0; POLISH=1; CHECK_ONLY=0; CLEAN=0
while [ $# -gt 0 ]; do case "$1" in
  --check) CHECK_ONLY=1; shift;; --force) FORCE=1; shift;;
  --clean) CLEAN=1; shift;;
  --no-polish) POLISH=0; shift;; -h|--help) sed -n '2,34p' "$0"; exit 0;;
  *) echo "unknown arg: $1"; exit 2;;
esac; done

WORK="$SAGA_ROOT/tmp/jutsu"; mkdir -p "$WORK"
LOG="$WORK/run_$(date +%Y%m%d_%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
T0=$(date +%s)

log(){ echo "[$(date +%H:%M:%S)] $*"; }
step(){ echo; echo "════════════ STEP $1 — $2 ════════════"; }
fail(){ echo; echo "❌ FAIL (step ${CUR:-?}): $*" >&2; echo "   log: $LOG" >&2; exit 1; }
have_file(){ [ -s "$1" ]; }
verify_out(){ have_file "$1" || fail "expected output missing/empty: $1"; log "  ✓ $(basename "$1") ($(stat -c%s "$1" 2>/dev/null || echo 0) bytes)"; }
frames_of(){ command -v ffprobe >/dev/null && ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$1" 2>/dev/null || echo "?"; }

# Identity is carried by the LoRA + trigger (prepended by saga-keyframe.sh);
# BASE is just style + scene so the trigger isn't diluted.
# Consistent framing/composition tags reduce inter-keyframe variance, so the FLF
# segments read as one continuous scene instead of jump-cuts.
BASE="solo, $OUTFIT, $EYES, $STYLE, medium shot, centered composition, consistent framing, eye level, dark background, embers, dramatic lighting"

echo "════════════════════════════════════════════════════"
echo " SAGA — 20s JUTSU (keyframe/FLF)   seed=$SEED  ${W}x${H}@${FPS}fps"
echo " log: $LOG"
echo "════════════════════════════════════════════════════"

# ── STEP 0 — PREFLIGHT ──────────────────────────────────────────────────────
CUR=0; step 0 "preflight checks"
for t in jq curl ffmpeg; do command -v "$t" >/dev/null || fail "missing tool: $t"; done
command -v ffprobe >/dev/null || log "  ⚠ ffprobe absent — frame-count checks will be skipped"
[ -x "$KF" ] || fail "not executable: $KF (chmod +x)"
[ -x "$FLF" ] || fail "not executable: $FLF (chmod +x)"
log "tools ok"

curl -sf "$COMFY/system_stats" >/dev/null || fail "ComfyUI not reachable at $COMFY (is saga-comfyui up?)"
log "engine reachable at $COMFY"

OI=$(mktemp); curl -sf "$COMFY/object_info" -o "$OI" || fail "cannot fetch /object_info"
KEYS=$(jq -r 'keys[]' "$OI"); rm -f "$OI"
need_node(){ grep -qx "$1" <<<"$KEYS" || fail "required ComfyUI node MISSING: $1"; }
NODES="CheckpointLoaderSimple LoraLoader UnetLoaderGGUF CLIPLoader WanFirstLastFrameToVideo VHS_VideoCombine"
[ "$USE_CONTROL" -eq 1 ] && NODES="$NODES ControlNetLoader ControlNetApplyAdvanced Canny"
[ "$USE_CONTROL" -eq 1 ] && [ "${UNION_TYPE:-canny/lineart/anime_lineart/mlsd}" != "none" ] && NODES="$NODES SetUnionControlNetType"
for n in $NODES; do need_node "$n"; done
log "nodes ok (incl. LoraLoader, WanFirstLastFrameToVideo)"

have_model(){ find "$SAGA_ROOT/models" -name "$1" -print -quit 2>/dev/null | grep -q .; }
for m in animagine-xl-4.0.safetensors \
         Wan2.2-I2V-A14B-HighNoise-Q6_K.gguf Wan2.2-I2V-A14B-LowNoise-Q6_K.gguf \
         "$FLF_T5" wan_2.1_vae.safetensors CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors; do
  have_model "$m" || fail "required model file MISSING under models/: $m"
done
[ -f "$SAGA_ROOT/models/loras/$LORA" ] || fail "LoRA not found: models/loras/$LORA (train it: saga-lora-train.sh)"
log "models ok (lora=$LORA, umt5=$FLF_T5)"

if [ "$IDENTITY" = "instantid" ]; then
  [ -x "$IIDKF" ] || fail "not executable: $IIDKF (chmod +x)"
  { [ -n "$FACE" ] && [ -f "$FACE" ]; } || fail "IDENTITY=instantid needs FACE=<front-facing photo> (got: '${FACE:-unset}')"
  for n in InstantIDModelLoader InstantIDFaceAnalysis ApplyInstantID ControlNetLoader; do need_node "$n"; done
  have_model "ip-adapter.bin" || fail "InstantID model missing: ip-adapter.bin (run saga-instantid-setup.sh)"
  have_model "instantid_controlnet.safetensors" || fail "InstantID controlnet missing (run saga-instantid-setup.sh)"
  log "instantid ok (face=$(basename "$FACE"), iid=$IIDW[..$IIDE])"
fi

if [ "$DETAIL" != "none" ]; then
  [ -x "$DTL" ] || fail "not executable: $DTL (chmod +x)"
  for n in FaceDetailer UltralyticsDetectorProvider; do need_node "$n"; done
  have_model "hand_yolov8s.pt" || fail "hand detector missing under models/: hand_yolov8s.pt (needed for DETAIL=$DETAIL)"
  [ "$DETAIL" = "both" ] && { have_model "face_yolov8m.pt" || fail "face detector missing under models/: face_yolov8m.pt"; }
  log "hand-fixer ok (--detect $DETAIL on each keyframe)"
fi

if [ "$POLISH" -eq 1 ]; then
  for s in "$HERE/saga-esrgan-video.sh" "$HERE/saga-interpolate.sh" "$GRADE_SH"; do [ -x "$s" ] || fail "not executable: $s (chmod +x)"; done
  command -v ffprobe >/dev/null || fail "ffprobe required for polish (2K upscale); apt-get install ffmpeg or run --no-polish"
  if [ "$UPSCALE_MODE" = "esrgan" ]; then
    for n in UpscaleModelLoader ImageUpscaleWithModel ImageScale; do need_node "$n"; done
    have_model "4x-AnimeSharp.pth" || fail "upscale model missing under models/: 4x-AnimeSharp.pth (use UPSCALE_MODE=lanczos or --no-polish)"
  fi
  log "polish ok (${UPSCALE_MODE} 2K upscale + ${POLISH_FPS}fps interpolate)"
fi

if [ "$USE_CONTROL" -eq 1 ]; then
  MISS=0
  for f in "$SEAL1" "$SEAL2" "$SEAL3" "$SEAL4" "$SEAL5"; do
    if have_file "$f"; then log "  seal ✓ $f"; else log "  seal ✗ MISSING $f"; MISS=1; fi
  done
  [ "$MISS" -eq 0 ] || fail "USE_CONTROL=1 needs the 5 seal crops (set SEAL1..SEAL5)"
fi
log "inputs ok"
echo "✅ preflight passed"
[ "$CHECK_ONLY" -eq 1 ] && { echo "(--check) done."; exit 0; }

# --clean: remove ONLY this pipeline's regenerable artifacts (never touches
# comparison stills, LoRAs, datasets, or anything else under tmp/).
if [ "$CLEAN" -eq 1 ]; then
  log "clean: removing prior jutsu artifacts (keyframes, FLF segments, holds, master, polish)…"
  rm -f "$SAGA_ROOT"/tmp/jutsu_k[1-8].png 2>/dev/null
  rm -f "$SAGA_ROOT"/tmp/s0[1-8].mp4 2>/dev/null
  rm -f "$WORK"/s0*_hold*.mp4 "$WORK"/jutsu_20s_master.mp4 "$WORK"/jutsu_2k.mp4 "$WORK"/jutsu_final.mp4 "$WORK"/concat.txt 2>/dev/null
  rm -rf "$SAGA_ROOT"/tmp/.esrgan_vid_* 2>/dev/null   # stale per-frame upscale temps from killed runs
  log "  cleaned."
fi

# ── STEP 1 — KEYFRAMES ──────────────────────────────────────────────────────
CUR=1; step 1 "keyframes (8 pose stills)"
# helpers do the work + log to the run; they DON'T echo the path (callers use the
# deterministic out path), so no stdout capture and `fail` halts the whole script.
gen_kf(){ # <name> <prompt-extra> [control]  → writes $SAGA_ROOT/tmp/<name>.png
  local name="$1" extra="$2" ctrl="${3:-}" out="$SAGA_ROOT/tmp/${1}.png"
  if [ "$FORCE" -eq 0 ] && have_file "$out"; then log "  reuse $name (exists; --force to redo)"; return 0; fi
  if [ "$IDENTITY" = "instantid" ]; then
    # identity via InstantID (real face embedding) + LoRA for style; pose from prompt
    local a=(--face "$FACE" -o "$name" -s "$SEED" -W "$W" -H "$H" --lora "$LORA" --lora-weight "$LORAW" --trigger "$TRIGGER" --iid-weight "$IIDW" --iid-end "$IIDE" -n "$NEG" -p "$BASE, $extra")
    [ -n "$CFG" ] && a+=(--cfg "$CFG")
    log "  gen $name (instantid, face=$(basename "$FACE"))"
    "$IIDKF" "${a[@]}" || fail "instantid keyframe $name failed"
  else
    # identity via the trained LoRA + trigger (no IP-Adapter pose prior)
    local args=(-o "$name" -s "$SEED" -W "$W" -H "$H" --lora "$LORA" --lora-weight "$LORAW" --trigger "$TRIGGER" -n "$NEG" -p "$BASE, $extra")
    [ -n "$CFG" ] && args+=(--cfg "$CFG")
    [ "$USE_CONTROL" -eq 1 ] && [ -n "$ctrl" ] && args+=(-c "$ctrl" --control-pre canny --control-strength 0.85 --union-type "${UNION_TYPE:-canny/lineart/anime_lineart/mlsd}")
    log "  gen $name ${ctrl:+${USE_CONTROL:+(control: $(basename "$ctrl"))}}"
    "$KF" "${args[@]}" || fail "keyframe $name failed"
  fi
  # HAND FIX: re-render hands (and optionally the face) on the keyframe IN PLACE,
  # before it feeds FLF — so clean hands are carried through the interpolation.
  if [ "$DETAIL" != "none" ]; then
    local dargs=(--image "$out" --detect "$DETAIL" --lora "$LORA" --lora-weight "$LORAW" --trigger "$TRIGGER" -n "$NEG" -o "$name")
    # detailer keeps its OWN guidance — it corrects fingers better at normal CFG;
    # only the keyframe GENERATION uses the soft low CFG.
    log "  detail $name (--detect $DETAIL)"
    "$DTL" "${dargs[@]}" >/dev/null || fail "detail $name failed"
    have_file "$out" || fail "detail produced no output for $name"
  fi
}
# Seal keyframes describe the HAND POSE GEOMETRICALLY — never the animal name.
# (The Naruto seal each corresponds to is noted for the show; the animal word is
# kept OUT of the prompt because it renders the animal. Exact seal shapes come
# from ControlNet via USE_CONTROL=1 + the SEAL* crops, not from naming them.)
gen_kf jutsu_k1 "both hands forming a ninja hand seal, fingers interlocked in front of chest, intense focus" "$SEAL1"; K1="$SAGA_ROOT/tmp/jutsu_k1.png"; verify_out "$K1"   # tiger
gen_kf jutsu_k2 "both hands forming a ninja hand seal, hands clasped together, fingers laced" "$SEAL2"; K2="$SAGA_ROOT/tmp/jutsu_k2.png"; verify_out "$K2"                    # serpent
gen_kf jutsu_k3 "both hands forming a ninja hand seal, palms together, fingers crossed" "$SEAL3"; K3="$SAGA_ROOT/tmp/jutsu_k3.png"; verify_out "$K3"                            # dragon
gen_kf jutsu_k4 "both hands forming a ninja hand seal, both index fingers raised and pressed together, remaining fingers folded" "$SEAL4"; K4="$SAGA_ROOT/tmp/jutsu_k4.png"; verify_out "$K4"  # ram
gen_kf jutsu_k5 "both hands forming a ninja hand seal, fists pressed together, knuckles touching" "$SEAL5"; K5="$SAGA_ROOT/tmp/jutsu_k5.png"; verify_out "$K5"                  # boar
gen_kf jutsu_k6 "both hands pressed flat together in prayer position at center, gathering purple energy, faint glow between the palms"; K6="$SAGA_ROOT/tmp/jutsu_k6.png"; verify_out "$K6"
gen_kf jutsu_k7 "hands slightly apart, a small swirling purple energy orb forming between the palms, rasengan, glowing"; K7="$SAGA_ROOT/tmp/jutsu_k7.png"; verify_out "$K7"
gen_kf jutsu_k8 "hands held wide apart, a large swirling purple energy sphere between the palms, rasengan, crackling purple lightning, energy flowing, radiant glow"; K8="$SAGA_ROOT/tmp/jutsu_k8.png"; verify_out "$K8"
echo "✅ 8 keyframes ready"

# ── STEP 2 — MOTION (holds + FLF transitions) ───────────────────────────────
CUR=2; step 2 "motion (3 holds + 7 FLF transitions = 320f/20s)"
hold(){ # <still> <frames> <out>
  local png="$1" n="$2" out="$3"
  if [ "$FORCE" -eq 0 ] && have_file "$out"; then log "  reuse hold $(basename "$out")"; return 0; fi
  log "  hold $(basename "$png") × ${n}f"
  ffmpeg -y -loop 1 -i "$png" -t "$(awk -v n="$n" -v f="$FPS" 'BEGIN{printf "%.4f", n/f}')" \
    -r "$FPS" -s "${W}x${H}" -c:v libx264 -pix_fmt yuv420p "$out" >/dev/null 2>&1 || fail "hold render failed: $out"
}
flf(){ # <name> <first> <last> <frames> <motion-prompt>  → writes $SAGA_ROOT/tmp/<name>.mp4
  local name="$1" a="$2" b="$3" n="$4" mp="$5" out="$SAGA_ROOT/tmp/${1}.mp4"
  if [ "$FORCE" -eq 0 ] && have_file "$out"; then log "  reuse flf $name"; return 0; fi
  log "  flf $name  ${n}f  ($(basename "$a") → $(basename "$b"))"
  "$FLF" -o "$name" -a "$a" -b "$b" -L "$n" --fps "$FPS" -W "$W" -H "$H" -s "$SEED" -p "$mp" || fail "flf $name failed"
}
SEAL_MOTION="both hands smoothly change to the next ninja hand seal, precise finger movement"
declare -a CLIPS
hold "$K1" 8  "$WORK/s00_hold1.mp4";                                              CLIPS+=( "$WORK/s00_hold1.mp4" )
flf s01 "$K1" "$K2" 40 "$SEAL_MOTION";                                            CLIPS+=( "$SAGA_ROOT/tmp/s01.mp4" )
flf s02 "$K2" "$K3" 40 "$SEAL_MOTION";                                            CLIPS+=( "$SAGA_ROOT/tmp/s02.mp4" )
flf s03 "$K3" "$K4" 40 "$SEAL_MOTION";                                            CLIPS+=( "$SAGA_ROOT/tmp/s03.mp4" )
flf s04 "$K4" "$K5" 40 "$SEAL_MOTION";                                            CLIPS+=( "$SAGA_ROOT/tmp/s04.mp4" )
flf s05 "$K5" "$K6" 40 "both hands come together into prayer position, energy gathering at the center"; CLIPS+=( "$SAGA_ROOT/tmp/s05.mp4" )
hold "$K6" 16 "$WORK/s06_hold6.mp4";                                              CLIPS+=( "$WORK/s06_hold6.mp4" )
flf s07 "$K6" "$K7" 40 "the hands separate, a purple energy orb forms and swirls between the palms"; CLIPS+=( "$SAGA_ROOT/tmp/s07.mp4" )
flf s08 "$K7" "$K8" 48 "the purple energy orb grows larger, swirling and flowing with crackling energy, radiant"; CLIPS+=( "$SAGA_ROOT/tmp/s08.mp4" )
hold "$K8" 8  "$WORK/s09_hold8.mp4";                                              CLIPS+=( "$WORK/s09_hold8.mp4" )
TOT=0
for c in "${CLIPS[@]}"; do verify_out "$c"; f=$(frames_of "$c"); [ "$f" != "?" ] && TOT=$((TOT+f)); done
log "total frames (measured): ${TOT:-?} (expected 320 = 20.0s @ ${FPS}fps)"
echo "✅ motion segments ready"

# ── STEP 3 — ASSEMBLE ───────────────────────────────────────────────────────
CUR=3; step 3 "assemble → master"
LIST="$WORK/concat.txt"; : > "$LIST"
for c in "${CLIPS[@]}"; do echo "file '$c'" >> "$LIST"; done
MASTER="$WORK/jutsu_20s_master.mp4"
ffmpeg -y -f concat -safe 0 -i "$LIST" -c:v libx264 -pix_fmt yuv420p -r "$FPS" "$MASTER" >/dev/null 2>&1 || fail "concat failed"
verify_out "$MASTER"; log "master frames: $(frames_of "$MASTER"), duration ~$(awk -v t="$(frames_of "$MASTER")" -v f="$FPS" 'BEGIN{printf "%.1f", (t=="?"?0:t)/f}')s"
echo "✅ master → $MASTER"

# ── STEP 4 — POLISH ─────────────────────────────────────────────────────────
CUR=4; step 4 "polish (2K upscale → grade → interpolate?)"
FINAL="$MASTER"
if [ "$POLISH" -eq 0 ]; then log "(--no-polish) skipped"; else
  UP="$WORK/jutsu_2k.mp4"
  log "2K upscale ($UPSCALE_MODE)…"
  "$HERE/saga-esrgan-video.sh" "$MASTER" --method "$UPSCALE_MODE" -o "$UP" >/dev/null || fail "2K upscale failed"
  verify_out "$UP"; FINAL="$UP"
  # grade unifies color/exposure across the whole clip (reduces per-segment seams)
  # and adds the analog grain.
  if [ "$GRADE" != "none" ]; then
    GR="$WORK/jutsu_graded.mp4"
    log "grade ($GRADE — unify color + grain)…"
    "$GRADE_SH" "$FINAL" --preset "$GRADE" -o "$GR" >/dev/null || fail "grade failed"
    verify_out "$GR"; FINAL="$GR"
  fi
  if [ "$INTERPOLATE" = "1" ]; then
    POL="$WORK/jutsu_final.mp4"
    log "interpolate → ${POLISH_FPS}fps…"
    "$HERE/saga-interpolate.sh" "$FINAL" --fps "$POLISH_FPS" -o "$POL" >/dev/null || fail "interpolate failed"
    verify_out "$POL"; FINAL="$POL"
  else
    log "interpolation OFF (minterpolate ghosts fast motion → trailing rays; set INTERPOLATE=1 to enable)"
  fi
  log "polished → $FINAL ($(frames_of "$FINAL") frames)"
fi

DT=$(( $(date +%s) - T0 ))
echo
echo "════════════════════════════════════════════════════"
echo " ✅ DONE in ${DT}s — review: $FINAL"
echo "   (raw master: $MASTER)"
echo " log: $LOG"
echo "════════════════════════════════════════════════════"
