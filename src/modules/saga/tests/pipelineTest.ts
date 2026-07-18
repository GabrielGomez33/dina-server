// File: src/modules/saga/tests/pipelineTest.ts
// ============================================================================
// DINA SAGA — PIPELINE PLANNER PROOF HARNESS
// ============================================================================
// Proves recommend + override + readiness: the jutsu shot recommends the detailer
// (the stage the first render silently skipped); overrides flip stages; a missing
// node/model BLOCKS its stage and surfaces it instead of silently skipping; the
// audited box baseline runs the full pipeline ready.
//   run:  npx ts-node src/modules/saga/tests/pipelineTest.ts
// ============================================================================

import {
  PipelineContext, ReadinessSnapshot, StageId, PipelineError,
  planPipeline, STAGES, CURRENT_BOX_READINESS,
} from '../core/pipeline';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(c: boolean, name: string): void { if (c) passed++; else { failed++; failures.push(name); console.error(`  ❌ ${name}`); } }
function eq(a: unknown, e: unknown, name: string): void { ok(a === e, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`); }
function throws(fn: () => void, name: string): void {
  try { fn(); ok(false, `${name} (expected throw)`); } catch (e) { ok(e instanceof PipelineError, `${name} threw PipelineError`); }
}
async function section(t: string, fn: () => void): Promise<void> { console.log(`\n▶ ${t}`); fn(); }

function ctx(over: Partial<PipelineContext> = {}): PipelineContext {
  return { generationFps: 16, targetFps: 24, isPreview: false, ...over };
}
function stage(plan: ReturnType<typeof planPipeline>, id: StageId) { return plan.stages.find((s) => s.id === id)!; }

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA SAGA — PIPELINE PLANNER PROOFS');
  console.log('════════════════════════════════════════════════');

  await section('1. the jutsu shot: hands in frame → detailer RECOMMENDED (the skipped stage)', () => {
    const plan = planPipeline(ctx({ handsInFrame: true, facesInFrame: true, generateMode: 'flf' }));
    const detail = stage(plan, 'detail');
    eq(detail.recommended, true, 'detail recommended when hands+faces in frame');
    eq(detail.enabled, true, 'detail enabled (model present on the box)');
    eq(detail.source, 'recommended', 'came from recommendation, not override');
    ok(detail.reason.includes('hands'), 'reason cites hands — the exact gap the jutsu render had');
    eq(plan.mode, 'flf', 'generate mode carried through');
    eq(plan.ready, true, 'whole pipeline ready on the audited box');
  });

  await section('2. canonical order + which stages run for a FINAL jutsu clip', () => {
    const plan = planPipeline(ctx({ handsInFrame: true, generationFps: 16, targetFps: 24, isPreview: false }));
    // generate, detail (hands), interpolate (16<24), upscale (final) → filters off (none selected)
    eq(plan.order.join(','), 'generate,detail,interpolate,upscale', 'final clip runs gen+detail+interpolate+upscale in order');
    ok(stage(plan, 'filters').enabled === false, 'filters off (none selected)');
  });

  await section('3. PREVIEW gates upscale off (never upscale a draft)', () => {
    const plan = planPipeline(ctx({ handsInFrame: true, isPreview: true }));
    eq(stage(plan, 'upscale').recommended, false, 'upscale NOT recommended on a preview');
    eq(stage(plan, 'upscale').enabled, false, 'upscale off on a preview');
    ok(stage(plan, 'upscale').reason.includes('preview'), 'reason explains the preview gate');
  });

  await section('4. interpolate keys off the fps gap', () => {
    ok(stage(planPipeline(ctx({ generationFps: 16, targetFps: 24 })), 'interpolate').recommended, 'gen<target → interpolate on');
    ok(!stage(planPipeline(ctx({ generationFps: 24, targetFps: 24 })), 'interpolate').recommended, 'gen==target → interpolate off');
  });

  await section('5. overrides flip recommendations (run what you want)', () => {
    // force detail OFF despite hands
    const off = planPipeline(ctx({ handsInFrame: true }), { detail: false });
    eq(stage(off, 'detail').requested, false, 'override forces detail off');
    eq(stage(off, 'detail').source, 'override', 'source marked override');
    eq(stage(off, 'detail').enabled, false, 'detail does not run');
    // force upscale ON for a preview → allowed, but warned
    const on = planPipeline(ctx({ isPreview: true }), { upscale: true });
    eq(stage(on, 'upscale').enabled, true, 'override forces upscale on');
    ok(on.warnings.some((w) => w.includes('PREVIEW')), 'forcing upscale on a preview warns');
  });

  await section('6. mandatory generate cannot be disabled; unknown stage rejected', () => {
    throws(() => planPipeline(ctx(), { generate: false }), 'disabling generate rejected');
    throws(() => planPipeline(ctx(), { sharpen: true } as any), 'unknown override stage rejected');
    throws(() => planPipeline(ctx({ generationFps: 0 })), 'non-positive generationFps rejected');
  });

  await section('7. READINESS — a missing model BLOCKS its stage (no silent skip)', () => {
    // snapshot with the hand/face detector model removed
    const noDetector: ReadinessSnapshot = {
      nodes: CURRENT_BOX_READINESS.nodes,
      models: CURRENT_BOX_READINESS.models.filter((m) => !m.includes('yolov8')),
    };
    const plan = planPipeline(ctx({ handsInFrame: true }), {}, noDetector);
    const detail = stage(plan, 'detail');
    eq(detail.recommended, true, 'still recommended (content wants it)');
    eq(detail.enabled, false, 'but NOT enabled — model missing');
    eq(detail.blocked, true, 'flagged blocked');
    ok(detail.missing.some((x) => x.kind === 'model' && x.purpose!.includes('detector')), 'the missing detector model is named');
    eq(plan.ready, false, 'whole plan not ready when a requested stage is blocked');
    ok(plan.missing.length > 0, 'plan.missing aggregates the install gap');
    ok(plan.warnings.some((w) => w.includes('detail') && w.includes('not runnable')), 'blocked stage surfaced as a warning');
  });

  await section('8. READINESS — FLF mode requires the FLF node specifically', () => {
    const noFlf: ReadinessSnapshot = {
      nodes: CURRENT_BOX_READINESS.nodes.filter((n) => n !== 'WanFirstLastFrameToVideo'),
      models: CURRENT_BOX_READINESS.models,
    };
    // i2v mode is fine without the FLF node...
    eq(stage(planPipeline(ctx({ generateMode: 'i2v' }), {}, noFlf), 'generate').ready, true, 'i2v generate ready without the FLF node');
    // ...but flf mode blocks
    const flf = stage(planPipeline(ctx({ generateMode: 'flf' }), {}, noFlf), 'generate');
    eq(flf.ready, false, 'flf generate blocked without WanFirstLastFrameToVideo');
    ok(flf.missing.some((x) => x.what === 'WanFirstLastFrameToVideo'), 'the FLF node is named as missing');
  });

  await section('9. the audited box baseline runs a full final clip, ready', () => {
    const plan = planPipeline(ctx({ handsInFrame: true, facesInFrame: true, generateMode: 'flf', filters: ['vintage'] }));
    eq(plan.ready, true, 'everything ready on the real box');
    eq(plan.order.join(','), 'generate,detail,interpolate,upscale,filters', 'all five stages run when all are warranted');
    eq(plan.missing.length, 0, 'nothing missing');
  });

  await section('10. catalog integrity', () => {
    const ids = STAGES.map((s) => s.id);
    eq(new Set(ids).size, ids.length, 'stage ids are unique');
    const orders = STAGES.map((s) => s.order);
    eq(new Set(orders).size, orders.length, 'stage orders are unique');
    ok(STAGES.find((s) => s.id === 'generate')!.optional === false, 'generate is mandatory');
    ok(STAGES.filter((s) => s.id !== 'generate').every((s) => s.optional), 'every non-generate stage is optional');
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) for (const f of failures) console.log(`     • ${f}`);
  console.log('════════════════════════════════════════════════');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('❌ harness crashed:', e); process.exit(1); });
