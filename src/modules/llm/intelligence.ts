// DINA Phase 2: Multi-Model LLM Intelligence Engine (Fixed)
// File: src/modules/llm/intelligence.ts

import { performance } from 'perf_hooks';
import { database } from '../../config/database/db';

// ================================
// CORE INTERFACES
// ================================

export interface ComplexityScore {
  level: number;           // 1-10 scale
  confidence: number;      // 0-1 confidence in assessment
  reasoning: string;       // Why this complexity was assigned
  recommendedModel: ModelType;
  estimatedTokens: number;
  processingTime: number;  // Estimated ms
}

export interface ModelCapabilities {
  maxTokens: number;
  strengthAreas: string[];
  weaknesses: string[];
  averageResponseTime: number;
  memoryUsage: number;
  costPerToken?: number;
}

export interface LLMResponse {
  id: string;
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
  };
}

export enum ModelType {
  MISTRAL_7B = 'mistral:7b',
  CODELLAMA_34B = 'codellama:34b',
  LLAMA2_70B = 'llama2:70b'
}

// ================================
// ANALYSIS RESULT INTERFACE
// ================================

interface ComplexityAnalysis {
  linguistic: number;
  semantic: number;
  computational: number;
  domain: number;
  context: number;
}

// ================================
// QUERY COMPLEXITY ANALYZER
// ================================

export class QueryComplexityAnalyzer {
  private patternCache: Map<string, ComplexityScore> = new Map();

  /**
   * Analyze query complexity and recommend optimal model
   */
  async analyzeQuery(query: string, context?: any): Promise<ComplexityScore> {
    const queryHash = this.hashQuery(query);
    console.log(`🧠 Analyzing query complexity for hash: ${queryHash}`);
    const cached = this.patternCache.get(queryHash);
    if (cached) {
      console.log(`⚡ Cache hit for query complexity: ${queryHash}`);
      return { ...cached, confidence: cached.confidence * 0.95 };
    }

    const startTime = performance.now();
    
    // Multi-dimensional complexity analysis
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
    
    const result: ComplexityScore = {
      level: complexityLevel,
      confidence,
      reasoning: this.generateReasoning(analysis, complexityLevel),
      recommendedModel,
      estimatedTokens: this.estimateTokenRequirement(query, complexityLevel),
      processingTime: this.estimateProcessingTime(complexityLevel, recommendedModel)
    };

    this.patternCache.set(queryHash, result);
    await this.recordLearningData(query, result, performance.now() - startTime);

    console.log(`✅ Query complexity analyzed: level=${result.level}, model=${result.recommendedModel}`);
    return result;
  }

  private analyzeLinguisticComplexity(query: string): number {
    let score = 0;
    const wordCount = query.split(/\s+/).length;
    score += Math.min(wordCount / 50, 3);
    
    const sentences = query.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const avgSentenceLength = wordCount / sentences.length;
    score += Math.min(avgSentenceLength / 20, 2);
    
    const complexWords = query.match(/\b\w{8,}\b/g) || [];
    score += Math.min(complexWords.length / 10, 2);
    
    const technicalPatterns = [
      /\b(algorithm|optimization|machine learning|neural network|database|architecture)\b/gi,
      /\b(implementation|methodology|paradigm|framework|infrastructure)\b/gi
    ];
    
    for (const pattern of technicalPatterns) {
      const matches = query.match(pattern) || [];
      score += Math.min(matches.length * 0.5, 1);
    }

    return Math.min(score, 10);
  }

  private analyzeSemanticComplexity(query: string): number {
    let score = 0;
    const queryLower = query.toLowerCase();
    
    const complexQuestionWords = ['why', 'how', 'analyze', 'explain', 'compare', 'evaluate'];
    complexQuestionWords.forEach(word => {
      if (queryLower.includes(word)) score += 1.5;
    });
    
    const questionMarks = (query.match(/\?/g) || []).length;
    if (questionMarks > 1) score += questionMarks * 0.5;
    
    const conditionals = ['if', 'unless', 'provided that', 'assuming', 'given that'];
    conditionals.forEach(cond => {
      if (queryLower.includes(cond)) score += 1;
    });
    
    const comparisons = ['compare', 'contrast', 'difference', 'versus', 'vs', 'better', 'worse'];
    comparisons.forEach(comp => {
      if (queryLower.includes(comp)) score += 1.5;
    });

    return Math.min(score, 10);
  }

