// File: scripts/digimBackfillGraph.ts
// ============================================================================
// DIGIM — GRAPH BACKFILL RUNNER (enrich existing researches)
// ============================================================================
// Calls the authenticated /digim/graph/backfill endpoint to RE-EXTRACT the
// relationship graph for YOUR existing researches from already-gathered content
// (no re-fetching), using the current extractor + DIGIM_WEB_EXTRACT_MODEL. This
// fills in missing occurred_at dates and adds relationships a weaker earlier
// model missed — so old islands get richer graphs + populated timelines.
//
// AUTH: pass your access token (browser console: localStorage.getItem('dina.accessToken')).
//
// USAGE:
//   DINA_TOKEN=<jwt> npx ts-node scripts/digimBackfillGraph.ts
//   DINA_TOKEN=<jwt> npx ts-node scripts/digimBackfillGraph.ts <research_id>
//   VERIFY_BASE_URL=https://host/dina DINA_TOKEN=<jwt> npx ts-node scripts/digimBackfillGraph.ts
// ============================================================================

const BASE = (process.env.VERIFY_BASE_URL || 'https://www.theundergroundrailroad.world/dina').replace(/\/+$/, '');
const TOKEN = process.env.DINA_TOKEN || '';
const RESEARCH_ID = (process.argv[2] || '').trim() || null;

async function main() {
  if (!TOKEN) {
    console.error('Set DINA_TOKEN to your access token (browser console: localStorage.getItem("dina.accessToken")).');
    process.exit(2);
  }
  const url = `${BASE}/api/v1/digim/graph/backfill`;
  console.log(`\nGraph backfill → ${url}${RESEARCH_ID ? `  (research ${RESEARCH_ID})` : '  (all your researches)'}\n`);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(RESEARCH_ID ? { research_id: RESEARCH_ID } : {}),
  });
  const body = await res.json().catch(() => null);
  console.log(`HTTP ${res.status}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (body) {
    console.log(`  status:               ${body.status}`);
    console.log(`  researches processed: ${body.researches ?? '-'}`);
    console.log(`  documents re-read:    ${body.documents ?? '-'}`);
    console.log(`  relationships added:  ${body.relationshipsAdded ?? '-'}`);
    if (body.message) console.log(`  ${body.message}`);
  }
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => { console.error('backfill runner failed:', e?.message || e); process.exit(1); });
