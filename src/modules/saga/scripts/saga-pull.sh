#!/usr/bin/env bash
# ============================================================================
# saga-pull.sh — sync the pod's SAGA tooling from the public dina-server repo.
# ----------------------------------------------------------------------------
# The pod runs a flat /workspace/SAGA/scripts; the repo keeps the scripts under
# src/modules/saga/. This pulls the latest (shallow, sparse — only the saga subtree)
# and copies scripts + video manifests into place. dina-server is PUBLIC, so this
# needs no git credentials. Run it whenever the repo tooling has moved.
#
#   saga-pull.sh                     # sync the dev branch (default below)
#   SAGA_BRANCH=main saga-pull.sh    # sync a different branch
#
# Env: SAGA_ROOT (default /workspace/SAGA), SAGA_REPO, SAGA_BRANCH, SAGA_REPO_CACHE.
# It installs itself too, so after the one-time bootstrap you just run `saga-pull.sh`.
# ============================================================================
set -uo pipefail
SAGA_ROOT="${SAGA_ROOT:-/workspace/SAGA}"
REPO="${SAGA_REPO:-https://github.com/gabrielgomez33/dina-server}"
BRANCH="${SAGA_BRANCH:-claude/dina-server-analysis-9wjtkc}"
CACHE="${SAGA_REPO_CACHE:-$SAGA_ROOT/.repo}"
SUB="src/modules/saga"
die(){ echo "❌ $*" >&2; exit 1; }
command -v git >/dev/null || die "git required"

echo "▶ saga-pull: $REPO @ $BRANCH"
if [ -d "$CACHE/.git" ]; then
  git -C "$CACHE" remote set-url origin "$REPO" 2>/dev/null || true
  git -C "$CACHE" sparse-checkout set "$SUB" 2>/dev/null || true
  git -C "$CACHE" fetch --depth 1 origin "$BRANCH" || die "fetch failed (network?)"
  git -C "$CACHE" checkout -q -B "$BRANCH" FETCH_HEAD || die "checkout failed"
else
  rm -rf "$CACHE"
  git clone --depth 1 --filter=blob:none --sparse -b "$BRANCH" "$REPO" "$CACHE" \
    || die "clone failed (network? branch '$BRANCH' exists?)"
  git -C "$CACHE" sparse-checkout set "$SUB" || die "sparse-checkout failed"
fi
HEAD=$(git -C "$CACHE" rev-parse --short HEAD)
SRC="$CACHE/$SUB"
[ -d "$SRC/scripts" ] || die "repo layout unexpected: $SRC/scripts not found"

mkdir -p "$SAGA_ROOT/scripts" "$SAGA_ROOT/videos" "$SAGA_ROOT/docs"
cp -f "$SRC/scripts/"* "$SAGA_ROOT/scripts/" 2>/dev/null || true
chmod +x "$SAGA_ROOT/scripts/"*.sh 2>/dev/null || true
[ -d "$SRC/videos" ] && cp -f "$SRC/videos/"* "$SAGA_ROOT/videos/" 2>/dev/null || true
[ -d "$SRC/docs" ]   && cp -f "$SRC/docs/"*   "$SAGA_ROOT/docs/"   2>/dev/null || true

echo "✅ synced @ $HEAD → $SAGA_ROOT/{scripts,videos,docs}"
echo "  scripts:"; ls "$SAGA_ROOT/scripts/" | grep -E '^saga-' | sed 's/^/    /'
