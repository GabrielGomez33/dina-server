// File: src/modules/visuals/visualsRoutes.ts
// ============================================================================
// DINA VISUALS ROUTES — HTTP → DUMP boundary
// ============================================================================
// Follows the proven truthStreamRoutes.ts pattern EXACTLY:
//   • dependencies (DinaCore, createDinaMessage, trust-level mapper) are
//     INJECTED — this file imports nothing across module boundaries
//   • every request: auth → validate → createDinaMessage → dina.handleIncomingMessage
//     → extract from the DUMP double-wrap → safeJsonResponse
//   • so every visuals call gets the orchestrator's audit logging, protocol
//     validation, sanitization, QoS and error isolation for free.
//
// URL surface (mounted under the existing /dina base):
//   POST   /visuals/tenants
//   POST   /visuals/:tenantId/projects
//   GET    /visuals/:tenantId/projects/:projectId
//   DELETE /visuals/:tenantId/projects/:projectId
//   POST   /visuals/:tenantId/projects/:projectId/generate/image
//   POST   /visuals/:tenantId/projects/:projectId/generate/video
//   POST   /visuals/:tenantId/projects/:projectId/generate/music-video
//   POST   /visuals/:tenantId/projects/:projectId/training/lora
//   POST   /visuals/:tenantId/projects/:projectId/audio/:trackId/analyze
//   GET    /visuals/:tenantId/jobs/:jobId
//   DELETE /visuals/:tenantId/jobs/:jobId
//   POST   /visuals/:tenantId/projects/:projectId/generations/:genId/promote
//   GET    /visuals/status
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
      console.warn('[Visuals] Response already sent, skipping duplicate response');
    }
  } catch (e: any) {
    console.error('[Visuals] Error sending response:', e.message);
  }
}

/** Unwrap the orchestrator's DUMP double-wrap (documented in truthStreamRoutes). */
function extractDumpResponseData(response: any): { data: any; error: any } {
  const inner = response?.payload?.data;
  if (inner?.status === 'success') {
    const payloadData = inner.payload?.data;
    return { data: payloadData?.data ?? payloadData, error: null };
  }
  return {
    data: null,
    error: inner?.error || response?.error || { code: 'UNKNOWN', message: 'Unknown error' },
  };
}

/** Map a visuals handler error code to an HTTP status (uniform, predictable API). */
function httpStatusFor(code: string): number {
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

export function registerVisualsRoutes(
  apiRouter: Router,
  dina: DinaInstance,
  createDinaMessage: CreateDinaMessageFn,
  mapTrustLevelToSecurityLevel: MapTrustLevelFn,
): void {
  console.log('[Visuals] Registering visuals routes (DUMP protocol)...');

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
        target: { module: 'visuals', method, priority },
        security: {
          user_id: userId,
          session_id: req.dina?.session_id,
          clearance: mapTrustLevelToSecurityLevel(req.dina?.trust_level || 'new'),
          sanitized: false, // orchestrator sanitizes; we do not pre-claim it
        },
        payload: data,
      });

      const response = await dina.handleIncomingMessage(message);
      const { data: result, error } = extractDumpResponseData(response);

      if (error) {
        safeJsonResponse(res, httpStatusFor(error.code), { success: false, error: error.message, code: error.code });
        return;
      }
      // Handlers return VisualsHandlerResult; surface its error codes as HTTP.
      if (result && result.success === false && result.error) {
        safeJsonResponse(res, httpStatusFor(result.error.code), {
          success: false,
          error: result.error.message,
          code: result.error.code,
        });
        return;
      }
      safeJsonResponse(res, 200, { success: true, ...(result?.data !== undefined ? { data: result.data } : { data: result }) });
    } catch (e: any) {
      console.error(`[Visuals] ${method} route error:`, e.message);
      safeJsonResponse(res, 500, { success: false, error: 'Internal error', code: 'INTERNAL' });
    }
  }

  // ---- tenancy / projects ----
  apiRouter.post('/visuals/tenants', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'visuals_create_tenant', {
      name: req.body?.name,
      slug: req.body?.slug,
      plan: req.body?.plan,
    }),
  );

  apiRouter.post('/visuals/:tenantId/projects', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'visuals_create_project', {
      tenantId: req.params.tenantId,
      slug: req.body?.slug,
    }),
  );

  apiRouter.get('/visuals/:tenantId/projects/:projectId', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'visuals_get_project', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
    }),
  );

  apiRouter.delete('/visuals/:tenantId/projects/:projectId', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'visuals_delete_project', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
    }),
  );

  // ---- generation (validate + enqueue; worker holds the GPU lease) ----
  apiRouter.post('/visuals/:tenantId/projects/:projectId/generate/image', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'visuals_generate_image', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      params: req.body?.params ?? {},
    }, 6),
  );

  apiRouter.post('/visuals/:tenantId/projects/:projectId/generate/video', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'visuals_generate_video', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      params: req.body?.params ?? {},
    }, 4),
  );

  apiRouter.post('/visuals/:tenantId/projects/:projectId/generate/music-video', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'visuals_generate_music_video', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      audioTrackId: req.body?.audioTrackId,
      modes: req.body?.modes ?? { beatSync: true, lyricSync: false, lipSync: false },
      params: req.body?.params ?? {},
    }, 4),
  );

  apiRouter.post('/visuals/:tenantId/projects/:projectId/training/lora', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'visuals_train_lora', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      manifestId: req.body?.manifestId,
    }, 3),
  );

  apiRouter.post('/visuals/:tenantId/projects/:projectId/audio/:trackId/analyze', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'visuals_audio_analyze', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      audioTrackId: req.params.trackId,
    }),
  );

  // ---- jobs / lifecycle ----
  apiRouter.get('/visuals/:tenantId/jobs/:jobId', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'visuals_job_status', {
      tenantId: req.params.tenantId,
      jobId: req.params.jobId,
    }, 7),
  );

  apiRouter.delete('/visuals/:tenantId/jobs/:jobId', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'visuals_job_cancel', {
      tenantId: req.params.tenantId,
      jobId: req.params.jobId,
    }, 7),
  );

  apiRouter.post('/visuals/:tenantId/projects/:projectId/generations/:genId/promote', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'visuals_promote_generation', {
      tenantId: req.params.tenantId,
      projectId: req.params.projectId,
      generationId: req.params.genId,
    }),
  );

  apiRouter.get('/visuals/status', (req: Request, res: Response) =>
    dispatch(req as AuthedRequest, res, 'visuals_get_status', {}, 8),
  );

  console.log('[Visuals] Routes registered: 13 endpoints under /visuals');
}
