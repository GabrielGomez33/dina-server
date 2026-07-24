// File: migrations/004_auth_users.ts
// ============================================================================
// DINA AUTH — SESSIONS + CREDENTIAL-FLOW TOKENS (on DINA's OWN users table)
// ============================================================================
// TOPOLOGY (corrected):
//   DINA and Mirror do NOT share a database. Mirror is a separate module with
//   its OWN `mirror` database and its own `users` table; it talks to DINA over
//   the wire. This migration operates ONLY on DINA's `dina` database.
//
//   DINA already has its own `users` table, created by the app's schema
//   bootstrap (src/config/database/db.ts). Its real shape is:
//     id VARCHAR(36) PRIMARY KEY DEFAULT (UUID())   -- UUID string, NOT an int
//     email VARCHAR(255) UNIQUE, username VARCHAR(100), password_hash VARCHAR(255),
//     salt, last_login, failed_login_attempts, locked_until, is_active,
//     security_clearance ENUM(...)                   -- no email_verified/role
//
// Why the first attempt failed:
//   The token tables declared `user_id BIGINT UNSIGNED` referencing
//   `users.id VARCHAR(36)` — incompatible ("Referencing column 'user_id' and
//   referenced column 'id' ... incompatible", errno 150).
//
// How this version is correct AND robust:
//   1. DETECT the real column type of `users.id` at run time (VARCHAR(36) here,
//      but INT/BIGINT-safe too) and use it VERBATIM — length included — for every
//      `user_id` FK column. See normalizeColType: char/varchar lengths are kept.
//   2. Do NOT recreate DINA's `users` table when it exists; only ADD the two
//      auth columns it lacks (`email_verified`, `role`) via addColumnIfMissing.
//      On a fresh standalone DB, create a users table matching DINA's UUID shape.
//   3. Create `user_sessions` + the three credential-token tables IF NOT EXISTS,
//      with `user_id` matching users.id exactly.
//   4. down() is a guarded NO-OP — it never drops `users` (may hold accounts).
//
// Token-table conventions (proven design, from mirror-server migration 011/013):
//   email_verification_tokens — plaintext `token` CHAR(64) (secret is the inbox)
//   password_reset_tokens     — `token_hash` CHAR(64) = SHA-256(token); plaintext
//                        never touches the DB; + ip_address/user_agent forensics
//   pending_email_changes     — new_email + plaintext `token` CHAR(64)
// ============================================================================

import type { Connection } from 'mysql2/promise';
import { Migration } from './types';
import { tableExists, addColumnIfMissing } from './helpers';

/**
 * The exact SQL column type of `users.id`, read live from information_schema
 * (e.g. "varchar(36)", "int", "bigint unsigned"). Every FK `user_id` column is
 * declared with this identical type so MySQL accepts the foreign key regardless
 * of how `users` was created. Falls back to "varchar(36)" (DINA's UUID default)
 * only when `users` does not yet exist — matching the table this migration then
 * creates.
 */
async function usersIdType(conn: Connection): Promise<string> {
  const [rows] = await conn.query(
    `SELECT column_type FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'id'`,
  );
  const arr = rows as Array<Record<string, any>>;
  if (!arr || arr.length === 0) return 'varchar(36)';
  const raw = String(Object.values(arr[0])[0] ?? '').trim();
  return normalizeColType(raw);
}

/**
 * Normalise a column_type for reuse as an FK column type.
 *   - Integer family ("int(11)", "bigint(20) unsigned"): drop the meaningless
 *     display width, keep signedness → "int", "bigint unsigned".
 *   - Everything else (VARCHAR(36), CHAR(36), decimal(p,s), …): keep VERBATIM.
 *     The length is SEMANTIC — a VARCHAR(36) FK to a VARCHAR(36) PK must be
 *     exactly VARCHAR(36); stripping "(36)" yields invalid "varchar" DDL.
 * DINA's real users.id is VARCHAR(36) (UUID), so this distinction is load-bearing.
 */
export function normalizeColType(raw: string): string {
  const t = String(raw ?? '').toLowerCase().trim();
  if (t.length === 0) return 'varchar(36)';
  if (/^(tinyint|smallint|mediumint|int|integer|bigint)\b/.test(t)) {
    return t.replace(/\(\d+\)/, '').replace(/\s+/g, ' ').trim();
  }
  return t;
}

async function createTable(conn: Connection, name: string, ddl: string): Promise<void> {
  if (await tableExists(conn, name)) {
    console.log(`   • ${name} already exists — skipping (owned/shared, left untouched)`);
    return;
  }
  await conn.query(ddl);
  console.log(`   ✓ created ${name}`);
}

