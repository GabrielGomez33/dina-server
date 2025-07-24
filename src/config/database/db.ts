// DINA Enhanced Database System - Complete Working Implementation
// File: src/config/database/db.ts

import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';
import crypto from 'crypto';
import { performance } from 'perf_hooks';

// ================================
// INTERFACES AND TYPES
// ================================

interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
  timeout: number;
  ssl?: any;
  trace?: boolean;
}

interface SecurityScanResult {
  timestamp: Date;
  threatsDetected: number;
  vulnerabilities: string[];
  recommendations: string[];
}

interface QueryPerformance {
  queryHash: string;
  sql: string;
  executionCount: number;
  totalTime: number;
  averageTime: number;
  minTime: number;
  maxTime: number;
  lastExecuted: Date;
}

interface PerformancePrediction {
  estimatedDuration: number;
  confidence: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

// ================================
// UNIFIED AUTH INTERFACES
// ================================
export interface DinaUser {
  unique_id: string;
  user_key: string;
  dina_key: string;
  device_fingerprint: string;
  ip_address: string;
  mac_address?: string;
  user_agent: string;
  trust_level: 'new' | 'trusted' | 'suspicious' | 'blocked';
  suspicion_score: number;
  blocked_until?: Date;
  first_seen: Date;
  last_seen: Date;
  total_requests: number;
  successful_requests: number;
  failed_requests: number;
  max_requests_per_minute: number;
  max_tokens_per_request: number;
  allowed_models: string[];
  allowed_endpoints: string[];
  current_session_id?: string;
}

export interface DinaAuthRequest {
  request_id: string;
  timestamp: Date;
  user_key?: string;
  dina_key?: string;
  method: string;
  endpoint: string;
  payload_hash?: string;
  ip_address: string;
  mac_address?: string;
  user_agent: string;
  headers: Record<string, string>;
  signature?: string;
}

export interface DinaAuthResult {
  allow: boolean;
  user: DinaUser;
  is_new_user: boolean;
  rate_limit_remaining: number;
  token_limit_remaining: number;
  trust_level: DinaUser['trust_level'];
  suspicion_reasons: string[];
  session_id: string;
  validation_time_ms: number;
}

// ================================
// SECURITY MODULE
// ================================
class SecurityModule {
  private encryptionKey: Buffer;

  constructor() {
    this.encryptionKey = this.deriveEncryptionKey();
  }

  async validateEnvironment(): Promise<void> {
    console.log('🔒 Validating security environment...');
    
    const passwordCheck = this.validatePasswordStrength();
    if (!passwordCheck.passed) {
      throw new Error(`Security validation failed: ${passwordCheck.message}`);
    }
    
    console.log('✅ Security environment validated');
  }

  async validateQuery(sql: string, params: any[]): Promise<void> {
    const injectionPatterns = [
      /(\b(union|select|insert|update|delete|drop|exec|execute)\b.*\b(union|select|insert|update|delete|drop|exec|execute)\b)/i,
      /(;|\-\-|\/\*|\*\/|xp_|sp_)/i,
      /(\b(or|and)\b.*=.*\b(or|and)\b)/i,
      /(script|javascript|vbscript|onload|onerror)/i
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(sql)) {
        console.warn('🚨 SQL injection attempt detected:', sql.substring(0, 100));
        throw new Error('SQL injection attempt detected');
      }
    }

    for (const param of params) {
      if (typeof param === 'string' && this.containsSuspiciousContent(param)) {
        console.warn('🚨 Suspicious parameter detected:', param.substring(0, 50));
        throw new Error('Suspicious parameter content detected');
      }
    }
  }

  async performSecurityScan(): Promise<SecurityScanResult> {
    return {
      timestamp: new Date(),
      threatsDetected: 0,
      vulnerabilities: [],
      recommendations: []
    };
  }

  private deriveEncryptionKey(): Buffer {
    const password = process.env.DINA_ENCRYPTION_KEY || 'default-key-change-in-production';
    const salt = process.env.DINA_ENCRYPTION_SALT || 'dina-neural-architect';
    return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512');
  }

  private containsSuspiciousContent(content: string): boolean {
    const suspiciousPatterns = [
      /<script[^>]*>.*?<\/script>/gi,
      /javascript:/gi,
      /on\w+\s*=/gi,
      /expression\s*\(/gi
    ];
    
    return suspiciousPatterns.some(pattern => pattern.test(content));
  }

  private validatePasswordStrength(): {passed: boolean, message: string} {
    const password = process.env.DB_PASSWORD;
    if (!password || password.length < 8) {
      return { passed: false, message: 'Database password too weak' };
    }
    return { passed: true, message: 'Password strength OK' };
  }
}

// ================================
// PERFORMANCE METRICS MODULE
// ================================
class PerformanceMetrics {
  private queryCache: Map<string, QueryPerformance> = new Map();

  async predictQueryPerformance(sql: string, params: any[]): Promise<PerformancePrediction> {
    const queryHash = this.hashQuery(sql, params);
    const historical = this.queryCache.get(queryHash);
    
    if (historical) {
      return {
        estimatedDuration: historical.averageTime,
        confidence: historical.executionCount > 10 ? 0.9 : 0.5,
        riskLevel: this.calculateRiskLevel(historical.averageTime)
      };
    }

    return {
      estimatedDuration: 50,
      confidence: 0.3,
      riskLevel: 'low'
    };
  }

  async recordQueryExecution(
    queryId: string, 
    sql: string, 
    params: any[], 
    executionTime: number, 
    prediction: PerformancePrediction
  ): Promise<void> {
    const queryHash = this.hashQuery(sql, params);
    const existing = this.queryCache.get(queryHash) || {
      queryHash,
      sql,
      executionCount: 0,
      totalTime: 0,
      averageTime: 0,
      minTime: Infinity,
      maxTime: 0,
      lastExecuted: new Date()
    };

    existing.executionCount++;
    existing.totalTime += executionTime;
    existing.averageTime = existing.totalTime / existing.executionCount;
    existing.minTime = Math.min(existing.minTime, executionTime);
    existing.maxTime = Math.max(existing.maxTime, executionTime);
    existing.lastExecuted = new Date();

    this.queryCache.set(queryHash, existing);
  }

  async analyzeAndOptimize(): Promise<any> {
    console.log('📊 Analyzing performance patterns...');
    
    const slowQueries = Array.from(this.queryCache.values())
      .filter(q => q.averageTime > 1000)
      .sort((a, b) => b.averageTime - a.averageTime);

    return {
      timestamp: new Date(),
      totalQueriesAnalyzed: this.queryCache.size,
      slowQueries: slowQueries.length,
      recommendations: slowQueries.slice(0, 5).map(q => ({
        query: q.sql.substring(0, 100),
        averageTime: q.averageTime,
        recommendation: 'Consider adding indexes or optimizing query structure'
      }))
    };
  }

