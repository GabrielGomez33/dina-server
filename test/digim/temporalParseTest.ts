// File: test/digim/temporalParseTest.ts
// ============================================================================
// DIGIM — TEMPORAL PARSER PROOF (timeline foundation)
// ============================================================================
// Hermetic (no DB, no network, no clock). Proves parseTemporal() converts the
// free-form date expressions a real knowledge graph produces — "300,000 years
// ago", "10,000 BCE", "18th century", ISO dates — into a signed, sortable year
// plus a storable-ISO ONLY when the date fits the MySQL DATETIME window.
//
//   run:  npx ts-node test/digim/temporalParseTest.ts
// ============================================================================

import { parseTemporal } from '../../src/modules/digim/web/graph/temporalParse';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.error(`  ❌ ${name}`); }
}
function approxEq(a: number | null, b: number, eps = 0.6): boolean {
  return a !== null && Math.abs(a - b) <= eps;
}
function section(t: string): void { console.log(`\n▶ ${t}`); }

// Deterministic reference year so "N years ago" is reproducible in CI.
const REF = 2025;
const P = (s: string) => parseTemporal(s, REF);

function main(): void {
  console.log('=== DIGIM — Temporal Parser Proof ===');

  section('prehistoric "years ago" → negative sortValue, never storable as ISO');
  ok(approxEq(P('300,000 years ago').sortValue, REF - 300000), '"300,000 years ago" ≈ -297975');
  ok(P('300,000 years ago').iso === null, '"300,000 years ago" is NOT ISO-storable');
  ok(P('300,000 years ago').label !== null, '"300,000 years ago" keeps a human label');
  ok(approxEq(P('2.5 million years ago').sortValue, REF - 2_500_000), '"2.5 million years ago" ≈ -2497975');
  ok(approxEq(P('5 mya').sortValue, REF - 5_000_000), '"5 mya" == 5 million years ago');
  ok(approxEq(P('300 kya').sortValue, REF - 300_000), '"300 kya" == 300 thousand years ago');
  ok(approxEq(P('4 bya').sortValue, REF - 4_000_000_000), '"4 bya" == 4 billion years ago');

  section('explicit BCE / BC → negative year');
  ok(approxEq(P('10,000 BCE').sortValue, -10000), '"10,000 BCE" == -10000');
  ok(P('10,000 BCE').iso === null, '"10,000 BCE" is NOT ISO-storable');
  ok(approxEq(P('3200 BC').sortValue, -3200), '"3200 BC" == -3200');
  ok(approxEq(P('1.5 million BC').sortValue, -1_500_000), '"1.5 million BC" == -1.5e6');
  ok(approxEq(P('44 BCE').sortValue, -44), '"44 BCE" == -44 (Caesar)');

  section('centuries (ordinal) → mid-century year');
  ok(approxEq(P('18th century').sortValue, 1750), '"18th century" == 1750');
  ok(P('18th century').iso === '1750-01-01 00:00:00', '"18th century" is ISO-storable (in range)');
  ok(approxEq(P('5th century BCE').sortValue, -450), '"5th century BCE" == -450');
  ok(P('5th century BCE').iso === null, '"5th century BCE" is NOT ISO-storable');
  ok(approxEq(P('21st century').sortValue, 2050), '"21st century" == 2050');

  section('bare year / CE / AD → positive year, ISO-storable when in range');
  ok(approxEq(P('1990').sortValue, 1990), '"1990" == 1990');
  ok(P('1990').iso === '1990-01-01 00:00:00', '"1990" is ISO-storable');
  ok(approxEq(P('2020').sortValue, 2020), '"2020" == 2020');
  ok(approxEq(P('AD 1500').sortValue, 1500), '"AD 1500" == 1500');
  ok(approxEq(P('1969 CE').sortValue, 1969), '"1969 CE" == 1969');
  ok(P('800').iso === null, '"800" (year < 1000) is NOT ISO-storable but still parses');
  ok(approxEq(P('800').sortValue, 800), '"800" sortValue == 800');

  section('circa / approx prefixes → year kept, label marked');
  ok(approxEq(P('circa 1500').sortValue, 1500), '"circa 1500" == 1500');
  ok(P('circa 1500').label === 'circa 1500', '"circa 1500" label preserved');
  ok(approxEq(P('~1200').sortValue, 1200), '"~1200" == 1200');
  ok(approxEq(P('about 1850').sortValue, 1850), '"about 1850" == 1850');

  section('full ISO dates → fractional sortValue + storable ISO');
  ok(approxEq(P('1969-07-20').sortValue, 1969.55, 0.05), '"1969-07-20" sortValue ≈ 1969.55');
  ok(P('1969-07-20').iso === '1969-07-20 00:00:00', '"1969-07-20" is ISO-storable');
  ok(approxEq(P('2001-09').sortValue, 2001.67, 0.05), '"2001-09" (partial ISO) ≈ 2001.67');

  section('unparseable / empty → all-null (treated as undated)');
  ok(P('').sortValue === null && P('').iso === null, 'empty string → all null');
  ok(P('null').sortValue === null, '"null" → null');
  ok(P('unknown').sortValue === null, '"unknown" → null');
  ok(P('sometime later').sortValue === null, '"sometime later" → null');
  ok(P('the distant past').sortValue === null, '"the distant past" → null');

  section('determinism / never-throws');
  ok(parseTemporal('300,000 years ago', 2025).sortValue === parseTemporal('300,000 years ago', 2025).sortValue, 'deterministic given refYear');
  let threw = false;
  try { parseTemporal({ weird: true } as any); parseTemporal(undefined as any); parseTemporal(NaN as any); }
  catch { threw = true; }
  ok(!threw, 'never throws on garbage input');

  section('ordering invariant — the property the timeline depends on');
  const order = ['300,000 years ago', '10,000 BCE', '3200 BC', '44 BCE', '18th century', '1990', '2020-06-01']
    .map((s) => ({ s, v: P(s).sortValue }));
  let monotonic = true;
  for (let i = 1; i < order.length; i++) {
    if (order[i].v === null || order[i - 1].v === null || (order[i].v as number) <= (order[i - 1].v as number)) monotonic = false;
  }
  ok(monotonic, 'chronological inputs produce strictly increasing sortValues');

  console.log(`\n${failed === 0 ? '✅' : '❌'} temporalParse: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

main();
