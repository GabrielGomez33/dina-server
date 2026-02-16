// File: src/modules/llm/intelligence.ts - FIXED TYPESCRIPT ERRORS
import { performance } from 'perf_hooks';
import { database } from '../../config/database/db';
import { redisManager } from '../../config/redis';

// ================================
// CORE INTERFACES
// ================================

export interface ComplexityScore {
  level: number;
  confidence: number;
  reasoning: string;
  recommendedModel: ModelType;
  estimatedTokens: number;
  processingTime: number;
  cacheKey?: string;
  computationCost?: number;
}

export interface PersistenceMetrics {
  cacheHits: number;
  cacheMisses: number;
  persistedEntries: number;
  averageComputeSavings: number;
  lastCleanup: number;
  hitRate?: number;
  memoryEntries?: number;
}

export interface ModelCapabilities {
  maxTokens: number;
  strengthAreas: string[];
  weaknesses: string[];
  averageResponseTime: number;
  memoryUsage: number;
  costPerToken?: number;
  computationCost?: number;
}

export interface LLMResponse {
  id: string;
  sourceRequestId?: string,
  model: string;
  response: string;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  performance: {
    processingTime: number;
    queueTime: number;
    modelLoadTime: number;
  };
  confidence: number;
  metadata: {
    complexity: ComplexityScore;
    context_used: boolean;
    cached: boolean;
    fallback_used?: boolean;
    persistence_hit?: boolean;
    cache_source?: 'memory' | 'redis' | 'persistence' | 'computed';
  };
}

export enum ModelType {
  MISTRAL_7B = 'mistral:7b',
  CODELLAMA_34B = 'codellama:34b',
  LLAMA2_70B = 'llama2:70b'
}

interface ComplexityAnalysis {
  linguistic: number;
  semantic: number;
  computational: number;
  domain: number;
  context: number;
}

// FIXED: Properly typed weights interface
interface ComplexityWeights {
  linguistic: number;
  semantic: number;
  computational: number;
  domain: number;
  context: number;
}

// ================================
// ENHANCED COMPLEXITY ANALYZER
// ================================

export class QueryComplexityAnalyzer {
  private patternCache: Map<string, ComplexityScore> = new Map();
  private persistenceMetrics: PersistenceMetrics = {
    cacheHits: 0,
    cacheMisses: 0,
    persistedEntries: 0,
    averageComputeSavings: 0,
    lastCleanup: Date.now()
  };

  async analyzeQuery(query: string, context?: any): Promise<ComplexityScore> {
    const queryHash = this.getQueryHash(query);
    console.log(`🧠 Analyzing query complexity for hash: ${queryHash}`);
    
    const startTime = performance.now();
    
    // TIER 1: Check in-memory cache first (fastest)
    const memoryHit = this.patternCache.get(queryHash);
    if (memoryHit) {
      console.log(`⚡ Memory cache hit for query complexity: ${queryHash}`);
      this.persistenceMetrics.cacheHits++;
      return { 
        ...memoryHit, 
        confidence: memoryHit.confidence * 0.98,
        cacheKey: queryHash,
        computationCost: performance.now() - startTime
      };
    }

    // TIER 2: Check persistence cache (Redis + disk)
    try {
      const persistenceHit = await redisManager.getComplexityFromCache(queryHash);
      if (persistenceHit) {
        console.log(`💾 Persistence cache hit for query complexity: ${queryHash}`);
        this.persistenceMetrics.cacheHits++;
        
        // Store in memory cache for faster future access
        this.patternCache.set(queryHash, persistenceHit);
        
        return {
          ...persistenceHit,
          confidence: persistenceHit.confidence * 0.95,
          cacheKey: queryHash,
          computationCost: performance.now() - startTime
        };
      }
    } catch (error) {
      console.warn(`⚠️ Persistence cache error for ${queryHash}:`, error);
    }

    // TIER 3: Generate new analysis (most expensive)
    console.log(`🧮 Computing new complexity analysis for: ${queryHash}`);
    this.persistenceMetrics.cacheMisses++;
    
    const analysis = await this.performComplexityAnalysis(query, context);
    const computationTime = performance.now() - startTime;
    
    const result: ComplexityScore = {
      ...analysis,
      cacheKey: queryHash,
      computationCost: computationTime
    };

    // Store in all cache tiers
    await this.storeInAllCaches(queryHash, result, computationTime);
    
    console.log(`✅ Query complexity analyzed: level=${result.level}, model=${result.recommendedModel}, computation=${computationTime.toFixed(2)}ms`);
    return result;
  }

