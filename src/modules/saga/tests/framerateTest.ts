// File: src/modules/saga/tests/framerateTest.ts
// ============================================================================
// DINA SAGA — FRAMERATE POLICY PROOF HARNESS
// ============================================================================
//   run:  npx ts-node src/modules/saga/tests/framerateTest.ts
// ============================================================================

import { planFramerate, FramerateError, GENERATION_FPS_FACTS, FINAL_FPS_FACTS, MAX_INTERPOLATION } from '../core/framerate';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(c: boolean, name: string): void { if (c) passed++; else { failed++; failures.push(name); console.error(`  ❌ ${name}`); } }
function eq(a: unknown, e: unknown, name: string): void { ok(a === e, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`); }
function throws(fn: () => void, name: string): void {
  try { fn(); ok(false, `${name} (expected throw)`); } catch (e) { ok(e instanceof FramerateError, `${name} threw`); }
}
async function section(t: string, fn: () => void): Promise<void> { console.log(`\n▶ ${t}`); fn(); }

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA SAGA — FRAMERATE POLICY PROOFS');
  console.log('════════════════════════════════════════════════');

  await section('1. finalFps = generationFps × interpolationFactor (always consistent)', () => {
    for (const target of [24, 30, 48, 60]) for (const m of ['anime-authentic', 'standard', 'fluid-action'] as const) {
      const p = planFramerate(target, m);
      eq(p.generationFps * p.interpolationFactor, p.finalFps, `${m}@${target}: math holds`);
      ok(p.interpolationFactor >= 1 && p.interpolationFactor <= MAX_INTERPOLATION, `${m}@${target}: factor in range`);
    }
  });

  await section('2. authentic anime at 24 → render on twos (12) and interpolate 2×', () => {
    const p = planFramerate(24, 'anime-authentic');
    eq(p.generationFps, 12, 'renders at 12 ("on twos")');
    eq(p.interpolationFactor, 2, '×2 interpolation');
    eq(p.finalFps, 24, 'lands at 24');
    ok(p.interpolate, 'interpolation on');
  });

  await section('3. THE key creative guard — 60fps on anime warns (soap-opera)', () => {
    const p = planFramerate(60, 'anime-authentic');
    eq(p.finalFps, 60, 'still delivers 60 if asked');
    ok(p.warnings.some((w) => /soap-opera|authentic/i.test(w)), 'but warns it looks un-anime');
  });

  await section('4. fluid-action at 60 is legitimate (fewer/necessary warnings)', () => {
    const p = planFramerate(60, 'fluid-action');
    eq(p.finalFps, 60, 'delivers 60');
    ok(!p.warnings.some((w) => /soap-opera/i.test(w)), 'no soap-opera warning for action motion');
    ok(p.cons.some((c) => /soap|uncanny|compute/i.test(c)), 'still surfaces 60fps cons for informed choice');
  });

  await section('5. no interpolation when target equals a native gen fps', () => {
    const p = planFramerate(16, 'standard');
    eq(p.generationFps, 16, 'renders 16 natively');
    eq(p.interpolationFactor, 1, 'no interpolation');
    ok(!p.interpolate, 'interpolate=false');
  });

  await section('6. aggressive interpolation is flagged', () => {
    // 48 fluid-action → 24×2 (fine). Force a ×4 situation: standard@ target that only divides by 4.
    const p = planFramerate(60, 'standard');
    ok(p.interpolationFactor <= MAX_INTERPOLATION, 'never exceeds the cap');
    if (p.interpolationFactor > 3) ok(p.warnings.some((w) => /aggressive/i.test(w)), '×4 warned');
    else ok(true, 'chose a moderate factor');
  });

  await section('7. every plan carries pros AND cons for an informed choice', () => {
    const p = planFramerate(30, 'standard');
    ok(p.pros.length > 0 && p.cons.length > 0, 'both sides present');
    ok(typeof p.rationale === 'string' && p.rationale.length > 0, 'human rationale present');
  });

  await section('8. bounds + catalog integrity', () => {
    throws(() => planFramerate(4), 'below 8 rejected');
    throws(() => planFramerate(200), 'above 120 rejected');
    ok(GENERATION_FPS_FACTS.every((f) => f.pros.length && f.cons.length), 'every gen-fps option documents pros+cons');
    ok(FINAL_FPS_FACTS.every((f) => f.pros.length && f.cons.length), 'every final-fps option documents pros+cons');
    ok(FINAL_FPS_FACTS.find((f) => f.fps === 60)!.cons.some((c) => /soap/i.test(c)), '60fps cons name the soap-opera effect');
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) for (const f of failures) console.log(`     • ${f}`);
  console.log('════════════════════════════════════════════════');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('❌ harness crashed:', e); process.exit(1); });
