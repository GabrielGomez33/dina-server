// File: migrations/004_auth_users.ts
// ============================================================================
// DINA AUTH — USERS, SESSIONS, AND CREDENTIAL-FLOW TOKENS
// ============================================================================
// Ports mirror-server's proven auth schema to DINA (its own separate accounts —
// user files live under /var/www/dina-storage; these tables hold the records).
//
//   users                       — the account (username, email, bcrypt hash)
//   user_sessions               — one row per device login; refresh/JWT session,
//                                 revocable individually or all-at-once
//   email_verification_tokens   — one-time email-verify links
//   password_reset_tokens       — one-time password-reset links
//   pending_email_changes       — email-change requests awaiting confirmation
//
// Idempotent: CREATE TABLE IF NOT EXISTS + a tableExists guard for clean logs.
// InnoDB + utf8mb4; FKs cascade so deleting a user cleans up its sessions/tokens.
// ============================================================================

import type { Connection } from 'mysql2/promise';
import { Migration } from './types';
import { tableExists } from './helpers';

async function createTable(conn: Connection, name: string, ddl: string): Promise<void> {
  if (await tableExists(conn, name)) {
    console.log(`   • ${name} already exists — skipping`);
    return;
  }
  await conn.query(ddl);
  console.log(`   ✓ created ${name}`);
}

const migration: Migration = {
  id: 4,
  name: 'auth_users',

  async up(conn: Connection): Promise<void> {
    await createTable(
      conn,
      'users',
      `CREATE TABLE IF NOT EXISTS users (
        id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        username        VARCHAR(64)  NOT NULL,
        email           VARCHAR(320) NOT NULL,
        password_hash   VARCHAR(255) NOT NULL,
        email_verified  TINYINT(1)   NOT NULL DEFAULT 0,
        role            VARCHAR(24)  NOT NULL DEFAULT 'user',
        status          VARCHAR(24)  NOT NULL DEFAULT 'active',
        last_login_at   DATETIME     NULL,
        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_username (username),
        UNIQUE KEY uq_users_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC`
    );

    await createTable(
      conn,
      'user_sessions',
      `CREATE TABLE IF NOT EXISTS user_sessions (
        id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id             BIGINT UNSIGNED NOT NULL,
        session_id          CHAR(36)     NOT NULL,
        refresh_token_hash  VARCHAR(255) NULL,
        user_agent          VARCHAR(255) NULL,
        ip_address          VARCHAR(45)  NULL,
        device_fingerprint  VARCHAR(128) NULL,
        revoked_at          DATETIME     NULL,
        expires_at          DATETIME     NOT NULL,
        created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at        DATETIME     NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_sessions_session_id (session_id),
        KEY idx_sessions_user (user_id),
        KEY idx_sessions_expires (expires_at),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC`
    );

    await createTable(
      conn,
      'email_verification_tokens',
      `CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id     BIGINT UNSIGNED NOT NULL,
        token       CHAR(64)     NOT NULL,
        expires_at  DATETIME     NOT NULL,
        used_at     DATETIME     NULL,
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_evt_token (token),
        KEY idx_evt_user (user_id),
        CONSTRAINT fk_evt_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC`
    );

    await createTable(
      conn,
      'password_reset_tokens',
      `CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id     BIGINT UNSIGNED NOT NULL,
        token       CHAR(64)     NOT NULL,
        expires_at  DATETIME     NOT NULL,
        used_at     DATETIME     NULL,
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_prt_token (token),
        KEY idx_prt_user (user_id),
        CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC`
    );

    await createTable(
      conn,
      'pending_email_changes',
      `CREATE TABLE IF NOT EXISTS pending_email_changes (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id     BIGINT UNSIGNED NOT NULL,
        new_email   VARCHAR(320) NOT NULL,
        token       CHAR(64)     NOT NULL,
        expires_at  DATETIME     NOT NULL,
        used_at     DATETIME     NULL,
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_pec_token (token),
        KEY idx_pec_user (user_id),
        CONSTRAINT fk_pec_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC`
    );
  },

  async down(conn: Connection): Promise<void> {
    // Reverse dependency order (children before parent). Idempotent.
    for (const t of [
      'pending_email_changes',
      'password_reset_tokens',
      'email_verification_tokens',
      'user_sessions',
      'users',
    ]) {
      await conn.query(`DROP TABLE IF EXISTS ${t}`);
      console.log(`   ✓ dropped ${t}`);
    }
  },
};

export default migration;
