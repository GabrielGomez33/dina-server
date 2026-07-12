// DIGIM Main Orchestrator - Phase 1 Foundation
// File: src/modules/digim/index.ts

import { performance } from 'perf_hooks';
import { v4 as uuidv4 } from 'uuid';
// ✅ ADD MISSING IMPORT
import { DinaUniversalMessage, DinaResponse, DinaProtocol, createDinaResponse } from '../../core/protocol';
import { database } from '../../config/database/db';
import { redisManager } from '../../config/redis';
import { contextMemorySystem, llmIntelligenceEngine } from '../llm/intelligence';
// Web-research subsystem (self-contained; additive; config-gated default-off).
import { getWebResearchOrchestrator, WebResearchOrchestrator, IntelligenceLevel, checkUrlSafety } from './web';
import {
  DigiMMessage,
  DigiMResponse,
  DigiMRequestData,
  DigiMMethod,
  DigiMSystemStatus,
  DigiMSource,
  DigiMContent,
  DigiMConfig,
  isDigiMMessage,
  isDigiMMethod
} from './types';

// ================================
// DIGIM CORE ORCHESTRATOR
// ================================

export class DigiMOrchestrator {
  private initialized: boolean = false;
  private config: DigiMConfig;
  private startTime: Date = new Date();
  private activeSources: Map<string, DigiMSource> = new Map();
  private gatheringIntervals: Map<string, NodeJS.Timeout> = new Map();
  private moduleHealth: 'healthy' | 'degraded' | 'critical' = 'healthy';
  // Web-research subsystem — its own concern, its own LLM instance. Constructed
  // lazily (no I/O); only does work when DIGIM_WEB_ENABLED=true.
  private webResearch: WebResearchOrchestrator = getWebResearchOrchestrator();

  constructor() {
    console.log('🧠 Initializing DIGIM Orchestrator...');
    this.config = this.loadDefaultConfig();
  }

  // ✅ ADD MISSING NORMALIZATION METHOD
  private normalizeMessage(message: DinaUniversalMessage): DinaUniversalMessage {
    const normalized = JSON.parse(JSON.stringify(message)); // Deep clone
    
    console.log('🔧 DIGIM NORMALIZING MESSAGE - Before:', {
      sourceModule: message.source?.module,
      sourceModuleType: typeof message.source?.module,
      targetModule: message.target?.module,
      targetModuleType: typeof message.target?.module
    });
    
    // Fix nested source.module structure
    if (normalized.source?.module && typeof normalized.source.module === 'object') {
      const sourceModule = normalized.source.module as any;
      if (sourceModule.module && typeof sourceModule.module === 'string') {
        console.log(`🔧 DIGIM: Fixing nested source.module: ${JSON.stringify(sourceModule)} → "${sourceModule.module}"`);
        normalized.source = {
          ...normalized.source,
          module: sourceModule.module,
          instance: sourceModule.instance || normalized.source.instance,
          version: sourceModule.version || normalized.source.version
        };
      }
    }
    
    // Fix nested target.module structure  
    if (normalized.target?.module && typeof normalized.target.module === 'object') {
      const targetModule = normalized.target.module as any;
      if (targetModule.module && typeof targetModule.module === 'string') {
        console.log(`🔧 DIGIM: Fixing nested target.module: ${JSON.stringify(targetModule)} → "${targetModule.module}"`);
        normalized.target = {
          ...normalized.target,
          module: targetModule.module,
          method: normalized.target.method || targetModule.method,
          priority: normalized.target.priority || targetModule.priority
        };
      }
    }
    
    console.log('🔧 DIGIM NORMALIZING MESSAGE - After:', {
      sourceModule: normalized.source?.module,
      sourceModuleType: typeof normalized.source?.module,
      targetModule: normalized.target?.module,
      targetModuleType: typeof normalized.target?.module
    });
    
    return normalized;
  }

  // ================================
  // INITIALIZATION
  // ================================

async  initialize(): Promise<void> {
    if (this.initialized) {
      console.log('ℹ️ DIGIM already initialized');
      return;
    }

    console.log('🚀 Starting DIGIM Phase 1 initialization...');
    
    try {
      // Step 1: Initialize database schemas
      await this.initializeDatabaseSchemas();
      console.log('✅ DIGIM database schemas initialized');

      // Step 2: Load existing sources
      await this.loadExistingSources();
      console.log('✅ Existing data sources loaded');

      // Step 3: Initialize security and validation systems
      await this.initializeSecuritySystems();
      console.log('✅ Security systems initialized');

      // Step 4: Start monitoring and health checks
      this.startHealthMonitoring();
     console.log('✅ Health monitoring started');

      // Step 5: Initialize the web-research subsystem (non-fatal, self-gating).
      // When DIGIM_WEB_ENABLED is not set this is a cheap no-op — it does not
      // touch the network or spin up an LLM, so it cannot disrupt startup.
      try {
        await this.webResearch.initialize();
        console.log(`✅ DIGIM web-research subsystem ready (enabled=${this.webResearch.enabled}, provider=${this.webResearch.providerName})`);
      } catch (webErr) {
        // Never let the optional subsystem break DIGIM startup.
        console.warn(`⚠️ DIGIM web-research init degraded (continuing): ${(webErr as Error).message}`);
      }

      this.initialized = true;
      this.moduleHealth = 'healthy';
      
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('✅ DIGIM Phase 1 initialization complete!');
      console.log('🔹 Features available:');
      console.log('  • DUMP protocol integration');
      console.log('  • Database schema foundation');
      console.log('  • Security sandbox preparation');
      console.log('  • Source management framework');
      console.log('  • Health monitoring system');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      // Log successful initialization
      await database.log('info', 'digim', 'DIGIM Phase 1 initialized successfully', {
        phase: 'foundation',
        features: ['protocol-integration', 'database-schemas', 'security-framework', 'health-monitoring']
      });

    } catch (error) {
      this.initialized = false;
      this.moduleHealth = 'critical';
      console.error('❌ DIGIM initialization failed:', error);
      
      await database.log('error', 'digim', 'DIGIM initialization failed', {
        error: (error as Error).message,
        phase: 'foundation'
      });
      
      throw error;
    }
  }

