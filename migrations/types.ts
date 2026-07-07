// File: migrations/types.ts
// ============================================================================
// DINA MIGRATION FRAMEWORK — TYPES
// ============================================================================
// A migration is a small, ordered, idempotent unit of schema evolution. Each
// lives in migrations/NNN_description.ts and default-exports a `Migration`.
//
//   - `id`   : the numeric order key (matches the NNN filename prefix).
//   - `name` : human label, recorded in schema_migrations.
//   - `up`   : apply the change. MUST be idempotent (safe to re-run) — MySQL
//              DDL auto-commits and cannot be rolled back in a transaction, so
//              use the helpers in ./helpers to guard every statement.
//   - `down` : optional reverse. Also idempotent. Omit if irreversible.
// ============================================================================

import type { Connection } from 'mysql2/promise';

export interface Migration {
  id: number;
  name: string;
  up(conn: Connection): Promise<void>;
  down?(conn: Connection): Promise<void>;
}
