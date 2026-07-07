// File: migrations/helpers.ts
// ============================================================================
// DINA MIGRATION FRAMEWORK — IDEMPOTENCY HELPERS
// ============================================================================
// MySQL DDL (CREATE/ALTER/DROP) auto-commits and is NOT transactional, so a
// migration cannot rely on rollback. Instead every migration must be safe to
// re-run. These introspection helpers (via INFORMATION_SCHEMA) let a migration
// check current state before changing it, so re-running is a no-op.
// ============================================================================

import type { Connection } from 'mysql2/promise';

async function scalar(conn: Connection, sql: string, params: any[]): Promise<number> {
  const [rows] = await conn.query(sql, params);
  const arr = rows as Array<Record<string, any>>;
  if (!arr || arr.length === 0) return 0;
  const first = arr[0];
  const key = Object.keys(first)[0];
  return Number(first[key]) || 0;
}

/** True if `table` exists in the current database. */
export async function tableExists(conn: Connection, table: string): Promise<boolean> {
  const c = await scalar(
    conn,
    `SELECT COUNT(*) AS c FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [table]
  );
  return c > 0;
}

/** True if `column` exists on `table`. */
export async function columnExists(conn: Connection, table: string, column: string): Promise<boolean> {
  const c = await scalar(
    conn,
    `SELECT COUNT(*) AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return c > 0;
}

/** True if a named index exists on `table`. */
export async function indexExists(conn: Connection, table: string, index: string): Promise<boolean> {
  const c = await scalar(
    conn,
    `SELECT COUNT(*) AS c FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index]
  );
  return c > 0;
}

/** Returns 'YES' | 'NO' | null (null = column absent). */
export async function columnNullability(conn: Connection, table: string, column: string): Promise<'YES' | 'NO' | null> {
  const [rows] = await conn.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  const arr = rows as Array<{ is_nullable: string }>;
  if (!arr || arr.length === 0) return null;
  return arr[0].is_nullable === 'YES' ? 'YES' : 'NO';
}

/** Names of foreign-key constraints on `table.column`. */
export async function foreignKeysOnColumn(conn: Connection, table: string, column: string): Promise<string[]> {
  const [rows] = await conn.query(
    `SELECT constraint_name FROM information_schema.key_column_usage
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
       AND referenced_table_name IS NOT NULL`,
    [table, column]
  );
  const arr = rows as Array<{ constraint_name: string }>;
  return arr.map((r) => r.constraint_name);
}

/** True if a named foreign-key constraint exists on `table`. */
export async function foreignKeyExists(conn: Connection, table: string, constraint: string): Promise<boolean> {
  const c = await scalar(
    conn,
    `SELECT COUNT(*) AS c FROM information_schema.table_constraints
     WHERE table_schema = DATABASE() AND table_name = ?
       AND constraint_name = ? AND constraint_type = 'FOREIGN KEY'`,
    [table, constraint]
  );
  return c > 0;
}

/** Add a column only if it is missing. `definition` is the full column spec. */
export async function addColumnIfMissing(
  conn: Connection,
  table: string,
  column: string,
  definition: string
): Promise<boolean> {
  if (await columnExists(conn, table, column)) return false;
  await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
  return true;
}

/** Create an index only if it is missing. */
export async function addIndexIfMissing(
  conn: Connection,
  table: string,
  index: string,
  columnsSql: string
): Promise<boolean> {
  if (await indexExists(conn, table, index)) return false;
  await conn.query(`ALTER TABLE \`${table}\` ADD INDEX \`${index}\` (${columnsSql})`);
  return true;
}
