// File: migrations/004_auth_users.ts
// ============================================================================
// DINA AUTH — USERS, SESSIONS, AND CREDENTIAL-FLOW TOKENS  (shared-DB safe)
// ============================================================================
// CRITICAL CONTEXT — this database is SHARED with mirror-server.
//   The `users` table in this database is owned and populated by mirror-server
//   (the Admin panel creates "simulated" Mirror users by calling mirror-server's
//   internal /mirror/api/admin/simulation API, which does the INSERT INTO users).
//   It already holds real accounts. DINA therefore MUST NOT recreate, alter the
//   shape of, or drop `users` / `user_sessions`. It reuses them as-is.
//
// Why the previous version failed:
//   Mirror created `users` with `id INT NOT NULL AUTO_INCREMENT` (SIGNED). The
//   old migration declared its FK columns as `BIGINT UNSIGNED`, so MySQL refused
//   the foreign keys — "Referencing column 'user_id' and referenced column 'id'
//   in foreign key constraint 'fk_evt_user' are incompatible."
//
// How this version is correct AND robust:
//   1. It DETECTS the real column type of `users.id` at run time and uses it
//      verbatim for every `user_id` FK column. This can never drift out of sync
//      with whatever mirror-server actually created — INT, INT UNSIGNED, BIGINT,
//      whatever the live table has, the FK columns match it exactly.
//   2. Every table is CREATE TABLE IF NOT EXISTS behind a tableExists() guard,
//      so on the live shared DB (where Mirror already made these) it is a clean
//      skip, and on a fresh standalone DINA DB it creates Mirror-COMPATIBLE
//      tables (identical column names/types to mirror-server migrations 011/013
//      and its authController), so the two services interoperate on one schema.
//   3. down() is a guarded NO-OP. Auto-dropping a `users` table shared with a
//      live, account-holding sister service is a footgun; reverting DINA must
//      never destroy Mirror's data. Manual, deliberate teardown only.
//
// Column conventions matched to mirror-server (verified against its source):
//   users              — INSERT (username, email, password_hash); login stamps
//                        `last_login`; lock via account_locked/locked_until;
//                        email_verified TINYINT(1); role VARCHAR.
//   user_sessions      — revoked BOOLEAN + revoked_at (NOT a nullable-token
//                        model); session_id, user_agent, ip_address,
//                        device_fingerprint, expires_at, created_at.
//   email_verification_tokens — plaintext `token` CHAR(64) (secret is the inbox)
//   password_reset_tokens     — `token_hash` CHAR(64) = SHA-256(token); the
//                        plaintext never touches the DB; + ip_address/user_agent
//   pending_email_changes     — new_email + plaintext `token` CHAR(64)
// ============================================================================

import type { Connection } from 'mysql2/promise';
import { Migration } from './types';
import { tableExists } from './helpers';

/**
 * The exact SQL column type of `users.id`, read live from information_schema
 * (e.g. "int", "int unsigned", "bigint unsigned"). Every FK `user_id` column is
 * declared with this identical type so MySQL accepts the foreign key regardless
 * of how the shared `users` table was originally created. Falls back to plain
 * "int" only when `users` does not yet exist (fresh standalone DINA DB), which
 * matches the users table this migration would then create.
 */
async function usersIdType(conn: Connection): Promise<string> {
  const [rows] = await conn.query(
    `SELECT column_type FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'id'`,
  );
  const arr = rows as Array<Record<string, any>>;
  if (!arr || arr.length === 0) return 'int';
  const raw = String(Object.values(arr[0])[0] ?? '').trim();
  // column_type is like "int", "int(11)", "int unsigned", "bigint unsigned".
  // Strip the display-width "(n)" (deprecated in MySQL 8) but keep "unsigned".
  const t = raw.replace(/\(\d+\)/, '').toLowerCase().trim();
  return t.length > 0 ? t : 'int';
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
    // On the live shared DB this is skipped (Mirror owns it). On a fresh
    // standalone DINA DB, create a Mirror-compatible minimal accounts table.
    // NOTE: id is INT SIGNED to match mirror-server; auth-relevant columns only.
    await createTable(
      conn,
      'users',
      `CREATE TABLE IF NOT EXISTS users (
        id              INT          NOT NULL AUTO_INCREMENT,
        username        VARCHAR(64)  NOT NULL,
        email           VARCHAR(320) NOT NULL,
        password_hash   VARCHAR(255) NOT NULL,
        email_verified  TINYINT(1)   NOT NULL DEFAULT 0,
        account_locked  TINYINT(1)   NOT NULL DEFAULT 0,
        locked_until    DATETIME     NULL DEFAULT NULL,
        role            VARCHAR(24)  NOT NULL DEFAULT 'user',
        last_login      DATETIME     NULL DEFAULT NULL,
        last_active     DATETIME     NULL DEFAULT NULL,
        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_username (username),
        UNIQUE KEY uq_users_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );

    // Resolve the real FK type AFTER users is guaranteed to exist (either it
    // already did, or we just created it as INT). Everything below matches it.
    const idType = await usersIdType(conn);
    console.log(`   ↳ users.id resolved as "${idType}" — FK user_id columns will match`);

    // ── user_sessions ────────────────────────────────────────────────────
    // Matches mirror-server's authController schema (revoked BOOLEAN model).
    await createTable(
      conn,
      'user_sessions',
      `CREATE TABLE IF NOT EXISTS user_sessions (
        id                  ${idType} NOT NULL AUTO_INCREMENT,
        user_id             ${idType} NOT NULL,
        session_id          CHAR(36)     NOT NULL,
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
        id          ${idType} NOT NULL AUTO_INCREMENT,
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
        id          ${idType} NOT NULL AUTO_INCREMENT,
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
        id          ${idType} NOT NULL AUTO_INCREMENT,
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
  // Deliberately a NO-OP. This database is SHARED with mirror-server: `users`
  // and `user_sessions` hold live accounts and sessions, and the token tables
  // may be relied on by mirror-server too. A `migrate:down` must never silently
  // destroy a sister service's data. If a genuine teardown is intended, drop the
  // specific tables by hand after confirming no other service depends on them.
  async down(_conn: Connection): Promise<void> {
    console.log(
      '   ⚠ down() is a no-op for 004_auth_users: `users`/`user_sessions` and the\n' +
        '     auth token tables are SHARED with mirror-server and hold live data.\n' +
        '     Refusing to auto-drop. Drop manually if you are certain it is safe.',
    );
  },
};

export default migration;
