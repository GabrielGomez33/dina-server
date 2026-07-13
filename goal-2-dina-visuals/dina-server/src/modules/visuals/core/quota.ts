// File: src/modules/visuals/core/quota.ts
// ============================================================================
// DINA VISUALS — QUOTA MATH (pure logic)
// ============================================================================
// Per-tenant byte quotas by plan tier, enforced BEFORE a job is enqueued
// (fail fast, not after a 10-minute render). Pure functions → provable in the
// hermetic harness: admission is monotone, never negative, overflow-safe, and
// a write that would exceed the ceiling is refused with the exact shortfall.
// ============================================================================

import { PlanTier } from '../types';

/** Default quota ceilings per plan (bytes). Env-overridable at module init. */
export const DEFAULT_PLAN_QUOTA_BYTES: Record<PlanTier, number> = {
  free: 25 * 1024 ** 3, // 25 GB
  pro: 500 * 1024 ** 3, // 500 GB
  admin: 3.5 * 1024 ** 4, // 3.5 TB (the 4TB SSD minus models/tmp headroom)
};

export interface QuotaDecision {
  allowed: boolean;
  /** Bytes that would be used after the write. */
  projectedBytes: number;
  /** Ceiling applied. */
  quotaBytes: number;
  /** When refused: how many bytes over the ceiling the write would land. */
  shortfallBytes: number;
  /** 0..1 utilisation after the write (capped at reporting bounds). */
  projectedUtilisation: number;
}

/** Coerce arbitrary input into a safe non-negative finite byte count. */
export function safeBytes(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  // Guard against numbers beyond MAX_SAFE_INTEGER corrupting arithmetic.
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
}

/**
 * Decide whether a write of `incomingBytes` is admitted for a tenant currently
 * using `usedBytes` of a `quotaBytes` ceiling. Pure; never throws.
 */
export function admitWrite(usedBytes: unknown, incomingBytes: unknown, quotaBytes: unknown): QuotaDecision {
  const used = safeBytes(usedBytes);
  const incoming = safeBytes(incomingBytes);
  const quota = safeBytes(quotaBytes);

  // Saturating add — two huge values can't wrap into a small projected total.
  const projected = used + incoming > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : used + incoming;

  const allowed = quota > 0 && projected <= quota;
  return {
    allowed,
    projectedBytes: projected,
    quotaBytes: quota,
    shortfallBytes: allowed ? 0 : Math.max(0, projected - quota),
    projectedUtilisation: quota > 0 ? Math.min(1, projected / quota) : 1,
  };
}

/**
 * Apply a byte delta to a usage counter (writes add, deletions subtract).
 * Clamps at 0 so double-deletes can never drive usage negative.
 */
export function applyUsageDelta(currentBytes: unknown, deltaBytes: number): number {
  const current = safeBytes(currentBytes);
  const d = Number.isFinite(deltaBytes) ? Math.floor(deltaBytes) : 0;
  const next = current + d;
  if (next < 0) return 0;
  return Math.min(next, Number.MAX_SAFE_INTEGER);
}

/** Resolve a tenant's quota ceiling: explicit column value wins; else plan default. */
export function resolveQuota(plan: PlanTier, explicitQuotaBytes?: unknown): number {
  const explicit = safeBytes(explicitQuotaBytes);
  if (explicit > 0) return explicit;
  return DEFAULT_PLAN_QUOTA_BYTES[plan] ?? DEFAULT_PLAN_QUOTA_BYTES.free;
}