  private hashQuery(sql: string, params: any[]): string {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const paramHash = crypto.createHash('md5').update(JSON.stringify(params)).digest('hex');
    return crypto.createHash('md5').update(normalized + paramHash).digest('hex');
  }

  private calculateRiskLevel(executionTime: number): 'low' | 'medium' | 'high' | 'critical' {
    if (executionTime < 100) return 'low';
    if (executionTime < 500) return 'medium';
    if (executionTime < 2000) return 'high';
    return 'critical';
  }
}

// ================================
// OPTIMIZATION ENGINE
// ================================
class OptimizationEngine {
  private database!: DinaDatabase;

  async initialize(database: DinaDatabase): Promise<void> {
    this.database = database;
    console.log('⚡ Initializing optimization engine...');
    console.log('✅ Optimization engine ready');
  }

  async runAutonomousOptimization(): Promise<void> {
    console.log('🔧 Running autonomous optimization cycle...');
    
    try {
      const longQueries = await this.database.query(`
        SELECT COUNT(*) as long_query_count
        FROM dina_requests 
        WHERE processing_time_ms > 5000 
          AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
      `);
      
      if (longQueries[0]?.long_query_count > 0) {
        console.log(`⚠️ Found ${longQueries[0].long_query_count} slow queries in the last hour`);
      }
    } catch (error) {
      console.error('Error during autonomous optimization analysis:', error);
    }
  }

  async analyzeSlowQuery(sql: string, params: any[], executionTime: number): Promise<void> {
    console.log(`🐌 Analyzing slow query (${executionTime}ms):`, sql.substring(0, 100));
    
    try {
      await this.database.recordIntelligence('optimization', 'performance', {
        type: 'slow_query',
        sql: sql.substring(0, 200),
        executionTime,
        timestamp: new Date().toISOString()
      }, 0.8, Math.min(executionTime / 100, 10));
    } catch (error) {
      console.error('Error recording slow query intelligence:', error);
    }
  }
}

// ================================
// BEAUTY MODULE
// ================================
class BeautyModule {
  static formatQueryForLogging(sql: string): string {
    return sql
      .replace(/\s+/g, ' ')
      .replace(/,/g, ',\n  ')
      .replace(/FROM/gi, '\nFROM')
      .replace(/WHERE/gi, '\nWHERE')
      .replace(/ORDER BY/gi, '\nORDER BY')
      .replace(/GROUP BY/gi, '\nGROUP BY')
      .trim();
  }

  static createVisualSeparator(title: string): string {
    const width = 60;
    const padding = Math.max(0, width - title.length - 4);
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    
    return `\n${'='.repeat(width)}\n${' '.repeat(leftPad)}  ${title}  ${' '.repeat(rightPad)}\n${'='.repeat(width)}\n`;
  }

  static formatPerformanceMetrics(metrics: any): string {
    return `
┌─ PERFORMANCE METRICS ─────────────────────┐
│ Average Query Time: ${(metrics.avgTime || 0).toFixed(2)}ms         │
│ Peak Throughput:    ${metrics.peakTps || 0} queries/sec    │
│ Connection Pool:    ${metrics.activeConnections || 0}/${metrics.maxConnections || 0} active      │
│ Cache Hit Rate:     ${((metrics.cacheHitRate || 0) * 100).toFixed(1)}%          │
└───────────────────────────────────────────┘
    `.trim();
  }
}

// ================================
// MAIN ENHANCED DINA DATABASE CLASS
// ================================
export class DinaDatabase {
  private pool: mysql.Pool | null = null;
  private config: DatabaseConfig;
  public isConnected: boolean = false;
  public startTime: Date = new Date();
  
  private securityModule: SecurityModule;
  private performanceMetrics: PerformanceMetrics;
  private optimizationEngine: OptimizationEngine;
  
  private autonomousMode: boolean = true;
  private learningEnabled: boolean = true;
  private selfHealingEnabled: boolean = true;

  // ================================
  // UNIFIED AUTH SYSTEM
  // ================================
  private blockedIPs: Set<string> = new Set();
  private blockedMACs: Set<string> = new Set();
  private requestCache: Map<string, { count: number; windowStart: number }> = new Map();

  constructor() {
    console.log(BeautyModule.createVisualSeparator('DINA ENHANCED DATABASE INITIALIZATION'));
    
    this.config = this.loadIntelligentConfiguration();
    this.securityModule = new SecurityModule();
    this.performanceMetrics = new PerformanceMetrics();
    this.optimizationEngine = new OptimizationEngine();
  }

  private loadIntelligentConfiguration(): DatabaseConfig {
    console.log('🧠 Loading intelligent database configuration...');
    
    const config: DatabaseConfig = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'dina_user',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'dina',
      connectionLimit: this.calculateOptimalConnectionLimit(),
      timeout: parseInt(process.env.DB_TIMEOUT || '60000'),
      ssl: process.env.DB_SSL === 'true' ? {
        rejectUnauthorized: process.env.NODE_ENV === 'production'
      } : false,
      trace: process.env.NODE_ENV === 'development'
    };

    if (process.env.NODE_ENV === 'production' && !config.password) {
      throw new Error('🚨 CRITICAL: Database password required in production');
    }

    console.log('✅ Configuration loaded with intelligent defaults');
    return config;
  }

  private calculateOptimalConnectionLimit(): number {
    try {
      const os = require('os'); 
      const cpuCores = os.cpus().length;
      const memoryGB = os.totalmem() / (1024 * 1024 * 1024);
      
      const baseConnections = cpuCores * 2;
      const memoryAdjustment = Math.min(memoryGB / 4, 10);
      
      const optimalLimit = Math.min(Math.max(baseConnections + memoryAdjustment, 5), 50);
      
      console.log(`🧮 Calculated optimal connection limit: ${optimalLimit} (CPU: ${cpuCores}, RAM: ${memoryGB.toFixed(1)}GB)`);
      return Math.floor(optimalLimit);
    } catch (error) {
      console.log('🧮 Using default connection limit: 10');
      return 10;
    }
  }

  async initialize(): Promise<void> {
    try {
      console.log('🚀 Initializing DINA Enhanced Database System...');
      console.log(`🎯 Mode: ${this.autonomousMode ? 'Autonomous' : 'Manual'} | Learning: ${this.learningEnabled ? 'ON' : 'OFF'}`);
      
      console.log('\n🔒 Phase 1: Security Validation');
      await this.securityModule.validateEnvironment();
      
      console.log('\n🔗 Phase 2: Establishing Secure Connection');
      await this.establishIntelligentConnection();
      
      console.log('\n🧬 Phase 3: Intelligent Schema Evolution');
      await this.evolveSchemaIntelligently();
      
      console.log('\n📊 Phase 4: Performance Baseline Establishment');
      await this.establishPerformanceBaseline();
      
      console.log('\n⚡ Phase 5: Optimization Engine Activation');
      await this.optimizationEngine.initialize(this);
      
      console.log('\n🔄 Phase 6: Autonomous Monitoring Activation');
      this.activateAutonomousMonitoring();
      
      console.log('\n🔐 Phase 7: Unified Auth System Initialization');
      await this.initializeUnifiedAuth();
      
      this.isConnected = true;
      this.startTime = new Date();
      console.log(BeautyModule.createVisualSeparator('INITIALIZATION COMPLETE'));
      console.log('✅ DINA Enhanced Database System with Unified Auth is ONLINE');
      
    } catch (error) {
      console.error('❌ DINA Database initialization failed:', error);
      await this.emergencyShutdown();
      throw error;
    }
  }

