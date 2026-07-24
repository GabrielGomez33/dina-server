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
//
// CRITICAL: every handler is wrapped in asyncHandler(). Express 4 does NOT catch
// errors thrown from an async handler — they escape as an unhandled promise
// rejection, which (under DINA's global handler / PM2) can restart the whole
// process. A single misconfigured or malformed auth request must NEVER take down
// the server (DIGIM, Mirror comms, everything). asyncHandler guarantees any
// throw/rejection becomes a clean JSON error on THAT request and nothing more.
// ============================================================================

import { Router, RequestHandler, Request, Response, NextFunction } from 'express';
import { requireAuth } from './requireAuth';
import * as auth from './authController';

type AsyncHandler = (req: Request, res: Response) => Promise<unknown> | unknown;

/**
 * Wrap an async route handler so a thrown error or rejected promise can never
 * escape into an unhandled rejection. On failure it logs and returns a 500 (or
 * 503 for a configuration error) on that single request; the process stays up.
 */
function respondError(req: Request, res: Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[auth] handler error on ${req.method} ${req.originalUrl}:`, msg);
  if (res.headersSent) return;
  // A missing/short secret or other misconfiguration is a 503 (the service is up
  // but not correctly configured); everything else is a generic 500.
  const isConfig = /\[auth\]/.test(msg);
  res.status(isConfig ? 503 : 500).json({
    error: isConfig ? 'Authentication is not configured on the server.' : 'Authentication service error.',
    code: isConfig ? 'AUTH_NOT_CONFIGURED' : 'AUTH_ERROR',
  });
}

export function asyncHandler(fn: AsyncHandler): RequestHandler {
  return (req: Request, res: Response, _next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err: unknown) => respondError(req, res, err));
  };
}

/**
 * Same guarantee as asyncHandler, but for MIDDLEWARE: it forwards `next` so the
 * chain can proceed on success (e.g. requireAuth → the actual handler). A throw
 * or rejection is caught and answered here instead of escaping.
 */
type AsyncMiddleware = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;
export function asyncMiddleware(fn: AsyncMiddleware): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch((err: unknown) => respondError(req, res, err));
  };
}

/**
 * Attach auth routes to a router mounted at the API base. Call this after body
 * parsing + CORS are set up but BEFORE the service `authenticate` gate.
 */
export function registerAuthRoutes(router: Router): void {
  const r = Router();

  // ── Public ────────────────────────────────────────────────────────────────
  r.post('/register', asyncHandler(auth.register));
  r.post('/login', asyncHandler(auth.login));
  r.post('/refresh', asyncHandler(auth.refresh));
  r.get('/check-username', asyncHandler(auth.checkUsername));
  r.post('/verify-email', asyncHandler(auth.verifyEmail));
  r.post('/forgot-password', asyncHandler(auth.forgotPassword));
  r.post('/reset-password', asyncHandler(auth.resetPassword));
  r.post('/confirm-email-change', asyncHandler(auth.confirmEmailChange));

  // ── Authenticated (user JWT + live session) ─────────────────────────────────
  // requireAuth is itself async; wrap it as middleware (forwards `next`) so a DB
  // hiccup during session validation can't escape as an unhandled rejection.
  const guard = asyncMiddleware(requireAuth);
  r.get('/me', guard, asyncHandler(auth.me));
  r.post('/logout', guard, asyncHandler(auth.logout));
  r.post('/logout-all', guard, asyncHandler(auth.logoutAll));
  r.post('/resend-verification', guard, asyncHandler(auth.resendVerification));
  r.post('/change-password', guard, asyncHandler(auth.changePassword));
  r.post('/change-email', guard, asyncHandler(auth.changeEmail));

  router.use('/auth', r);
}
