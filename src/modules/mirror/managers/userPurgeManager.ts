// /src/modules/mirror/managers/userPurgeManager.ts
//
// Purges every Dina-side trace of a Mirror user when their account is
// deleted on mirror-server. This is the "downstream half" of the
// account-deletion pipeline; mirror-server has already removed the user
// from its own DB + filesystem before we get called.
//
// Design notes:
//   - We work off the Mirror userId only (no Dina-side userId mapping is
//     stored separately). All DELETE statements are `WHERE user_id = ?`.
//   - Each table is purged independently. A failure on one table is
//     logged and we continue — orphaned rows on one table do not justify
//     leaving rows in another table un-purged.
//   - Idempotent: re-running this against an already-purged user is a
//     no-op (DELETE WHERE row-not-present returns affectedRows = 0).
//   - Redis: we scan for `mirror:*:<userId>` key patterns and delete in
//     batches, then explicitly drop the well-known per-user keys.
//   - This file is invoked through the Mirror module / DUMP protocol
//     only — there's no direct HTTP surface here. See
//     src/modules/mirror/index.ts::handleUserDeletion and the
//     `mirror_purge_user` orchestrator case.

import { EventEmitter } from 'events';
import { database as DB } from '../../../config/database/db';
import { redisManager } from '../../../config/redis';

// =============================================================================
// TABLE INVENTORY
// =============================================================================
// Every table in the dina-server schema that holds a `user_id` column for a
// Mirror user. Adding a new table elsewhere in the codebase that stores
// per-user rows MUST also be added here, otherwise account deletion leaks.
// Column name override is supported for tables that use a non-default name.

interface PurgeTable {
  table: string;
  column?: string; // defaults to 'user_id'
}

const PURGE_TABLES: ReadonlyArray<PurgeTable> = [
  // Core mirror-module storage
  { table: 'mirror_user_context' },
  { table: 'mirror_user_metadata' },
  { table: 'mirror_user_feedback' },
  { table: 'mirror_submissions' },

  // Per-modality processed snapshots
  { table: 'mirror_facial_analysis' },
  { table: 'mirror_voice_analysis' },
  { table: 'mirror_iq_assessment' },
  { table: 'mirror_astrological_analysis' },
  { table: 'mirror_personality_analysis' },

  // Generated outputs
  { table: 'mirror_generated_insights' },
  { table: 'mirror_generated_questions' },
  { table: 'mirror_cross_modal_patterns' },

  // Notifications + preferences
  { table: 'mirror_notifications' },
  { table: 'user_preferences' },
];

// =============================================================================
// REDIS KEY PATTERNS
// =============================================================================
// Patterns we scan + delete during a purge. Keep this in sync with any
// cache key formatter that includes a userId.

function redisPatternsForUser(userId: string): string[] {
  // Order matters slightly: explicit keys first, then wildcards.
  return [
    `mirror:context:${userId}`,
    `mirror:embeddings:${userId}`,
    `mirror:insights:${userId}`,
    `mirror:notifications:${userId}`,
    `mirror:submission:${userId}:*`,
    `mirror:patterns:${userId}:*`,
    `mirror:*:user:${userId}`,
    `mirror:*:${userId}`,
  ];
}

// =============================================================================
// PURGE RESULT SHAPE
// =============================================================================

export interface PurgeTableResult {
  table: string;
  affectedRows: number;
  ok: boolean;
  error?: string;
}

export interface UserPurgeResult {
  userId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tables: PurgeTableResult[];
  redis: {
    deletedKeys: number;
    scannedPatterns: number;
    errors: string[];
  };
  // True iff every table purge succeeded. Redis errors do not flip this —
  // they're cache, not source of truth.
  allTablesPurged: boolean;
  totalRowsAffected: number;
}

// =============================================================================
// MANAGER
// =============================================================================

export class UserPurgeManager extends EventEmitter {
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // Schema verification is intentionally deferred to first use. We don't
    // want a missing-table error during boot to block the whole module —
    // some environments may not have run every migration yet, and the
    // purge handler degrades gracefully (per-table errors are captured).
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  async healthCheck(): Promise<{ healthy: boolean; status: string }> {
    return { healthy: true, status: 'ready' };
  }

