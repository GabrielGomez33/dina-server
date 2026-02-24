// /src/modules/mirror/groupRoutes.ts
/**
 * DINA MIRROR MODULE - GROUP API ROUTES
 *
 * These routes are added to the dina-server's API router to expose
 * group management functionality through the mirror module.
 *
 * INTEGRATION: Add these routes to /src/api/routes/index.ts
 *
 * Usage in routes/index.ts:
 *   import { registerGroupRoutes } from '../../modules/mirror/groupRoutes';
 *   registerGroupRoutes(apiRouter);
 *
 * All endpoints are prefixed with /mirror/groups/ and require authentication.
 */

import { Request, Response, Router } from 'express';
import { mirrorGroupManager } from './groupManager';
import type { GroupValidationRequest, GroupContextEnrichment } from './groupManager';

// ============================================================================
// ROUTE REGISTRATION
// ============================================================================

/**
 * Register group-related routes on the API router.
 * Call this from the main routes/index.ts file.
 *
 * @param apiRouter - The Express router to register routes on
 */
export function registerGroupRoutes(apiRouter: Router): void {
  console.log('Registering mirror group routes...');

  // ========================================================================
  // POST /mirror/groups/validate
  // Validates group creation data and returns sanitized data with recommendations
  // ========================================================================
  apiRouter.post('/mirror/groups/validate',
    async (req: Request, res: Response) => {
      try {
        const userId = (req as any).dina?.dina_key;
        if (!userId) {
          res.status(401).json({
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH'
          });
          return;
        }

        const {
          name,
          type,
          subtype,
          privacy,
          goal,
          goalCustom,
          description,
          maxMembers,
        } = req.body;

        const validationRequest: GroupValidationRequest = {
          name,
          type: type || 'family',
          subtype,
          privacy: privacy || 'private',
          goal,
          goalCustom,
          description,
          maxMembers,
          creatorUserId: userId,
        };

        const result = mirrorGroupManager.validateGroupCreation(validationRequest);

        res.json({
          success: result.valid,
          data: {
            valid: result.valid,
            errors: result.errors,
            warnings: result.warnings,
            recommendations: result.recommendations,
            sanitizedData: result.sanitizedData,
          }
        });
      } catch (error: any) {
        console.error('Error in group validation:', error);
        res.status(500).json({
          success: false,
          error: 'Group validation failed',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  );

  // ========================================================================
  // GET /mirror/groups/goal-recommendations
  // Returns recommended goals for a given group type
  // ========================================================================
  apiRouter.get('/mirror/groups/goal-recommendations',
    async (req: Request, res: Response) => {
      try {
        const userId = (req as any).dina?.dina_key;
        if (!userId) {
          res.status(401).json({
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH'
          });
          return;
        }

        const groupType = (req.query.type as string) || 'family';
        const subtype = req.query.subtype as string | undefined;

        const recommendations = mirrorGroupManager.getGoalRecommendations(groupType, subtype);

        res.json({
          success: true,
          data: {
            type: groupType,
            subtype: subtype || null,
            goals: recommendations,
          }
        });
      } catch (error: any) {
        console.error('Error getting goal recommendations:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get goal recommendations'
        });
      }
    }
  );

  // ========================================================================
  // POST /mirror/groups/enrich-context
  // Enriches group context for insight synthesis
  // Called by mirror-server before triggering group analysis
  // ========================================================================
  apiRouter.post('/mirror/groups/enrich-context',
    async (req: Request, res: Response) => {
      try {
        const userId = (req as any).dina?.dina_key;
        if (!userId) {
          res.status(401).json({
            success: false,
            error: 'Authentication required',
            code: 'NO_AUTH'
          });
          return;
        }

        const {
          groupId,
          groupType,
          groupSubtype,
          groupGoal,
          memberCount,
          memberUserIds,
        } = req.body;

        if (!groupId || !groupType) {
          res.status(400).json({
            success: false,
            error: 'Missing required fields: groupId, groupType',
            code: 'INVALID_REQUEST'
          });
          return;
        }

        const enrichment: GroupContextEnrichment = {
          groupId,
          groupType,
          groupSubtype,
          groupGoal,
          memberCount: memberCount || 0,
          memberUserIds: memberUserIds || [],
        };

        const enrichedContext = mirrorGroupManager.enrichGroupContext(enrichment);

        res.json({
          success: true,
          data: enrichedContext,
        });
      } catch (error: any) {
        console.error('Error enriching group context:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to enrich group context'
        });
      }
    }
  );

  // ========================================================================
  // GET /mirror/groups/type-config
  // Returns configuration and metadata for all group types
  // Used by frontend to display type selection
  // ========================================================================
  apiRouter.get('/mirror/groups/type-config',
    async (req: Request, res: Response) => {
      try {
        const typeConfigs = [
          {
            type: 'family',
            label: 'Family',
            description: 'Blood relatives or chosen family building understanding',
            icon: 'family',
            defaultPrivacy: 'private',
            typicalSize: { min: 3, max: 8 },
            maxMembersMax: 20,
            insightsFocus: [
              'Intergenerational communication patterns',
              'Shared family traits vs. individual differences',
              'Conflict resolution styles inherited/learned',
            ],
          },
          {
            type: 'partners',
            label: 'Partners',
            description: 'Romantic or platonic partnerships deepening connection',
            icon: 'partners',
            defaultPrivacy: 'private',
            typicalSize: { min: 2, max: 4 },
            maxMembersMax: 6,
            subtypes: ['lover', 'platonic'],
            insightsFocus: [
              'Compatibility across all modalities',
              'Complementary strengths',
              'Potential friction points and mitigation',
            ],
          },
          {
            type: 'teamwork',
            label: 'Teamwork',
            description: 'Work teams, project groups, skill-building cohorts',
            icon: 'teamwork',
            defaultPrivacy: 'private',
            typicalSize: { min: 4, max: 20 },
            maxMembersMax: 100,
            insightsFocus: [
              'Leadership distribution',
              'Collaboration patterns',
              'Skill complementarity and gap analysis',
              'Goal alignment',
            ],
          },
          {
            type: 'friends',
            label: 'Friends',
            description: 'Connect with your close friends',
            icon: 'friends',
            defaultPrivacy: 'private',
            typicalSize: { min: 3, max: 10 },
            maxMembersMax: 30,
            insightsFocus: ['Social dynamics', 'Communication preferences', 'Group harmony'],
          },
          {
            type: 'therapy',
            label: 'Support Group',
            description: 'Therapeutic and support circles',
            icon: 'therapy',
            defaultPrivacy: 'private',
            typicalSize: { min: 3, max: 12 },
            maxMembersMax: 20,
            insightsFocus: ['Emotional support patterns', 'Progress tracking', 'Safe space dynamics'],
          },
          {
            type: 'anonymous',
            label: 'Anonymous',
            description: 'Share insights without identity',
            icon: 'anonymous',
            defaultPrivacy: 'secret',
            typicalSize: { min: 5, max: 25 },
            maxMembersMax: 50,
            insightsFocus: ['Aggregated patterns', 'Anonymous insights', 'Collective wisdom'],
          },
        ];

        res.json({
          success: true,
          data: {
            types: typeConfigs,
            privacyOptions: [
              { value: 'private', label: 'Private', description: 'Invite-only. Not listed in directory.' },
              { value: 'public', label: 'Public', description: 'Listed in directory. Join requests require approval.' },
              { value: 'secret', label: 'Secret', description: 'Hidden from all search. Maximum privacy.' },
            ],
          }
        });
      } catch (error: any) {
        console.error('Error getting type config:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to get type configuration'
        });
      }
    }
  );

  console.log('Mirror group routes registered successfully');
}
