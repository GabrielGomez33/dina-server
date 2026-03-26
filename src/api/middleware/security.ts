// ========================================
// DINA UNIFIED SECURITY MIDDLEWARE (WITH CORS)
// File: src/api/middleware/security.ts
// UPDATED: Fixed CORS wildcard/null origin vulnerability, removed sensitive header exposure,
//          sanitized error responses, added service-to-service auth middleware
// ========================================

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { database, DinaAuthRequest } from '../../config/database/db';

// ================================
// INTERFACES
// ================================

export interface AuthenticatedRequest extends Request {
  dina?: {
    user_key: string;
    dina_key: string;
    trust_level: string;
    session_id: string;
    rate_limit_remaining: number;
    token_limit_remaining: number;
    is_new_user: boolean;
    is_service_call: boolean; // NEW: Track if this is inter-service communication
  };
  user?: {
    id: string;
    securityLevel: string;
  };
}

// ================================
// ALLOWED ORIGINS CONFIGURATION
// ================================

const PRODUCTION_ORIGINS = [
  'https://theundergroundrailroad.world',
  'https://www.theundergroundrailroad.world',
  'https://theundergroundrailroad.world:8444',
  'https://www.theundergroundrailroad.world:8444',
  'https://theundergroundrailroad.world:8445',
  'https://www.theundergroundrailroad.world:8445',
];

const DEVELOPMENT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:8080',
  'http://localhost:8445',
  'https://localhost:8445',
  'http://127.0.0.1:3000',
  'https://127.0.0.1:8445',
];

function getAllowedOrigins(): string[] {
  const origins = [...PRODUCTION_ORIGINS];
  if (process.env.NODE_ENV !== 'production') {
    origins.push(...DEVELOPMENT_ORIGINS);
  }
  return origins;
}

// ================================
// CORS MIDDLEWARE
// ================================

/**
 * Strict CORS middleware - only allows explicitly listed origins
 * SECURITY FIX: Removed wildcard fallback and 'null' origin
 */
