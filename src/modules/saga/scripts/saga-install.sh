#!/usr/bin/env bash
# ============================================================================
# saga-install.sh — publish the saga-*.sh tools to a stable run location on PATH
# ----------------------------------------------------------------------------
# Gives you ONE fixed place to run every saga tool from — $SAGA_ROOT/bin — decoupled
# from wherever the repo happens to be checked out (/var/www/dina-server today). Add
# that ONE dir to PATH once and every `saga-…` command works, forever.
#
# WHY WRAPPERS (default), not raw copies:
#   The tools resolve resources RELATIVE TO THEIR OWN LOCATION —
#     • saga-jutsu-flf.sh calls sibling  $HERE/saga-flf.sh, saga-framepack.sh, …
#     • saga-video-lora-train.sh reads   $HERE/../training/*.toml.tmpl
#   A flat copy into one folder sets $HERE to that folder → ../training breaks, and a
#   copy silently DRIFTS from the repo the moment the repo is updated. A wrapper execs
#   the real repo script in place, so $HERE stays the repo scripts dir (every relative
#   path resolves) AND behavior tracks the repo — `git pull` updates the tools with no
#   re-install. Install once; never re-run after a pull.
#
#   saga-install.sh [--bin DIR] [--copy] [--check] [--force]
#     --bin DIR   run location (default $SAGA_ROOT/bin)
#     --copy      physical snapshot instead of wrappers (self-contained but DRIFTS —
#                 re-run after every repo update; also mirrors ../training so the
#                 trainer keeps working)
#     --check     report install state (target dir, count, stale/broken links) and exit
#     --force     overwrite existing entries without prompting (default: overwrite anyway,
#                 --force just also clears unrelated non-saga files it created earlier)
#
# Env: SAGA_ROOT (required)
# ============================================================================
set -uo pipefail
: "${SAGA_ROOT:?set SAGA_ROOT (the runtime data tree, e.g. /mnt/.../SAGA)}"

# This script's real dir = the repo scripts dir (resolve through a symlink if invoked via one).
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do d="$(cd -P "$(dirname "$SELF")" && pwd)"; SELF="$(readlink "$SELF")"; [[ "$SELF" != /* ]] && SELF="$d/$SELF"; done
SRC="$(cd -P "$(dirname "$SELF")" && pwd)"

BIN="$SAGA_ROOT/bin"; MODE="wrapper"; CHECK=0; FORCE=0
die(){ echo "❌ $*" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in
  --bin) BIN="$2"; shift 2;;
  --copy) MODE="copy"; shift;;
  --check) CHECK=1; shift;;
  --force) FORCE=1; shift;;
  -h|--help) sed -n '2,33p' "$0"; exit 0;;
  *) die "unknown arg: $1 (see --help)";;
esac; done

# tools to publish: EVERY saga-*.sh in the repo scripts dir, including this installer itself
# (so `saga-install.sh --check` / re-install work from PATH after the first run).
mapfile -t TOOLS < <(cd "$SRC" && ls saga-*.sh 2>/dev/null)
[ "${#TOOLS[@]}" -gt 0 ] || die "no saga-*.sh found in $SRC (is this the repo scripts dir?)"

# ---- --check: report state, don't touch anything -------------------------------
if [ "$CHECK" -eq 1 ]; then
  echo "SAGA install state"
  echo "  repo scripts : $SRC (${#TOOLS[@]} tools)"
  echo "  run location : $BIN"
  if [ ! -d "$BIN" ]; then echo "  status       : NOT INSTALLED (run: saga-install.sh)"; exit 0; fi
  on_path=no; case ":$PATH:" in *":$BIN:"*) on_path=yes;; esac
  echo "  on PATH      : $on_path$([ "$on_path" = no ] && echo "  → export PATH=\"$BIN:\$PATH\"")"
  missing=0; stale=0
  for t in "${TOOLS[@]}"; do
    dst="$BIN/$t"
    [ -e "$dst" ] || { echo "  ✗ missing: $t"; missing=$((missing+1)); continue; }
    if [ -L "$dst" ] || head -n3 "$dst" 2>/dev/null | grep -q 'saga-install.sh'; then
      grep -q "$SRC/$t" "$dst" 2>/dev/null || { [ "$(readlink "$dst" 2>/dev/null)" = "$SRC/$t" ] || { echo "  ⚠ stale target: $t (points elsewhere; re-run installer)"; stale=$((stale+1)); }; }
    fi
  done
  echo "  installed    : $(( ${#TOOLS[@]} - missing ))/${#TOOLS[@]} (missing=$missing, stale=$stale)"
  [ "$missing" -eq 0 ] && [ "$stale" -eq 0 ] && echo "  ✅ up to date"
  exit 0
fi

mkdir -p "$BIN" || die "cannot create $BIN"
echo "▶ publishing ${#TOOLS[@]} saga tools → $BIN  (mode=$MODE)"
echo "  source: $SRC"

if [ "$MODE" = "copy" ]; then
  # physical snapshot. Mirror ../training too so saga-video-lora-train.sh's $HERE/../training
  # (which becomes $BIN/../training after copy) still resolves. DRIFTS — re-run after updates.
  for t in "${TOOLS[@]}"; do cp -f "$SRC/$t" "$BIN/$t" && chmod +x "$BIN/$t" || die "copy failed: $t"; done
  if [ -d "$SRC/../training" ]; then
    TRAIN_DEST="$(cd "$BIN" && cd .. && pwd)/training"
    mkdir -p "$TRAIN_DEST" && cp -f "$SRC/../training/"* "$TRAIN_DEST/" 2>/dev/null \
      && echo "  mirrored training templates → $TRAIN_DEST" || echo "  ⚠ could not mirror ../training (trainer may fail in copy mode)"
  fi
  echo "  ⚠ COPY mode drifts from the repo — re-run 'saga-install.sh --copy' after every git pull"
else
  # thin exec-wrappers: $HERE inside the wrapped script stays the REPO dir → all relative
  # refs (siblings + ../training) resolve, and behavior tracks the repo (no re-install on pull).
  for t in "${TOOLS[@]}"; do
    cat > "$BIN/$t" <<WRAP
#!/usr/bin/env bash
# SAGA launcher — auto-generated by saga-install.sh. Do not edit.
# Runs the repo tool in place so it resolves siblings + ../training from the repo (no drift).
exec "$SRC/$t" "\$@"
WRAP
    chmod +x "$BIN/$t" || die "chmod failed: $t"
  done
fi

echo "✅ installed ${#TOOLS[@]} tools."
case ":$PATH:" in
  *":$BIN:"*) echo "   $BIN is already on PATH.";;
  *) echo "   Add to PATH (this shell + persist):"
     echo "     export PATH=\"$BIN:\$PATH\""
     echo "     echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.bashrc";;
esac
echo "   Verify:  saga-jutsu-flf.sh --help | head -1"