  private analyzeComputationalRequirements(query: string): number {
    let score = 0;
    const queryLower = query.toLowerCase();
    
    const codeKeywords = [
      'function', 'algorithm', 'code', 'program', 'script', 'implementation',
      'debug', 'optimize', 'refactor', 'api', 'database', 'sql', 'json'
    ];
    
    codeKeywords.forEach(keyword => {
      if (queryLower.includes(keyword)) score += 1;
    });
    
    const mathKeywords = [
      'calculate', 'equation', 'formula', 'statistics', 'probability',
      'integration', 'derivative', 'matrix', 'vector', 'optimization'
    ];
    
    mathKeywords.forEach(keyword => {
      if (queryLower.includes(keyword)) score += 1.5;
    });

    return Math.min(score, 10);
  }

  private analyzeDomainSpecificity(query: string): number {
    let score = 0;
    const queryLower = query.toLowerCase();
    
    const domains = {
      programming: ['javascript', 'python', 'react', 'node', 'typescript', 'css', 'html'],
      ai_ml: ['artificial intelligence', 'machine learning', 'neural network', 'llm', 'gpt'],
      database: ['sql', 'mysql', 'postgresql', 'mongodb', 'redis', 'database'],
      security: ['encryption', 'authentication', 'ssl', 'cybersecurity', 'vulnerability']
    };
    
    let domainMatches = 0;
    Object.values(domains).forEach(domainTerms => {
      const matches = domainTerms.filter(term => queryLower.includes(term)).length;
      if (matches > 0) {
        domainMatches++;
        score += matches * 0.5;
      }
    });
    
    if (domainMatches > 1) {
      score += domainMatches * 1.5;
    }

    return Math.min(score, 10);
  }

  private analyzeContextRequirements(context: any): number {
    let score = 0;
    if (!context) return 0;
    
    const contextSize = JSON.stringify(context).length;
    score += Math.min(contextSize / 1000, 3);
    
    if (context.conversation_history && context.conversation_history.length > 5) {
      score += 2;
    }
    
    if (context.user_preferences) score += 1;
    if (context.domain_specific_data) score += 2;

    return Math.min(score, 10);
  }

  private calculateWeightedComplexity(analysis: ComplexityAnalysis): number {
    const weights = {
      linguistic: 0.15,
      semantic: 0.25,
      computational: 0.30,
      domain: 0.20,
      context: 0.10
    };
    
    const weightedSum = 
      analysis.linguistic * weights.linguistic +
      analysis.semantic * weights.semantic +
      analysis.computational * weights.computational +
      analysis.domain * weights.domain +
      analysis.context * weights.context;
    
    return Math.max(1, Math.min(10, Math.round(weightedSum)));
  }

  private selectOptimalModel(complexity: number, analysis: ComplexityAnalysis): ModelType {
    if (analysis.computational > 6 && analysis.domain > 3) {
      return ModelType.CODELLAMA_34B;
    }
    
    if (complexity <= 3) {
      return ModelType.MISTRAL_7B;
    }
    
    if (complexity <= 6) {
      if (analysis.computational > 4) {
        return ModelType.CODELLAMA_34B;
      }
      return ModelType.MISTRAL_7B;
    }
    
    return ModelType.LLAMA2_70B;
  }

  private calculateConfidence(analysis: ComplexityAnalysis, complexity: number): number {
    let confidence = 0.5;
    
    const values = Object.values(analysis) as number[];
    const analysisSpread = Math.max(...values) - Math.min(...values);
    if (analysisSpread > 5) {
      confidence += 0.3;
    }
    
    if (analysis.domain > 5) {
      confidence += 0.2;
    }
    
    if (analysis.computational > 7 || analysis.computational < 2) {
      confidence += 0.2;
    }
    
    return Math.min(0.95, confidence);
  }

