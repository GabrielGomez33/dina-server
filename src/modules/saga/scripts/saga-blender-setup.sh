#!/usr/bin/env bash
# ============================================================================
# saga-blender-setup.sh — install a portable headless Blender on the pod volume.
# ----------------------------------------------------------------------------
# The 3D pose-proxy pipeline (stages 2–4) runs Blender headless (-b -P) for
# remesh, rig, and batch depth/lineart/color renders. We use the official
# portable tarball (no apt, no root libs beyond the GL libs saga-trellis-setup
# already installed) extracted onto the persistent volume, and symlink it onto
# PATH so `blender` resolves everywhere.
#
#   bash saga-blender-setup.sh                 # install default series to $SAGA_ROOT/engine/blender
#   BLENDER_VER=4.2.5 bash saga-blender-setup.sh
#
# Override: SAGA_ROOT, BLENDER_VER (full x.y.z), BLENDER_SERIES (x.y), BLENDER_URL (full tarball URL).
# ============================================================================
set -euo pipefail
SAGA_ROOT="${SAGA_ROOT:-/workspace/SAGA}"
DEST="${DEST:-$SAGA_ROOT/engine/blender}"
BLENDER_VER="${BLENDER_VER:-4.2.5}"
BLENDER_SERIES="${BLENDER_SERIES:-${BLENDER_VER%.*}}"
BLENDER_URL="${BLENDER_URL:-https://download.blender.org/release/Blender${BLENDER_SERIES}/blender-${BLENDER_VER}-linux-x64.tar.xz}"
die(){ echo "❌ $*" >&2; exit 1; }

if [ -x "$DEST/blender" ]; then
  echo "✔ blender already at $DEST" >&2
  "$DEST/blender" --version | head -1 >&2
else
  echo "▶ downloading Blender $BLENDER_VER" >&2
  echo "  $BLENDER_URL" >&2
  mkdir -p "$DEST"
  tmp="$(mktemp -d)"
  if ! curl -fL "$BLENDER_URL" -o "$tmp/blender.tar.xz"; then
    die "download failed — pick a version that exists: BLENDER_VER=x.y.z bash $0
    (list: https://download.blender.org/release/Blender${BLENDER_SERIES}/ )"
  fi
  echo "  extracting…" >&2
  tar -xf "$tmp/blender.tar.xz" -C "$DEST" --strip-components=1
  rm -rf "$tmp"
  [ -x "$DEST/blender" ] || die "extract did not yield $DEST/blender"
fi

# symlink onto PATH (idempotent). Prefer /usr/local/bin; fall back to the saga scripts dir.
if ln -sf "$DEST/blender" /usr/local/bin/blender 2>/dev/null; then
  echo "  linked → /usr/local/bin/blender" >&2
else
  ln -sf "$DEST/blender" "$SAGA_ROOT/scripts/blender" 2>/dev/null || true
  echo "  linked → $SAGA_ROOT/scripts/blender (add scripts dir to PATH)" >&2
fi

echo "✔ blender ready" >&2
blender --version 2>/dev/null | head -1 >&2 || "$DEST/blender" --version | head -1 >&2
# headless smoke test (no GPU needed for remesh)
blender -b --python-expr "import bpy; print('  bpy OK', bpy.app.version_string)" 2>/dev/null | grep "bpy OK" >&2 \
  || "$DEST/blender" -b --python-expr "import bpy; print('  bpy OK', bpy.app.version_string)" | grep "bpy OK" >&2
