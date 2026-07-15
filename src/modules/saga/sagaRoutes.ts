// File: src/modules/saga/sagaRoutes.ts
// ============================================================================
// DINA SAGA ROUTES — HTTP → DUMP boundary
// ============================================================================
// Follows the proven truthStreamRoutes.ts pattern EXACTLY:
//   • dependencies (DinaCore, createDinaMessage, trust-level mapper) are
//     INJECTED — this file imports nothing across module boundaries
//   • every request: auth → validate → createDinaMessage → dina.handleIncomingMessage
//     → extract from the DUMP double-wrap → safeJsonResponse
//   • so every saga call gets the orchestrator's audit logging, protocol
//     validation, sanitization, QoS and error isolation for free.
//
// URL surface (mounted under the existing /dina base):
//   POST   /saga/tenants
//   POST   /saga/:tenantId/projects
//   GET    /saga/:tenantId/projects/:projectId
//   DELETE /saga/:tenantId/projects/:projectId
//   POST   /saga/:tenantId/projects/:projectId/generate/image
//   POST   /saga/:tenantId/projects/:projectId/generate/video
//   POST   /saga/:tenantId/projects/:projectId/generate/music-video
//   POST   /saga/:tenantId/projects/:projectId/training/lora
//   POST   /saga/:tenantId/projects/:projectId/audio/:trackId/analyze
//   GET    /saga/:tenantId/jobs/:jobId
//   DELETE /saga/:tenantId/jobs/:jobId
//   POST   /saga/:tenantId/projects/:projectId/generations/:genId/promote
//   GET    /saga/status
// ============================================================================

import { Request, Response, Router } from 'express';

// ---- injected dependency shapes (structural, like truthStreamRoutes) ----------

interface DinaInstance {
  handleIncomingMessage(message: any): Promise<any>;
}

type CreateDinaMessageFn = (params: {
  source: { module: string; version: string };
  target: { module: string; method: string; priority: number };
  security: { user_id: string; session_id?: string; clearance: any; sanitized: boolean };
  payload: Record<string, any>;
}) => any;

type MapTrustLevelFn = (trustLevel: string) => any;

/** Minimal structural view of the security middleware's request augmentation. */
interface AuthedRequest extends Request {
  dina?: { dina_key?: string; trust_level?: string; session_id?: string };
}

// ---- helpers (same battle-tested shapes as truthStreamRoutes) -----------------

function safeJsonResponse(res: Response, statusCode: number, body: Record<string, any>): void {
  try {
    if (!res.headersSent) {
      res.status(statusCode).json(body);
    } else {
      console.warn('[Saga] Response already sent, skipping duplicate response');
    }
  } catch (e: any) {
    console.error('[Saga] Error sending response:', e.message);
  }
}

export interface SagaResult {
  success: boolean;
  data?: any;
  error?: { code: string; message: string };
}

/**
 * Extract the SagaHandlerResult the module returned from the orchestrator's
 * envelope.
 *
 * IMPORTANT — SAGA differs from the mirror pattern: mirror handlers return a
 * full `createDinaResponse` (so the value carries a `.status`), which the
 * orchestrator then wraps a SECOND time. SAGA handlers instead return a plain
 * `{ success, data|error }` (`SagaHandlerResult`), which the orchestrator wraps
 * ONCE — so it lands verbatim at `response.payload.data`. This function reads
 * that single-wrap shape (the old copy-from-mirror version looked for
 * `inner.status` and mis-classified every SAGA response as an error → HTTP 500).
 */
export function extractSagaResult(response: any): SagaResult {
  // Orchestrator-level failure (protocol invalid, handler threw past its own
  // try/catch, recursion guard, …): handleIncomingMessage sets status:'error'.
  if (response?.status === 'error') {
    return {
      success: false,
      error: { code: 'PROCESSING_ERROR', message: response?.error?.message || 'Processing error' },
    };
  }
  const inner = response?.payload?.data;
  // Normal path: inner IS the SagaHandlerResult the module returned.
  if (inner && typeof inner.success === 'boolean') {
    return inner as SagaResult;
  }
  // Defensive: an envelope shape we don't recognise is a server-side fault.
  return { success: false, error: { code: 'INTERNAL', message: 'Unexpected response shape from orchestrator' } };
}

