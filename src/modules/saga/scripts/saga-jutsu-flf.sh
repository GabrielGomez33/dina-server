#!/usr/bin/env bash
# ============================================================================
# saga-jutsu-flf.sh — the 20s jutsu, keyframe-directed
# ----------------------------------------------------------------------------
# 5 seals → hands together (prayer) → on separation a purple rasengan orb grows,
# flowing with energy. 8 keyframes, 7 FLF transitions + 3 holds = 320 frames @
# 16fps = 20.0s exactly. Every FLF segment fits Wan's ~81-frame window.
#
# This is a DRIVER: it calls saga-keyframe.sh (pose stills) and saga-flf.sh
# (animate between them), then concats → (optional) RIFE → (optional) ESRGAN.
#
# ── YOU PROVIDE (edit the CONFIG block) ─────────────────────────────────────
#   REF   : an Exodia identity image (IP-Adapter anchor)
#   SEAL1..SEAL5 : five cropped seal images from your reference sheet (the hand
#                  drawings — one per file). Prayer/orb keyframes are prompt-driven
#                  (no seal control needed).
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KF="$HERE/saga-keyframe.sh"; FLF="$HERE/saga-flf.sh"
[ -x "$KF" ] || KF="bash $KF"; [ -x "$FLF" ] || FLF="bash $FLF"

# ── CONFIG ──────────────────────────────────────────────────────────────────
REF="${REF:-$SAGA_ROOT/tmp/exodia_ref.png}"
SEAL1="${SEAL1:-$SAGA_ROOT/tmp/seal_tiger.png}"
SEAL2="${SEAL2:-$SAGA_ROOT/tmp/seal_serpent.png}"
SEAL3="${SEAL3:-$SAGA_ROOT/tmp/seal_dragon.png}"
SEAL4="${SEAL4:-$SAGA_ROOT/tmp/seal_ram.png}"
SEAL5="${SEAL5:-$SAGA_ROOT/tmp/seal_boar.png}"
SEED="${SEED:-777}"
W="${W:-1280}"; H="${H:-704}"; FPS="${FPS:-16}"
WORK="$SAGA_ROOT/tmp/jutsu"; mkdir -p "$WORK"

BASE="Exodia the Forbidden One, golden armored egyptian anime god, glowing red eyes, ornate gold headdress with blue gem, pink and gold plating, cel shaded anime, 2d, flat colors, dark background, embers, dramatic lighting, masterpiece"

echo "════════ 20s JUTSU (keyframe/FLF) — seed $SEED ════════"

# ── 1. KEYFRAMES (pose stills) ──────────────────────────────────────────────
# seals: control-forced hand poses; prayer/orb: prompt-driven identity poses.
gen_kf(){ # <out> <prompt-extra> [control-image]
  local out="$1" extra="$2" ctrl="${3:-}"
  local args=(-o "$out" -s "$SEED" -W "$W" -H "$H" -r "$REF" -p "$BASE, $extra")
  [ -n "$ctrl" ] && args+=(-c "$ctrl" --control-pre dwpose --control-strength 0.85)
  $KF "${args[@]}" >/dev/null && echo "$SAGA_ROOT/tmp/${out}.png"
}
echo "▶ keyframes…"
K1=$(gen_kf jutsu_k1 "both hands forming a ninja hand seal, fingers interlocked, tiger seal, intense focus" "$SEAL1")
K2=$(gen_kf jutsu_k2 "both hands forming a ninja hand seal, serpent seal, hands clasped" "$SEAL2")
K3=$(gen_kf jutsu_k3 "both hands forming a ninja hand seal, dragon seal" "$SEAL3")
K4=$(gen_kf jutsu_k4 "both hands forming a ninja hand seal, ram seal, index fingers up" "$SEAL4")
K5=$(gen_kf jutsu_k5 "both hands forming a ninja hand seal, boar seal, fists together" "$SEAL5")
K6=$(gen_kf jutsu_k6 "both hands pressed flat together in prayer position at center, gathering purple energy, faint glow between the palms")
K7=$(gen_kf jutsu_k7 "hands slightly apart, a small swirling purple energy orb forming between the palms, rasengan, glowing")
K8=$(gen_kf jutsu_k8 "hands held wide apart, a large swirling purple energy sphere between the palms, rasengan, crackling purple lightning, energy flowing, radiant glow")

