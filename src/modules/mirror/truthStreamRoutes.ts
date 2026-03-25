// ============================================================================
// TRUTHSTREAM ROUTES - Dina-Server Mirror Module API
// ============================================================================
// File: src/modules/mirror/truthStreamRoutes.ts
// ----------------------------------------------------------------------------
// These routes expose TruthStream functionality through the mirror module,
// routing ALL requests through the DUMP protocol (DinaUniversalMessage) via
// dina.handleIncomingMessage(). This ensures every request goes through the
// orchestrator's caching, audit logging, security, telemetry, and QoS layers.
//
// PATTERN: Same as /mirror/synthesize-insights in routes/index.ts:
//   HTTP POST → Express route → createDinaMessage() → dina.handleIncomingMessage()
//     → orchestrator.processMirrorRequest() → mirrorModule.handleTruthStream*()
//       → truthStreamSynthesizer.*() → llmManager.generate()
//
// The mirror module owns its own DinaLLMManager instance. We never expose
// DinaCore.llmManager — the orchestrator routes to the mirror module which
// uses its private llmManager for LLM operations.
//
// INTEGRATION: Add to /src/api/routes/index.ts:
//   import { registerTruthStreamRoutes } from '../../modules/mirror/truthStreamRoutes';
//   registerTruthStreamRoutes(apiRouter, dina, createDinaMessage, mapTrustLevelToSecurityLevel);
//
// All endpoints are prefixed with /mirror/truthstream/ and require authentication.
// ============================================================================

import { Request, Response, Router } from 'express';
import type { AuthenticatedRequest } from '../../api/middleware/security';

// ============================================================================
// TYPES
// ============================================================================

/** DinaCore instance interface — only the method we need */
interface DinaInstance {
  handleIncomingMessage(message: any): Promise<any>;
}

/** createDinaMessage function signature */
type CreateDinaMessageFn = (params: {
  source: { module: string; version: string };
  target: { module: string; method: string; priority: number };
  security: { user_id: string; session_id?: string; clearance: any; sanitized: boolean };
  payload: Record<string, any>;
}) => any;

/** mapTrustLevelToSecurityLevel function signature */
type MapTrustLevelFn = (trustLevel: string) => any;

// ============================================================================
// HELPER: Safe response sender (prevents ERR_HTTP_HEADERS_SENT)
// ============================================================================

function safeJsonResponse(res: Response, statusCode: number, body: Record<string, any>): void {
  try {
    if (!res.headersSent) {
      res.status(statusCode).json(body);
    } else {
      console.warn('[TruthStream] Response already sent, skipping duplicate response');
    }
  } catch (err: any) {
    console.error('[TruthStream] Error sending response:', err.message);
  }
}

// ============================================================================
// HELPER: Extract inner response data from DUMP double-wrap
// ============================================================================
// The orchestrator double-wraps via createDinaResponse:
//   mirrorModule.handler() -> createDinaResponse({ payload: { data: result } })
//   orchestrator.handleIncomingMessage() -> createDinaResponse({ payload: <inner DinaResponse> })
// So the inner DinaResponse is at response.payload.data
// And the actual data is at innerResponse.payload.data.data
//   (because createDinaResponse wraps payload into { data: payload },
//    and the handler passes { data: result }, so it's .data.data)

function extractDumpResponseData(response: any): { data: any; error: any } {
  const innerResponse = response.payload?.data;
  if (innerResponse?.status === 'success') {
    // innerResponse.payload.data = { data: <result> } (from handler's createDinaResponse)
    // The actual result is at .data within that — matching the synthesize-insights pattern:
    //   const synthesisData = innerResponse?.payload?.data?.data;
    const payloadData = innerResponse.payload?.data;
    return { data: payloadData?.data ?? payloadData, error: null };
  }
  // Inner response had an error
  return {
    data: null,
    error: innerResponse?.error || response.error || { code: 'UNKNOWN', message: 'Unknown error' },
  };
}

// ============================================================================
// ROUTE REGISTRATION
// ============================================================================

/**
 * Register TruthStream routes on the API router.
 * All requests are routed through DUMP protocol via dina.handleIncomingMessage().
 *
 * @param apiRouter - The Express router to register routes on
 * @param dina - The DinaCore instance for DUMP message routing
 * @param createDinaMessage - Function to create DUMP-compliant messages
 * @param mapTrustLevelToSecurityLevel - Maps auth trust levels to security clearance
 */
