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
#   STEP 1  keyframes  — 8 pose stills (anchor-chain by default), hands detailed in place
#   STEP 2  motion     — 3 holds + 7 FLF transitions
#   STEP 3  assemble   — concat → 20s master
#   STEP 4  polish     — ESRGAN 2K upscale (4x-AnimeSharp) → frame interpolation
#
# STEP 1 keyframe modes (see KEYFRAME_MODE / CHAIN_DENOISE in CONFIG):
#   anchor       (default) — K1 generated fully, then K2..K8 are img2img EDITs of the
#                  clean K1 (edit, don't redraw): identity/outfit/framing inherited,
#                  only the pose changes → maximum consistency. FLF adds the motion.
#   --independent          — generate every keyframe from scratch (more pose freedom,
#                  higher inter-keyframe variance).
#
# Usage:
#   LORA=exodia.safetensors TRIGGER=exodia_saga ./saga-jutsu-flf.sh
#   (add USE_CONTROL=1 to force each pose from a reference image via ControlNet; refs
#    default to the curated anime hand-signs, override with SIGN_DIR= or SIGN1..4/
#    SIGN_PRAYER/SIGN_ORB_NEAR/SIGN_ORB_FAR. Works in both anchor and independent modes.)
#   Identity source (keyframes):  IDENTITY=lora (default) | instantid
#     LoRA-only:   LORA=animegabriel.safetensors TRIGGER=animegabriel LORAW=1.6 CFG=2.0 ./saga-jutsu-flf.sh
#     InstantID:   IDENTITY=instantid FACE=/path/to/face.png LORA=animegabriel.safetensors TRIGGER=animegabriel ./saga-jutsu-flf.sh
#   CFG= sets the keyframe guidance (low = the soft look); IIDW/IIDE tune InstantID.
# Flags:
#   --check       run STEP 0 preflight only, then exit
#   --force       regenerate artifacts even if they already exist
#   --clean       delete THIS pipeline's prior artifacts (keyframes/segments/master/
#                 polish) before running — frees disk + guarantees a fresh render.
#                 Only touches jutsu_*/s0*/hold/master/2k/final; nothing else in tmp.
#   --independent generate each keyframe from scratch (default: anchor chain off K1)
#   --chain-prev  anchor mode: edit the PREVIOUS keyframe instead of the clean K1
#   --dwpose      reference control via pose SKELETON only (anime hands, no bleed) [enables control]
#   --openpose    like --dwpose, OpenPose preprocessor                            [enables control]
#   --canny       reference control via ALL edges of the ref (imports bg+realism)  [enables control]
#   --cuts        seal sequence as anime CUTS (hold+hard-cut, no Wan morph → no melted
#                 hands); orb beats still use FLF motion. Implies hard-cut assembly.
#   --no-polish   skip STEP 4
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
COMFY="${COMFY:-http://127.0.0.1:8188}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KF="$HERE/saga-keyframe.sh"; FLF="$HERE/saga-flf.sh"; IIDKF="$HERE/saga-instantid-keyframe.sh"; DTL="$HERE/saga-detail.sh"; GRADE_SH="$HERE/saga-grade.sh"; EDIT="$HERE/saga-edit.sh"
# Single-take backend drivers (VIDEO_BACKEND=framepack|ltx). Same common interface as saga-flf.sh.
FRAMEPACK="$HERE/saga-framepack.sh"; LTX="$HERE/saga-ltx.sh"

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
HAND_DENOISE="${HAND_DENOISE:-0.3}" # GENTLE by default: at 0.4 the detailer re-invents hands (clean but wrong/missing limbs); 0.3 cleans without destroying good hands. Raise only to rescue badly-broken frames.
# STEP-1 keyframe generation MODE:
#   anchor      (DEFAULT) — generate K1 fully, then img2img-EDIT the CLEAN K1 into
#                every other keyframe (via saga-edit.sh). Identity, outfit, framing
#                and lighting are inherited from the anchor; only the hand pose
#                changes. Editing the SAME clean anchor each time (never the previous,
#                drifting frame) means error can't accumulate → maximum inter-keyframe
#                consistency ("no chaos"). FLF supplies the motion between keyframes.
#   independent — generate every keyframe from scratch (LoRA identity + pose prompt).
#                More pose freedom, higher inter-keyframe variance (jump-cut risk).
#                Select with the --independent flag or KEYFRAME_MODE=independent.
KEYFRAME_MODE="${KEYFRAME_MODE:-anchor}"
# Denoise for the anchor edits (anchor mode only). Each edit is off the CLEAN anchor
# (no accumulation), so this can run high enough to restructure the hands into a new
# seal without snowballing: ~0.5–0.6 is the working range. Lower = more faithful to
# the anchor (poses barely change); higher = stronger pose change, more departure.
CHAIN_DENOISE="${CHAIN_DENOISE:-0.55}"
# Anchor-mode edit SOURCE: anchor = edit the clean K1 every time (no drift accumulation,
# max identity stability); prev = edit the PREVIOUS keyframe (smoother frame-to-frame
# evolution → gentler FLF motion, slight drift-creep risk). Select prev with --chain-prev.
CHAIN_FROM="${CHAIN_FROM:-anchor}"
# PINNED across ALL keyframes for wardrobe continuity. Keep it SIMPLE and match
# what the LoRA already learned (e.g. the shirt in the training photos) — vague or
# exotic outfits ("high-collar", "gi", "armor") make the model invent a different
# costume per keyframe, and "high-collar" in particular reads as a face mask.
OUTFIT="${OUTFIT:-wearing a plain white short-sleeve shirt}"
POLISH_FPS="${POLISH_FPS:-32}"      # STEP 4 interpolation target fps
UPSCALE_MODE="${UPSCALE_MODE:-esrgan}"   # esrgan (crisp cel lines) | lanczos (soft/painterly — matches a low-CFG look)
EYES="${EYES:-dark brown eyes, clearly visible round irises and pupils, sharp detailed eyes}"   # PINNED — explicit irises/pupils fight the blown-out "white eyes" failure
GROOMING="${GROOMING:-buzz cut, very short hair, short trimmed beard}"   # PINNED hair/beard across keyframes
# Visual style for keyframes — pushed toward rough analog anime (Serial Experiments Lain):
# retro 90s cel look, muted/desaturated, grainy, hand-drawn, low-fi. This drives the
# generation toward "less real, more anime"; the GRADE (lain-heavy) then degrades the whole
# video uniformly on top. (Earlier this was clean to protect hands; the aesthetic wins.)
STYLE="${STYLE:-retro 1990s anime screencap, cel shading, muted desaturated colors, visible film grain, rough hand-drawn linework, flat colors, 2d, moody, low fidelity, serial experiments lain style}"
GRADE="${GRADE:-lain}"              # none | grain | lain — post grade; also UNIFIES color across FLF segments (reduces visible seams)
INTERPOLATE="${INTERPOLATE:-0}"     # 1 = interpolate to POLISH_FPS. OFF by default: minterpolate ghosts fast motion (the trailing light-rays)
# Assembly (STEP 3): how the segments are joined. Every seam is between two clips that
# SHARE the boundary keyframe, so a short crossfade removes the per-segment velocity
# "pop" (decelerate-in / accelerate-out) without a visible dissolve → reads as one shot.
ASSEMBLE="${ASSEMBLE:-concat}"      # concat = ONE continuous take (FLF segments share endpoint
                                    # keyframes, so motion flows through with no dissolve) | xfade
                                    # = crossfade seams (NOT wanted — reads as a dissolve, not continuous)
