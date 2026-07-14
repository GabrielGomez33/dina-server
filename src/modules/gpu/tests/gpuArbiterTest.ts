// File: src/modules/gpu/tests/gpuArbiterTest.ts
// ============================================================================
// DINA GPU ARBITER — HERMETIC PROOF HARNESS
// ============================================================================
//
// Dependency-light, deterministic proof of the arbiter's safety properties.
// It imports ONLY the arbiter (no DB, Redis, LLM, HTTP or real GPU) and drives
// time with a VirtualClock, so every timeout/watchdog/aging path is exercised
// in microseconds with zero flakiness.
//
//   run:  npx ts-node src/modules/gpu/tests/gpuArbiterTest.ts
//
// Each ▶ section asserts one safety property from gpuArbiter.ts's header:
//   1. budget never over-subscribed        5. no starvation (aging)
//   2. exclusive never overlaps shared     6. backpressure (acquire timeout)
//   3. strict priority (head-of-line)      7. idempotent release / abort / watchdog
//   4. drain + restore around exclusive    8. auto-promotion, run() safety, shutdown
// ============================================================================

import { GpuArbiter } from '../gpuArbiter';
import { GpuAcquireTimeoutError, GpuAbortError, GpuArbiterShutdownError } from '../gpuArbiter';
import { VirtualClock } from '../clock';
import { EngineAdapter, Lease, LeaseRequest } from '../types';

// ----------------------------------------------------------------------------
// Tiny assertion framework (matches test/digim/* style)
// ----------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, name: string): void {
  if (cond) passed++;
  else {
    failed++;
    failures.push(name);
    console.error(`  ❌ ${name}`);
  }
}
function eq(actual: unknown, expected: unknown, name: string): void {
  ok(actual === expected, `${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
async function section(title: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n▶ ${title}`);
  await fn();
}

/** Let queued microtasks (promise .then handlers) settle. Independent of VirtualClock. */
async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/** Wrap acquire() so we can inspect settlement without awaiting a pending promise. */
interface Tracked {
  status: 'pending' | 'granted' | 'rejected';
  lease?: Lease;
  error?: Error;
}
function track(p: Promise<Lease>): Tracked {
  const t: Tracked = { status: 'pending' };
  p.then(
    (lease) => {
      t.status = 'granted';
      t.lease = lease;
    },
    (err) => {
      t.status = 'rejected';
      t.error = err;
    },
  );
  return t;
}

/** Fake engine adapter that records drain/restore calls; configurable to fail. */
class FakeEngine implements EngineAdapter {
  drains = 0;
  restores = 0;
  constructor(
    readonly name: string,
    private readonly freedMb = 10000,
    private readonly failDrain = false,
  ) {}
  async drain(): Promise<number> {
    this.drains++;
    if (this.failDrain) throw new Error('simulated drain failure');
    return this.freedMb;
  }
  async restore(): Promise<void> {
    this.restores++;
  }
}

const shared = (label: string, est: number, extra: Partial<LeaseRequest> = {}): LeaseRequest => ({
  label,
  engine: 'ollama',
  estVramMb: est,
  mode: 'shared',
  priority: 'normal',
  ...extra,
});
const exclusive = (label: string, extra: Partial<LeaseRequest> = {}): LeaseRequest => ({
  label,
  engine: 'comfyui',
  estVramMb: 22000,
  mode: 'exclusive',
  priority: 'background',
  ...extra,
});

