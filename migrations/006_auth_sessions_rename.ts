// File: migrations/006_auth_sessions_rename.ts
// ============================================================================
// DINA AUTH — ensure DINA owns its sessions table (dina_auth_sessions)
// ============================================================================
// Why: the generic `user_sessions` table already existed in this DB with a
// FOREIGN schema (no `session_id`), created by something other than DINA-auth.
// Migration 004 correctly SKIPPED it ("already exists"), but the auth code then
// tried to INSERT its own columns → "Unknown column 'session_id'".
//
// Fix: DINA-auth uses its OWN namespaced table `dina_auth_sessions` (see the
// updated 004). This migration creates that table on installs where 004 already
// ran under the old name — idempotent, so it no-ops on a fresh DB where 004 has
// just created it. It NEVER touches the foreign `user_sessions` (not ours).
//
// `dina_auth_sessions.user_id` matches `users.id` type AND collation, reusing
// the same resolver 004 uses (a VARCHAR FK needs both to match — errno 150).
// ============================================================================

import type { Connection } from 'mysql2/promise';
import { Migration } from './types';
import { tableExists } from './helpers';
import { usersIdColumnSpec } from './004_auth_users';

const migration: Migration = {
  id: 6,
  name: 'auth_sessions_rename',

  async up(conn: Connection): Promise<void> {
    if (await tableExists(conn, 'dina_auth_sessions')) {
      console.log('   • dina_auth_sessions already exists — skipping');
      return;
    }

    // `users` must exist (004/005 guarantee it) to resolve the FK spec.
    if (!(await tableExists(conn, 'users'))) {
      throw new Error('[006] users table missing — run earlier migrations first.');
    }

    const idType = await usersIdColumnSpec(conn);
    console.log(`   ↳ users.id resolved as "${idType}" — dina_auth_sessions.user_id will match`);

    await conn.query(
      `CREATE TABLE IF NOT EXISTS dina_auth_sessions (
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
        UNIQUE KEY uq_das_session_id (session_id),
        KEY idx_das_user (user_id),
        KEY idx_das_expires (expires_at),
        CONSTRAINT fk_das_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
    console.log('   ✓ created dina_auth_sessions');
  },

  // Additive; down() is a guarded no-op (the table holds live session data, and
  // we must never touch the foreign `user_sessions`).
  async down(_conn: Connection): Promise<void> {
    console.log('   ⚠ down() is a no-op for 006_auth_sessions_rename (holds live session data).');
  },
};

export default migration;
