// ============================================================================
// PERSONAL ANALYSIS ROUTES - Dina-Server Mirror Module API
// ============================================================================
// File: src/modules/mirror/personalAnalysisRoutes.ts
// ----------------------------------------------------------------------------
// Exposes personal analysis functionality through the mirror module,
// routing ALL requests through the DUMP protocol (DinaUniversalMessage) via
// dina.handleIncomingMessage(). Follows the EXACT same pattern as
// truthStreamRoutes.ts.
//
// PATTERN:
//   HTTP POST → Express route → createDinaMessage() → dina.handleIncomingMessage()
//     → orchestrator.processMirrorRequest() → mirrorModule.handlePersonalAnalysis()
//       → personalAnalysisSynthesizer.generateAnalysis() → llmManager.generate()
//
// INTEGRATION: Add to /src/api/routes/index.ts:
//   import { registerPersonalAnalysisRoutes } from '../../modules/mirror/personalAnalysisRoutes';
//   registerPersonalAnalysisRoutes(apiRouter, dina, createDinaMessage, mapTrustLevelToSecurityLevel);
//
// All endpoints are prefixed with /mirror/personal-analysis/ and require authentication.
// ============================================================================

import { Request, Response, Router } from 'express';
import type { AuthenticatedRequest } from '../../api/middleware/security';

// ============================================================================
// TYPES
// ============================================================================

/** DinaCore instance interface */
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

// ============================================================================
// HELPER: Safe response sender (prevents ERR_HTTP_HEADERS_SENT)
// ============================================================================

function safeJsonResponse(res: Response, statusCode: number, body: Record<string, any>): void {
  try {
    if (!res.headersSent) {
      res.status(statusCode).json(body);
    } else {
      console.warn('[PersonalAnalysis] Response already sent, skipping duplicate response');
    }
  } catch (err: any) {
    console.error('[PersonalAnalysis] Error sending response:', err.message);
  }
}

// ============================================================================
// HELPER: Extract inner response data from DUMP double-wrap
// ============================================================================
// Same extraction pattern as truthStreamRoutes.ts

function extractDumpResponseData(response: any): { data: any; error: any } {
  const innerResponse = response.payload?.data;
  if (innerResponse?.status === 'success') {
    const payloadData = innerResponse.payload?.data;
    return { data: payloadData?.data ?? payloadData, error: null };
  }
  return {
    data: null,
    error: innerResponse?.error || response.error || { code: 'UNKNOWN', message: 'Unknown error' },
  };
}

// ============================================================================
// ROUTE REGISTRATION
// ============================================================================

export function registerPersonalAnalysisRoutes(
  router: Router,
  dina: DinaInstance,
  createDinaMessage: CreateDinaMessageFn,
  mapTrustLevelToSecurityLevel: MapTrustLevelFn
): void {
  console.log('[PersonalAnalysis] Registering personal analysis routes on mirror module');

  // ==========================================================================
  // POST /mirror/personal-analysis/generate
  // Generate comprehensive personal analysis report
  // ==========================================================================
  router.post('/mirror/personal-analysis/generate', async (req: Request, res: Response) => {
    const startTime = Date.now();
    const authReq = req as AuthenticatedRequest;

    try {
      const userId = authReq.dina?.dina_key;
      if (!userId) {
        return safeJsonResponse(res, 401, {
          success: false,
          error: 'Authentication required',
          code: 'UNAUTHORIZED',
        });
      }

      const {
        analysisType,
        intakeData,
        journalEntries,
        previousAnalysis,
        options,
      } = req.body;

      // Validate required fields
      if (!analysisType) {
        return safeJsonResponse(res, 400, {
          success: false,
          error: 'analysisType is required',
          code: 'MISSING_ANALYSIS_TYPE',
        });
      }

      if (!intakeData || typeof intakeData !== 'object') {
        return safeJsonResponse(res, 400, {
          success: false,
          error: 'intakeData object is required',
          code: 'MISSING_INTAKE_DATA',
        });
      }

      const validTypes = ['personal_mirror_report', 'journal_trend_analysis', 'growth_trajectory', 'comprehensive'];
      if (!validTypes.includes(analysisType)) {
        return safeJsonResponse(res, 400, {
          success: false,
          error: `Invalid analysisType. Valid: ${validTypes.join(', ')}`,
          code: 'INVALID_ANALYSIS_TYPE',
        });
      }

      // Validate journal entries if provided
      if (journalEntries && !Array.isArray(journalEntries)) {
        return safeJsonResponse(res, 400, {
          success: false,
          error: 'journalEntries must be an array',
          code: 'INVALID_JOURNAL_ENTRIES',
        });
      }

      console.log(`[PersonalAnalysis] Generating ${analysisType} for user ${userId} (${journalEntries?.length || 0} journal entries)`);

      // Route through DUMP protocol — same pattern as truthStreamRoutes.ts
      const mirrorMessage = createDinaMessage({
        source: { module: 'api', version: '1.0.0' },
        target: { module: 'mirror', method: 'mirror_personal_analysis', priority: 7 },
        security: {
          user_id: userId,
          session_id: authReq.dina?.session_id,
          clearance: mapTrustLevelToSecurityLevel(authReq.dina?.trust_level || 'new'),
          sanitized: true,
        },
        payload: {
          userId,
          analysisType,
          intakeData,
          journalEntries: journalEntries || [],
          previousAnalysis: previousAnalysis || null,
          options: options || {},
        },
      });

      const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);

      if (mirrorResponse.status === 'success') {
        const { data, error } = extractDumpResponseData(mirrorResponse);

        if (error) {
          console.warn('[PersonalAnalysis] Inner DUMP error:', error);
          return safeJsonResponse(res, 500, {
            success: false,
            error: error.message || 'Analysis generation failed internally',
            code: error.code || 'INTERNAL_ERROR',
          });
        }

        console.log(`[PersonalAnalysis] Analysis generated in ${Date.now() - startTime}ms`);
        return safeJsonResponse(res, 200, {
          success: true,
          data,
        });
      }

      // Outer DUMP failure
      console.error('[PersonalAnalysis] DUMP routing failed:', mirrorResponse.error);
      return safeJsonResponse(res, 500, {
        success: false,
        error: mirrorResponse.error?.message || 'Analysis routing failed',
        code: mirrorResponse.error?.code || 'ROUTING_ERROR',
      });

    } catch (error: any) {
      console.error('[PersonalAnalysis] Unhandled error:', error.message);
      return safeJsonResponse(res, 500, {
        success: false,
        error: 'Internal server error during analysis generation',
        code: 'SERVER_ERROR',
      });
    }
  });

  // ==========================================================================
  // GET /mirror/personal-analysis/health
  // Health check for personal analysis subsystem
  // ==========================================================================
  router.get('/mirror/personal-analysis/health', (_req: Request, res: Response) => {
    safeJsonResponse(res, 200, {
      success: true,
      service: 'personal-analysis',
      status: 'operational',
      timestamp: new Date().toISOString(),
    });
  });

  console.log('[PersonalAnalysis] Routes registered: POST /mirror/personal-analysis/generate, GET /mirror/personal-analysis/health');
}
