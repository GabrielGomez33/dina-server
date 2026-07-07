// File: scripts/migrate.ts
// ============================================================================
// DINA MIGRATION RUNNER (env-driven)
// ============================================================================
//
// A small, dependency-light schema-migration CLI in the same spirit as the rest
// of DINA: env-configured, defensive, and loud about what it does. It reuses the
// existing DB_* environment variables (same ones db.ts / test-db.js read).
//
// COMMANDS
//   npm run migrate            # apply all pending migrations (alias: 'up')
//   npm run migrate:status     # show applied vs pending (needs DB)
//   npm run migrate:list       # list discovered migrations (OFFLINE, no DB)
//   npm run migrate:down       # roll back the most recently applied migration
//   ts-node scripts/migrate.ts up --dry-run   # show pending without applying
//
// SAFETY
//   * Each migration is recorded in `schema_migrations` only AFTER its up()
//     succeeds. MySQL DDL auto-commits and is not transactional, so migrations
//     must be idempotent (the helpers in migrations/helpers.ts enforce this).
//   * `up` stops at the first failure and leaves later migrations unapplied.
// ============================================================================

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mysql, { Connection } from 'mysql2/promise';
import { Migration } from '../migrations/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');
const FILE_RE = /^(\d+)_.+\.(ts|js)$/;

type Command = 'up' | 'down' | 'status' | 'list';

function parseArgs(): { command: Command; dryRun: boolean } {
  const argv = process.argv.slice(2);
  const command = (argv.find((a) => !a.startsWith('-')) || 'status') as Command;
  const dryRun = argv.includes('--dry-run');
  if (!['up', 'down', 'status', 'list'].includes(command)) {
    console.error(`❌ Unknown command "${command}". Use: up | down | status | list`);
    process.exit(1);
  }
  return { command, dryRun };
}

/** Discover migration modules, sorted by numeric id. Pure filesystem — no DB. */
function discoverMigrations(): Migration[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => FILE_RE.test(f) && !f.endsWith('.d.ts'))
    .sort();

  const migrations: Migration[] = [];
  const seen = new Set<number>();
  for (const file of files) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(MIGRATIONS_DIR, file));
    const migration: Migration = mod.default || mod;
    if (!migration || typeof migration.up !== 'function' || typeof migration.id !== 'number') {
      throw new Error(`Migration file ${file} does not export a valid Migration (needs id:number, up:function)`);
    }
    if (seen.has(migration.id)) {
      throw new Error(`Duplicate migration id ${migration.id} (${file}) — ids must be unique`);
    }
    seen.add(migration.id);
    migrations.push(migration);
  }
  return migrations.sort((a, b) => a.id - b.id);
}

async function connect(): Promise<Connection> {
  const host = process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT || '3306', 10);
  const user = process.env.DB_USER || 'dina_user';
  const password = process.env.DB_PASSWORD || '';
  const database = process.env.DB_NAME || 'dina';

  console.log(`🔌 Connecting to MySQL ${user}@${host}:${port}/${database} ...`);
  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    multipleStatements: false,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.NODE_ENV === 'production' } : undefined,
  });
  console.log('✅ Connected');
  return conn;
}

async function ensureTrackingTable(conn: Connection): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function appliedIds(conn: Connection): Promise<Set<number>> {
  const [rows] = await conn.query('SELECT id FROM schema_migrations ORDER BY id ASC');
  return new Set((rows as Array<{ id: number }>).map((r) => Number(r.id)));
}

// ----------------------------------------------------------------------------
// COMMANDS
// ----------------------------------------------------------------------------

function cmdList(migrations: Migration[]): void {
  console.log(`\n📋 Discovered ${migrations.length} migration(s) in ${path.relative(process.cwd(), MIGRATIONS_DIR)}:`);
  for (const m of migrations) {
    console.log(`   ${String(m.id).padStart(3, '0')}  ${m.name}${m.down ? '' : '  (no down)'}`);
  }
  console.log('\n(Offline listing — run "npm run migrate:status" to see which are applied.)');
}

async function cmdStatus(migrations: Migration[]): Promise<void> {
  const conn = await connect();
  try {
    await ensureTrackingTable(conn);
    const applied = await appliedIds(conn);
    console.log('\n📊 Migration status:');
    for (const m of migrations) {
      const mark = applied.has(m.id) ? '✅ applied ' : '⏳ pending ';
      console.log(`   ${mark} ${String(m.id).padStart(3, '0')}  ${m.name}`);
    }
    const pending = migrations.filter((m) => !applied.has(m.id)).length;
    console.log(`\n${pending === 0 ? '✅ Up to date.' : `⏳ ${pending} pending migration(s). Run "npm run migrate".`}`);
  } finally {
    await conn.end();
  }
}

async function cmdUp(migrations: Migration[], dryRun: boolean): Promise<void> {
  const conn = await connect();
  try {
    await ensureTrackingTable(conn);
    const applied = await appliedIds(conn);
    const pending = migrations.filter((m) => !applied.has(m.id));

    if (pending.length === 0) {
      console.log('✅ No pending migrations — schema is up to date.');
      return;
    }
    console.log(`\n🚀 ${pending.length} pending migration(s)${dryRun ? ' (DRY RUN — nothing will be applied)' : ''}:`);
    for (const m of pending) console.log(`   • ${String(m.id).padStart(3, '0')} ${m.name}`);

    if (dryRun) {
      console.log('\n(Dry run complete — re-run without --dry-run to apply.)');
      return;
    }

    for (const m of pending) {
      console.log(`\n▶ Applying ${String(m.id).padStart(3, '0')} ${m.name} ...`);
      try {
        await m.up(conn);
        await conn.query('INSERT INTO schema_migrations (id, name) VALUES (?, ?)', [m.id, m.name]);
        console.log(`✅ Applied ${m.name}`);
      } catch (err) {
        console.error(`❌ Migration ${m.id} (${m.name}) FAILED: ${(err as Error).message}`);
        console.error('   Later migrations were NOT applied. Fix the cause and re-run (migrations are idempotent).');
        process.exitCode = 1;
        return;
      }
    }
    console.log('\n✅ All pending migrations applied.');
  } finally {
    await conn.end();
  }
}

async function cmdDown(migrations: Migration[]): Promise<void> {
  const conn = await connect();
  try {
    await ensureTrackingTable(conn);
    const applied = await appliedIds(conn);
    const last = migrations.filter((m) => applied.has(m.id)).sort((a, b) => b.id - a.id)[0];
    if (!last) {
      console.log('ℹ️ Nothing to roll back.');
      return;
    }
    if (!last.down) {
      console.error(`❌ Migration ${last.id} (${last.name}) has no down() — cannot roll back automatically.`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n↩️ Rolling back ${String(last.id).padStart(3, '0')} ${last.name} ...`);
    await last.down(conn);
    await conn.query('DELETE FROM schema_migrations WHERE id = ?', [last.id]);
    console.log(`✅ Rolled back ${last.name}`);
  } finally {
    await conn.end();
  }
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const { command, dryRun } = parseArgs();
  const migrations = discoverMigrations();

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`   DINA Migration Runner — "${command}"`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  switch (command) {
    case 'list':
      cmdList(migrations);
      break;
    case 'status':
      await cmdStatus(migrations);
      break;
    case 'up':
      await cmdUp(migrations, dryRun);
      break;
    case 'down':
      await cmdDown(migrations);
      break;
  }
}

main().catch((err) => {
  console.error('❌ Migration runner crashed:', err);
  process.exit(1);
});
