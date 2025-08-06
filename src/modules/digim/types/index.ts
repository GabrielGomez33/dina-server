// DIGIM Core Types - Phase 1 Foundation
// File: src/modules/digim/types/index.ts

import { DinaUniversalMessage, MessagePriority, SecurityLevel } from '../../../core/protocol';

// ================================
// DIGIM PROTOCOL EXTENSIONS
// ================================

// Extend DUMP protocol with DIGIM-specific methods
export type DigiMMethod = 
  | 'digim_gather'        // Gather content from sources
  | 'digim_query'         // Natural language intelligence query
  | 'digim_analyze'       // Deep analysis of content/topics
  | 'digim_generate'      // Generate outputs (articles, reports, etc.)
  | 'digim_cluster'       // Get clustered/organized content
  | 'digim_export'        // Export intelligence in various formats
  | 'digim_status'        // System status and health metrics
  | 'digim_sources'       // Manage data sources
  | 'digim_security';     // Security operations and validation

// DIGIM-specific message payloads
export interface DigiMMessage extends DinaUniversalMessage {
  target: DinaUniversalMessage['target'] & {
    method: DigiMMethod;
  };
  payload: {
    data: DigiMRequestData;
    context?: DigiMContext;
    metadata?: DigiMMetadata & {
      size_bytes?: number;
      complexity_score?: number;
      user_count?: number;
    };
  };
}

// ================================
// REQUEST DATA TYPES
// ================================

export type DigiMRequestData = 
  | DigiMGatherRequest
  | DigiMQueryRequest
  | DigiMAnalyzeRequest
  | DigiMGenerateRequest
  | DigiMClusterRequest
  | DigiMExportRequest
  | DigiMStatusRequest
  | DigiMSourcesRequest
  | DigiMSecurityRequest;

export interface DigiMGatherRequest {
  source_ids?: string[];
  categories?: string[];
  manual_trigger?: boolean;
  priority_override?: MessagePriority;
}

export interface DigiMQueryRequest {
  query: string;
  filters?: {
    categories?: string[];
    date_range?: { start: Date; end: Date };
    quality_threshold?: number;
    trust_level_required?: number;
  };
  intelligence_level?: 'surface' | 'deep' | 'predictive';
  output_format?: 'json' | 'summary' | 'feed' | 'article' | 'report';
  max_results?: number;
}

export interface DigiMAnalyzeRequest {
  content_ids?: string[];
  analysis_type?: 'trend' | 'sentiment' | 'entity' | 'topic' | 'quality' | 'similarity';
  depth?: 'quick' | 'thorough' | 'comprehensive';
}

export interface DigiMGenerateRequest {
  content_ids: string[];
  output_type: 'article' | 'report' | 'summary' | 'feed_item';
  template?: string;
  style?: 'formal' | 'casual' | 'technical' | 'journalistic';
  length?: 'brief' | 'medium' | 'comprehensive';
}

export interface DigiMClusterRequest {
  category?: string;
  time_range?: { start: Date; end: Date };
  similarity_threshold?: number;
  max_clusters?: number;
}

export interface DigiMExportRequest {
  content_ids?: string[];
  cluster_ids?: string[];
  format: 'json' | 'csv' | 'pdf' | 'rss' | 'xml';
  include_metadata?: boolean;
  include_analysis?: boolean;
}

export interface DigiMStatusRequest {
  detailed?: boolean;
  include_performance?: boolean;
  include_security?: boolean;
}

export interface DigiMSourcesRequest {
  action: 'list' | 'add' | 'update' | 'delete' | 'test';
  source?: DigiMSource;
  source_id?: string;
}

export interface DigiMSecurityRequest {
  action: 'scan' | 'validate' | 'quarantine' | 'cleanup';
  target_ids?: string[];
  security_level?: SecurityLevel;
}

// ================================
// CONTEXT AND METADATA
// ================================

export interface DigiMContext {
  user_preferences?: {
    preferred_categories?: string[];
    intelligence_level?: 'surface' | 'deep' | 'predictive';
    output_format?: string;
    language?: string;
  };
  conversation_context?: {
    previous_queries?: string[];
    research_topic?: string;
    session_focus?: string;
  };
  system_context?: {
    current_load?: number;
    available_models?: string[];
    processing_queue_size?: number;
  };
}

export interface DigiMMetadata {
  request_priority?: MessagePriority;
  processing_hints?: {
    use_cache?: boolean;
    require_fresh_data?: boolean;
    max_processing_time?: number;
    preferred_model?: string;
  };
  quality_requirements?: {
    min_quality_score?: number;
    min_trust_level?: number;
    require_validation?: boolean;
  };
  output_requirements?: {
    include_sources?: boolean;
    include_confidence?: boolean;
    include_lineage?: boolean;
  };
}

// ================================
// RESPONSE TYPES
// ================================

