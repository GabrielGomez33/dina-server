// ============================================================================
// MIRROR CHAT PROCESSOR - @Dina Chat Message Handler for DINA
// ============================================================================
// File: src/modules/mirror/processors/chatProcessor.ts
//
// Purpose: Processes chat queries from Mirror Groups that mention @Dina.
// This processor handles natural language questions and provides intelligent
// responses based on group context and conversation history.
//
// Integrates with the DINA Universal Messaging Protocol (DUMP)
// ============================================================================

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { v4 as uuidv4 } from 'uuid';

// Core imports
import { DinaLLMManager } from '../../llm/manager';

// Type imports
import {
  DinaUniversalMessage,
  DinaResponse,
  createDinaResponse,
} from '../../../core/protocol';

// ============================================================================
// TYPES
// ============================================================================

export interface ChatQueryRequest {
  requestId: string;
  groupId: string;
  userId: string;
  username: string;
  query: string;
  context: ChatContext;
}

export interface ChatContext {
  groupInfo?: {
    name: string;
    description?: string;
    goal?: string;
  };
  members?: Array<{
    username: string;
    role?: string;
  }>;
  recentMessages?: Array<{
    username: string;
    content: string;
    createdAt?: string;
  }>;
  originalContext?: any;
}

export interface ChatResponse {
  success: boolean;
  response: string;
  metadata: {
    processingTimeMs: number;
    modelUsed: string;
    confidence: number;
    tokensUsed?: number;
  };
}

// ============================================================================
// CONTEXT NORMALIZATION
// ============================================================================
//
// The mirror-server sends context in TWO possible formats depending on the
// communication path (WebSocket vs HTTP). This normalizer handles both.
//
// Flat format (from mirror-server transformation):
//   { groupName, groupGoal, members: string[], recentMessages, requestingUser }
//
// Nested format (from DinaChatContext utility):
//   { groupInfo: { name, goal }, members: [{ username }], recentMessages }
// ============================================================================

function normalizeContext(raw: any): ChatContext {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const result: ChatContext = {};

  // ---- Group Info ----
  if (raw.groupInfo && typeof raw.groupInfo === 'object') {
    result.groupInfo = {
      name: raw.groupInfo.name || 'Unknown Group',
      description: raw.groupInfo.description,
      goal: raw.groupInfo.goal,
    };
  } else if (raw.groupName || raw.groupGoal) {
    // Flat format from mirror-server
    result.groupInfo = {
      name: raw.groupName || 'Unknown Group',
      goal: raw.groupGoal,
    };
  }

  // ---- Members ----
  if (Array.isArray(raw.members) && raw.members.length > 0) {
    result.members = raw.members
      .filter((m: any) => m != null)
      .map((m: any) => {
        if (typeof m === 'string') return { username: m };
        if (typeof m === 'object' && m.username) return { username: m.username, role: m.role };
        return null;
      })
      .filter(Boolean) as Array<{ username: string; role?: string }>;
  }

  // ---- Recent Messages ----
  if (Array.isArray(raw.recentMessages) && raw.recentMessages.length > 0) {
    result.recentMessages = raw.recentMessages
      .filter((m: any) => m && m.username && m.content)
      .map((m: any) => ({
        username: m.username,
        content: m.content,
        createdAt: m.createdAt || m.created_at || m.timestamp,
      }));
  }

  // ---- Original Context ----
  if (raw.originalContext) {
    result.originalContext = raw.originalContext;
  }

  return result;
}

// ============================================================================
// MIRROR CHAT PROCESSOR CLASS
// ============================================================================

export class MirrorChatProcessor extends EventEmitter {
  private llmManager: DinaLLMManager;
  private initialized: boolean = false;

  // Configuration
  private readonly PROCESSOR_VERSION = '1.0.0';
  private readonly MAX_CONTEXT_MESSAGES = 20;
  private readonly MAX_RESPONSE_TOKENS = 500;
  private readonly DEFAULT_TEMPERATURE = 0.7;

  // System prompts
  private readonly SYSTEM_PROMPT = `You are Dina, an intelligent AI assistant integrated into a group chat application called Mirror.

Your role is to:
- Answer questions from group members clearly and helpfully
- Provide insights about group dynamics when asked
- Facilitate productive discussions
- Offer thoughtful perspectives on topics being discussed
- Maintain a friendly, supportive, and inclusive tone

Guidelines:
- Keep responses concise and focused (2-4 sentences for simple questions)
- Be warm and personable while remaining professional
- Address the user by name when appropriate
- If you don't know something, say so honestly
- Avoid controversial topics and respect all viewpoints
- Never share private information about group members
- If asked about group insights, suggest using the Insights tab for detailed analysis`;

