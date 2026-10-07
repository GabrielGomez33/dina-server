# saga-pod-init.sh — SOURCE this first on every fresh pod.
# ============================================================================
#   source /workspace/SAGA/scripts/saga-pod-init.sh
#
# We move pod-to-pod frequently (terminate when idle to avoid charges). The
# /workspace volume PERSISTS (all venvs, models, scripts, meshes), but the
# container overlay is EPHEMERAL — so a fresh pod loses: the system GL libraries
# (libEGL/libGL, needed by TRELLIS/nvdiffrast/moderngl/open3d/Blender), PATH,
# and the /usr/local/bin/blender symlink. This restores exactly those, idempotently.
#
# Safe to source (no exit / no set -e). Fast on a warm pod (skips apt when GL is present).
# ============================================================================

export SAGA_ROOT="${SAGA_ROOT:-/workspace/SAGA}"
export HF_HOME="${HF_HOME:-$SAGA_ROOT/hf_home/huggingface}"
export HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}"
export COMFY="${COMFY:-http://127.0.0.1:8188}"

# --- PATH: saga scripts + portable Blender ---
case ":$PATH:" in *":$SAGA_ROOT/scripts:"*) ;; *) export PATH="$SAGA_ROOT/scripts:$PATH";; esac
if [ -x "$SAGA_ROOT/engine/blender/blender" ]; then
  case ":$PATH:" in *":$SAGA_ROOT/engine/blender:"*) ;; *) export PATH="$SAGA_ROOT/engine/blender:$PATH";; esac
  ln -sf "$SAGA_ROOT/engine/blender/blender" /usr/local/bin/blender 2>/dev/null || true
fi

# --- repo sync: pull the latest scripts from GitHub so a fresh pod is always current ---
# Needs a READ-ONLY token on the volume (never committed): create it ONCE with
#   printf '%s' 'github_pat_xxx' > "$SAGA_ROOT/.gh_token" && chmod 600 "$SAGA_ROOT/.gh_token"
# (a fine-grained PAT with Contents:Read on GabrielGomez33/dina-server). Or export SAGA_GH_TOKEN.
# The token is read from that file, used ONLY via a per-command auth header (never written into
# git config or the remote URL), never echoed, and unset after. Any failure is soft: the pod
# keeps whatever scripts it already has and still works.
saga_sync_repo() {
  local url="https://github.com/GabrielGomez33/dina-server.git"
  local branch="${SAGA_REPO_BRANCH:-claude/dina-server-analysis-9wjtkc}"
  local dir="${SAGA_REPO_DIR:-$SAGA_ROOT/repo}"
  local token="${SAGA_GH_TOKEN:-}"
  [ -z "$token" ] && [ -f "$SAGA_ROOT/.gh_token" ] && token="$(tr -d '\r\n' < "$SAGA_ROOT/.gh_token" 2>/dev/null)"
  if [ -z "$token" ]; then
    echo "  ⚠ repo sync skipped (no token; create \$SAGA_ROOT/.gh_token to enable)"; return 0
  fi
  command -v git >/dev/null 2>&1 || { echo "  ⚠ repo sync skipped (git not installed)"; return 0; }
  local auth; auth="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
  if [ -d "$dir/.git" ]; then
    if git -c http.extraheader="$auth" -C "$dir" fetch -q --depth 1 origin "$branch" 2>/dev/null \
       && git -C "$dir" checkout -q -B "$branch" FETCH_HEAD 2>/dev/null; then
      echo "  ✓ repo updated ($branch)"
    else echo "  ⚠ repo update failed — keeping existing scripts"; unset auth token; return 0; fi
  else
    if git -c http.extraheader="$auth" clone -q --depth 1 --branch "$branch" "$url" "$dir" 2>/dev/null; then
      echo "  ✓ repo cloned ($branch)"
    else echo "  ⚠ repo clone failed (token/network?) — keeping existing scripts"; unset auth token; return 0; fi
  fi
  unset auth token
  local src="$dir/src/modules/saga/scripts"
  if [ -d "$src" ]; then
    mkdir -p "$SAGA_ROOT/scripts"
    if cp -f "$src"/* "$SAGA_ROOT/scripts/" 2>/dev/null; then echo "  ✓ scripts deployed from repo"; fi
  fi
}
saga_sync_repo

# --- system GL libs (ephemeral; required by trellis/nvdiffrast/moderngl/open3d/blender) ---
# idempotent: only apt-install when libEGL.so.1 is not already resolvable.
if ldconfig -p 2>/dev/null | grep -q 'libEGL\.so\.1'; then
  echo "  ✓ GL libs present"
else
  echo "  installing system GL libs (fresh pod)…"
  if apt-get update -qq >/dev/null 2>&1 && apt-get install -y --no-install-recommends \
       libegl1 libgl1 libgles2 libglvnd0 libglib2.0-0 libxrender1 libxi6 libxxf86vm1 libxfixes3 >/dev/null 2>&1; then
    echo "  ✓ GL libs installed"
  else
    echo "  ⚠ GL lib install failed — run: apt-get update && apt-get install -y libegl1 libgl1 libglib2.0-0"
  fi
fi

# --- imagemagick (for contact-sheet montage; ephemeral) — idempotent ---
if command -v montage >/dev/null 2>&1; then
  echo "  ✓ imagemagick present"
else
  if apt-get install -y --no-install-recommends imagemagick fonts-dejavu-core >/dev/null 2>&1; then
    echo "  ✓ imagemagick installed"
  else
    echo "  ⚠ imagemagick install failed — contact sheets will fall back to individual PNGs"
  fi
fi

# --- summary so you can see the pod is ready at a glance ---
echo "✔ SAGA pod ready  (SAGA_ROOT=$SAGA_ROOT, HF_HOME=$HF_HOME)"
command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | sed 's/^/  GPU:    /'
for e in TRELLIS UniRig ComfyUI blender; do
  [ -e "$SAGA_ROOT/engine/$e" ] && echo "  engine: $e ✓" || echo "  engine: $e MISSING (reinstall needed)"
done
command -v blender >/dev/null 2>&1 && echo "  blender:$(blender --version 2>/dev/null | head -1 | sed 's/^/ /')" || echo "  blender: not found"
echo "  venvs:  TRELLIS→ . \$SAGA_ROOT/engine/TRELLIS/.venv/bin/activate   (rig script self-activates UniRig)"
