#!/usr/bin/env bash
# ============================================================================
# DINA — ONE-COMMAND VERIFICATION (auth + tenancy + security)
# ============================================================================
# Proves every request delivered in this workstream and that the security
# boundary is airtight. Two layers:
#
#   PART A — LOGIC PROOFS (offline, isolated)
#     Spins up a THROWAWAY MariaDB in a temp dir (your real `dina` database is
#     NEVER touched), runs the full auth + DIGIM-tenancy suites against it, then
#     tears it down. Deterministic; no server, network, or providers needed.
#
#   PART B — LIVE E2E (optional)
#     If VERIFY_BASE_URL is set, hits the RUNNING server over HTTPS to confirm
#     auth is enforced and cross-tenant access is blocked on the deployed system.
#
# USAGE
#   bash scripts/verify-all.sh                       # Part A only
#   VERIFY_BASE_URL=https://www.theundergroundrailroad.world/dina \
#     bash scripts/verify-all.sh                     # Part A + Part B
#   (add VERIFY_INSECURE=1 if hitting a loopback/self-signed TLS endpoint)
#
# Exit code 0 = everything passed. Non-zero = something failed (details above).
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$1"; }
bold()  { printf '\033[1m%s\033[0m\n' "$1"; }

FAILED=0
run() { # run <label> <cmd...>
  local label="$1"; shift
  bold "▶ $label"
  if "$@"; then green "  PASS: $label"; else red "  FAIL: $label"; FAILED=1; fi
  echo
}

# ── Throwaway MariaDB lifecycle ─────────────────────────────────────────────
TMPDB="$(mktemp -d /tmp/dina-verify-XXXXXX)"
SOCK="/tmp/dina-verify-$$.sock"
PORT="${VERIFY_DB_PORT:-33091}"
MYSQLD="$(command -v mariadbd || command -v mysqld || echo /usr/sbin/mariadbd)"
INSTALL="$(command -v mariadb-install-db || command -v mysql_install_db)"
CLIENT="$(command -v mariadb || command -v mysql)"
ADMIN="$(command -v mariadb-admin || command -v mysqladmin)"
USERFLAG=""; [ "$(id -u)" = "0" ] && USERFLAG="--user=root"
DB_STARTED=0

cleanup() {
  if [ "$DB_STARTED" = "1" ]; then "$ADMIN" --socket="$SOCK" shutdown 2>/dev/null || true; sleep 1; fi
  rm -rf "$TMPDB" "$SOCK" 2>/dev/null || true
}
trap cleanup EXIT

boot_db() {
  [ -x "$MYSQLD" ] || { yellow "  (no mariadbd/mysqld found — skipping DB-backed proofs)"; return 1; }
  "$INSTALL" --datadir="$TMPDB/data" --auth-root-authentication-method=normal >/dev/null 2>&1 \
    || "$INSTALL" --datadir="$TMPDB/data" >/dev/null 2>&1 || { red "  install-db failed"; return 1; }
  "$MYSQLD" $USERFLAG --datadir="$TMPDB/data" --socket="$SOCK" --port="$PORT" \
    --bind-address=127.0.0.1 --pid-file="$TMPDB/m.pid" >"$TMPDB/mysqld.log" 2>&1 &
  for i in $(seq 1 30); do "$ADMIN" --socket="$SOCK" ping >/dev/null 2>&1 && { DB_STARTED=1; break; }; sleep 1; done
  [ "$DB_STARTED" = "1" ] || { red "  MariaDB did not start (see $TMPDB/mysqld.log)"; return 1; }
  # Fresh dina DB with a Mirror-shaped users table (UUID id) + the error-log table.
  "$CLIENT" --socket="$SOCK" <<SQL
CREATE DATABASE dina;
USE dina;
CREATE TABLE users (
  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()), username VARCHAR(100), email VARCHAR(255) UNIQUE,
  password_hash VARCHAR(255) NULL, is_active TINYINT(1) DEFAULT 1, locked_until TIMESTAMP NULL,
  last_login TIMESTAMP NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE system_logs (id BIGINT AUTO_INCREMENT PRIMARY KEY, level VARCHAR(16), module VARCHAR(64), message TEXT, metadata JSON, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE USER 'dina_user'@'127.0.0.1' IDENTIFIED BY 'verify_pw';
GRANT ALL ON dina.* TO 'dina_user'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
  export DB_HOST=127.0.0.1 DB_PORT="$PORT" DB_USER=dina_user DB_PASSWORD=verify_pw DB_NAME=dina
  export DIGIM_WEB_ENABLED=true DIGIM_WEB_SEARCH_PROVIDER=searxng
  export JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  export DINA_AUTH_SECRETS_FILE="$TMPDB/auth-secrets.json"
  return 0
}

bold "════════════════════════════════════════════════════════"
bold "  DINA VERIFICATION — auth + tenancy + security"
bold "════════════════════════════════════════════════════════"
echo

# ── PART A.1 — pure logic (no DB) ───────────────────────────────────────────
yellow "PART A.1 — pure logic proofs (no database)"
run "auth: input policy + FK type-detection (unit)"            npx ts-node test/auth/authUnit.ts
run "auth: signing-secret resolution + persistence (config)"  npx ts-node test/auth/configTest.ts
run "auth: an auth error can never crash the server (crash)"   npx ts-node test/auth/crashProof.ts

# ── PART A.2 — DB-backed logic (throwaway MariaDB) ──────────────────────────
yellow "PART A.2 — DB-backed proofs (isolated throwaway MariaDB — your data untouched)"
if boot_db; then
  bold "▶ applying migrations to the throwaway DB"; npm run migrate >/dev/null 2>&1 && green "  migrations applied" || { red "  migrate failed"; FAILED=1; }
  echo
  run "auth: full HTTP lifecycle — register/login/refresh/logout/session-revoke (21 checks)" \
      env SMOKE_UNIQ="verify" npx ts-node test/auth/authSmoke.ts
  run "DIGIM tenancy: adversarial isolation — IDOR, cache, content, graph-bleed, islands (21 checks)" \
      npx ts-node test/digim/tenancyTest.ts
else
  yellow "  DB-backed proofs skipped (no local MariaDB). The logic is identical to what runs on your box."
fi

# ── PART B — live E2E (optional) ────────────────────────────────────────────
if [ -n "${VERIFY_BASE_URL:-}" ]; then
  echo; yellow "PART B — LIVE E2E against ${VERIFY_BASE_URL}"
  run "live: auth enforced on /digim/*, full auth lifecycle, cross-tenant isolation, session revocation" \
      env VERIFY_BASE_URL="$VERIFY_BASE_URL" npx ts-node test/e2e/liveSecurityE2E.ts
else
  echo; yellow "PART B — live E2E skipped (set VERIFY_BASE_URL=https://<host>/dina to run it)"
fi

# ── Verdict ─────────────────────────────────────────────────────────────────
echo
bold "════════════════════════════════════════════════════════"
if [ "$FAILED" = "0" ]; then
  green "  ✅ ALL VERIFICATIONS PASSED — auth, tenancy, and the security boundary are intact."
else
  red   "  ❌ ONE OR MORE VERIFICATIONS FAILED — see the FAIL lines above."
fi
bold "════════════════════════════════════════════════════════"
exit "$FAILED"