export interface DigiMResponse {
  status: 'success' | 'error' | 'partial' | 'queued';
  data: DigiMResponseData;
  metadata: {
    processing_time_ms: number;
    confidence_score?: number;
    quality_metrics?: QualityMetrics;
    sources_used?: string[];
    security_status?: SecurityStatus;
  };
  pagination?: {
    page: number;
    total_pages: number;
    total_items: number;
    has_more: boolean;
  };
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

export type DigiMResponseData = 
  | DigiMContent[]
  | DigiMCluster[]
  | DigiMIntelligence
  | DigiMGenerated
  | DigiMSystemStatus
  | DigiMExportResult;

// ================================
// CORE DATA STRUCTURES
// ================================

export interface DigiMSource {
  id: string;
  name: string;
  category: 'news' | 'documents' | 'academic';
  subcategory: string; // world, tech, health, finance, etc.
  source_type: 'web' | 'api' | 'rss' | 'file';
  url?: string;
  config: {
    headers?: Record<string, string>;
    auth?: {
      type: 'none' | 'api_key' | 'bearer' | 'basic';
      credentials?: Record<string, string>;
    };
    extraction_rules?: ExtractionRule[];
    crawl_rules?: CrawlRule[];
  };
  schedule: {
    type: 'realtime' | 'hourly' | 'daily' | 'manual';
    interval?: number; // minutes
    next_run?: Date;
  };
  trust_level: number; // 0-1
  is_active: boolean;
  metadata: {
    last_gathered?: Date;
    total_items_gathered?: number;
    avg_quality_score?: number;
    error_count?: number;
    last_error?: string;
  };
}

export interface ExtractionRule {
  id: string;
  name: string;
  selector: string; // CSS selector or XPath
  attribute?: string; // href, src, text, innerHTML, etc.
  transform?: string; // JavaScript function to transform data
  required: boolean;
  data_type: 'text' | 'number' | 'date' | 'url' | 'email' | 'json';
}

export interface CrawlRule {
  id: string;
  pattern: string; // regex or glob pattern
  depth: number; // max crawl depth
  respect_robots: boolean;
  delay_ms: number; // politeness delay
  user_agent: string;
  exclude_patterns: string[];
  include_patterns: string[];
  follow_links: boolean;
}

export interface DigiMContent {
  id: string;
  source_id: string;
  content_hash: string; // For deduplication
  title?: string;
  content: string;
  url: string;
  author?: string;
  published_at?: Date;
  gathered_at: Date;
  
  // Quality metrics
  quality_metrics: QualityMetrics;
  
  // Processing status
  processing_status: 'raw' | 'processing' | 'analyzed' | 'clustered' | 'ready' | 'error';
  cluster_id?: string;
  
  // Security validation
  security_status: SecurityStatus;
  validation_results?: ValidationResults;
  
  // Analysis results
  entities?: EntityExtraction[];
  topics?: TopicAnalysis[];
  sentiment_score?: number;
  language?: string;
  word_count?: number;
  
  // Embeddings and relationships
  embeddings?: number[];
  similar_content_ids?: string[];
  
  metadata: Record<string, any>;
}

export interface QualityMetrics {
  overall_score: number; // 0-1
  relevance_score: number; // 0-1
  freshness_score: number; // 0-1
  authority_score: number; // 0-1
  completeness_score: number; // 0-1
  uniqueness_score: number; // 0-1 (inverse of duplication)
  confidence_level: number; // 0-1
}

export interface SecurityStatus {
  status: 'pending' | 'safe' | 'suspicious' | 'blocked';
  threats_detected: string[];
  sandbox_processed: boolean;
  validation_timestamp: Date;
  risk_score: number; // 0-1
}

export interface ValidationResults {
  content_safety: boolean;
  url_safety: boolean;
  malware_detected: boolean;
  phishing_detected: boolean;
  spam_score: number;
  validation_errors: string[];
}

export interface EntityExtraction {
  text: string;
  type: 'person' | 'organization' | 'location' | 'date' | 'money' | 'technology' | 'misc';
  confidence: number;
  start_pos: number;
  end_pos: number;
  normalized_form?: string;
  external_id?: string; // Link to knowledge base
}

export interface TopicAnalysis {
  topic: string;
  relevance: number;
  keywords: string[];
  confidence: number;
}

export interface DigiMCluster {
  id: string;
  name: string;
  description?: string;
  category: string;
  content_ids: string[];
  cluster_metrics: {
    size: number;
    avg_quality: number;
    coherence_score: number; // How related the content is
    freshness: number; // How recent the content is
    diversity: number; // How varied the sources are
  };
  representative_content?: DigiMContent; // Best example of cluster
  thumbnail_url?: string;
  created_at: Date;
  updated_at: Date;
}

export interface DigiMIntelligence {
  query_hash: string;
  query_text: string;
  intelligence_level: 'surface' | 'deep' | 'predictive';
  results: {
    summary: string;
    key_insights: string[];
    trends?: TrendAnalysis[];
    predictions?: PredictionAnalysis[];
    entities?: EntityExtraction[];
    topics?: TopicAnalysis[];
  };
  source_content: DigiMContent[];
  clusters_analyzed?: DigiMCluster[];
  confidence_score: number;
  processing_metadata: {
    model_used: string;
    processing_time_ms: number;
    sources_consulted: number;
    analysis_depth: string;
  };
  generated_at: Date;
  expires_at?: Date;
}

export interface TrendAnalysis {
  trend_name: string;
  direction: 'rising' | 'falling' | 'stable' | 'volatile';
  strength: number; // 0-1
  time_period: { start: Date; end: Date };
  evidence: string[];
  confidence: number;
}

export interface PredictionAnalysis {
  prediction: string;
  probability: number; // 0-1
  time_horizon: string; // "1 week", "1 month", etc.
  confidence: number;
  factors: string[];
  supporting_evidence: string[];
}

export interface DigiMGenerated {
  id: string;
  type: 'article' | 'report' | 'summary' | 'feed_item';
  title: string;
  content: string;
  summary?: string;
  thumbnail_url?: string;
  
