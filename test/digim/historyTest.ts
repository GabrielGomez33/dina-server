// File: test/digim/historyTest.ts
// ============================================================================
// DIGIM RESEARCH HISTORY — PURE ROW-PARSER EDGE CASES
// ============================================================================
// Hermetic (no DB): the intelligence-row → summary/record mappers that back the
// frontend's history sidebar and detail view. The real risk they guard is that
// mysql2 returns JSON columns as STRINGS in some drivers/versions and as parsed
// OBJECTS in others — both must produce identical, well-typed output.
//
//   run:  npx ts-node test/digim/historyTest.ts   (npm run test:history)
// ============================================================================

import { toResearchSummary, parseIntelligenceRow } from '../../src/modules/digim/web/storage/webResearchStore';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.error(`  ❌ ${name}`); }
}
function section(t: string): void { console.log(`\n▶ ${t}`); }

// A representative row as stored by storeIntelligence(), with JSON columns as
// STRINGS (the stricter of the two driver behaviours).
function rowStringJson(): any {
  return {
    id: 'r1',
    query_text: 'the 2026 Iran-USA war',
    intelligence_type: 'deep',
    confidence_score: '0.82',
    model_used: 'mistral:7b',
    processing_time_ms: 91234,
    generated_at: '2026-07-13 14:28:42',
    expires_at: null,
    source_content_ids: JSON.stringify(['c1', 'c2', 'c3']),
    summary: '  Iran and the United States   escalated…  ',
    insights: JSON.stringify(['oil shock', 'Hormuz closure']),
    trends: JSON.stringify(['Brent > $120']),
    raw_data: JSON.stringify({
      entities: [{ text: 'Iran', type: 'location' }],
      topics: [{ topic: 'oil', relevance: 0.9 }],
      caveats: ['some sources disputed'],
      sources: ['https://reuters.com/x', 'https://apnews.com/y'],
    }),
  };
}

async function main(): Promise<void> {
  console.log('=== DIGIM Research History — pure parser edge cases ===');

  section('toResearchSummary — lightweight sidebar row');
  {
    const s = toResearchSummary(rowStringJson());
    ok(s.id === 'r1' && s.query.includes('Iran'), 'id + query mapped');
    ok(s.level === 'deep', 'intelligence_type → level');
    ok(Math.abs(s.confidence - 0.82) < 1e-9, 'confidence coerced from string');
    ok(s.sourceCount === 3, 'sourceCount from JSON-string array');
    ok(s.snippet === 'Iran and the United States escalated…', 'snippet trimmed + whitespace-collapsed');
    ok(typeof s.generatedAt === 'string' && s.generatedAt!.startsWith('2026-07-13'), 'generated_at → ISO');
    ok(s.expiresAt === null, 'null expiry preserved');
  }

  section('toResearchSummary — JSON columns already parsed (object form)');
  {
    const row = rowStringJson();
    row.source_content_ids = ['c1', 'c2']; // object, not string
    const s = toResearchSummary(row);
    ok(s.sourceCount === 2, 'object-form source ids counted identically');
  }

  section('parseIntelligenceRow — full detail record');
  {
    const r = parseIntelligenceRow(rowStringJson());
    ok(r.summary.includes('escalated'), 'full summary retained (not the snippet)');
    ok(r.keyInsights.length === 2 && r.keyInsights[0] === 'oil shock', 'insights array parsed');
    ok(r.trends.length === 1, 'trends parsed');
    ok(r.entities.length === 1 && r.entities[0].text === 'Iran', 'entities from raw_data');
    ok(r.topics.length === 1 && r.sources.length === 2, 'topics + sources from raw_data');
    ok(r.caveats.length === 1, 'caveats from raw_data');
    ok(r.sourceContentIds.length === 3 && r.sourceContentIds[0] === 'c1', 'source content ids as strings');
  }

  section('robustness — malformed / missing fields never throw');
  {
    ok((() => { try { const s = toResearchSummary({}); return s.id === 'undefined' || s.id === '' || typeof s.id === 'string'; } catch { return false; } })(), 'empty row → summary without throwing');
    const bad = rowStringJson(); bad.raw_data = '{not valid json'; bad.insights = 'oops'; bad.source_content_ids = null;
    const r = parseIntelligenceRow(bad);
    ok(r.entities.length === 0 && r.sources.length === 0, 'unparseable raw_data → empty arrays');
    ok(r.keyInsights.length === 0, 'unparseable insights → []');
    ok(r.sourceContentIds.length === 0 && r.sourceCount === 0, 'null source ids → 0');
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) { console.error('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
  console.log('✅ DIGIM research-history parser checks passed.');
  process.exit(0);
}

main().catch((err) => { console.error('test harness crashed:', err); process.exit(1); });