# ── 2. HOLDS (freeze a keyframe for N frames) ───────────────────────────────
hold(){ # <still.png> <frames> <out.mp4>
  local png="$1" n="$2" out="$3"
  ffmpeg -y -loop 1 -i "$png" -t "$(awk -v n="$n" -v f="$FPS" 'BEGIN{printf "%.4f", n/f}')" \
    -r "$FPS" -s "${W}x${H}" -c:v libx264 -pix_fmt yuv420p "$out" >/dev/null 2>&1 || { echo "❌ hold failed"; exit 1; }
  echo "$out"
}

# ── 3. FLF TRANSITIONS + assembly order (320 frames = 20.0s) ────────────────
SEAL_MOTION="both hands smoothly change to the next ninja hand seal, precise finger movement"
declare -a CLIPS
echo "▶ hold + transitions…"
CLIPS+=( "$(hold "$K1" 8 "$WORK/s00_hold1.mp4")" )
CLIPS+=( "$($FLF -o s01 -a "$K1" -b "$K2" -L 40 --fps "$FPS" -s "$SEED" -p "$SEAL_MOTION"; echo "$SAGA_ROOT/tmp/s01.mp4")" )
CLIPS+=( "$($FLF -o s02 -a "$K2" -b "$K3" -L 40 --fps "$FPS" -s "$SEED" -p "$SEAL_MOTION"; echo "$SAGA_ROOT/tmp/s02.mp4")" )
CLIPS+=( "$($FLF -o s03 -a "$K3" -b "$K4" -L 40 --fps "$FPS" -s "$SEED" -p "$SEAL_MOTION"; echo "$SAGA_ROOT/tmp/s03.mp4")" )
CLIPS+=( "$($FLF -o s04 -a "$K4" -b "$K5" -L 40 --fps "$FPS" -s "$SEED" -p "$SEAL_MOTION"; echo "$SAGA_ROOT/tmp/s04.mp4")" )
CLIPS+=( "$($FLF -o s05 -a "$K5" -b "$K6" -L 40 --fps "$FPS" -s "$SEED" -p "both hands come together into prayer position, energy gathering at the center"; echo "$SAGA_ROOT/tmp/s05.mp4")" )
CLIPS+=( "$(hold "$K6" 16 "$WORK/s06_hold6.mp4")" )
CLIPS+=( "$($FLF -o s07 -a "$K6" -b "$K7" -L 40 --fps "$FPS" -s "$SEED" -p "the hands separate, a purple energy orb forms and swirls between the palms"; echo "$SAGA_ROOT/tmp/s07.mp4")" )
CLIPS+=( "$($FLF -o s08 -a "$K7" -b "$K8" -L 48 --fps "$FPS" -s "$SEED" -p "the purple energy orb grows larger, swirling and flowing with crackling energy, radiant"; echo "$SAGA_ROOT/tmp/s08.mp4")" )
CLIPS+=( "$(hold "$K8" 8 "$WORK/s09_hold8.mp4")" )

# ── 4. CONCAT → master ──────────────────────────────────────────────────────
LIST="$WORK/concat.txt"; : > "$LIST"
for c in "${CLIPS[@]}"; do [ -f "$c" ] || { echo "❌ missing clip: $c"; exit 1; }; echo "file '$c'" >> "$LIST"; done
MASTER="$WORK/jutsu_20s_master.mp4"
ffmpeg -y -f concat -safe 0 -i "$LIST" -c:v libx264 -pix_fmt yuv420p -r "$FPS" "$MASTER" >/dev/null 2>&1 \
  || { echo "❌ concat failed"; exit 1; }
echo "✅ master (raw, ${FPS}fps): $MASTER"

# ── 5. POLISH (uses your existing box scripts if present) ───────────────────
# Pipeline planner's recommendation for a FINAL clip: interpolate (16→ higher) +
# upscale to 2K. Hands were already pinned+clean at the keyframes, so per-frame
# detail is optional here.
if [ -x "$HERE/saga-interpolate.sh" ]; then
  echo "▶ RIFE interpolate…"; "$HERE/saga-interpolate.sh" "$MASTER" || echo "⚠️ interpolate step skipped"
else
  echo "ℹ next: RIFE interpolate  →  saga-interpolate.sh \"$MASTER\""
fi
if [ -x "$HERE/saga-esrgan-video.sh" ]; then
  echo "▶ ESRGAN 2K upscale…"; "$HERE/saga-esrgan-video.sh" "$MASTER" || echo "⚠️ upscale step skipped"
else
  echo "ℹ next: ESRGAN 2K upscale →  saga-esrgan-video.sh \"$MASTER\""
fi
echo "════════ done — review $MASTER ════════"
