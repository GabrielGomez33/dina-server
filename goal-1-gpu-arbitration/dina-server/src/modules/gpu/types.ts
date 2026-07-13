// File: src/modules/gpu/types.ts
// ============================================================================
// DINA GPU ARBITER — PUBLIC TYPE CONTRACT
// ============================================================================
//
// These types are the ONLY coupling surface between the arbiter and its
// callers/engines. The arbiter core (gpuArbiter.ts) depends on nothing except
// these types + an injectable Clock — it knows nothing about Ollama, ComfyUI,
// HTTP, or the database. Engine-specific behaviour (how to free VRAM, how to
// re-warm) is supplied through the EngineAdapter interface, keeping concerns
// strictly separated (single responsibility, no intertwined logic).
// ============================================================================

/**
 * Scheduling urgency for a lease request.
 *   • interactive — a human is waiting on this right now (@Dina chat, streaming).
 *   • normal      — user-triggered but tolerant of a short wait (analysis, a
 *                   one-off image generation the user is watching).
 *   • background  — no human in the loop (digim research embeddings, batch
 *                   video renders, LoRA training, backfills).
 *
 * Higher urgency is always served first, BUT a long-waiting lower-urgency
 * request ages upward so it can never starve indefinitely (see ArbiterConfig.agingMs).
 */
export type LeasePriority = 'interactive' | 'normal' | 'background';

/**
 * How the lease shares the card:
 *   • shared    — coexists with other shared leases as long as the summed VRAM
 *                 estimate stays within budget (space-sharing). LLM calls use this.
 *   • exclusive — needs the whole card. The arbiter waits for every other lease
 *                 to drain, drains competing engines (e.g. unloads Ollama), then
 *                 hands over the entire budget (time-sharing). Video/image/LoRA use this.
 */
export type LeaseMode = 'shared' | 'exclusive';

/** A request to occupy the GPU. Only `label`, `engine` and `estVramMb` are required. */
export interface LeaseRequest {
  /** Human-readable tag for logs/diagnostics, e.g. "llm.generate:mistral". */
  label: string;
  /** Which engine will do the work: 'ollama' | 'comfyui' | any registered name. */
  engine: string;
  /** Estimated VRAM footprint in MB. Clamped defensively; drives budget admission. */
  estVramMb: number;
  /** Space-share ('shared', default) or take the whole card ('exclusive'). */
  mode?: LeaseMode;
  /** Scheduling urgency (default 'normal'). */
  priority?: LeasePriority;
  /** Max time to wait in the queue before rejecting with a GpuAcquireTimeoutError. */
  acquireTimeoutMs?: number;
  /** Watchdog: auto-release the lease after this long held, so a crashed job
   *  can never deadlock the GPU forever. Defaults from config. */
  maxHoldMs?: number;
  /** Optional cancellation — if it aborts while queued, the acquire rejects. */
  signal?: AbortSignal;
}

/** A granted occupancy token. Always release it (use arbiter.run() to be safe). */
export interface Lease {
  readonly id: string;
  readonly label: string;
  readonly engine: string;
  readonly mode: LeaseMode;
  readonly priority: LeasePriority;
  readonly estVramMb: number;
  /** Epoch ms when the lease was granted. */
  readonly grantedAt: number;
  /** True once released (idempotent). */
  readonly released: boolean;
  /** Release the GPU. Idempotent — calling twice is a safe no-op. */
  release(): void;
}

/**
 * Engine-specific VRAM control. The arbiter calls drain() on OTHER engines
 * before granting an exclusive lease, and restore() after it releases. Both
 * MUST be best-effort and MUST NOT throw (a failure to drain degrades to
 * "run anyway and let the residency monitor catch it", never a crash).
 */
export interface EngineAdapter {
  /** Engine name this adapter controls (matches LeaseRequest.engine). */
  readonly name: string;
  /**
   * Free the VRAM this engine currently holds. Returns MB freed (best-effort
   * estimate; 0 is fine). Must resolve even on error.
   */
  drain(reason: string): Promise<number>;
  /**
   * Return the engine to a warm/ready state after an exclusive job finished.
   * Best-effort; must resolve even on error.
   */
  restore(reason: string): Promise<void>;
}

/** Tunable arbiter policy. All fields have safe defaults in DEFAULT_ARBITER_CONFIG. */
export interface ArbiterConfig {
  /** Usable VRAM budget in MB (card total minus display/CUDA reserve). */
  budgetMb: number;
  /** Headroom always kept free so a grant never pushes the card to the edge. */
  reserveMb: number;
  /** Default queue-wait timeout when a request omits acquireTimeoutMs. */
  defaultAcquireTimeoutMs: number;
  /** Default watchdog hold limit when a request omits maxHoldMs. */
  defaultMaxHoldMs: number;
  /** Every `agingMs` a queued request waits, its effective urgency rises one tier-step. */
  agingMs: number;
  /** Whether to drain competing engines before an exclusive lease (default true). */
  drainOnExclusive: boolean;
}

/** A point-in-time view of arbiter state for diagnostics/health endpoints. */
export interface ArbiterSnapshot {
  budgetMb: number;
  reserveMb: number;
  usableMb: number;
  reservedMb: number;
  freeMb: number;
  exclusiveActive: boolean;
  activeLeases: Array<{
    id: string;
    label: string;
    engine: string;
    mode: LeaseMode;
    priority: LeasePriority;
    estVramMb: number;
    heldMs: number;
  }>;
  queueDepth: number;
  queued: Array<{
    id: string;
    label: string;
    engine: string;
    mode: LeaseMode;
    priority: LeasePriority;
    estVramMb: number;
    waitedMs: number;
  }>;
  drainedEngines: string[];
  totals: {
    granted: number;
    released: number;
    rejectedTimeout: number;
    rejectedAborted: number;
    watchdogReleases: number;
    promotedToExclusive: number;
  };
}