  constructor(llmManager: DinaLLMManager) {
    super();
    console.log('💬 Initializing Mirror Chat Processor...');
    this.llmManager = llmManager;
    this.setupEventHandlers();
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('✅ Mirror Chat Processor already initialized');
      return;
    }

    try {
      console.log('🔧 Initializing chat processing systems...');

      // Verify LLM manager is ready
      if (!this.llmManager.isInitialized) {
        await this.llmManager.initialize();
      }

      this.initialized = true;
      console.log('✅ Mirror Chat Processor initialized successfully');

      this.emit('initialized');
    } catch (error) {
      console.error('❌ Failed to initialize Mirror Chat Processor:', error);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    this.on('queryProcessed', (data) => {
      console.log(`💬 Chat query processed for user ${data.username} in ${data.processingTimeMs}ms`);
    });

    this.on('queryFailed', (data) => {
      console.error(`❌ Chat query failed for user ${data.username}: ${data.error}`);
    });
  }

  // ============================================================================
  // DUMP MESSAGE HANDLING
  // ============================================================================

  /**
   * Process a DUMP message for chat queries
   */
  async processDumpMessage(message: DinaUniversalMessage): Promise<DinaResponse> {
    const startTime = performance.now();
    const requestId = message.id || uuidv4();

    console.log(`💬 Processing DUMP chat message: ${requestId}`);

    try {
      // Extract payload data
      const payload = message.payload.data || message.payload;
      const {
        query,
        groupId,
        userId,
        username,
        context,
      } = payload;

      if (!query || typeof query !== 'string') {
        throw new Error('Query is required for chat processing');
      }

      // FIX: Normalize context before processing to handle both flat and nested formats
      const normalizedCtx = normalizeContext(context || {});

      // Process the chat query
      const result = await this.processQuery({
        requestId,
        groupId: groupId || 'unknown',
        userId: userId || message.security?.user_id || 'anonymous',
        username: username || 'User',
        query,
        context: normalizedCtx,
      });

      const processingTime = performance.now() - startTime;

      return createDinaResponse({
        request_id: requestId,
        status: 'success',
        payload: {
          response: result.response,
          metadata: {
            ...result.metadata,
            processingTimeMs: processingTime,
          },
        },
        metrics: {
          processing_time_ms: processingTime,
        },
      });

    } catch (error) {
      const processingTime = performance.now() - startTime;
      console.error(`❌ Error processing chat message ${requestId}:`, error);

      return createDinaResponse({
        request_id: requestId,
        status: 'error',
        payload: {
          response: 'I apologize, but I encountered an issue processing your request. Please try again.',
          error: (error as Error).message,
        },
        metrics: {
          processing_time_ms: processingTime,
        },
        error: {
          code: 'CHAT_PROCESSING_ERROR',
          message: (error as Error).message,
          details: { requestId },
        },
      });
    }
  }

  // ============================================================================
  // QUERY PROCESSING
  // ============================================================================

  /**
   * Process a chat query and generate a response
   */
  async processQuery(request: ChatQueryRequest): Promise<ChatResponse> {
    const startTime = performance.now();

    console.log(`🔄 Processing chat query from ${request.username}: "${request.query.substring(0, 50)}..."`);

    try {
      // Build the conversation prompt
      const prompt = this.buildPrompt(request);

      // Generate response using LLM
      const llmResponse = await this.llmManager.generate(prompt, {
        maxTokens: this.MAX_RESPONSE_TOKENS,
        temperature: this.DEFAULT_TEMPERATURE,
        user_id: request.userId,
        conversation_id: `chat_${request.groupId}`,
      });

      const responseText = this.extractTextFromLLMResponse(llmResponse);
      const processingTimeMs = performance.now() - startTime;

      // Emit success event
      this.emit('queryProcessed', {
        requestId: request.requestId,
        username: request.username,
        groupId: request.groupId,
        processingTimeMs,
      });

      return {
        success: true,
        response: responseText,
        metadata: {
          processingTimeMs,
          modelUsed: llmResponse.model || 'default',
          confidence: llmResponse.confidence || 0.85,
          tokensUsed: llmResponse.tokens?.total,
        },
      };

    } catch (error) {
      const processingTimeMs = performance.now() - startTime;

      // Emit failure event
      this.emit('queryFailed', {
        requestId: request.requestId,
        username: request.username,
        groupId: request.groupId,
        error: (error as Error).message,
        processingTimeMs,
      });

      throw error;
    }
  }

