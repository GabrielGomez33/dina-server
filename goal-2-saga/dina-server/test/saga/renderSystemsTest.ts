// File: test/saga/renderSystemsTest.ts
// ============================================================================
// DINA SAGA — RENDER-SYSTEMS PROOF HARNESS (phase 2 backend units)
// ============================================================================
// Hermetic proofs for the pure render machinery: workflow binding (injection
// safety), progress mapping (monotonicity), ETA math, and the ComfyUI client
// driven through a fake transport (happy path, execution error, timeout,
// stall, abort). No network, no GPU, no ComfyUI.
//
//   run:  npx ts-node test/saga/renderSystemsTest.ts
// ============================================================================

import { bindWorkflow, TEMPLATE_IMAGE_BASIC, WorkflowBindError } from '../../src/modules/saga/systems/workflowTemplates';
import { ProgressMapper } from '../../src/modules/saga/systems/progressMapper';
import { EtaEstimator, mergeCalibration } from '../../src/modules/saga/core/etaEstimator';
import { ComfyClient, ComfyError, ComfyEvent, ComfyTransport } from '../../src/modules/saga/systems/comfyClient';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(c: boolean, name: string): void { if (c) passed++; else { failed++; failures.push(name); console.error(`  ❌ ${name}`); } }
function eq(a: unknown, e: unknown, name: string): void { ok(a === e, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`); }
async function section(t: string, fn: () => Promise<void> | void): Promise<void> { console.log(`\n▶ ${t}`); await fn(); }

/** Fake ComfyUI transport: scripted WS events, recorded HTTP calls. */
class FakeTransport implements ComfyTransport {
  posts: Array<{ path: string; body: any }> = [];
  script: ComfyEvent[] = [];
  autoplay = true;
  emit: ((e: ComfyEvent) => void) | null = null;
  closed = 0;
  failSubmit = false;

  async post(path: string, body: unknown): Promise<any> {
    this.posts.push({ path, body });
    if (path === '/prompt') {
      if (this.failSubmit) throw new Error('500 invalid workflow');
      return { prompt_id: 'p1' };
    }
    return {};
  }
  async get(path: string): Promise<any> {
    if (path.startsWith('/history/')) return { p1: { outputs: { '7': { images: [{ filename: 'dina_0001.png' }] } } } };
    return {};
  }
  openSocket(_cid: string, onEvent: (e: ComfyEvent) => void): { close(): void } {
    this.emit = onEvent;
    if (this.autoplay) setImmediate(() => this.script.forEach((e) => onEvent(e)));
    return { close: () => { this.closed++; } };
  }
}

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA SAGA — RENDER SYSTEMS PROOFS');
  console.log('════════════════════════════════════════════════');

  await section('1. Workflow binding — injection safety & fail-fast', () => {
    const graph = bindWorkflow(TEMPLATE_IMAGE_BASIC, {
      prompt: 'a rooftop at dusk, anime key visual', checkpoint: 'anime-xl.safetensors', seed: 42, steps: 30,
    });
    eq(graph['5'].inputs.seed, 42, 'numeric input bound as number');
    eq(graph['2'].inputs.text, 'a rooftop at dusk, anime key visual', 'prompt bound as string');
    eq(graph['3'].inputs.text, '', 'optional negative defaults to empty');

    // Injection: prompt containing JSON-breaking characters must stay a string.
    const hostile = bindWorkflow(TEMPLATE_IMAGE_BASIC, {
      prompt: '"},"9":{"class_type":"Evil","inputs":{}}', checkpoint: 'x.safetensors',
    });
    eq(Object.keys(hostile).length, 7, 'JSON-injection in prompt cannot add graph nodes');
    ok(hostile['2'].inputs.text.includes('Evil'), 'hostile text survives as inert string content');

    let threw = 0;
    try { bindWorkflow(TEMPLATE_IMAGE_BASIC, { checkpoint: 'x' }); } catch (e) { if (e instanceof WorkflowBindError) threw++; }
    try { bindWorkflow(TEMPLATE_IMAGE_BASIC, { prompt: 'p', checkpoint: 'x', smuggled: 1 } as any); } catch (e) { if (e instanceof WorkflowBindError) threw++; }
    try { bindWorkflow(TEMPLATE_IMAGE_BASIC, { prompt: 'p', checkpoint: 'x', steps: 99999 }); } catch { threw++; }
    eq(threw, 2, 'missing-required and undeclared-input rejected; out-of-range clamped not thrown');
    eq(bindWorkflow(TEMPLATE_IMAGE_BASIC, { prompt: 'p', checkpoint: 'x', steps: 99999 })['5'].inputs.steps, 150, 'steps clamped to declared max');
  });

  await section('2. Progress mapper — monotonic, weighted, complete=100', () => {
    const m = new ProgressMapper('j1', 'image_gen');
    m.enterPhase('sample');
    m.step(15, 30);
    const a = m.snapshot();
    eq(a.phase, 'Sampling', 'phase label surfaces');
    eq(a.overall_pct, 50, 'weighted overall: 15% load + half of 70% sampling = 50%');
    ok(a.pct === 50, 'phase pct = 50');

    // ComfyUI restarts node progress (second sampler pass) — bar must not rewind.
    m.step(1, 30);
    const b = m.snapshot();
    ok(b.overall_pct >= a.overall_pct, `monotonic under progress reset (${b.overall_pct} >= ${a.overall_pct})`);

    // A stray late 'load' event cannot rewind the phase either.
    m.enterPhase('load');
    const c = m.snapshot();
    eq(c.phase, 'Sampling', 'phase index never moves backwards');

    m.complete();
    eq(m.snapshot().overall_pct, 100, 'complete() drives overall to exactly 100');

    // Degenerate weights normalize instead of exploding.
    const w = new ProgressMapper('j2', 'image_gen', [
      { key: 'a', label: 'A', weight: 0 }, { key: 'b', label: 'B', weight: 0 },
    ]);
    w.enterPhase('b'); w.step(1, 2);
    eq(w.snapshot().overall_pct, 75, 'zero weights fall back to even split (50% + half of 50%)');
  });

  await section('3. ETA estimator — calibration, live blend, junk input', () => {
    const eta = new EtaEstimator({ jobKind: 'image_gen', model: 'm', resolution: '1024', sPerStep: 2, overheadS: 10 });
    eq(eta.etaSeconds(10, 30), 40, 'calibration-only ETA: 20 steps × 2s');
    eq(eta.etaSeconds(10, 30, true), 50, 'overhead included on request');
    eta.observeStep(4); eta.observeStep(4); eta.observeStep(4);
    const blended = eta.etaSeconds(10, 30)!;
    ok(blended > 40 && blended <= 80, `live observations pull ETA toward reality (${blended}s)`);
    eta.observeStep(NaN); eta.observeStep(-5);
    ok(eta.etaSeconds(10, 30)! > 0, 'junk observations ignored');

    const blind = new EtaEstimator(null);
    eq(blind.etaSeconds(5, 30), null, 'no calibration + no observations → null (never invented)');
    blind.observeStep(3);
    eq(blind.etaSeconds(29, 30), 3, 'live-only ETA once observed');

    const merged = mergeCalibration(
      { jobKind: 'image_gen', model: 'm', resolution: '1024', sPerStep: 2, overheadS: 10 },
      { jobKind: 'image_gen', model: 'm', resolution: '1024', sPerStep: 4, overheadS: 10 },
    );
    eq(merged.sPerStep, 2.5, 'calibration merge is EWMA (0.25×4 + 0.75×2)');
  });

  await section('4. ComfyClient — happy path collects steps, phases, outputs', async () => {
    const t = new FakeTransport();
    t.script = [
      { type: 'executing', data: { node: '1', prompt_id: 'p1' } },
      { type: 'progress', data: { value: 10, max: 30, prompt_id: 'p1' } },
      { type: 'progress', data: { value: 30, max: 30, prompt_id: 'p1' } },
      { type: 'progress', data: { value: 5, max: 30, prompt_id: 'other' } }, // foreign prompt — ignored
      { type: 'executing', data: { node: null, prompt_id: 'p1' } }, // done
    ];
    const steps: number[] = []; const nodes: string[] = [];
    const c = new ComfyClient(t, 'cid');
    const res = await c.executeWorkflow({ '1': {} }, { onStep: (v) => steps.push(v), onNode: (n) => nodes.push(n) });
    eq(res.promptId, 'p1', 'prompt id returned');
    eq(steps.join(','), '10,30', 'steps forwarded; foreign-prompt events filtered');
    eq(nodes.join(','), '1', 'node transitions forwarded');
    ok(!!res.outputs['7'], 'outputs collected from history');
    eq(t.closed, 1, 'socket closed exactly once');
  });

  await section('5. ComfyClient — error, timeout, stall, abort all interrupt & reject', async () => {
    // ComfyClient unref()s its internal timers (production must never be held
    // open by them) — so in this bare test process we pin the event loop
    // ourselves, or the timeout/stall cases would hang a draining loop.
    const keepAlive = setInterval(() => undefined, 20);
    const kinds: string[] = [];

    // execution_error
    {
      const t = new FakeTransport();
      t.script = [{ type: 'execution_error', data: { prompt_id: 'p1', node_type: 'KSampler' } }];
      try { await new ComfyClient(t, 'c').executeWorkflow({}); } catch (e) { kinds.push((e as ComfyError).kind); }
    }
    // submit failure
    {
      const t = new FakeTransport(); t.failSubmit = true;
      try { await new ComfyClient(t, 'c').executeWorkflow({}); } catch (e) { kinds.push((e as ComfyError).kind); }
    }
    // timeout (tiny ceilings; no events ever arrive)
    {
      const t = new FakeTransport(); t.autoplay = false;
      try { await new ComfyClient(t, 'c').executeWorkflow({}, { timeoutMs: 30, stallMs: 10_000 }); }
      catch (e) { kinds.push((e as ComfyError).kind); ok(t.posts.some(p => p.path === '/interrupt'), 'timeout sends /interrupt'); }
    }
    // stall
    {
      const t = new FakeTransport(); t.autoplay = false;
      try { await new ComfyClient(t, 'c').executeWorkflow({}, { timeoutMs: 10_000, stallMs: 25 }); }
      catch (e) { kinds.push((e as ComfyError).kind); }
    }
    // abort
    {
      const t = new FakeTransport(); t.autoplay = false;
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 15);
      try { await new ComfyClient(t, 'c').executeWorkflow({}, { signal: ctrl.signal }); }
      catch (e) { kinds.push((e as ComfyError).kind); ok(t.posts.some(p => p.path === '/interrupt'), 'abort sends /interrupt'); }
    }
    eq(kinds.join(','), 'execution,submit,timeout,stall,aborted', 'every failure path yields its typed ComfyError');
    clearInterval(keepAlive);
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) for (const f of failures) console.log(`     • ${f}`);
  console.log('════════════════════════════════════════════════');
  process.exitCode = failed === 0 ? 0 : 1; // exitCode (not exit) so stdout flushes when piped
}

main().catch((e) => { console.error('❌ harness crashed:', e); process.exit(1); });
