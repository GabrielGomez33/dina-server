// File: test/digim/plannerTest.ts
// ============================================================================
// DIGIM PHASE 2.4a — RESEARCH PLANNER PURE-LOGIC + ORCHESTRATION EDGE CASES
// ============================================================================
// Hermetic (no LLM/network): the planner takes injected deps, so the full
// decompose → run-facets → fuse orchestration is proven with mocks, plus the
// pure parse/dedupe/union helpers. Live investigation verified on the box.
//
//   run:  npx ts-node test/digim/plannerTest.ts   (npm run test:planner)
// ============================================================================

import {
  ResearchPlanner, parsePlan, dedupeSources, unionEntities, PlannerDeps,
} from '../../src/modules/digim/web/planner/researchPlanner';
import { DigimWebConfig } from '../../src/modules/digim/web/config/webConfig';
import { WebInsight } from '../../src/modules/digim/web/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.error(`  ❌ ${name}`); }
}
function section(t: string): void { console.log(`\n▶ ${t}`); }

function makeCfg(over: Partial<DigimWebConfig> = {}): DigimWebConfig {
  return { plannerMaxSubQueries: 5, plannerConcurrency: 2, plannerFacetLevel: 'surface', ...over } as DigimWebConfig;
}
function insight(over: Partial<WebInsight> = {}): WebInsight {
  return { summary: '', keyInsights: [], entities: [], topics: [], trends: [], confidence: 0.5, sources: [], caveats: [], ...over };
}