  private generateReasoning(analysis: ComplexityAnalysis, complexity: number): string {
    const reasons = [];
    
    if (analysis.linguistic > 6) reasons.push("high linguistic complexity");
    if (analysis.semantic > 6) reasons.push("complex semantic requirements");
    if (analysis.computational > 6) reasons.push("significant computational processing needed");
    if (analysis.domain > 6) reasons.push("specialized domain knowledge required");
    if (analysis.context > 3) reasons.push("context-aware processing needed");
    
    if (reasons.length === 0) {
      return `Simple query (complexity ${complexity}) - suitable for fast processing`;
    }
    
    return `Complexity ${complexity}/10 due to: ${reasons.join(', ')}`;
  }

  private estimateTokenRequirement(query: string, complexity: number): number {
    const baseTokens = query.split(/\s+/).length * 1.3;
    const complexityMultiplier = 1 + (complexity / 20);
    return Math.round(baseTokens * complexityMultiplier);
  }

  private estimateProcessingTime(complexity: number, model: ModelType): number {
    const baseProcessingTimes = {
      [ModelType.MISTRAL_7B]: 150,
      [ModelType.CODELLAMA_34B]: 800,
      [ModelType.LLAMA2_70B]: 2500
    };
    
    const complexityMultiplier = 1 + (complexity / 15);
    const baseTime = baseProcessingTimes[model];
    
    return Math.round(baseTime * complexityMultiplier);
  }

  private hashQuery(query: string): string {
    return Buffer.from(query.toLowerCase().replace(/\s+/g, ' ').trim()).toString('base64').substring(0, 16);
  }

  public getQueryHash(query: string): string {
    console.log(`🧠 Generating query hash for: "${query.substring(0, 50)}..."`);
    const hash = this.hashQuery(query);
    console.log(`✅ Generated query hash: ${hash}`);
    return hash;
  }

  private async recordLearningData(query: string, result: ComplexityScore, analysisTime: number): Promise<void> {
    try {
      await database.recordIntelligence(
        'llm-intelligence',
        'prediction',
        {
          query_hash: this.hashQuery(query),
          complexity_prediction: result.level,
          recommended_model: result.recommendedModel,
          confidence: result.confidence,
          analysis_time_ms: analysisTime,
          estimated_tokens: result.estimatedTokens,
          estimated_processing_time: result.processingTime
        },
        result.confidence,
        result.level
      );
      console.log(`📊 Recorded learning data for query hash: ${this.hashQuery(query)}`);
    } catch (error) {
      console.error(`❌ Failed to record learning data: ${error}`);
    }
  }
}

// ================================
// CONTEXT MEMORY SYSTEM
// ================================

export class ContextMemorySystem {
  private conversationCache: Map<string, any> = new Map();
  private maxContextLength: number = 8000;
  private compressionThreshold: number = 6000;

  async storeContext(
    userId: string, 
    conversationId: string, 
    interaction: {
      query: string;
      response: string;
      model: ModelType;
      timestamp: Date;
      metadata?: any;
    }
  ): Promise<void> {
    try {
      const contextKey = `${userId}_${conversationId}`;
      console.log(`📚 Storing context for key: ${contextKey}`);
      let context = this.conversationCache.get(contextKey) || {
        interactions: [],
        totalTokens: 0,
        lastUpdated: new Date()
      };

      const estimatedTokens = this.estimateTokens(interaction.query + interaction.response);
      context.interactions.push({
        ...interaction,
        estimatedTokens
      });
      context.totalTokens += estimatedTokens;
      context.lastUpdated = new Date();

      if (context.totalTokens > this.compressionThreshold) {
        context = await this.compressContext(context);
      }

      this.conversationCache.set(contextKey, context);

      await database.storeUserMemory({
        user_id: userId,
        module: `conversation_${conversationId}`,
        memory_type: 'episodic',
        data: {
          recentInteractions: context.interactions.slice(-5),
          summary: context.summary,
          totalInteractions: context.interactions.length
        },
        confidence_score: 0.9
      });
      console.log(`✅ Context stored for key: ${contextKey}`);
    } catch (error) {
      console.error(`❌ Failed to store context: ${error}`);
    }
  }

// REPLACE the getContext method in intelligence.ts ContextMemorySystem class with this:
  