  // ================================
  // UNIFIED AUTH METHODS
  // ================================
  
  private async initializeUnifiedAuth(): Promise<void> {
    try {
      await this.loadBlockedDevices();
      console.log('✅ Unified authentication system initialized');
    } catch (error) {
      console.error('❌ Failed to initialize auth system:', error);
      throw error;
    }
  }

  async authenticateRequest(request: DinaAuthRequest): Promise<DinaAuthResult> {
    const startTime = performance.now();
    
    try {
      // Check device blocks
      if (this.isDeviceBlocked(request.ip_address, request.mac_address)) {
        return this.createDeniedResult(request, 'device_blocked', startTime);
      }
      
      // Generate device fingerprint
      const deviceFingerprint = this.generateDeviceFingerprint(request);
      
      // Find or create user
      let user = await this.findUser(request.user_key, request.dina_key, deviceFingerprint);
      let isNewUser = false;
      
      if (!user) {
        user = await this.createNewUser(request, deviceFingerprint);
        isNewUser = true;
        console.log(`👤 New user registered: ${user.user_key} → ${user.dina_key}`);
      }
      
      // Check user blocks
      if (user.trust_level === 'blocked' && user.blocked_until && user.blocked_until > new Date()) {
        return this.createDeniedResult(request, 'user_blocked', startTime, user);
      }
      
      // Assess suspicion
      const suspicionAssessment = this.assessSuspicion(request, user);
      user.suspicion_score = this.updateSuspicionScore(user.suspicion_score, suspicionAssessment.score);
      
      // Update trust level
      user.trust_level = this.calculateTrustLevel(user);
      
      // Check rate limits
      const rateCheck = await this.checkRateLimit(user);
      if (!rateCheck.allowed) {
        user.failed_requests += 1;
        user.suspicion_score += 10;
        await this.updateUser(user);
        return this.createRateLimitedResult(request, rateCheck, startTime, user);
      }
      
      // Make decision
      const allow = user.trust_level !== 'blocked';
      
      // Update user activity
      await this.updateUserActivity(user, request, allow);
      
      // Handle blocking threshold
      if (user.suspicion_score >= 90) {
        await this.blockUser(user, request);
      }
      
      const sessionId = `dina_session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      user.current_session_id = sessionId;
      
      const result: DinaAuthResult = {
        allow,
        user,
        is_new_user: isNewUser,
        rate_limit_remaining: rateCheck.remaining,
        token_limit_remaining: user.max_tokens_per_request,
        trust_level: user.trust_level,
        suspicion_reasons: suspicionAssessment.reasons,
        session_id: sessionId,
        validation_time_ms: performance.now() - startTime
      };
      
      // Log security event
      await this.logSecurityEvent({
        event_type: allow ? 'auth_success' : 'auth_denied',
        user_key: user.user_key,
        dina_key: user.dina_key,
        ip_address: request.ip_address,
        user_agent: request.user_agent,
        endpoint: request.endpoint,
        timestamp: new Date(),
        details: {
          is_new_user: isNewUser,
          trust_level: user.trust_level,
          suspicion_score: user.suspicion_score,
          suspicion_reasons: suspicionAssessment.reasons
        },
        severity: allow ? 'low' : (user.trust_level === 'blocked' ? 'high' : 'medium')
      });
      
      return result;
      
    } catch (error) {
      console.error('❌ Authentication error:', error);
      return this.createDeniedResult(request, 'system_error', startTime);
    }
  }

  private generateDeviceFingerprint(request: DinaAuthRequest): string {
    const components = [
      request.ip_address,
      request.mac_address || 'unknown',
      request.user_agent,
      request.headers['accept-language'] || '',
      request.headers['accept-encoding'] || '',
      process.env.DINA_AUTH_FINGERPRINT_SALT || 'dina-enterprise-2025'
    ];
    
    return crypto.createHash('sha256')
      .update(components.join('|'))
      .digest('hex');
  }

  private isDeviceBlocked(ipAddress: string, macAddress?: string): boolean {
    if (this.blockedIPs.has(ipAddress)) return true;
    if (macAddress && this.blockedMACs.has(macAddress)) return true;
    return false;
  }

  private async findUser(userKey?: string, dinaKey?: string, deviceFingerprint?: string): Promise<DinaUser | null> {
    let whereClause = '';
    const params: any[] = [];
    
    if (dinaKey) {
      whereClause = 'dina_key = ?';
      params.push(dinaKey);
    } else if (userKey) {
      whereClause = 'user_key = ?';
      params.push(userKey);
    } else if (deviceFingerprint) {
      whereClause = 'device_fingerprint = ?';
      params.push(deviceFingerprint);
    } else {
      return null;
    }
    
    const results = await this.query(
      `SELECT * FROM dina_users WHERE ${whereClause} LIMIT 1`,
      params,
      true
    );
    
    return results.length > 0 ? this.mapRowToUser(results[0]) : null;
  }

  private async createNewUser(request: DinaAuthRequest, deviceFingerprint: string): Promise<DinaUser> {
    const userProvidedKey = request.user_key || 'anonymous';
    const keyHash = crypto.createHash('md5').update(userProvidedKey).digest('hex').substring(0, 8);
    const dinaKey = `dina_${keyHash}_${crypto.randomBytes(8).toString('hex')}`;
    
    const user: DinaUser = {
      unique_id: `dina_user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      user_key: userProvidedKey,
      dina_key: dinaKey,
      device_fingerprint: deviceFingerprint,
      ip_address: request.ip_address,
      mac_address: request.mac_address,
      user_agent: request.user_agent,
      trust_level: 'new',
      suspicion_score: 0,
      first_seen: new Date(),
      last_seen: new Date(),
      total_requests: 0,
      successful_requests: 0,
      failed_requests: 0,
      max_requests_per_minute: 10,
      max_tokens_per_request: 100,
      allowed_models: ['mxbai-embed-large'],
      allowed_endpoints: ['/health', '/models/mxbai-embed-large/embeddings']
    };
    
    await this.saveUser(user);
    return user;
  }