  private async storeInAllCaches(
    queryHash: string, 
    result: ComplexityScore, 
    computationTime: number
  ): Promise<void> {
    try {
      // Tier 1: Memory cache (immediate access)
      this.patternCache.set(queryHash, result);
      
      // Tier 2: Persistence cache (survives restarts)
      if (computationTime > 50) { // 50ms threshold
        await redisManager.cacheComplexityAnalysis(queryHash, result);
        this.persistenceMetrics.persistedEntries++;
        console.log(`💾 Persisted complexity analysis for ${queryHash} (cost: ${computationTime.toFixed(2)}ms)`);
      }
      
      // Tier 3: Database (for analytics and long-term learning)
      await this.recordLearningData(queryHash, result, computationTime);
      
    } catch (error) {
      console.error(`❌ Failed to store complexity analysis in caches:`, error);
    }
  }

  private async performComplexityAnalysis(query: string, context?: any): Promise<ComplexityScore> {
    const analysis: ComplexityAnalysis = {
      linguistic: this.analyzeLinguisticComplexity(query),
      semantic: this.analyzeSemanticComplexity(query),
      computational: this.analyzeComputationalRequirements(query),
      domain: this.analyzeDomainSpecificity(query),
      context: this.analyzeContextRequirements(context)
    };

    const complexityLevel = this.calculateWeightedComplexity(analysis);
    const recommendedModel = this.selectOptimalModel(complexityLevel, analysis);
    const confidence = this.calculateConfidence(analysis, complexityLevel);
    
    return {
      level: complexityLevel,
      confidence,
      reasoning: this.generateReasoning(analysis, complexityLevel),
      recommendedModel,
      estimatedTokens: this.estimateTokenRequirement(query, complexityLevel),
      processingTime: this.estimateProcessingTime(complexityLevel, recommendedModel)
    };
  }

  // ================================
  // ANALYSIS METHODS (PRESERVED)
  // ================================

  private analyzeLinguisticComplexity(query: string): number {
    let score = 0;
    const wordCount = query.split(/\s+/).length;
    score += Math.min(wordCount / 50, 3);
    
    const sentences = query.split(/[.!?]+/).length;
    score += Math.min(sentences / 5, 2);
    
    const technicalWords = ['algorithm', 'implementation', 'architecture', 'optimization', 'performance'];
    const technicalCount = technicalWords.filter(word => 
      query.toLowerCase().includes(word)
    ).length;
    score += technicalCount * 0.5;
    
    return Math.min(score, 10);
  }

  private analyzeSemanticComplexity(query: string): number {
    let score = 2;
    
    const abstractConcepts = ['philosophy', 'consciousness', 'ethics', 'meaning', 'purpose'];
    if (abstractConcepts.some(concept => query.toLowerCase().includes(concept))) {
      score += 3;
    }
    
    const reasoningIndicators = ['because', 'therefore', 'however', 'consequently', 'furthermore'];
    const reasoningCount = reasoningIndicators.filter(indicator => 
      query.toLowerCase().includes(indicator)
    ).length;
    score += reasoningCount;
    
    if (query.includes('?')) {
      if (query.includes('why') || query.includes('how')) score += 2;
      if (query.includes('what if') || query.includes('suppose')) score += 3;
    }
    
    return Math.min(score, 10);
  }

  private analyzeComputationalRequirements(query: string): number {
    let score = 1;
    
    if (query.toLowerCase().includes('code') || 
        query.toLowerCase().includes('program') ||
        query.toLowerCase().includes('implement')) {
      score += 4;
    }
    
    if (query.toLowerCase().includes('calculate') || 
        query.toLowerCase().includes('solve') ||
        /\d+/.test(query)) {
      score += 2;
    }
    
    if (query.toLowerCase().includes('analyze') || 
        query.toLowerCase().includes('compare') ||
        query.toLowerCase().includes('evaluate')) {
      score += 3;
    }
    
    return Math.min(score, 10);
  }

  private analyzeDomainSpecificity(query: string): number {
    const domains = {
      'medical': ['diagnosis', 'treatment', 'medical', 'health', 'disease'],
      'legal': ['law', 'legal', 'court', 'contract', 'regulation'],
      'technical': ['engineering', 'software', 'hardware', 'system', 'architecture'],
      'financial': ['investment', 'finance', 'trading', 'market', 'economic'],
      'scientific': ['research', 'experiment', 'hypothesis', 'methodology', 'analysis']
    };
    
    for (const [domain, keywords] of Object.entries(domains)) {
      if (keywords.some(keyword => query.toLowerCase().includes(keyword))) {
        return 6;
      }
    }
    
    return 2;
  }