  async getContext(userId: string, conversationId: string): Promise<any> {
    const contextKey = `${userId}_${conversationId}`;
    console.log(`📚 Retrieving context for key: ${contextKey}`);
    
    let context = this.conversationCache.get(contextKey);
    
    if (!context) {
      try {
        // FIXED: Pass memory type as array (the function expects an array parameter)
        const memories = await database.getUserMemory(
          userId, 
          `conversation_${conversationId}`, 
          ['episodic'] // Pass as array, not single string
        );
        
        if (memories.length > 0) {
          const latestMemory = memories[0];
          context = {
            interactions: latestMemory.data.recentInteractions || [],
            summary: latestMemory.data.summary,
            totalTokens: this.estimateTokens(JSON.stringify(latestMemory.data)),
            lastUpdated: new Date(latestMemory.created_at)
          };
          
          this.conversationCache.set(contextKey, context);
          console.log(`✅ Loaded context from database for key: ${contextKey}`);
        }
      } catch (error) {
        console.error(`❌ Failed to load context from database: ${error}`);
      }
    }
    
    return context || {
      interactions: [],
      totalTokens: 0,
      lastUpdated: new Date()
    };
  }

  async getRelevantContext(userId: string, conversationId: string, query: string): Promise<string[]> {
    console.log(`📚 Getting relevant context for userId=${userId}, conversationId=${conversationId}`);
    const context = await this.getContext(userId, conversationId);
    if (!context || context.interactions.length === 0) {
      console.log(`ℹ️ No context available for key: ${userId}_${conversationId}`);
      return [];
    }

    // Simple relevance scoring based on keyword overlap
    const queryWords = new Set(query.toLowerCase().split(/\s+/));
    const relevantInteractions = context.interactions
      .map((interaction: any) => {
        const interactionWords = new Set(interaction.query.toLowerCase().split(/\s+/));
        const overlap = [...queryWords].filter(word => interactionWords.has(word)).length;
        return { interaction, score: overlap / queryWords.size };
      })
      .filter((item: any) => item.score > 0.3) // Threshold for relevance
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 3) // Limit to top 3 relevant interactions
      .map((item: any) => `Query: ${item.interaction.query}\nResponse: ${item.interaction.response}`);

