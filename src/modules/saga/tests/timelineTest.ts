// File: src/modules/saga/tests/timelineTest.ts
// ============================================================================
// DINA SAGA — TIMELINE / SEQUENCE MODEL PROOF HARNESS
// ============================================================================
// Proves every invariant of timeline.ts by constructing the EXACT malformed
// state each guard is meant to reject, and asserting it throws — plus the
// non-fatal warnings, plus the resolveExportPlan ordering/default-materialization
// and sequenceDuration math. If a guard regresses, this harness goes red.
//   run:  npx ts-node src/modules/saga/tests/timelineTest.ts
// ============================================================================

import {
  Sequence, Track, Clip, TrackKind,
  TimelineError, validateSequence, sequenceDuration, resolveExportPlan,
  clipDuration, clipEnd, isVideoKind, isAudioKind,
} from '../core/timeline';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(c: boolean, name: string): void { if (c) passed++; else { failed++; failures.push(name); console.error(`  ❌ ${name}`); } }
function eq(a: unknown, e: unknown, name: string): void { ok(a === e, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`); }
function throws(fn: () => void, name: string): void {
  try { fn(); ok(false, `${name} (expected throw)`); } catch (e) { ok(e instanceof TimelineError, `${name} threw TimelineError`); }
}
function nothrow(fn: () => void, name: string): void {
  try { fn(); ok(true, name); } catch (e) { ok(false, `${name} (threw: ${(e as Error).message})`); }
}
async function section(t: string, fn: () => void): Promise<void> { console.log(`\n▶ ${t}`); fn(); }

// ---- builders ---------------------------------------------------------------
function vclip(id: string, start: number, dur: number, extra: Partial<Clip> = {}): Clip {
  return { id, sourceId: `gen-${id}`, sourceDurationS: dur, start, in: 0, out: dur, ...extra };
}
function aclip(id: string, start: number, dur: number, extra: Partial<Clip> = {}): Clip {
  return { id, sourceId: `aud-${id}`, sourceDurationS: dur, start, in: 0, out: dur, ...extra };
}
function track(id: string, kind: TrackKind, clips: Clip[]): Track { return { id, kind, clips }; }
function seq(tracks: Track[], over: Partial<Sequence> = {}): Sequence {
  return { id: 'seq1', name: 'Test', fps: 24, width: 1280, height: 720, tracks, ...over };
}

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA SAGA — TIMELINE PROOFS');
  console.log('════════════════════════════════════════════════');

  await section('1. clip math helpers', () => {
    const c = vclip('c', 5, 10, { in: 2, out: 9 });
    eq(clipDuration(c), 7, 'duration = out - in');
    eq(clipEnd(c), 12, 'end = start + duration');
    eq(isVideoKind('video'), true, 'video is a video kind');
    eq(isAudioKind('music'), true, 'music is an audio kind');
    eq(isAudioKind('video'), false, 'video is not an audio kind');
    eq(isVideoKind('sfx'), false, 'sfx is not a video kind');
  });

  await section('2. a valid multi-track sequence passes clean (no warnings)', () => {
    const s = seq([
      track('v1', 'video', [vclip('a', 0, 5), vclip('b', 5, 5)]),
      track('m1', 'music', [aclip('m', 0, 10, { gain: 0.8 })]),
    ]);
    let w: string[] = [];
    nothrow(() => { w = validateSequence(s); }, 'clean sequence validates');
    eq(w.length, 0, 'no warnings on a clean sequence');
  });

  await section('3. sequence-level guards', () => {
    throws(() => validateSequence(seq([], { id: '' })), 'missing sequence id rejected');
    throws(() => validateSequence(seq([], { name: '' })), 'missing sequence name rejected');
    throws(() => validateSequence(seq([], { fps: 7 })), 'fps below floor rejected');
    throws(() => validateSequence(seq([], { fps: 61 })), 'fps above ceiling rejected');
    throws(() => validateSequence(seq([], { fps: NaN })), 'non-finite fps rejected');
    throws(() => validateSequence(seq([], { width: 32 })), 'width below floor rejected');
    throws(() => validateSequence(seq([], { height: 9000 })), 'height above ceiling rejected');
  });

  await section('4. clip field guards (finite / ranges / trim)', () => {
    throws(() => validateSequence(seq([track('v', 'video', [vclip('', 0, 5)])])), 'empty clip id rejected');
    throws(() => validateSequence(seq([track('v', 'video', [{ ...vclip('a', 0, 5), sourceId: '' }])])), 'missing sourceId rejected');
    throws(() => validateSequence(seq([track('v', 'video', [{ ...vclip('a', 0, 5), start: -1 }])])), 'negative start rejected');
    throws(() => validateSequence(seq([track('v', 'video', [{ ...vclip('a', 0, 5), in: -1 }])])), 'negative in rejected');
    throws(() => validateSequence(seq([track('v', 'video', [{ ...vclip('a', 0, 5), in: 5, out: 5 }])])), 'zero-duration (out==in) rejected');
    throws(() => validateSequence(seq([track('v', 'video', [{ ...vclip('a', 0, 5), in: 6, out: 4 }])])), 'negative duration (out<in) rejected');
    throws(() => validateSequence(seq([track('v', 'video', [{ ...vclip('a', 0, 5), sourceDurationS: 4, out: 5 }])])), 'trim past source length rejected');
    throws(() => validateSequence(seq([track('v', 'video', [{ ...vclip('a', 0, 5), out: NaN }])])), 'non-finite out rejected');
    nothrow(() => validateSequence(seq([track('v', 'video', [{ ...vclip('a', 0, 5), sourceDurationS: 5, in: 1, out: 5 }])])), 'trim exactly to source length allowed (EPS)');
  });

  await section('5. track-kind field enforcement (no smuggling wrong fields)', () => {
    // audio clip must NOT carry video-only fields
    throws(() => validateSequence(seq([track('m', 'music', [aclip('a', 0, 5, { cinematography: { framing: 'closeup' } })])])), 'cinematography on audio clip rejected');
    throws(() => validateSequence(seq([track('m', 'music', [aclip('a', 0, 5, { transition: { kind: 'fade', durationS: 1 } })])])), 'transition on audio clip rejected');
    throws(() => validateSequence(seq([track('m', 'music', [aclip('a', 0, 5, { syncMode: 'free' })])])), 'syncMode on audio clip rejected');
    // video clip must NOT carry audio-only fields
    throws(() => validateSequence(seq([track('v', 'video', [vclip('a', 0, 5, { gain: 1 })])])), 'gain on video clip rejected');
    // gain range on audio
    throws(() => validateSequence(seq([track('m', 'music', [aclip('a', 0, 5, { gain: -0.1 })])])), 'negative gain rejected');
    throws(() => validateSequence(seq([track('m', 'music', [aclip('a', 0, 5, { gain: 5 })])])), 'gain above max rejected');
    nothrow(() => validateSequence(seq([track('m', 'music', [aclip('a', 0, 5, { gain: 4 })])])), 'gain at max allowed');
  });

  await section('6. transition bounds', () => {
    // transition longer than its own clip
    throws(() => validateSequence(seq([track('v', 'video', [
      vclip('a', 0, 5), vclip('b', 5, 2, { transition: { kind: 'dissolve', durationS: 3 } }),
    ])])), 'transition longer than its clip rejected');
    // transition longer than the previous clip
    throws(() => validateSequence(seq([track('v', 'video', [
      vclip('a', 0, 1), vclip('b', 1, 5, { transition: { kind: 'dissolve', durationS: 3 } }),
    ])])), 'transition longer than previous clip rejected');
    // negative transition duration
    throws(() => validateSequence(seq([track('v', 'video', [
      vclip('a', 0, 5), vclip('b', 5, 5, { transition: { kind: 'fade', durationS: -1 } }),
    ])])), 'negative transition duration rejected');
    // valid transition within both bounds
    nothrow(() => validateSequence(seq([track('v', 'video', [
      vclip('a', 0, 5), vclip('b', 5, 5, { transition: { kind: 'dissolve', durationS: 2 } }),
    ])])), 'transition within both bounds allowed');
    // transition on the first clip → warning, not a throw
    const w = validateSequence(seq([track('v', 'video', [
      vclip('a', 0, 5, { transition: { kind: 'fade', durationS: 1 } }),
    ])]));
    ok(w.some((x) => x.includes('first clip')), 'transition on first clip warns (ignored)');
  });

  await section('7. duplicate ids rejected', () => {
    throws(() => validateSequence(seq([track('v', 'video', [vclip('dup', 0, 5), vclip('dup', 5, 5)])])), 'duplicate clip id rejected');
    throws(() => validateSequence(seq([track('t', 'video', [vclip('a', 0, 5)]), track('t', 'music', [aclip('b', 0, 5)])])), 'duplicate track id rejected');
    // duplicate clip id ACROSS tracks also caught (ids are sequence-global)
    throws(() => validateSequence(seq([track('v', 'video', [vclip('x', 0, 5)]), track('m', 'music', [aclip('x', 0, 5)])])), 'duplicate clip id across tracks rejected');
  });

  await section('8. overlap within a track is a HARD error; gap is a warning', () => {
    // b starts before a ends → overlap
    throws(() => validateSequence(seq([track('v', 'video', [vclip('a', 0, 5), vclip('b', 4, 5)])])), 'overlapping clips rejected');
    // exact touch (b starts where a ends) is fine
    nothrow(() => validateSequence(seq([track('v', 'video', [vclip('a', 0, 5), vclip('b', 5, 5)])])), 'back-to-back clips (touching) allowed');
    // gap on a VIDEO track → warning (dead air)
    const wv = validateSequence(seq([track('v', 'video', [vclip('a', 0, 5), vclip('b', 8, 5)])]));
    ok(wv.some((x) => x.includes('gap')), 'gap on video track warns (dead air)');
    // gap on an AUDIO track → NO warning (silence between cues is normal)
    const wa = validateSequence(seq([track('s', 'sfx', [aclip('a', 0, 2), aclip('b', 10, 2)])]));
    ok(!wa.some((x) => x.includes('gap')), 'gap on audio track does not warn');
    // overlap detection is order-independent (unsorted input)
    throws(() => validateSequence(seq([track('v', 'video', [vclip('b', 4, 5), vclip('a', 0, 5)])])), 'overlap detected regardless of clip array order');
  });

  await section('9. sequence-level warnings (beat-sync, empty, unknown kind)', () => {
    // beat-synced video but no music track → warn
    const wb = validateSequence(seq([track('v', 'video', [vclip('a', 0, 5, { syncMode: 'beat-synced' })])]));
    ok(wb.some((x) => x.includes('beat-synced')), 'beat-sync without music warns');
    // beat-synced WITH a music track that has clips → no warn
    const wok = validateSequence(seq([
      track('v', 'video', [vclip('a', 0, 5, { syncMode: 'beat-synced' })]),
      track('m', 'music', [aclip('m', 0, 5)]),
    ]));
    ok(!wok.some((x) => x.includes('beat-synced')), 'beat-sync with music does not warn');
    // empty sequence → warn
    const we = validateSequence(seq([]));
    ok(we.some((x) => x.includes('no clips')), 'empty sequence warns');
    // unknown track kind rejected
    throws(() => validateSequence(seq([{ id: 't', kind: 'foley' as TrackKind, clips: [] }])), 'unknown track kind rejected');
  });

  await section('10. sequenceDuration = latest clip end across all tracks', () => {
    const s = seq([
      track('v', 'video', [vclip('a', 0, 5), vclip('b', 5, 5)]), // ends at 10
      track('m', 'music', [aclip('m', 0, 12)]),                   // ends at 12
    ]);
    eq(sequenceDuration(s), 12, 'duration is the max clip end (audio outlasts video)');
    eq(sequenceDuration(seq([])), 0, 'empty sequence has 0 duration');
    // trimmed clip: start 3, in 1 out 4 → duration 3 → ends at 6
    eq(sequenceDuration(seq([track('v', 'video', [{ ...vclip('a', 3, 10), in: 1, out: 4 }])])), 6, 'trimmed clip end uses out-in, not source length');
  });

  await section('11. resolveExportPlan — validates, orders, materializes defaults', () => {
    const s = seq([
      track('v1', 'video', [
        vclip('a', 0, 5, { syncMode: 'beat-synced', cinematography: { framing: 'wide' } }),
        vclip('b', 5, 5), // syncMode omitted → must default to 'free'
      ]),
      track('m1', 'music', [aclip('m', 0, 10)]),          // gain omitted → default 1
      track('s1', 'sfx', [aclip('s', 2, 1, { gain: 2 })]),
      track('empty', 'ambience', []),                      // no clips → excluded from plan.audio
    ]);
    const plan = resolveExportPlan(s);

    eq(plan.sequenceId, 'seq1', 'plan carries sequence id');
    eq(plan.fps, 24, 'plan carries fps');
    eq(plan.durationS, 10, 'plan duration computed');
    eq(plan.video.length, 2, 'both video steps present');
    eq(plan.video[0].clipId, 'a', 'video ordered by start (a first)');
    eq(plan.video[1].clipId, 'b', 'video ordered by start (b second)');
    eq(plan.video[0].syncMode, 'beat-synced', 'explicit syncMode preserved');
    eq(plan.video[1].syncMode, 'free', 'omitted syncMode materialized to free');
    ok(!!plan.video[0].cinematography, 'cinematography carried into the step');
    eq(plan.video[0].durationS, 5, 'step duration resolved');

    // audio: only the two tracks WITH clips appear
    eq(plan.audio.length, 2, 'empty audio track excluded from plan');
    const music = plan.audio.find((t) => t.kind === 'music')!;
    const sfx = plan.audio.find((t) => t.kind === 'sfx')!;
    eq(music.clips[0].gain, 1, 'omitted gain materialized to 1 (unity)');
    eq(sfx.clips[0].gain, 2, 'explicit gain preserved');
    eq(sfx.clips[0].start, 2, 'audio clip start carried');
  });

  await section('12. resolveExportPlan orders video by (trackIndex, start)', () => {
    // two video tracks; ensure track order then start order
    const s = seq([
      track('vA', 'video', [vclip('a2', 5, 5), vclip('a1', 0, 5)]),
      track('vB', 'video', [vclip('b1', 0, 5)]),
    ]);
    const plan = resolveExportPlan(s);
    eq(plan.video.map((v) => v.clipId).join(','), 'a1,a2,b1', 'video sorted by trackIndex then start');
  });

  await section('13. resolveExportPlan refuses an invalid sequence (validation gate)', () => {
    throws(() => resolveExportPlan(seq([track('v', 'video', [vclip('a', 0, 5), vclip('b', 4, 5)])])), 'export plan rejects overlapping clips');
    // but surfaces warnings on a valid-but-imperfect sequence
    const plan = resolveExportPlan(seq([track('v', 'video', [vclip('a', 0, 5), vclip('b', 8, 5)])]));
    ok(plan.warnings.some((x) => x.includes('gap')), 'export plan surfaces warnings');
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) for (const f of failures) console.log(`     • ${f}`);
  console.log('════════════════════════════════════════════════');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('❌ harness crashed:', e); process.exit(1); });