export const corsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const allowedOrigins = getAllowedOrigins();
  const origin = req.headers.origin;

  // Only set CORS headers if origin is in the allowlist
  // Do NOT fall back to '*' or allow missing/null origins with credentials
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  // If origin is not in the allowlist, no Access-Control-Allow-Origin header is set,
  // which means the browser will block the response (secure by default)

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Key, X-Dina-Key, X-Dina-Signature, X-Client-Mac, X-Service-Key, User-Agent, Accept');
  // SECURITY FIX: Only expose non-sensitive headers; removed X-Dina-Key from exposed headers
  res.setHeader('Access-Control-Expose-Headers', 'X-Dina-Trust-Level, X-Dina-Rate-Limit-Remaining, X-Dina-Session-ID');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[CORS] Preflight: ${req.method} ${req.path} from ${origin}`);
    }
    res.status(204).end();
    return;
  }

  next();
};

// ================================
// SERVICE-TO-SERVICE AUTH MIDDLEWARE
// ================================

/**
 * Validates that a request is from an authorized internal service (e.g., mirror-server).
 * Uses a shared secret key passed via X-Service-Key header.
 * Apply this middleware to routes that should only be callable by mirror-server.
 */
export const requireServiceAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  const serviceKey = req.headers['x-service-key'] as string;
  const expectedKey = process.env.MIRROR_SERVICE_KEY;

  if (!expectedKey) {
    // If no service key configured, log warning but allow (backwards compatibility)
    console.warn('[SECURITY] MIRROR_SERVICE_KEY not configured - service auth bypassed');
    if (req.dina) {
      req.dina.is_service_call = false;
    }
    next();
    return;
  }

  if (!serviceKey || !crypto.timingSafeEqual(
    Buffer.from(serviceKey, 'utf-8'),
    Buffer.from(expectedKey, 'utf-8')
  )) {
    res.status(403).json({
      success: false,
      error: {
        code: 'SERVICE_AUTH_FAILED',
        message: 'Invalid or missing service authentication'
      }
    });
    return;
  }

  // Mark as service call for downstream logic
  if (req.dina) {
    req.dina.is_service_call = true;
  }

  next();
};

// ================================
// UNIFIED AUTHENTICATION MIDDLEWARE
// ================================

/**
 * Main DINA authentication middleware - replaces all previous auth
 * Seamlessly integrates with existing system
 */
export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const startTime = performance.now();

  try {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[AUTH] Check: ${req.method} ${req.path} from ${getClientIP(req)}`);
    }

    // Build authentication request
    const authRequest = buildAuthRequest(req);

    // Authenticate through unified auth system
    const authResult = await database.authenticateRequest(authRequest);

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[AUTH] Result: ${authResult.allow ? 'ALLOW' : 'DENY'} - Trust: ${authResult.trust_level}`);
    }

    // Handle denied requests with sanitized error messages
    if (!authResult.allow) {
      const statusCode = getHttpStatusCode(authResult);
      const errorCode = getErrorCode(authResult);

      const errorResponse: any = {
        success: false,
        error: {
          code: errorCode,
          message: getErrorMessage(authResult),
          // SECURITY FIX: Do NOT expose suspicion_reasons to client
          // Only expose rate limit info when rate limited
          ...(errorCode === 'RATE_LIMITED' ? {
            rate_limit_remaining: authResult.rate_limit_remaining,
            retry_after: getRetryAfter(authResult),
          } : {})
        },
        security: {
          session_id: authResult.session_id,
          validation_time_ms: Math.round(authResult.validation_time_ms)
        }
      };

      // Set security headers (non-sensitive only)
      res.set({
        'X-Dina-Trust-Level': authResult.trust_level,
        'X-Dina-Rate-Limit-Remaining': authResult.rate_limit_remaining.toString(),
        'X-Dina-Session-ID': authResult.session_id,
        'Retry-After': getRetryAfter(authResult).toString()
      });

      res.status(statusCode).json(errorResponse);
      return;
    }

    // Attach auth info to request for downstream middleware
    req.dina = {
      user_key: authResult.user.user_key,
      dina_key: authResult.user.dina_key,
      trust_level: authResult.trust_level,
      session_id: authResult.session_id,
      rate_limit_remaining: authResult.rate_limit_remaining,
      token_limit_remaining: authResult.token_limit_remaining,
      is_new_user: authResult.is_new_user,
      is_service_call: false // Will be set by requireServiceAuth if applicable
    };

    // Legacy compatibility - set user object for existing code
    req.user = {
      id: authResult.user.dina_key,
      securityLevel: authResult.trust_level
    };

    // Set response headers for successful auth
    // SECURITY FIX: Don't expose dina_key in response headers (can be correlated)
    res.set({
      'X-Dina-Trust-Level': authResult.trust_level,
      'X-Dina-Rate-Limit-Remaining': authResult.rate_limit_remaining.toString(),
      'X-Dina-Session-ID': authResult.session_id,
      'X-Dina-Is-New-User': authResult.is_new_user.toString()
    });

    // Log successful authentication for new users
    if (authResult.is_new_user) {
      console.log(`[AUTH] New user authenticated: ${authResult.user.user_key}`);
    }

    next();

  } catch (error) {
    console.error('[AUTH] Middleware error:', error instanceof Error ? error.message : error);

    res.status(500).json({
      success: false,
      error: {
        code: 'AUTH_SYSTEM_ERROR',
        message: 'Authentication system error',
        details: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined
      },
      security: {
        session_id: uuidv4(),
        validation_time_ms: Math.round(performance.now() - startTime)
      }
    });
  }
};


// ================================
// LEGACY MIDDLEWARE (Kept for compatibility)
// ================================

/**
 * Legacy rate limiting - now handled by unified auth
 * Kept for backward compatibility
 */
export const rateLimit = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  // Rate limiting is now handled in the authenticate middleware
  next();
};

/**
 * Legacy input sanitization - now handled by unified auth
 * Kept for backward compatibility
 */
export const sanitizeInput = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  // Input sanitization is now handled in the authenticate middleware
  next();
};

/**
 * Error handling middleware
 */
export const handleError = (error: Error, req: Request, res: Response, next: NextFunction): void => {
  // Don't expose internal error details in production
  if (process.env.NODE_ENV !== 'production') {
    console.error('[API] Error:', error);
  } else {
    console.error('[API] Error:', error.message);
  }

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message
    },
    timestamp: new Date().toISOString()
  });
};

// ================================
// UTILITY FUNCTIONS
// ================================

function buildAuthRequest(req: Request): DinaAuthRequest {
  return {
    request_id: uuidv4(),
    timestamp: new Date(),
    user_key: extractUserKey(req),
    dina_key: req.headers['x-dina-key'] as string,
    method: req.method,
    endpoint: req.path,
    payload_hash: req.body ? createPayloadHash(req.body) : undefined,
    ip_address: getClientIP(req),
    mac_address: req.headers['x-client-mac'] as string,
    user_agent: req.headers['user-agent'] || 'unknown',
    headers: {
      'accept-language': req.headers['accept-language'] || '',
      'accept-encoding': req.headers['accept-encoding'] || '',
      'x-forwarded-for': req.headers['x-forwarded-for'] as string || '',
      'x-timezone': req.headers['x-timezone'] as string || '',
      'authorization': req.headers['authorization'] || ''
    },
    signature: req.headers['x-dina-signature'] as string
  };
}

function extractUserKey(req: Request): string | undefined {
  // Check multiple sources for user key
  return req.headers['x-user-key'] as string ||
         req.headers['x-api-key'] as string ||
         req.query.user_key as string ||
         req.body?.user_key ||
         undefined;
}

function getClientIP(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] as string ||
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         req.ip ||
         'unknown';
}

function createPayloadHash(payload: any): string {
  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHash('sha256').update(payloadString).digest('hex');
}

function getErrorCode(authResult: any): string {
  if (authResult.suspicion_reasons.includes('device_blocked')) return 'DEVICE_BLOCKED';
  if (authResult.suspicion_reasons.includes('user_blocked')) return 'USER_BLOCKED';
  if (authResult.suspicion_reasons.includes('rate_limit_exceeded')) return 'RATE_LIMITED';
  if (authResult.trust_level === 'suspicious') return 'SUSPICIOUS_ACTIVITY';
  return 'ACCESS_DENIED';
}

function getErrorMessage(authResult: any): string {
  const messages: { [key: string]: string } = {
    'DEVICE_BLOCKED': 'Device has been blocked due to suspicious activity',
    'USER_BLOCKED': 'User access has been temporarily suspended',
    'RATE_LIMITED': 'Request rate limit exceeded - please slow down',
    'SUSPICIOUS_ACTIVITY': 'Request flagged for review',
    'ACCESS_DENIED': 'Access denied'
  };

  const code = getErrorCode(authResult);
  return messages[code] || 'Access denied';
}

function getHttpStatusCode(authResult: any): number {
  if (authResult.suspicion_reasons.includes('rate_limit_exceeded')) return 429;
  if (authResult.suspicion_reasons.includes('device_blocked')) return 403;
  if (authResult.suspicion_reasons.includes('user_blocked')) return 403;
  if (authResult.trust_level === 'suspicious') return 403;
  return 401;
}

function getRetryAfter(authResult: any): number {
  if (authResult.suspicion_reasons.includes('rate_limit_exceeded')) return 60; // 1 minute
  if (authResult.suspicion_reasons.includes('user_blocked')) return 3600; // 1 hour
  if (authResult.trust_level === 'blocked') return 86400; // 24 hours
  return 300; // 5 minutes default
}

function getResetTime(): number {
  // Return timestamp for when rate limit resets (next minute)
  const now = new Date();
  const nextMinute = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                             now.getHours(), now.getMinutes() + 1, 0, 0);
  return Math.floor(nextMinute.getTime() / 1000);
}

// ================================
// OPTIONAL SPECIALIZED MIDDLEWARE
// ================================

/**
 * Require specific trust level
 */
export const requireTrustLevel = (requiredLevel: 'new' | 'trusted' | 'suspicious' | 'blocked') => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.dina) {
      res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Authentication required'
        }
      });
      return;
    }

    const trustHierarchy = { 'blocked': 0, 'suspicious': 1, 'new': 2, 'trusted': 3 };
    const userLevel = trustHierarchy[req.dina.trust_level as keyof typeof trustHierarchy];
    const requiredLevelValue = trustHierarchy[requiredLevel];

    if (userLevel < requiredLevelValue) {
      res.status(403).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_TRUST',
          message: `Higher trust level required`,
          current_trust_level: req.dina.trust_level,
          required_trust_level: requiredLevel
        }
      });
      return;
    }

    next();
  };
};

/**
 * Require access to specific model
 */
export const requireModelAccess = (modelName: string) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.dina) {
      res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Authentication required'
        }
      });
      return;
    }

    // Model access by trust level
    const modelAccess: { [key: string]: string[] } = {
      'new': ['mxbai-embed-large', 'qwen2.5:3b', 'mistral:7b'],
      'trusted': ['mxbai-embed-large', 'qwen2.5:3b', 'mistral:7b', 'codellama:34b', 'llama2:70b'],
      'suspicious': ['mxbai-embed-large', 'qwen2.5:3b', 'mistral:7b'],
      'blocked': ['mxbai-embed-large']
    };

    const allowedModels = modelAccess[req.dina.trust_level] || [];

    if (!allowedModels.includes(modelName)) {
      res.status(403).json({
        success: false,
        error: {
          code: 'MODEL_ACCESS_DENIED',
          message: `Access to model '${modelName}' requires higher trust level`,
          allowed_models: allowedModels,
          current_trust_level: req.dina.trust_level
        }
      });
      return;
    }

    next();
  };
};
