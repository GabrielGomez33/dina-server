#!/usr/bin/env bash
# ============================================================================
# ops/install-redis-stack.sh
# Helper to get RediSearch (Redis Stack) running for DINA semantic memory.
# Safe: it INSPECTS first and never destroys existing data. It prefers Docker;
# if Docker is absent it prints native-install guidance and exits.
#
# Usage:
#   ./ops/install-redis-stack.sh check      # just report current state
#   ./ops/install-redis-stack.sh docker     # start redis-stack-server in Docker
# See ops/REDIS_STACK_RUNBOOK.md for full details and native install.
# ============================================================================
set -euo pipefail

REDIS_CLI="${REDIS_CLI:-redis-cli}"
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
CONTAINER_NAME="${CONTAINER_NAME:-dina-redis}"
IMAGE="${IMAGE:-redis/redis-stack-server:latest}"

log()  { printf '\033[0;36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m⚠️  %s\033[0m\n' "$*"; }
err()  { printf '\033[0;31m❌ %s\033[0m\n' "$*"; }

check_redisearch() {
  if ! command -v "$REDIS_CLI" >/dev/null 2>&1; then
    warn "redis-cli not found; cannot verify RediSearch from here."
    return 2
  fi
  if "$REDIS_CLI" -h "$REDIS_HOST" -p "$REDIS_PORT" FT._LIST >/dev/null 2>&1; then
    ok "RediSearch is available on ${REDIS_HOST}:${REDIS_PORT} — DINA will use native vector search."
    return 0
  fi
  warn "RediSearch NOT detected on ${REDIS_HOST}:${REDIS_PORT} (DINA will use the in-process fallback)."
  return 1
}

cmd="${1:-check}"
case "$cmd" in
  check)
    log "🔍 Checking Redis + RediSearch..."
    check_redisearch || true
    ;;
  docker)
    if ! command -v docker >/dev/null 2>&1; then
      err "Docker not installed. See ops/REDIS_STACK_RUNBOOK.md section 2B/2C for a native install."
      exit 1
    fi
    if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
      warn "Container '${CONTAINER_NAME}' already exists — starting it if stopped."
      docker start "$CONTAINER_NAME" >/dev/null
    else
      log "🚀 Starting ${IMAGE} as '${CONTAINER_NAME}' on port ${REDIS_PORT}..."
      docker run -d --name "$CONTAINER_NAME" \
        -p "${REDIS_PORT}:6379" \
        -v dina-redis-data:/data \
        --restart unless-stopped \
        "$IMAGE" >/dev/null
    fi
    sleep 2
    check_redisearch || true
    log "Point DINA at it with: REDIS_URL=redis://${REDIS_HOST}:${REDIS_PORT}"
    ;;
  *)
    err "Unknown command '${cmd}'. Use: check | docker"
    exit 1
    ;;
esac