  // ================================
  // MAIN REQUEST HANDLER (DUMP PROTOCOL) - ✅ UPDATED
  // ================================

  async handleIncomingMessage(message: DinaUniversalMessage): Promise<DinaResponse> {
  const startTime = performance.now();
  console.log(`📥 DIGIM processing request: ${message.target.method}`);

  // ✅ ADD NORMALIZATION STEP
  const normalizedMessage = this.normalizeMessage(message);

  try {
    // ✅ VALIDATE AND SANITIZE NORMALIZED MESSAGE
    if (!DinaProtocol.validateMessage(normalizedMessage)) {
      throw new Error('Invalid DINA message: Protocol validation failed');
    }

    const sanitizedMessage = DinaProtocol.sanitizeMessage(normalizedMessage);

    // ✅ FINAL SAFETY CHECK
    if (!sanitizedMessage.target || typeof sanitizedMessage.target.module !== 'string') {
      throw new Error(
        `CRITICAL: target.module is not a string after normalization! ` +
        `Type: ${typeof sanitizedMessage.target?.module}, ` +
        `Value: ${JSON.stringify(sanitizedMessage.target?.module)}`
      );
    }

    // ✅ VALIDATE THIS IS A DIGIM MESSAGE AND CAST TO DigiMMessage
    if (!isDigiMMessage(sanitizedMessage)) {
      throw new Error('Invalid DIGIM message format');
    }

    // ✅ NOW SAFE TO CAST - TypeScript knows this is a DigiMMessage
    const digiMMessage = sanitizedMessage as DigiMMessage;

    // Check if DIGIM is initialized
    if (!this.initialized) {
      throw new Error('DIGIM not initialized');
    }

    // ✅ USE CAST MESSAGE FOR VALIDATION AND ROUTING
    await this.validateUserPermissions(digiMMessage);

    // Route to appropriate handler
    const result = await this.routeRequest(digiMMessage);

    // Create successful response
    const processingTime = performance.now() - startTime;
    const response = createDinaResponse({
      request_id: sanitizedMessage.id,
      status: 'success',
      payload: result,
      metrics: {
        processing_time_ms: processingTime,
        model_used: 'digim-orchestrator'
      }
    });

    console.log(`✅ DIGIM request completed: ${sanitizedMessage.target.method} (${processingTime.toFixed(2)}ms)`);
    return response;

  } catch (error) {
    const processingTime = performance.now() - startTime;
    console.error(`❌ DIGIM request failed: ${normalizedMessage.target.method}`, error);

    // Log error for monitoring
    await database.log('error', 'digim', 'Request processing failed', {
      method: normalizedMessage.target.method,
      error: (error as Error).message,
      user_id: normalizedMessage.security.user_id,
      processing_time_ms: processingTime
    });

    // Create error response
    return createDinaResponse({
      request_id: normalizedMessage.id,
      status: 'error',
      payload: { error: true },
      metrics: { processing_time_ms: processingTime },
      error: {
        code: 'DIGIM_PROCESSING_ERROR',
        message: (error as Error).message,
        details: { method: normalizedMessage.target.method }
      }
    });
  }
}
  // ================================
  // REQUEST ROUTING
  // ================================

  private async routeRequest(message: DigiMMessage): Promise<any> {
    const { method } = message.target;
    const requestData = message.payload.data;

    console.log(`🔀 Routing DIGIM request: ${method}`);

    switch (method) {
      case 'digim_status':
        return await this.handleStatusRequest(requestData);

      case 'digim_sources':
        return await this.handleSourcesRequest(requestData, message.security.user_id);

      case 'digim_gather':
        return await this.handleGatherRequest(requestData, message.security.user_id);

      case 'digim_research':
        return await this.handleResearchRequest(requestData, message.security.user_id);

      case 'digim_investigate':
        return await this.handleInvestigateRequest(requestData, message.security.user_id);

      case 'digim_search':
        return await this.handleSearchRequest(requestData);

      case 'digim_recall':
        return await this.handleRecallRequest(requestData, message.security.user_id);

      case 'digim_graph':
        return await this.handleGraphRequest(requestData);

      case 'digim_memory_backfill':
        return await this.handleMemoryBackfillRequest(requestData);

      case 'digim_memory_prune':
        return await this.handleMemoryPruneRequest();

      case 'digim_query':
        return await this.handleQueryRequest(requestData, message.security.user_id);

      case 'digim_analyze':
        return await this.handleAnalyzeRequest(requestData, message.security.user_id);

      case 'digim_generate':
        return await this.handleGenerateRequest(requestData, message.security.user_id);

      case 'digim_cluster':
        return await this.handleClusterRequest(requestData, message.security.user_id);

      case 'digim_export':
        return await this.handleExportRequest(requestData, message.security.user_id);

      case 'digim_security':
        return await this.handleSecurityRequest(requestData, message.security.user_id);

      default:
        throw new Error(`Unknown DIGIM method: ${method}`);
    }
  }

  // ================================
  // REQUEST HANDLERS (Phase 1 Implementations)
  // ================================

