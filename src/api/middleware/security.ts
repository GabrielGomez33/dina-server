// ========================================
// DINA UNIFIED SECURITY MIDDLEWARE (WITH CORS)
// File: src/api/middleware/security.ts
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
  };
  user?: {
    id: string;
    securityLevel: string;
  };
}

// ================================
// CORS MIDDLEWARE
// ================================

/**
 * CORS middleware for browser testing
 */
export const corsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // Allow requests from remote domains and localhost for testing
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:8080',
    'http://localhost:8445',
    'https://localhost:8445',
    'https://theundergroundrailroad.world',
    'https://theundergroundrailroad.world:8445',
    'http://theundergroundrailroad.world',
    'http://theundergroundrailroad.world:8445',
    'http://127.0.0.1:3000',
    'https://127.0.0.1:8445',
    'null' // For file:// protocol testing
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin as string) || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Key, X-Dina-Key, X-Dina-Signature, X-Client-Mac, User-Agent, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'X-Dina-Key, X-Dina-Trust-Level, X-Dina-Rate-Limit-Remaining, X-Dina-Token-Limit-Remaining, X-Dina-Session-ID, X-Dina-Is-New-User');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
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
    console.log(`🔐 Auth check: ${req.method} ${req.path} from ${getClientIP(req)}`);
    
    // Build authentication request
    const authRequest = buildAuthRequest(req);
    
    // Authenticate through unified auth system
    const authResult = await database.authenticateRequest(authRequest);
    
    console.log(`🔐 Auth result: ${authResult.allow ? 'ALLOW' : 'DENY'} - Trust: ${authResult.trust_level} - Score: ${authResult.user.suspicion_score || 0}`);
    
    // Handle denied requests
    if (!authResult.allow) {
      const errorResponse = {
        success: false,
        error: {
          code: getErrorCode(authResult),
          message: getErrorMessage(authResult),
          trust_level: authResult.trust_level,
          suspicion_reasons: authResult.suspicion_reasons,
          dina_key: authResult.user.dina_key || null
        },
        rate_limit: {
          remaining: authResult.rate_limit_remaining,
          reset_time: getResetTime(),
          retry_after: getRetryAfter(authResult)
        },
        security: {
          session_id: authResult.session_id,
          validation_time_ms: authResult.validation_time_ms
        }
      };
      
      const statusCode = getHttpStatusCode(authResult);
      
      // Set security headers
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
      is_new_user: authResult.is_new_user
    };
    
    // Legacy compatibility - set user object for existing code
    req.user = {
      id: authResult.user.dina_key,
      securityLevel: authResult.trust_level
    };
    
    // Set response headers for successful auth
    res.set({
      'X-Dina-Key': authResult.user.dina_key,
      'X-Dina-Trust-Level': authResult.trust_level,
      'X-Dina-Rate-Limit-Remaining': authResult.rate_limit_remaining.toString(),
      'X-Dina-Token-Limit-Remaining': authResult.token_limit_remaining.toString(),
      'X-Dina-Session-ID': authResult.session_id,
      'X-Dina-Is-New-User': authResult.is_new_user.toString()
    });
    
    // Log successful authentication for new users
    if (authResult.is_new_user) {
      console.log(`👤 New user authenticated: ${authResult.user.user_key} → ${authResult.user.dina_key}`);
    }
    
    next();
    
  } catch (error) {
    console.error('❌ Auth middleware error:', error);
    
    res.status(500).json({
      success: false,
      error: {
        code: 'AUTH_SYSTEM_ERROR',
        message: 'Authentication system error',
        details: process.env.NODE_ENV === 'development' ? (error as Error).message : undefined
      },
      security: {
        session_id: uuidv4(),
        validation_time_ms: performance.now() - startTime
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
  // This is just a pass-through for backward compatibility
  next();
};

/**
 * Legacy input sanitization - now handled by unified auth
 * Kept for backward compatibility
 */
export const sanitizeInput = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  // Input sanitization is now handled in the authenticate middleware
  // This is just a pass-through for backward compatibility
  next();
};

/**
 * Error handling middleware
 */
export const handleError = (error: Error, req: Request, res: Response, next: NextFunction): void => {
  console.error('❌ API Error:', error);
  
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
         req.connection.remoteAddress ||
         req.socket.remoteAddress ||
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
    'SUSPICIOUS_ACTIVITY': 'Request flagged for suspicious activity',
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
          message: `Trust level '${requiredLevel}' required, current level: '${req.dina.trust_level}'`,
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
      'new': ['mxbai-embed-large'],
      'trusted': ['mxbai-embed-large', 'mistral:7b', 'codellama:34b'],
      'suspicious': ['mxbai-embed-large'],
      'blocked': []
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
