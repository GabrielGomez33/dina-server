// File: scripts/digimTenancyDiagnose.ts
// ============================================================================
// DIGIM — TENANCY / ISLAND DIAGNOSTIC (read-only, non-destructive)
// ============================================================================
// Answers ONE question: is each research's graph data (entities + relationships)
// correctly tagged with its OWN research_id (island), or is legacy/untagged data
// bleeding across researches?
//
// It uses the SAME database connection the app uses (mysql2 + the DB_* env vars
// from .env), so there are no separate credentials to hunt for. It only reads —
// no writes, no deletes.
//
// USAGE (from /var/www/dina-server):
//   npx ts-node scripts/digimTenancyDiagnose.ts
//   npx ts-node scripts/digimTenancyDiagnose.ts <owner_id>     # focus one user
//
// Reads: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME (from .env, like the app)
// ============================================================================

import 'dotenv/config';
import mysql, { Connection } from 'mysql2/promise';

const OWNER_ARG = (process.argv[2] || '').trim() || null;

function line(c = '─') { console.log(c.repeat(78)); }
function h(title: string) { line('═'); console.log(`  ${title}`); line('═'); }

async function tableExists(db: Connection, name: string): Promise<boolean> {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
    [name],
  );
  return ((rows as any[])[0]?.n || 0) > 0;
}

async function columnExists(db: Connection, table: string, col: string): Promise<boolean> {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, col],
  );
  return ((rows as any[])[0]?.n || 0) > 0;
}