  private async handleStatusRequest(requestData: any): Promise<DigiMSystemStatus> {
    console.log('📊 Generating DIGIM system status...');

    const statistics = await this.getSystemStatistics();
    const performance = await this.getPerformanceMetrics();
    const security = await this.getSecurityMetrics();

    const status: DigiMSystemStatus = {
      overall_health: this.moduleHealth,
      components: {
        gatherer: {
          status: 'operational',
          last_check: new Date(),
          uptime_percentage: 100,
          error_count: 0,
          performance_score: 1.0
        },
        analyzer: {
          status: 'operational',
          last_check: new Date(),
          uptime_percentage: 100,
          error_count: 0,
          performance_score: 1.0
        },
        security: {
          status: 'operational',
          last_check: new Date(),
          uptime_percentage: 100,
          error_count: 0,
          performance_score: 1.0
        },
        database: {
          status: database.isConnected ? 'operational' : 'down',
          last_check: new Date(),
          uptime_percentage: database.isConnected ? 100 : 0,
          error_count: 0,
          performance_score: database.isConnected ? 1.0 : 0.0
        }
      },
      statistics,
      performance,
      security,
      last_updated: new Date()
    };

    // Surface web-research subsystem status (enabled? provider wired up?).
    (status as any).web_research = this.webResearch.getStatus();

    console.log(`✅ System status generated: ${status.overall_health}`);
    return status;
  }

  private async handleSourcesRequest(requestData: any, userId?: string): Promise<any> {
    console.log(`📂 Handling sources request: ${requestData.action}`);
    
    switch (requestData.action) {
      case 'list':
        return await this.listSources();
      
      case 'add':
        if (!requestData.source) {
          throw new Error('Source data required for add action');
        }
        return await this.addSource(requestData.source, userId);
      
      case 'test':
        if (!requestData.source_id) {
          throw new Error('Source ID required for test action');
        }
        return await this.testSource(requestData.source_id);
      
      default:
        throw new Error(`Unsupported sources action: ${requestData.action}`);
    }
  }

  private async handleGatherRequest(requestData: any, userId?: string): Promise<any> {
    console.log('🔍 Handling gather request');

    // When the web-research subsystem is enabled, actually surf + collect.
    if (this.webResearch.enabled) {
      const query: string = (requestData?.query || requestData?.q || '').trim();
      const seedUrls: string[] = Array.isArray(requestData?.seed_urls) ? requestData.seed_urls : [];
      if (!query && seedUrls.length === 0) {
        throw new Error('digim_gather requires a "query" or "seed_urls"');
      }
      const gather = await this.webResearch.gather(query, {
        maxDocuments: requestData?.max_documents,
        seedUrls,
        userId,
        browserMode: normalizeBrowserMode(requestData?.browser_mode),
      });
      return {
        status: 'completed',
        query: gather.query,
        documents_gathered: gather.documents.length,
        documents: gather.documents.map((d) => ({
          id: d.id,
          title: d.title,
          url: d.url,
          published_at: d.publishedAt,
          word_count: d.wordCount,
          quality: d.quality,
          duplicate: d.duplicate,
        })),
        diagnostics: gather.diagnostics,
        duration_ms: gather.durationMs,
        provider: gather.diagnostics.searchProvider,
      };
    }

    // Disabled → the original Phase-1 placeholder (unchanged behavior).
    return {
      status: 'queued',
      message: 'Content gathering queued for processing (web-research disabled — set DIGIM_WEB_ENABLED=true)',
      sources_queued: requestData.source_ids?.length || 0,
      estimated_completion: new Date(Date.now() + 300000), // 5 minutes
      phase: 'foundation'
    };
  }

  /**
   * digim_research — the headline capability: surf the web for the query,
   * gather + score sources, then synthesize a grounded WebInsight.
   */
  private async handleResearchRequest(requestData: any, userId?: string): Promise<any> {
    const query: string = (requestData?.query || requestData?.q || '').trim();
    const seedUrls: string[] = Array.isArray(requestData?.seed_urls) ? requestData.seed_urls : [];
    console.log(`🌐 Handling research request: "${query.substring(0, 60)}..."`);

    if (!this.webResearch.enabled) {
      return {
        status: 'disabled',
        message: 'DIGIM web-research is disabled. Set DIGIM_WEB_ENABLED=true and configure DIGIM_WEB_SEARCH_PROVIDER to enable.',
        phase: 'foundation',
      };
    }
    if (!query && seedUrls.length === 0) {
      throw new Error('digim_research requires a "query" or "seed_urls"');
    }

    const level = normalizeIntelligenceLevel(requestData?.intelligence_level);
    const result = await this.webResearch.research(query, {
      level,
      maxDocuments: requestData?.max_documents,
      seedUrls,
      userId,
      forceRefresh: requestData?.force_refresh === true,
      browserMode: normalizeBrowserMode(requestData?.browser_mode),
    });

    return {
      status: 'success',
      query: result.query,
      intelligence_level: result.level,
      cached: result.cached,
      // Transparency: where did this answer come from? 'web' = freshly gathered,
      // 'memory' = recalled from prior research (0 fetched this run), 'web+memory'
      // = both, 'cache' = served from the intelligence cache, 'none' = nothing.
      basis: result.basis,
      documents_gathered: result.gather.documents.length,
      memory_used: result.memoryUsed,
      graph_relationships_added: result.graphAdded,
      insight: result.insight,
      sources_consulted: result.insight.sources.length,
      diagnostics: result.gather.diagnostics,
      intelligence_id: result.intelligenceId,
      processing_time_ms: Math.round(result.processingTimeMs),
      generated_at: new Date(),
    };
  }

