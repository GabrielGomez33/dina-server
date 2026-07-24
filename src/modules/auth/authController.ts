// File: src/modules/auth/authController.ts
// ============================================================================
// DINA AUTH — HTTP HANDLERS
// ============================================================================
// Express handlers for the DINA console's user authentication. Ports the
// security-relevant behaviour of mirror-server's authController while dropping
// its app-specific plumbing (paywall tiers, tier-file writes, cross-service
// purge calls). Security properties preserved:
//   - Two-token JWT model with DB-backed revocable sessions.
//   - bcrypt with length caps BEFORE hashing/compare (CPU-exhaustion guard).
//   - Constant-ish login time: a dummy bcrypt.compare runs on user-not-found so
//     timing can't distinguish "no such account" from "wrong password".
//   - Unicode-normalised, whitespace-bounded credentials (single source: policy).
//   - No user enumeration on forgot-password (always 200) or on login errors.
//   - Rate limiting on login / register / forgot-password.
// ============================================================================

import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getAuthConfig } from './config';
import {
  normaliseUsername,
  normaliseEmail,
  normalisePassword,
  validateUsername,
  validateEmail,
  validatePassword,
  MAX_PASSWORD_INPUT,
} from './policy';
import {
  createAccessToken,
  createRefreshToken,
  generateSessionId,
  verifyRefreshToken,
} from './tokens';
import { createSession, revokeSession, revokeAllUserSessions, validateSession } from './sessionStore';
import {
  createUser,
  findByEmail,
  findById,
  usernameExists,
  updateLastLogin,
  updatePassword,
  markEmailVerified,
  applyEmailChange,
  isLocked,
  emailExists,
  DuplicateUserError,
  AuthUserRow,
} from './userStore';
import {
  issueEmailVerification,
  consumeEmailVerification,
  issuePasswordReset,
  consumePasswordReset,
  issueEmailChange,
  consumeEmailChange,
} from './credentialTokens';
import { sendVerificationEmail, sendPasswordResetEmail, sendEmailChangeEmail } from './emailService';
import { AuthedRequest } from './requireAuth';
import { hit } from './rateLimit';

// ── Timing-attack defense ────────────────────────────────────────────────────
// A precomputed hash to compare against when the account doesn't exist, so the
// not-found path spends the same ~bcrypt time as the wrong-password path.
const DUMMY_HASH_PROMISE: Promise<string> = bcrypt.hash('dummy-password-for-timing-defense', 12);
DUMMY_HASH_PROMISE.catch((e) => console.error('[auth] failed to precompute dummy hash:', e));

function clientIp(req: Request): string {
  const xf = (req.headers['x-forwarded-for'] as string) || '';
  const first = xf.split(',')[0].trim();
  return (first || req.ip || req.socket?.remoteAddress || 'unknown').replace('::ffff:', '');
}

function userAgent(req: Request): string {
  return (req.headers['user-agent'] as string) || 'Unknown';
}

/** The public shape of a user returned to the client — never the password hash. */
function publicUser(u: { id: string; username: string; email: string; role: string; email_verified: number }) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    emailVerified: Boolean(u.email_verified),
  };
}

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

/** Create a session row + sign both tokens for a freshly authenticated user. */
async function issueSession(req: Request, user: AuthUserRow, deviceFingerprint?: string): Promise<IssuedTokens> {
  const sessionId = generateSessionId();
  await createSession(user.id, sessionId, {
    userAgent: userAgent(req),
    ipAddress: clientIp(req),
    fingerprint: deviceFingerprint,
  });
  const accessToken = createAccessToken({
    id: user.id,
    email: user.email,
    username: user.username,
    sessionId,
  });
  const refreshToken = createRefreshToken({ id: user.id, sessionId });
  return { accessToken, refreshToken, sessionId };
}

// ── register ─────────────────────────────────────────────────────────────────

