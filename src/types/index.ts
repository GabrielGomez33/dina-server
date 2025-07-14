// DINA Core Type Definitions

export interface DinaMessage {
  id: string;
  timestamp: string;
  source: 'frontend' | 'dina' | 'module';
  target: 'dina' | 'mirror' | 'math';
  type: 'request' | 'response' | 'error';
  method: string;
  payload: {
    user_id: string;
    data: any;
    context?: any;
  };
  priority: number;
  timeout: number;
  requires_auth: boolean;
}

export interface DinaResponse {
  id: string;
  timestamp: string;
  status: 'processed' | 'failed' | 'pending';
  result?: any;
  error?: string;
}

export interface DinaConfig {
  port: number;
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  redis: {
    host: string;
    port: number;
  };
  llm: {
    model: string;
    endpoint: string;
  };
}

export interface ModuleStatus {
  name: string;
  status: 'active' | 'inactive' | 'pending' | 'error';
  last_heartbeat?: string;
  message_count?: number;
}

// Database-specific types
export interface DatabaseUser {
  id: string;
  email?: string;
  username?: string;
  created_at: string;
  updated_at: string;
  metadata: any;
  is_active: boolean;
}

export interface DatabaseSession {
  id: string;
  user_id: string;
  session_token: string;
  expires_at: string;
  created_at: string;
  last_activity: string;
  user_agent?: string;
  ip_address?: string;
  is_active: boolean;
}

export interface DatabaseRequest {
  id: string;
  user_id?: string;
  source: string;
  target: string;
  method: string;
  payload: any;
  response?: any;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  priority: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  processing_time_ms?: number;
  error_message?: string;
}

export interface UserMemory {
  id: string;
  user_id: string;
  module: string;
  memory_type: string;
  data: any;
  confidence_score: number;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  is_active: boolean;
}

export interface SystemLog {
  id: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  module: string;
  message: string;
  metadata?: any;
  created_at: string;
}