  /**
   * digim_investigate — multi-facet investigation (Phase 2.4a): decompose a broad
   * question into sub-queries, research each through the pipeline, and fuse into
   * one comprehensive, provenance-tracked briefing.
   */
  private async handleInvestigateRequest(requestData: any, userId?: string): Promise<any> {
    const query: string = (requestData?.query || requestData?.q || '').trim();
    console.log(`🧭 Handling investigate request: "${query.substring(0, 60)}..."`);

    if (!this.webResearch.enabled) {
      return {
        status: 'disabled',
        message: 'DIGIM web-research is disabled. Set DIGIM_WEB_ENABLED=true.',
      };
    }
    if (!query) {
      throw new Error('digim_investigate requires a "query"');
    }

    const level = normalizeIntelligenceLevel(requestData?.intelligence_level);
    const result = await this.webResearch.investigate(query, { level });

    return {
      status: 'success',
      query: result.query,
      intelligence_level: result.level,
      facets_planned: result.facetsPlanned,
      plan: result.plan,
      facets: result.facets.map((f) => ({
        facet: f.facet,
        query: f.query,
        basis: f.basis,
        documents_gathered: f.documentsGathered,
        summary: f.insight.summary,
        key_insights: f.insight.keyInsights,
      })),
      insight: result.synthesis,
      sources_consulted: result.sourcesConsulted,
      processing_time_ms: Math.round(result.processingTimeMs),
      generated_at: new Date(),
    };
  }

  /**
   * digim_graph — query the relationship graph: the subgraph around a focus term
   * (nodes + edges + provenance) plus the view the system recommends for it.
   */
  private async handleGraphRequest(requestData: any): Promise<any> {
    const focus: string = (requestData?.query || requestData?.focus || requestData?.q || '').trim();
    console.log(`🕸️ Handling graph request: "${focus.substring(0, 60)}..."`);

    if (!this.webResearch.enabled) {
      return { status: 'disabled', message: 'DIGIM web-research is disabled. Set DIGIM_WEB_ENABLED=true.' };
    }
    if (!focus) {
      throw new Error('digim_graph requires a "query" (focus entity/topic)');
    }

    const sub = await this.webResearch.graph(focus, { maxNodes: requestData?.max_nodes });
    const stats = await this.webResearch.getGraphStats();
    // Resolve edge endpoints to names so the relationships are directly readable.
    const nameById = new Map(sub.nodes.map((n) => [n.id, n.name]));
    return {
      status: 'success',
      focus: sub.focus,
      matched_focus: sub.matchedFocus,
      suggested_view: sub.suggestedView,
      node_count: sub.nodes.length,
      edge_count: sub.edges.length,
      nodes: sub.nodes.map((n) => ({
        id: n.id, name: n.name, type: n.type,
        occurred_at: n.occurredAt, weight: n.mentionCount,
      })),
      edges: sub.edges.map((e) => ({
        from: nameById.get(e.subjectId) || e.subjectId,
        predicate: e.predicate,
        to: nameById.get(e.objectId) || e.objectId,
        corroboration: e.corroborationCount, confidence: e.confidence,
        occurred_at: e.occurredAt, sources: e.sources || [],
      })),
      graph_totals: stats,
      generated_at: new Date(),
    };
  }

  /**
   * digim_search — discovery inspection: run the search provider and show the
   * candidate URLs (each SSRF-annotated) WITHOUT fetching. Lets you see what
   * DINA would gather, and confirm the provider is wired up, before researching.
   */
  private async handleSearchRequest(requestData: any): Promise<any> {
    const query: string = (requestData?.query || requestData?.q || '').trim();
    console.log(`🔎 Handling search/discovery request: "${query.substring(0, 60)}..."`);

    if (!this.webResearch.enabled) {
      return {
        status: 'disabled',
        message: 'DIGIM web-research is disabled. Set DIGIM_WEB_ENABLED=true.',
      };
    }
    if (!query) {
      throw new Error('digim_search requires a "query"');
    }

    const result = await this.webResearch.discover(query, { limit: requestData?.limit });
    return {
      status: 'success',
      query: result.query,
      provider: result.provider,
      provider_configured: result.configured,
      candidate_count: result.candidates.length,
      candidates: result.candidates.map((c) => ({
        title: c.title,
        url: c.url,
        snippet: c.snippet,
        provider: c.provider,
        safe: c.safe,
        safety_reason: c.safetyReason,
      })),
      generated_at: new Date(),
    };
  }

  /**
   * digim_recall — retrieve documents from semantic memory by meaning, without
   * gathering anything new. This is DINA reasoning over what it already knows.
   */
  private async handleRecallRequest(requestData: any, userId?: string): Promise<any> {
    const query: string = (requestData?.query || requestData?.q || '').trim();
    console.log(`🧩 Handling recall request: "${query.substring(0, 60)}..."`);

    if (!this.webResearch.enabled) {
      return {
        status: 'disabled',
        message: 'DIGIM web-research is disabled. Set DIGIM_WEB_ENABLED=true to enable semantic memory.',
        phase: 'foundation',
      };
    }
    if (!query) {
      throw new Error('digim_recall requires a "query"');
    }

    const memories = await this.webResearch.recall(query, {
      topK: requestData?.top_k,
      minScore: requestData?.min_score,
    });

    return {
      status: 'success',
      query,
      count: memories.length,
      memories: memories.map((m) => ({
        id: m.id,
        title: m.title,
        url: m.url,
        published_at: m.publishedAt,
        score: m.score,
        vector_score: m.vectorScore,
        excerpt: (m.content || '').slice(0, 300),
      })),
      generated_at: new Date(),
    };
  }

  /**
   * digim_memory_backfill — embed content still marked 'pending' into semantic
   * memory (maintenance: populate memory for pre-Phase-1 content, or repair
   * after a Redis data loss). Admin-only at the route layer.
   */
  private async handleMemoryBackfillRequest(requestData: any): Promise<any> {
    if (!this.webResearch.enabled) {
      return { status: 'disabled', message: 'DIGIM web-research is disabled. Set DIGIM_WEB_ENABLED=true.' };
    }
    const limit = typeof requestData?.limit === 'number' ? requestData.limit : 100;
    const result = await this.webResearch.backfillMemory(limit);
    return {
      status: 'success',
      ...result,
      message: `Backfill complete: ${result.embedded} embedded, ${result.failed} failed of ${result.processed} pending`,
      generated_at: new Date(),
    };
  }

