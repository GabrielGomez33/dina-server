// File: scripts/digimPipelineDiagnose.ts
// ============================================================================
// DIGIM — PIPELINE DATA DIAGNOSTIC (semantic + timeline) — read-only
// ============================================================================
// Answers two questions, non-destructively:
//   • SEMANTIC "0 points": is content being EMBEDDED, and do the stored vectors
//     carry this owner's id in their metadata (what the semantic view filters
//     on)? Checks MySQL embedding_status AND the live Redis embedding:* keys.
//   • TIMELINE empty: do this owner's entities/relationships carry occurred_at
//     (the field the timeline renders)?
//
// Uses the SAME connections the app uses — DB_* env for MySQL and REDIS_URL/
// REDIS_DB for Redis — so there are no separate credentials to find. Reads only.
//
// USAGE (from /var/www/dina-server):
//   npx ts-node scripts/digimPipelineDiagnose.ts
//   npx ts-node scripts/digimPipelineDiagnose.ts <owner_id>
// ============================================================================

import 'dotenv/config';
import mysql, { Connection } from 'mysql2/promise';
import { createClient } from 'redis';

const OWNER = (process.argv[2] || '7d46b784-8ac6-4afa-abb5-aba48d846edf').trim();
const EMBED_MODEL = process.env.DIGIM_WEB_EMBED_MODEL || process.env.DINA_EMBED_MODEL || 'mxbai-embed-large';
const INDEX_DIM = 1024; // src/config/redis.ts defaultVectorDimensions

function h(t: string) { console.log('\n' + '═'.repeat(78) + `\n  ${t}\n` + '═'.repeat(78)); }

async function colExists(db: Connection, table: string, col: string): Promise<boolean> {
  const [r] = await db.query(
    `SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?`,
    [table, col],
  );
  return ((r as any[])[0]?.n || 0) > 0;
}
async function tblExists(db: Connection, table: string): Promise<boolean> {
  const [r] = await db.query(
    `SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?`,
    [table],
  );
  return ((r as any[])[0]?.n || 0) > 0;
}

