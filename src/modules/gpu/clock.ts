// File: src/modules/gpu/clock.ts
// ============================================================================
// DINA GPU ARBITER — INJECTABLE CLOCK
// ============================================================================
//
// Time is the arbiter's hardest dependency to test: queue timeouts, watchdog
// auto-release, and priority aging are all time-driven. Rather than sprinkle
// Date.now()/setTimeout() through the scheduler (which would force real sleeps
// in tests and make them slow + flaky), the arbiter takes a Clock. Production
// uses realClock; tests use VirtualClock and advance time deterministically.
//
// This is the seam that makes every timing edge case a fast, repeatable proof.
// ============================================================================

export interface TimerHandle {
  readonly _id: number;
}

export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
  /** Schedule `fn` to run after `ms`. Returns a handle for cancellation. */
  setTimer(ms: number, fn: () => void): TimerHandle;
  /** Cancel a scheduled timer. Safe to call on an already-fired/unknown handle. */
  clearTimer(handle: TimerHandle | null | undefined): void;
}

// ----------------------------------------------------------------------------
// PRODUCTION CLOCK — wraps Date.now + setTimeout. Timers are unref()'d so the
// arbiter can never keep the Node process alive on its own.
// ----------------------------------------------------------------------------

class RealClock implements Clock {
  private seq = 0;
  private readonly timers = new Map<number, NodeJS.Timeout>();

  now(): number {
    return Date.now();
  }

  setTimer(ms: number, fn: () => void): TimerHandle {
    const id = ++this.seq;
    const t = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, Math.max(0, ms));
    // Do not hold the event loop open for an arbiter timer.
    if (typeof t.unref === 'function') t.unref();
    this.timers.set(id, t);
    return { _id: id };
  }

  clearTimer(handle: TimerHandle | null | undefined): void {
    if (!handle) return;
    const t = this.timers.get(handle._id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(handle._id);
    }
  }
}

export const realClock: Clock = new RealClock();

// ----------------------------------------------------------------------------
// VIRTUAL CLOCK — deterministic, manually advanced. Test-only, but shipped
// beside the arbiter so the proof harness needs no external mocking library.
// ----------------------------------------------------------------------------

interface VirtualTimer {
  id: number;
  fireAt: number;
  fn: () => void;
}

export class VirtualClock implements Clock {
  private current: number;
  private seq = 0;
  private timers: VirtualTimer[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimer(ms: number, fn: () => void): TimerHandle {
    const id = ++this.seq;
    this.timers.push({ id, fireAt: this.current + Math.max(0, ms), fn });
    return { _id: id };
  }

  clearTimer(handle: TimerHandle | null | undefined): void {
    if (!handle) return;
    this.timers = this.timers.filter((t) => t.id !== handle._id);
  }

  /**
   * Advance virtual time by `ms`, firing every timer whose deadline is crossed
   * in chronological order. Timers scheduled by a firing callback are honoured
   * if they fall within the same window (mirrors real setTimeout semantics).
   */
  advance(ms: number): void {
    const target = this.current + ms;
    // Loop because a fired callback may schedule new timers before `target`.
    // Guard against pathological infinite re-scheduling.
    let guard = 0;
    while (true) {
      const due = this.timers
        .filter((t) => t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
      if (due.length === 0) break;
      const next = due[0];
      this.timers = this.timers.filter((t) => t.id !== next.id);
      this.current = next.fireAt;
      next.fn();
      if (++guard > 100000) {
        throw new Error('VirtualClock.advance: timer storm (possible infinite reschedule)');
      }
    }
    this.current = target;
  }

  /** Number of timers still pending — useful for leak assertions in tests. */
  get pendingTimers(): number {
    return this.timers.length;
  }
}
