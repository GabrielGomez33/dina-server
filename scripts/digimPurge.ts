// File: scripts/digimPurge.ts
// ============================================================================
// DIGIM — DESTRUCTIVE PURGE (research, graph, content, embeddings)
// ============================================================================
// Wipes ALL DIGIM research data for a clean slate:
//   MySQL: digim_relationship_sources, digim_relationships, digim_entities,
//          digim_content, digim_intelligence
//   Redis: every `embedding:*` key (the vector store)
//
// This is IRREVERSIBLE. It requires an explicit confirmation so it can never run
// by accident:
//   npm run digim:purge -- --yes        (or set DIGIM_PURGE_CONFIRM=YES)
//
// A dry run (default without --yes) reports the row/key counts it WOULD delete
// and changes nothing.
//
// Standalone by design (own MySQL + Redis connections from the same env the app
// uses) so it never drags in the heavy DINA bootstrap. Mirrors scripts/migrate.ts.
// ============================================================================

import 'dotenv/config';
import mysql, { Connection } from 'mysql2/promise';
import { createClient } from 'redis';

// FK-safe order: children before parents.
const TABLES = [
  'digim_relationship_sources',
  'digim_relationships',
  'digim_entities',
  'digim_content',
  'digim_intelligence',
];

function confirmed(): boolean {
  const arg = process.argv.includes('--yes') || process.argv.includes('-y');
  const env = (process.env.DIGIM_PURGE_CONFIRM || '').toUpperCase() === 'YES';
  return arg || env;
}

async function connectMysql(): Promise<Connection> {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'dina_user',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'dina',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.NODE_ENV === 'production' } : undefined,
  });
  return conn;
}

async function tableExists(conn: Connection, name: string): Promise<boolean> {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
    [name],
  );
  return Number((rows as any[])[0]?.c || 0) > 0;
}

async function rowCount(conn: Connection, name: string): Promise<number> {
  const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM \`${name}\``);
  return Number((rows as any[])[0]?.c || 0);
}

/** SCAN + count/delete embedding:* keys. Returns the number seen/deleted. */
async function purgeEmbeddings(dryRun: boolean): Promise<number> {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const database = parseInt(process.env.REDIS_DB || '0', 10);
  // Fail fast if Redis is down: bounded connect timeout, no infinite reconnect.
  const client = createClient({
    url,
    database,
    socket: { connectTimeout: 3000, reconnectStrategy: false },
  });
  client.on('error', () => {
    /* handled below via connect() rejection */
  });
  try {
    await client.connect();
  } catch (err) {
    console.warn(`   ⚠ Redis unreachable (${url}) — skipping embedding purge: ${err instanceof Error ? err.message : err}`);
    return -1;
  }
  let count = 0;
  try {
    let cursor = '0';
    do {
      // node-redis v4 scan
      const res: any = await (client as any).scan(cursor, { MATCH: 'embedding:*', COUNT: 500 });
      cursor = String(res.cursor);
      const keys: string[] = res.keys || [];
      if (keys.length) {
        count += keys.length;
        if (!dryRun) await client.del(keys);
      }
    } while (cursor !== '0');
  } finally {
    await client.quit().catch(() => undefined);
  }
  return count;
}

async function main(): Promise<void> {
  const dryRun = !confirmed();
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`   DIGIM PURGE — ${dryRun ? 'DRY RUN (no changes)' : 'LIVE — DELETING'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const conn = await connectMysql();
  try {
    console.log(`🔌 MySQL ${process.env.DB_USER}@${process.env.DB_HOST || 'localhost'}/${process.env.DB_NAME || 'dina'}`);

    // Report counts first.
    let total = 0;
    for (const t of TABLES) {
      if (!(await tableExists(conn, t))) {
        console.log(`   • ${t}: table absent — skipping`);
        continue;
      }
      const n = await rowCount(conn, t);
      total += n;
      console.log(`   ${dryRun ? '·' : '✗'} ${t}: ${n} row(s)${dryRun ? ' would be deleted' : ' — deleting'}`);
    }

    if (!dryRun) {
      // Disable FK checks for the duration so order/edge-cases can't block a
      // full wipe, then delete each table. Re-enable in finally.
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      try {
        for (const t of TABLES) {
          if (await tableExists(conn, t)) {
            await conn.query(`DELETE FROM \`${t}\``);
          }
        }
      } finally {
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      }
      console.log(`   ✓ deleted ${total} MySQL row(s) across ${TABLES.length} table(s)`);
    }

    // Embeddings.
    console.log('🔌 Redis embeddings (embedding:*)');
    const emb = await purgeEmbeddings(dryRun);
    if (emb >= 0) {
      console.log(`   ${dryRun ? '·' : '✓'} ${emb} embedding key(s)${dryRun ? ' would be deleted' : ' deleted'}`);
    }

    console.log('');
    if (dryRun) {
      console.log('ℹ️  DRY RUN — nothing changed. Re-run with `-- --yes` to actually purge.');
    } else {
      console.log('✅ DIGIM data purged. Clean slate.');
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('❌ Purge failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
