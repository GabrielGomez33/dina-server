// DINA Universal Message Protocol (DUMP) - Enhanced Version
// This is the standard format ALL DINA modules use to communicate

import { v4 as uuidv4 } from 'uuid'; // Import uuidv4 for generating unique IDs

// Core message interface that every DINA module understands
export interface DinaUniversalMessage {
  // === IDENTITY SECTION ===
  id: string;                    // Unique message ID (UUID)
  timestamp: string;             // When message was created (ISO 8601)
  version: string;               // Protocol version (for future compatibility)
  
  // === ROUTING SECTION ===
  source: {
    module: string;              // Which module sent this ("core", "llm", "mirror", "database")
    instance?: string;           // For load balancing multiple instances
    version: string;             // Module version (for compatibility)
  };
  
  target: {
    module: string;              // Which module should receive this
    method: string;              // What method to call ("generate", "store", "ping")
    priority: MessagePriority;   // How urgent is this message (1-10)
  };
  
  // === SECURITY SECTION ===
  security: {
    user_id?: string;           // Who is making this request
    session_id?: string;        // User's session for tracking
    clearance: SecurityLevel;   // Security level of this request
    sanitized: boolean;         // Has input been cleaned of dangerous content
  };
  
  // === DATA SECTION ===
  payload: {
    data: any;                  // The actual content/request (consider a more specific type if possible)
    context?: any;              // Additional context (conversation history, etc.)
    metadata?: {
      size_bytes?: number;      // How big is this message
      complexity_score?: number; // How hard is this to process (1-10)
      user_count?: number;       // Current system load indicator
    };
  };
  
  // === QUALITY OF SERVICE SECTION (ENHANCED) ===
  qos: {
    delivery_mode: 'at_most_once' | 'at_least_once' | 'exactly_once';
    timeout_ms: number;         // How long before we give up
    retry_count: number;        // How many times we've tried this
    max_retries: number;        // Maximum retry attempts
    require_ack: boolean;       // Does sender need confirmation
    priority_boost?: boolean;   // VIP user gets faster processing
  };
  
  // === MONITORING SECTION (ENHANCED) ===
  trace: {
    created_at: number;         // Timestamp when message was created
    route: string[];            // Path the message has taken through modules
    request_chain: string[];    // Chain of message IDs that led to this
    performance_target_ms: number; // How fast should this be processed
    resource_allocation?: string;   // Hint about which model/resource to use
    // LLM-specific trace fields
    llm_processing_start?: number;
    llm_processing_end?: number;
    llm_processing_time?: number;
    queue_time_ms?: number;
    orchestrator_start?: number;
    orchestrator_end?: number;
    orchestrator_processing_time?: number;
  };
  
  // === METHOD (for backward compatibility and LLM routing) ===
  method: string;              // Duplicate for easier access
}

// Message priority levels (higher number = higher priority)
export type MessagePriority = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

// Security clearance levels
export enum SecurityLevel {
  PUBLIC = 'public',
  RESTRICTED = 'restricted',
  CONFIDENTIAL = 'confidential',
  SECRET = 'secret',
  TOP_SECRET = 'top_secret'
}

// Standard response format (Enhanced)
// THIS IS THE DEFINITIVE DinaResponse INTERFACE
export interface DinaResponse {
  request_id: string; // Original message ID this responds to
  id: string;
  timestamp: string;
  status: 'success' | 'error' | 'processing' | 'queued';
  payload: { // Changed from 'result' to 'payload' to be consistent with DinaUniversalMessage
    data: any;
    metadata?: any;
  };
  error?: {
    code: string;
    message: string;
    details?: any; // Consider a more specific type if possible
  };
  metrics: {
    processing_time_ms: number;
    queue_time_ms?: number;
    model_used?: string;
    tokens_generated?: number;
  };
}

// Response wrapper for DUMP protocol (Removed as DinaResponse is now top-level)
// export interface DinaResponseWrapper { ... }

// Quality of Service levels
export interface QoSLevel {
  delivery_mode: 'at_most_once' | 'at_least_once' | 'exactly_once';
  timeout_ms: number;
  retry_count: number;
  max_retries: number;
  require_ack: boolean;
  priority_boost?: boolean;
}

// Connection state for WebSocket management
export interface ConnectionState {
  id: string;
  user_id?: string;
  session_id: string;
  connected_at: Date;
  last_activity: Date;
  message_count: number;
  is_authenticated: boolean;
}

