// File: src/modules/saga/tests/generationWorkerTest.ts
// ============================================================================
// DINA SAGA — GENERATION WORKER PROOF HARNESS
// ============================================================================
// Proves the Phase-2 keystone end-to-end with fakes: correct lease mode per
// model, fidelity + user-input composition, files-are-authoritative, and the
// safety properties that keep one bad job from wedging the GPU —
//   • bind failure never acquires a lease
//   • the lease is released on success AND on engine failure
//   • unknown model / GPU-unavailable fail cleanly
//
//   run:  npx ts-node src/modules/saga/tests/generationWorkerTest.ts
// ============================================================================

import {
  GenerationWorker, GpuLease, GpuLeaseProvider, ComfyExecutor, GenerationStore, extractOutputFiles,
} from '../systems/generationWorker';
import { ComfyError, ComfyResult } from '../systems/comfyClient';
import { JobProgress, ProgressSinkPort } from '../types';

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(c: boolean, name: string): void { if (c) passed++; else { failed++; failures.push(name); console.error(`  ❌ ${name}`); } }
function eq(a: unknown, e: unknown, name: string): void { ok(a === e, `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`); }
async function section(t: string, fn: () => Promise<void> | void): Promise<void> { console.log(`\n▶ ${t}`); await fn(); }

// ---- fakes -------------------------------------------------------------------

class FakeGpu implements GpuLeaseProvider {
  calls: Array<{ mode: string; vramMb: number; priority: number }> = [];
  releases = 0;
  rejectWith: Error | null = null;
  async acquire(req: { mode: 'shared' | 'exclusive'; vramMb: number; priority: number }): Promise<GpuLease> {
    if (this.rejectWith) throw this.rejectWith;
    this.calls.push({ mode: req.mode, vramMb: req.vramMb, priority: req.priority });
    return { release: () => { this.releases++; } };
  }
}

class FakeStore implements GenerationStore {
  events: string[] = [];
  lastFail?: { code: string; message: string };
  lastOk?: { files: string[]; elapsedMs: number };
  async markRunning(): Promise<void> { this.events.push('running'); }
  async markSucceeded(_id: string, o: { files: string[]; elapsedMs: number }): Promise<void> { this.events.push('succeeded'); this.lastOk = o; }
  async markFailed(_id: string, code: string, message: string): Promise<void> { this.events.push('failed'); this.lastFail = { code, message }; }
}

class FakeSink implements ProgressSinkPort {
  events: JobProgress[] = [];
  emit(e: JobProgress): void { this.events.push(e); }
}

/** Fake ComfyUI: emits N steps then resolves with outputs; or throws a ComfyError. */
class FakeComfy implements ComfyExecutor {
  lastGraph?: Record<string, any>;
  constructor(private readonly opts: { steps?: number; outputs?: Record<string, any>; throwKind?: ComfyError['kind'] } = {}) {}
  async executeWorkflow(graph: Record<string, any>, handlers?: any): Promise<ComfyResult> {
    this.lastGraph = graph;
    if (this.opts.throwKind) throw new ComfyError(this.opts.throwKind, `simulated ${this.opts.throwKind}`);
    const steps = this.opts.steps ?? 4;
    for (let i = 1; i <= steps; i++) handlers?.onStep?.(i, steps);
    return { promptId: 'p1', outputs: this.opts.outputs ?? { '9': { images: [{ filename: 'out_0001.png' }] } }, elapsedMs: 1234 };
  }
}