XFADE="${XFADE:-5}"                 # crossfade length in frames at each seam (xfade mode only)
# Dwell frames on the anchor poses. LARGE holds read as "stuck doing nothing"; kept short
# now (was 8/16/8). Set any to 0 to drop that hold entirely.
HOLD1="${HOLD1:-4}"; HOLD6="${HOLD6:-6}"; HOLD8="${HOLD8:-8}"
# Motion for the SEAL sequence (K1→K5): flf = Wan morphs between seals (but Wan melts hands
# mid-morph); cuts = hold each seal + HARD CUT to the next (anime-authentic, no morph → no
# melted hands). The ORB beats (K5→K8) always use FLF (open hands interpolate cleanly).
# Select cuts with --cuts. HOLD_SEAL = frames each seal is held in cut mode.
# Swappable video motion backend (see docs/VIDEO_BACKENDS.md). wan = current keyframe+FLF
# stitching. framepack/ltx = single-take long continuous gen (built after those models +
# their video LoRAs are installed). Only 'wan' is wired today; others fail preflight cleanly.
VIDEO_BACKEND="${VIDEO_BACKEND:-wan}"
# Single-take backends (framepack|ltx): ONE continuous generation from the start keyframe (K1)
# + a full-jutsu motion prompt — the "one scene, one gen" path (no FLF stitching, no seams).
# These read a VIDEO-model LoRA (architecture-specific; train with saga-video-lora-train.sh)
# so identity is native → no face-restore hack. Knobs:
VIDEO_LORA="${VIDEO_LORA:-}"                   # e.g. gabrielgomez1.safetensors under models/loras_video/<backend>
VIDEO_LORA_WEIGHT="${VIDEO_LORA_WEIGHT:-0.9}"
TAKE_SECONDS="${TAKE_SECONDS:-15}"             # target length of the single continuous take
# The whole jutsu in ONE prompt (single-take backends narrate the sequence rather than pinning
# per-seal keyframes). Overridable via env for other scenes/characters.
TAKE_PROMPT="${TAKE_PROMPT:-the man rapidly performs a flurry of ninja hand seals in about one second, hands flicking fast and precise, then snaps both palms together in a prayer position at his chest, then slowly draws his hands apart as a small bright orb of glowing light appears between his palms and grows larger and brighter, finally his arms open to shoulder width and the orb erupts into vivid swirling multicolored energy, dramatic action scene, subtle handheld camera shake, cinematic, the same man stays centered in frame, one continuous shot, consistent lighting}"
MOTION_MODE="${MOTION_MODE:-flf}"   # flf | cuts
HOLD_SEAL="${HOLD_SEAL:-8}"
# Seal-transition SPEED (flf mode): frames per seal→seal morph. Real jutsu flash through
# all the seals in ~1s, so keep these SHORT — a fast continuous flurry, not a slow morph.
# Short morphs also give Wan little room to melt hands. 4 ≈ all seals in ~1s; 6 ≈ ~1.5s.
SEAL_FRAMES="${SEAL_FRAMES:-6}"
# Orb-growth length (flf mode): the SLOW, continuous, dramatic part. Bump for a longer clip.
ORB_FRAMES="${ORB_FRAMES:-48}"
# STEP-4 identity + camera (polish):
# FACE_RESTORE=1 re-renders the face on EVERY frame with the LoRA → locks YOUR identity
# across Wan's drifted frames (fixes the "random guy"). Per-frame → SLOW but the real fix.
FACE_RESTORE="${FACE_RESTORE:-0}"; FACE_DENOISE="${FACE_DENOISE:-0.45}"
# CAMERA_SHAKE = handheld tremble amplitude in px (0 = off; ~12 = action/cinematic). Post.
CAMERA_SHAKE="${CAMERA_SHAKE:-0}"
# Shared negative fed to EVERY keyframe AND the hand-fixer. Guards the recurring
# FAILURE CLASSES (not just this scene): hand mutations, seal-name animals bleeding
# into the background, wrong eye colors, mask/costume drift, wrong sex, text.
# Extend/override per scene or character via NEG=.  (Want the ghostly seal-spirit
# animals as an intentional effect? Drop the animal words from NEG and add them
# to a keyframe's prompt.)
NEG="${NEG:-lowres, worst quality, blurry, deformed, bad anatomy, bad hands, extra fingers, fused fingers, missing fingers, mutated hands, malformed hands, elongated fingers, extra limbs, extra arms, twisted arms, sideways arms, elongated arms, bent broken wrists, disconnected limbs, floating hands, boar, dragon, ram, serpent, tiger, snake, animal, creature, monster, mask, face covering, hood, helmet, white eyes, blank white eyes, solid white eyes, no pupils, rolled-back eyes, glowing eyes, blue eyes, green eyes, heterochromia, 1girl, woman, female, text, watermark, signature}"
# ── Hand-sign REFERENCE control (prompt + reference, combined) ──────────────
# USE_CONTROL=1 forces each hand pose to match a REFERENCE image via ControlNet, while the
# LoRA supplies identity and the prompt supplies everything else. Works in BOTH anchor and
# independent modes (anchor edits route control through saga-edit). The --dwpose/--openpose/
# --canny flags set the preprocessor and enable control.
USE_CONTROL="${USE_CONTROL:-0}"
CONTROL_STRENGTH="${CONTROL_STRENGTH:-0.85}"   # ControlNet pose-forcing strength 0..1; lower lets the LoRA/prompt breathe
CONTROL_END="${CONTROL_END:-0.9}"              # fraction of denoising control stays ON; LOWER (~0.5) locks the hand pose
                                               # early then RELEASES so the prompt reasserts background/style/face (kills
                                               # the reference's background bleed + softness). 0.9 = control on almost throughout.
