// File: scripts/digimSemanticDiagnose.ts
// ============================================================================
// DIGIM — PER-RESEARCH SEMANTIC + TIMELINE DIAGNOSTIC (read-only)
// ============================================================================
// The owner-wide diagnostic (digimPipelineDiagnose.ts) proves the corpus is
// healthy overall. This one answers the SHARP question: "why is the Semantic
// (and Timeline) tab EMPTY for THIS ONE research?" — e.g. "the timeline of the
// human species".
//
// It reproduces, in plain SQL + a Redis scan, the EXACT path the live endpoints
// take, so the output is a proof, not a guess:
//
//   1. Resolve the research the console is showing (by id, or newest whose query
//      matches your text) and classify it: standalone / investigation ROOT /
//      facet.
//   2. Expand it to its ISLAND exactly like resolveResearchScope:
//        SELECT id FROM digim_intelligence WHERE user_id=? AND (id=? OR parent_id=?)
//      — a root unions its facets; a leaf is just itself. This is what BOTH the
//      graph and semantic endpoints filter by.
//   3. For every island id: content rows + embedding_status, graph entity/edge
//      counts, and occurred_at / occurred_sort population (timeline readiness).
//   4. Redis: count the vectors whose metadata.researchId ∈ island — this is
//      LITERALLY the set the Semantic tab would plot. Then show which research_ids
//      the owner's vectors ARE tagged with, so a mismatch is visible.
//   5. VERDICT: names the single failing link.
//
// Uses the same DB_* / REDIS_* env the app uses. READS ONLY — no writes.
//
// USAGE (from the server dir):
//   npx ts-node scripts/digimSemanticDiagnose.ts "human species"
//   npx ts-node scripts/digimSemanticDiagnose.ts <research_id>
//   npx ts-node scripts/digimSemanticDiagnose.ts "human species" <owner_id>
// ============================================================================

import 'dotenv/config';
import mysql, { Connection } from 'mysql2/promise';
import { createClient } from 'redis';

const ARG = (process.argv[2] || '').trim();
const OWNER = (process.argv[3] || '7d46b784-8ac6-4afa-abb5-aba48d846edf').trim();
const INDEX_DIM = 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function h(t: string) { console.log('\n' + '═'.repeat(78) + `\n  ${t}\n` + '═'.repeat(78)); }
function colExists(db: Connection, table: string, col: string) {
  return db.query(
    `SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?`,
    [table, col],
  ).then(([r]) => ((r as any[])[0]?.n || 0) > 0);
}