  // ============================================================================
  // PROMPT BUILDING
  // ============================================================================

  /**
   * Build the full prompt for the LLM.
   *
   * FIX: Context is now guaranteed to be in normalized (nested) format
   *      thanks to normalizeContext() in processDumpMessage(). The
   *      context.groupInfo fields will always be populated correctly.
   */
  private buildPrompt(request: ChatQueryRequest): string {
    const { query, username, context } = request;

    // Build context section
    let contextSection = '';

    if (context.groupInfo) {
      contextSection += `\nGroup Context:`;
      contextSection += `\n- Group Name: ${context.groupInfo.name}`;
      if (context.groupInfo.goal) {
        contextSection += `\n- Group Purpose: ${context.groupInfo.goal}`;
      }
    }

    if (context.members && context.members.length > 0) {
      const memberList = context.members.map(m => m.username).slice(0, 10).join(', ');
      contextSection += `\n- Active Members: ${memberList}`;
    }

    // Add recent conversation context (limited)
    let conversationContext = '';
    if (context.recentMessages && context.recentMessages.length > 0) {
      const recentMessages = context.recentMessages.slice(0, this.MAX_CONTEXT_MESSAGES);
      conversationContext = '\n\nRecent Conversation:\n';
      conversationContext += recentMessages
        .map(m => `${m.username}: ${m.content.substring(0, 200)}`)
        .join('\n');
    }

    // Build the full prompt
    const fullPrompt = `${this.SYSTEM_PROMPT}
${contextSection}
${conversationContext}

${username} asks: ${query}

Respond as Dina:`;

    return fullPrompt;
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private extractTextFromLLMResponse(response: any): string {
    try {
      if (typeof response === 'string') {
        return response.trim();
      }

      if (response?.content) {
        return response.content.trim();
      }

      if (response?.text) {
        return response.text.trim();
      }

      if (response?.choices?.[0]?.text) {
        return response.choices[0].text.trim();
      }

      if (response?.choices?.[0]?.message?.content) {
        return response.choices[0].message.content.trim();
      }

      // Fallback
      console.warn('⚠️ Unknown LLM response structure, using toString()');
      return String(response).trim();

    } catch (error) {
      console.error('❌ Error extracting text from LLM response:', error);
      return 'I apologize, but I had trouble formulating a response. Please try asking in a different way.';
    }
  }

  // ============================================================================
  // HEALTH & METRICS
  // ============================================================================

  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'critical';
    details: Record<string, any>;
  }> {
    try {
      const llmHealth = await this.llmManager.getSystemStatus();

      // Test with a simple query
      const testResult = await this.testChatProcessing();

      return {
        status: llmHealth.status === 'healthy' && testResult ? 'healthy' : 'degraded',
        details: {
          llmManager: llmHealth.status,
          chatProcessing: testResult ? 'healthy' : 'degraded',
          initialized: this.initialized,
          version: this.PROCESSOR_VERSION,
        },
      };
    } catch (error) {
      return {
        status: 'critical',
        details: {
          error: error instanceof Error ? error.message : 'Unknown error',
          initialized: this.initialized,
        },
      };
    }
  }

  private async testChatProcessing(): Promise<boolean> {
    try {
      const testPrompt = "Say hello briefly.";

      const response = await this.llmManager.generate(testPrompt, {
        maxTokens: 50,
        temperature: 0.7,
      });

      const text = this.extractTextFromLLMResponse(response);
      return Boolean(text && text.length > 0);
    } catch (error) {
      console.error('❌ Test chat processing failed:', error);
      return false;
    }
  }

  getPerformanceMetrics(): {
    queriesProcessed: number;
    averageProcessingTime: number;
    successRate: number;
  } {
    // Would be populated from actual metrics tracking
    return {
      queriesProcessed: 0,
      averageProcessingTime: 0,
      successRate: 0,
    };
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down Mirror Chat Processor...');

    try {
      this.initialized = false;
      console.log('✅ Mirror Chat Processor shutdown complete');
    } catch (error) {
      console.error('❌ Error during Chat Processor shutdown:', error);
      throw error;
    }
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export default MirrorChatProcessor;