  private analyzeContextRequirements(context?: any): number {
    if (!context) return 1;
    
    let score = 3;
    
    if (context.conversationHistory && context.conversationHistory.length > 5) {
      score += 2;
    }
    
    if (context.userPreferences) {
      score += 1;
    }
    
    if (context.documents && context.documents.length > 0) {
      score += 3;
    }
    
    return Math.min(score, 10);
  }

  // FIXED: Proper typing for weights iteration
  private calculateWeightedComplexity(analysis: ComplexityAnalysis): number {
    const weights: ComplexityWeights = {
      linguistic: 0.2,
      semantic: 0.3,
      computational: 0.3,
      domain: 0.1,
      context: 0.1
    };
    
    let weightedSum = 0;
    // FIXED: Properly typed iteration
    for (const [dimension, weight] of Object.entries(weights) as [keyof ComplexityWeights, number][]) {
      weightedSum += analysis[dimension] * weight;
    }
    
    return Math.round(Math.min(Math.max(weightedSum, 1), 10));
  }

  private selectOptimalModel(complexityLevel: number, analysis: ComplexityAnalysis): ModelType {
    if (analysis.computational > 6) {
      return complexityLevel > 7 ? ModelType.CODELLAMA_34B : ModelType.MISTRAL_7B;
    }
    
    if (complexityLevel > 8) {
      return ModelType.LLAMA2_70B;
    }
    
    if (complexityLevel > 5) {
      return ModelType.CODELLAMA_34B;
    }
    
    return ModelType.MISTRAL_7B;
  }

  private calculateConfidence(analysis: ComplexityAnalysis, complexityLevel: number): number {
    let confidence = 0.8;
    
    if (complexityLevel <= 2 || complexityLevel >= 9) {
      confidence += 0.15;
    }
    
    if (analysis.domain > 8) {
      confidence -= 0.2;
    }
    
    return Math.max(0.1, Math.min(1.0, confidence));
  }

  private generateReasoning(analysis: ComplexityAnalysis, complexityLevel: number): string {
    const reasons = [];
    
    if (analysis.linguistic > 5) reasons.push("complex linguistic structure");
    if (analysis.semantic > 6) reasons.push("abstract conceptual reasoning");
    if (analysis.computational > 5) reasons.push("significant computational requirements");
    if (analysis.domain > 6) reasons.push("domain-specific expertise needed");
    if (analysis.context > 5) reasons.push("extensive context integration required");
    
    if (reasons.length === 0) {
      return `Simple query with complexity level ${complexityLevel}`;
    }
    
    return `Complexity level ${complexityLevel} due to: ${reasons.join(', ')}`;
  }

  private estimateTokenRequirement(query: string, complexityLevel: number): number {
    const baseTokens = Math.ceil(query.split(/\s+/).length * 1.3);
    const complexityMultiplier = 1 + (complexityLevel / 10);
    const outputEstimate = baseTokens * complexityMultiplier * 2;
    
    return Math.round(baseTokens + outputEstimate);
  }

  private estimateProcessingTime(complexityLevel: number, model: ModelType): number {
    const modelBaseTimes = {
      [ModelType.MISTRAL_7B]: 150,
      [ModelType.CODELLAMA_34B]: 800,
      [ModelType.LLAMA2_70B]: 2500
    };
    
    const baseTime = modelBaseTimes[model];
    const complexityMultiplier = 1 + (complexityLevel / 20);
    
    return Math.round(baseTime * complexityMultiplier);
  }

  // ================================
  // ENHANCED UTILITY METHODS
  // ================================

  public getQueryHash(query: string): string {
    const normalized = query
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[^\w\s]/g, '');
    
    const crypto = require('crypto');
    const hash = crypto
      .createHash('sha256')
      .update(normalized)
      .digest('hex')
      .substring(0, 16);
    
