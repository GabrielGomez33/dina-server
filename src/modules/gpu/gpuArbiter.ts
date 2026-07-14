// File: src/modules/gpu/gpuArbiter.ts
// ============================================================================
// DINA GPU ARBITER — SINGLE-CARD, CROSS-ENGINE VRAM SCHEDULER
// ============================================================================
//
// THE PROBLEM THIS SOLVES
// -----------------------
// dina-server runs LLM inference (Ollama) on ONE 24 GB RTX 3090 Ti. We are now
// adding local image/video generation (ComfyUI: FLUX/Wan/HunyuanVideo/LoRA),
// whose models are 12–60 GB and cannot coexist with Ollama's ~10 GB resident
// warm set. Naively sharing the card forces the exact failure the GPU runbook
// documents: Ollama spills to CPU (or ComfyUI OOMs) and latency craters.
//
// The card must therefore be TIME-shared, not space-shared, and interactive
// work must never wait behind a background render. This arbiter is the single
// process-wide choke point that enforces that. Every GPU consumer — including
// the six DinaLLMManager instances and the raw /debug/ollama-raw route — asks
// the arbiter for a lease before touching the GPU.
//
// DESIGN
// ------
//   • The core is PURE scheduling: priorities, budget admission, aging, and
//     shared/exclusive leasing. It knows nothing about HTTP/Ollama/ComfyUI.
//   • Engine-specific behaviour (drain/restore VRAM) is INJECTED via
//     EngineAdapter, so this file has no I/O and is fully unit-testable.
//   • Time is injected via Clock, so every timeout/watchdog/aging path is a
//     fast, deterministic proof (see test/gpu/gpuArbiterTest.ts).
//
// SAFETY PROPERTIES (all covered by the test harness)
//   1. Budget is never over-subscribed by shared leases.
//   2. An exclusive lease gets the whole card — no shared lease overlaps it.
//   3. Strict priority: higher urgency is served first (head-of-line blocking).
//   4. No starvation: a waiting request ages upward until it reaches the head.
//   5. No deadlock: a crashed holder is auto-released by a watchdog.
//   6. Backpressure: a request that waits too long rejects instead of hanging.
//   7. Idempotent release + abortable acquire; grant decisions are atomic.
// ============================================================================

import {
  ArbiterConfig,
  ArbiterSnapshot,
  EngineAdapter,
  Lease,
  LeaseMode,
  LeasePriority,
  LeaseRequest,
} from './types';
import { Clock, TimerHandle, realClock } from './clock';

// ---- Errors (typed so callers can distinguish backpressure from failure) ----

export class GpuAcquireTimeoutError extends Error {
  constructor(label: string, waitedMs: number) {
    super(`GPU acquire timed out for "${label}" after ${waitedMs}ms (backpressure)`);
    this.name = 'GpuAcquireTimeoutError';
  }
}
export class GpuAbortError extends Error {
  constructor(label: string) {
    super(`GPU acquire aborted for "${label}"`);
    this.name = 'GpuAbortError';
  }
}
export class GpuArbiterShutdownError extends Error {
  constructor(label: string) {
    super(`GPU arbiter is shutting down; rejected "${label}"`);
    this.name = 'GpuArbiterShutdownError';
  }
}

export const DEFAULT_ARBITER_CONFIG: ArbiterConfig = {
  // RTX 3090 Ti = 24 GB. Reserve ~2 GB for display/CUDA context → ~22 GB usable,
  // matching llmConfig.vramBudgetMb so both layers agree on the ceiling.
  budgetMb: 22000,
  reserveMb: 512,
  defaultAcquireTimeoutMs: 120000, // 2 min in queue, then backpressure
  defaultMaxHoldMs: 900000, // 15 min watchdog (a video render is long; a hang is longer)
  agingMs: 30000, // every 30s waited, a request gains one full priority tier
  drainOnExclusive: true,
};