export async function register(req: Request, res: Response): Promise<void> {
  getAuthConfig(); // fail fast on missing secrets
  const ip = clientIp(req);
  const rl = hit(`register:${ip}`, 10, 60 * 60 * 1000); // 10/hour/IP
  if (!rl.allowed) {
    res.status(429).json({ error: 'Too many sign-ups. Try again later.', code: 'RATE_LIMITED', retryAfter: rl.retryAfterSec });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = normaliseUsername(body.username);
  const email = normaliseEmail(body.email);
  const password = normalisePassword(body.password);
  const deviceFingerprint = typeof body.deviceFingerprint === 'string' ? body.deviceFingerprint : undefined;

  if (!username || !email || !password) {
    const field = !username ? 'username' : !email ? 'email' : 'password';
    res.status(400).json({ error: 'All fields are required.', code: 'MISSING_FIELDS', field });
    return;
  }
  for (const err of [validateUsername(username), validateEmail(email), validatePassword(password)]) {
    if (err) {
      res.status(400).json(err);
      return;
    }
  }

  try {
    const userId = await createUser(username, email, password);
    const user = await findById(userId);
    if (!user) throw new Error('user vanished immediately after creation');

    const tokens = await issueSession(req, user, deviceFingerprint);

    // Best-effort verification email — never blocks registration.
    try {
      const token = await issueEmailVerification(userId);
      await sendVerificationEmail(email, username, token);
    } catch (e) {
      console.error('[auth] verification email dispatch failed (non-fatal):', e instanceof Error ? e.message : e);
    }

    res.status(201).json({
      message: 'Account created.',
      user: publicUser(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (err) {
    if (err instanceof DuplicateUserError) {
      const msg = err.code === 'USERNAME_TAKEN' ? 'That username is taken.' : 'That email is already registered.';
      res.status(409).json({ error: msg, code: err.code, field: err.field });
      return;
    }
    // UNIQUE race fallback (1062) → same friendly message.
    if (err && typeof err === 'object' && (err as { code?: string }).code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: 'That username or email is already registered.', code: 'DUPLICATE', field: 'email' });
      return;
    }
    console.error('[auth] register error:', err);
    res.status(500).json({ error: 'Could not create account.', code: 'REGISTER_FAILED' });
  }
}

// ── login ──────────────────────────────────────────────────────────────────

export async function login(req: Request, res: Response): Promise<void> {
  getAuthConfig();
  const ip = clientIp(req);
  const rl = hit(`login:${ip}`, 20, 15 * 60 * 1000); // 20 per 15 min per IP
  if (!rl.allowed) {
    res.status(429).json({ error: 'Too many attempts. Try again later.', code: 'RATE_LIMITED', retryAfter: rl.retryAfterSec });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const email = normaliseEmail(body.email ?? body.identifier);
  const rawPassword = typeof body.password === 'string' ? body.password : '';
  const deviceFingerprint = typeof body.deviceFingerprint === 'string' ? body.deviceFingerprint : undefined;

  // Hard cap BEFORE bcrypt.compare — huge inputs must not grind the CPU.
  if (!email || !rawPassword || rawPassword.length > MAX_PASSWORD_INPUT * 4) {
    res.status(400).json({ error: 'Email and password are required.', code: 'MISSING_CREDENTIALS' });
    return;
  }
  const password = normalisePassword(rawPassword);

  try {
    const user = await findByEmail(email);

    if (!user) {
      // Spend equivalent time so timing can't reveal that the account is absent.
      const dummy = await DUMMY_HASH_PROMISE;
      await bcrypt.compare(password, dummy).catch(() => false);
      res.status(401).json({ error: 'Invalid email or password.', code: 'INVALID_CREDENTIALS' });
      return;
    }

    if (isLocked(user)) {
      res.status(403).json({ error: 'Account is locked. Contact support.', code: 'ACCOUNT_LOCKED' });
      return;
    }

    let ok = false;
    try {
      ok = await bcrypt.compare(password, user.password_hash || '');
    } catch {
      ok = false;
    }
    // Retry once against the raw (un-normalised) password for accounts created
    // before NFKC normalisation — matches mirror-server's compatibility path.
    if (!ok && password !== rawPassword) {
      try {
        ok = await bcrypt.compare(rawPassword.slice(0, MAX_PASSWORD_INPUT), user.password_hash || '');
      } catch {
        ok = false;
      }
    }

    if (!ok) {
      res.status(401).json({ error: 'Invalid email or password.', code: 'INVALID_CREDENTIALS' });
      return;
    }

    const tokens = await issueSession(req, user, deviceFingerprint);
    await updateLastLogin(user.id);

    res.status(200).json({
      message: 'Logged in.',
      user: publicUser(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (err) {
    console.error('[auth] login error:', err);
    res.status(500).json({ error: 'Login failed.', code: 'LOGIN_FAILED' });
  }
}

// ── refresh ──────────────────────────────────────────────────────────────────

export async function refresh(req: Request, res: Response): Promise<void> {
  getAuthConfig();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = typeof body.refreshToken === 'string' ? body.refreshToken : '';
  if (!token) {
    res.status(400).json({ error: 'Refresh token required.', code: 'MISSING_REFRESH_TOKEN' });
    return;
  }
  try {
    const payload = verifyRefreshToken(token);
    const live = await validateSession(payload.id, payload.sessionId);
    if (!live) {
      res.status(401).json({ error: 'Session expired or revoked.', code: 'INVALID_SESSION' });
      return;
    }
    const user = await findById(payload.id);
    if (!user) {
      res.status(401).json({ error: 'User not found.', code: 'USER_NOT_FOUND' });
      return;
    }
    const accessToken = createAccessToken({
      id: user.id,
      email: user.email,
      username: user.username,
      sessionId: payload.sessionId,
    });
    res.status(200).json({ accessToken, expiresIn: 900 });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token.', code: 'INVALID_REFRESH_TOKEN' });
  }
}

// ── logout / logout-all ──────────────────────────────────────────────────────

export async function logout(req: AuthedRequest, res: Response): Promise<void> {
  try {
    if (req.authUser) await revokeSession(req.authUser.id, req.authUser.sessionId);
    res.status(200).json({ message: 'Logged out.' });
  } catch (err) {
    console.error('[auth] logout error:', err);
    res.status(200).json({ message: 'Logged out.' }); // never block logout on a DB hiccup
  }
}

export async function logoutAll(req: AuthedRequest, res: Response): Promise<void> {
  try {
    if (req.authUser) await revokeAllUserSessions(req.authUser.id);
    res.status(200).json({ message: 'Logged out from all devices.' });
  } catch (err) {
    console.error('[auth] logout-all error:', err);
    res.status(500).json({ error: 'Failed to log out everywhere.', code: 'LOGOUT_ALL_FAILED' });
  }
}

// ── me (current user) ────────────────────────────────────────────────────────

export async function me(req: AuthedRequest, res: Response): Promise<void> {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required.', code: 'NO_AUTH' });
    return;
  }
  const user = await findById(req.authUser.id);
  if (!user) {
    res.status(401).json({ error: 'User not found.', code: 'USER_NOT_FOUND' });
    return;
  }
  res.status(200).json({ user: publicUser(user) });
}

// ── check-username (availability) ────────────────────────────────────────────

export async function checkUsername(req: Request, res: Response): Promise<void> {
  const raw = (req.query.username ?? req.query.u) as unknown;
  const username = normaliseUsername(raw);
  const invalid = validateUsername(username);
  if (invalid) {
    res.status(200).json({ available: false, reason: invalid.code });
    return;
  }
  try {
    const taken = await usernameExists(username);
    res.status(200).json({ available: !taken });
  } catch {
    res.status(200).json({ available: false, reason: 'CHECK_FAILED' });
  }
}

// ── email verification ───────────────────────────────────────────────────────

export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = typeof body.token === 'string' ? body.token : (req.query.token as string) || '';
  const userId = await consumeEmailVerification(token);
  if (!userId) {
    res.status(400).json({ error: 'This verification link is invalid or has expired.', code: 'INVALID_TOKEN' });
    return;
  }
  await markEmailVerified(userId);
  res.status(200).json({ message: 'Email verified.' });
}

export async function resendVerification(req: AuthedRequest, res: Response): Promise<void> {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required.', code: 'NO_AUTH' });
    return;
  }
  const rl = hit(`resend:${req.authUser.id}`, 5, 60 * 60 * 1000);
  if (!rl.allowed) {
    res.status(429).json({ error: 'Too many requests.', code: 'RATE_LIMITED', retryAfter: rl.retryAfterSec });
    return;
  }
  const user = await findById(req.authUser.id);
  if (!user) {
    res.status(401).json({ error: 'User not found.', code: 'USER_NOT_FOUND' });
    return;
  }
  if (user.email_verified) {
    res.status(200).json({ message: 'Email already verified.' });
    return;
  }
  const token = await issueEmailVerification(user.id);
  await sendVerificationEmail(user.email, user.username, token);
  res.status(200).json({ message: 'Verification email sent.' });
}

// ── forgot / reset password ──────────────────────────────────────────────────

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  getAuthConfig();
  const ip = clientIp(req);
  const rl = hit(`forgot:${ip}`, 5, 60 * 60 * 1000);
  // Always answer 200 with the same body — never reveal whether the email exists.
  const genericOk = () =>
    res.status(200).json({ message: 'If an account exists for that email, a reset link is on its way.' });

  if (!rl.allowed) {
    genericOk();
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const email = normaliseEmail(body.email);
  if (!email || validateEmail(email)) {
    genericOk();
    return;
  }
  try {
    const user = await findByEmail(email);
    if (user && !isLocked(user)) {
      const token = await issuePasswordReset(user.id, ip, userAgent(req));
      await sendPasswordResetEmail(user.email, user.username, token);
    }
  } catch (err) {
    console.error('[auth] forgot-password error (suppressed to client):', err);
  }
  genericOk();
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  getAuthConfig();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = typeof body.token === 'string' ? body.token : '';
  const newPassword = normalisePassword(body.password ?? body.newPassword);

  if (!token) {
    res.status(400).json({ error: 'Reset token required.', code: 'MISSING_TOKEN' });
    return;
  }
  const weak = validatePassword(newPassword);
  if (weak) {
    res.status(400).json(weak);
    return;
  }
  const userId = await consumePasswordReset(token);
  if (!userId) {
    res.status(400).json({ error: 'This reset link is invalid or has expired.', code: 'INVALID_TOKEN' });
    return;
  }
  await updatePassword(userId, newPassword);
  // Security: a password reset logs the user out everywhere.
  await revokeAllUserSessions(userId);
  res.status(200).json({ message: 'Password updated. Please sign in with your new password.' });
}

// ── change password (authenticated) ──────────────────────────────────────────

export async function changePassword(req: AuthedRequest, res: Response): Promise<void> {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required.', code: 'NO_AUTH' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const currentPassword = normalisePassword(body.currentPassword);
  const rawCurrent = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = normalisePassword(body.newPassword ?? body.password);

  if (!currentPassword) {
    res.status(400).json({ error: 'Current password is required.', code: 'PASSWORD_REQUIRED' });
    return;
  }
  const weak = validatePassword(newPassword);
  if (weak) {
    res.status(400).json(weak);
    return;
  }

  const user = await findById(req.authUser.id);
  if (!user) {
    res.status(401).json({ error: 'User not found.', code: 'USER_NOT_FOUND' });
    return;
  }

  let ok = false;
  try {
    ok = await bcrypt.compare(currentPassword, user.password_hash);
  } catch {
    ok = false;
  }
  if (!ok && currentPassword !== rawCurrent) {
    try {
      ok = await bcrypt.compare(rawCurrent.slice(0, MAX_PASSWORD_INPUT), user.password_hash);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    res.status(401).json({ error: 'Current password is incorrect.', code: 'INVALID_CREDENTIALS' });
    return;
  }

  await updatePassword(user.id, newPassword);
  // Keep the current session alive; drop every OTHER device.
  await revokeAllUserSessions(user.id);
  const tokens = await issueSession(req, { ...user, email: user.email });
  res.status(200).json({
    message: 'Password changed.',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });
}

// ── change email (authenticated, re-verify model) ────────────────────────────

export async function changeEmail(req: AuthedRequest, res: Response): Promise<void> {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required.', code: 'NO_AUTH' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const newEmail = normaliseEmail(body.newEmail ?? body.email);
  const currentPassword = normalisePassword(body.currentPassword);
  const rawCurrent = typeof body.currentPassword === 'string' ? body.currentPassword : '';

  const emailErr = validateEmail(newEmail);
  if (emailErr) {
    res.status(400).json(emailErr);
    return;
  }
  if (!currentPassword) {
    res.status(400).json({ error: 'Current password is required.', code: 'PASSWORD_REQUIRED' });
    return;
  }

  const user = await findById(req.authUser.id);
  if (!user) {
    res.status(401).json({ error: 'User not found.', code: 'USER_NOT_FOUND' });
    return;
  }

  let ok = false;
  try {
    ok = await bcrypt.compare(currentPassword, user.password_hash);
  } catch {
    ok = false;
  }
  if (!ok && currentPassword !== rawCurrent) {
    try {
      ok = await bcrypt.compare(rawCurrent.slice(0, MAX_PASSWORD_INPUT), user.password_hash);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    res.status(401).json({ error: 'Current password is incorrect.', code: 'INVALID_CREDENTIALS' });
    return;
  }

  if (await emailExists(newEmail)) {
    // Don't reveal ownership: generic conflict.
    res.status(409).json({ error: 'That email cannot be used.', code: 'EMAIL_UNAVAILABLE', field: 'email' });
    return;
  }

  const token = await issueEmailChange(user.id, newEmail);
  await sendEmailChangeEmail(newEmail, user.username, token);
  res.status(200).json({ message: 'Confirmation sent to the new address.' });
}

export async function confirmEmailChange(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = typeof body.token === 'string' ? body.token : (req.query.token as string) || '';
  const result = await consumeEmailChange(token);
  if (!result) {
    res.status(400).json({ error: 'This confirmation link is invalid or has expired.', code: 'INVALID_TOKEN' });
    return;
  }
  // Final race guard: the address may have been claimed since the request.
  if (await emailExists(result.newEmail)) {
    res.status(409).json({ error: 'That email is no longer available.', code: 'EMAIL_UNAVAILABLE' });
    return;
  }
  await applyEmailChange(result.userId, result.newEmail);
  res.status(200).json({ message: 'Email updated.' });
}