# Preprocessor: what canny extracts from the reference. canny = ALL edges (imports the
# reference's background + realistic texture + composition — bleed + photoreal hands).
# dwpose/openpose = only the body/hand SKELETON (pose only; the character is drawn purely
# by the LoRA+prompt → anime hands, no bleed, no realism import). Full-scene realistic
# refs → prefer dwpose. union-type must match the preprocessor family.
CONTROL_PRE="${CONTROL_PRE:-canny}"            # canny | dwpose | openpose (also set by --dwpose/--openpose/--canny)
# NOTE: CONTROL_UNION is derived from CONTROL_PRE *after* flag parsing (a flag can change it).
export KF_CN="${KF_CN:-controlnet-union-sdxl-promax.safetensors}"   # union controlnet
export EDIT_CN="$KF_CN"   # saga-edit (anchor edits) uses the SAME controlnet model preflight validates
# Hand-pose REFERENCE images (anime-ified, curated one-per-sign). ControlNet uses only
# the canny edge map, so these force the exact hand shape/position while the LoRA carries
# identity. SEQUENCE: ram → boar → dragon → serpent (no tiger ref exists), then the hand-
# separation stages drive the orb beats. K8 (apex, arms widest) has no exact ref →
# prompt-only. All overridable via env; the front end will parameterize these per shot.
SIGN_DIR="${SIGN_DIR:-$SAGA_ROOT/users/gabrielgomez1/datasets/anime_curated}"
SIGN1="${SIGN1:-$SIGN_DIR/anime_gabrielhandsigns_ram_2748679270_s303.png}"                              # K1 ram
SIGN2="${SIGN2:-$SIGN_DIR/anime_gabrielhandsigns_boar_2_1181337321_s101.png}"                           # K2 boar
SIGN3="${SIGN3:-$SIGN_DIR/anime_gabrielhandsigns_dragon_2_1218743849_s202.png}"                         # K3 dragon
SIGN4="${SIGN4:-$SIGN_DIR/anime_gabrielhandsigns_serpent_339339625_s101.png}"                           # K4 serpent
SIGN_PRAYER="${SIGN_PRAYER:-$SIGN_DIR/anime_gabrielhandsigns_handstogether_1845580320_s202.png}"                       # K5 prayer
SIGN_ORB_NEAR="${SIGN_ORB_NEAR:-$SIGN_DIR/anime_gabrielhandsigns_handsslightlyseperated_3_2479493325_s303.png}"        # K6 orb near
SIGN_ORB_FAR="${SIGN_ORB_FAR:-$SIGN_DIR/anime_gabrielhandsigns_handsslightlyseperated_further_215320804_s303.png}"     # K7 orb far
# K8 apex: no dedicated arms-wide reference exists, so reuse the widest available (orb-far)
# so K8 is REFERENCE-ANCHORED (identity + framing come from a real ref) instead of being a
# prompt-only generation that drifts into a stranger. Override with a true arms-wide ref.
SIGN_ORB_APEX="${SIGN_ORB_APEX:-$SIGN_ORB_FAR}"                                                                        # K8 apex
SEED="${SEED:-777}"; W="${W:-1280}"; H="${H:-704}"; FPS="${FPS:-16}"

# confirmed installed filenames (audit 2026-07-18); saga-flf.sh reads these via env
export FLF_T5="${FLF_T5:-umt5_xxl_fp8_e4m3fn_scaled.safetensors}"

FORCE=0; POLISH=1; CHECK_ONLY=0; CLEAN=0
while [ $# -gt 0 ]; do case "$1" in
  --check) CHECK_ONLY=1; shift;; --force) FORCE=1; shift;;
  --clean) CLEAN=1; shift;;
  --independent) KEYFRAME_MODE=independent; shift;;   # STEP 1: independent keyframes instead of the anchor chain
  --chain-prev) CHAIN_FROM=prev; shift;;              # anchor mode: edit the PREVIOUS keyframe instead of the clean K1
  # ControlNet preprocessor (all imply USE_CONTROL=1): dwpose/openpose = pose skeleton
  # only (anime hands, no background/realism bleed); canny = trace all edges of the ref.
  --dwpose) CONTROL_PRE=dwpose; USE_CONTROL=1; shift;;
  --openpose) CONTROL_PRE=openpose; USE_CONTROL=1; shift;;
  --canny) CONTROL_PRE=canny; USE_CONTROL=1; shift;;
  # Identity method for the keyframes (who the character is):
  #   lora      = per-user TRAINED identity (default; strongest, but a train per user)
  #   instantid = ZERO-SHOT identity from one reference FACE photo, NO training — the
  #               path that scales to many users. Needs FACE=<photo> + InstantID installed.
  --identity) IDENTITY="$2"; shift 2;;
  --zero-shot) IDENTITY=instantid; shift;;            # alias: --identity instantid
  --face) FACE="$2"; shift 2;;                          # reference photo for --zero-shot
  # anime cuts for the seal sequence (no Wan morph → no melted hands); implies hard cuts
  --cuts) MOTION_MODE=cuts; ASSEMBLE=concat; shift;;
  --no-polish) POLISH=0; shift;; -h|--help) sed -n '2,40p' "$0"; exit 0;;
  *) echo "unknown arg: $1"; exit 2;;
