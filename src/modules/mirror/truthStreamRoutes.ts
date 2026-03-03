// ============================================================================
// TRUTHSTREAM ROUTES - Dina-Server Mirror Module API
// ============================================================================
// File: src/modules/mirror/truthStreamRoutes.ts
// ----------------------------------------------------------------------------
// These routes are added to the dina-server's API router to expose
// TruthStream functionality through the mirror module.
//
// INTEGRATION: Add to /src/api/routes/index.ts:
//   import { registerTruthStreamRoutes } from '../../modules/mirror/truthStreamRoutes';
//   registerTruthStreamRoutes(apiRouter);
//
// All endpoints are prefixed with /mirror/truthstream/ and require authentication.
//
// Pattern follows: groupRoutes.ts
// ============================================================================

import { Request, Response, Router } from 'express';
import { truthStreamManager } from './truthStreamManager';
import { TruthStreamSynthesizer } from './processors/truthStreamSynthesizer';
import type {
  GoalCategory,
  ClassifyReviewRequest,
  GenerateAnalysisRequest,
  ValidateTruthCardRequest,
  ScoreReviewQualityRequest,
} from './types/truthstream';

// ============================================================================
// SYNTHESIZER INSTANCE
// ============================================================================
// The synthesizer is initialized with the LLM manager when routes are registered.
// This allows the synthesizer to use the same LLM connection as insightSynthesizer.

let truthStreamSynthesizer: TruthStreamSynthesizer | null = null;

// ============================================================================
// ROUTE REGISTRATION
// ============================================================================

/**
 * Register TruthStream routes on the API router.
 * Call this from the main routes/index.ts file.
 *
 * @param apiRouter - The Express router to register routes on
 * @param llmManager - Optional LLM manager instance for synthesis
 */