    console.log(`✅ Found ${relevantInteractions.length} relevant context interactions`);
    return relevantInteractions;
  }

  async updateContext(userId: string, conversationId: string, query: string, response: string): Promise<void> {
    console.log(`📚 Updating context for userId=${userId}, conversationId=${conversationId}`);
    await this.storeContext(userId, conversationId, {
      query,
      response,
      model: ModelType.MISTRAL_7B, // Default model for context updates
      timestamp: new Date(),
      metadata: { source: 'llm-manager' }
    });
  }

  private async compressContext(context: any): Promise<any> {
    console.log(`🗜️ Compressing context: totalTokens=${context.totalTokens}`);
    const recentInteractions = context.interactions.slice(-3);
    const olderInteractions = context.interactions.slice(0, -3);
    
    const summary = this.summarizeInteractions(olderInteractions);
    
    const recentTokens = recentInteractions.reduce((sum: number, interaction: any) => 
      sum + (interaction.estimatedTokens || 0), 0);
    const summaryTokens = this.estimateTokens(summary);
    
    const compressedContext = {
      interactions: recentInteractions,
      summary: context.summary ? `${context.summary}\n\n${summary}` : summary,
      totalTokens: recentTokens + summaryTokens,
      lastUpdated: context.lastUpdated,
      compressionCount: (context.compressionCount || 0) + 1
    };
    console.log(`✅ Context compressed: new totalTokens=${compressedContext.totalTokens}`);
    return compressedContext;
  }

  private summarizeInteractions(interactions: any[]): string {
    if (interactions.length === 0) return '';
    
    const topics = new Set<string>();
    const keyPoints: string[] = [];
    
    interactions.forEach(interaction => {
      const words = interaction.query.toLowerCase().split(/\s+/);
      words.forEach((word: string) => {
        if (word.length > 5 && !['about', 'could', 'would', 'should'].includes(word)) {
          topics.add(word);
        }
      });
      
      const firstSentence = interaction.response.split('.')[0];
      if (firstSentence && firstSentence.length > 20) {
        keyPoints.push(firstSentence.trim());
      }
    });
    
    const summary = `Previous conversation covered: ${Array.from(topics).slice(0, 5).join(', ')}. Key points: ${keyPoints.slice(0, 3).join('; ')}.`;
    console.log(`📝 Generated context summary: "${summary.substring(0, 50)}..."`);
    return summary;
  }

  private estimateTokens(text: string): number {
    const tokens = Math.ceil(text.split(/\s+/).length * 1.3);
    console.log(`📏 Estimated tokens for text: ${tokens}`);
    return tokens;
  }

  async cleanupOldContexts(): Promise<void> {
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    console.log(`🧹 Cleaning up old contexts before ${cutoffTime}`);
    
    let removed = 0;
    for (const [key, context] of this.conversationCache.entries()) {
      if (context.lastUpdated < cutoffTime) {
        this.conversationCache.delete(key);
        removed++;
      }
    }
    console.log(`✅ Cleaned up ${removed} old contexts`);
  }

  getContextStats(): any {
    const totalContexts = this.conversationCache.size;
    let totalTokens = 0;
    let totalInteractions = 0;
    
    for (const context of this.conversationCache.values()) {
      totalTokens += context.totalTokens;
      totalInteractions += context.interactions.length;
    }
    
    const stats = {
      activeContexts: totalContexts,
      totalTokensInMemory: totalTokens,
      totalInteractions,
      averageTokensPerContext: totalContexts > 0 ? Math.round(totalTokens / totalContexts) : 0,
      memoryUsage: `${(totalTokens * 4 / 1024 / 1024).toFixed(2)} MB`
    };
    console.log(`📊 Context stats: ${JSON.stringify(stats)}`);
    return stats;
  }
}

// ================================
// PERFORMANCE OPTIMIZER
// ================================

export class LLMPerformanceOptimizer {
  private performanceHistory: Map<string, any[]> = new Map();

  async recordPerformance(data: {
    queryHash: string;
    model: ModelType;
    complexity: number;
    actualProcessingTime: number;
    estimatedProcessingTime: number;
    tokens: { input: number; output: number };
    success: boolean;
    quality?: number;
  }): Promise<void> {
    console.log(`📈 Recording performance for query hash: ${data.queryHash}`);
    const history = this.performanceHistory.get(data.queryHash) || [];
    
    history.push({
      ...data,
      timestamp: new Date(),
      accuracy: Math.abs(data.actualProcessingTime - data.estimatedProcessingTime) / data.estimatedProcessingTime
    });
    
    if (history.length > 10) {
      history.splice(0, history.length - 10);
    }
    
    this.performanceHistory.set(data.queryHash, history);
    await this.analyzePerformancePattern(data);
    console.log(`✅ Performance recorded for query hash: ${data.queryHash}`);
  }

  private async analyzePerformancePattern(data: any): Promise<void> {
    try {
      const modelEfficiency = this.calculateModelEfficiency(data);
      console.log(`📊 Model efficiency for ${data.model}: ${modelEfficiency}`);
      
      if (modelEfficiency < 0.7) {
        await database.recordIntelligence(
          'llm-performance-optimizer',
          'optimization',
          {
            recommendation: 'suboptimal_model_selection',
            queryHash: data.queryHash,
            currentModel: data.model,
            efficiency: modelEfficiency,
            suggestedImprovement: this.suggestBetterModel(data)
          },
          0.8,
          3.0
        );
        console.log(`⚠️ Recorded optimization recommendation for query hash: ${data.queryHash}`);
      }
    } catch (error) {
      console.error(`❌ Failed to analyze performance pattern: ${error}`);
    }
  }