const migration: Migration = {
  id: 4,
  name: 'auth_users',

  async up(conn: Connection): Promise<void> {
    // ── users ────────────────────────────────────────────────────────────
    // Normally SKIPPED: DINA's app bootstrap already created `users` (UUID id).
    // Only on a fresh standalone DB (users absent) do we create it, matching
    // DINA's real UUID shape so both paths converge on the same schema.
    await createTable(
      conn,
      'users',
      `CREATE TABLE IF NOT EXISTS users (
        id              VARCHAR(36)  NOT NULL DEFAULT (UUID()),
        email           VARCHAR(255) NULL,
        username        VARCHAR(100) NULL,
        password_hash   VARCHAR(255) NULL,
        salt            VARCHAR(32)  NULL,
        created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        last_login      TIMESTAMP    NULL,
        failed_login_attempts INT    NOT NULL DEFAULT 0,
        locked_until    TIMESTAMP    NULL,
        is_active       TINYINT(1)   NOT NULL DEFAULT 1,
        email_verified  TINYINT(1)   NOT NULL DEFAULT 0,
        role            VARCHAR(24)  NOT NULL DEFAULT 'user',
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );

    // DINA's existing `users` table lacks the two columns the auth module needs.
    // Add them idempotently — non-destructive, safe on a table with live rows.
    const addedVerified = await addColumnIfMissing(
      conn,
      'users',
      'email_verified',
      'email_verified TINYINT(1) NOT NULL DEFAULT 0',
    );
    if (addedVerified) console.log('   ✓ users.email_verified added');
    const addedRole = await addColumnIfMissing(conn, 'users', 'role', "role VARCHAR(24) NOT NULL DEFAULT 'user'");
    if (addedRole) console.log('   ✓ users.role added');

    // Resolve the real FK type AFTER users is guaranteed to exist. VARCHAR(36)
    // on the live DB; the length is preserved (see normalizeColType).
    const idType = await usersIdType(conn);
    console.log(`   ↳ users.id resolved as "${idType}" — FK user_id columns will match`);

    // ── user_sessions ────────────────────────────────────────────────────
    // Matches mirror-server's authController schema (revoked BOOLEAN model).
    await createTable(
      conn,
      'user_sessions',
      `CREATE TABLE IF NOT EXISTS user_sessions (
        id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id             ${idType} NOT NULL,
        session_id          CHAR(64)     NOT NULL,
        user_agent          VARCHAR(255) NULL DEFAULT NULL,
        ip_address          VARCHAR(64)  NULL DEFAULT NULL,
        device_fingerprint  VARCHAR(128) NULL DEFAULT NULL,
        revoked             TINYINT(1)   NOT NULL DEFAULT 0,
        revoked_at          DATETIME     NULL DEFAULT NULL,
        expires_at          DATETIME     NOT NULL,
        created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_sessions_session_id (session_id),
        KEY idx_sessions_user (user_id),
        KEY idx_sessions_expires (expires_at),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );

    // ── email_verification_tokens ────────────────────────────────────────
    // Plaintext single-use token (the security boundary is the user's inbox).
    // Matches mirror-server migration 011.
    await createTable(
      conn,
      'email_verification_tokens',
      `CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id     ${idType} NOT NULL,
        token       CHAR(64)     NOT NULL,
        expires_at  DATETIME     NOT NULL,
        used_at     DATETIME     NULL DEFAULT NULL,
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_evt_token (token),
        KEY idx_evt_user_pending (user_id, used_at, expires_at),
        KEY idx_evt_expires (expires_at),
        CONSTRAINT fk_evt_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );

    // ── password_reset_tokens ────────────────────────────────────────────
    // Stores SHA-256(token); the plaintext lives only in the email body.
    // Matches mirror-server migration 011 (token_hash + ip/ua forensics).
    await createTable(
      conn,
      'password_reset_tokens',
      `CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id     ${idType} NOT NULL,
        token_hash  CHAR(64)     NOT NULL,
        expires_at  DATETIME     NOT NULL,
        used_at     DATETIME     NULL DEFAULT NULL,
        ip_address  VARCHAR(64)  NULL DEFAULT NULL,
        user_agent  VARCHAR(255) NULL DEFAULT NULL,
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_prt_token_hash (token_hash),
        KEY idx_prt_user_pending (user_id, used_at, expires_at),
        KEY idx_prt_expires (expires_at),
        CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );

    // ── pending_email_changes ────────────────────────────────────────────
    // Re-verify email-change model. Matches mirror-server migration 013.
    await createTable(
      conn,
      'pending_email_changes',
      `CREATE TABLE IF NOT EXISTS pending_email_changes (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id     ${idType} NOT NULL,
        new_email   VARCHAR(320) NOT NULL,
        token       CHAR(64)     NOT NULL,
        expires_at  DATETIME     NOT NULL,
        used_at     DATETIME     NULL DEFAULT NULL,
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_pec_token (token),
        KEY idx_pec_user_pending (user_id, used_at, expires_at),
        KEY idx_pec_expires (expires_at),
        CONSTRAINT fk_pec_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
  },

  // ── down ───────────────────────────────────────────────────────────────
  // Deliberately a NO-OP. `users` predates this migration (DINA's app bootstrap
  // owns it) and may hold live accounts; the two auth columns we add are
  // harmless to leave in place. A `migrate:down` must never silently destroy
  // account data or a column another code path now reads. If a genuine teardown
  // is intended, drop the specific token tables by hand after confirming nothing
  // depends on them; never drop `users`.
  async down(_conn: Connection): Promise<void> {
    console.log(
      '   ⚠ down() is a no-op for 004_auth_users: `users` predates this migration\n' +
        '     and may hold live accounts. Refusing to auto-drop. Drop the token\n' +
        '     tables manually if you are certain it is safe.',
    );
  },
};

export default migration;
