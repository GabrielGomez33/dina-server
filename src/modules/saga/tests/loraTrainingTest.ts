// File: src/modules/saga/tests/loraTrainingTest.ts
// ============================================================================
// DINA SAGA — LoRA TRAINING PLAN PROOF HARNESS
// ============================================================================
// Proves the training-request gate: every way a request could waste 20-40 min
// of GPU is rejected up front, valid requests resolve to a sane plan, and output
// names / trigger tokens are sanitized (no path or prompt injection).
//
//   run:  npx ts-node src/modules/saga/tests/loraTrainingTest.ts
// ============================================================================

import { resolveLoraPlan, LoraTrainingError, MAX_TRAINING_IMAGES } from '../core/loraTraining';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(c: boolean, name: string): void { if (c) passed++; else { failed++; failures.push(name); console.error(`  ❌ ${name}`); } }
function eq(a: unknown, e: unknown, name: string): void { ok(a === e, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`); }
function throws(fn: () => void, name: string): void {
  try { fn(); ok(false, `${name} (expected throw)`); } catch (e) { ok(e instanceof LoraTrainingError, `${name} (threw ${(e as Error).name})`); }
}
async function section(t: string, fn: () => void): Promise<void> { console.log(`\n▶ ${t}`); fn(); }

// A valid character request against the real registry's animagine image profile.
const CHAR = { name: 'Exodia FTW', kind: 'character' as const, baseModelId: 'animagine-xl-4', imageCount: 20, triggerWord: 'exodia ftw' };

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA SAGA — LoRA TRAINING PLAN PROOFS');
  console.log('════════════════════════════════════════════════');

  await section('1. valid character plan resolves with kind defaults', () => {
    const p = resolveLoraPlan(CHAR);
    eq(p.networkDim, 24, 'character default rank 24');
    eq(p.steps, 1800, 'character default steps 1800');
    eq(p.networkAlpha, 12, 'alpha = rank/2');
    eq(p.resolution, 1024, 'default resolution 1024 (SDXL)');
    eq(p.baseCheckpoint, 'animagine-xl-4.0.safetensors', 'base checkpoint resolved from the image profile');
    eq(p.warnings.length, 0, '20 images → no warning');
  });

  await section('2. output name + trigger are sanitized (no injection)', () => {
    const p = resolveLoraPlan({ ...CHAR, name: '../../Exodia! v2', triggerWord: 'Exodia FTW!!' });
    eq(p.outputName, 'exodia_v2.safetensors', 'name → safe lowercase filename, path chars stripped');
    eq(p.triggerWord, 'exodia_ftw', 'trigger → safe token');
    ok(!p.outputName.includes('/') && !p.outputName.includes('..'), 'no path traversal survives');
  });

  await section('3. dataset-size gates', () => {
    throws(() => resolveLoraPlan({ ...CHAR, imageCount: 5 }), 'too few images rejected');
    throws(() => resolveLoraPlan({ ...CHAR, imageCount: MAX_TRAINING_IMAGES + 1 }), 'too many images rejected');
    const warn = resolveLoraPlan({ ...CHAR, imageCount: 9 });
    ok(warn.warnings.some((w) => w.includes('recommended')), '9 images → valid but warns');
  });

  await section('4. trigger requirement depends on kind', () => {
    throws(() => resolveLoraPlan({ ...CHAR, triggerWord: '' }), 'character without trigger rejected');
    const style = resolveLoraPlan({ name: 'Ukiyo-e', kind: 'style', baseModelId: 'animagine-xl-4', imageCount: 40 });
    eq(style.triggerWord, 'ukiyo_e', 'style derives a trigger from the name (no explicit one needed)');
    eq(style.networkDim, 16, 'style default rank 16');
  });

  await section('5. base model must be a real IMAGE model', () => {
    throws(() => resolveLoraPlan({ ...CHAR, baseModelId: 'nope' }), 'unknown base rejected');
    throws(() => resolveLoraPlan({ ...CHAR, baseModelId: 'wan2.2-i2v-a14b-lightning' }), 'a VIDEO model as base is rejected');
  });

  await section('6. expert overrides clamp to safe bounds', () => {
    eq(resolveLoraPlan({ ...CHAR, rank: 9999 }).networkDim, 128, 'rank clamps to 128');
    eq(resolveLoraPlan({ ...CHAR, rank: 0 }).networkDim, 4, 'rank clamps up to 4');
    eq(resolveLoraPlan({ ...CHAR, steps: 999999 }).steps, 6000, 'steps clamp to 6000');
    eq(resolveLoraPlan({ ...CHAR, learningRate: 5 }).learningRate, 1e-2, 'LR clamps to max');
    const badRes = resolveLoraPlan({ ...CHAR, resolution: 777 });
    eq(badRes.resolution, 1024, 'unsupported resolution falls back to 1024');
    ok(badRes.warnings.some((w) => w.includes('777')), 'and warns about it');
  });

  await section('7. unknown kind / empty name rejected', () => {
    throws(() => resolveLoraPlan({ ...CHAR, kind: 'hologram' as any }), 'unknown kind rejected');
    throws(() => resolveLoraPlan({ ...CHAR, name: '!!!' }), 'name with no alphanumerics rejected');
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) for (const f of failures) console.log(`     • ${f}`);
  console.log('════════════════════════════════════════════════');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('❌ harness crashed:', e); process.exit(1); });