  // Generation metadata
  source_content_ids: string[];
  template_used?: string;
  style: string;
  length_category: string;
  word_count: number;
  reading_time_minutes: number;
  
  // Quality and confidence
  generation_confidence: number;
  fact_check_status: 'pending' | 'verified' | 'disputed' | 'false';
  
  // Output metadata
  generated_by: string; // model or user
  generated_at: Date;
  view_count?: number;
  user_ratings?: number[];
  
  metadata: Record<string, any>;
}

export interface DigiMSystemStatus {
  overall_health: 'healthy' | 'degraded' | 'critical';
  components: {
    gatherer: ComponentStatus;
    analyzer: ComponentStatus;
    security: ComponentStatus;
    database: ComponentStatus;
  };
  statistics: {
    total_sources: number;
    active_sources: number;
    total_content: number;
    content_by_status: Record<string, number>;
    total_clusters: number;
    processing_queue_size: number;
    avg_processing_time_ms: number;
  };
  performance: {
    cpu_usage: number;
    memory_usage: number;
    active_workers: number;
    cache_hit_ratio: number;
  };
  security: {
    threats_blocked: number;
    content_quarantined: number;
    validation_success_rate: number;
  };
  last_updated: Date;
}

export interface ComponentStatus {
  status: 'operational' | 'degraded' | 'down';
  last_check: Date;
  uptime_percentage: number;
  error_count: number;
  performance_score: number; // 0-1
}

export interface DigiMExportResult {
  export_id: string;
  format: string;
  file_url?: string;
  file_size_bytes?: number;
  content_count: number;
  generated_at: Date;
  expires_at: Date;
  metadata: Record<string, any>;
}

// ================================
// ERROR TYPES
// ================================

export interface DigiMError {
  code: string;
  message: string;
  component: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details?: any;
  timestamp: Date;
  user_id?: string;
  request_id?: string;
}

// ================================
// CONFIGURATION TYPES
// ================================

export interface DigiMConfig {
  gathering: {
    max_concurrent_sources: number;
    default_crawl_delay_ms: number;
    max_content_size_mb: number;
    content_retention_days: number;
  };
  processing: {
    worker_threads: number;
    batch_size: number;
    max_processing_time_ms: number;
    embedding_model: string;
  };
  security: {
    sandbox_enabled: boolean;
    max_sandbox_memory_mb: number;
    max_sandbox_time_ms: number;
    threat_detection_enabled: boolean;
  };
  intelligence: {
    default_intelligence_level: 'surface' | 'deep' | 'predictive';
    cache_ttl_hours: number;
    max_query_results: number;
    quality_threshold: number;
  };
}

// ================================
// UTILITY TYPES
// ================================

export type DigiMEventType = 
  | 'content_gathered'
  | 'content_processed'
  | 'cluster_created'
  | 'intelligence_generated'
  | 'security_threat_detected'
  | 'source_error'
  | 'system_health_change';

export interface DigiMEvent {
  id: string;
  type: DigiMEventType;
  timestamp: Date;
  component: string;
  data: any;
  severity: 'info' | 'warning' | 'error' | 'critical';
}

// ================================
// TYPE GUARDS
// ================================

// Type guards for request validation
export function isDigiMMessage(message: DinaUniversalMessage): message is DigiMMessage {
  return message.target.module === 'digim' && 
         message.target.method.startsWith('digim_');
}

export function isDigiMMethod(method: string): method is DigiMMethod {
  const digiMethods: DigiMMethod[] = [
    'digim_gather', 'digim_query', 'digim_analyze', 'digim_generate',
    'digim_cluster', 'digim_export', 'digim_status', 'digim_sources', 'digim_security'
  ];
  return digiMethods.includes(method as DigiMMethod);
}