async function main() {
  const cfg = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'dina',
  };
  console.log(`\nConnecting → ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}\n`);
  const db = await mysql.createConnection(cfg);

  try {
    // ── 0. schema sanity: do the tenancy columns even exist? ──────────────────
    h('0) SCHEMA — are the tenancy columns present?');
    for (const t of ['digim_entities', 'digim_relationships', 'digim_intelligence']) {
      if (!(await tableExists(db, t))) { console.log(`  ${t}: MISSING TABLE`); continue; }
      const hasOwner = await columnExists(db, t, 'owner_id');
      const hasResearch = await columnExists(db, t, 'research_id');
      console.log(`  ${t}: owner_id=${hasOwner ? 'yes' : 'NO'}  research_id=${hasResearch ? 'yes' : 'NO'}`);
    }
    console.log();

    const entitiesOk = (await columnExists(db, 'digim_entities', 'owner_id')) &&
                       (await columnExists(db, 'digim_entities', 'research_id'));
    if (!entitiesOk) {
      console.log('⛔ digim_entities is missing owner_id/research_id — migration 007 did not run here.');
      console.log('   That alone explains the bleed: with no research_id column, nothing can be islanded.');
      return;
    }

    // ── 1. untagged (legacy) rows — the classic bleed source ──────────────────
    h('1) UNTAGGED ROWS — NULL owner_id or research_id (pre-tenancy legacy)');
    for (const t of ['digim_entities', 'digim_relationships']) {
      if (!(await tableExists(db, t))) continue;
      const [rows] = await db.query(
        `SELECT
           COUNT(*)                                          AS total,
           SUM(owner_id IS NULL)                             AS null_owner,
           SUM(research_id IS NULL)                          AS null_research
         FROM ${t}`,
      );
      const r = (rows as any[])[0];
      console.log(`  ${t}: total=${r.total}  null_owner=${r.null_owner}  null_research=${r.null_research}`);
    }
    console.log('  (null_research > 0 means those rows belong to NO island → they leak into every "island" that falls back to owner scope.)');
    console.log();

    // ── 2. researches for the owner(s), with their titles ─────────────────────
    h('2) RESEARCHES (digim_intelligence) and their entity/edge counts');
    const ownerFilter = OWNER_ARG ? 'WHERE i.owner_id = ?' : '';
    const ownerArgs = OWNER_ARG ? [OWNER_ARG] : [];
    const hasIntelOwner = await columnExists(db, 'digim_intelligence', 'owner_id');
    if (!hasIntelOwner) {
      console.log('  digim_intelligence has no owner_id column — skipping title join.');
    } else {
      const [rows] = await db.query(
        `SELECT i.id AS research_id, i.owner_id,
                LEFT(COALESCE(i.title, i.query, '(untitled)'), 48) AS title,
                (SELECT COUNT(*) FROM digim_entities e
                   WHERE e.research_id = i.id) AS entities,
                (SELECT COUNT(*) FROM digim_relationships r
                   WHERE r.research_id = i.id) AS edges
           FROM digim_intelligence i
           ${ownerFilter}
          ORDER BY i.created_at DESC
          LIMIT 40`,
        ownerArgs,
      );
      for (const r of rows as any[]) {
        console.log(`  research ${r.research_id}  owner=${String(r.owner_id).slice(0, 8)}…  entities=${r.entities}  edges=${r.edges}  "${r.title}"`);
      }
    }
    console.log();

    // ── 3. the money query: entities grouped by research_id, with topic flags ──
    h('3) ENTITY ISLANDS — are Tubman and fourth-dimension in SEPARATE research_ids?');
    const eOwnerFilter = OWNER_ARG ? 'WHERE owner_id = ?' : '';
    const [grp] = await db.query(
      `SELECT
         COALESCE(research_id, '(NULL — untagged)')            AS research_id,
         owner_id,
         COUNT(*)                                              AS entities,
         SUM(name LIKE '%Tubman%')                             AS tubman,
         SUM(name LIKE '%Minkowski%' OR name LIKE '%dimension%'
             OR name LIKE '%Einstein%' OR name LIKE '%relativity%') AS fourthdim,
         SUM(name LIKE '%Hormuz%' OR name LIKE '%Iran%')       AS iran
       FROM digim_entities
       ${eOwnerFilter}
       GROUP BY research_id, owner_id
       ORDER BY entities DESC
       LIMIT 60`,
      OWNER_ARG ? [OWNER_ARG] : [],
    );
    console.log('  research_id                               owner    ents  tubman  4d  iran');
    for (const r of grp as any[]) {
      const rid = String(r.research_id).padEnd(40).slice(0, 40);
      console.log(`  ${rid}  ${String(r.owner_id).slice(0, 6)}  ${String(r.entities).padStart(4)}  ${String(r.tubman).padStart(6)}  ${String(r.fourthdim).padStart(2)}  ${String(r.iran).padStart(4)}`);
    }
    console.log();

    // ── 4. verdict ────────────────────────────────────────────────────────────
    h('4) VERDICT');
    const arr = grp as any[];
    const mixed = arr.filter((r) => (Number(r.tubman) > 0 ? 1 : 0) + (Number(r.fourthdim) > 0 ? 1 : 0) > 1);
    const untagged = arr.filter((r) => String(r.research_id).startsWith('(NULL'));
    if (untagged.length) {
      console.log(`  ⚠️  ${untagged.reduce((s, r) => s + Number(r.entities), 0)} entities have NO research_id (untagged legacy).`);
      console.log('      These predate the island tagging and bleed into every view. FIX = backfill/re-tag or purge+re-run.');
    }
    if (mixed.length) {
      console.log('  ⛔  At least one research_id row contains BOTH Tubman AND fourth-dimension entities.');
      console.log('      The writes were not islanded — a code/data fix is required, not a frontend reload.');
    }
    if (!untagged.length && !mixed.length) {
      console.log('  ✅  Every topic lives in its OWN research_id (data is correctly islanded).');
      console.log('      => The bleed can ONLY come from the request omitting research_id (stale SPA tab).');
      console.log('         Fix: cache-disabled reload of the app; confirm the /digim/graph payload carries research_id + scope:"island".');
    }
    console.log();
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error('diagnostic failed:', e?.message || e); process.exit(1); });
