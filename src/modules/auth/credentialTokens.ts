// File: src/modules/auth/credentialTokens.ts
// ============================================================================
// DINA AUTH — CREDENTIAL-FLOW TOKEN STORE
// ============================================================================
// Backs three single-use, short-lived token flows against DINA's own token
// tables (see migrations/004_auth_users.ts). The DESIGN follows mirror-server's
// proven scheme (these are separate tables in DINA's own database):
//
//   email_verification_tokens — plaintext `token` (secret is the user's inbox)
//   password_reset_tokens      — `token_hash` = SHA-256(token); plaintext lives
//                                only in the email. A DB leak can't reset a
//                                password. + ip_address/user_agent forensics.
//   pending_email_changes      — plaintext `token` + the `new_email` to apply.
//
// All tokens are 256-bit random hex. All are single-use: consuming one stamps
// `used_at` and validity requires used_at IS NULL AND expires_at > NOW().
// ============================================================================

import crypto from 'crypto';
import { q } from './authDb';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS = 60 * 60 * 1000; // 1h — reset links are more sensitive
const CHANGE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function randomToken(): string {
  return crypto.randomBytes(32).toString('hex'); // 64 hex chars → CHAR(64)
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function ttlDate(ms: number): Date {
  return new Date(Date.now() + ms);
}

// ── Email verification ──────────────────────────────────────────────────────

/** Issue a verification token. Invalidates the user's prior unused tokens so a
 *  fresh "resend" supersedes stale links. Returns the plaintext token. */
export async function issueEmailVerification(userId: string): Promise<string> {
  const token = randomToken();
  await q(
    'UPDATE email_verification_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
    [userId],
  );
  await q(
    'INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
    [userId, token, ttlDate(VERIFY_TTL_MS)],
  );
  return token;
}

/** Consume a verification token. Returns the user_id on success, else null. */
export async function consumeEmailVerification(token: string): Promise<string | null> {
  if (typeof token !== 'string' || token.length !== 64) return null;
  const rows = await q(
    `SELECT id, user_id FROM email_verification_tokens
     WHERE token = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
    [token],
  );
  const row = Array.isArray(rows) && rows[0];
  if (!row) return null;
  await q('UPDATE email_verification_tokens SET used_at = NOW() WHERE id = ?', [row.id]);
  return String(row.user_id);
}

// ── Password reset ──────────────────────────────────────────────────────────

/** Issue a reset token. Stores only its SHA-256 hash. Invalidates prior unused
 *  reset tokens. Returns the PLAINTEXT token (goes only into the email). */
export async function issuePasswordReset(
  userId: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<string> {
  const token = randomToken();
  await q(
    'UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
    [userId],
  );
  await q(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    [
      userId,
      sha256(token),
      ttlDate(RESET_TTL_MS),
      (ipAddress || '').substring(0, 64) || null,
      (userAgent || '').substring(0, 255) || null,
    ],
  );
  return token;
}

/** Consume a reset token (by hashing the presented plaintext). Returns user_id. */
export async function consumePasswordReset(token: string): Promise<string | null> {
  if (typeof token !== 'string' || token.length !== 64) return null;
  const rows = await q(
    `SELECT id, user_id FROM password_reset_tokens
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
    [sha256(token)],
  );
  const row = Array.isArray(rows) && rows[0];
  if (!row) return null;
  await q('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?', [row.id]);
  return String(row.user_id);
}

// ── Pending email change ────────────────────────────────────────────────────

/** Issue an email-change token bound to the new address. Returns plaintext. */
export async function issueEmailChange(userId: string, newEmail: string): Promise<string> {
  const token = randomToken();
  await q(
    'UPDATE pending_email_changes SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
    [userId],
  );
  await q(
    'INSERT INTO pending_email_changes (user_id, new_email, token, expires_at) VALUES (?, ?, ?, ?)',
    [userId, newEmail, token, ttlDate(CHANGE_TTL_MS)],
  );
  return token;
}

/** Consume an email-change token. Returns {userId, newEmail} on success. */
export async function consumeEmailChange(token: string): Promise<{ userId: string; newEmail: string } | null> {
  if (typeof token !== 'string' || token.length !== 64) return null;
  const rows = await q(
    `SELECT id, user_id, new_email FROM pending_email_changes
     WHERE token = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
    [token],
  );
  const row = Array.isArray(rows) && rows[0];
  if (!row) return null;
  await q('UPDATE pending_email_changes SET used_at = NOW() WHERE id = ?', [row.id]);
  return { userId: String(row.user_id), newEmail: String(row.new_email) };
}
