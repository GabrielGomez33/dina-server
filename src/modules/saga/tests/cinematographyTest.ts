// File: src/modules/saga/tests/cinematographyTest.ts
// ============================================================================
// DINA SAGA — CINEMATOGRAPHY VOCABULARY PROOF HARNESS
// ============================================================================
//   run:  npx ts-node src/modules/saga/tests/cinematographyTest.ts
// ============================================================================

import {
  composeShotPrompt, composeCameraMotion, composeFilterChain, kindOf,
  CinematographyError, FRAMING, ANGLE, OPTICS, CAMERA, FILTERS,
} from '../core/cinematography';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(c: boolean, name: string): void { if (c) passed++; else { failed++; failures.push(name); console.error(`  ❌ ${name}`); } }
function eq(a: unknown, e: unknown, name: string): void { ok(a === e, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`); }
function throws(fn: () => void, name: string): void {
  try { fn(); ok(false, `${name} (expected throw)`); } catch (e) { ok(e instanceof CinematographyError, `${name} threw`); }
}
async function section(t: string, fn: () => void): Promise<void> { console.log(`\n▶ ${t}`); fn(); }

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA SAGA — CINEMATOGRAPHY PROOFS');
  console.log('════════════════════════════════════════════════');

  await section('1. terms route to the correct MECHANISM (the whole point)', () => {
    eq(kindOf('closeup'), 'prompt', 'framing → prompt');
    eq(kindOf('low-angle'), 'prompt', 'angle → prompt');
    eq(kindOf('bokeh'), 'prompt', 'optics → prompt');
    eq(kindOf('orbit'), 'camera', 'camera move → camera');
    eq(kindOf('negative'), 'post', 'filter → post');
    eq(kindOf('vintage'), 'post', 'vintage → post');
  });

  await section('2. shot prompt composes framing + angle + optics into tags', () => {
    const p = composeShotPrompt({ framing: 'closeup', angle: 'low-angle', optics: ['bokeh', 'rim-light'] });
    ok(p.includes('close-up'), 'framing tags present');
    ok(p.includes('from below'), 'low-angle → "from below"');
    ok(p.includes('bokeh') && p.includes('rim lighting'), 'both optics present');
    ok(!/undefined|,\s*,/.test(p), 'no gaps/undefined');
  });

  await section('3. eye-level contributes nothing; empty direction → empty', () => {
    eq(composeShotPrompt({ angle: 'eye-level' }), '', 'eye-level is neutral (no tags)');
    eq(composeShotPrompt({}), '', 'empty direction → empty prompt');
  });

  await section('4. camera motion → video-prompt fragment', () => {
    ok(composeCameraMotion('orbit').includes('orbits'), 'orbit describes an orbit');
    ok(composeCameraMotion('push-in').includes('dolly in'), 'push-in → dolly in');
    eq(composeCameraMotion(undefined), '', 'no motion → empty');
  });

  await section('5. POST filters → ffmpeg chain (the "another step" part)', () => {
    eq(composeFilterChain(['negative']), 'negate', 'invert → ffmpeg negate (the exact example asked about)');
    eq(composeFilterChain(['grayscale']), 'hue=s=0', 'grayscale filter');
    eq(composeFilterChain(['vintage', 'vignette']), 'curves=preset=vintage,noise=alls=8:allf=t,vignette,vignette', 'multiple filters comma-joined in order');
    eq(composeFilterChain([]), '', 'no filters → empty (caller skips post pass)');
    eq(composeFilterChain(undefined), '', 'undefined → empty');
  });

  await section('6. unknown terms are rejected everywhere', () => {
    throws(() => composeShotPrompt({ framing: 'macro' as any }), 'unknown framing rejected');
    throws(() => composeShotPrompt({ angle: 'sideways' as any }), 'unknown angle rejected');
    throws(() => composeCameraMotion('zoom-blast' as any), 'unknown camera move rejected');
    throws(() => composeFilterChain(['deepfry' as any]), 'unknown filter rejected');
    throws(() => kindOf('nonsense'), 'unknown term in kindOf rejected');
  });

  await section('7. catalog integrity — every entry is complete and correctly typed', () => {
    for (const [name, cat] of [['FRAMING', FRAMING], ['ANGLE', ANGLE], ['OPTICS', OPTICS]] as const) {
      for (const [k, v] of Object.entries(cat)) ok(v.kind === 'prompt' && typeof v.tags === 'string' && !!v.description, `${name}.${k} is a prompt entry`);
    }
    for (const [k, v] of Object.entries(CAMERA)) ok(v.kind === 'camera' && typeof v.tags === 'string', `CAMERA.${k} is a camera entry`);
    for (const [k, v] of Object.entries(FILTERS)) ok(v.kind === 'post' && typeof v.ffmpeg === 'string' && v.ffmpeg.length > 0, `FILTERS.${k} has an ffmpeg fragment`);
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) for (const f of failures) console.log(`     • ${f}`);
  console.log('════════════════════════════════════════════════');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('❌ harness crashed:', e); process.exit(1); });
