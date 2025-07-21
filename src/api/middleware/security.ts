// DINA API Middleware: Security, Rate Limiting, and Input Sanitization
// File: src/api/middleware/security.ts

import { Request, Response, NextFunction } from 'express';
import { redisManager } from '../../config/redis'; // Import Redis Manager for rate limiting and caching
import { SecurityLevel } from '../../core/protocol'; // Import SecurityLevel enum
import { v4 as uuidv4 } from 'uuid'; // For generating unique request IDs

// ================================
// INTERFACES
// ================================

// Defines the structure for a cached API key
interface ApiKeyCacheEntry {
  userId: string;
  securityLevel: SecurityLevel; // Use the enum type
  lastUsed: number; // Timestamp
  tokenCount: number; // For token-aware rate limiting
}

// ================================
// IN-MEMORY CACHE FOR API KEYS (For simplicity in Phase 1, can be moved to Redis later)
// In a real enterprise system, this would be backed by a secure database and Redis.
const apiKeyStore = new Map<string, ApiKeyCacheEntry>();

// Populate with a dummy API key for testing (REPLACE IN PRODUCTION)
// In a real system, API keys would be securely generated and managed.
apiKeyStore.set('DINA_API_KEY_TEST_123', {
  userId: 'test_user_dina_1',
  securityLevel: SecurityLevel.TOP_SECRET, // Corrected to use enum
  lastUsed: Date.now(),
  tokenCount: 0,
});

// ================================
// AUTHENTICATION MIDDLEWARE
// ================================
/**
 * Authenticates API requests using a simple API key mechanism.
 * In a real enterprise system, this would involve JWT, OAuth2, or more complex schemes.
 * For Phase 1, we use a basic API key check.
 * @param req Express Request object
 * @param res Express Response object
 * @param next NextFunction to pass control to the next middleware
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Extract API key from Authorization header or query parameter
  const apiKey = req.headers['authorization']?.split(' ')[1] || req.query.api_key as string;

  if (!apiKey) {
    console.warn('Authentication failed: No API key provided');
    res.status(401).json({ error: 'Unauthorized', message: 'API key is required' });
    return;
  }

  const apiKeyEntry = apiKeyStore.get(apiKey);

  if (!apiKeyEntry) {
    console.warn(`Authentication failed: Invalid API key: ${apiKey.substring(0, 10)}...`);
    res.status(403).json({ error: 'Forbidden', message: 'Invalid API key' });
    return;
  }

  // Attach user information to the request for downstream middleware/handlers
  (req as any).user = {
    id: apiKeyEntry.userId,
    securityLevel: apiKeyEntry.securityLevel,
  };

  // Update last used timestamp
  apiKeyEntry.lastUsed = Date.now();

  console.log(`✅ Authenticated user: ${apiKeyEntry.userId} (Level: ${apiKeyEntry.securityLevel})`);
  next();
}

// ================================
// RATE LIMITING MIDDLEWARE (Token-aware)
// ================================
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window
const MAX_REQUESTS_PER_WINDOW = 100; // Max requests per user per window
const MAX_TOKENS_PER_WINDOW = 50000; // Max estimated tokens per user per window

// In-memory store for rate limiting (can be replaced by Redis for distributed limits)
const userRequestCounts = new Map<string, { count: number; tokens: number; lastReset: number }>();

/**
 * Estimates tokens in a given text. This is a simplified estimation.
 * A more accurate method would involve a proper tokenizer or LLM call.
 * @param text The text to estimate tokens for.
 * @returns Estimated token count.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3); // Rough estimate: words * 1.3
}

/**
 * Implements token-aware rate limiting.
 * @param req Express Request object
 * @param res Express Response object
 * @param next NextFunction to pass control to the next middleware
 */