esac; done
# Derive the union-net type from the FINAL preprocessor (env or flag). Must run post-flags.
# Values must be valid SetUnionControlNetType enums: pose skeleton → "openpose".
case "$CONTROL_PRE" in dwpose|openpose) CONTROL_UNION="${UNION_TYPE:-openpose}";; *) CONTROL_UNION="${UNION_TYPE:-canny/lineart/anime_lineart/mlsd}";; esac
# Identity method must be a known value (fail early on a typo, not deep in STEP 1).
case "$IDENTITY" in lora|instantid) ;; *) echo "❌ IDENTITY must be lora|instantid (got '$IDENTITY'); instantid = zero-shot reference-face, needs --face"; exit 2;; esac

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
# NOTE on lighting: the previous "dark background, embers, dramatic lighting" cast a
# hard top-light that blew the eyes out solid white. Replaced with soft, even frontal
# light + explicit face/eye visibility so the brown irises actually render. "1man"
# anchors the correct sex (Animagine biases 1girl). "both hands visible … in front of
# the chest" keeps the seal hands framed and stops the sideways/cut-off arms.
# Arm/hand POSTURE is owned by each pose string (seals = forearms vertical; orb apex =
# arms extended wide), so BASE only pins framing/identity/lighting — otherwise a bent-
# arms pin in BASE would fight the shoulder-width orb finale.
BASE="solo, 1man, adult man, $GROOMING, $OUTFIT, $EYES, detailed face, both eyes open looking forward, $STYLE, upper body medium shot from the waist up, both hands visible in frame, centered composition, consistent framing, eye level, plain dark muted background, soft even frontal lighting"

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
case "$VIDEO_BACKEND" in
  wan) ;;
  framepack) BACKEND_DRV="$FRAMEPACK";;
  ltx)       BACKEND_DRV="$LTX";;
  *) fail "VIDEO_BACKEND must be wan|framepack|ltx (got '$VIDEO_BACKEND')";;
esac
# Single-take backends: driver must exist + its node classes must be live on this engine.
# Run the driver's own /object_info preflight now (fail fast, before any keyframe GPU time).
if [ "$VIDEO_BACKEND" != "wan" ]; then
  [ -x "$BACKEND_DRV" ] || fail "not executable: $BACKEND_DRV (chmod +x)"
  ARG=(); [ -n "$VIDEO_LORA" ] && ARG=(--lora "$VIDEO_LORA")
  COMFY="$COMFY" "$BACKEND_DRV" --check "${ARG[@]}" \
    || fail "$VIDEO_BACKEND preflight failed — install nodes/models per docs/VIDEO_BACKENDS.md §2/§3, then restart saga-comfyui"
  if [ -n "$VIDEO_LORA" ]; then
    find "$SAGA_ROOT/models/loras_video/$VIDEO_BACKEND" -name "$VIDEO_LORA" -print -quit 2>/dev/null | grep -q . \
      || log "  ⚠ VIDEO_LORA '$VIDEO_LORA' not found under models/loras_video/$VIDEO_BACKEND — identity will drift; train it: saga-video-lora-train.sh --model $([ "$VIDEO_BACKEND" = framepack ] && echo hunyuan || echo ltx)"
  else
    log "  ⚠ no VIDEO_LORA set for $VIDEO_BACKEND — the take will NOT carry the trained identity (the 'random guy'); set VIDEO_LORA=<file> once trained"
  fi
fi
log "tools ok (video backend: $VIDEO_BACKEND)"

curl -sf "$COMFY/system_stats" >/dev/null || fail "ComfyUI not reachable at $COMFY (is saga-comfyui up?)"
log "engine reachable at $COMFY"

OI=$(mktemp); curl -sf "$COMFY/object_info" -o "$OI" || fail "cannot fetch /object_info"
KEYS=$(jq -r 'keys[]' "$OI"); rm -f "$OI"
need_node(){ grep -qx "$1" <<<"$KEYS" || fail "required ComfyUI node MISSING: $1"; }
# Keyframe stack (SDXL) is needed for EVERY backend — it authors K1..K8 that seed motion.
NODES="CheckpointLoaderSimple LoraLoader CLIPLoader VHS_VideoCombine"
# Wan FLF nodes only when the Wan backend actually stitches keyframe pairs. Single-take
# backends (framepack/ltx) validated their OWN nodes via the driver --check above.
[ "$VIDEO_BACKEND" = "wan" ] && NODES="$NODES UnetLoaderGGUF WanFirstLastFrameToVideo"
[ "$USE_CONTROL" -eq 1 ] && NODES="$NODES ControlNetLoader ControlNetApplyAdvanced Canny"
[ "$USE_CONTROL" -eq 1 ] && [ "${UNION_TYPE:-canny/lineart/anime_lineart/mlsd}" != "none" ] && NODES="$NODES SetUnionControlNetType"
for n in $NODES; do need_node "$n"; done
log "nodes ok (backend=$VIDEO_BACKEND)"

have_model(){ find "$SAGA_ROOT/models" -name "$1" -print -quit 2>/dev/null | grep -q .; }
# Keyframe checkpoint is always required. Wan motion models only for the Wan backend.
have_model "animagine-xl-4.0.safetensors" || fail "required model file MISSING under models/: animagine-xl-4.0.safetensors"
if [ "$VIDEO_BACKEND" = "wan" ]; then
  for m in Wan2.2-I2V-A14B-HighNoise-Q6_K.gguf Wan2.2-I2V-A14B-LowNoise-Q6_K.gguf \
           "$FLF_T5" wan_2.1_vae.safetensors CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors; do
    have_model "$m" || fail "required model file MISSING under models/: $m"
  done
fi
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

# Anchor-chain keyframes (STEP 1 default): validate the edit primitive + its knob.
if [ "$KEYFRAME_MODE" = "anchor" ]; then
  [ -x "$EDIT" ] || fail "not executable: $EDIT (chmod +x) — required for KEYFRAME_MODE=anchor"
  case "$CHAIN_DENOISE" in ''|*[!0-9.]*) fail "CHAIN_DENOISE must be numeric (got '$CHAIN_DENOISE')";; esac
  awk -v d="$CHAIN_DENOISE" 'BEGIN{exit !(d>0 && d<=1)}' || fail "CHAIN_DENOISE must be in (0,1] (got $CHAIN_DENOISE)"
  # saga-edit re-renders the anchor with this checkpoint; keep it in the model set.
  export EDIT_CKPT="${EDIT_CKPT:-animagine-xl-4.0.safetensors}"
  have_model "$EDIT_CKPT" || fail "anchor-edit checkpoint missing under models/: $EDIT_CKPT (set EDIT_CKPT= or use --independent)"
  case "$CHAIN_FROM" in anchor|prev) ;; *) fail "CHAIN_FROM must be 'anchor' or 'prev' (got '$CHAIN_FROM')";; esac
  [ "$USE_CONTROL" -eq 1 ] && log "  anchor mode: ControlNet forces each sign (K1 via saga-keyframe, K2-K8 via saga-edit)"
  log "anchor-chain ok (edit primitive, denoise=$CHAIN_DENOISE, source=$CHAIN_FROM, ckpt=$EDIT_CKPT)"