  /**
   * digim_memory_prune — run the retention sweep on demand: delete aged content
   * (+ their vectors) and expired cached intelligence. Admin-only at the route.
   */
  private async handleMemoryPruneRequest(): Promise<any> {
    if (!this.webResearch.enabled) {
      return { status: 'disabled', message: 'DIGIM web-research is disabled. Set DIGIM_WEB_ENABLED=true.' };
    }
    const result = await this.webResearch.prune();
    return {
      status: 'success',
      ...result,
      message: `Retention sweep: ${result.contentDeleted} content + ${result.vectorsRemoved} vectors + ${result.intelligencePruned} intelligence removed`,
      generated_at: new Date(),
    };
  }

  private async handleQueryRequest(requestData: any, userId?: string): Promise<any> {
    console.log(`🧠 Handling query request: "${requestData.query?.substring(0, 50)}..."`);

    // When web-research is enabled, a natural-language query IS a research run.
    if (this.webResearch.enabled && (requestData?.query || '').trim()) {
      const level = normalizeIntelligenceLevel(requestData?.intelligence_level);
      const result = await this.webResearch.research(String(requestData.query).trim(), {
        level,
        maxDocuments: requestData?.max_results,
        userId,
      });
      return {
        query: result.query,
        intelligence_level: result.level,
        cached: result.cached,
        results: {
          summary: result.insight.summary,
          key_insights: result.insight.keyInsights,
          entities: result.insight.entities,
          topics: result.insight.topics,
          trends: result.insight.trends,
          confidence_score: result.insight.confidence,
          caveats: result.insight.caveats,
          sources: result.insight.sources,
        },
        processing_metadata: {
          model_used: this.webResearch.enabled ? 'digim-web-research' : 'digim-orchestrator',
          processing_time_ms: Math.round(result.processingTimeMs),
          sources_consulted: result.insight.sources.length,
          analysis_depth: result.level,
        },
        generated_at: new Date(),
      };
    }

    // Disabled → the original Phase-1 complexity-only placeholder (unchanged).
    try {
      const complexity = await llmIntelligenceEngine.analyzeQuery(requestData.query);

      return {
        query: requestData.query,
        intelligence_level: requestData.intelligence_level || 'surface',
        results: {
          summary: `Query analysis complete. Complexity level: ${complexity.level}/10`,
          key_insights: [
            'DIGIM intelligence gathering system is in Phase 1',
            'Query complexity analysis completed using existing LLM intelligence',
            'Enable web-research (DIGIM_WEB_ENABLED=true) for full query processing'
          ],
          confidence_score: complexity.confidence
        },
        processing_metadata: {
          model_used: complexity.recommendedModel,
          processing_time_ms: 0,
          sources_consulted: 0,
          analysis_depth: 'foundation'
        },
        generated_at: new Date(),
        phase: 'foundation'
      };
    } catch (error) {
      throw new Error(`Query processing failed: ${(error as Error).message}`);
    }
  }

  private async handleAnalyzeRequest(requestData: any, userId?: string): Promise<any> {
    console.log('🔬 Handling analyze request (Phase 1 placeholder)');
    
    return {
      analysis_type: requestData.analysis_type || 'quality',
      results: {
        message: 'Analysis capabilities will be available in Phase 2',
        placeholder: true
      },
      phase: 'foundation'
    };
  }

  private async handleGenerateRequest(requestData: any, userId?: string): Promise<any> {
    console.log('📝 Handling generate request (Phase 1 placeholder)');
    
    return {
      generation_type: requestData.output_type,
      status: 'pending',
      message: 'Content generation will be available in Phase 3',
      phase: 'foundation'
    };
  }

  private async handleClusterRequest(requestData: any, userId?: string): Promise<any> {
    console.log('🔗 Handling cluster request (Phase 1 placeholder)');
    
    return {
      clusters: [],
      message: 'Content clustering will be available in Phase 2',
      phase: 'foundation'
    };
  }

  private async handleExportRequest(requestData: any, userId?: string): Promise<any> {
    console.log('📤 Handling export request (Phase 1 placeholder)');
    
    return {
      export_format: requestData.format,
      status: 'pending',
      message: 'Export capabilities will be available in Phase 4',
      phase: 'foundation'
    };
  }

  private async handleSecurityRequest(requestData: any, userId?: string): Promise<any> {
    console.log('🔒 Handling security request');
    
    switch (requestData.action) {
      case 'scan':
        return await this.performSecurityScan();
      
      case 'validate':
        return await this.validateSecurityStatus();
      
      default:
        return {
          action: requestData.action,
          status: 'completed',
          message: 'Security framework operational',
          phase: 'foundation'
        };
    }
  }

  // ================================
  // DATABASE INITIALIZATION
  // ================================