function mkWorker(comfy: ComfyExecutor, gpu = new FakeGpu(), store = new FakeStore(), sink = new FakeSink()) {
  return { worker: new GenerationWorker({ comfy, gpu, store, sink }), gpu, store, sink };
}

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA SAGA — GENERATION WORKER PROOFS');
  console.log('════════════════════════════════════════════════');

  await section('1. image happy path — SHARED lease, records success, releases', async () => {
    const { worker, gpu, store, sink } = mkWorker(new FakeComfy());
    const r = await worker.run({ generationId: 'g1', jobKind: 'image_gen', inputs: { prompt: 'a cat' } });
    eq(r.ok, true, 'succeeds');
    eq(r.leaseMode, 'shared', 'light image model → SHARED lease');
    eq(gpu.calls[0]?.vramMb, 7000, 'lease requested with the profile VRAM footprint');
    eq(gpu.releases, 1, 'lease released exactly once');
    eq(store.events.join('>'), 'running>succeeded', 'store lifecycle: running → succeeded');
    eq((r.files ?? [])[0], 'out_0001.png', 'output file extracted');
    ok(sink.events.length >= 2, 'progress emitted');
    eq(sink.events[sink.events.length - 1].overall_pct, 100, 'final progress reaches 100');
  });

  await section('2. video happy path — EXCLUSIVE lease (the arbiter drain trigger)', async () => {
    const { worker, gpu } = mkWorker(new FakeComfy({ outputs: { '10': { gifs: [{ filename: 'saga_video_0001.mp4' }] } } }));
    const r = await worker.run({ generationId: 'v1', jobKind: 'video_gen', inputs: { prompt: 'run', referenceImage: 'x.png' } });
    eq(r.ok, true, 'video succeeds');
    eq(r.leaseMode, 'exclusive', 'heavy video model → EXCLUSIVE lease');
    eq(gpu.calls[0]?.vramMb, 18000, 'exclusive lease carries the heavy footprint');
    eq((r.files ?? [])[0], 'saga_video_0001.mp4', 'mp4 extracted from VHS gifs[] output');
  });

  await section('3. fidelity dial maps into the template (only declared inputs)', async () => {
    const comfy = new FakeComfy();
    const { worker } = mkWorker(comfy);
    // reference model declares ipAdapterWeight; level 10 → 0.9
    await worker.run({ generationId: 'g2', jobKind: 'image_gen', modelId: 'animagine-xl-4-ref', fidelityLevel: 10, inputs: { prompt: 'p', referenceImage: 'r.png' } });
    // node '10' is IPAdapterAdvanced in image-reference@1
    eq(comfy.lastGraph?.['10']?.inputs?.weight, 0.9, 'fidelity 10 → ipAdapterWeight 0.9 bound into the graph');
  });

  await section('4. files are authoritative — user cannot swap the model checkpoint', async () => {
    const comfy = new FakeComfy();
    const { worker } = mkWorker(comfy);
    await worker.run({ generationId: 'g3', jobKind: 'image_gen', inputs: { prompt: 'p', checkpoint: 'evil.safetensors' } });
    eq(comfy.lastGraph?.['1']?.inputs?.ckpt_name, 'animagine-xl-4.0.safetensors', 'profile file wins over a user-supplied checkpoint');
  });

  await section('5. user inputs override profile defaults (params are tunable)', async () => {
    const comfy = new FakeComfy();
    const { worker } = mkWorker(comfy);
    await worker.run({ generationId: 'g4', jobKind: 'image_gen', inputs: { prompt: 'p', steps: 12 } });
    eq(comfy.lastGraph?.['5']?.inputs?.steps, 12, 'user steps override the default 28');
  });

  await section('6. bind failure NEVER acquires the GPU (fail fast, zero cost)', async () => {
    const { worker, gpu, store } = mkWorker(new FakeComfy());
    // image-basic requires `prompt`; omit it → WorkflowBindError before any lease
    const r = await worker.run({ generationId: 'g5', jobKind: 'image_gen', inputs: {} });
    eq(r.ok, false, 'fails');
    eq(r.error?.code, 'INVALID_REQUEST', 'classified as invalid request');
    eq(gpu.calls.length, 0, 'GPU was NEVER acquired for an unbindable graph');
    eq(gpu.releases, 0, 'nothing to release');
    eq(store.events.join('>'), 'failed', 'marked failed without ever running');
  });

  await section('7. engine error still RELEASES the lease (no wedged GPU)', async () => {
    const { worker, gpu, store } = mkWorker(new FakeComfy({ throwKind: 'execution' }));
    const r = await worker.run({ generationId: 'g6', jobKind: 'image_gen', inputs: { prompt: 'p' } });
    eq(r.ok, false, 'fails');
    eq(r.error?.code, 'ENGINE_ERROR', 'execution error mapped');
    eq(gpu.calls.length, 1, 'lease was acquired');
    eq(gpu.releases, 1, 'lease RELEASED despite the failure (finally)');
    eq(store.events.join('>'), 'running>failed', 'running → failed');
  });

  await section('8. timeout / abort map to distinct codes and still release', async () => {
    for (const [kind, code] of [['timeout', 'TIMEOUT'], ['aborted', 'CANCELLED'], ['stall', 'STALLED']] as const) {
      const { worker, gpu } = mkWorker(new FakeComfy({ throwKind: kind }));
      const r = await worker.run({ generationId: `t-${kind}`, jobKind: 'image_gen', inputs: { prompt: 'p' } });
      eq(r.error?.code, code, `${kind} → ${code}`);
      eq(gpu.releases, 1, `${kind} still releases the lease`);
    }
  });

  await section('9. unknown model / GPU unavailable fail cleanly', async () => {
    const bad = mkWorker(new FakeComfy());
    const r1 = await bad.worker.run({ generationId: 'g7', jobKind: 'image_gen', modelId: 'nope' });
    eq(r1.error?.code, 'MODEL_NOT_FOUND', 'unknown model → MODEL_NOT_FOUND');
    eq(bad.gpu.calls.length, 0, 'no GPU touched for an unknown model');

    const gpu = new FakeGpu(); gpu.rejectWith = new Error('backpressure: queue full');
    const busy = mkWorker(new FakeComfy(), gpu);
    const r2 = await busy.worker.run({ generationId: 'g8', jobKind: 'image_gen', inputs: { prompt: 'p' } });
    eq(r2.error?.code, 'GPU_UNAVAILABLE', 'acquire rejection → GPU_UNAVAILABLE');
    eq(busy.store.events.join('>'), 'running>failed', 'marked running then failed');
  });

  await section('10. extractOutputFiles — images + gifs across nodes, robust to junk', () => {
    const files = extractOutputFiles({ '9': { images: [{ filename: 'a.png' }, { filename: 'b.png' }] }, '10': { gifs: [{ filename: 'c.mp4' }] }, '11': { text: 'noise' } });
    eq(files.join(','), 'a.png,b.png,c.mp4', 'collects all image + gif filenames, ignores non-file outputs');
    eq(extractOutputFiles({}).length, 0, 'empty outputs → no files');
    eq(extractOutputFiles(null as any).length, 0, 'null outputs → no throw');
  });

  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) for (const f of failures) console.log(`     • ${f}`);
  console.log('════════════════════════════════════════════════');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error('❌ harness crashed:', e); process.exit(1); });