async function main() {
  console.log(`\nDIGIM pipeline diagnostic — owner=${OWNER}`);
  console.log(`embed model=${EMBED_MODEL}  index DIM=${INDEX_DIM}\n`);

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'dina',
  });

  try {
    // ── 1. CONTENT EMBEDDING STATUS (MySQL) ─────────────────────────────────
    h('1) CONTENT — is it being embedded? (digim_content.embedding_status)');
    if (!(await tblExists(db, 'digim_content'))) {
      console.log('  digim_content MISSING');
    } else {
      const [byStatus] = await db.query(
        `SELECT embedding_status, COUNT(*) n FROM digim_content GROUP BY embedding_status`,
      );
      console.log('  ALL content by status:');
      for (const r of byStatus as any[]) console.log(`    ${String(r.embedding_status).padEnd(9)} ${r.n}`);

      const hasOwner = await colExists(db, 'digim_content', 'owner_id');
      if (hasOwner) {
        const [own] = await db.query(
          `SELECT
             COUNT(*)                                  AS total,
             SUM(owner_id = ?)                         AS owned,
             SUM(owner_id = ? AND embedding_status='embedded') AS owned_embedded,
             SUM(owner_id IS NULL)                     AS null_owner,
             SUM(research_id IS NULL)                  AS null_research
           FROM digim_content`,
          [OWNER, OWNER],
        );
        const r = (own as any[])[0];
        console.log(`\n  this owner: total_rows=${r.total}  owned=${r.owned}  owned&embedded=${r.owned_embedded}`);
        console.log(`  untagged rows: null_owner=${r.null_owner}  null_research=${r.null_research}`);
        console.log('  (owned&embedded is the pool the semantic view can show for you.)');
      } else {
        console.log('  digim_content has NO owner_id column (migration 007 not applied here).');
      }
    }

    // ── 3. TIMELINE READINESS (MySQL) ───────────────────────────────────────
    h('2) TIMELINE — do entities/relationships carry occurred_at?');
    for (const t of ['digim_entities', 'digim_relationships']) {
      if (!(await tblExists(db, t))) { console.log(`  ${t} MISSING`); continue; }
      const hasOwner = await colExists(db, t, 'owner_id');
      const [r] = await db.query(
        `SELECT COUNT(*) total, SUM(occurred_at IS NOT NULL) dated
           FROM ${t} ${hasOwner ? 'WHERE owner_id = ?' : ''}`,
        hasOwner ? [OWNER] : [],
      );
      const row = (r as any[])[0];
      console.log(`  ${t}: your rows=${row.total}  with occurred_at=${row.dated}`);
    }
    console.log('  (Timeline shows ONLY rows with occurred_at. 0 dated ⇒ empty timeline even with a full graph.)');

    // ── 3. REDIS EMBEDDINGS ─────────────────────────────────────────────────
    h('3) REDIS — stored vectors + do they carry your ownerId?');
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    const redis = createClient({ url, database: parseInt(process.env.REDIS_DB || '0', 10),
      socket: { connectTimeout: 4000, reconnectStrategy: false } });
    redis.on('error', () => { /* handled below */ });
    let redisOk = false;
    try { await redis.connect(); redisOk = true; } catch (e) { console.log(`  Redis connect FAILED: ${(e as Error).message}`); }

    if (redisOk) {
      let cursor = '0', scanned = 0, withOwner = 0, ownedByYou = 0, dimBad = 0, nullOwner = 0;
      const perResearch = new Map<string, number>();
      const sample: string[] = [];
      const MAX = 6000;
      do {
        const res = await redis.sendCommand(['SCAN', cursor, 'MATCH', 'embedding:*', 'COUNT', '300']) as any[];
        cursor = String(res[0]);
        const keys: string[] = (res[1] as any[]).map(String);
        for (const key of keys) {
          scanned++;
          const md = await redis.hGet(key, 'metadata').catch(() => null);
          const dims = await redis.hGet(key, 'dimensions').catch(() => null);
          if (dims && parseInt(String(dims), 10) !== INDEX_DIM) dimBad++;
          let owner: string | null = null, research: string | null = null;
          if (md) {
            try {
              const m = JSON.parse(String(md));
              owner = m.ownerId ?? m.owner_id ?? null;
              research = m.researchId ?? m.research_id ?? null;
            } catch { /* ignore */ }
          }
          if (owner) withOwner++; else nullOwner++;
          if (owner === OWNER) {
            ownedByYou++;
            const rk = research || '(no research_id)';
            perResearch.set(rk, (perResearch.get(rk) || 0) + 1);
          }
          if (sample.length < 3 && md) sample.push(String(md).slice(0, 200));
          if (scanned >= MAX) { cursor = '0'; break; }
        }
      } while (cursor !== '0' && scanned < MAX);

      console.log(`  embedding:* keys scanned = ${scanned}`);
      console.log(`  with an ownerId in metadata = ${withOwner}   (NULL/untagged = ${nullOwner})`);
      console.log(`  owned by YOU (${OWNER.slice(0, 8)}…) = ${ownedByYou}`);
      console.log(`  wrong dimension (≠ ${INDEX_DIM}) = ${dimBad}`);
      if (perResearch.size) {
        console.log('  your embeddings per research_id:');
        for (const [rid, n] of [...perResearch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
          console.log(`    ${String(rid).padEnd(40)} ${n}`);
        }
      }
      if (sample.length) { console.log('  sample metadata:'); sample.forEach((s) => console.log(`    ${s}`)); }
      await redis.quit().catch(() => undefined);
    }

    // ── 4. VERDICT ──────────────────────────────────────────────────────────
    h('4) READS');
    console.log('  SEMANTIC needs: content embedded (§1 owned&embedded > 0) AND Redis vectors');
    console.log('  tagged with your ownerId (§3 owned by YOU > 0). If §1 shows embedded rows');
    console.log('  but §3 owned-by-you is 0, the vectors lost their owner tag (legacy/pre-tenancy)');
    console.log('  → they need re-embedding with owner/research metadata.');
    console.log('  If §1 owned&embedded is 0, content is not being embedded at all (memory off,');
    console.log('  embed model/dim mismatch, or every doc deduped) — that is the pipeline fix.');
    console.log('  TIMELINE needs §2 with-occurred_at > 0; if 0, extraction is producing no dated');
    console.log('  events (thin/undated extraction), which is a prompt/extraction quality fix.\n');
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error('diagnostic failed:', e?.message || e); process.exit(1); });
