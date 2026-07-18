// File: src/modules/saga/tests/loraDatasetTest.ts
// ============================================================================
// DINA SAGA — LoRA DATASET BUILDER PROOF HARNESS
// ============================================================================
//   run:  npx ts-node src/modules/saga/tests/loraDatasetTest.ts
// ============================================================================

import { resolveLoraPlan, LoraTrainingPlan, LoraTrainingError } from '../core/loraTraining';
import { buildDatasetPlan, DatasetImage } from '../core/loraDataset';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(c: boolean, name: string): void { if (c) passed++; else { failed++; failures.push(name); console.error(`  ❌ ${name}`); } }
function eq(a: unknown, e: unknown, name: string): void { ok(a === e, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`); }
function throws(fn: () => void, name: string): void {
  try { fn(); ok(false, `${name} (expected throw)`); } catch (e) { ok(e instanceof LoraTrainingError, `${name} threw`); }
}
async function section(t: string, fn: () => void): Promise<void> { console.log(`\n▶ ${t}`); fn(); }

function exodiaPlan(imageCount = 20): LoraTrainingPlan {
  return resolveLoraPlan({ name: 'Exodia', kind: 'character', baseModelId: 'animagine-xl-4', imageCount, triggerWord: 'exodia_saga' });
}
function imgs(n: number, cap?: string): DatasetImage[] {
  return Array.from({ length: n }, (_, i) => ({ filename: `exodia_${String(i).padStart(3, '0')}.png`, caption: cap }));
}

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA SAGA — LoRA DATASET PROOFS');
  console.log('════════════════════════════════════════════════');

  await section('1. a healthy Exodia dataset builds the kohya layout', () => {
    const plan = exodiaPlan(20);
    const ds = buildDatasetPlan({ plan, images: imgs(20) });
    eq(ds.trigger, 'exodia_saga', 'trigger carried from the plan');
    eq(ds.folderName, `${ds.repeats}_exodia_saga`, 'kohya folder is "<repeats>_<trigger>"');
    eq(ds.imageCount, 20, 'image count');
    eq(ds.items.length, 20, 'one item per image');
    eq(ds.items[0].captionFile, 'exodia_000.txt', 'caption file is the image stem + .txt');
    eq(ds.items[0].caption, 'exodia_saga', 'caption is the trigger when no tags given');
    ok(ds.totalSteps > 0 && ds.epochs >= 1, 'step math produced positive steps + epochs');
  });

  await section('2. step math tracks the plan target', () => {
    const plan = exodiaPlan(20); // character default steps = 1800
    const ds = buildDatasetPlan({ plan, images: imgs(20), repeats: 10, batchSize: 1 });
    eq(ds.stepsPerEpoch, 200, '20 imgs × 10 repeats / batch 1 = 200 steps/epoch');
    eq(ds.epochs, 9, 'epochs = round(1800 / 200) = 9');
    eq(ds.totalSteps, 1800, 'effective total steps hits the target');
  });

  await section('3. captions: trigger prepended, tags appended', () => {
    const plan = exodiaPlan(15);
    const ds = buildDatasetPlan({ plan, images: [{ filename: 'a.png', caption: 'full body, fighting stance' }, ...imgs(14)] });
    eq(ds.items[0].caption, 'exodia_saga, full body, fighting stance', 'trigger + tags');
    // whitespace/newlines in a caption are normalized
    const ds2 = buildDatasetPlan({ plan, images: [{ filename: 'b.png', caption: '  close-up\n\tportrait ' }, ...imgs(14)] });
    eq(ds2.items[0].caption, 'exodia_saga, close-up portrait', 'caption whitespace normalized');
  });

  await section('4. hard rejects', () => {
    const plan = exodiaPlan(15);
    throws(() => buildDatasetPlan({ plan, images: [] }), 'empty dataset rejected');
    throws(() => buildDatasetPlan({ plan, images: [{ filename: 'notes.txt' }, ...imgs(14)] }), 'non-image file rejected');
    throws(() => buildDatasetPlan({ plan, images: [{ filename: 'a.png' }, { filename: 'a.png' }, ...imgs(13)] }), 'duplicate stem rejected');
    throws(() => buildDatasetPlan({ plan, images: [{ filename: '../etc/x.png' }, ...imgs(14)] }), 'path traversal rejected');
    throws(() => buildDatasetPlan({ plan, images: [{ filename: '/abs/x.png' }, ...imgs(14)] }), 'absolute path rejected');
    throws(() => buildDatasetPlan({ plan, images: [{ filename: 'a.png', caption: 'x'.repeat(2000) }, ...imgs(14)] }), 'overlong caption rejected');
    throws(() => buildDatasetPlan({ plan, images: imgs(400) }), 'too many images rejected');
  });

  await section('5. same stem via different extensions collides (caption files would clash)', () => {
    const plan = exodiaPlan(15);
    throws(() => buildDatasetPlan({ plan, images: [{ filename: 'a.png' }, { filename: 'a.jpg' }, ...imgs(13)] }), 'a.png + a.jpg share stem "a" → rejected');
  });

  await section('6. quality warnings (the overfit/undertrain traps)', () => {
    // few images → variety warning
    const few = buildDatasetPlan({ plan: exodiaPlan(8), images: imgs(8) });
    ok(few.warnings.some((w) => w.includes('variety')), 'few images warns about variety/overfit');
    // high steps-to-images ratio → overfit warning (views ≈ steps/images,
    // independent of repeats since epochs auto-adjust to the target).
    const hi = resolveLoraPlan({ name: 'Exodia', kind: 'character', baseModelId: 'animagine-xl-4', imageCount: 15, triggerWord: 'exodia_saga', steps: 6000 });
    const over = buildDatasetPlan({ plan: hi, images: imgs(15), repeats: 10 });
    ok(over.warnings.some((w) => w.includes('overfit')), 'excessive views (6000 steps / 15 imgs ≈ 400×) warns overfit');
    // mismatch between declared plan count and actual images is surfaced
    const mism = buildDatasetPlan({ plan: exodiaPlan(20), images: imgs(15) });
    ok(mism.warnings.some((w) => w.includes('declared')), 'declared-vs-actual image count mismatch surfaced');
  });

  await section('7. repeats/batch clamped to safe bounds', () => {
    const plan = exodiaPlan(20);
    const ds = buildDatasetPlan({ plan, images: imgs(20), repeats: 9999, batchSize: 99 });
    ok(ds.repeats <= 100, 'repeats clamped');
    ok(ds.batchSize <= 8, 'batch clamped');
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) for (const f of failures) console.log(`     • ${f}`);
  console.log('════════════════════════════════════════════════');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('❌ harness crashed:', e); process.exit(1); });