export async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = (req as any).user?.id || 'anonymous'; // Get user ID from authentication
  const now = Date.now();

  let userState = userRequestCounts.get(userId);
  if (!userState || (now - userState.lastReset) > RATE_LIMIT_WINDOW_MS) {
    // Reset state for new window
    userState = { count: 0, tokens: 0, lastReset: now };
    userRequestCounts.set(userId, userState);
  }

  // Estimate tokens from the request payload (e.g., query for LLM)
  let estimatedReqTokens = 0;
  if (req.body && typeof req.body.query === 'string') {
    estimatedReqTokens = estimateTokens(req.body.query);
  } else if (req.body && typeof req.body.code_request === 'string') {
    estimatedReqTokens = estimateTokens(req.body.code_request);
  } else if (req.body && typeof req.body.analysis_query === 'string') {
    estimatedReqTokens = estimateTokens(req.body.analysis_query);
  }

  // Check limits
  if (userState.count >= MAX_REQUESTS_PER_WINDOW) {
    console.warn(`Rate limit exceeded for user ${userId}: Request count`);
    res.status(429).json({ error: 'Too Many Requests', message: 'Rate limit exceeded (request count)' });
    return;
  }
  if (userState.tokens + estimatedReqTokens > MAX_TOKENS_PER_WINDOW) {
    console.warn(`Rate limit exceeded for user ${userId}: Token count`);
    res.status(429).json({ error: 'Too Many Requests', message: 'Rate limit exceeded (token count)' });
    return;
  }

  // Increment counts
  userState.count++;
  userState.tokens += estimatedReqTokens;

  // Set rate limit headers
  res.setHeader('X-RateLimit-Limit-Requests', MAX_REQUESTS_PER_WINDOW);
  res.setHeader('X-RateLimit-Remaining-Requests', MAX_REQUESTS_PER_WINDOW - userState.count);
  res.setHeader('X-RateLimit-Limit-Tokens', MAX_TOKENS_PER_WINDOW);
  res.setHeader('X-RateLimit-Remaining-Tokens', MAX_TOKENS_PER_WINDOW - userState.tokens);
  res.setHeader('X-RateLimit-Reset', userState.lastReset + RATE_LIMIT_WINDOW_MS);

  console.log(`Rate limit check for ${userId}: Requests: ${userState.count}/${MAX_REQUESTS_PER_WINDOW}, Tokens: ${userState.tokens}/${MAX_TOKENS_PER_WINDOW}`);
  next();
}

// ================================
// INPUT SANITIZATION MIDDLEWARE
// ================================
/**
 * Sanitizes input to prevent common attacks like XSS, SQL Injection, and basic Prompt Injection.
 * This is a foundational layer; more advanced semantic filtering would be in Phase 3.
 * @param req Express Request object
 * @param res Express Response object
 * @param next NextFunction to pass control to the next middleware
 */
export function sanitizeInput(req: Request, res: Response, next: NextFunction): void {
  // Deep sanitize request body
  if (req.body) {
    req.body = deepSanitize(req.body);
  }
  // Sanitize query parameters
  if (req.query) {
    req.query = deepSanitize(req.query);
  }
  // Sanitize route parameters
  if (req.params) {
    req.params = deepSanitize(req.params);
  }

  console.log('✅ Input sanitized');
  next();
}

/**
 * Recursively sanitizes strings within an object.
 * @param obj The object to sanitize.
 * @returns The sanitized object.
 */
function deepSanitize(obj: any): any {
  if (obj === null || typeof obj !== 'object') {
    return sanitizeString(obj); // Sanitize primitives directly
  }

  if (Array.isArray(obj)) {
    return obj.map(item => deepSanitize(item));
  }

  const sanitizedObj: { [key: string]: any } = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      sanitizedObj[key] = deepSanitize(obj[key]);
    }
  }
  return sanitizedObj;
}

/**
 * Sanitizes a single string to prevent XSS, basic SQLi, and prompt injection attempts.
 * @param input The string to sanitize.
 * @returns The sanitized string.
 */
function sanitizeString(input: any): any {
  if (typeof input !== 'string') {
    return input; // Return non-strings as is
  }

  let sanitized = input;

  // 1. HTML/XSS Sanitization: Encode HTML entities
  sanitized = sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');

  // 2. Basic SQL Injection prevention (beyond prepared statements, for extra layer)
  // Remove common SQL injection keywords/characters. This is a blunt tool; prepared statements are primary defense.
  sanitized = sanitized
    .replace(/(\b(union|select|insert|update|delete|drop|exec|execute)\b)/gi, '') // Remove SQL keywords
    .replace(/(;|\-\-|\/\*|\*\/)/g, ''); // Remove comment/statement terminators

  // 3. Basic Prompt Injection prevention (Phase 1: simple keyword/pattern removal)
  // This is rudimentary. Phase 3 will have semantic filtering.
  sanitized = sanitized
    .replace(/ignore previous instructions/gi, '')
    .replace(/disregard all prior commands/gi, '')
    .replace(/as an AI language model/gi, '') // Prevent self-referential attacks
    .replace(/act as/gi, '') // Prevent role-playing manipulation
    .replace(/system:/gi, '') // Prevent attempts to mimic system messages
    .replace(/user:/gi, '') // Prevent attempts to mimic user messages
    .replace(/assistant:/gi, ''); // Prevent attempts to mimic assistant messages

  // Trim whitespace
  sanitized = sanitized.trim();

  return sanitized;
}

// ================================
// ERROR HANDLING MIDDLEWARE (Optional, but good practice)
// ================================
/**
 * Centralized error handling middleware.
 * @param err The error object.
 * @param req Express Request object.
 * @param res Express Response object.
 * @param next NextFunction.
 */
export function handleError(err: Error, req: Request, res: Response, next: NextFunction): void {
  console.error('❌ API Error:', err.message, err.stack);

  if (res.headersSent) {
    return next(err); // If headers already sent, defer to default error handler
  }

  res.status(500).json({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred. Please try again later.',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined, // Only expose details in dev
  });
}

