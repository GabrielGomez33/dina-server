// File: src/modules/saga/tests/keyframeChoreographyTest.ts
// ============================================================================
// DINA SAGA — KEYFRAME CHOREOGRAPHY PROOF HARNESS
// ============================================================================
// Proves the FLF-path planner: every invariant rejects its exact bad state, the
// render plan is ordered/materialized correctly, the Wan-window cap is enforced,
// and the FLF template binds with BOTH start and end frames wired.
//   run:  npx ts-node src/modules/saga/tests/keyframeChoreographyTest.ts
// ============================================================================

import {
  Choreography, Keyframe, ChoreographyError,
  validateChoreography, resolveChoreographyPlan, FlfStep, HoldStep,
} from '../core/keyframeChoreography';
import { getTemplate, bindWorkflow } from '../systems/workflowTemplates';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(c: boolean, name: string): void { if (c) passed++; else { failed++; failures.push(name); console.error(`  ❌ ${name}`); } }
function eq(a: unknown, e: unknown, name: string): void { ok(a === e, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`); }
function throws(fn: () => void, name: string): void {
  try { fn(); ok(false, `${name} (expected throw)`); } catch (e) { ok(e instanceof ChoreographyError, `${name} threw ChoreographyError`); }
}
function nothrow(fn: () => void, name: string): void {
  try { fn(); ok(true, name); } catch (e) { ok(false, `${name} (threw: ${(e as Error).message})`); }
}
async function section(t: string, fn: () => void): Promise<void> { console.log(`\n▶ ${t}`); fn(); }

function kf(id: string, extra: Partial<Keyframe> = {}): Keyframe {
  return { id, imageSourceId: `still-${id}`, ...extra };
}
function choreo(keyframes: Keyframe[], over: Partial<Choreography> = {}): Choreography {
  return { id: 'jutsu', fps: 16, width: 1280, height: 704, keyframes, ...over };
}

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA SAGA — KEYFRAME CHOREOGRAPHY (FLF) PROOFS');
  console.log('════════════════════════════════════════════════');

  await section('1. the jutsu shot the user described validates & plans clean', () => {
    // seals → prayer → hands apart with a contained sphere
    const c = choreo([
      kf('tiger', { label: 'seal:tiger', holdS: 0.5 }),
      kf('serpent', { label: 'seal:serpent', flfDurationS: 1 }),
      kf('ram', { label: 'seal:ram', flfDurationS: 1 }),
      kf('prayer', { label: 'prayer', flfDurationS: 1.5, motionPrompt: 'hands come together' }),
      kf('sphere', { label: 'sphere', flfDurationS: 2, motionPrompt: 'hands draw apart, contained energy sphere expands between the palms', holdS: 1 }),
    ]);
    let w: string[] = [];
    nothrow(() => { w = validateChoreography(c); }, 'the described jutsu validates');
    eq(w.length, 0, 'no warnings on a well-formed choreography');
    const plan = resolveChoreographyPlan(c);
    eq(plan.flfCount, 4, '5 keyframes → 4 FLF transitions');
    // steps in timeline order: hold(tiger) flf flf flf flf hold(sphere)
    eq(plan.steps.map((s) => s.kind).join(','), 'hold,flf,flf,flf,flf,hold', 'step order: intro hold, 4 flf, outro hold');
    const first = plan.steps[1] as FlfStep;
    eq(first.fromKeyframeId, 'tiger', 'first flf goes from tiger');
    eq(first.toKeyframeId, 'serpent', 'first flf goes to serpent');
    eq(first.firstImageSourceId, 'still-tiger', 'flf start image is the from-keyframe still');
    eq(first.lastImageSourceId, 'still-serpent', 'flf end image is the to-keyframe still');
    eq(first.frameCount, 16, '1s @ 16fps = 16 frames');
  });

  await section('2. defaults materialize (flfDurationS → 2s)', () => {
    const plan = resolveChoreographyPlan(choreo([kf('a'), kf('b')])); // b has no flfDurationS
    const flf = plan.steps.find((s) => s.kind === 'flf') as FlfStep;
    eq(flf.durationS, 2, 'omitted flfDurationS defaults to 2s');
    eq(flf.frameCount, 32, '2s @ 16fps = 32 frames');
  });

  await section('3. structural guards', () => {
    throws(() => validateChoreography(choreo([kf('a')])), 'fewer than 2 keyframes rejected');
    throws(() => validateChoreography(choreo([kf('a'), kf('b')], { id: '' })), 'missing id rejected');
    throws(() => validateChoreography(choreo([kf('a'), kf('b')], { fps: 4 })), 'fps below floor rejected');
    throws(() => validateChoreography(choreo([kf('a'), kf('b')], { fps: 61 })), 'fps above ceiling rejected');
    throws(() => validateChoreography(choreo([kf('a'), kf('b')], { width: 100 })), 'width below Wan window rejected');
    throws(() => validateChoreography(choreo([kf('a'), kf('b')], { width: 2000 })), 'width above Wan window rejected');
  });

  await section('4. keyframe guards', () => {
    throws(() => validateChoreography(choreo([kf(''), kf('b')])), 'missing keyframe id rejected');
    throws(() => validateChoreography(choreo([kf('dup'), kf('dup')])), 'duplicate keyframe id rejected');
    throws(() => validateChoreography(choreo([{ id: 'a', imageSourceId: '' }, kf('b')])), 'missing imageSourceId rejected (a keyframe must be a pinned still)');
    throws(() => validateChoreography(choreo([kf('a'), kf('b', { holdS: -1 })])), 'negative hold rejected');
    throws(() => validateChoreography(choreo([kf('a'), kf('b', { holdS: 999 })])), 'absurd hold rejected (sanity cap)');
    throws(() => validateChoreography(choreo([kf('a'), kf('b', { seed: -5 })])), 'negative seed rejected');
  });

  await section('5. transition frame bounds (the Wan window cap — the discovered limit)', () => {
    // 6s @ 16fps = 96 frames > 81 → must split
    throws(() => validateChoreography(choreo([kf('a'), kf('b', { flfDurationS: 6 })])), 'transition beyond Wan 81-frame window rejected');
    // exactly at the window edge is allowed: 5s @ 16fps = 80 frames
    nothrow(() => validateChoreography(choreo([kf('a'), kf('b', { flfDurationS: 5 })])), 'transition at the window edge allowed');
    // too short to read as motion: 0.25s @ 16fps = 4 frames < 8
    throws(() => validateChoreography(choreo([kf('a'), kf('b', { flfDurationS: 0.25 })])), 'transition below the minimum frame count rejected');
    // zero/negative duration
    throws(() => validateChoreography(choreo([kf('a'), kf('b', { flfDurationS: 0 })])), 'zero-duration transition rejected');
    // the SAME 6s beat becomes legal once split with an intermediate keyframe (3s + 3s)
    nothrow(() => validateChoreography(choreo([kf('a'), kf('mid', { flfDurationS: 3 }), kf('b', { flfDurationS: 3 })])), 'splitting a too-long beat across a keyframe fixes it');
  });

  await section('6. motion fields on the FIRST keyframe warn (inert), not throw', () => {
    const w = validateChoreography(choreo([kf('a', { flfDurationS: 2, motionPrompt: 'zoom' }), kf('b')]));
    ok(w.some((x) => x.includes('first keyframe')), 'motion fields on keyframe 0 warn');
  });

  await section('7. plan totals + hold steps', () => {
    // a:hold 1s(16f) → flf a→b 2s(32f) → b:hold 0.5s(8f)
    const c = choreo([kf('a', { holdS: 1 }), kf('b', { flfDurationS: 2, holdS: 0.5 })]);
    const plan = resolveChoreographyPlan(c);
    eq(plan.totalFrames, 16 + 32 + 8, 'total frames = holds + transitions');
    eq(plan.totalDurationS, (16 + 32 + 8) / 16, 'total duration = frames / fps');
    const holds = plan.steps.filter((s): s is HoldStep => s.kind === 'hold');
    eq(holds.length, 2, 'both holds emitted');
    eq(holds[0].keyframeId, 'a', 'intro hold is on keyframe a');
    eq(holds[0].imageSourceId, 'still-a', 'hold freezes the keyframe still');
    // a hold that rounds to 0 frames is rejected
    throws(() => validateChoreography(choreo([kf('a', { holdS: 0.01 }), kf('b')])), 'sub-frame hold rejected');
  });

  await section('8. the FLF template binds with BOTH frames wired (structural proof)', () => {
    const tpl = getTemplate('video-flf-wan-a14b@1');
    ok(!!tpl, 'FLF template is registered');
    const graph = bindWorkflow(tpl!, {
      highNoiseUnet: 'wan-hi.gguf', lowNoiseUnet: 'wan-lo.gguf',
      highLora: 'lx-hi.safetensors', lowLora: 'lx-lo.safetensors',
      textEncoder: 'umt5.safetensors', vae: 'wan21.vae', clipVision: 'clip-vit-h.safetensors',
      referenceImage: 'kf_from.png', endImage: 'kf_to.png',
      length: 33, fps: 16, seed: 7,
    });
    // both LoadImage nodes carry their distinct frames
    eq(graph['10'].inputs.image, 'kf_from.png', 'start frame wired to node 10');
    eq(graph['19'].inputs.image, 'kf_to.png', 'end frame wired to node 19');
    // the motion node takes start_image AND end_image (the whole point of FLF)
    eq(graph['14'].class_type, 'WanFirstLastFrameToVideo', 'motion node is the FLF node');
    ok(Array.isArray(graph['14'].inputs.start_image), 'start_image socket present');
    ok(Array.isArray(graph['14'].inputs.end_image), 'end_image socket present');
    eq(graph['14'].inputs.length, 33, 'frame count bound into the graph');
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) for (const f of failures) console.log(`     • ${f}`);
  console.log('════════════════════════════════════════════════');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('❌ harness crashed:', e); process.exit(1); });
