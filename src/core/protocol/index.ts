// DINA Universal Message Protocol (DUMP)
// This is the standard format ALL DINA modules use to communicate

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
    data: any;                  // The actual content/request
    context?: any;              // Additional context (conversation history, etc.)
    metadata?: {
      size_bytes?: number;      // How big is this message
      complexity_score?: number; // How hard is this to process (1-10)
      user_count?: number;       // Current system load indicator
    };
  };
  
  // === QUALITY OF SERVICE SECTION ===
  qos: {
    timeout_ms: number;         // How long before we give up
    retry_count: number;        // How many times we've tried this
    max_retries: number;        // Maximum retry attempts
    require_ack: boolean;       // Does sender need confirmation
    priority_boost?: boolean;   // VIP user gets faster processing
  };
  
  // === MONITORING SECTION ===
  trace: {
    request_chain: string[];    // Chain of message IDs that led to this
    performance_target_ms: number; // How fast should this be processed
    resource_allocation?: string;   // Hint about which model/resource to use
  };
}

// Message priority levels (higher number = higher priority)
export type MessagePriority = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

// Security clearance levels
export type SecurityLevel = 'public' | 'restricted' | 'confidential';

// Standard response format
export interface DinaResponse {
  // Original message ID this responds to
  request_id: string;
  
  // Response details
  id: string;
  timestamp: string;
  status: 'success' | 'error' | 'processing' | 'queued';
  
  // The actual response data
  result?: any;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  
  // Performance metrics
  metrics: {
    processing_time_ms: number;
    queue_time_ms?: number;
    model_used?: string;
    tokens_generated?: number;
  };
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

// Utility functions for message creation
export class DinaProtocol {
  
  /**
   * Creates a new DINA message with all required fields
   * This is how modules should create messages to send to other modules
   */
  static createMessage(
    source: string,
    target: string, 
    method: string,
    data: any,
    options: Partial<DinaUniversalMessage> = {}
  ): DinaUniversalMessage {
    
    const messageId = this.generateMessageId();
    const timestamp = new Date().toISOString();
    
    return {
      // Identity
      id: messageId,
      timestamp,
      version: '1.0.0',
      
      // Routing
      source: {
        module: source,
        version: '1.0.0',
        ...options.source
      },
      target: {
        module: target,
        method,
        priority: 5, // Default medium priority
        ...options.target
      },
      
      // Security (basic defaults)
      security: {
        clearance: 'public',
        sanitized: false,
        ...options.security
      },
      
      // Data
      payload: {
        data,
        ...options.payload
      },
      
      // Quality of Service
      qos: {
        timeout_ms: 30000,      // 30 second default timeout
        retry_count: 0,
        max_retries: 3,
        require_ack: false,
        ...options.qos
      },
      
      // Tracing
      trace: {
        request_chain: [],
        performance_target_ms: 1000, // 1 second default target
        ...options.trace
      }
    };
  }
  
  /**
   * Creates a response to an existing message
   */
  static createResponse(
    originalMessage: DinaUniversalMessage,
    result: any,
    processingTimeMs: number,
    error?: any
  ): DinaResponse {
    
    return {
      request_id: originalMessage.id,
      id: this.generateMessageId(),
      timestamp: new Date().toISOString(),
      status: error ? 'error' : 'success',
      result: error ? undefined : result,
      error: error ? {
        code: error.code || 'UNKNOWN_ERROR',
        message: error.message || 'An unknown error occurred',
        details: error.details
      } : undefined,
      metrics: {
        processing_time_ms: processingTimeMs,
        model_used: originalMessage.trace.resource_allocation
      }
    };
  }
  
  /**
   * Validates that a message follows the protocol
   */
  static validateMessage(message: any): message is DinaUniversalMessage {
    // Check required fields exist
    const required = ['id', 'timestamp', 'version', 'source', 'target', 'security', 'payload', 'qos', 'trace'];
    
    for (const field of required) {
      if (!(field in message)) {
        console.warn(`Invalid DINA message: missing field '${field}'`);
        return false;
      }
    }
    
    // Check priority is valid
    if (message.target.priority < 1 || message.target.priority > 10) {
      console.warn(`Invalid priority: ${message.target.priority}`);
      return false;
    }
    
    // Check security level is valid
    const validSecurity = ['public', 'restricted', 'confidential'];
    if (!validSecurity.includes(message.security.clearance)) {
      console.warn(`Invalid security clearance: ${message.security.clearance}`);
      return false;
    }
    
    return true;
  }
  
  /**
   * Sanitizes input data to remove potentially dangerous content
   */
  static sanitizeMessage(message: DinaUniversalMessage): DinaUniversalMessage {
    const sanitized = { ...message };
    
    // Clean string data of script injections
    if (typeof sanitized.payload.data === 'string') {
      sanitized.payload.data = sanitized.payload.data
        .replace(/<script[^>]*>.*?<\/script>/gi, '')  // Remove script tags
        .replace(/javascript:/gi, '')                 // Remove javascript: URLs
        .replace(/on\w+\s*=/gi, '')                  // Remove event handlers
        .trim();
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
      return 'dina:queue:priority:high';
    }
    
    // Medium priority
    if (priority >= 5 || systemLoad < 0.7) {
      return 'dina:queue:priority:medium';
    }
    
    // Low priority
    if (priority >= 3) {
      return 'dina:queue:priority:low';
    }
    
    // Background/batch processing
    return 'dina:queue:priority:batch';
  }
  
  // Private utility methods
  private static generateMessageId(): string {
    // Create a unique ID using timestamp + random string
    return `dina_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
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
