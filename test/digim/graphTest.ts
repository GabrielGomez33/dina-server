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

import { canonicalizeEntityName, normalizePredicate, normalizeEntityType, isLowValueEntity } from '../../src/modules/digim/web/graph/entityResolution';
import { suggestView } from '../../src/modules/digim/web/graph/graphView';
import { rowToNode, rowToEdge } from '../../src/modules/digim/web/graph/graphStore';
import { parseTriples, GraphExtractor } from '../../src/modules/digim/web/graph/graphExtractor';
import { projectEmbeddings } from '../../src/modules/digim/web/graph/semanticProjection';
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
  ok(normalizePredicate('the struck') === 'struck', 'leading article dropped');

  // --------------------------------------------------------------------------
  section('isLowValueEntity — drop generic/indefinite/pronoun references (2.4b polish)');
  ok(isLowValueEntity('a container ship') === true, '"a container ship" → low value');
  ok(isLowValueEntity('three vessels') === true, '"three vessels" → low value');
  ok(isLowValueEntity('3 ships') === true, '"3 ships" → low value');
  ok(isLowValueEntity('they') === true && isLowValueEntity('it') === true, 'pronouns → low value');
  ok(isLowValueEntity('the government') === false, '"the government" kept (canonicalizer handles "the")');
  ok(isLowValueEntity('Iran') === false && isLowValueEntity('United States') === false, 'named entities kept');
  ok(isLowValueEntity('Qatari-flagged vessel al-Rakiyat') === false, 'specific named vessel kept');

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
  ok(parseTriples('{"triples":[{"subject":"Alpha","predicate":"p","object":"Beta","source":9}]}', urls, 40)[0].sourceUrl === '', 'out-of-range source → empty URL');
  ok(parseTriples('{"triples":[{"subject":"Alpha","predicate":"p"}]}', urls, 40).length === 0, 'missing object → dropped');
  ok(parseTriples('{"triples":[{"subject":"Iran","predicate":"is","object":"iran","source":1}]}', urls, 40).length === 0, 'self-loop dropped');
  ok(parseTriples('{"triples":[{"subject":"Iran","predicate":"struck","object":"a container ship","source":1}]}', urls, 40).length === 0, 'triple with generic entity dropped');
  ok(parseTriples('{"triples":[{"subject":"United States","predicate":"sanctioned","object":"Iran","source":1}]}', urls, 40).length === 1, 'named-entity triple kept');
  ok(parseTriples('{"triples":[{"subject":"Alpha","predicate":"p","object":"Beta"},{"subject":"Gamma","predicate":"p","object":"Delta"}]}', urls, 1).length === 1, 'clamped to max');
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

  // --------------------------------------------------------------------------
  section('projectEmbeddings — PCA 3D projection (the semantic view)');
  {
    // Degenerate corpora.
    ok(projectEmbeddings([]).points.length === 0, 'empty corpus → no points');
    const one = projectEmbeddings([{ id: 'a', vector: [1, 2, 3], label: 'A' }]);
    ok(one.points.length === 1 && one.points[0].x === 0 && one.points[0].y === 0 && one.points[0].z === 0, 'single point → origin (nothing to spread)');
    ok(projectEmbeddings([{ id: 'a', vector: [] }, { id: 'b', vector: [] }]).points.length === 0, 'all-empty vectors → dropped');

    // Determinism: same input → identical output (no RNG).
    const corpus = [
      { id: '1', vector: [10, 0, 0, 0], label: 'x+' },
      { id: '2', vector: [9, 1, 0, 0], label: 'x+' },
      { id: '3', vector: [0, 10, 0, 0], label: 'y+' },
      { id: '4', vector: [0, 9, 1, 0], label: 'y+' },
      { id: '5', vector: [-10, 0, 0, 0], label: 'x-' },
      { id: '6', vector: [0, -10, 0, 0], label: 'y-' },
    ];
    const p1 = projectEmbeddings(corpus);
    const p2 = projectEmbeddings(corpus);
    ok(JSON.stringify(p1.points) === JSON.stringify(p2.points), 'deterministic — identical corpus → identical cloud');
    ok(p1.points.length === 6 && p1.dimensions === 4, 'all points projected; dimensionality reported');

    // Coordinates are finite and rescaled into [-1, 1].
    const inRange = p1.points.every((pt) => [pt.x, pt.y, pt.z].every((v) => Number.isFinite(v) && v >= -1.0000001 && v <= 1.0000001));
    ok(inRange, 'coordinates finite and rescaled to [-1, 1]');

    // Structure preservation: two points that share a near-identical vector must
    // land closer to each other than to a clearly different one.
    const byId = new Map(p1.points.map((pt) => [pt.id, pt]));
    const d = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const near = d(byId.get('1'), byId.get('2'));   // both x+
    const far = d(byId.get('1'), byId.get('6'));    // x+ vs y-
    ok(near < far, 'similar vectors project closer than dissimilar ones');

    // Modal-dimension guard: a stray wrong-length vector is skipped, not fatal.
    const mixed = projectEmbeddings([
      { id: '1', vector: [1, 0, 0, 0] }, { id: '2', vector: [0, 1, 0, 0] },
      { id: '3', vector: [0, 0, 1, 0] }, { id: 'bad', vector: [1, 2] },
    ]);
    ok(mixed.points.length === 3 && !mixed.points.some((pt) => pt.id === 'bad'), 'off-dimension vector skipped, rest projected');

    // Explained variance is a fraction per axis, descending-ish, bounded.
    ok(p1.explainedVariance.length === 3 && p1.explainedVariance.every((v) => v >= 0 && v <= 1.0000001), 'explained variance ∈ [0,1] per axis');

    // High-dimensional smoke: 1024-D like production, deterministic seed vectors.
    const hi = Array.from({ length: 12 }, (_, i) => ({
      id: `h${i}`,
      vector: Array.from({ length: 1024 }, (_, j) => Math.sin((i + 1) * 0.31 + j * 0.017)),
    }));
    const hp = projectEmbeddings(hi);
    ok(hp.points.length === 12 && hp.dimensions === 1024 && hp.points.every((pt) => Number.isFinite(pt.x)), '1024-D corpus → finite 3D cloud');
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
