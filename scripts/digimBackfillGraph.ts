// File: scripts/digimBackfillGraph.ts
// ============================================================================
// DIGIM — GRAPH BACKFILL RUNNER (enrich existing researches)
// ============================================================================
// Re-extracts the relationship graph for YOUR existing researches from content
// already gathered (no re-fetching), using the current extractor (per-document
// + broader prompt). Fills in missing occurred_at dates and adds relationships a
// single-pass / weaker earlier extraction missed — so old islands get richer
// graphs + populated timelines.
//
// Runs ONE research per HTTP call (each bounded, so nothing blows the request
// timeout) and prints live per-research progress. Idempotent: re-running only
// upserts (dedupes) — safe to run again.
//
// AUTH: pass your access token (browser console: localStorage.getItem('dina.accessToken')).
//
// USAGE:
//   DINA_TOKEN=<jwt> npx ts-node scripts/digimBackfillGraph.ts            # all your researches
//   DINA_TOKEN=<jwt> npx ts-node scripts/digimBackfillGraph.ts <research_id>   # just one
// ============================================================================

const BASE = (process.env.VERIFY_BASE_URL || 'https://www.theundergroundrailroad.world/dina').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
const TOKEN = process.env.DINA_TOKEN || '';
const ONE = (process.argv[2] || '').trim() || null;
const PER_RESEARCH_TIMEOUT_MS = 290000;

async function call(method: string, path: string, body?: any, timeoutMs = 30000): Promise<{ status: number; body: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const b: any = await res.json().catch(() => null);
    return { status: res.status, body: b };
  } finally {
    clearTimeout(t);
  }
}

async function backfillOne(id: string, label: string): Promise<number> {
  const t0 = Date.now();
  process.stdout.write(`  • ${id.slice(0, 8)}… "${label.slice(0, 44)}" … `);
  try {
    const r = await call('POST', '/digim/graph/backfill', { research_id: id }, PER_RESEARCH_TIMEOUT_MS);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (r.status === 200 && r.body?.status === 'success') {
      const added = r.body.relationshipsAdded ?? 0;
      console.log(`+${added} rels (${r.body.documents ?? 0} docs, ${secs}s)`);
      return added;
    }
    console.log(`skipped (HTTP ${r.status}${r.body?.message ? ': ' + r.body.message : ''}, ${secs}s)`);
    return 0;
  } catch (e) {
    console.log(`error (${(e as Error).message})`);
    return 0;
  }
}

async function main() {
  if (!TOKEN) {
    console.error('Set DINA_TOKEN to your access token (browser console: localStorage.getItem("dina.accessToken")).');
    process.exit(2);
  }
  console.log(`\nGraph backfill → ${API}\n`);

  if (ONE) {
    const total = await backfillOne(ONE, '(single research)');
    console.log(`\nDone — +${total} relationships.\n`);
    return;
  }

  // List the caller's researches, then backfill each (roots AND facets — every
  // research has its own island of content to re-extract).
  const hist = await call('GET', '/digim/history?limit=200');
  const items: any[] = Array.isArray(hist.body?.items) ? hist.body.items : [];
  if (items.length === 0) {
    console.log('No researches found for this account.');
    return;
  }
  console.log(`Re-extracting ${items.length} research(es), one at a time:\n`);
  let grand = 0;
  for (const it of items) {
    grand += await backfillOne(String(it.id), String(it.query || ''));
  }
  console.log(`\nDone — +${grand} relationships across ${items.length} research(es).`);
  console.log('Open a research → Explore: the graph + timeline should be noticeably richer.\n');
}

main().catch((e) => { console.error('backfill runner failed:', e?.message || e); process.exit(1); });
