// File: src/modules/saga/tests/fidelityTest.ts
// ============================================================================
// DINA SAGA — FIDELITY SCALE PROOF HARNESS
// ============================================================================
// Proves the 0..10 dial is monotonic, bounded, clamped, and pinned at its
// endpoints — so "free drawing" and "near-copy" mean exactly what the UI says,
// and every step in between moves every knob in the correct direction.
//
//   run:  npx ts-node src/modules/saga/tests/fidelityTest.ts
// ============================================================================

import { fidelityToParams, FidelityError, FIDELITY_MIN, FIDELITY_MAX } from '../core/fidelity';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(c: boolean, name: string): void { if (c) passed++; else { failed++; failures.push(name); console.error(`  ❌ ${name}`); } }
function eq(a: unknown, e: unknown, name: string): void { ok(a === e, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`); }
async function section(t: string, fn: () => void): Promise<void> { console.log(`\n▶ ${t}`); fn(); }

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA SAGA — FIDELITY SCALE PROOFS');
  console.log('════════════════════════════════════════════════');

  await section('1. endpoints mean exactly what the UI says', () => {
    const free = fidelityToParams(0);
    eq(free.ipAdapterWeight, 0.25, '0 → faint identity');
    eq(free.controlnetStrength, 0, '0 → no structural lock (free drawing)');
    eq(free.denoise, 1, '0 → full generation');
    eq(free.label, 'free drawing', '0 → labelled free drawing');
    const copy = fidelityToParams(10);
    eq(copy.ipAdapterWeight, 0.9, '10 → strong identity');
    eq(copy.controlnetStrength, 1, '10 → full structural lock');
    eq(copy.controlnetEndPercent, 0.95, '10 → structure held almost the whole schedule');
    eq(copy.denoise, 0.45, '10 → close to source');
    eq(copy.label, 'near-copy', '10 → labelled near-copy');
  });

  await section('2. monotonic across every integer step (the core guarantee)', () => {
    let prev = fidelityToParams(0);
    let monoUp = true, monoDown = true;
    for (let lvl = 1; lvl <= 10; lvl++) {
      const cur = fidelityToParams(lvl);
      if (!(cur.ipAdapterWeight >= prev.ipAdapterWeight)) monoUp = false;
      if (!(cur.controlnetStrength >= prev.controlnetStrength)) monoUp = false;
      if (!(cur.controlnetEndPercent >= prev.controlnetEndPercent)) monoUp = false;
      if (!(cur.denoise <= prev.denoise)) monoDown = false; // denoise moves the OTHER way
      prev = cur;
    }
    ok(monoUp, 'ipAdapterWeight, controlnetStrength, controlnetEndPercent all non-decreasing');
    ok(monoDown, 'denoise is non-increasing (higher fidelity → closer to source)');
  });

  await section('3. every output stays within its declared bounds', () => {
    for (let lvl = 0; lvl <= 10; lvl++) {
      const p = fidelityToParams(lvl);
      ok(p.ipAdapterWeight >= 0.25 && p.ipAdapterWeight <= 0.9, `ipAdapterWeight bounded @${lvl}`);
      ok(p.controlnetStrength >= 0 && p.controlnetStrength <= 1, `controlnetStrength in [0,1] @${lvl}`);
      ok(p.controlnetEndPercent >= 0.4 && p.controlnetEndPercent <= 0.95, `controlnetEndPercent bounded @${lvl}`);
      ok(p.denoise >= 0.45 && p.denoise <= 1, `denoise in [0.45,1] @${lvl}`);
    }
  });

  await section('4. midpoint is genuinely halfway', () => {
    const mid = fidelityToParams(5);
    eq(mid.controlnetStrength, 0.5, 'level 5 → controlnetStrength 0.5');
    eq(mid.ipAdapterWeight, 0.575, 'level 5 → ipAdapterWeight halfway (0.25↔0.9)');
    eq(mid.label, 'balanced', 'level 5 → balanced');
  });

  await section('5. out-of-range levels CLAMP (a slider cannot exceed its ends)', () => {
    eq(fidelityToParams(-3).level, FIDELITY_MIN, 'negative clamps to 0');
    eq(fidelityToParams(-3).controlnetStrength, 0, 'negative behaves as free drawing');
    eq(fidelityToParams(99).level, FIDELITY_MAX, 'over-range clamps to 10');
    eq(fidelityToParams(99).ipAdapterWeight, 0.9, 'over-range behaves as near-copy');
  });

  await section('6. continuous levels interpolate (slider can be fractional)', () => {
    const q = fidelityToParams(2.5);
    ok(q.controlnetStrength > 0.2 && q.controlnetStrength < 0.3, 'level 2.5 → controlnetStrength ~0.25');
    eq(q.level, 2.5, 'fractional level preserved');
  });

  await section('7. non-finite level is a programming error, not a silent 0', () => {
    let threwNaN = false, threwInf = false;
    try { fidelityToParams(NaN); } catch (e) { threwNaN = e instanceof FidelityError; }
    try { fidelityToParams(Infinity); } catch (e) { threwInf = e instanceof FidelityError; }
    ok(threwNaN, 'NaN throws FidelityError');
    ok(threwInf, 'Infinity throws FidelityError');
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) for (const f of failures) console.log(`     • ${f}`);
  console.log('════════════════════════════════════════════════');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('❌ harness crashed:', e); process.exit(1); });
