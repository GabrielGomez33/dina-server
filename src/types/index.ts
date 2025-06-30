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