async function main(): Promise<void> {
  console.log('=== DIGIM Phase 2.4a — Research Planner Edge Cases ===');

  // --------------------------------------------------------------------------
  section('parsePlan — accepts each shape, clamps, dedupes, drops junk');
  ok(parsePlan('{"subQueries":[{"facet":"a","query":"q1"},{"facet":"b","query":"q2"}]}', 5).length === 2, 'subQueries shape');
  ok(parsePlan('{"facets":[{"facet":"a","query":"q1"}]}', 5).length === 1, 'facets shape');
  ok(parsePlan('[{"facet":"a","query":"q1"}]', 5).length === 1, 'bare array shape');
  ok(parsePlan('```json\n{"subQueries":[{"query":"q1"}]}\n```', 5)[0].facet === 'aspect', 'fence-wrapped + default facet label');
  ok(parsePlan('{"subQueries":[{"query":"dup"},{"query":"DUP"},{"query":"x"}]}', 5).length === 2, 'dedupe by query (case-insensitive)');
  ok(parsePlan('{"subQueries":[{"query":"a"},{"query":"b"},{"query":"c"}]}', 2).length === 2, 'clamp to max');
  ok(parsePlan('{"subQueries":[{"facet":"a"}]}', 5).length === 0, 'item without query dropped');
  ok(parsePlan('not json', 5).length === 0, 'garbage → []');
  ok(parsePlan('', 5).length === 0, 'empty → []');

  // --------------------------------------------------------------------------
  section('dedupeSources / unionEntities');
  ok(dedupeSources([{ title: 'A', url: 'https://x.com/' }, { title: 'A2', url: 'https://x.com' }]).length === 1, 'sources deduped by normalized url');
  ok(dedupeSources([{ title: 'F', url: 'facet://timeline' }]).length === 0, 'facet:// pseudo-sources dropped');
  ok(unionEntities([{ text: 'Iran', type: 'location' }, { text: 'iran', type: 'x' }]).length === 1, 'entities deduped case-insensitively');
  ok(unionEntities([{ text: 'Iran', type: 'location' }, { text: 'US', type: 'location' }]).length === 2, 'distinct entities kept');

  // --------------------------------------------------------------------------
  section('investigate — happy path (decompose → 3 facets → fuse)');
  {
    let synthCalls = 0;
    const deps: PlannerDeps = {
      generate: async () => '{"subQueries":[{"facet":"timeline","query":"q1"},{"facet":"causes","query":"q2"},{"facet":"effects","query":"q3"}]}',
      research: async (q) => ({
        insight: insight({ summary: `S:${q}`, sources: [{ title: q, url: `https://ex.com/${q}` }], entities: [{ text: 'Iran', type: 'location' }] }),
        documentsGathered: 3,
        basis: 'web',
      }),
      synthesize: async () => { synthCalls++; return insight({ summary: 'FUSED', keyInsights: ['ki'] }); },
    };
    const r = await new ResearchPlanner(makeCfg(), deps).investigate('broad question');
    ok(r.facetsPlanned === 3 && r.facets.length === 3, 'three facets planned + researched');
    ok(r.synthesis.summary === 'FUSED', 'fused synthesis used');
    ok(synthCalls === 1, 'fuse synthesize called exactly once');
    ok(r.synthesis.sources.length === 3, 'real provenance: union of 3 facet sources');
    ok(r.synthesis.entities.length === 1, 'entities unioned + deduped (Iran)');
    ok(r.sourcesConsulted === 3, 'sourcesConsulted matches unioned sources');
  }

  // --------------------------------------------------------------------------
  section('investigate — decompose LLM failure → single-facet fallback');
  {
    let researchCalls = 0;
    const deps: PlannerDeps = {
      generate: async () => { throw new Error('LLM down'); },
      research: async (q) => { researchCalls++; return { insight: insight({ summary: `S:${q}`, sources: [{ title: 'a', url: 'https://a/1' }] }), documentsGathered: 1, basis: 'web' }; },
      synthesize: async () => insight({ summary: 'FUSED' }),
    };
    const r = await new ResearchPlanner(makeCfg(), deps).investigate('q');
    ok(r.facetsPlanned === 1 && researchCalls === 1, 'falls back to a single facet, still researches');
    ok(r.plan[0].facet === 'overview', 'fallback facet labelled overview');
  }

  // --------------------------------------------------------------------------
  section('investigate — all facets empty → honest empty synthesis (no fuse)');
  {
    let synthCalls = 0;
    const deps: PlannerDeps = {
      generate: async () => '{"subQueries":[{"facet":"a","query":"q1"},{"facet":"b","query":"q2"}]}',
      research: async () => ({ insight: insight({ summary: '' }), documentsGathered: 0, basis: 'none' }),
      synthesize: async () => { synthCalls++; return insight({ summary: 'FUSED' }); },
    };
    const r = await new ResearchPlanner(makeCfg(), deps).investigate('q');
    ok(synthCalls === 0, 'fuse skipped when nothing was gathered');
    ok(/No sources were gathered/.test(r.synthesis.summary), 'honest empty summary');
    ok(r.synthesis.sources.length === 0, 'no sources claimed');
  }

  // --------------------------------------------------------------------------
  section('investigate — fuse synthesis failure → assembled fallback, real sources kept');
  {
    const deps: PlannerDeps = {
      generate: async () => '{"subQueries":[{"facet":"a","query":"q1"},{"facet":"b","query":"q2"}]}',
      research: async (q) => ({ insight: insight({ summary: `S:${q}`, sources: [{ title: q, url: `https://ex.com/${q}` }] }), documentsGathered: 2, basis: 'web' }),
      synthesize: async () => { throw new Error('fuse LLM down'); },
    };
    const r = await new ResearchPlanner(makeCfg(), deps).investigate('q');
    ok(/non-fused/.test(r.synthesis.caveats.join(' ')), 'fallback fusion caveat present');
    ok(r.synthesis.sources.length === 2, 'real facet sources still unioned in despite fuse failure');
  }

  // --------------------------------------------------------------------------
  section('investigate — concurrency cap researches every facet exactly once');
  {
    let concurrent = 0, maxConcurrent = 0, total = 0;
    const deps: PlannerDeps = {
      generate: async () => '{"subQueries":[{"query":"q1"},{"query":"q2"},{"query":"q3"},{"query":"q4"}]}',
      research: async (q) => {
        concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); total++;
        await new Promise((r) => setTimeout(r, 5));
        concurrent--;
        return { insight: insight({ summary: `S:${q}`, sources: [{ title: q, url: `https://ex.com/${q}` }] }), documentsGathered: 1, basis: 'web' };
      },
      synthesize: async () => insight({ summary: 'FUSED' }),
    };
    const r = await new ResearchPlanner(makeCfg({ plannerConcurrency: 2 }), deps).investigate('q');
    ok(total === 4 && r.facets.length === 4, 'all 4 facets researched exactly once');
    ok(maxConcurrent <= 2, 'concurrency cap (2) respected');
  }

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error('FAILED:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('✅ Phase 2.4a research-planner checks passed.');
  process.exit(0);
}

main().catch((err) => { console.error('test harness crashed:', err); process.exit(1); });