  private calculateModelEfficiency(data: any): number {
    const quality = data.quality || 0.8;
    const timeScore = Math.max(0.1, 1 - (data.actualProcessingTime / 10000));
    const resourceCost = this.getModelResourceCost(data.model);
    
    return (quality * timeScore) / resourceCost;
  }

  private getModelResourceCost(model: ModelType): number {
    const costs = {
      [ModelType.MISTRAL_7B]: 0.3,
      [ModelType.CODELLAMA_34B]: 0.7,
      [ModelType.LLAMA2_70B]: 1.0
    };
    return costs[model] || 0.5;
  }

  private suggestBetterModel(data: any): string {
    if (data.actualProcessingTime > data.estimatedProcessingTime * 2) {
      if (data.model === ModelType.LLAMA2_70B) {
        return 'Consider using CodeLlama-34B for better speed';
      }
      if (data.model === ModelType.CODELLAMA_34B) {
        return 'Consider using Mistral-7B for better speed';
      }
    }
    
    if (data.quality && data.quality < 0.6) {
      if (data.model === ModelType.MISTRAL_7B) {
        return 'Consider using CodeLlama-34B for better quality';
      }
      if (data.model === ModelType.CODELLAMA_34B) {
        return 'Consider using Llama2-70B for better quality';
      }
    }
    
    return 'Current model selection appears optimal';
  }

  async getOptimizationRecommendations(): Promise<any[]> {
    console.log('📈 Fetching optimization recommendations...');
    try {
      const recentOptimizations = await database.query(`
        SELECT 
          analysis_data,
          confidence_level,
          impact_score,
          created_at
        FROM system_intelligence 
        WHERE component = 'llm-performance-optimizer'
          AND intelligence_type = 'optimization'
          AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
        ORDER BY impact_score DESC, confidence_level DESC
        LIMIT 10
      `);

      const recommendations = recentOptimizations.map((opt: any) => ({
        ...JSON.parse(opt.analysis_data),
        confidence: opt.confidence_level,
        impact: opt.impact_score,
        timestamp: opt.created_at
      }));
      console.log(`✅ Retrieved ${recommendations.length} optimization recommendations`);
      return recommendations;
    } catch (error) {
      console.error(`❌ Failed to fetch optimization recommendations: ${error}`);
      return [];
    }
  }

  getPerformanceStats(): any {
    let totalQueries = 0;
    let totalTime = 0;
    let totalAccuracy = 0;
    const modelUsage = new Map<ModelType, number>();

    for (const history of this.performanceHistory.values()) {
      for (const record of history) {
        totalQueries++;
        totalTime += record.actualProcessingTime;
        totalAccuracy += (1 - record.accuracy);
        
        const count = modelUsage.get(record.model) || 0;
        modelUsage.set(record.model, count + 1);
      }
    }

    const stats = {
      totalQueries,
      averageProcessingTime: totalQueries > 0 ? Math.round(totalTime / totalQueries) : 0,
      averagePredictionAccuracy: totalQueries > 0 ? (totalAccuracy / totalQueries * 100).toFixed(1) + '%' : '0%',
      modelUsageDistribution: Object.fromEntries(modelUsage),
      trackingUniqueQueries: this.performanceHistory.size
    };
    console.log(`📊 Performance stats: ${JSON.stringify(stats)}`);
    return stats;
  }
}

// ================================
// MAIN INTELLIGENCE ENGINE
// ================================

export class LLMIntelligenceEngine {
  private queryAnalyzer: QueryComplexityAnalyzer;
  private performanceTracker: Map<string, any> = new Map();

  constructor() {
    this.queryAnalyzer = new QueryComplexityAnalyzer();
    console.log('🚀 Initializing LLMIntelligenceEngine');
  }