// System load metrics for intelligent routing
export interface SystemMetrics {
  cpu_usage: number;           // 0.0 - 1.0
  memory_usage: number;        // 0.0 - 1.0
  active_connections: number;
  queue_depth: {
    high: number;
    medium: number;
    low: number;
    batch: number;
  };
  models_loaded: string[];
}

// ================================
// DUMP MESSAGE CREATION HELPERS
// ================================

/**
 * Create a DUMP-compliant DINA message
 */
export function createDinaMessage(options: {
  source: {
    module: string;
    instance?: string;
    version?: string;
  };
  target: {
    module: string;
    method: string; // Ensure method is always provided here for clarity and safety
    priority?: number;
  };
  payload: any; // This is the data part of the payload
  qos?: Partial<QoSLevel>;
  security?: {
    user_id?: string;
    session_id?: string;
    clearance?: SecurityLevel;
    sanitized?: boolean; // Added sanitized to the options for creation
  };
}): DinaUniversalMessage {
  const messageId = uuidv4(); // Use uuidv4 for message ID
  const timestamp = new Date().toISOString();
  const now = Date.now();

  return {
    // Identity
    id: messageId,
    timestamp,
    version: '2.0.0', // Standardized version
    
    // Routing
    source: {
      module: options.source.module,
      instance: options.source.instance || 'default',
      version: options.source.version || '2.0.0' // Default source version
    },
    target: {
      module: options.target.module,
      method: options.target.method, // Use options.target.method
      priority: (options.target.priority || 5) as MessagePriority
    },
    
    // Security
    security: {
      user_id: options.security?.user_id,
      session_id: options.security?.session_id,
      clearance: options.security?.clearance || SecurityLevel.PUBLIC, // Use enum
      sanitized: options.security?.sanitized ?? false // Default to false if not provided
    },
    
    // Data
    payload: {
      data: options.payload, // Use options.payload directly as data
      metadata: {
        size_bytes: JSON.stringify(options.payload).length
      }
    },
    
    // Quality of Service
    qos: {
      delivery_mode: options.qos?.delivery_mode || 'at_least_once', // Default delivery mode
      timeout_ms: options.qos?.timeout_ms || 30000,         // Default timeout
      retry_count: options.qos?.retry_count || 0,           // Default retry count
      max_retries: options.qos?.max_retries || 3,           // Default max retries
      require_ack: options.qos?.require_ack ?? true,        // Default require_ack
      priority_boost: options.qos?.priority_boost ?? false  // Default priority boost
    },
    
    // Tracing
    trace: {
      created_at: now,
      route: [options.source.module],
      request_chain: [],
      performance_target_ms: 1000 // Default performance target
    },
    
    // Method (for easier access)
    method: options.target.method // Duplicate from options.target.method
  };
}

/**
 * Create a DUMP-compliant response (now directly DinaResponse)
 */
export function createDinaResponse(options: {
  request_id: string; // Original message ID this responds to
  status: 'success' | 'error' | 'processing' | 'queued';
  payload: any; // The actual response data
  metrics: {
    processing_time_ms: number;
    queue_time_ms?: number;
    model_used?: string;
    tokens_generated?: number;
  };
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}): DinaResponse {
  return {
    id: uuidv4(), // Generate a new ID for the response
    timestamp: new Date().toISOString(),
    request_id: options.request_id,
    status: options.status,
    payload: { data: options.payload }, // Wrap data in a payload object
    metrics: options.metrics,
    error: options.error
  };
}

// ================================
// UTILITY FUNCTIONS
// ================================

/**
 * Enhanced DINA Protocol utilities
 */
export class DinaProtocol {
  
  /**
   * Creates a new DINA message with all required fields (Legacy compatibility)
   */
  static createMessage(
    sourceModule: string, // Renamed 'source' to 'sourceModule' to avoid conflict with options.source
    targetModule: string, // Renamed 'target' to 'targetModule'
    method: string,
    data: any,
    options: Partial<DinaUniversalMessage> = {} // Allowing partial options for flexibility
  ): DinaUniversalMessage {
    
    return createDinaMessage({
      source: {
        module: sourceModule, // Use sourceModule
        instance: options.source?.instance,
        version: options.source?.version
      },
      target: {
        module: targetModule, // Use targetModule
        method: method, // Pass the method explicitly
        priority: options.target?.priority
      },
      payload: data,
      qos: options.qos,
      security: options.security
    });
  }
  
