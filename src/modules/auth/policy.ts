// File: src/modules/auth/policy.ts
// ============================================================================
// DINA AUTH — INPUT POLICY (single source of truth)
// ============================================================================
// Normalisation + validation for usernames, emails and passwords. Ported from
// mirror-server's proven rules so DINA behaves identically for accounts that
// live in the SHARED `users` table. Every entry point (register, login,
// change-password) funnels through these functions so the value we validate is
// the exact value we hash — no keyboard/autocorrect drift between platforms.
// ============================================================================

/** Hard upper bound applied to any raw password BEFORE it reaches bcrypt.
 *  bcrypt is O(n) in input length; without a cap a multi-megabyte "password"
 *  becomes a cheap CPU-exhaustion vector. */
export const MAX_PASSWORD_INPUT = 256;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

// RFC-5322-lite. Rejects obvious garbage without false-negatives on real
// addresses; the verification click is the authoritative check.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Usernames: 3–20 chars, letters/numbers/underscore. Matches mirror-server.
export const USERNAME_RE = /^[a-zA-Z0-9_]+$/;

/** Strip all internal whitespace and bound length. Usernames never contain
 *  spaces; iOS auto-period-after-double-space can otherwise sneak one in. */
export function normaliseUsername(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, '').slice(0, 64);
}

/** Trim, drop interior whitespace (autocorrect dust), bound length. Case is
 *  preserved — the SQL collation handles case-insensitive uniqueness. */
export function normaliseEmail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, '').slice(0, 254);
}

/** Unicode-normalise (NFKC folds smart quotes / full-width chars a mobile
 *  keyboard may inject), strip surrounding whitespace, hard-bound length. We do
 *  NOT strip interior spaces — a space can be a legitimate password character. */
export function normalisePassword(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let s = raw;
  try {
    s = s.normalize('NFKC');
  } catch {
    /* normalize can throw only on malformed input we can't fix — use as-is */
  }
  return s.trim().slice(0, MAX_PASSWORD_INPUT);
}

export type Field = 'username' | 'email' | 'password';

export interface PolicyError {
  error: string;
  code: string;
  field: Field;
}

/** 3–20 chars, [a-zA-Z0-9_]. Returns null when valid. */
export function validateUsername(username: string): PolicyError | null {
  if (username.length < 3 || username.length > 20 || !USERNAME_RE.test(username)) {
    return {
      error: 'Username must be 3–20 characters, letters, numbers and underscores only.',
      code: 'INVALID_USERNAME',
      field: 'username',
    };
  }
  return null;
}

/** RFC-lite + length bound. Returns null when valid. */
export function validateEmail(email: string): PolicyError | null {
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { error: 'Please enter a valid email address.', code: 'INVALID_EMAIL', field: 'email' };
  }
  return null;
}

/**
 * Password strength: 8–128 chars with at least one lowercase, uppercase, digit
 * AND one non-alphanumeric, non-whitespace character. Any symbol counts (iOS
 * strong-password hyphens, `_`, `#`, `.` etc.) — the narrow `[@$!%*?&]` set
 * used to reject legitimate strong passwords. Returns null when valid.
 */
export function validatePassword(pw: string): PolicyError | null {
  const weak: PolicyError = {
    error:
      'Password must be 8–128 characters and include uppercase, lowercase, a number, and one symbol.',
    code: 'WEAK_PASSWORD',
    field: 'password',
  };
  if (typeof pw !== 'string') return weak;
  if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) return weak;
  if (!/[a-z]/.test(pw)) return weak;
  if (!/[A-Z]/.test(pw)) return weak;
  if (!/\d/.test(pw)) return weak;
  if (!/[^A-Za-z0-9\s]/.test(pw)) return weak;
  return null;
}