  async analyzeQuery(query: string, context?: any): Promise<ComplexityScore> {
    console.log(`🧠 Analyzing query: "${query.substring(0, 50)}..."`);
    const result = await this.queryAnalyzer.analyzeQuery(query, context);
    console.log(`✅ Query analysis complete: level=${result.level}, model=${result.recommendedModel}`);
    return result;
  }

  async assessConfidence(response: string): Promise<number> {
    console.log(`🧠 Assessing confidence for response: "${response.substring(0, 50)}..."`);
    // Simple confidence assessment based on response length and keywords
    const lengthScore = Math.min(response.length / 1000, 1.0);
    const qualityKeywords = ['confident', 'certain', 'accurate', 'reliable'];
    const keywordScore = qualityKeywords.reduce((score, keyword) => 
      score + (response.toLowerCase().includes(keyword) ? 0.2 : 0), 0);
    
    const confidence = Math.min(0.95, 0.5 + lengthScore + keywordScore);
    console.log(`✅ Confidence assessed: ${confidence}`);
    return confidence;
  }

  async processIntelligentRequest(
    query: string, 
    context?: any, 
    userPreferences?: any
  ): Promise<{
    complexity: ComplexityScore;
    modelSelection: any;
    processingStrategy: any;
    estimatedMetrics: any;
  }> {
    console.log(`🚀 Processing intelligent request: "${query.substring(0, 50)}..."`);
    const startTime = performance.now();
    
    const complexity = await this.queryAnalyzer.analyzeQuery(query, context);
    
    const modelSelection = {
      model: complexity.recommendedModel,
      reasoning: complexity.reasoning,
      confidence: complexity.confidence,
      fallback: this.determineFallbackModel(complexity.recommendedModel)
    };
    
    const processingStrategy = this.determineProcessingStrategy(complexity, modelSelection);
    const estimatedMetrics = this.estimatePerformanceMetrics(complexity, modelSelection);
    
    const processingTime = performance.now() - startTime;
    
    await this.recordIntelligenceDecision({
      query_hash: this.getQueryHash(query),
      complexity,
      modelSelection,
      processingStrategy,
      estimatedMetrics,
      intelligenceProcessingTime: processingTime
    });
    
    console.log(`✅ Intelligent request processed: model=${modelSelection.model}, processingTime=${processingTime.toFixed(2)}ms`);
    return {
      complexity,
      modelSelection,
      processingStrategy,
      estimatedMetrics
    };
  }

  private determineProcessingStrategy(complexity: ComplexityScore, modelSelection: any): any {
    const strategy = {
      useStreaming: complexity.level > 5,
      enableCache: complexity.level <= 5,
      timeoutMs: Math.max(5000, complexity.estimatedTokens * 50),
      retryStrategy: {
        maxRetries: complexity.level > 7 ? 2 : 1,
        fallbackModel: modelSelection.fallback
      },
      memoryManagement: {
        preloadModel: complexity.level > 6,
        unloadOtherModels: complexity.level > 8
      }
    };
    console.log(`📋 Processing strategy: ${JSON.stringify(strategy)}`);
    return strategy;
  }

  private estimatePerformanceMetrics(complexity: ComplexityScore, modelSelection: any): any {
    const metrics = {
      estimatedResponseTime: complexity.processingTime,
      estimatedTokens: complexity.estimatedTokens,
      estimatedMemoryUsage: this.getModelMemoryUsage(modelSelection.model),
      confidenceLevel: complexity.confidence * modelSelection.confidence,
      resourceIntensity: this.calculateResourceIntensity(complexity, modelSelection),
      qualityScore: this.estimateResponseQuality(complexity, modelSelection)
    };
    console.log(`📊 Estimated metrics: ${JSON.stringify(metrics)}`);
    return metrics;
  }

  private getModelMemoryUsage(model: ModelType): number {
    const memoryMap = {
      [ModelType.MISTRAL_7B]: 7000,
      [ModelType.CODELLAMA_34B]: 20000,
      [ModelType.LLAMA2_70B]: 40000
    };
    return memoryMap[model] || 0;
  }