  /**
   * Creates a response to an existing message (Legacy compatibility)
   */
  static createResponse(
    originalMessage: DinaUniversalMessage,
    result: any,
    processingTimeMs: number,
    error?: { code?: string; message?: string; details?: any; } // More specific error type
  ): DinaResponse {
    
    return {
      request_id: originalMessage.id,
      id: uuidv4(), // Generate a new ID for the response
      timestamp: new Date().toISOString(),
      status: error ? 'error' : 'success',
      payload: { data: error ? undefined : result }, // Wrap data in payload
      error: error ? {
        code: error.code || 'UNKNOWN_ERROR',
        message: error.message || 'An unknown error occurred',
        details: error.details // Pass details as-is
      } : undefined,
      metrics: {
        processing_time_ms: processingTimeMs,
        model_used: originalMessage.trace.resource_allocation // This is optional, but if present, it's good
      }
    };
  }
  
  /**
   * Validates that a message follows the DUMP protocol
   */
  static validateMessage(message: any): message is DinaUniversalMessage {
      const required = ['id', 'timestamp', 'version', 'source', 'target', 'security', 'payload', 'qos', 'trace', 'method'];
      for (const field of required) {
        if (!(field in message)) {
          console.warn(`Invalid DINA message: missing field '${field}'`);
          return false;
        }
      }
      if (!message.source || !message.source.module || !message.source.version) {
        console.warn('Invalid DINA message: missing source details');
        return false;
      }
      if (!message.target || !message.target.module || !message.target.method || typeof message.target.priority === 'undefined') {
        console.warn('Invalid DINA message: missing target details');
        return false;
      }
      if (!message.security || typeof message.security.sanitized === 'undefined') {
        console.warn('Invalid DINA message: missing security details');
        return false;
      }
      if (!message.payload || typeof message.payload.data === 'undefined') {
        console.warn('Invalid DINA message: missing payload data');
        return false;
      }
     // Enhanced LLM method validation with flexible payload structure
      if (message.target.module === 'llm') {
        const method = message.target.method;
        
        if (method === 'llm_generate') {
          // Handle both direct payload and nested data structure
          const query = message.payload.query || message.payload.data?.query || message.payload.data?.data?.query;
          if (!query) {
            console.warn('Invalid DINA message: missing query for llm_generate');
            console.warn('Payload structure:', JSON.stringify(message.payload, null, 2));
            return false;
          }
        }
        
        if (method === 'llm_embed') {
          const text = message.payload.text || message.payload.data?.text || message.payload.data?.data?.text;
          if (!text) {
            console.warn('Invalid DINA message: missing text for llm_embed');
            console.warn('Payload structure:', JSON.stringify(message.payload, null, 2));
            return false;
          }
        }
      }
      if (!message.qos || typeof message.qos.delivery_mode === 'undefined' || typeof message.qos.timeout_ms === 'undefined' || typeof message.qos.retry_count === 'undefined' || typeof message.qos.max_retries === 'undefined' || typeof message.qos.require_ack === 'undefined') {
        console.warn('Invalid DINA message: missing QoS details');
        return false;
      }
      if (!message.trace || typeof message.trace.created_at === 'undefined' || !message.trace.route || !message.trace.request_chain || typeof message.trace.performance_target_ms === 'undefined') {
        console.warn('Invalid DINA message: missing trace details');
        return false;
      }
      if (message.target.priority < 1 || message.target.priority > 10) {
        console.warn(`Invalid priority: ${message.target.priority}`);
        return false;
      }
      const validSecurity: SecurityLevel[] = Object.values(SecurityLevel);
      if (!validSecurity.includes(message.security.clearance)) {
        console.warn(`Invalid security clearance: ${message.security.clearance}`);
        return false;
      }
      const validDeliveryModes: ('at_most_once' | 'at_least_once' | 'exactly_once')[] = ['at_most_once', 'at_least_once', 'exactly_once'];
      if (!validDeliveryModes.includes(message.qos.delivery_mode)) {
        console.warn(`Invalid delivery mode: ${message.qos.delivery_mode}`);
        return false;
      }
      return true;
    }  
  /**
   * Sanitizes input data to remove potentially dangerous content
   */
  static sanitizeMessage(message: DinaUniversalMessage): DinaUniversalMessage {
    const sanitized = { ...message };
    
    // Deep copy to avoid modifying original trace route during sanitization if it's referenced elsewhere
    sanitized.trace = { ...message.trace, route: [...message.trace.route], request_chain: [...message.trace.request_chain] };

    // Clean string data of script injections
    if (typeof sanitized.payload.data === 'string') {
      sanitized.payload.data = sanitized.payload.data
        .replace(/<script[^>]*>.*?<\/script>/gi, '')  // Remove script tags
        .replace(/javascript:/gi, '')                 // Remove javascript: URLs
        .replace(/on\w+\s*=/gi, '')                  // Remove event handlers
        .trim();
    } else if (typeof sanitized.payload.data === 'object' && sanitized.payload.data !== null) {
        // Recursively sanitize objects (e.g., if data is a structured JSON)
        // This is a simplistic example; a more robust solution might use a library
        for (const key in sanitized.payload.data) {
            if (Object.prototype.hasOwnProperty.call(sanitized.payload.data, key) && typeof sanitized.payload.data[key] === 'string') {
                sanitized.payload.data[key] = (sanitized.payload.data[key] as string)
                    .replace(/<script[^>]*>.*?<\/script>/gi, '')
                    .replace(/javascript:/gi, '')
                    .replace(/on\w+\s*=/gi, '')
                    .trim();
            }
        }
    }
    
    // Mark as sanitized
    sanitized.security.sanitized = true;
    
    return sanitized;
  }
  