    console.log(`🔑 Generated query hash: ${hash} for query: "${query.substring(0, 50)}..."`);
    return hash;
  }

  async assessConfidence(response: string): Promise<number> {
    // Simple confidence assessment based on response characteristics
    let confidence = 0.7;
    
    if (response.length > 100) confidence += 0.1;
    if (response.includes('I think') || response.includes('probably')) confidence -= 0.1;
    if (response.includes('certainly') || response.includes('definitely')) confidence += 0.1;
    
    return Math.max(0.1, Math.min(1.0, confidence));
  }

  // FIXED: Changed intelligence type from 'complexity-analysis' to 'optimization'
  private async recordLearningData(queryHash: string, result: ComplexityScore, computationTime: number): Promise<void> {
    try {
      await database.recordIntelligence(
        'llm-intelligence-engine',
        'optimization', // FIXED: Changed from 'complexity-analysis' to valid type
        {
          query_hash: queryHash,
          complexity: result,
          computation_time: computationTime,
          cache_source: 'computed',
          persistence_eligible: computationTime > 50
        },
        result.confidence,
        result.level
      );
      console.log(`📊 Recorded intelligence decision for query hash: ${queryHash}`);
    } catch (error) {
      console.error(`❌ Failed to record intelligence decision: ${error}`);
    }
  }

  // ================================
  // CACHE MANAGEMENT AND MONITORING
  // ================================

  getPersistenceMetrics(): PersistenceMetrics {
    const totalAccess = this.persistenceMetrics.cacheHits + this.persistenceMetrics.cacheMisses;
    const hitRate = totalAccess > 0 ? this.persistenceMetrics.cacheHits / totalAccess : 0;
    
    return {
      ...this.persistenceMetrics,
      hitRate,
      memoryEntries: this.patternCache.size,
      averageComputeSavings: this.calculateAverageComputeSavings()
    };
  }

  async getIntelligenceStats(): Promise<any> {
    return {
      totalQueries: this.persistenceMetrics.cacheHits + this.persistenceMetrics.cacheMisses,
      cacheHitRate: this.getPersistenceMetrics().hitRate,
      memoryEntries: this.patternCache.size,
      persistedEntries: this.persistenceMetrics.persistedEntries
    };
  }

  private calculateAverageComputeSavings(): number {
    const cacheEntries = Array.from(this.patternCache.values());
    if (cacheEntries.length === 0) return 0;
    
    const totalSavings = cacheEntries.reduce((sum, entry) => {
      return sum + (entry.computationCost || entry.processingTime);
    }, 0);
    
    return totalSavings / cacheEntries.length;
  }

  async cleanExpiredEntries(): Promise<void> {
    const now = Date.now();
    const maxAge = 2 * 60 * 60 * 1000; // 2 hours
    
    let cleaned = 0;
    for (const [hash, entry] of this.patternCache.entries()) {
      const entryAge = now - (entry.computationCost ? now - entry.computationCost : 0);
      if (entryAge > maxAge) {
        this.patternCache.delete(hash);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`🧹 Cleaned ${cleaned} expired complexity entries from memory cache`);
    }
    
    this.persistenceMetrics.lastCleanup = now;
  }

  async warmUpCache(): Promise<void> {
    console.log('🔥 Warming up complexity analysis cache...');
    
    try {
      const frequentPatterns = await this.loadFrequentPatterns();
      
      let warmed = 0;
      for (const pattern of frequentPatterns) {
        if (!this.patternCache.has(pattern.queryHash)) {
          this.patternCache.set(pattern.queryHash, pattern.complexity);
          warmed++;
        }
      }
      
      console.log(`🔥 Warmed up ${warmed} complexity patterns in memory cache`);
      
    } catch (error) {
      console.error('❌ Failed to warm up complexity cache:', error);
    }
  }

  private async loadFrequentPatterns(): Promise<any[]> {
    return [];
  }
}

// ================================
// ENHANCED PERFORMANCE OPTIMIZER
// ================================

export class PerformanceOptimizer {
  private performanceHistory: Map<string, any[]> = new Map();
  private optimizationRecommendations: any[] = [];

  async recordPerformance(data: {
    queryHash: string;
    model: ModelType;
    complexity: number;
    actualProcessingTime: number;
    estimatedProcessingTime: number;
    tokens: number;
    success: boolean;
    quality: number;
    cacheHit?: boolean;
    cacheSource?: string;
  }): Promise<void> {
    const history = this.performanceHistory.get(data.queryHash) || [];
    history.push({
      ...data,
      timestamp: Date.now()
    });
    
    if (history.length > 10) {
      history.shift();
    }
    
    this.performanceHistory.set(data.queryHash, history);
    
    await this.updateOptimizationRecommendations(data);
    
    console.log(`📈 Performance recorded: ${data.queryHash}, cache: ${data.cacheHit ? data.cacheSource : 'miss'}`);
  }