async function main() {
  console.log(`\nDIGIM semantic diagnostic — owner=${OWNER}  target=${ARG ? `"${ARG}"` : '(latest research)'}`);

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'dina',
  });

  try {
    // ── 1. RESOLVE THE RESEARCH ─────────────────────────────────────────────
    h('1) RESEARCH — which row is the console showing?');
    let target: any = null;
    if (ARG && UUID_RE.test(ARG)) {
      const [rows] = await db.query(
        `SELECT id, query, parent_id, level, created_at FROM digim_intelligence WHERE user_id=? AND id=? LIMIT 1`,
        [OWNER, ARG],
      );
      target = (rows as any[])[0] || null;
    } else {
      const like = `%${ARG}%`;
      const [rows] = await db.query(
        `SELECT id, query, parent_id, level, created_at FROM digim_intelligence
          WHERE user_id=? ${ARG ? 'AND query LIKE ?' : ''}
          ORDER BY created_at DESC LIMIT 1`,
        ARG ? [OWNER, like] : [OWNER],
      );
      target = (rows as any[])[0] || null;
    }
    if (!target) { console.log('  No matching research for this owner. Check the owner_id / text.'); return; }
    const kind = target.parent_id ? 'FACET (child of an investigation)' : 'ROOT or STANDALONE (parent_id NULL)';
    console.log(`  id        = ${target.id}`);
    console.log(`  query     = ${target.query}`);
    console.log(`  parent_id = ${target.parent_id ?? 'NULL'}   → ${kind}`);
    console.log(`  level     = ${target.level}   created=${target.created_at}`);

    // ── 2. ISLAND (exactly resolveResearchScope) ────────────────────────────
    h('2) ISLAND — the research_ids the graph/semantic endpoints filter by');
    const [islandRows] = await db.query(
      `SELECT id, query, parent_id FROM digim_intelligence WHERE user_id=? AND (id=? OR parent_id=?)`,
      [OWNER, target.id, target.id],
    );
    const island = (islandRows as any[]).map((r) => String(r.id));
    console.log(`  resolveResearchScope('${String(target.id).slice(0, 8)}…') → ${island.length} id(s):`);
    for (const r of islandRows as any[]) {
      console.log(`    ${String(r.id).slice(0, 8)}…  ${r.parent_id ? '(facet) ' : '(root)  '} ${String(r.query).slice(0, 60)}`);
    }
    if (island.length === 1 && !target.parent_id) {
      console.log('  NOTE: island is just this row. If you EXPECTED facets, either this was a');
      console.log('  single-topic research (normal) or investigate() did not tag facets with parent_id.');
    }

    // ── 3. PER-ISLAND CONTENT / GRAPH / DATES ───────────────────────────────
    h('3) PER-ISLAND — content embedded? graph built? dates present?');
    const hasSort = await colExists(db, 'digim_entities', 'occurred_sort');
    const inList = island.map(() => '?').join(',');
    // Content + embedding status for the whole island.
    const [cStatus] = await db.query(
      `SELECT embedding_status, COUNT(*) n FROM digim_content
        WHERE owner_id=? AND research_id IN (${inList}) GROUP BY embedding_status`,
      [OWNER, ...island],
    );
    const totalContent = (cStatus as any[]).reduce((s, r) => s + Number(r.n), 0);
    console.log(`  digim_content in island: ${totalContent} row(s)`);
    for (const r of cStatus as any[]) console.log(`      ${String(r.embedding_status).padEnd(9)} ${r.n}`);
    if (totalContent === 0) console.log('  ⇒ NO content stored for this island → nothing to embed → empty semantic AND empty graph.');

    // Graph counts (these are per-island already via research_id).
    for (const t of ['digim_entities', 'digim_relationships']) {
      const dateCols = hasSort
        ? `SUM(occurred_at IS NOT NULL) dated_at, SUM(occurred_sort IS NOT NULL) dated_sort`
        : `SUM(occurred_at IS NOT NULL) dated_at, 0 dated_sort`;
      const [g] = await db.query(
        `SELECT COUNT(*) total, ${dateCols} FROM ${t} WHERE owner_id=? AND research_id IN (${inList})`,
        [OWNER, ...island],
      );
      const row = (g as any[])[0];
      console.log(`  ${t}: ${row.total} row(s)  · occurred_at=${row.dated_at}  · occurred_sort=${row.dated_sort}`);
    }
    if (!hasSort) console.log('  ⚠ occurred_sort column ABSENT — migration 009 not applied here yet.');
    console.log('  (Timeline now renders by occurred_sort. 0 there ⇒ run digim:backfill-graph to');
    console.log('   re-extract dates for this island, then re-open the Timeline tab.)');

    // ── 4. REDIS — vectors the Semantic tab would actually plot ─────────────
    h('4) REDIS — vectors whose metadata.researchId ∈ island (what Semantic plots)');
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    const redis = createClient({ url, database: parseInt(process.env.REDIS_DB || '0', 10),
      socket: { connectTimeout: 4000, reconnectStrategy: false } });
    redis.on('error', () => undefined);
    let redisOk = false;
    try { await redis.connect(); redisOk = true; } catch (e) { console.log(`  Redis connect FAILED: ${(e as Error).message}`); }

    let inIsland = 0;
    if (redisOk) {
      const islandSet = new Set(island);
      let cursor = '0', scanned = 0, ownedByYou = 0, dimBad = 0;
      const perResearch = new Map<string, number>();
      const MAX = 20000;
      do {
        const res = await redis.sendCommand(['SCAN', cursor, 'MATCH', 'embedding:*', 'COUNT', '400']) as any[];
        cursor = String(res[0]);
        for (const key of (res[1] as any[]).map(String)) {
          scanned++;
          const md = await redis.hGet(key, 'metadata').catch(() => null);
          const dims = await redis.hGet(key, 'dimensions').catch(() => null);
          if (dims && parseInt(String(dims), 10) !== INDEX_DIM) dimBad++;
          if (!md) continue;
          let owner: string | null = null, research: string | null = null;
          try { const m = JSON.parse(String(md)); owner = m.ownerId ?? m.owner_id ?? null; research = m.researchId ?? m.research_id ?? null; } catch { /* ignore */ }
          if (owner !== OWNER) continue;
          ownedByYou++;
          const rk = research || '(no research_id)';
          perResearch.set(rk, (perResearch.get(rk) || 0) + 1);
          if (research && islandSet.has(research)) inIsland++;
        }
        if (scanned >= MAX) break;
      } while (cursor !== '0');

      console.log(`  embedding:* scanned=${scanned}  ownedByYou=${ownedByYou}  wrongDim=${dimBad}`);
      console.log(`  → vectors MATCHING this island (owner + researchId∈island) = ${inIsland}`);
      console.log(`     THIS is the Semantic tab's point count for this research.`);
      console.log('  your vectors grouped by the research_id they are TAGGED with:');
      for (const [rid, n] of [...perResearch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
        const mark = island.includes(rid) ? '  ⬅ in island' : '';
        console.log(`      ${String(rid).padEnd(40)} ${String(n).padStart(4)}${mark}`);
      }
      await redis.quit().catch(() => undefined);
    }

    // ── 5. VERDICT ──────────────────────────────────────────────────────────
    h('5) VERDICT');
    if (totalContent === 0) {
      console.log('  ✗ CAUSE: this island stored NO content. The research gathered nothing (or it was');
      console.log('    stored untagged). Semantic AND graph are empty for a reason. Re-run the research');
      console.log('    with sources reachable, or check gathering diagnostics.');
    } else if (redisOk && inIsland === 0) {
      console.log('  ✗ CAUSE: content rows EXIST for this island but ZERO Redis vectors carry an');
      console.log('    island research_id. The docs were never embedded under this island (memory');
      console.log('    off during the run, embed-model failure, or vectors lost their tag).');
      console.log('    FIX: backfill embeddings for this island (re-embed pending/failed content).');
      console.log('    The §4 grouping shows where your vectors ARE tagged — if they sit under a');
      console.log('    DIFFERENT research_id than the island, the tagging/linkage is the bug.');
    } else if (redisOk && inIsland > 0) {
      console.log(`  ✓ ${inIsland} vector(s) match this island — the Semantic tab SHOULD render them.`);
      console.log('    If the UI still shows empty, the client is not sending research_id/scope on the');
      console.log('    /digim/semantic call for this research (front-end wiring), not the data.');
    } else {
      console.log('  Redis was unreachable — re-run with Redis up to complete the semantic verdict.');
    }
    console.log('');
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error('diagnostic failed:', e?.message || e); process.exit(1); });