  /**
   * Determines which queue a message should go to based on priority and system load
   */
  static getQueueName(message: DinaUniversalMessage, systemLoad: number): string {
    const priority = message.target.priority;
    
    // High priority or low system load → high priority queue
    if (priority >= 8 || systemLoad < 0.3) {
      return QUEUE_NAMES.HIGH;
    }
    
    // Medium priority
    if (priority >= 5 || systemLoad < 0.7) {
      return QUEUE_NAMES.MEDIUM;
    }
    
    // Low priority
    if (priority >= 3) {
      return QUEUE_NAMES.LOW;
    }
    
    // Background/batch processing
    return QUEUE_NAMES.BATCH;
  }
}

// ================================
// HELPER FUNCTIONS
// ================================

/**
 * Calculate message priority based on content and urgency
 */
export function calculateMessagePriority(
  method: string,
  payload: any,
  userContext?: { is_vip?: boolean; [key: string]: any; } // Explicitly define userContext type
): MessagePriority {
  let priority = 5; // Default medium priority
  
  // High priority methods
  const highPriorityMethods = ['ping', 'health', 'emergency', 'alert'];
  if (highPriorityMethods.includes(method)) {
    priority = Math.min(10, priority + 3);
  }
  
  // LLM priority based on complexity
  if (method.startsWith('llm_')) {
    const queryContent = typeof payload.data === 'string' ? payload.data : JSON.stringify(payload.data || '');
    const queryLength = queryContent.length;
    if (queryLength > 500) priority = Math.min(10, priority + 2);
    if (queryContent.includes('urgent') || queryContent.includes('critical')) {
      priority = Math.min(10, priority + 3);
    }
  }
  
  // VIP user boost
  if (userContext?.is_vip) {
    priority = Math.min(10, priority + 2);
  }
  
  return priority as MessagePriority;
}

// Export common constants
export const QUEUE_NAMES = {
  HIGH: 'dina:queue:priority:high',
  MEDIUM: 'dina:queue:priority:medium', 
  LOW: 'dina:queue:priority:low',
  BATCH: 'dina:queue:priority:batch'
} as const;

export const DEFAULT_TIMEOUTS = {
  FAST_OPERATION: 5000,    // 5 seconds
  NORMAL_OPERATION: 30000, // 30 seconds  
  COMPLEX_OPERATION: 120000 // 2 minutes
} as const;

export const DELIVERY_MODES = {
  AT_MOST_ONCE: 'at_most_once' as const,
  AT_LEAST_ONCE: 'at_least_once' as const,
  EXACTLY_ONCE: 'exactly_once' as const
} as const;

console.log('📡 DINA Universal Message Protocol (DUMP) v2.0 loaded');
console.log('✅ Enhanced with LLM support and enterprise messaging capabilities');