// ============================================================================
// TESTS
// ============================================================================

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log('   DINA GPU ARBITER — PROOF HARNESS');
  console.log('════════════════════════════════════════════════');

  await section('1. Budget is never over-subscribed by shared leases', async () => {
    const clock = new VirtualClock();
    const arb = new GpuArbiter({ budgetMb: 10000, reserveMb: 0 }, clock);

    const a = await arb.acquire(shared('a', 6000));
    const b = await arb.acquire(shared('b', 3000)); // 9000 <= 10000 → fits
    const c = track(arb.acquire(shared('c', 3000))); // 12000 > 10000 → must queue
    await flush();

    eq(arb.snapshot().reservedMb, 9000, 'two shared leases reserve 9000MB');
    eq(c.status, 'pending', 'overflowing shared lease is queued, not granted');
    eq(arb.snapshot().freeMb, 1000, '1000MB free, correctly not enough for a 3000MB lease');

    b.release();
    await flush();
    eq(c.status, 'granted', 'queued lease grants once budget frees');
    eq(arb.snapshot().reservedMb, 9000, 'budget invariant holds after re-grant (6000+3000)');
    a.release();
    c.lease!.release();
  });

  await section('2. Exclusive lease never overlaps a shared lease', async () => {
    const clock = new VirtualClock();
    const arb = new GpuArbiter({ budgetMb: 22000, reserveMb: 0 }, clock);
    arb.registerEngine(new FakeEngine('ollama'));

    const s = await arb.acquire(shared('llm', 5000));
    const x = track(arb.acquire(exclusive('video')));
    await flush();
    eq(x.status, 'pending', 'exclusive waits while a shared lease is active');

    // While exclusive is queued, a new shared lease must NOT be able to grant
    // ahead in a way that would overlap — but a higher-priority shared CAN run
    // (that is priority, not overlap). Overlap = exclusive + anything active.
    s.release();
    await flush();
    eq(x.status, 'granted', 'exclusive grants once the card is empty');
    const snap = arb.snapshot();
    eq(snap.exclusiveActive, true, 'exclusiveActive flag set');
    eq(snap.activeLeases.length, 1, 'exactly one active lease during exclusive');

    // A shared request arriving during an exclusive lease must queue (no overlap).
    const late = track(arb.acquire(shared('llm2', 100)));
    await flush();
    eq(late.status, 'pending', 'shared lease cannot overlap an active exclusive');
    x.lease!.release();
    await flush();
    eq(late.status, 'granted', 'shared lease proceeds after exclusive releases');
    late.lease!.release();
  });

  await section('3. Drain competing engines before exclusive, restore after', async () => {
    const clock = new VirtualClock();
    const arb = new GpuArbiter({ budgetMb: 22000, reserveMb: 0 }, clock);
    const ollama = new FakeEngine('ollama', 10000);
    arb.registerEngine(ollama);

    const x = await arb.run(exclusive('render', { engine: 'comfyui' }), async (lease) => {
      // During the exclusive job, ollama must have been drained exactly once.
      eq(ollama.drains, 1, 'ollama drained once before exclusive body runs');
      eq(ollama.restores, 0, 'restore not called until after release');
      return lease.id;
    });
    await flush();
    ok(typeof x === 'string', 'run() returns the fn result');
    eq(ollama.restores, 1, 'ollama restored once after exclusive releases');
  });

  await section('4. Strict priority — interactive jumps a queued background exclusive', async () => {
    const clock = new VirtualClock();
    const arb = new GpuArbiter({ budgetMb: 22000, reserveMb: 0 }, clock);
    arb.registerEngine(new FakeEngine('ollama'));

    const hold = await arb.acquire(shared('hold', 1000, { priority: 'interactive' }));
    const bg = track(arb.acquire(exclusive('bg-video'))); // background, queued (card busy)
    await flush();
    eq(bg.status, 'pending', 'background exclusive queues behind active lease');

    const chat = track(arb.acquire(shared('chat', 500, { priority: 'interactive' })));
    await flush();
    eq(chat.status, 'granted', 'interactive chat jumps ahead of the queued background exclusive');
    eq(bg.status, 'pending', 'background exclusive still waits');

    hold.release();
    chat.lease!.release();
    await flush();
    eq(bg.status, 'granted', 'background exclusive runs once the card empties');
    bg.lease!.release();
  });

  await section('5. No starvation — an aged background job beats newer interactive work', async () => {
    const clock = new VirtualClock();
    // Fully-serialized card (only one 1000MB lease fits) so priority ORDER is
    // what decides who runs next. agingMs=1000 → background(100) overtakes
    // interactive(300) after >2000ms of waiting.
    const arb = new GpuArbiter({ budgetMb: 1000, reserveMb: 0, agingMs: 1000 }, clock);

    const hold = await arb.acquire(shared('hold', 1000, { priority: 'interactive' }));
    const bg = track(arb.acquire(shared('bg', 1000, { priority: 'background', acquireTimeoutMs: 60000 })));
    await flush();
    eq(bg.status, 'pending', 'background lease blocked — card full');

    clock.advance(2500); // bg ages: 100 + (2500/1000)*100 = 350 > interactive 300
    // A fresh interactive request arrives AFTER bg has aged.
    const chat = track(arb.acquire(shared('chat', 1000, { priority: 'interactive', acquireTimeoutMs: 60000 })));
    await flush();
    eq(chat.status, 'pending', 'newer interactive request also blocked — card still full');

    hold.release(); // one slot frees; scheduler picks the higher effective urgency
    await flush();
    eq(bg.status, 'granted', 'aged background lease is served before the newer interactive one');
    eq(chat.status, 'pending', 'newer interactive waits — proof aging prevents starvation');
    bg.lease!.release();
    await flush();
    eq(chat.status, 'granted', 'interactive served next');
    chat.lease!.release();
  });

  await section('6. Backpressure — acquire times out instead of hanging', async () => {
    const clock = new VirtualClock();
    const arb = new GpuArbiter({ budgetMb: 1000, reserveMb: 0 }, clock);
    const hold = await arb.acquire(shared('hold', 1000));
    const late = track(arb.acquire(shared('late', 1000, { acquireTimeoutMs: 5000 })));
    await flush();
    eq(late.status, 'pending', 'late lease waits');

    clock.advance(5000);
    await flush();
    eq(late.status, 'rejected', 'late lease rejects at the acquire timeout');
    ok(late.error instanceof GpuAcquireTimeoutError, 'rejection is a GpuAcquireTimeoutError');
    eq(arb.snapshot().totals.rejectedTimeout, 1, 'timeout counted');
    hold.release();
  });

  await section('7a. Watchdog force-releases a leaked lease (no deadlock)', async () => {
    const clock = new VirtualClock();
    const arb = new GpuArbiter({ budgetMb: 1000, reserveMb: 0 }, clock);
    // Grant a lease and NEVER release it (simulate a crashed holder).
    await arb.acquire(shared('leaky', 1000, { maxHoldMs: 10000 }));
    const waiting = track(arb.acquire(shared('waiting', 1000, { acquireTimeoutMs: 60000 })));
    await flush();
    eq(waiting.status, 'pending', 'second lease blocked by the leaked one');

    clock.advance(10000); // watchdog fires
    await flush();
    eq(waiting.status, 'granted', 'watchdog freed the GPU so the waiter proceeds');
    eq(arb.snapshot().totals.watchdogReleases, 1, 'watchdog release counted');
    waiting.lease!.release();
  });

  await section('7b. Idempotent release + abort', async () => {
    const clock = new VirtualClock();
    const arb = new GpuArbiter({ budgetMb: 1000, reserveMb: 0 }, clock);
    const a = await arb.acquire(shared('a', 1000));
    a.release();
    a.release(); // double release must be a safe no-op
    eq(arb.snapshot().reservedMb, 0, 'double release does not corrupt the budget');
    eq(arb.snapshot().totals.released, 1, 'release counted exactly once');

    // Abort a queued waiter.
    const hold = await arb.acquire(shared('hold', 1000));
    const ctrl = new AbortController();
    const ab = track(arb.acquire(shared('abortme', 1000, { signal: ctrl.signal })));
    await flush();
    eq(ab.status, 'pending', 'aborted-candidate is queued');
    ctrl.abort();
    await flush();
    eq(ab.status, 'rejected', 'aborting the signal rejects the acquire');
    ok(ab.error instanceof GpuAbortError, 'rejection is a GpuAbortError');
    hold.release();
  });

  await section('8. Auto-promotion, run() cleanup on throw, shutdown', async () => {
    const clock = new VirtualClock();
    const arb = new GpuArbiter({ budgetMb: 8000, reserveMb: 0 }, clock);

    // A shared request larger than the usable budget is auto-promoted to exclusive.
    const big = await arb.acquire(shared('too-big', 12000));
    eq(big.mode, 'exclusive', 'oversized shared request auto-promoted to exclusive');
    eq(arb.snapshot().totals.promotedToExclusive, 1, 'promotion counted');
    big.release();

    // run() releases the lease even when the body throws.
    let threw = false;
    try {
      await arb.run(shared('boom', 1000), async () => {
        throw new Error('boom');
      });
    } catch {
      threw = true;
    }
    ok(threw, 'run() propagates the body error');
    eq(arb.snapshot().reservedMb, 0, 'run() released the lease despite the throw');

    // Shutdown rejects everything queued.
    const hold = await arb.acquire(shared('hold', 8000));
    const q = track(arb.acquire(shared('q', 8000)));
    await flush();
    arb.shutdown();
    await flush();
    eq(q.status, 'rejected', 'shutdown rejects queued waiters');
    ok(q.error instanceof GpuArbiterShutdownError, 'rejection is a GpuArbiterShutdownError');
    hold.release();
  });

  await section('9. Drain failure is survivable — exclusive still runs', async () => {
    const clock = new VirtualClock();
    const arb = new GpuArbiter({ budgetMb: 22000, reserveMb: 0 }, clock);
    arb.registerEngine(new FakeEngine('ollama', 0, /* failDrain */ true));

    let ran = false;
    await arb.run(exclusive('render-despite-drain-fail', { engine: 'comfyui' }), async () => {
      ran = true;
    });
    await flush();
    ok(ran, 'exclusive body runs even when engine.drain() throws (best-effort)');
  });

  // --------------------------------------------------------------------------
  console.log('\n════════════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('   FAILURES:');
    for (const f of failures) console.log(`     • ${f}`);
  }
  console.log('════════════════════════════════════════════════');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('❌ Test harness crashed:', err);
  process.exit(1);
});
