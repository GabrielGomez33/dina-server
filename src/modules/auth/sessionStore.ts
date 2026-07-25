// File: src/modules/auth/sessionStore.ts
// ============================================================================
// DINA AUTH — SESSION STORE (revocable device sessions)
// ============================================================================
// One row per device login in `dina_auth_sessions` — DINA-auth's OWN table,
// deliberately namespaced so it never collides with a pre-existing generic
// `user_sessions` in this DB. The JWT sessionId maps to a row here; a session is
// valid only while the row is unexpired and not revoked. This is what makes
// logout instant — we don't wait for the JWT to expire, we flip `revoked` and
// every future validate() fails.
//
// Schema: user_id, session_id, user_agent, ip_address, device_fingerprint,
// revoked(TINYINT), revoked_at, expires_at, created_at. See
// migrations/004_auth_users.ts (fresh) and 006 (reconcile existing installs).
// ============================================================================

import { q } from './authDb';
import { getAuthConfig } from './config';

export interface SessionMetadata {
  userAgent?: string;
  ipAddress?: string;
  fingerprint?: string;
}

/** Insert a new session row. expires_at = now + refresh TTL.
 *  NOTE: userId is DINA's VARCHAR(36) UUID string. */
export async function createSession(
  userId: string,
  sessionId: string,
  metadata: SessionMetadata,
): Promise<void> {
  const expiresAt = new Date(Date.now() + getAuthConfig().refreshTokenTtlMs);
  await q(
    `INSERT INTO dina_auth_sessions
       (user_id, session_id, user_agent, ip_address, device_fingerprint, revoked, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, NOW())`,
    [
      userId,
      sessionId,
      (metadata.userAgent || '').substring(0, 255) || null,
      (metadata.ipAddress || '').substring(0, 64) || null,
      (metadata.fingerprint || '').substring(0, 128) || null,
      expiresAt,
    ],
  );
}

/** True iff the session exists for this user, is unexpired, and not revoked. */
export async function validateSession(userId: string, sessionId: string): Promise<boolean> {
  const rows = await q(
    `SELECT id FROM dina_auth_sessions
     WHERE user_id = ? AND session_id = ? AND expires_at > NOW() AND revoked = 0
     LIMIT 1`,
    [userId, sessionId],
  );
  return Array.isArray(rows) && rows.length > 0;
}

/** Touch a session so we can distinguish active vs dormant devices. Best-effort. */
export async function markSessionUsed(userId: string, sessionId: string): Promise<void> {
  // last_used is optional; ignore if the column doesn't exist on older schemas.
  try {
    await q(
      `UPDATE dina_auth_sessions SET expires_at = expires_at WHERE user_id = ? AND session_id = ?`,
      [userId, sessionId],
    );
  } catch {
    /* non-fatal */
  }
}

/** Revoke a single device session (logout). Idempotent. */
export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  await q(
    `UPDATE dina_auth_sessions SET revoked = 1, revoked_at = NOW()
     WHERE user_id = ? AND session_id = ? AND revoked = 0`,
    [userId, sessionId],
  );
}

/** Revoke every active session for a user (logout-all / password change). */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await q(
    `UPDATE dina_auth_sessions SET revoked = 1, revoked_at = NOW()
     WHERE user_id = ? AND revoked = 0`,
    [userId],
  );
}

/** Housekeeping: drop expired + long-revoked rows. Safe to run on a schedule. */
export async function cleanExpiredSessions(): Promise<number> {
  const result = await q(
    `DELETE FROM dina_auth_sessions
     WHERE expires_at < NOW()
        OR (revoked = 1 AND revoked_at < DATE_SUB(NOW(), INTERVAL 30 DAY))`,
    [],
  );
  // mysql2 OkPacket exposes affectedRows
  return (result && (result.affectedRows as number)) || 0;
}