elif [ "$KEYFRAME_MODE" != "independent" ]; then
  fail "KEYFRAME_MODE must be 'anchor' or 'independent' (got '$KEYFRAME_MODE')"
fi

if [ "$POLISH" -eq 1 ]; then
  for s in "$HERE/saga-esrgan-video.sh" "$HERE/saga-interpolate.sh" "$GRADE_SH"; do [ -x "$s" ] || fail "not executable: $s (chmod +x)"; done
  command -v ffprobe >/dev/null || fail "ffprobe required for polish (2K upscale); apt-get install ffmpeg or run --no-polish"
  if [ "$UPSCALE_MODE" = "esrgan" ]; then
    for n in UpscaleModelLoader ImageUpscaleWithModel ImageScale; do need_node "$n"; done
    have_model "4x-AnimeSharp.pth" || fail "upscale model missing under models/: 4x-AnimeSharp.pth (use UPSCALE_MODE=lanczos or --no-polish)"
  fi
  if [ "$FACE_RESTORE" -eq 1 ]; then
    [ -x "$HERE/saga-face-restore.sh" ] || fail "not executable: saga-face-restore.sh (chmod +x)"
    [ -x "$DTL" ] || fail "FACE_RESTORE needs saga-detail.sh executable"
    for n in FaceDetailer UltralyticsDetectorProvider; do need_node "$n"; done
    have_model "face_yolov8m.pt" || fail "FACE_RESTORE needs the face detector under models/: face_yolov8m.pt"
    log "  face-restore ON (per-frame identity lock @ denoise $FACE_DENOISE — this is slow)"
  fi
  if [ "$CAMERA_SHAKE" -gt 0 ]; then
    [ -x "$HERE/saga-shake.sh" ] || fail "not executable: saga-shake.sh (chmod +x)"
    case "$CAMERA_SHAKE" in ''|*[!0-9]*) fail "CAMERA_SHAKE must be an integer px";; esac
    log "  camera shake ON (amp ${CAMERA_SHAKE}px)"
  fi
  log "polish ok (${UPSCALE_MODE} 2K upscale + ${POLISH_FPS}fps interpolate)"
fi

if [ "$USE_CONTROL" -eq 1 ]; then
  # control works in BOTH modes: independent → saga-keyframe; anchor → saga-edit (K1 via
  # saga-keyframe, K2-K8 via saga-edit's ControlNet). Both need the same nodes + model.
  for n in ControlNetLoader ControlNetApplyAdvanced SetUnionControlNetType; do need_node "$n"; done
  case "$CONTROL_PRE" in
    canny)    need_node Canny;;
    openpose) need_node OpenposePreprocessor;;
    dwpose)   need_node DWPreprocessor;;
    *) fail "CONTROL_PRE must be canny|dwpose|openpose (got '$CONTROL_PRE')";;
  esac
  have_model "$KF_CN" || fail "ControlNet model missing under models/: $KF_CN (set KF_CN= or run USE_CONTROL=0)"
  MISS=0; NREF=0
  for f in "$SIGN1" "$SIGN2" "$SIGN3" "$SIGN4" "$SIGN_PRAYER" "$SIGN_ORB_NEAR" "$SIGN_ORB_FAR" "$SIGN_ORB_APEX"; do
    if have_file "$f"; then log "  ref ✓ $(basename "$f")"; NREF=$((NREF+1)); else log "  ref ✗ MISSING $f"; MISS=1; fi
  done
  [ "$MISS" -eq 0 ] || fail "USE_CONTROL=1 needs the reference images (set SIGN_DIR= or the individual SIGN* vars)"
  log "control ok ($NREF refs via $KF_CN, pre=$CONTROL_PRE @ strength $CONTROL_STRENGTH, end $CONTROL_END)"
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
  rm -f "$WORK"/s0*_hold*.mp4 "$WORK"/cut_k*.mp4 "$WORK"/jutsu_20s_master.mp4 "$WORK"/jutsu_2k.mp4 "$WORK"/jutsu_graded.mp4 "$WORK"/jutsu_face.mp4 "$WORK"/jutsu_shake.mp4 "$WORK"/jutsu_final.mp4 "$WORK"/concat.txt 2>/dev/null
  rm -rf "$SAGA_ROOT"/tmp/.esrgan_vid_* 2>/dev/null   # stale per-frame upscale temps from killed runs
  log "  cleaned."
fi

# ── STEP 1 — KEYFRAMES ──────────────────────────────────────────────────────
CUR=1; step 1 "keyframes (8 pose stills, mode=$KEYFRAME_MODE)"
# helpers do the work + log to the run; they DON'T echo the path (callers use the
# deterministic out path), so no stdout capture and `fail` halts the whole script.

# HAND FIX (shared by both modes): re-render hands (and optionally the face) on a
# keyframe IN PLACE, before it feeds FLF — so clean hands carry through interpolation.
# GENTLE denoise: the detailer is a scalpel, not a paint roller — at high denoise it
# re-invents good hands into anatomically-wrong ones. Low denoise cleans only.
hand_fix(){ # <name> <out-path>
  local name="$1" out="$2"
  [ "$DETAIL" = "none" ] && return 0
  local dargs=(--image "$out" --detect "$DETAIL" --lora "$LORA" --lora-weight "$LORAW" --trigger "$TRIGGER" --denoise "$HAND_DENOISE" -n "$NEG" -o "$name")
  log "  detail $name (--detect $DETAIL @ denoise $HAND_DENOISE)"
  "$DTL" "${dargs[@]}" >/dev/null || fail "detail $name failed"
  have_file "$out" || fail "detail produced no output for $name"
}