// One priority tier. Base ranks are one tier apart; aging adds tiers over time.
const TIER = 100;

// Base urgency ranks. Higher = served first. Aging adds to these.
const PRIORITY_RANK: Record<LeasePriority, number> = {
  interactive: 3 * TIER,
  normal: 2 * TIER,
  background: 1 * TIER,
};

interface ActiveLease {
  id: string;
  label: string;
  engine: string;
  mode: LeaseMode;
  priority: LeasePriority;
  estVramMb: number;
  grantedAt: number;
  watchdog: TimerHandle | null;
  released: boolean;
}

interface Waiter {
  id: string;
  label: string;
  engine: string;
  mode: LeaseMode;
  priority: LeasePriority;
  estVramMb: number;
  maxHoldMs: number;
  enqueuedAt: number;
  resolve: (lease: Lease) => void;
  reject: (err: Error) => void;
  timeout: TimerHandle | null;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

export class GpuArbiter {
  private config: ArbiterConfig;
  private clock: Clock;

  private engines = new Map<string, EngineAdapter>();
  private active = new Map<string, ActiveLease>();
  private queue: Waiter[] = [];
  private drained = new Set<string>();

  private exclusiveActive = false;
  private draining = false; // true while awaiting engine.drain() for an exclusive grant
  private shuttingDown = false;

  private idSeq = 0;
  private agingTimer: TimerHandle | null = null;

  private totals = {
    granted: 0,
    released: 0,
    rejectedTimeout: 0,
    rejectedAborted: 0,
    watchdogReleases: 0,
    promotedToExclusive: 0,
  };

  constructor(config: Partial<ArbiterConfig> = {}, clock: Clock = realClock) {
    this.config = { ...DEFAULT_ARBITER_CONFIG, ...config };
    this.clock = clock;
  }

  /** Replace config at runtime (merges over current). Re-pumps in case budget grew. */
  configure(patch: Partial<ArbiterConfig>): void {
    this.config = { ...this.config, ...patch };
    this.pump();
  }

  /** Register an engine's drain/restore behaviour. Idempotent by engine name. */
  registerEngine(adapter: EngineAdapter): void {
    this.engines.set(adapter.name, adapter);
  }

  private get usableMb(): number {
    return Math.max(0, this.config.budgetMb - this.config.reserveMb);
  }

