// File: src/modules/visuals/core/ttlPolicy.ts
// ============================================================================
// DINA VISUALS — TTL / LIFECYCLE POLICY (pure logic)
// ============================================================================
// Encodes the locked per-asset-kind TTL table. The nightly janitor consumes
// pruneDecision(); routes consume ttlExpiryFor() when a row is created. Pure
// functions → every rule is a provable assertion, including the two absolute
// invariants:
//   • promoted exports are NEVER pruned (TTL-immune)
//   • user-input assets (raw refs, audio source) are NEVER auto-pruned
// ============================================================================

export type TtlAssetKind =
  | 'raw_ref' // until project deleted — never auto-prune
  | 'lora' // until manifest superseded + 30d
  | 'gen_image' // 30 days
  | 'gen_video' // 14 days
  | 'gen_lipsync' // 14 days
  | 'export' // forever — TTL-immune
  | 'audio_source' // until project deleted
  | 'audio_stems' // 60 days (cached compute)
  | 'audio_analysis'; // 60 days (cached compute)

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default TTL in ms; null = no automatic expiry. */
export const TTL_TABLE_MS: Record<TtlAssetKind, number | null> = {
  raw_ref: null,
  lora: 30 * DAY_MS, // measured from manifest supersession, not creation
  gen_image: 30 * DAY_MS,
  gen_video: 14 * DAY_MS,
  gen_lipsync: 14 * DAY_MS,
  export: null,
  audio_source: null,
  audio_stems: 60 * DAY_MS,
  audio_analysis: 60 * DAY_MS,
};

/**
 * Compute the ttl_expires_at for a new row. `anchorMs` is the event the TTL
 * counts from (creation time for generations/stems; manifest-supersession time
 * for LoRAs). Returns null for kinds that never auto-expire.
 */
export function ttlExpiryFor(kind: TtlAssetKind, anchorMs: number): Date | null {
  const ttl = TTL_TABLE_MS[kind];
  if (ttl === null || ttl === undefined) return null;
  const anchor = Number.isFinite(anchorMs) ? anchorMs : Date.now();
  return new Date(anchor + ttl);
}

export interface PruneCandidate {
  kind: TtlAssetKind;
  ttlExpiresAt: Date | string | null;
  promoted?: boolean;
  deletedAt?: Date | string | null;
}

export interface PruneDecision {
  prune: boolean;
  reason:
    | 'expired'
    | 'soft-deleted-grace-elapsed'
    | 'not-expired'
    | 'no-ttl'
    | 'promoted-immune'
    | 'invalid-timestamp';
}

/** Soft-deleted rows are recoverable for 30 days, then hard-pruned. */
export const SOFT_DELETE_GRACE_MS = 30 * DAY_MS;

/**
 * The janitor's single decision function for one row at time `nowMs`.
 * Order of precedence (highest first):
 *   1. promoted → NEVER prune (even if soft-deleted TTL rows expired earlier —
 *      a promote is an explicit user act; deletion of exports is manual only).
 *   2. soft-deleted + grace elapsed → prune (hard delete).
 *   3. TTL expired → prune.
 *   4. otherwise keep.
 */
export function pruneDecision(row: PruneCandidate, nowMs: number): PruneDecision {
  if (row.promoted) return { prune: false, reason: 'promoted-immune' };

  if (row.deletedAt) {
    const t = toMs(row.deletedAt);
    if (t === null) return { prune: false, reason: 'invalid-timestamp' };
    if (nowMs - t >= SOFT_DELETE_GRACE_MS) return { prune: true, reason: 'soft-deleted-grace-elapsed' };
    // Within the recovery window — keep, regardless of TTL.
    return { prune: false, reason: 'not-expired' };
  }

  if (row.ttlExpiresAt === null || row.ttlExpiresAt === undefined) {
    return { prune: false, reason: 'no-ttl' };
  }
  const expiry = toMs(row.ttlExpiresAt);
  if (expiry === null) return { prune: false, reason: 'invalid-timestamp' };
  return expiry <= nowMs ? { prune: true, reason: 'expired' } : { prune: false, reason: 'not-expired' };
}

function toMs(value: Date | string): number | null {
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}
