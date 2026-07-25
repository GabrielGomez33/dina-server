// File: migrations/005_auth_users_columns.ts
// ============================================================================
// DINA AUTH — ENSURE THE users TABLE HAS EVERY AUTH COLUMN
// ============================================================================
// The live `dina.users` table predates DINA's schema bootstrap and drifted: it
// was created minimal (id, username, email) BEFORE db.ts declared the fuller
// `CREATE TABLE IF NOT EXISTS users (…)`. Because of IF NOT EXISTS, that fuller
// definition never applied, so the real table is missing columns the auth module
// reads/writes (migration 004 already revealed email_verified/role were absent;
// registration then failed on a missing `password_hash`).
//
// This migration idempotently ADDS every column the auth module needs, if
// missing. It is additive and non-destructive: existing rows keep their data,
// new columns get safe defaults / NULL. Fresh installs already get all of these
// from 004's CREATE, so here every add is simply a no-op on a fresh DB.
//
// Columns the auth module depends on (src/modules/auth/userStore.ts):
//   password_hash, email_verified, is_active, locked_until, last_login, role
//   (id, username, email are guaranteed to pre-exist — they're the table's core)
// ============================================================================

import type { Connection } from 'mysql2/promise';
import { Migration } from './types';
import { tableExists, addColumnIfMissing } from './helpers';

const COLUMNS: Array<{ name: string; ddl: string }> = [
  // Nullable: legacy rows (if any) simply have no hash and can't log in — safe.
  { name: 'password_hash', ddl: 'password_hash VARCHAR(255) NULL' },
  { name: 'email_verified', ddl: 'email_verified TINYINT(1) NOT NULL DEFAULT 0' },
  // Active by default so pre-existing accounts aren't accidentally locked out.
  { name: 'is_active', ddl: 'is_active TINYINT(1) NOT NULL DEFAULT 1' },
  { name: 'locked_until', ddl: 'locked_until TIMESTAMP NULL DEFAULT NULL' },
  { name: 'last_login', ddl: 'last_login TIMESTAMP NULL DEFAULT NULL' },
  { name: 'role', ddl: "role VARCHAR(24) NOT NULL DEFAULT 'user'" },
];

const migration: Migration = {
  id: 5,
  name: 'auth_users_columns',

  async up(conn: Connection): Promise<void> {
    if (!(await tableExists(conn, 'users'))) {
      // 004 creates `users` on a fresh DB with all of these already present, so
      // if it's somehow absent here there is nothing to backfill.
      console.log('   • users table not present — nothing to backfill (004 owns creation)');
      return;
    }
    for (const col of COLUMNS) {
      const added = await addColumnIfMissing(conn, 'users', col.name, col.ddl);
      console.log(added ? `   ✓ users.${col.name} added` : `   • users.${col.name} already present — skipping`);
    }
  },

  // Additive migration; down() is a guarded no-op. These columns may hold live
  // auth data (password hashes!) and other code now reads them — dropping them
  // on a rollback would destroy accounts. Remove by hand only if truly intended.
  async down(_conn: Connection): Promise<void> {
    console.log(
      '   ⚠ down() is a no-op for 005_auth_users_columns: these columns hold live\n' +
        '     auth data (password_hash, etc.). Refusing to auto-drop.',
    );
  },
};

export default migration;
