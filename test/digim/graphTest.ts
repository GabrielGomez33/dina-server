// File: test/digim/graphTest.ts
// ============================================================================
// DIGIM PHASE 2.4b — RELATIONSHIP GRAPH PURE-LOGIC EDGE CASES
// ============================================================================
// Hermetic (no DB): entity resolution (the alias-merging heart), predicate/type
// normalization, adaptive view selection, and DB-row → type mapping. The live
// DB round-trip (upsert/subgraph) is verified on the box per PHASE2_4.md — the
// sandbox has no MySQL.
//
//   run:  npx ts-node test/digim/graphTest.ts   (npm run test:graph)
// ============================================================================

import { canonicalizeEntityName, normalizePredicate, normalizeEntityType } from '../../src/modules/digim/web/graph/entityResolution';
import { suggestView } from '../../src/modules/digim/web/graph/graphView';
import { rowToNode, rowToEdge } from '../../src/modules/digim/web/graph/graphStore';
import { parseTriples, GraphExtractor } from '../../src/modules/digim/web/graph/graphExtractor';
import { DigimWebConfig } from '../../src/modules/digim/web/config/webConfig';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.error(`  ❌ ${name}`); }
}
function section(t: string): void { console.log(`\n▶ ${t}`); }
const canon = canonicalizeEntityName;

function extractorCfg(): DigimWebConfig {
  return { graphExtractMaxDocs: 6, graphMaxTriples: 40, synthesisPerDocChars: 2000 } as DigimWebConfig;
}