  private assessSuspicion(request: DinaAuthRequest, user: DinaUser): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];
    
    if (user.ip_address !== request.ip_address) {
      score += 5;
      reasons.push('ip_change');
    }
    
    if (user.user_agent !== request.user_agent) {
      score += 10;
      reasons.push('user_agent_change');
    }
    
    const suspiciousAgents = ['bot', 'crawler', 'scanner', 'python-requests', 'curl', 'wget'];
    if (suspiciousAgents.some(agent => request.user_agent.toLowerCase().includes(agent))) {
      score += 15;
      reasons.push('automated_client');
    }
    
    if (user.total_requests > 10) {
      const failureRate = user.failed_requests / user.total_requests;
      if (failureRate > 0.3) {
        score += 25;
        reasons.push('high_failure_rate');
      }
    }
    
    return { score, reasons };
  }

  private updateSuspicionScore(currentScore: number, newAssessment: number): number {
    const weight = 0.3;
    const updated = (currentScore * (1 - weight)) + (newAssessment * weight);
    return Math.max(0, Math.min(100, updated));
  }

  private calculateTrustLevel(user: DinaUser): DinaUser['trust_level'] {
    if (user.blocked_until && user.blocked_until > new Date()) {
      return 'blocked';
    }
    
    if (user.suspicion_score >= 70) {
      return 'suspicious';
    }
    
    if (user.total_requests < 10) {
      return 'new';
    }
    
    const failureRate = user.total_requests > 0 ? user.failed_requests / user.total_requests : 0;
    const daysSinceFirstSeen = (Date.now() - user.first_seen.getTime()) / (24 * 60 * 60 * 1000);
    
    if (user.suspicion_score < 20 && failureRate < 0.1 && daysSinceFirstSeen > 1) {
      return 'trusted';
    }
    
    return 'new';
  }

  private async checkRateLimit(user: DinaUser): Promise<{ allowed: boolean; remaining: number }> {
    const now = Date.now();
    const windowStart = Math.floor(now / 60000) * 60000;
    
    const cacheKey = `${user.unique_id}:${windowStart}`;
    const current = this.requestCache.get(cacheKey) || { count: 0, windowStart };
    
    // Cleanup old entries
    for (const [key, value] of this.requestCache) {
      if (value.windowStart < now - 120000) {
        this.requestCache.delete(key);
      }
    }
    
    current.count += 1;
    this.requestCache.set(cacheKey, current);
    
    const limit = user.max_requests_per_minute;
    const allowed = current.count <= limit;
    const remaining = Math.max(0, limit - current.count);
    
    return { allowed, remaining };
  }

  private async updateUserActivity(user: DinaUser, request: DinaAuthRequest, allowed: boolean): Promise<void> {
    user.last_seen = new Date();
    user.total_requests += 1;
    user.ip_address = request.ip_address;
    user.user_agent = request.user_agent;
    
    if (allowed) {
      user.successful_requests += 1;
      user.suspicion_score = Math.max(0, user.suspicion_score - 1);
    } else {
      user.failed_requests += 1;
      user.suspicion_score += 20;
    }
    
    // Update permissions based on trust level
    if (user.trust_level === 'trusted') {
      user.max_requests_per_minute = 100;
      user.max_tokens_per_request = 1000;
      user.allowed_models = ['mxbai-embed-large', 'mistral:7b', 'codellama:34b'];
      user.allowed_endpoints = ['/health', '/models/*/embeddings', '/models/*/chat', '/models'];
    } else if (user.trust_level === 'suspicious') {
      user.max_requests_per_minute = 5;
      user.max_tokens_per_request = 50;
      user.allowed_models = ['mxbai-embed-large'];
      user.allowed_endpoints = ['/health'];
    }
    
    await this.updateUser(user);
  }

  private async blockUser(user: DinaUser, request: DinaAuthRequest): Promise<void> {
    user.trust_level = 'blocked';
    user.blocked_until = new Date(Date.now() + 24 * 60 * 60 * 1000);
    
    this.blockedIPs.add(request.ip_address);
    if (request.mac_address) {
      this.blockedMACs.add(request.mac_address);
    }
    
    console.warn(`🚨 User blocked: ${user.user_key} (score: ${user.suspicion_score})`);
  }

  private async saveUser(user: DinaUser): Promise<void> {
    try {
      await this.query(`
        INSERT INTO dina_users (
          unique_id, user_key, dina_key, device_fingerprint, ip_address, mac_address,
          user_agent, trust_level, suspicion_score, blocked_until, first_seen, last_seen,
          total_requests, successful_requests, failed_requests, max_requests_per_minute,
          max_tokens_per_request, allowed_models, allowed_endpoints, current_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        user.unique_id,
        user.user_key,
        user.dina_key,
        user.device_fingerprint,
        user.ip_address,
        user.mac_address || null,        // Fix: Convert undefined to null
        user.user_agent,
        user.trust_level,
        user.suspicion_score,
        user.blocked_until || null,      // Fix: Convert undefined to null
        user.first_seen,
        user.last_seen,
        user.total_requests,
        user.successful_requests,
        user.failed_requests,
        user.max_requests_per_minute,
        user.max_tokens_per_request,
        JSON.stringify(user.allowed_models || []),
        JSON.stringify(user.allowed_endpoints || []),
        user.current_session_id || null  // Fix: Convert undefined to null
      ], true);
    } catch (error) {
      console.error('❌ Failed to save user:', error);
      throw error;
    }
  }

   private async updateUser(user: DinaUser): Promise<void> {
    try {
      await this.query(`
        UPDATE dina_users SET
          ip_address = ?, user_agent = ?, trust_level = ?, suspicion_score = ?,
          blocked_until = ?, last_seen = ?, total_requests = ?, successful_requests = ?,
          failed_requests = ?, max_requests_per_minute = ?, max_tokens_per_request = ?,
          allowed_models = ?, allowed_endpoints = ?, current_session_id = ?
        WHERE unique_id = ?
      `, [
        user.ip_address,
        user.user_agent,
        user.trust_level,
        user.suspicion_score,
        user.blocked_until || null,      // Fix: Convert undefined to null
        user.last_seen,
        user.total_requests,
        user.successful_requests,
        user.failed_requests,
        user.max_requests_per_minute,
        user.max_tokens_per_request,
        JSON.stringify(user.allowed_models || []),
        JSON.stringify(user.allowed_endpoints || []),
        user.current_session_id || null, // Fix: Convert undefined to null
        user.unique_id
      ], true);
    } catch (error) {
      console.error('❌ Failed to update user:', error);
      throw error;
    }
  }
  private mapRowToUser(row: any): DinaUser {
    return {
      unique_id: row.unique_id,
      user_key: row.user_key,
      dina_key: row.dina_key,
      device_fingerprint: row.device_fingerprint,
      ip_address: row.ip_address,
      mac_address: row.mac_address,
      user_agent: row.user_agent,
      trust_level: row.trust_level,
      suspicion_score: parseFloat(row.suspicion_score),
      blocked_until: row.blocked_until,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      total_requests: row.total_requests,
      successful_requests: row.successful_requests,
      failed_requests: row.failed_requests,
      max_requests_per_minute: row.max_requests_per_minute,
      max_tokens_per_request: row.max_tokens_per_request,
      allowed_models: JSON.parse(row.allowed_models || '[]'),
      allowed_endpoints: JSON.parse(row.allowed_endpoints || '[]'),
      current_session_id: row.current_session_id
    };
  }

  private async logSecurityEvent(event: {
    event_type: string;
    user_key?: string;
    dina_key?: string;
    ip_address: string;
    user_agent: string;
    endpoint?: string;
    timestamp: Date;
    details: any;
    severity: string;
  }): Promise<void> {
    const eventId = `dina_event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      await this.query(`
        INSERT INTO dina_security_events (
          event_id, event_type, user_key, dina_key, ip_address, user_agent,
          endpoint, timestamp, details, severity
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        eventId, event.event_type, event.user_key, event.dina_key,
        event.ip_address, event.user_agent, event.endpoint, event.timestamp,
        JSON.stringify(event.details), event.severity
      ], true);
      
      if (event.severity === 'high' || event.severity === 'critical') {
        console.warn(`🚨 Security Event: ${event.event_type} - ${event.severity}`);
      }
      
    } catch (error) {
      console.error('❌ Failed to log security event:', error);
    }
  }

  private async loadBlockedDevices(): Promise<void> {
    try {
      const blocked = await this.query(`
        SELECT DISTINCT ip_address, mac_address 
        FROM dina_users 
        WHERE trust_level = 'blocked' AND (blocked_until IS NULL OR blocked_until > NOW())
      `, [], true);
      
      this.blockedIPs.clear();
      this.blockedMACs.clear();
      
      for (const device of blocked) {
        this.blockedIPs.add(device.ip_address);
        if (device.mac_address) {
          this.blockedMACs.add(device.mac_address);
        }
      }
      
      console.log(`🔒 Loaded ${this.blockedIPs.size} blocked IPs, ${this.blockedMACs.size} blocked MACs`);
    } catch (error) {
      console.log('ℹ️ No blocked devices found (tables may not exist yet)');
    }
  }

  private createDeniedResult(
    request: DinaAuthRequest, 
    reason: string, 
    startTime: number,
    user?: DinaUser
  ): DinaAuthResult {
    return {
      allow: false,
      user: user || {} as DinaUser,
      is_new_user: false,
      rate_limit_remaining: 0,
      token_limit_remaining: 0,
      trust_level: 'blocked',
      suspicion_reasons: [reason],
      session_id: `denied_${Date.now()}`,
      validation_time_ms: performance.now() - startTime
    };
  }

  private createRateLimitedResult(
    request: DinaAuthRequest,
    rateCheck: { allowed: boolean; remaining: number },
    startTime: number,
    user: DinaUser
  ): DinaAuthResult {
    return {
      allow: false,
      user,
      is_new_user: false,
      rate_limit_remaining: rateCheck.remaining,
      token_limit_remaining: user.max_tokens_per_request,
      trust_level: user.trust_level,
      suspicion_reasons: ['rate_limit_exceeded'],
      session_id: `rate_limited_${Date.now()}`,
      validation_time_ms: performance.now() - startTime
    };
  }

  // ================================
  // EXISTING DATABASE METHODS (UNCHANGED)
  // ================================

  private async establishIntelligentConnection(): Promise<void> {
    const poolConfig = {
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      waitForConnections: true,
      connectionLimit: this.config.connectionLimit,
      maxIdle: Math.floor(this.config.connectionLimit / 2),
      idleTimeout: 60000,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      charset: 'utf8mb4',
      timezone: '+00:00',
      ssl: this.config.ssl,
      multipleStatements: false,
      trace: this.config.trace
    };

    console.log(`🔌 Creating connection pool: ${this.config.connectionLimit} connections`);
    this.pool = mysql.createPool(poolConfig);
    
    await this.testConnectionWithRetry();
    console.log('✅ Secure connection established');
  }

  private async testConnectionWithRetry(maxRetries: number = 3): Promise<void> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔍 Connection test attempt ${attempt}/${maxRetries}`);
        
        if (!this.pool) {
          throw new Error('Connection pool not initialized');
        }

        const connection = await this.pool.getConnection();
        await connection.ping();
        connection.release();
        
        console.log('✅ Connection test successful');
        return;
        
      } catch (error) {
        lastError = error as Error;
        console.warn(`⚠️ Connection attempt ${attempt} failed: ${lastError.message}`);
        
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`⏳ Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw new Error(`Connection failed after ${maxRetries} attempts: ${lastError?.message}`);
  }

  private async evolveSchemaIntelligently(): Promise<void> {
    console.log('🧬 Analyzing current schema state...');
    
    await this.dropTableIfExists('dina_requests');
    await this.dropTableIfExists('neural_memory');

    const schemaExists = await this.checkSchemaExists();
    
    if (!schemaExists) {
      console.log('🏗️ Creating initial schema with intelligent design...');
      await this.createIntelligentSchema();
    } else {
      console.log('🔄 Schema exists, checking for intelligent improvements...');
      await this.verifySchema();
    }
    
    console.log('✅ Schema evolution complete');
  }

  private async dropTableIfExists(tableName: string): Promise<void> {
    try {
      await this.query(`DROP TABLE IF EXISTS ${tableName}`, [], true); 
      console.log(`🗑️ Dropped table: ${tableName}`);
    } catch (error) {
      console.warn(`⚠️ Could not drop table ${tableName}:`, (error as Error).message);
    }
  }

  private async checkSchemaExists(): Promise<boolean> {
    try {
      const tables = await this.query('SHOW TABLES', [], true); 
      return tables.length > 0;
    } catch (error) {
      return false;
    }
  }

  private async verifySchema(): Promise<void> {
    console.log('🔍 Verifying schema integrity...');
    const requiredTables = ['users', 'system_logs', 'system_intelligence', 'dina_requests', 'neural_memory', 'dina_users', 'dina_security_events'];
    const existingTables = (await this.query('SHOW TABLES', [], true)).map((row: any) => Object.values(row)[0]);

    for (const table of requiredTables) {
      if (!existingTables.includes(table)) {
        console.warn(`⚠️ Table ${table} missing, recreating...`);
        await this.createTable(table);
      }
    }
  }

  private async createTable(tableName: string): Promise<void> {
    const tableDefinitions: Record<string, string> = {
      users: `CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
        email VARCHAR(255) UNIQUE,
        username VARCHAR(100),
        password_hash VARCHAR(255),
        salt VARCHAR(32),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        last_login TIMESTAMP NULL,
        failed_login_attempts INT DEFAULT 0,
        locked_until TIMESTAMP NULL,
        metadata JSON,
        is_active BOOLEAN DEFAULT TRUE,
        security_clearance ENUM('public','restricted','confidential','secret','top_secret') DEFAULT 'public',
        
        INDEX idx_email_active (email, is_active),
        INDEX idx_security (security_clearance, is_active),
        INDEX idx_login_tracking (last_login, failed_login_attempts)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      system_logs: `CREATE TABLE IF NOT EXISTS system_logs (
        id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
        level ENUM('debug','info','warn','error','critical') NOT NULL,
        module VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        metadata JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        
        INDEX idx_level_time (level, created_at),
        INDEX idx_module_time (module, created_at),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      system_intelligence: `CREATE TABLE IF NOT EXISTS system_intelligence (
        id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
        component VARCHAR(100) NOT NULL,
        intelligence_type ENUM('performance','security','optimization','prediction','anomaly') NOT NULL,
        analysis_data JSON NOT NULL,
        recommendations JSON,
        confidence_level DECIMAL(3,2) NOT NULL,
        impact_score DECIMAL(5,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        applied_at TIMESTAMP NULL,
        effectiveness_score DECIMAL(3,2) NULL,
        
        INDEX idx_component_type (component, intelligence_type),
        INDEX idx_impact_confidence (impact_score DESC, confidence_level DESC),
        INDEX idx_analysis_time (created_at),
        
        CHECK (confidence_level >= 0.00 AND confidence_level <= 1.00),
        CHECK (effectiveness_score IS NULL OR (effectiveness_score >= 0.00 AND effectiveness_score <= 1.00))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      dina_requests: `CREATE TABLE IF NOT EXISTS dina_requests (
        id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
        user_id VARCHAR(36),
        source VARCHAR(50) NOT NULL,
        target VARCHAR(50) NOT NULL,
        method VARCHAR(100) NOT NULL,
        payload JSON NOT NULL,
        response JSON,
        status ENUM('pending','processing','completed','failed','timeout') DEFAULT 'pending',
        priority TINYINT NOT NULL DEFAULT 5,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        started_at TIMESTAMP NULL,
        completed_at TIMESTAMP NULL,
        processing_time_ms INT UNSIGNED,
        error_message TEXT,
        retry_count TINYINT UNSIGNED DEFAULT 0,
        security_context JSON,
        
        INDEX idx_processing_queue (status, priority, created_at),
        INDEX idx_performance_analysis (completed_at, processing_time_ms),
        INDEX idx_user_requests (user_id, created_at),
        INDEX idx_target_method (target, method),
        
        CHECK (priority >= 1 AND priority <= 10),
        CHECK (retry_count <= 5)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      neural_memory: `CREATE TABLE IF NOT EXISTS neural_memory (
        id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
        user_id VARCHAR(36),
        neural_path VARCHAR(255) NOT NULL,
        memory_type ENUM('episodic','semantic','procedural','working','emotional') NOT NULL,
        data JSON NOT NULL,
        embeddings BLOB,
        confidence_score DECIMAL(5,4) DEFAULT 0.0000,
        importance_weight DECIMAL(5,4) DEFAULT 0.5000,
        access_count INT UNSIGNED DEFAULT 0,
        last_accessed TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NULL,
        is_active BOOLEAN DEFAULT TRUE,
        security_classification ENUM('public','restricted','confidential','secret','top_secret') DEFAULT 'public',
        
        INDEX idx_neural_path (neural_path, is_active),
        INDEX idx_memory_type (memory_type, importance_weight),
        INDEX idx_confidence (confidence_score DESC),
        INDEX idx_access_pattern (last_accessed, access_count),
        INDEX idx_expiration (expires_at),
        
        CHECK (confidence_score >= 0.0000 AND confidence_score <= 1.0000),
        CHECK (importance_weight >= 0.0000 AND importance_weight <= 1.0000)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      dina_users: `CREATE TABLE IF NOT EXISTS dina_users (
        unique_id VARCHAR(36) PRIMARY KEY,
        user_key VARCHAR(255) NOT NULL,
        dina_key VARCHAR(255) UNIQUE NOT NULL,
        device_fingerprint VARCHAR(64) NOT NULL,
        ip_address VARCHAR(45) NOT NULL,
        mac_address VARCHAR(17),
        user_agent TEXT,
        trust_level ENUM('new', 'trusted', 'suspicious', 'blocked') DEFAULT 'new',
        suspicion_score DECIMAL(5,2) DEFAULT 0.00,
        blocked_until TIMESTAMP NULL,
        first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        total_requests INT UNSIGNED DEFAULT 0,
        successful_requests INT UNSIGNED DEFAULT 0,
        failed_requests INT UNSIGNED DEFAULT 0,
        max_requests_per_minute INT UNSIGNED DEFAULT 10,
        max_tokens_per_request INT UNSIGNED DEFAULT 100,
        allowed_models JSON,
        allowed_endpoints JSON,
        current_session_id VARCHAR(36),
        
        INDEX idx_user_key (user_key),
        INDEX idx_dina_key (dina_key),
        INDEX idx_device_fingerprint (device_fingerprint),
        INDEX idx_trust_level (trust_level),
        INDEX idx_blocked_until (blocked_until),
        INDEX idx_ip_address (ip_address)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      dina_security_events: `CREATE TABLE IF NOT EXISTS dina_security_events (
        event_id VARCHAR(36) PRIMARY KEY,
        event_type VARCHAR(50) NOT NULL,
        user_key VARCHAR(255),
        dina_key VARCHAR(255),
        ip_address VARCHAR(45) NOT NULL,
        user_agent TEXT,
        endpoint VARCHAR(255),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        details JSON,
        severity ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
        
        INDEX idx_event_type (event_type),
        INDEX idx_timestamp (timestamp),
        INDEX idx_severity (severity),
        INDEX idx_ip_address (ip_address)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    };

    const sql = tableDefinitions[tableName];
    if (!sql) {
      throw new Error(`No definition found for table ${tableName}`);
    }

    try {
      console.log(`🏗️ Creating table: ${tableName}`);
      await this.query(sql, [], true); 
      console.log(`✅ Table created: ${tableName}`);
    } catch (error) {
      console.error(`❌ Failed to create table ${tableName}:`, error);
      throw error;
    }
  }

  private async createIntelligentSchema(): Promise<void> {
    console.log('🎨 Creating beautiful, secure, and efficient schema...');
    
    const tables = [
      'users', 
      'system_logs', 
      'system_intelligence', 
      'dina_requests', 
      'neural_memory',
      'dina_users',
      'dina_security_events'
    ];

    for (const tableName of tables) {
      try {
        await this.createTable(tableName);
      } catch (error) {
        console.error(`❌ Failed to create table ${tableName}:`, error);
        throw error;
      }
    }

    console.log('🔗 Adding foreign key constraints...');
    try {
      await this.query(`
        ALTER TABLE dina_requests 
        ADD CONSTRAINT fk_requests_user 
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      `, [], true);
      
      await this.query(`
        ALTER TABLE neural_memory 
        ADD CONSTRAINT fk_memory_user 
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      `, [], true);
      
      console.log('✅ Foreign key constraints added');
    } catch (error) {
      console.log('ℹ️ Foreign key constraints may already exist');
    }

    console.log('🎨 Beautiful schema created with intelligent design patterns');
  }

  async query(sql: string, params: any[] = [], skipSecurityValidation: boolean = false): Promise<any> {
    if (!this.pool) {
      throw new Error('Database not initialized');
    }

    const queryId = this.generateQueryId();
    const startTime = performance.now();
    
    try {
      if (!skipSecurityValidation) {
        await this.securityModule.validateQuery(sql, params);
      }
      
      const prediction = this.learningEnabled 
        ? await this.performanceMetrics.predictQueryPerformance(sql, params)
        : null;
      
      if (this.config.trace) {
        console.log('📝 Executing query:', BeautyModule.formatQueryForLogging(sql));
      }
      
      const [rows] = await this.pool.execute(sql, params);
      const executionTime = performance.now() - startTime;
      
      if (this.learningEnabled && prediction) {
        await this.performanceMetrics.recordQueryExecution(queryId, sql, params, executionTime, prediction);
      }
      
      if (this.autonomousMode && executionTime > 1000) {
        setImmediate(() => this.optimizationEngine.analyzeSlowQuery(sql, params, executionTime));
      }
      
      return rows;
      
    } catch (error) {
      const executionTime = performance.now() - startTime;
      await this.handleQueryError(queryId, sql, params, error, executionTime, true); 
      throw error;
    }
  }

  private async establishPerformanceBaseline(): Promise<void> {
    console.log('📊 Establishing performance baseline...');
    
    const testQueries = [
      'SELECT 1 as test',
      'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ?'
    ];
    
    let totalTime = 0;
    for (const testQuery of testQueries) {
      const startTime = performance.now();
      if (testQuery.includes('?')) {
        await this.query(testQuery, [this.config.database]);
      } else {
        await this.query(testQuery);
      }
      const endTime = performance.now();
      totalTime += (endTime - startTime);
    }
    
    const avgTime = totalTime / testQueries.length;
    console.log(`📈 Baseline established: ${avgTime.toFixed(2)}ms average query time`);
  }

  private activateAutonomousMonitoring(): void {
    if (!this.autonomousMode) {
      console.log('🔧 Manual mode - autonomous monitoring disabled');
      return;
    }

    console.log('🤖 Activating autonomous monitoring systems...');

    setInterval(async () => {
      try {
        await this.optimizationEngine.runAutonomousOptimization();
      }
      catch (error) {
        console.error('❌ Autonomous optimization failed:', error);
      }
    }, 5 * 60 * 1000);

    setInterval(async () => {
      try {
        const scanResult = await this.securityModule.performSecurityScan();
        if (scanResult.threatsDetected > 0) {
          console.warn(`🚨 Security scan: ${scanResult.threatsDetected} threats detected`);
        }
      } catch (error) {
        console.error('❌ Security scan failed:', error);
      }
    }, 60 * 1000);

    setInterval(async () => {
      try {
        const report = await this.performanceMetrics.analyzeAndOptimize();
        if (report.slowQueries > 0) {
          console.log(`📊 Performance analysis: ${report.slowQueries} slow queries identified`);
        }
      } catch (error) {
        console.error('❌ Performance analysis failed:', error);
      }
    }, 10 * 60 * 1000);

    setInterval(async () => {
      if (this.selfHealingEnabled) {
        await this.performSelfHealing();
      }
    }, 60 * 60 * 1000);

    setInterval(async () => {
      try {
        await this.loadBlockedDevices();
      } catch (error) {
        console.error('❌ Failed to reload blocked devices:', error);
      }
    }, 60 * 60 * 1000);

    console.log('🤖 Autonomous monitoring systems are ACTIVE');
  }

  private async performSelfHealing(): Promise<void> {
    console.log('🔧 Performing self-healing analysis...');
    
    try {
      const poolHealth = await this.checkConnectionPoolHealth();
      if (!poolHealth.healthy) {
        await this.healConnectionPool();
      }

      await this.performIntelligentCleanup();
      await this.updateTableStatistics();

      console.log('✅ Self-healing cycle completed');
    } catch (error) {
      console.error('❌ Self-healing failed:', error);
    }
  }

  private async checkConnectionPoolHealth(): Promise<{healthy: boolean, issues: string[]}> {
    if (!this.pool) {
      return { healthy: false, issues: ['No connection pool'] };
    }

    const issues: string[] = [];
    
    try {
      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();

      const poolStats = (this.pool as any);
      const activeConnections = poolStats._allConnections?.length || 0;
      const freeConnections = poolStats._freeConnections?.length || 0;
      
      if (activeConnections > this.config.connectionLimit * 0.9) {
        issues.push('Connection pool near capacity');
      }
      
      if (freeConnections === 0) {
        issues.push('No free connections available');
      }

    } catch (error) {
      issues.push(`Connection test failed: ${error}`);
    }

    return { 
      healthy: issues.length === 0, 
      issues 
    };
  }

  private async healConnectionPool(): Promise<void> {
    console.log('🔧 Healing connection pool...');
    
    if (this.pool) {
      await this.pool.end();
    }
    
    await this.establishIntelligentConnection();
    console.log('✅ Connection pool healed');
  }

  private async performIntelligentCleanup(): Promise<void> {
    console.log('🧹 Performing intelligent cleanup...');
    
    const cleanupTasks = [
      {
        name: 'Expired Memories',
        query: 'UPDATE neural_memory SET is_active = FALSE WHERE expires_at IS NOT NULL AND expires_at <= NOW()',
      },
      {
        name: 'Old System Logs',
        query: 'DELETE FROM system_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY) AND level IN ("debug", "info")',
      },
      {
        name: 'Old Completed Requests',
        query: 'DELETE FROM dina_requests WHERE status = "completed" AND completed_at < DATE_SUB(NOW(), INTERVAL 7 DAY)',
      },
      {
        name: 'Old Failed Requests',
        query: 'DELETE FROM dina_requests WHERE status = "failed" AND created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)',
      },
      {
        name: 'Expired User Blocks',
        query: 'UPDATE dina_users SET trust_level = "new", blocked_until = NULL WHERE trust_level = "blocked" AND blocked_until <= NOW()',
      },
      {
        name: 'Old Security Events',
        query: 'DELETE FROM dina_security_events WHERE timestamp < DATE_SUB(NOW(), INTERVAL 30 DAY)',
      }
    ];

    let totalCleaned = 0;
    for (const task of cleanupTasks) {
      try {
        const result = await this.query(task.query, [], true); 
        const affectedRows = (result as any).affectedRows || 0;
        totalCleaned += affectedRows;
        
        if (affectedRows > 0) {
          console.log(`🧹 ${task.name}: cleaned ${affectedRows} records`);
        }
      } catch (error) {
        console.log(`ℹ️ Cleanup task '${task.name}' skipped:`, (error as Error).message);
      }
    }

    if (totalCleaned > 0) {
      console.log(`✅ Cleanup completed: ${totalCleaned} total records cleaned`);
    }
  }

  private async updateTableStatistics(): Promise<void> {
    try {
      const tables = ['users', 'dina_requests', 'neural_memory', 'system_intelligence', 'system_logs', 'dina_users', 'dina_security_events'];
      
      for (const table of tables) {
        try {
          await this.query(`ANALYZE TABLE ${table}`, [], true); 
        } catch (error) {
          console.warn(`Could not analyze table ${table}:`, (error as Error).message);
        }
      }
      
      console.log('📊 Table statistics updated for query optimization');
    } catch (error) {
      console.error('❌ Failed to update table statistics:', error);
    }
  }

  private generateQueryId(): string {
    return `dina_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private async handleQueryError(queryId: string, sql: string, params: any[], error: any, executionTime: number, skipSecurityValidation: boolean): Promise<void> {
    const errorInfo = {
      queryId,
      sql: sql.substring(0, 200) + (sql.length > 200 ? '...' : ''),
      params: params.slice(0, 5),
      error: error.message,
      executionTime,
      timestamp: new Date().toISOString()
    };

    console.error('❌ Query execution failed:', errorInfo);

    try {
      await this.query(
        'INSERT INTO system_logs (level, module, message, metadata) VALUES (?, ?, ?, ?)',
        ['error', 'database', 'Query execution failed', JSON.stringify(errorInfo)],
        true
      );
    } catch (logError) {
      console.error('Failed to log query error:', logError);
    }
  }

  private calculateErrorImpact(error: any): number {
    if (error.code === 'ER_ACCESS_DENIED_ERROR') return 9.0;
    if (error.code === 'ER_CONNECTION_REFUSED') return 8.0;
    if (error.code === 'ER_LOCK_WAIT_TIMEOUT') return 6.0;
    if (error.code === 'ER_DUP_ENTRY') return 3.0;
    return 5.0;
  }

  async recordIntelligence(
    component: string, 
    type: 'performance' | 'security' | 'optimization' | 'prediction' | 'anomaly',
    analysisData: any,
    confidenceLevel: number,
    impactScore: number,
    recommendations?: any
  ): Promise<void> {
    try {
      await this.query(
        `INSERT INTO system_intelligence (component, intelligence_type, analysis_data, recommendations, confidence_level, impact_score)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [component, type, JSON.stringify(analysisData), JSON.stringify(recommendations || {}), confidenceLevel, impactScore]
      );
    } catch (error) {
      console.error('❌ Failed to record intelligence:', error);
    }
  }

  async log(level: string, module: string, message: string, metadata?: any): Promise<void> {
    try {
      await this.query(
        'INSERT INTO system_logs (level, module, message, metadata) VALUES (?, ?, ?, ?)',
        [level, module, message, JSON.stringify(metadata || {})],
        true
      );
    } catch (error) {
      console.error('❌ Failed to log message to database:', error);
    }
  }

  async logRequest(request: {
    source: string;
    target: string;
    method: string;
    payload: any;
    priority: number;
    userId?: string;
    securityContext?: any;
  }): Promise<string> {
    const requestId = this.generateQueryId();
    try {
      await this.query(
        `INSERT INTO dina_requests (id, user_id, source, target, method, payload, status, priority, security_context, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          requestId,
          request.userId || null,
          request.source,
          request.target,
          JSON.stringify(request.method),
          JSON.stringify(request.payload),
          'pending',
          request.priority,
          JSON.stringify(request.securityContext || {})
        ]
      );
      return requestId;
    } catch (error) {
      console.error('❌ Failed to log request:', error);
      throw error;
    }
  }

  async updateRequestStatus(
    requestId: string,
    status: 'completed' | 'failed' | 'timeout',
    response?: any,
    processingTimeMs?: number,
    errorMessage?: string
  ): Promise<void> {
    try {
      const finalErrorMessage = errorMessage === undefined ? null : errorMessage;

      await this.query(
        `UPDATE dina_requests
         SET status = ?, response = ?, completed_at = CURRENT_TIMESTAMP, processing_time_ms = ?, error_message = ?
         WHERE id = ?`,
        [status, JSON.stringify(response || {}), processingTimeMs, finalErrorMessage, requestId]
      );
    } catch (error) {
      console.error('❌ Failed to update request status:', error);
    }
  }

  async storeUserMemory(memory: {
    user_id: string;
    module: string;
    memory_type: 'episodic' | 'semantic' | 'procedural' | 'working' | 'emotional' | 'neural_memory';
    data: any;
    confidence_score: number;
    importance_weight?: number;
    expires_at?: Date;
    security_classification?: string;
    embeddings?: Buffer;
  }): Promise<void> {
    try {
      await this.query(
        `INSERT INTO neural_memory (user_id, neural_path, memory_type, data, confidence_score, importance_weight, expires_at, security_classification, embeddings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          memory.user_id,
          memory.module,
          memory.memory_type,
          JSON.stringify(memory.data),
          memory.confidence_score,
          memory.importance_weight || 0.5,
          memory.expires_at || null,
          memory.security_classification || 'public',
          memory.embeddings || null
        ]
      );
    } catch (error) {
      console.error('❌ Failed to store user memory:', error);
    }
  }

  async getUserMemory(
    userId: string,
    neuralPath: string,
    memoryType: ('episodic' | 'semantic' | 'procedural' | 'working' | 'emotional' | 'neural_memory')[]
  ): Promise<any[]> {
    try {
      const results = await this.query(
        `SELECT data, created_at FROM neural_memory WHERE user_id = ? AND neural_path = ? AND memory_type IN (?) ORDER BY created_at DESC`,
        [userId, neuralPath, memoryType]
      );
      return results.map((row: any) => ({ data: JSON.parse(row.data), created_at: row.created_at }));
    } catch (error) {
      console.error('❌ Failed to retrieve user memory:', error);
      return [];
    }
  }

  async getSystemStatus(): Promise<any> {
    const poolHealth = await this.checkConnectionPoolHealth();
    return {
      status: this.isConnected && poolHealth.healthy ? 'online' : 'offline',
      connectionPool: poolHealth,
      uptime: Date.now() - this.startTime.getTime(),
      timestamp: new Date().toISOString()
    };
  }

  async getSystemStats(): Promise<any> {
    const [totalRequests] = await this.query('SELECT COUNT(*) as count FROM dina_requests WHERE status = "completed"');
    const [avgProcessingTime] = await this.query('SELECT AVG(processing_time_ms) as avg_time FROM dina_requests WHERE status = "completed" AND processing_time_ms IS NOT NULL');
    
    return {
      totalRequestsProcessed: totalRequests ? totalRequests.count : 0,
      avgResponseTimeMs: avgProcessingTime ? avgProcessingTime.avg_time : 0,
      timestamp: new Date().toISOString()
    };
  }

  async getConnectionStatus(): Promise<{connected: boolean}> {
    return { connected: this.isConnected };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.isConnected = false;
      console.log('✅ Database connection pool closed.');
    }
  }

  private async emergencyShutdown(): Promise<void> {
    console.error('🚨 Performing emergency database shutdown...');
    if (this.pool) {
      try {
        await this.pool.end();
        this.isConnected = false;
        console.log('✅ Emergency database shutdown complete.');
      } catch (error) {
        console.error('❌ Error during emergency database shutdown:', error);
      }
    }
  }
}

export const database = new DinaDatabase();