export function registerTruthStreamRoutes(
  apiRouter: Router,
  dina: DinaInstance,
  createDinaMessage: CreateDinaMessageFn,
  mapTrustLevelToSecurityLevel: MapTrustLevelFn,
): void {
  console.log('[TruthStream] Registering mirror TruthStream routes (DUMP protocol)...');

  // ========================================================================
  // POST /mirror/truthstream/classify-review
  // Classify a submitted review using Dina LLM (via mirror module)
  // Called by: mirror-server TruthStreamQueueProcessor (async job)
  // ========================================================================
  apiRouter.post('/mirror/truthstream/classify-review',
    async (req: Request, res: Response) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const userId = authReq.dina?.dina_key;

        if (!userId) {
          safeJsonResponse(res, 401, {
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH',
          });
          return;
        }

        const { reviewId, reviewText, responses, reviewTone, revieweeGoal, revieweeGoalText, qualityMetrics } = req.body;

        // Validate required fields — reviewText is optional (built from responses if empty)
        if (!reviewId || !responses || !revieweeGoal) {
          safeJsonResponse(res, 400, {
            success: false,
            error: 'Missing required fields: reviewId, responses, revieweeGoal',
            code: 'INVALID_REQUEST',
          });
          return;
        }

        // Input sanitization
        const sanitizedReviewText = reviewText ? String(reviewText).substring(0, 10000) : '';

        // Create DUMP message targeting mirror module's TruthStream classifier
        const mirrorMessage = createDinaMessage({
          source: { module: 'api', version: '1.0.0' },
          target: { module: 'mirror', method: 'mirror_ts_classify_review', priority: 7 },
          security: {
            user_id: userId,
            session_id: authReq.dina?.session_id,
            clearance: mapTrustLevelToSecurityLevel(authReq.dina?.trust_level || 'new'),
            sanitized: true,
          },
          payload: {
            reviewId: String(reviewId).substring(0, 100),
            reviewText: sanitizedReviewText,
            responses: typeof responses === 'object' && !Array.isArray(responses) ? responses : {},
            reviewTone: reviewTone ? String(reviewTone).substring(0, 100) : undefined,
            revieweeGoal: String(revieweeGoal).substring(0, 200),
            revieweeGoalText: revieweeGoalText ? String(revieweeGoalText).substring(0, 500) : undefined,
            qualityMetrics: qualityMetrics && typeof qualityMetrics === 'object' ? qualityMetrics : undefined,
          },
        });

        // Route through DINA orchestrator → mirror module → truthStreamSynthesizer
        const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);

        if (mirrorResponse.status === 'success') {
          const { data, error } = extractDumpResponseData(mirrorResponse);
          if (error) {
            safeJsonResponse(res, 500, {
              success: false,
              error: error.message || 'Classification failed',
              code: error.code || 'CLASSIFICATION_ERROR',
            });
          } else {
            safeJsonResponse(res, 200, {
              success: true,
              data,
            });
          }
        } else {
          safeJsonResponse(res, 500, {
            success: false,
            error: mirrorResponse.error?.message || 'Review classification failed',
            code: mirrorResponse.error?.code || 'CLASSIFICATION_ERROR',
          });
        }
      } catch (error: any) {
        console.error('[TruthStream] Error classifying review:', error.message);
        safeJsonResponse(res, 500, {
          success: false,
          error: 'Review classification failed',
          code: 'CLASSIFICATION_ERROR',
        });
      }
    }
  );

  // ========================================================================
  // POST /mirror/truthstream/generate-analysis
  // Generate a comprehensive analysis (Truth Mirror Report, etc.)
  // Called by: mirror-server TruthStreamQueueProcessor (async job)
  // ========================================================================
  apiRouter.post('/mirror/truthstream/generate-analysis',
    async (req: Request, res: Response) => {
      // Track whether we've already sent a response (guards against timeout race)
      let responseSent = false;

      const sendOnce = (statusCode: number, body: Record<string, any>) => {
        if (!responseSent && !res.headersSent) {
          responseSent = true;
          try {
            res.status(statusCode).json(body);
          } catch (err: any) {
            console.error('[TruthStream] Error sending analysis response:', err.message);
          }
        } else {
          console.warn('[TruthStream] generate-analysis: Duplicate response suppressed');
        }
      };

      try {
        const authReq = req as AuthenticatedRequest;
        const userId = authReq.dina?.dina_key;

        if (!userId) {
          sendOnce(401, {
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH',
          });
          return;
        }

        const {
          userId: targetUserId,
          analysisType,
          reviews,
          selfAssessmentData,
          goal,
          goalCategory,
          selfStatement,
          totalReviewCount,
          previousAnalysis,
        } = req.body;

        // Validate required fields
        if (!targetUserId || !analysisType || !reviews || !goal || !goalCategory) {
          sendOnce(400, {
            success: false,
            error: 'Missing required fields: userId, analysisType, reviews, goal, goalCategory',
            code: 'INVALID_REQUEST',
          });
          return;
        }

        if (!Array.isArray(reviews) || reviews.length < 5) {
          sendOnce(400, {
            success: false,
            error: 'Minimum 5 reviews required for analysis',
            code: 'INSUFFICIENT_REVIEWS',
            data: { current: Array.isArray(reviews) ? reviews.length : 0, minimum: 5 },
          });
          return;
        }

        // Cap reviews array to prevent resource exhaustion
        const cappedReviews = reviews.slice(0, 100);

        const validAnalysisTypes = [
          'truth_mirror_report', 'perception_gap', 'temporal_trend',
          'blind_spot', 'growth_recommendation',
        ];
        if (!validAnalysisTypes.includes(analysisType)) {
          sendOnce(400, {
            success: false,
            error: `Invalid analysis type. Valid: ${validAnalysisTypes.join(', ')}`,
            code: 'INVALID_ANALYSIS_TYPE',
          });
          return;
        }

        // Create DUMP message targeting mirror module's TruthStream analysis generator
        const mirrorMessage = createDinaMessage({
          source: { module: 'api', version: '1.0.0' },
          target: { module: 'mirror', method: 'mirror_ts_generate_analysis', priority: 8 },
          security: {
            user_id: userId,
            session_id: authReq.dina?.session_id,
            clearance: mapTrustLevelToSecurityLevel(authReq.dina?.trust_level || 'new'),
            sanitized: true,
          },
          payload: {
            userId: targetUserId,
            analysisType,
            reviews: cappedReviews,
            selfAssessmentData: selfAssessmentData && typeof selfAssessmentData === 'object' ? selfAssessmentData : undefined,
            goal: String(goal).substring(0, 1000),
            goalCategory: String(goalCategory).substring(0, 100),
            selfStatement: selfStatement ? String(selfStatement).substring(0, 2000) : undefined,
            totalReviewCount: totalReviewCount || cappedReviews.length,
            previousAnalysis: previousAnalysis && typeof previousAnalysis === 'object' ? previousAnalysis : undefined,
          },
        });

        // Route through DINA orchestrator → mirror module → truthStreamSynthesizer
        const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);

        if (mirrorResponse.status === 'success') {
          const { data, error } = extractDumpResponseData(mirrorResponse);
          if (error) {
            sendOnce(500, {
              success: false,
              error: error.message || 'Analysis generation failed',
              code: error.code || 'ANALYSIS_ERROR',
            });
          } else {
            sendOnce(200, {
              success: true,
              data,
            });
          }
        } else {
          sendOnce(500, {
            success: false,
            error: mirrorResponse.error?.message || 'Analysis generation failed',
            code: mirrorResponse.error?.code || 'ANALYSIS_ERROR',
          });
        }
      } catch (error: any) {
        console.error('[TruthStream] Error generating analysis:', error.message);
        sendOnce(500, {
          success: false,
          error: 'Analysis generation failed',
          code: 'ANALYSIS_ERROR',
        });
      }
    }
  );

  // ========================================================================
  // POST /mirror/truthstream/validate-truth-card
  // Validate and sanitize truth card data before creation
  // Called by: mirror-server truthstreamController (profile creation)
  // ========================================================================
  apiRouter.post('/mirror/truthstream/validate-truth-card',
    async (req: Request, res: Response) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const userId = authReq.dina?.dina_key;

        if (!userId) {
          safeJsonResponse(res, 401, {
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH',
          });
          return;
        }

        const { selfStatement, goal, goalCategory, sharedDataTypes, feedbackAreas, displayAlias } = req.body;

        if (!goal || !goalCategory || !sharedDataTypes || !displayAlias) {
          safeJsonResponse(res, 400, {
            success: false,
            error: 'Missing required fields: goal, goalCategory, sharedDataTypes, displayAlias',
            code: 'INVALID_REQUEST',
          });
          return;
        }

        // Create DUMP message for truth card validation
        const mirrorMessage = createDinaMessage({
          source: { module: 'api', version: '1.0.0' },
          target: { module: 'mirror', method: 'mirror_ts_validate_truth_card', priority: 5 },
          security: {
            user_id: userId,
            session_id: authReq.dina?.session_id,
            clearance: mapTrustLevelToSecurityLevel(authReq.dina?.trust_level || 'new'),
            sanitized: true,
          },
          payload: {
            selfStatement: selfStatement ? String(selfStatement).substring(0, 2000) : undefined,
            goal: String(goal).substring(0, 1000),
            goalCategory: String(goalCategory).substring(0, 100),
            sharedDataTypes: Array.isArray(sharedDataTypes) ? sharedDataTypes.slice(0, 20) : [],
            feedbackAreas: Array.isArray(feedbackAreas) ? feedbackAreas.slice(0, 20) : undefined,
            displayAlias: String(displayAlias).substring(0, 100),
          },
        });

        const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);

        if (mirrorResponse.status === 'success') {
          const { data, error } = extractDumpResponseData(mirrorResponse);
          if (error) {
            safeJsonResponse(res, 500, {
              success: false,
              error: error.message || 'Validation failed',
              code: error.code || 'VALIDATION_ERROR',
            });
          } else {
            safeJsonResponse(res, 200, {
              success: data?.valid ?? true,
              data,
            });
          }
        } else {
          safeJsonResponse(res, 500, {
            success: false,
            error: mirrorResponse.error?.message || 'Truth card validation failed',
            code: mirrorResponse.error?.code || 'VALIDATION_ERROR',
          });
        }
      } catch (error: any) {
        console.error('[TruthStream] Error validating truth card:', error.message);
        safeJsonResponse(res, 500, {
          success: false,
          error: 'Truth card validation failed',
          code: 'VALIDATION_ERROR',
        });
      }
    }
  );

  // ========================================================================
  // POST /mirror/truthstream/score-review-quality
  // Calculate review quality scores
  // Called by: mirror-server truthstreamController (review submission)
  // ========================================================================
  apiRouter.post('/mirror/truthstream/score-review-quality',
    async (req: Request, res: Response) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const userId = authReq.dina?.dina_key;

        if (!userId) {
          safeJsonResponse(res, 401, {
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH',
          });
          return;
        }

        const { responses, questionnaireSections, timeSpentSeconds, freeFormText } = req.body;

        if (!responses || !questionnaireSections) {
          safeJsonResponse(res, 400, {
            success: false,
            error: 'Missing required fields: responses, questionnaireSections',
            code: 'INVALID_REQUEST',
          });
          return;
        }

        // Create DUMP message for review quality scoring
        const mirrorMessage = createDinaMessage({
          source: { module: 'api', version: '1.0.0' },
          target: { module: 'mirror', method: 'mirror_ts_score_review_quality', priority: 5 },
          security: {
            user_id: userId,
            session_id: authReq.dina?.session_id,
            clearance: mapTrustLevelToSecurityLevel(authReq.dina?.trust_level || 'new'),
            sanitized: true,
          },
          payload: {
            responses: typeof responses === 'object' && !Array.isArray(responses) ? responses : {},
            questionnaireSections: Array.isArray(questionnaireSections) ? questionnaireSections.slice(0, 50) : [],
            timeSpentSeconds: typeof timeSpentSeconds === 'number' ? timeSpentSeconds : 0,
            freeFormText: freeFormText ? String(freeFormText).substring(0, 10000) : undefined,
          },
        });

        const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);

        if (mirrorResponse.status === 'success') {
          const { data, error } = extractDumpResponseData(mirrorResponse);
          if (error) {
            safeJsonResponse(res, 500, {
              success: false,
              error: error.message || 'Scoring failed',
              code: error.code || 'SCORING_ERROR',
            });
          } else {
            safeJsonResponse(res, 200, {
              success: true,
              data,
            });
          }
        } else {
          safeJsonResponse(res, 500, {
            success: false,
            error: mirrorResponse.error?.message || 'Review quality scoring failed',
            code: mirrorResponse.error?.code || 'SCORING_ERROR',
          });
        }
      } catch (error: any) {
        console.error('[TruthStream] Error scoring review quality:', error.message);
        safeJsonResponse(res, 500, {
          success: false,
          error: 'Review quality scoring failed',
          code: 'SCORING_ERROR',
        });
      }
    }
  );

  // ========================================================================
  // POST /mirror/truthstream/assess-hostility-pattern
  // Check if a reviewer shows a pattern of hostile reviews
  // Called by: mirror-server TruthStreamQueueProcessor (after classification)
  // ========================================================================
  apiRouter.post('/mirror/truthstream/assess-hostility-pattern',
    async (req: Request, res: Response) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const userId = authReq.dina?.dina_key;

        if (!userId) {
          safeJsonResponse(res, 401, {
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH',
          });
          return;
        }

        const { hostilityCount, totalReviews } = req.body;

        if (typeof hostilityCount !== 'number' || typeof totalReviews !== 'number') {
          safeJsonResponse(res, 400, {
            success: false,
            error: 'Missing required fields: hostilityCount (number), totalReviews (number)',
            code: 'INVALID_REQUEST',
          });
          return;
        }

        // Create DUMP message for hostility pattern assessment
        const mirrorMessage = createDinaMessage({
          source: { module: 'api', version: '1.0.0' },
          target: { module: 'mirror', method: 'mirror_ts_assess_hostility', priority: 6 },
          security: {
            user_id: userId,
            session_id: authReq.dina?.session_id,
            clearance: mapTrustLevelToSecurityLevel(authReq.dina?.trust_level || 'new'),
            sanitized: true,
          },
          payload: {
            hostilityCount,
            totalReviews,
          },
        });

        const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);

        if (mirrorResponse.status === 'success') {
          const { data, error } = extractDumpResponseData(mirrorResponse);
          if (error) {
            safeJsonResponse(res, 500, {
              success: false,
              error: error.message || 'Assessment failed',
              code: error.code || 'ASSESSMENT_ERROR',
            });
          } else {
            safeJsonResponse(res, 200, {
              success: true,
              data,
            });
          }
        } else {
          safeJsonResponse(res, 500, {
            success: false,
            error: mirrorResponse.error?.message || 'Hostility assessment failed',
            code: mirrorResponse.error?.code || 'ASSESSMENT_ERROR',
          });
        }
      } catch (error: any) {
        console.error('[TruthStream] Error assessing hostility pattern:', error.message);
        safeJsonResponse(res, 500, {
          success: false,
          error: 'Hostility pattern assessment failed',
          code: 'ASSESSMENT_ERROR',
        });
      }
    }
  );

  // ========================================================================
  // GET /mirror/truthstream/health
  // Health check for TruthStream module (routed through DUMP for consistency)
  // ========================================================================
  apiRouter.get('/mirror/truthstream/health',
    async (req: Request, res: Response) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const userId = authReq.dina?.dina_key || 'healthcheck';

        const mirrorMessage = createDinaMessage({
          source: { module: 'api', version: '1.0.0' },
          target: { module: 'mirror', method: 'mirror_ts_health', priority: 3 },
          security: {
            user_id: userId,
            session_id: authReq.dina?.session_id || 'healthcheck',
            clearance: mapTrustLevelToSecurityLevel('new'),
            sanitized: true,
          },
          payload: {},
        });

        const mirrorResponse = await dina.handleIncomingMessage(mirrorMessage);

        if (mirrorResponse.status === 'success') {
          const { data } = extractDumpResponseData(mirrorResponse);
          safeJsonResponse(res, 200, {
            success: true,
            data: data || { module: 'truthstream', healthy: true },
          });
        } else {
          safeJsonResponse(res, 500, {
            success: false,
            error: 'Health check failed',
            code: 'HEALTH_ERROR',
          });
        }
      } catch (error: any) {
        safeJsonResponse(res, 500, {
          success: false,
          error: 'Health check failed',
        });
      }
    }
  );

}