  private calculateResourceIntensity(complexity: ComplexityScore, modelSelection: any): number {
    const baseIntensity = complexity.level / 10;
    const modelMultiplier: Record<ModelType, number> = {
      [ModelType.MISTRAL_7B]: 0.3,
      [ModelType.CODELLAMA_34B]: 0.7,
      [ModelType.LLAMA2_70B]: 1.0
    };
    
    return baseIntensity * (modelMultiplier[modelSelection.model as ModelType] || 0.5);
  }

  private estimateResponseQuality(complexity: ComplexityScore, modelSelection: any): number {
    let qualityScore = 0.7;
    
    if (modelSelection.model === complexity.recommendedModel) {
      qualityScore += 0.2;
    }
    
    if (complexity.level <= 3 && modelSelection.model === ModelType.LLAMA2_70B) {
      qualityScore -= 0.1;
    }
    
    if (complexity.level >= 8 && modelSelection.model === ModelType.MISTRAL_7B) {
      qualityScore -= 0.3;
    }
    
    return Math.max(0.1, Math.min(1.0, qualityScore));
  }

  private determineFallbackModel(primaryModel: ModelType): ModelType {
    const fallback = {
      [ModelType.LLAMA2_70B]: ModelType.CODELLAMA_34B,
      [ModelType.CODELLAMA_34B]: ModelType.MISTRAL_7B,
      [ModelType.MISTRAL_7B]: ModelType.MISTRAL_7B
    }[primaryModel];
    console.log(`📋 Fallback model for ${primaryModel}: ${fallback}`);
    return fallback;
  }

  private async recordIntelligenceDecision(data: any): Promise<void> {
    try {
      await database.recordIntelligence(
        'llm-intelligence-engine',
        'prediction',
        data,
        data.complexity.confidence,
        data.complexity.level
      );
      console.log(`📊 Recorded intelligence decision for query hash: ${data.query_hash}`);
    } catch (error) {
      console.error(`❌ Failed to record intelligence decision: ${error}`);
    }
  }

  private hashQuery(query: string): string {
    return Buffer.from(query.toLowerCase().replace(/\s+/g, ' ').trim()).toString('base64').substring(0, 16);
  }

  public getQueryHash(query: string): string {
    console.log(`🧠 Generating query hash for: "${query.substring(0, 50)}..."`);
    const hash = this.hashQuery(query);
    console.log(`✅ Generated query hash: ${hash}`);
    return hash;
  }

  async getIntelligenceStats(): Promise<any> {
    console.log('📊 Fetching intelligence stats...');
    try {
      const stats = await database.query(`
        SELECT 
          COUNT(*) as total_decisions,
          AVG(confidence_level) as avg_confidence,
          AVG(impact_score) as avg_complexity,
          DATE(created_at) as decision_date
        FROM system_intelligence 
        WHERE component = 'llm-intelligence-engine'
          AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY DATE(created_at)
        ORDER BY decision_date DESC
        LIMIT 7
      `);

      const intelligenceStats = {
        recentDecisions: stats,
        engineStatus: 'active',
        learningEnabled: true,
        cacheSize: this.queryAnalyzer['patternCache'].size
      };
      console.log(`✅ Intelligence stats: ${JSON.stringify(intelligenceStats)}`);
      return intelligenceStats;
    } catch (error) {
      console.error(`❌ Failed to fetch intelligence stats: ${error}`);
      return {
        engineStatus: 'active',
        learningEnabled: true,
        cacheSize: this.queryAnalyzer['patternCache'].size,
        note: 'Database stats unavailable'
      };
    }
  }
}

// ================================
// EXPORTS
// ================================

export const llmIntelligenceEngine = new LLMIntelligenceEngine();
export const contextMemorySystem = new ContextMemorySystem();
export const performanceOptimizer = new LLMPerformanceOptimizer();

// Start periodic cleanup
setInterval(() => {
  contextMemorySystem.cleanupOldContexts();
}, 60 * 60 * 1000); // Every hour

console.log('🧠 DINA LLM Intelligence Engine initialized successfully');

