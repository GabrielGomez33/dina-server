// File: src/modules/auth/userStore.ts
// ============================================================================
// DINA AUTH — USER STORE (DINA's own `users` table)
// ============================================================================
// This is DINA's OWN table in the `dina` database (NOT shared with Mirror —
// Mirror has its own `mirror` DB). Real shape (src/config/database/db.ts):
//   id VARCHAR(36) PK DEFAULT (UUID()), email UNIQUE, username, password_hash,
//   salt, last_login, failed_login_attempts, locked_until, is_active,
//   security_clearance ENUM(...)  + email_verified/role added by migration 004.
// Ids are UUID strings. Lock state = is_active OR locked_until (no
// account_locked column). We never SELECT * into responses — callers pick
// explicit fields.
// ============================================================================

import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { q } from './authDb';
import { getAuthConfig } from './config';

export interface AuthUserRow {
  id: string; // VARCHAR(36) UUID
  username: string;
  email: string;
  password_hash: string;
  email_verified: number; // 0 | 1
  is_active: number; // 0 | 1
  locked_until: Date | null;
  role: string;
}

const SELECT_COLS =
  'id, username, email, password_hash, email_verified, is_active, locked_until, role';

function firstRow<T>(rows: unknown): T | null {
  return Array.isArray(rows) && rows.length > 0 ? (rows[0] as T) : null;
}

export async function findByEmail(email: string): Promise<AuthUserRow | null> {
  const rows = await q(
    `SELECT ${SELECT_COLS} FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`,
    [email],
  );
  return firstRow<AuthUserRow>(rows);
}

export async function findByUsername(username: string): Promise<AuthUserRow | null> {
  const rows = await q(
    `SELECT ${SELECT_COLS} FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1`,
    [username],
  );
  return firstRow<AuthUserRow>(rows);
}

export async function findById(id: string): Promise<AuthUserRow | null> {
  const rows = await q(`SELECT ${SELECT_COLS} FROM users WHERE id = ? LIMIT 1`, [id]);
  return firstRow<AuthUserRow>(rows);
}

export async function emailExists(email: string): Promise<boolean> {
  const rows = await q('SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1', [email]);
  return Array.isArray(rows) && rows.length > 0;
}

export async function usernameExists(username: string): Promise<boolean> {
  const rows = await q('SELECT id FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1', [username]);
  return Array.isArray(rows) && rows.length > 0;
}

export class DuplicateUserError extends Error {
  constructor(public code: 'USERNAME_TAKEN' | 'EMAIL_ALREADY_REGISTERED', public field: 'username' | 'email') {
    super(code);
    this.name = 'DuplicateUserError';
  }
}

/**
 * Hash the password and INSERT a new account. Generates the UUID id explicitly
 * (rather than relying on the column DEFAULT) so we can return it without a
 * follow-up SELECT. Pre-checks duplicates for precise field errors; the UNIQUE
 * email index is the ultimate race guard (1062 → same friendly error).
 * @returns the new user's UUID id.
 */
export async function createUser(username: string, email: string, plaintextPassword: string): Promise<string> {
  if (await usernameExists(username)) throw new DuplicateUserError('USERNAME_TAKEN', 'username');
  if (await emailExists(email)) throw new DuplicateUserError('EMAIL_ALREADY_REGISTERED', 'email');

  const id = uuidv4();
  const hash = await bcrypt.hash(plaintextPassword, getAuthConfig().bcryptRounds);
  await q(
    'INSERT INTO users (id, username, email, password_hash, is_active, email_verified) VALUES (?, ?, ?, ?, 1, 0)',
    [id, username, email, hash],
  );
  return id;
}

/** Stamp last_login (best-effort; login should not fail if this does). */
export async function updateLastLogin(userId: string): Promise<void> {
  try {
    await q('UPDATE users SET last_login = NOW() WHERE id = ?', [userId]);
  } catch {
    /* non-fatal */
  }
}

/** Replace the password hash (used by change-password and reset-password). */
export async function updatePassword(userId: string, plaintextPassword: string): Promise<void> {
  const hash = await bcrypt.hash(plaintextPassword, getAuthConfig().bcryptRounds);
  await q('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
}

/** Mark an email verified (used by verify-email and confirm-email-change). */
export async function markEmailVerified(userId: string): Promise<void> {
  await q('UPDATE users SET email_verified = 1 WHERE id = ?', [userId]);
}

/** Apply a confirmed email change and re-mark verified (the click proves it). */
export async function applyEmailChange(userId: string, newEmail: string): Promise<void> {
  await q('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?', [newEmail, userId]);
}

/** True if the account cannot currently sign in: deactivated (is_active = 0) or
 *  under a temporary lock (locked_until still in the future). DINA's `users`
 *  table has no `account_locked` flag — these two columns encode lock state. */
export function isLocked(user: AuthUserRow): boolean {
  if (!user.is_active) return true;
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) return true;
  return false;
}