# ANCHOR EDIT: img2img-EDIT the clean anchor ($ANCHOR) into a new pose via saga-edit.
# The full positive is assembled here (trigger + pinned BASE + pose) — saga-edit does
# not editorialize the prompt. Then the shared hand_fix runs, same as gen_kf.
anchor_edit(){ # <src-image> <name> <pose-extra> [control-ref]  → writes $SAGA_ROOT/tmp/<name>.png
  local src="$1" name="$2" extra="$3" ctrl="${4:-}" out="$SAGA_ROOT/tmp/${2}.png"
  if [ "$FORCE" -eq 0 ] && have_file "$out"; then log "  reuse $name (exists; --force to redo)"; return 0; fi
  local full="$TRIGGER, $BASE, $extra"
  local a=(--image "$src" --prompt "$full" --denoise "$CHAIN_DENOISE" \
           --lora "$LORA" --lora-weight "$LORAW" --cfg "${CFG:-2.0}" \
           -s "$SEED" -W "$W" -H "$H" -n "$NEG" -o "$name")
  # combine with reference control: the edit is pulled toward the reference pose
  # (canny→Union Promax) while inheriting identity/framing from the source ($src).
  if [ "$USE_CONTROL" -eq 1 ] && [ -n "$ctrl" ]; then
    a+=(-c "$ctrl" --control-pre "$CONTROL_PRE" --control-strength "$CONTROL_STRENGTH" --control-end "$CONTROL_END" --union-type "$CONTROL_UNION")
    log "  edit $name (from $(basename "$src") + ref: $(basename "$ctrl") @ $CONTROL_STRENGTH → denoise $CHAIN_DENOISE)"
  else
    log "  edit $name (from $(basename "$src") → denoise $CHAIN_DENOISE)"
  fi
  "$EDIT" "${a[@]}" >/dev/null || fail "anchor edit $name failed"
  have_file "$out" || fail "anchor edit produced no output for $name"
  hand_fix "$name" "$out"
}

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
    [ "$USE_CONTROL" -eq 1 ] && [ -n "$ctrl" ] && args+=(-c "$ctrl" --control-pre "$CONTROL_PRE" --control-strength "$CONTROL_STRENGTH" --control-end "$CONTROL_END" --union-type "$CONTROL_UNION")
    if [ "$USE_CONTROL" -eq 1 ] && [ -n "$ctrl" ]; then log "  gen $name (ref: $(basename "$ctrl") @ $CONTROL_STRENGTH)"; else log "  gen $name"; fi
    "$KF" "${args[@]}" || fail "keyframe $name failed"
  fi
  # HAND FIX (in place, before FLF) — shared with anchor mode.
  hand_fix "$name" "$out"
}
# Seal keyframes describe the HAND POSE GEOMETRICALLY — never the animal name.
# (The Naruto seal each corresponds to is noted in comments for the show; the animal
# word is kept OUT of the prompt because it renders the animal. Exact seal shapes come
# from ControlNet via USE_CONTROL=1 + the SEAL* crops, not from naming them.)
# Single source of truth for the 8 poses — both modes iterate this list, so the pose
# script never diverges between anchor and independent generation.
declare -a KF_NAME KF_POSE KF_CTRL
KF_NAME=( jutsu_k1 jutsu_k2 jutsu_k3 jutsu_k4 jutsu_k5 jutsu_k6 jutsu_k7 jutsu_k8 )
# THE SEQUENCE (per the brief): 4 hand signs (tiger, ram, boar, dragon) → prayer →
# orb of light grows as the hands separate → at shoulder width the orb boosts into
# vivid multicolor energy. Each seal is described GEOMETRICALLY and DISTINCTLY (no
# animal names — those summon the animal) so the four signs read as four different
# hand shapes, not four copies of the same steeple.
KF_POSE=(
  # K1 RAM — index+middle of both hands extended up, remaining interlocked
  "both hands together in front of the chest, index and middle fingers of both hands extended straight upward and pressed together, the remaining fingers interlocked, forearms vertical, focused expression"
  # K2 BOAR — hands back-to-back low, knuckles pressed, wrists bent down
  "both hands together in front of the stomach, backs of the hands facing outward, fingers curled inward with the knuckles pressed together, wrists bent downward, forearms angled down"
  # K3 DRAGON — fingers fully interlocked into an upward woven cage
  "both hands in front of the chest, fingers fully interlocked with the fingertips pointing upward forming a woven cage shape, thumbs crossed at the base, forearms vertical"
  # K4 SERPENT — hands clasped, fingers interlocked and flat, palms pressed
  "both hands clasped together in front of the chest, fingers interlocked and flat, palms pressed together, forearms vertical"
  # K5 PRAYER — flat palm-to-palm at center of chest
  "both hands pressed flat together palm to palm in a prayer position at the center of the chest, fingers straight and together pointing upward, forearms vertical, calm focused expression"
  # K6 ORB FORMING — hands part slightly, small bright orb appears between palms
  "both hands a few inches apart at the center of the chest, palms facing each other, a small bright glowing sphere of white-blue light beginning to form in the gap between the open palms"
  # K7 ORB GROWING — hands wider, larger swirling orb
  "both hands held further apart at chest height, palms open and facing each other, a larger bright glowing sphere of swirling light suspended in the space between the palms"
  # K8 ORB APEX — hands apart, big orb. Energy words TRIMMED: "radiant/brilliant/powerful/
  # rays of light" drowned the identity trigger → generated a stranger. Keep it minimal so
  # the LoRA identity dominates; the glow/rays are added in POST (grade), not the prompt.
  "both hands held apart with a large glowing orb of swirling multicolored energy between the open palms"
)
# References matched to the sequence: ram, boar, dragon, serpent, prayer, orb-near,
# orb-far, apex. Every keyframe is now reference-anchored (K8 no longer prompt-only).
KF_CTRL=( "$SIGN1" "$SIGN2" "$SIGN3" "$SIGN4" "$SIGN_PRAYER" "$SIGN_ORB_NEAR" "$SIGN_ORB_FAR" "$SIGN_ORB_APEX" )

# EFFECTIVE pose text. ALWAYS the specific geometric description (never a generic
# "forming a hand sign"). Two reasons this must stay specific:
#   1. It DIFFERENTIATES the keyframes — a shared generic prompt makes all 4 signs
#      identical, so they collapse to the same pose.
#   2. It HOLDS the seal through the CONTROL_END release — once ControlNet lets go
#      (second half of denoising), the prompt is the only thing describing the pose;
#      if it's generic, the model draws a generic sign. The specific text keeps the
#      correct seal while the anime style repaints it.
# It is pure GEOMETRY (finger positions) with no animal/seal names, so it can't summon
# animals and it reinforces (never fights) the matching reference.
pose_for(){ echo "${KF_POSE[$1]}"; }

