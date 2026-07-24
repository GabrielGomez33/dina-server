// File: src/modules/auth/authRoutes.ts
// ============================================================================
// DINA AUTH — ROUTE REGISTRATION
// ============================================================================
// Mounts the user-auth endpoints under `<apiPath>/auth/*`. These routes are
// registered BEFORE DINA's service-level `authenticate` middleware, so they are
// reachable by anonymous browsers (you can't hold a service key to log in).
// Endpoints that require an authenticated USER apply `requireAuth` per-route.
//
// Public:   register, login, refresh, check-username, verify-email,
//           forgot-password, reset-password, confirm-email-change
// User:     me, logout, logout-all, resend-verification, change-password,
//           change-email
// ============================================================================

import { Router } from 'express';
import { requireAuth } from './requireAuth';
import * as auth from './authController';

/**
 * Attach auth routes to a router mounted at the API base. Call this after body
 * parsing + CORS are set up but BEFORE the service `authenticate` gate.
 */
export function registerAuthRoutes(router: Router): void {
  const r = Router();

  // ── Public ────────────────────────────────────────────────────────────────
  r.post('/register', auth.register);
  r.post('/login', auth.login);
  r.post('/refresh', auth.refresh);
  r.get('/check-username', auth.checkUsername);
  r.post('/verify-email', auth.verifyEmail);
  r.post('/forgot-password', auth.forgotPassword);
  r.post('/reset-password', auth.resetPassword);
  r.post('/confirm-email-change', auth.confirmEmailChange);

  // ── Authenticated (user JWT + live session) ─────────────────────────────────
  r.get('/me', requireAuth, auth.me);
  r.post('/logout', requireAuth, auth.logout);
  r.post('/logout-all', requireAuth, auth.logoutAll);
  r.post('/resend-verification', requireAuth, auth.resendVerification);
  r.post('/change-password', requireAuth, auth.changePassword);
  r.post('/change-email', requireAuth, auth.changeEmail);

  router.use('/auth', r);
}