  private async initializeDatabaseSchemas(): Promise<void> {
    console.log('📊 Initializing DIGIM database schemas...');

    // Add DIGIM tables to existing database using the established pattern
    const digiMTables = {
      'digim_sources': `CREATE TABLE IF NOT EXISTS digim_sources (
                  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
                  name VARCHAR(255) NOT NULL,
                  category ENUM('news', 'documents', 'academic') NOT NULL,
                  subcategory VARCHAR(100) NOT NULL,
                  source_type ENUM('web', 'api', 'rss', 'file') NOT NULL,
                  url TEXT,
                  config JSON, -- REMOVE DEFAULT '{}'
                  schedule_type ENUM('realtime', 'hourly', 'daily', 'manual') DEFAULT 'hourly',
                  trust_level DECIMAL(3,2) DEFAULT 0.80,
                  is_active BOOLEAN DEFAULT TRUE,
                  last_gathered TIMESTAMP NULL,
                  metadata JSON, -- REMOVE DEFAULT '{}'
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  created_by VARCHAR(36),
                  INDEX idx_category_active (category, subcategory, is_active),
                  INDEX idx_schedule_trust (schedule_type, trust_level),
                  INDEX idx_created_by (created_by),
                  CHECK (trust_level >= 0.00 AND trust_level <= 1.00)
              ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
            
              'digim_content': `CREATE TABLE IF NOT EXISTS digim_content (
                  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
                  source_id VARCHAR(36) NULL, -- nullable: ad-hoc web docs need no configured source (migration 001)
                  content_hash VARCHAR(64) UNIQUE NOT NULL,
                  title TEXT,
                  content LONGTEXT NOT NULL,
                  url TEXT NOT NULL,
                  author VARCHAR(255),
                  published_at TIMESTAMP,
                  gathered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  quality_score DECIMAL(5,4) DEFAULT 0.0000,
                  relevance_score DECIMAL(5,4) DEFAULT 0.0000,
                  freshness_score DECIMAL(5,4) DEFAULT 0.0000,
                  authority_score DECIMAL(5,4) DEFAULT 0.0000,
                  processing_status ENUM('raw', 'processing', 'analyzed', 'clustered', 'ready', 'error') DEFAULT 'raw',
                  cluster_id VARCHAR(36),
                  security_status ENUM('pending', 'safe', 'suspicious', 'blocked') DEFAULT 'pending',
                  validation_results JSON,
                  entities JSON,
                  topics JSON,
                  sentiment_score DECIMAL(5,4),
                  language VARCHAR(10),
                  word_count INT UNSIGNED,
                  metadata JSON,
                  -- Phase 1 semantic-memory bookkeeping (vectors live in Redis; MySQL tracks status)
                  embedding_status ENUM('pending','embedded','failed','skipped') NOT NULL DEFAULT 'pending',
                  embedded_at TIMESTAMP NULL,
                  embedding_model VARCHAR(100) NULL,
                  embedding_ref VARCHAR(128) NULL, -- Redis vector id
                  CONSTRAINT fk_digim_content_source FOREIGN KEY (source_id) REFERENCES digim_sources(id) ON DELETE SET NULL,
                  INDEX idx_content_hash (content_hash),
                  INDEX idx_cluster_status (cluster_id, processing_status),
                  INDEX idx_quality_metrics (quality_score DESC, relevance_score DESC),
                  INDEX idx_security_status (security_status, gathered_at),
                  INDEX idx_published_fresh (published_at DESC, freshness_score DESC),
                  INDEX idx_embedding_status (embedding_status, gathered_at),
                  FULLTEXT idx_content_search (title, content),
                  CHECK (quality_score >= 0.0000 AND quality_score <= 1.0000),
                  CHECK (relevance_score >= 0.0000 AND relevance_score <= 1.0000),
                  CHECK (freshness_score >= 0.0000 AND freshness_score <= 1.0000),
                  CHECK (authority_score >= 0.0000 AND authority_score <= 1.0000)
              ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
            
              'digim_intelligence': `CREATE TABLE IF NOT EXISTS digim_intelligence (
                  id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
                  query_hash VARCHAR(64) NOT NULL,
                  user_id VARCHAR(36),
                  intelligence_type ENUM('surface', 'deep', 'predictive') NOT NULL,
                  query_text TEXT NOT NULL,
                  source_content_ids JSON NOT NULL,
                  summary TEXT,
                  insights JSON,
                  trends JSON,
                  predictions JSON,
                  confidence_score DECIMAL(5,4) DEFAULT 0.0000,
                  raw_data JSON,
                  formatted_output JSON,
                  generated_content TEXT,
                  visual_elements JSON,
                  processing_time_ms INT UNSIGNED,
                  model_used VARCHAR(100),
                  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  expires_at TIMESTAMP,
                  INDEX idx_query_hash (query_hash),
                  INDEX idx_user_type (user_id, intelligence_type),
                  INDEX idx_confidence (confidence_score DESC),
                  INDEX idx_generated_expires (generated_at DESC, expires_at),
                  CHECK (confidence_score >= 0.0000 AND confidence_score <= 1.0000)
              ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
            
              'digim_clusters': `CREATE TABLE IF NOT EXISTS digim_clusters (
                id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
                name VARCHAR(255) NOT NULL,
                description TEXT,
                category VARCHAR(100) NOT NULL,
                content_count INT UNSIGNED DEFAULT 0,
                avg_quality_score DECIMAL(5,4) DEFAULT 0.0000,
                coherence_score DECIMAL(5,4) DEFAULT 0.0000,
                freshness_score DECIMAL(5,4) DEFAULT 0.0000,
                diversity_score DECIMAL(5,4) DEFAULT 0.0000,
                representative_content_id VARCHAR(36),
                thumbnail_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                
                INDEX idx_category_quality (category, avg_quality_score DESC),
                INDEX idx_freshness (freshness_score DESC),
                INDEX idx_updated (updated_at DESC)
              ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    };

    // Use existing database createTable method pattern
    for (const [tableName, sql] of Object.entries(digiMTables)) {
      try {
        await database.query(sql, [], true);
        console.log(`✅ Created DIGIM table: ${tableName}`);
      } catch (error) {
        console.error(`❌ Failed to create table ${tableName}:`, error);
        throw error;
      }
    }

    console.log('✅ DIGIM database schemas initialized successfully');
  }

  // ================================
  // SOURCE MANAGEMENT
  // ================================

  private async loadExistingSources(): Promise<void> {
    console.log('📂 Loading existing DIGIM sources...');
    
    try {
      const sources = await database.query(`
        SELECT * FROM digim_sources 
        WHERE is_active = TRUE 
        ORDER BY created_at DESC
      `, [], true);

      for (const sourceRow of sources) {
        const source: DigiMSource = {
          id: sourceRow.id,
          name: sourceRow.name,
          category: sourceRow.category,
          subcategory: sourceRow.subcategory,
          source_type: sourceRow.source_type,
          url: sourceRow.url,
          config: JSON.parse(sourceRow.config || '{}'),
          schedule: {
            type: sourceRow.schedule_type,
            next_run: sourceRow.last_gathered ? 
              new Date(sourceRow.last_gathered.getTime() + this.getScheduleInterval(sourceRow.schedule_type)) : 
              new Date()
          },
          trust_level: parseFloat(sourceRow.trust_level),
          is_active: sourceRow.is_active,
          metadata: JSON.parse(sourceRow.metadata || '{}')
        };

        this.activeSources.set(source.id, source);
      }

      console.log(`✅ Loaded ${this.activeSources.size} active DIGIM sources`);
    } catch (error) {
      console.warn('⚠️ No existing DIGIM sources found (expected for first run)');
    }
  }

  private async listSources(): Promise<DigiMSource[]> {
    return Array.from(this.activeSources.values());
  }

  private async addSource(sourceData: Partial<DigiMSource>, userId?: string): Promise<{ id: string; status: string }> {
    console.log(`➕ Adding new DIGIM source: ${sourceData.name}`);

    const source: DigiMSource = {
      id: uuidv4(),
      name: sourceData.name || 'Unnamed Source',
      category: sourceData.category || 'news',
      subcategory: sourceData.subcategory || 'general',
      source_type: sourceData.source_type || 'rss',
      url: sourceData.url,
      config: sourceData.config || {},
      schedule: sourceData.schedule || { type: 'hourly' },
      trust_level: sourceData.trust_level || 0.8,
      is_active: sourceData.is_active !== false,
      metadata: sourceData.metadata || {}
    };

    // Validate source
    await this.validateSource(source);

    // Store in database
    await database.query(`
      INSERT INTO digim_sources (
        id, name, category, subcategory, source_type, url, config,
        schedule_type, trust_level, is_active, metadata, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      source.id, source.name, source.category, source.subcategory,
      source.source_type, source.url, JSON.stringify(source.config),
      source.schedule.type, source.trust_level, source.is_active,
      JSON.stringify(source.metadata), userId
    ], true);

    // Add to active sources
    this.activeSources.set(source.id, source);

    console.log(`✅ Added DIGIM source: ${source.id}`);
    return { id: source.id, status: 'added' };
  }

  private async testSource(sourceId: string): Promise<any> {
    console.log(`🧪 Testing DIGIM source: ${sourceId}`);
    
    const source = this.activeSources.get(sourceId);
    if (!source) {
      throw new Error(`Source not found: ${sourceId}`);
    }

    // Phase 1: Basic connectivity test
    if (source.url) {
      try {
        // SECURITY FIX: guard the source URL against SSRF before connecting.
        // Previously this fetched an arbitrary, user-supplied URL with no
        // validation — a source pointing at 169.254.169.254 or an internal
        // host would have been reachable. The guard blocks private/loopback/
        // link-local/metadata targets and non-http(s) schemes.
        const safety = await checkUrlSafety(source.url);
        if (!safety.safe) {
          return {
            source_id: sourceId,
            status: 'blocked',
            reason: safety.reason,
            error: safety.detail || 'URL failed safety validation',
            last_tested: new Date()
          };
        }

        const response = await fetch(source.url, {
          method: 'HEAD',
          headers: { 'User-Agent': 'DINA-DIGIM/1.0' }
        });
        
        return {
          source_id: sourceId,
          status: response.ok ? 'accessible' : 'error',
          response_code: response.status,
          response_time_ms: 0, // Would measure actual time
          last_tested: new Date()
        };
      } catch (error) {
        return {
          source_id: sourceId,
          status: 'error',
          error: (error as Error).message,
          last_tested: new Date()
        };
      }
    }

    return {
      source_id: sourceId,
      status: 'no_url',
      message: 'No URL to test',
      last_tested: new Date()
    };
  }

  // ================================
  // SECURITY SYSTEMS
  // ================================

  private async initializeSecuritySystems(): Promise<void> {
    console.log('🔒 Initializing DIGIM security systems...');
    
    // Phase 1: Basic security framework setup
    // Future phases will implement full sandboxing
    
    console.log('✅ Security framework initialized (basic level)');
  }

  private async performSecurityScan(): Promise<any> {
    console.log('🔍 Performing DIGIM security scan...');
    
    // Phase 1: Basic security status check
    const results = {
      scan_id: uuidv4(),
      scan_type: 'basic',
      started_at: new Date(),
      completed_at: new Date(),
      results: {
        threats_detected: 0,
        content_quarantined: 0,
        sources_checked: this.activeSources.size,
        security_status: 'clean'
      },
      phase: 'foundation'
    };

    return results;
  }

  private async validateSecurityStatus(): Promise<any> {
    return {
      security_framework: 'operational',
      sandbox_status: 'not_implemented', // Phase 2
      validation_engine: 'basic',
      threat_detection: 'basic',
      last_updated: new Date()
    };
  }

  // ================================
  // SYSTEM MONITORING
  // ================================

  private startHealthMonitoring(): void {
    console.log('🩺 Starting DIGIM health monitoring...');
    
    // Monitor system health every 30 seconds
    setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        console.error('❌ Health check failed:', error);
        this.moduleHealth = 'degraded';
      }
    }, 30000);
  }

  private async performHealthCheck(): Promise<void> {
    // Check database connectivity
    if (!database.isConnected) {
      this.moduleHealth = 'critical';
      return;
    }

    // Check Redis connectivity
    if (!redisManager.isConnected) {
      this.moduleHealth = 'degraded';
      return;
    }

    // All systems operational
    this.moduleHealth = 'healthy';
  }

  private async getSystemStatistics(): Promise<any> {
    try {
      const [sourceStats] = await database.query(`
        SELECT 
          COUNT(*) as total_sources,
          SUM(CASE WHEN is_active = TRUE THEN 1 ELSE 0 END) as active_sources
        FROM digim_sources
      `, [], true);

      const [contentStats] = await database.query(`
        SELECT 
          COUNT(*) as total_content,
          processing_status,
          COUNT(*) as count
        FROM digim_content 
        GROUP BY processing_status
      `, [], true);

      return {
        total_sources: sourceStats?.total_sources || 0,
        active_sources: sourceStats?.active_sources || 0,
        total_content: contentStats?.total_content || 0,
        content_by_status: contentStats ? { [contentStats.processing_status]: contentStats.count } : {},
        total_clusters: 0, // Phase 2
        processing_queue_size: 0, // Phase 2
        avg_processing_time_ms: 0 // Phase 2
      };
    } catch (error) {
      return {
        total_sources: this.activeSources.size,
        active_sources: this.activeSources.size,
        total_content: 0,
        content_by_status: {},
        total_clusters: 0,
        processing_queue_size: 0,
        avg_processing_time_ms: 0
      };
    }
  }

  private async getPerformanceMetrics(): Promise<any> {
    return {
      cpu_usage: 0, // Would implement actual monitoring
      memory_usage: 0,
      active_workers: 0,
      cache_hit_ratio: 0
    };
  }

  private async getSecurityMetrics(): Promise<any> {
    return {
      threats_blocked: 0,
      content_quarantined: 0,
      validation_success_rate: 100
    };
  }

  // ================================
  // UTILITY METHODS
  // ================================

  private async validateUserPermissions(message: DigiMMessage): Promise<void> {
    // Integration with existing progressive trust system
    const userTrustLevel = message.security.clearance;
    const method = message.target.method;

    // Phase 1: Basic permission checking
    const restrictedMethods = ['digim_sources', 'digim_security'];
    
    if (restrictedMethods.includes(method) && userTrustLevel === 'public') {
      throw new Error('Insufficient permissions for this operation');
    }
  }

  private async validateSource(source: DigiMSource): Promise<void> {
    if (!source.name || source.name.trim().length === 0) {
      throw new Error('Source name is required');
    }

    if (source.url && !this.isValidUrl(source.url)) {
      throw new Error('Invalid URL format');
    }

    if (source.trust_level < 0 || source.trust_level > 1) {
      throw new Error('Trust level must be between 0 and 1');
    }
  }

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  private getScheduleInterval(scheduleType: string): number {
    const intervals = {
      'realtime': 60000,      // 1 minute
      'hourly': 3600000,      // 1 hour
      'daily': 86400000,      // 24 hours
      'manual': 0
    };
    return intervals[scheduleType as keyof typeof intervals] || 3600000;
  }

  private loadDefaultConfig(): DigiMConfig {
    return {
      gathering: {
        max_concurrent_sources: 10,
        default_crawl_delay_ms: 1000,
        max_content_size_mb: 10,
        content_retention_days: 30
      },
      processing: {
        worker_threads: 8,
        batch_size: 50,
        max_processing_time_ms: 30000,
        embedding_model: 'mxbai-embed-large'
      },
      security: {
        sandbox_enabled: false, // Phase 2
        max_sandbox_memory_mb: 256,
        max_sandbox_time_ms: 10000,
        threat_detection_enabled: true
      },
      intelligence: {
        default_intelligence_level: 'surface',
        cache_ttl_hours: 24,
        max_query_results: 100,
        quality_threshold: 0.7
      }
    };
  }

  // ================================
  // PUBLIC GETTERS
  // ================================

  public get isInitialized(): boolean {
    return this.initialized;
  }

  public get moduleStatus(): 'healthy' | 'degraded' | 'critical' {
    return this.moduleHealth;
  }

  public getActiveSources(): DigiMSource[] {
    return Array.from(this.activeSources.values());
  }

  // ================================
  // SHUTDOWN
  // ================================

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down DIGIM...');
    
    try {
      // Clear all intervals
      for (const interval of this.gatheringIntervals.values()) {
        clearInterval(interval);
      }
      this.gatheringIntervals.clear();

      // Clear sources
      this.activeSources.clear();

      // Shut down the web-research subsystem (best-effort).
      try {
        await this.webResearch.shutdown();
      } catch (webErr) {
        console.warn(`⚠️ DIGIM web-research shutdown error (ignored): ${(webErr as Error).message}`);
      }

      this.initialized = false;
      this.moduleHealth = 'critical';

      console.log('✅ DIGIM shutdown complete');
    } catch (error) {
      console.error('❌ DIGIM shutdown error:', error);
    }
  }
}

// ================================
// HELPERS
// ================================

/**
 * Coerce any caller-supplied intelligence level into a valid one. Notably maps
 * the legacy/route value 'basic' (which is NOT a valid enum) → 'surface', which
 * previously flowed straight through as an invalid value.
 */
function normalizeIntelligenceLevel(value: any): IntelligenceLevel {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (v === 'deep' || v === 'predictive' || v === 'surface') return v;
  if (v === 'basic' || v === '' || v === 'structured') return 'surface';
  return 'surface';
}

/**
 * Normalize a caller-supplied browser mode. Returns undefined for an unset/
 * invalid value so the orchestrator falls back to the config default. Note the
 * browser can never be forced on this way if globally disabled — the registry
 * enforces that.
 */
function normalizeBrowserMode(value: any): 'off' | 'on-miss' | 'always' | undefined {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (v === 'off' || v === 'on-miss' || v === 'always') return v;
  return undefined;
}

// ================================
// EXPORT SINGLETON INSTANCE
// ================================

export const digiMOrchestrator = new DigiMOrchestrator();
export default digiMOrchestrator;