if [ "$KEYFRAME_MODE" = "anchor" ]; then
  # ANCHOR-CHAIN: K1 via the full generator (identity + pose + hand-fix), then every
  # other keyframe is an EDIT of the clean K1 — inherit identity/outfit/framing, change
  # only the pose. Editing the same clean anchor each time = no drift accumulation.
  gen_kf "${KF_NAME[0]}" "$(pose_for 0)" "${KF_CTRL[0]}"
  ANCHOR="$SAGA_ROOT/tmp/${KF_NAME[0]}.png"; verify_out "$ANCHOR"
  prev="$ANCHOR"
  for i in 1 2 3 4 5 6 7; do
    # CHAIN_FROM=anchor (default): every edit sources the CLEAN K1 → no drift accumulation.
    # CHAIN_FROM=prev: source the PREVIOUS keyframe → smoother frame-to-frame evolution
    # (closer consecutive keyframes → gentler FLF motion), at some drift-creep risk. The
    # reference (when USE_CONTROL=1) re-pins the pose each frame, capping structural drift.
    src="$ANCHOR"; [ "$CHAIN_FROM" = "prev" ] && src="$prev"
    anchor_edit "$src" "${KF_NAME[$i]}" "$(pose_for "$i")" "${KF_CTRL[$i]}"
    verify_out "$SAGA_ROOT/tmp/${KF_NAME[$i]}.png"
    prev="$SAGA_ROOT/tmp/${KF_NAME[$i]}.png"
  done
else
  # INDEPENDENT: each keyframe generated from scratch (LoRA identity + pose prompt).
  for i in 0 1 2 3 4 5 6 7; do
    gen_kf "${KF_NAME[$i]}" "$(pose_for "$i")" "${KF_CTRL[$i]}"
    verify_out "$SAGA_ROOT/tmp/${KF_NAME[$i]}.png"
  done
fi
# STEP 2 references K1..K8 by name; bind them from the deterministic out paths.
K1="$SAGA_ROOT/tmp/jutsu_k1.png"; K2="$SAGA_ROOT/tmp/jutsu_k2.png"
K3="$SAGA_ROOT/tmp/jutsu_k3.png"; K4="$SAGA_ROOT/tmp/jutsu_k4.png"
K5="$SAGA_ROOT/tmp/jutsu_k5.png"; K6="$SAGA_ROOT/tmp/jutsu_k6.png"
K7="$SAGA_ROOT/tmp/jutsu_k7.png"; K8="$SAGA_ROOT/tmp/jutsu_k8.png"
echo "✅ 8 keyframes ready (mode=$KEYFRAME_MODE)"

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
# Shared continuity suffix on EVERY motion prompt: the camera never moves and it's one
# continuous take, so Wan doesn't invent pans/zooms/cuts (the "movements not asked for").
CONT="the same man stays centered in frame, the camera is completely static, one continuous shot, smooth slow deliberate motion, consistent lighting"
declare -a CLIPS
if [ "$VIDEO_BACKEND" != "wan" ]; then
  # SINGLE-TAKE (framepack|ltx): ONE continuous generation from K1 + the whole-jutsu prompt.
  # No FLF stitching, no holds, no seams — the "one scene, one gen" path. Identity comes from
  # the VIDEO_LORA (native to the video model), not keyframe pinning; K1 seeds the start frame
  # + composition, then the model narrates seals → prayer → orb growth → apex in a single gen.
  TAKE_FRAMES=$(awk -v s="$TAKE_SECONDS" -v f="$FPS" 'BEGIN{printf "%d",(s*f)+0.5}')
  ONE="$SAGA_ROOT/tmp/jutsu_take.mp4"
  log "  single-take ($VIDEO_BACKEND): ${TAKE_SECONDS}s (~${TAKE_FRAMES}f @ ${FPS}fps) from K1${VIDEO_LORA:+, lora=$VIDEO_LORA@$VIDEO_LORA_WEIGHT}"
  if [ "$FORCE" -eq 0 ] && have_file "$ONE"; then
    log "  reuse take $(basename "$ONE")"
  else
    LARG=(); [ -n "$VIDEO_LORA" ] && LARG=(--lora "$VIDEO_LORA" --lora-weight "$VIDEO_LORA_WEIGHT")
    COMFY="$COMFY" "$BACKEND_DRV" -a "$K1" -p "$TAKE_PROMPT" -n "$NEG" \
      -L "$TAKE_FRAMES" --fps "$FPS" -W "$W" -H "$H" -s "$SEED" \
      "${LARG[@]}" -o "jutsu_take" || fail "$VIDEO_BACKEND single-take failed"
  fi
  CLIPS+=( "$ONE" )
elif [ "$MOTION_MODE" = "cuts" ]; then
  # SEAL SEQUENCE — anime cuts: hold each seal, HARD CUT to the next. No Wan morph between
  # seals → none of the melted/glued-finger mush. K5 (prayer) is held too, then flows into
  # the orb FLF below.
  log "  seal sequence: anime cuts (hold ${HOLD_SEAL}f + hard cut), K1→K5"
  for kf in K1 K2 K3 K4 K5; do
    hold "${!kf}" "$HOLD_SEAL" "$WORK/cut_${kf,,}.mp4";                             CLIPS+=( "$WORK/cut_${kf,,}.mp4" )
  done
else
  [ "$HOLD1" -gt 0 ] && { hold "$K1" "$HOLD1" "$WORK/s00_hold1.mp4";               CLIPS+=( "$WORK/s00_hold1.mp4" ); }
  # Seal→seal FLF transitions: describe the CHANGE, not specific finger counts (the two
  # keyframe images define the exact start/end pose; over-specifying fingers forces errors).
  # FAST seal flurry (SEAL_FRAMES each) — a quick continuous action beat, not a slow morph.
  flf s01 "$K1" "$K2" "$SEAL_FRAMES" "the man rapidly flicks his hands from one ninja hand seal to the next, fast decisive motion, $CONT";  CLIPS+=( "$SAGA_ROOT/tmp/s01.mp4" )
  flf s02 "$K2" "$K3" "$SEAL_FRAMES" "the man rapidly flicks his hands from one ninja hand seal to the next, fast decisive motion, $CONT";  CLIPS+=( "$SAGA_ROOT/tmp/s02.mp4" )
  flf s03 "$K3" "$K4" "$SEAL_FRAMES" "the man rapidly flicks his hands from one ninja hand seal to the next, fast decisive motion, $CONT";  CLIPS+=( "$SAGA_ROOT/tmp/s03.mp4" )
  flf s04 "$K4" "$K5" "$SEAL_FRAMES" "the man snaps both hands together into a flat prayer position at his chest, fast decisive motion, $CONT";  CLIPS+=( "$SAGA_ROOT/tmp/s04.mp4" )