  /**
   * Purge every Dina-side artefact associated with the given Mirror userId.
   * Safe to retry. Returns a structured report; the caller decides what
   * to surface to the user-facing response.
   */
  async purgeUser(userId: string): Promise<UserPurgeResult> {
    const startedAt = new Date();
    const id = String(userId || '').trim();

    const result: UserPurgeResult = {
      userId: id,
      startedAt: startedAt.toISOString(),
      finishedAt: '',
      durationMs: 0,
      tables: [],
      redis: { deletedKeys: 0, scannedPatterns: 0, errors: [] },
      allTablesPurged: true,
      totalRowsAffected: 0,
    };

    if (!id) {
      // Treat as a no-op — but flag failure so the caller doesn't claim
      // success on a malformed request.
      result.allTablesPurged = false;
      const finishedAt = new Date();
      result.finishedAt = finishedAt.toISOString();
      result.durationMs = finishedAt.getTime() - startedAt.getTime();
      return result;
    }

    console.log(`🧹 [UserPurgeManager] Beginning purge for user ${id}`);

    // -----------------------------------------------------------------
    // SQL tables
    // -----------------------------------------------------------------
    for (const entry of PURGE_TABLES) {
      const column = entry.column || 'user_id';
      const sql = `DELETE FROM \`${entry.table}\` WHERE \`${column}\` = ?`;
      try {
        // DinaDatabase.query() returns the OkPacket directly for DML
        // statements (see config/database/db.ts: `const [rows] =
        // await this.pool.execute(...); return rows;`). A prior version
        // of this code destructured `const [res] = await DB.query(...)`
        // which tried to iterate the OkPacket — mysql2's ResultSetHeader
        // is not iterable, so every DELETE threw a TypeError into the
        // catch, was misclassified as a "real" error (not table-missing),
        // and the manager reported `ok=false` + `0 rows` even though the
        // DELETE itself had succeeded server-side. Use the result
        // directly.
        const res: any = await DB.query(sql, [id]);
        const affected = Number(res?.affectedRows ?? 0);
        result.tables.push({ table: entry.table, affectedRows: affected, ok: true });
        result.totalRowsAffected += affected;
      } catch (err: any) {
        const message = err?.message || String(err);
        // Missing-table errors are tolerated — a fresh environment may
        // not have run every migration. Other errors flip allTablesPurged.
        const isMissingTable = typeof message === 'string'
          && /ER_NO_SUCH_TABLE|doesn't exist|does not exist/i.test(message);
        if (isMissingTable) {
          console.warn(`⚠️  [UserPurgeManager] Table ${entry.table} not present in this environment — skipping`);
          result.tables.push({
            table: entry.table,
            affectedRows: 0,
            ok: true,
            error: 'table_not_present',
          });
        } else {
          console.error(`❌ [UserPurgeManager] Failed to purge ${entry.table} for user ${id}:`, message);
          result.tables.push({
            table: entry.table,
            affectedRows: 0,
            ok: false,
            error: message.slice(0, 240),
          });
          result.allTablesPurged = false;
        }
      }
    }

    // -----------------------------------------------------------------
    // Redis cache + per-user keys
    // -----------------------------------------------------------------
    const patterns = redisPatternsForUser(id);
    result.redis.scannedPatterns = patterns.length;

    const client: any = (redisManager as any)?.client;
    if (!client || typeof client.keys !== 'function' || typeof client.del !== 'function') {
      result.redis.errors.push('redis_client_unavailable');
    } else {
      for (const pattern of patterns) {
        try {
          let keys: string[] = [];
          if (pattern.includes('*')) {
            const found = await client.keys(pattern);
            keys = Array.isArray(found) ? found : [];
          } else {
            // Direct key — try a GET first so we don't issue DEL for
            // keys that never existed. Both `exists` and a bare `del`
            // work; we prefer `del` to keep the round-trip minimal.
            keys = [pattern];
          }

          if (keys.length === 0) continue;

          // node-redis v4 accepts del(string | string[])
          const deleted = await client.del(keys);
          const n = Number(deleted ?? 0);
          if (Number.isFinite(n)) result.redis.deletedKeys += n;
        } catch (err: any) {
          const message = err?.message || String(err);
          console.warn(`⚠️  [UserPurgeManager] Redis purge failed for pattern ${pattern}:`, message);
          result.redis.errors.push(`${pattern}: ${message.slice(0, 120)}`);
        }
      }
    }

    const finishedAt = new Date();
    result.finishedAt = finishedAt.toISOString();
    result.durationMs = finishedAt.getTime() - startedAt.getTime();

    this.emit('userPurged', { userId: id, result });
    // Surface enough detail in the one summary line that the operator
    // can tell "0 rows because nothing existed" from "0 rows because
    // something broke". Per-table failures and redis errors both flip
    // a flag visible here.
    const failedTables = result.tables.filter(t => !t.ok).length;
    const redisStatus = result.redis.errors.length === 0
      ? `redis=${result.redis.deletedKeys} keys`
      : `redis=${result.redis.deletedKeys} keys, ${result.redis.errors.length} error(s): ${result.redis.errors.slice(0, 2).join(' | ')}`;
    console.log(
      `🧹 [UserPurgeManager] Finished purge for user ${id}: `
      + `tables=${result.totalRowsAffected} rows across ${result.tables.length} tables`
      + (failedTables > 0 ? ` (${failedTables} failed)` : '')
      + `, ${redisStatus}, `
      + `ok=${result.allTablesPurged}, `
      + `took=${result.durationMs}ms`
    );

    return result;
  }
}

export const userPurgeManager = new UserPurgeManager();
export default userPurgeManager;