  private async updateOptimizationRecommendations(data: any): Promise<void> {
    const recommendations = [];
    
    if (!data.cacheHit && data.actualProcessingTime > 1000) {
      recommendations.push({
        type: 'cache_optimization',
        priority: 'high',
        message: `Query ${data.queryHash} takes ${data.actualProcessingTime}ms and should be cached`,
        action: 'enable_aggressive_caching'
      });
    }
    
    if (data.actualProcessingTime > data.estimatedProcessingTime * 2) {
      recommendations.push({
        type: 'model_optimization',
        priority: 'medium',
        message: `Model ${data.model} significantly slower than estimated for complexity ${data.complexity}`,
        action: 'review_model_selection'
      });
    }
    
    this.optimizationRecommendations.push(...recommendations);
    
    if (this.optimizationRecommendations.length > 100) {
      this.optimizationRecommendations = this.optimizationRecommendations.slice(-100);
    }
  }

  getPerformanceStats(): any {
    const totalQueries = Array.from(this.performanceHistory.values()).flat().length;
    const cacheHits = Array.from(this.performanceHistory.values()).flat()
      .filter(record => record.cacheHit).length;
    
    return {
      totalQueries,
      cacheHitRate: totalQueries > 0 ? cacheHits / totalQueries : 0,
      averageProcessingTime: this.calculateAverageProcessingTime(),
      optimizationRecommendations: this.optimizationRecommendations.length
    };
  }

  private calculateAverageProcessingTime(): number {
    const allRecords = Array.from(this.performanceHistory.values()).flat();
    if (allRecords.length === 0) return 0;
    
    const totalTime = allRecords.reduce((sum, record) => sum + record.actualProcessingTime, 0);
    return totalTime / allRecords.length;
  }

  async getOptimizationRecommendations(): Promise<any[]> {
    return this.optimizationRecommendations.slice(-20);
  }
}

// ================================
// ENHANCED CONTEXT MEMORY SYSTEM
// ================================

export class ContextMemorySystem {
  private contextCache: Map<string, any> = new Map();
  
  async updateContext(userId: string, conversationId: string, query: string, response: string): Promise<void> {
    const contextKey = `${userId}:${conversationId}`;
    
    let context = this.contextCache.get(contextKey) || {
      userId,
      conversationId,
      interactions: [],
      patterns: new Map(),
      lastUpdated: Date.now()
    };
    
    context.interactions.push({
      query,
      response,
      timestamp: Date.now(),
      queryHash: llmIntelligenceEngine.getQueryHash(query)
    });
    
    if (context.interactions.length > 50) {
      context.interactions = context.interactions.slice(-50);
    }
    
    context.lastUpdated = Date.now();
    this.contextCache.set(contextKey, context);
    
    if (context.interactions.length % 10 === 0) {
      await this.persistContext(contextKey, context);
    }
  }

  private async persistContext(contextKey: string, context: any): Promise<void> {
    try {
      await redisManager.setExactCachedResponse(
        `context:${contextKey}`,
        context,
        7200
      );
      console.log(`💾 Persisted context for ${contextKey}`);
    } catch (error) {
      console.error('❌ Failed to persist context:', error);
    }
  }

  getContextStats(): any {
    return {
      activeContexts: this.contextCache.size,
      totalInteractions: Array.from(this.contextCache.values())
        .reduce((sum, context) => sum + context.interactions.length, 0)
    };
  }
}

// ================================
// EXPORT ENHANCED INSTANCES
// ================================

export const llmIntelligenceEngine = new QueryComplexityAnalyzer();
export const performanceOptimizer = new PerformanceOptimizer();
export const contextMemorySystem = new ContextMemorySystem();

// Warm up caches on startup
setTimeout(async () => {
  try {
    await llmIntelligenceEngine.warmUpCache();
    console.log('✅ LLM Intelligence cache warm-up completed');
  } catch (error) {
    console.error('❌ Cache warm-up failed:', error);
  }
}, 5000);

// Schedule periodic cache cleanup
setInterval(async () => {
  try {
    await llmIntelligenceEngine.cleanExpiredEntries();
  } catch (error) {
    console.error('❌ Cache cleanup failed:', error);
  }
}, 30 * 60 * 1000); // Clean every 30 minutes