fi
# ORB SEQUENCE (wan only) — always FLF: open hands + a growing orb interpolate cleanly.
# (Single-take backends already produced the entire jutsu, orb included, in ONE gen above.)
if [ "$VIDEO_BACKEND" = "wan" ]; then
  flf s05 "$K5" "$K6" 40 "the man's pressed palms begin to separate slightly and a small bright orb of glowing light appears in the gap between them, $CONT";                CLIPS+=( "$SAGA_ROOT/tmp/s05.mp4" )
  [ "$HOLD6" -gt 0 ] && { hold "$K6" "$HOLD6" "$WORK/s06_hold6.mp4";                 CLIPS+=( "$WORK/s06_hold6.mp4" ); }
  flf s07 "$K6" "$K7" 40 "the man's hands draw further apart and the glowing orb of light between his palms grows larger and brighter as the hands separate, $CONT";        CLIPS+=( "$SAGA_ROOT/tmp/s07.mp4" )
  flf s08 "$K7" "$K8" "$ORB_FRAMES" "the man's arms open out to shoulder width and the orb swells to full size, erupting into vivid swirling multicolored energy, radiant and intense, rays of light, $CONT"; CLIPS+=( "$SAGA_ROOT/tmp/s08.mp4" )
  [ "$HOLD8" -gt 0 ] && { hold "$K8" "$HOLD8" "$WORK/s09_hold8.mp4";                 CLIPS+=( "$WORK/s09_hold8.mp4" ); }
fi
TOT=0
for c in "${CLIPS[@]}"; do verify_out "$c"; f=$(frames_of "$c"); [ "$f" != "?" ] && TOT=$((TOT+f)); done
if [ "$VIDEO_BACKEND" = "wan" ]; then
  log "total frames (measured): ${TOT:-?} (expected 320 = 20.0s @ ${FPS}fps)"
else
  log "total frames (measured): ${TOT:-?} (single continuous take @ ${FPS}fps)"
fi
echo "✅ motion segments ready"

# ── STEP 3 — ASSEMBLE ───────────────────────────────────────────────────────
CUR=3; step 3 "assemble → master ($ASSEMBLE)"
MASTER="$WORK/jutsu_20s_master.mp4"
if [ "$ASSEMBLE" = "xfade" ] && [ "${#CLIPS[@]}" -gt 1 ] && command -v ffprobe >/dev/null; then
  # Crossfade every seam. Each seam joins two clips that share the boundary keyframe, so
  # the fade blends near-identical frames — it erases the velocity "pop" without a visible
  # dissolve. Inputs are normalized (fps/scale/sar) so xfade never rejects a mismatch.
  xd=$(awk -v x="$XFADE" -v f="$FPS" 'BEGIN{printf "%.4f", x/f}')
  inputs=(); norm=""; n=${#CLIPS[@]}
  for ((i=0;i<n;i++)); do inputs+=(-i "${CLIPS[$i]}"); norm+="[$i:v]fps=$FPS,scale=$W:$H,setsar=1[c$i];"; done
  acc=$(awk -v f="$(frames_of "${CLIPS[0]}")" -v r="$FPS" 'BEGIN{printf "%.4f", f/r}')
  chain=""; label="[c0]"
  for ((i=1;i<n;i++)); do
    off=$(awk -v a="$acc" -v x="$xd" 'BEGIN{printf "%.4f", (a-x<0?0:a-x)}')
    chain+="${label}[c$i]xfade=transition=fade:duration=$xd:offset=$off[v$i];"
    acc=$(awk -v a="$acc" -v f="$(frames_of "${CLIPS[$i]}")" -v r="$FPS" -v x="$xd" 'BEGIN{printf "%.4f", a + f/r - x}')
    label="[v$i]"
  done
  FILT="${norm}${chain}"; FILT="${FILT%;}"
  ffmpeg -y "${inputs[@]}" -filter_complex "$FILT" -map "$label" -r "$FPS" -c:v libx264 -pix_fmt yuv420p "$MASTER" >/dev/null 2>&1 \
    || fail "xfade assembly failed (retry with ASSEMBLE=concat)"
else
  [ "$ASSEMBLE" = "xfade" ] && log "  (xfade needs ffprobe + >1 clip; falling back to concat)"
  LIST="$WORK/concat.txt"; : > "$LIST"
  for c in "${CLIPS[@]}"; do echo "file '$c'" >> "$LIST"; done
  ffmpeg -y -f concat -safe 0 -i "$LIST" -c:v libx264 -pix_fmt yuv420p -r "$FPS" "$MASTER" >/dev/null 2>&1 || fail "concat failed"
fi
verify_out "$MASTER"; log "master frames: $(frames_of "$MASTER"), duration ~$(awk -v t="$(frames_of "$MASTER")" -v f="$FPS" 'BEGIN{printf "%.1f", (t=="?"?0:t)/f}')s"
echo "✅ master → $MASTER"

# ── STEP 4 — POLISH ─────────────────────────────────────────────────────────
CUR=4; step 4 "polish (2K upscale → grade → interpolate?)"
FINAL="$MASTER"
if [ "$POLISH" -eq 0 ]; then log "(--no-polish) skipped"; else
  # FACE RESTORE (before upscale): re-render the face on every frame with the LoRA so
  # Wan's drifted frames carry YOUR identity — the fix for the "random guy at the end".
  if [ "$FACE_RESTORE" -eq 1 ]; then
    FRV="$WORK/jutsu_face.mp4"
    log "face-restore (per-frame face → LoRA identity, denoise $FACE_DENOISE)… [slow]"
    "$HERE/saga-face-restore.sh" "$MASTER" --lora "$LORA" --trigger "$TRIGGER" --denoise "$FACE_DENOISE" -n "$NEG" -o "$FRV" || fail "face-restore failed"
    verify_out "$FRV"; MASTER="$FRV"
  fi
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
  # CAMERA SHAKE (last): handheld tremble for action/cinematic energy.
  if [ "$CAMERA_SHAKE" -gt 0 ]; then
    SHK="$WORK/jutsu_shake.mp4"
    log "camera shake (amp ${CAMERA_SHAKE}px)…"
    "$HERE/saga-shake.sh" "$FINAL" --amp "$CAMERA_SHAKE" -o "$SHK" >/dev/null || fail "camera shake failed"
    verify_out "$SHK"; FINAL="$SHK"
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