  private reservedMb(): number {
    let sum = 0;
    for (const l of this.active.values()) sum += l.estVramMb;
    return sum;
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  /**
   * Acquire a GPU lease. Resolves when the card is yours, rejects on timeout,
   * abort, or shutdown. ALWAYS release the returned lease — prefer run().
   */
  acquire(request: LeaseRequest): Promise<Lease> {
    if (this.shuttingDown) {
      return Promise.reject(new GpuArbiterShutdownError(request.label));
    }

    const priority: LeasePriority = request.priority ?? 'normal';
    let mode: LeaseMode = request.mode ?? 'shared';

    // Defensive VRAM floor: NaN/negative → 0. (Cap at budget happens AFTER the
    // promotion decision below, so an oversized request is still detected.)
    let est = Number.isFinite(request.estVramMb) ? Math.max(0, request.estVramMb) : 0;

    // A shared request larger than the usable budget can never fit alongside
    // anything — auto-promote it to exclusive so it is time-shared instead of
    // starving forever. (Covers a mis-sized LLM ctx or a big single image.)
    if (mode === 'shared' && est > this.usableMb) {
      mode = 'exclusive';
      this.totals.promotedToExclusive++;
    }

    // Now cap the stored estimate at the whole budget (a lease can't claim more
    // VRAM than exists on the card).
    est = Math.min(est, this.config.budgetMb);

    if (request.signal?.aborted) {
      return Promise.reject(new GpuAbortError(request.label));
    }

    return new Promise<Lease>((resolve, reject) => {
      const waiter: Waiter = {
        id: `gpl-${++this.idSeq}`,
        label: request.label,
        engine: request.engine,
        mode,
        priority,
        estVramMb: est,
        maxHoldMs: clampPositive(request.maxHoldMs, this.config.defaultMaxHoldMs),
        enqueuedAt: this.clock.now(),
        resolve,
        reject,
        timeout: null,
        signal: request.signal,
        settled: false,
      };

      const acquireTimeoutMs = clampPositive(request.acquireTimeoutMs, this.config.defaultAcquireTimeoutMs);
      waiter.timeout = this.clock.setTimer(acquireTimeoutMs, () => {
        if (waiter.settled) return;
        this.settleWaiter(waiter, 'timeout');
      });

      if (request.signal) {
        waiter.onAbort = () => {
          if (waiter.settled) return;
          this.settleWaiter(waiter, 'abort');
        };
        request.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }

      this.queue.push(waiter);
      this.pump();
    });
  }

  /**
   * Convenience: acquire → run fn → release (even if fn throws). This is the
   * ergonomic path every caller should use; it makes lease leaks impossible.
   */
  async run<T>(request: LeaseRequest, fn: (lease: Lease) => Promise<T>): Promise<T> {
    const lease = await this.acquire(request);
    try {
      return await fn(lease);
    } finally {
      lease.release();
    }
  }

  /** Point-in-time diagnostics for a health/status endpoint. */
  snapshot(): ArbiterSnapshot {
    const now = this.clock.now();
    return {
      budgetMb: this.config.budgetMb,
      reserveMb: this.config.reserveMb,
      usableMb: this.usableMb,
      reservedMb: this.reservedMb(),
      freeMb: Math.max(0, this.usableMb - this.reservedMb()),
      exclusiveActive: this.exclusiveActive,
      activeLeases: [...this.active.values()].map((l) => ({
        id: l.id,
        label: l.label,
        engine: l.engine,
        mode: l.mode,
        priority: l.priority,
        estVramMb: l.estVramMb,
        heldMs: now - l.grantedAt,
      })),
      queueDepth: this.queue.length,
      queued: this.queue.map((w) => ({
        id: w.id,
        label: w.label,
        engine: w.engine,
        mode: w.mode,
        priority: w.priority,
        estVramMb: w.estVramMb,
        waitedMs: now - w.enqueuedAt,
      })),
      drainedEngines: [...this.drained],
      totals: { ...this.totals },
    };
  }

  /** Reject all queued waiters and stop granting. Active leases are left to release. */
  shutdown(): void {
    this.shuttingDown = true;
    const pending = [...this.queue];
    this.queue = [];
    for (const w of pending) {
      this.finalizeWaiter(w);
      w.settled = true;
      w.reject(new GpuArbiterShutdownError(w.label));
    }
    if (this.agingTimer) {
      this.clock.clearTimer(this.agingTimer);
      this.agingTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // SCHEDULING CORE — pump() makes grant decisions SYNCHRONOUSLY so the
  // check-and-grant is atomic (no interleaving await between "there is room"
  // and "reserve it"). The only async side effect is draining engines for an
  // exclusive grant, which is fenced by the `draining`/`exclusiveActive` flags.
  // --------------------------------------------------------------------------

  private effectiveUrgency(w: Waiter, now: number): number {
    const waited = Math.max(0, now - w.enqueuedAt);
    // Aging: every `agingMs` a request waits, its urgency rises by one full
    // tier (100 pts) — so a background job (100) reaches interactive (300) after
    // ~2×agingMs of waiting and can no longer be starved by higher-priority work.
    const tiersGained = this.config.agingMs > 0 ? (waited / this.config.agingMs) * TIER : 0;
    return PRIORITY_RANK[w.priority] + tiersGained;
  }

  private pump(): void {
    this.pumpOnce();
    // Always (re)arm aging while a blocked waiter remains, regardless of which
    // early-return branch pumpOnce took — this is what guarantees liveness.
    this.scheduleAging();
  }

  private pumpOnce(): void {
    if (this.shuttingDown) return;
    // Cannot grant anything new while we are mid-drain for an exclusive lease.
    if (this.draining) return;

    // Process strictly in urgency order (desc), FIFO tie-break. Head-of-line
    // blocking: the first waiter we cannot grant stops the pass, which is what
    // gives us strict-priority + no-starvation (via aging) + no priority inversion.
    const now = this.clock.now();
    const ordered = [...this.queue].sort(
      (a, b) => this.effectiveUrgency(b, now) - this.effectiveUrgency(a, now) || a.enqueuedAt - b.enqueuedAt,
    );

    for (const w of ordered) {
      if (w.settled) continue;

      if (w.mode === 'exclusive') {
        // Exclusive needs the card empty AND no other exclusive in flight.
        if (this.active.size === 0 && !this.exclusiveActive) {
          this.beginExclusiveGrant(w);
        }
        // Whether or not we granted it, an exclusive at the head blocks
        // everything behind it this pass (prevents shared leases from starving it).
        return;
      }

      // Shared: fits iff no exclusive is active and budget has room.
      if (this.exclusiveActive) return; // exclusive owns the card; block all shared
      const room = this.usableMb - this.reservedMb();
      if (w.estVramMb <= room) {
        this.grantShared(w);
      } else {
        // Largest-fit-first would risk starving this waiter; head-of-line block instead.
        return;
      }
    }
  }

  private grantShared(w: Waiter): void {
    this.removeFromQueue(w.id);
    this.finalizeWaiter(w);
    const lease = this.materialize(w);
    this.active.set(lease.id, lease);
    this.totals.granted++;
    w.settled = true;
    w.resolve(this.toPublic(lease));
    this.scheduleAging();
  }

  private beginExclusiveGrant(w: Waiter): void {
    // Reserve the exclusive slot SYNCHRONOUSLY so no other grant can slip in
    // while we await the drain below.
    this.exclusiveActive = true;
    this.draining = true;
    this.removeFromQueue(w.id);
    this.finalizeWaiter(w);
    w.settled = true;

    const drainOthers = this.config.drainOnExclusive ? this.drainEnginesExcept(w.engine, w.label) : Promise.resolve();

    drainOthers
      .catch(() => {
        /* drain adapters are best-effort and must not throw; belt-and-suspenders */
      })
      .then(() => {
        this.draining = false;
        // If we were shut down mid-drain, hand back a rejection instead of a lease.
        if (this.shuttingDown) {
          this.exclusiveActive = false;
          w.reject(new GpuArbiterShutdownError(w.label));
          void this.restoreDrainedEngines(w.label);
          this.pump();
          return;
        }
        const lease = this.materialize(w);
        this.active.set(lease.id, lease);
        this.totals.granted++;
        w.resolve(this.toPublic(lease));
        this.scheduleAging();
      });
  }

  private materialize(w: Waiter): ActiveLease {
    const lease: ActiveLease = {
      id: w.id,
      label: w.label,
      engine: w.engine,
      mode: w.mode,
      priority: w.priority,
      estVramMb: w.estVramMb,
      grantedAt: this.clock.now(),
      watchdog: null,
      released: false,
    };
    // Watchdog: a lease held past maxHoldMs is force-released so a crashed or
    // hung job cannot own the GPU forever.
    lease.watchdog = this.clock.setTimer(w.maxHoldMs, () => {
      if (lease.released) return;
      this.totals.watchdogReleases++;
      console.error(
        `🔴 [gpuArbiter] WATCHDOG force-releasing lease "${lease.label}" (${lease.id}) held > ${w.maxHoldMs}ms — ` +
          `the holder likely crashed or hung. Freeing the GPU.`,
      );
      this.releaseLease(lease.id);
    });
    return lease;
  }

  private toPublic(lease: ActiveLease): Lease {
    const self = this;
    return {
      id: lease.id,
      label: lease.label,
      engine: lease.engine,
      mode: lease.mode,
      priority: lease.priority,
      estVramMb: lease.estVramMb,
      grantedAt: lease.grantedAt,
      get released() {
        return lease.released;
      },
      release() {
        self.releaseLease(lease.id);
      },
    };
  }

  private releaseLease(id: string): void {
    const lease = this.active.get(id);
    if (!lease || lease.released) return; // idempotent
    lease.released = true;
    if (lease.watchdog) {
      this.clock.clearTimer(lease.watchdog);
      lease.watchdog = null;
    }
    this.active.delete(id);
    this.totals.released++;

    if (lease.mode === 'exclusive') {
      this.exclusiveActive = false;
      // Re-warm the engines we drained for this exclusive job (best-effort, async).
      void this.restoreDrainedEngines(lease.label);
    }
    this.pump();
  }

  // --------------------------------------------------------------------------
  // ENGINE DRAIN / RESTORE (best-effort, never throws into the scheduler)
  // --------------------------------------------------------------------------

  private async drainEnginesExcept(exceptEngine: string, reason: string): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const [name, adapter] of this.engines) {
      if (name === exceptEngine) continue;
      jobs.push(
        (async () => {
          try {
            const freed = await adapter.drain(`exclusive:${reason}`);
            this.drained.add(name);
            if (freed > 0) {
              console.log(`🧹 [gpuArbiter] drained engine "${name}" (~${freed}MB freed) for exclusive "${reason}"`);
            }
          } catch (err) {
            console.warn(`⚠️ [gpuArbiter] engine "${name}" drain failed (continuing): ${(err as Error).message}`);
          }
        })(),
      );
    }
    await Promise.all(jobs);
  }

  private async restoreDrainedEngines(reason: string): Promise<void> {
    const names = [...this.drained];
    this.drained.clear();
    for (const name of names) {
      const adapter = this.engines.get(name);
      if (!adapter) continue;
      try {
        await adapter.restore(`post-exclusive:${reason}`);
      } catch (err) {
        console.warn(`⚠️ [gpuArbiter] engine "${name}" restore failed (non-fatal): ${(err as Error).message}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // WAITER LIFECYCLE HELPERS
  // --------------------------------------------------------------------------

  private settleWaiter(w: Waiter, kind: 'timeout' | 'abort'): void {
    if (w.settled) return;
    w.settled = true;
    this.removeFromQueue(w.id);
    this.finalizeWaiter(w);
    if (kind === 'timeout') {
      this.totals.rejectedTimeout++;
      w.reject(new GpuAcquireTimeoutError(w.label, this.clock.now() - w.enqueuedAt));
    } else {
      this.totals.rejectedAborted++;
      w.reject(new GpuAbortError(w.label));
    }
    this.pump();
  }

  private finalizeWaiter(w: Waiter): void {
    if (w.timeout) {
      this.clock.clearTimer(w.timeout);
      w.timeout = null;
    }
    if (w.signal && w.onAbort) {
      w.signal.removeEventListener('abort', w.onAbort);
      w.onAbort = undefined;
    }
  }

  private removeFromQueue(id: string): void {
    const i = this.queue.findIndex((w) => w.id === id);
    if (i >= 0) this.queue.splice(i, 1);
  }

  /**
   * Aging makes a waiting request's urgency rise over time, but urgency changes
   * with the clock, not with events — so while the queue holds a blocked waiter
   * we schedule a periodic re-pump to let aging take effect. Timer is unref'd.
   */
  private scheduleAging(): void {
    if (this.agingTimer || this.queue.length === 0 || this.config.agingMs <= 0) return;
    this.agingTimer = this.clock.setTimer(this.config.agingMs, () => {
      this.agingTimer = null;
      if (this.queue.length > 0) {
        this.pump();
        this.scheduleAging();
      }
    });
  }
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

// Process-wide singleton — the ONE choke point every GPU consumer funnels through.
export const gpuArbiter = new GpuArbiter();