export function registerTruthStreamRoutes(apiRouter: Router, llmManager?: any): void {
  console.log('[TruthStream] Registering mirror TruthStream routes...');

  // Initialize synthesizer with LLM manager
  if (llmManager) {
    truthStreamSynthesizer = new TruthStreamSynthesizer(llmManager);
    truthStreamSynthesizer.initialize().catch(err => {
      console.error('[TruthStream] Failed to initialize synthesizer:', err.message);
    });
  }

  // Initialize manager
  truthStreamManager.initialize().catch(err => {
    console.error('[TruthStream] Failed to initialize manager:', err.message);
  });

  // ========================================================================
  // POST /mirror/truthstream/classify-review
  // Classify a submitted review using Dina LLM
  // Called by: mirror-server TruthStreamQueueProcessor (async job)
  // ========================================================================
  apiRouter.post('/mirror/truthstream/classify-review',
    async (req: Request, res: Response) => {
      try {
        const userId = (req as any).dina?.dina_key;
        if (!userId) {
          res.status(401).json({
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH',
          });
          return;
        }

        if (!truthStreamSynthesizer) {
          res.status(503).json({
            success: false,
            error: 'TruthStream synthesizer not available',
            code: 'SYNTHESIZER_UNAVAILABLE',
          });
          return;
        }

        const { reviewId, reviewText, responses, reviewTone, revieweeGoal, revieweeGoalText, qualityMetrics } = req.body;

        // Validate required fields
        if (!reviewId || !reviewText || !responses || !revieweeGoal) {
          res.status(400).json({
            success: false,
            error: 'Missing required fields: reviewId, reviewText, responses, revieweeGoal',
            code: 'INVALID_REQUEST',
          });
          return;
        }

        const request: ClassifyReviewRequest = {
          reviewId,
          reviewText: String(reviewText).substring(0, 10000),
          responses,
          reviewTone: reviewTone ? String(reviewTone).substring(0, 100) : undefined,
          revieweeGoal,
          revieweeGoalText: revieweeGoalText ? String(revieweeGoalText).substring(0, 500) : undefined,
          qualityMetrics,
        };

        const result = await truthStreamSynthesizer.classifyReview(request);

        res.json({
          success: true,
          data: result,
        });
      } catch (error: any) {
        console.error('[TruthStream] Error classifying review:', error.message);
        res.status(500).json({
          success: false,
          error: 'Review classification failed',
          code: 'CLASSIFICATION_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
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
      try {
        const userId = (req as any).dina?.dina_key;
        if (!userId) {
          res.status(401).json({
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH',
          });
          return;
        }

        if (!truthStreamSynthesizer) {
          res.status(503).json({
            success: false,
            error: 'TruthStream synthesizer not available',
            code: 'SYNTHESIZER_UNAVAILABLE',
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
          res.status(400).json({
            success: false,
            error: 'Missing required fields: userId, analysisType, reviews, goal, goalCategory',
            code: 'INVALID_REQUEST',
          });
          return;
        }

        if (!Array.isArray(reviews) || reviews.length < 5) {
          res.status(400).json({
            success: false,
            error: 'Minimum 5 reviews required for analysis',
            code: 'INSUFFICIENT_REVIEWS',
            data: { current: Array.isArray(reviews) ? reviews.length : 0, minimum: 5 },
          });
          return;
        }

        const validAnalysisTypes = [
          'truth_mirror_report', 'perception_gap', 'temporal_trend',
          'blind_spot', 'growth_recommendation',
        ];
        if (!validAnalysisTypes.includes(analysisType)) {
          res.status(400).json({
            success: false,
            error: `Invalid analysis type. Valid: ${validAnalysisTypes.join(', ')}`,
            code: 'INVALID_ANALYSIS_TYPE',
          });
          return;
        }

        const request: GenerateAnalysisRequest = {
          userId: targetUserId,
          analysisType,
          reviews,
          selfAssessmentData,
          goal: String(goal).substring(0, 1000),
          goalCategory,
          selfStatement: selfStatement ? String(selfStatement).substring(0, 2000) : undefined,
          totalReviewCount: totalReviewCount || reviews.length,
          previousAnalysis,
        };

        const result = await truthStreamSynthesizer.generateAnalysis(request);

        res.json({
          success: true,
          data: result,
        });
      } catch (error: any) {
        console.error('[TruthStream] Error generating analysis:', error.message);
        res.status(500).json({
          success: false,
          error: 'Analysis generation failed',
          code: 'ANALYSIS_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
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
        const userId = (req as any).dina?.dina_key;
        if (!userId) {
          res.status(401).json({
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH',
          });
          return;
        }

        const { selfStatement, goal, goalCategory, sharedDataTypes, feedbackAreas, displayAlias } = req.body;

        if (!goal || !goalCategory || !sharedDataTypes || !displayAlias) {
          res.status(400).json({
            success: false,
            error: 'Missing required fields: goal, goalCategory, sharedDataTypes, displayAlias',
            code: 'INVALID_REQUEST',
          });
          return;
        }

        const request: ValidateTruthCardRequest = {
          selfStatement,
          goal,
          goalCategory,
          sharedDataTypes: Array.isArray(sharedDataTypes) ? sharedDataTypes : [],
          feedbackAreas: Array.isArray(feedbackAreas) ? feedbackAreas : undefined,
          displayAlias,
        };

        const result = truthStreamManager.validateTruthCard(request);

        res.json({
          success: result.valid,
          data: {
            valid: result.valid,
            errors: result.errors,
            warnings: result.warnings,
            recommendations: result.recommendations,
            sanitizedData: result.sanitizedData,
          },
        });
      } catch (error: any) {
        console.error('[TruthStream] Error validating truth card:', error.message);
        res.status(500).json({
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
        const userId = (req as any).dina?.dina_key;
        if (!userId) {
          res.status(401).json({
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH',
          });
          return;
        }

        const { responses, questionnaireSections, timeSpentSeconds, freeFormText } = req.body;

        if (!responses || !questionnaireSections) {
          res.status(400).json({
            success: false,
            error: 'Missing required fields: responses, questionnaireSections',
            code: 'INVALID_REQUEST',
          });
          return;
        }

        const request: ScoreReviewQualityRequest = {
          responses,
          questionnaireSections: Array.isArray(questionnaireSections) ? questionnaireSections : [],
          timeSpentSeconds: typeof timeSpentSeconds === 'number' ? timeSpentSeconds : 0,
          freeFormText: freeFormText ? String(freeFormText) : undefined,
        };

        const result = truthStreamManager.scoreReviewQuality(request);

        res.json({
          success: true,
          data: result,
        });
      } catch (error: any) {
        console.error('[TruthStream] Error scoring review quality:', error.message);
        res.status(500).json({
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
        const userId = (req as any).dina?.dina_key;
        if (!userId) {
          res.status(401).json({
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH',
          });
          return;
        }

        const { hostilityCount, totalReviews } = req.body;

        if (typeof hostilityCount !== 'number' || typeof totalReviews !== 'number') {
          res.status(400).json({
            success: false,
            error: 'Missing required fields: hostilityCount (number), totalReviews (number)',
            code: 'INVALID_REQUEST',
          });
          return;
        }

        const result = truthStreamManager.assessHostilityPattern(hostilityCount, totalReviews);

        res.json({
          success: true,
          data: result,
        });
      } catch (error: any) {
        console.error('[TruthStream] Error assessing hostility pattern:', error.message);
        res.status(500).json({
          success: false,
          error: 'Hostility pattern assessment failed',
          code: 'ASSESSMENT_ERROR',
        });
      }
    }
  );

  // ========================================================================
  // GET /mirror/truthstream/health
  // Health check for TruthStream module
  // ========================================================================
  apiRouter.get('/mirror/truthstream/health',
    async (_req: Request, res: Response) => {
      try {
        const synthesizerHealth = truthStreamSynthesizer
          ? await truthStreamSynthesizer.healthCheck()
          : { healthy: false, initialized: false };

        res.json({
          success: true,
          data: {
            module: 'truthstream',
            healthy: synthesizerHealth.healthy,
            synthesizer: synthesizerHealth,
            manager: { initialized: true },
            timestamp: new Date().toISOString(),
          },
        });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: 'Health check failed',
        });
      }
    }
  );

  console.log('[TruthStream] Mirror TruthStream routes registered successfully');
  console.log('[TruthStream] Endpoints:');
  console.log('  POST /mirror/truthstream/classify-review');
  console.log('  POST /mirror/truthstream/generate-analysis');
  console.log('  POST /mirror/truthstream/validate-truth-card');
  console.log('  POST /mirror/truthstream/score-review-quality');
  console.log('  POST /mirror/truthstream/assess-hostility-pattern');
  console.log('  GET  /mirror/truthstream/health');
}