async function main(): Promise<void> {
  console.log('=== DIGIM Phase 2.4b — Relationship Graph Edge Cases ===');

  // --------------------------------------------------------------------------
  section('canonicalizeEntityName — merges the exact aliases the live run produced');
  ok(canon('Strait of Hormuz') === canon('The Strait of Hormuz'), '"The Strait of Hormuz" == "Strait of Hormuz"');
  ok(canon('Ali Khamenei') === canon('Supreme Leader Ali Khamenei'), '"Supreme Leader Ali Khamenei" == "Ali Khamenei"');
  ok(canon('Donald Trump') === canon('US President Donald Trump'), '"US President Donald Trump" == "Donald Trump"');
  ok(canon('Strait of Hormuz') === 'strait of hormuz', 'canonical form is normalized');
  ok(canon('Ali Khamenei') === 'ali khamenei', 'honorific stripped to bare name');
  ok(canon('  IRAN  ') === 'iran', 'trim + lower-case');
  ok(canon(canon('The Strait of Hormuz')) === canon('The Strait of Hormuz'), 'idempotent');
  ok(canon('') === '' && canon(null as any) === '', 'empty / null → empty key');
  ok(canon('The Hague') !== '', '"The Hague" does not collapse to empty (name kept)');

  // --------------------------------------------------------------------------
  section('normalizePredicate — stable edge labels');
  ok(normalizePredicate('retaliated against') === 'retaliated_against', 'spaces → underscores');
  ok(normalizePredicate('launched') === 'launched', 'single word');
  ok(normalizePredicate('is the Chokepoint-For!!') === 'is_the_chokepoint_for', 'punctuation collapsed');
  ok(normalizePredicate('') === 'related_to', 'empty → related_to fallback');

  // --------------------------------------------------------------------------
  section('normalizeEntityType — synonyms → enum');
  ok(normalizeEntityType('country') === 'location', 'country → location');
  ok(normalizeEntityType('org') === 'organization', 'org → organization');
  ok(normalizeEntityType('operation') === 'event', 'operation → event');
  ok(normalizeEntityType('person') === 'person', 'passthrough valid type');
  ok(normalizeEntityType('nonsense') === 'other', 'unknown → other');

  // --------------------------------------------------------------------------
  section('suggestView — adaptive, deterministic, total');
  ok(suggestView([], []) === 'network', 'empty graph → network');
  ok(suggestView([{ occurredAt: '2026-01-01' }, { occurredAt: '2026-02-01' }, { occurredAt: null }] as any, []) === 'temporal', 'majority time-stamped → temporal');
  const embedded8 = Array.from({ length: 8 }, () => ({ occurredAt: null, embeddingRef: 'v' }));
  ok(suggestView(embedded8 as any, []) === 'semantic', '8+ embedded, none timed → semantic');
  ok(suggestView([{ occurredAt: null, embeddingRef: 'v' }, { occurredAt: null, embeddingRef: 'v' }] as any, []) === 'network', 'few embedded → network (too small for semantic)');
  const timedAndEmbedded = Array.from({ length: 8 }, () => ({ occurredAt: '2026-01-01', embeddingRef: 'v' }));
  ok(suggestView(timedAndEmbedded as any, []) === 'temporal', 'temporal takes precedence over semantic');
  ok(suggestView([{ occurredAt: null }, { occurredAt: null }, { occurredAt: null }] as any, []) === 'network', 'no signals → network');

  // --------------------------------------------------------------------------
  section('rowToNode / rowToEdge — DB row → type mapping');
  const n = rowToNode({ id: 'e1', name: 'Iran', type: 'location', occurred_at: null, mention_count: 5, embedding_ref: null });
  ok(n.id === 'e1' && n.type === 'location' && n.mentionCount === 5 && n.occurredAt === null, 'entity row mapped');
  const ev = rowToNode({ id: 'ev1', name: 'Operation Epic Fury', type: 'event', occurred_at: '2026-02-28 00:00:00', mention_count: 1 });
  ok(typeof ev.occurredAt === 'string' && ev.occurredAt!.startsWith('2026-02-28'), 'event occurred_at → ISO string');
  const e = rowToEdge({ id: 'r1', subject_id: 'a', predicate: 'launched', object_id: 'b', corroboration_count: 3, confidence: '0.800' });
  ok(e.subjectId === 'a' && e.objectId === 'b' && e.predicate === 'launched' && e.corroborationCount === 3, 'edge row mapped');
  ok(Math.abs(e.confidence - 0.8) < 1e-9, 'confidence coerced from string decimal');

  // --------------------------------------------------------------------------
  section('parseTriples — maps source numbers to URLs, drops junk, clamps');
  const urls = ['https://a.com', 'https://b.com'];
  const good = parseTriples('{"triples":[{"subject":"US","predicate":"launched","object":"Operation Epic Fury","objectType":"event","occurredAt":"2026-02-28","source":1,"confidence":0.9}]}', urls, 40);
  ok(good.length === 1 && good[0].sourceUrl === 'https://a.com', 'source number → URL');
  ok(good[0].objectType === 'event' && good[0].occurredAt!.startsWith('2026-02-28'), 'event type + occurredAt parsed');
  ok(parseTriples('{"triples":[{"subject":"X","predicate":"p","object":"Y","source":9}]}', urls, 40)[0].sourceUrl === '', 'out-of-range source → empty URL');
  ok(parseTriples('{"triples":[{"subject":"X","predicate":"p"}]}', urls, 40).length === 0, 'missing object → dropped');
  ok(parseTriples('{"triples":[{"subject":"Iran","predicate":"is","object":"iran","source":1}]}', urls, 40).length === 0, 'self-loop dropped');
  ok(parseTriples('{"triples":[{"subject":"a","predicate":"p","object":"b"},{"subject":"c","predicate":"p","object":"d"}]}', urls, 1).length === 1, 'clamped to max');
  ok(parseTriples('not json', urls, 40).length === 0, 'garbage → []');
  // Truncation resilience: an array cut off at the token limit (no closing ]/})
  // must still yield the COMPLETE objects, not zero.
  const truncated = '{"triples":[{"subject":"US","predicate":"launched","object":"Operation Epic Fury","source":1},{"subject":"Iran","predicate":"retaliated against","object":"US","source":2},{"subject":"Brent Crude","predicate":"surged';
  const salvaged = parseTriples(truncated, urls, 40);
  ok(salvaged.length === 2, 'truncated array → 2 complete triples salvaged (partial dropped)');
  ok(salvaged[1].subject === 'Iran' && salvaged[1].sourceUrl === 'https://b.com', 'salvaged triple keeps fields + source mapping');

  // --------------------------------------------------------------------------
  section('GraphExtractor.extract — orchestration (mock LLM)');
  {
    let genCalls = 0;
    const ext = new GraphExtractor(extractorCfg(), {
      generate: async () => { genCalls++; return '{"triples":[{"subject":"US","predicate":"sanctioned","object":"Iran","source":1,"confidence":0.8}]}'; },
    });
    const triples = await ext.extract([{ title: 'T', url: 'https://src.example/1', content: 'US sanctioned Iran.' }]);
    ok(triples.length === 1 && triples[0].sourceUrl === 'https://src.example/1', 'extracted triple carries its source URL');
    ok(genCalls === 1, 'one batched LLM call');
  }
  {
    const ext = new GraphExtractor(extractorCfg(), { generate: async () => { throw new Error('LLM down'); } });
    ok((await ext.extract([{ title: 'T', url: 'u', content: 'c' }])).length === 0, 'LLM failure → [] (never throws)');
  }
  {
    let genCalls = 0;
    const ext = new GraphExtractor(extractorCfg(), { generate: async () => { genCalls++; return '{}'; } });
    ok((await ext.extract([])).length === 0 && genCalls === 0, 'empty docs → [] with no LLM call');
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('FAILED:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('✅ Phase 2.4b graph pure-logic checks passed.');
  process.exit(0);
}

main().catch((err) => { console.error('test harness crashed:', err); process.exit(1); });