/** Map a saga handler error code to an HTTP status (uniform, predictable API). */
export function httpStatusFor(code: string): number {
  switch (code) {
    case 'INVALID_REQUEST':
      return 400;
    case 'NO_AUTH':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'NOT_CANCELLABLE':
      return 409;
    case 'QUOTA_EXCEEDED':
      return 413;
    case 'MODULE_NOT_READY':
      return 503;
    default:
      return 500;
  }
}

// ---- registration --------------------------------------------------------------

export function registerSagaRoutes(
  apiRouter: Router,
  dina: DinaInstance,
  createDinaMessage: CreateDinaMessageFn,
  mapTrustLevelToSecurityLevel: MapTrustLevelFn,
): void {
  console.log('[Saga] Registering saga routes (DUMP protocol)...');

  /** One uniform dispatcher: auth → DUMP → unwrap → HTTP. Every route uses it. */
  async function dispatch(req: AuthedRequest, res: Response, method: string, data: Record<string, any>, priority = 5): Promise<void> {
    try {
      const userId = req.dina?.dina_key;
      if (!userId) {
        safeJsonResponse(res, 401, { success: false, error: 'Authentication required', code: 'NO_AUTH' });
        return;
      }

      const message = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'saga', method, priority },
        security: {
          user_id: userId,
          session_id: req.dina?.session_id,
          clearance: mapTrustLevelToSecurityLevel(req.dina?.trust_level || 'new'),
          sanitized: false, // orchestrator sanitizes; we do not pre-claim it
        },
        payload: data,
      });

      const response = await dina.handleIncomingMessage(message);
      const result = extractSagaResult(response);

      if (!result.success) {
        const code = result.error?.code || 'INTERNAL';
        safeJsonResponse(res, httpStatusFor(code), {
          success: false,
          error: result.error?.message || 'Request failed',
          code,
        });
        return;
      }
      safeJsonResponse(res, 200, { success: true, data: result.data });
    } catch (e: any) {
      console.error(`[Saga] ${method} route error:`, e.message);
      safeJsonResponse(res, 500, { success: false, error: 'Internal error', code: 'INTERNAL' });
    }
  }

  // ---- tenancy / projects ----
  apiRouter.post('/saga/tenants', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'saga_create_tenant', {
      name: req.body?.name,
      slug: req.body?.slug,
      plan: req.body?.plan,
    }),
  );

  apiRouter.post('/saga/:tenantId/projects', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'saga_create_project', {
      tenantId: req.params.tenantId,
      slug: req.body?.slug,
    }),
  );

  apiRouter.get('/saga/:tenantId/projects/:projectId', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'saga_get_project', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
    }),
  );

  apiRouter.delete('/saga/:tenantId/projects/:projectId', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'saga_delete_project', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
    }),
  );

  // ---- generation (validate + enqueue; worker holds the GPU lease) ----
  apiRouter.post('/saga/:tenantId/projects/:projectId/generate/image', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'saga_generate_image', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      params: req.body?.params ?? {},
    }, 6),
  );

  apiRouter.post('/saga/:tenantId/projects/:projectId/generate/video', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'saga_generate_video', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      params: req.body?.params ?? {},
    }, 4),
  );

  apiRouter.post('/saga/:tenantId/projects/:projectId/generate/music-video', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'saga_generate_music_video', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      audioTrackId: req.body?.audioTrackId,
      modes: req.body?.modes ?? { beatSync: true, lyricSync: false, lipSync: false },
      params: req.body?.params ?? {},
    }, 4),
  );

  apiRouter.post('/saga/:tenantId/projects/:projectId/training/lora', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'saga_train_lora', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      manifestId: req.body?.manifestId,
    }, 3),
  );

  apiRouter.post('/saga/:tenantId/projects/:projectId/audio/:trackId/analyze', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'saga_audio_analyze', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      audioTrackId: req.params.trackId,
    }),
  );

  // ---- jobs / lifecycle ----
  apiRouter.get('/saga/:tenantId/jobs/:jobId', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'saga_job_status', {
      tenantId: req.params.tenantId,
      jobId: req.params.jobId,
    }, 7),
  );

  apiRouter.delete('/saga/:tenantId/jobs/:jobId', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'saga_job_cancel', {
      tenantId: req.params.tenantId,
      jobId: req.params.jobId,
    }, 7),
  );

  apiRouter.post('/saga/:tenantId/projects/:projectId/generations/:genId/promote', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'saga_promote_generation', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      generationId: req.params.genId,
    }),
  );

  apiRouter.get('/saga/status', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'saga_get_status', {}, 8),
  );

  console.log('[Saga] Routes registered: 13 endpoints under /saga');
}
