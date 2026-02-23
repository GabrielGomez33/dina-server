// ============================================================================
// MIRROR STREAMING CHAT PROCESSOR - @Dina with Real-Time Streaming
// ============================================================================
// File: src/modules/mirror/processors/streamingChatProcessor.ts
//
// Purpose: Processes chat queries with streaming support for real-time feedback.
// Implements the hybrid approach:
//   - Quick responses (< delay threshold) are returned whole
//   - Longer responses are streamed in chunks
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

export interface StreamingChatRequest {
  requestId: string;
  groupId: string;
  userId: string;
  username: string;
  query: string;
  context: ChatContext;
  streaming?: boolean;
}

export interface ChatContext {
  groupInfo?: {
    name: string;
    description?: string;
    goal?: string;
  };
  members?: Array<{ username: string; role?: string }>;
  recentMessages?: Array<{ username: string; content: string; createdAt?: string }>;
  originalContext?: any;
}

export interface StreamingConfig {
  enabled: boolean;
  decisionDelayMs: number;
  chunkSize: number;
  minStreamLength: number;
}

type StreamCallback = (chunk: string, isDone: boolean, metadata?: any) => void;

// ============================================================================
// CONTEXT NORMALIZATION
// ============================================================================
//
// Identical to the normalizer in chatProcessor.ts. Handles both flat format
// from mirror-server and nested format from DinaChatContext utility.
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
// STREAMING CHAT PROCESSOR CLASS
// ============================================================================

export class MirrorStreamingChatProcessor extends EventEmitter {
  private llmManager: DinaLLMManager;
  private initialized: boolean = false;
  private streamingConfig: StreamingConfig;

  private readonly PROCESSOR_VERSION = '2.0.0';
  private readonly DEFAULT_TEMPERATURE = 0.7;
  private readonly MAX_RESPONSE_TOKENS = 500;

  private readonly SYSTEM_PROMPT = `You are Dina, an intelligent AI assistant in a group chat app called Mirror.
Keep responses concise (2-4 sentences for simple questions). Be friendly and helpful.
Respond naturally as if you're part of the conversation.`;

  constructor(llmManager: DinaLLMManager, config?: Partial<StreamingConfig>) {
    super();
    this.llmManager = llmManager;

    this.streamingConfig = {
      enabled: true,
      decisionDelayMs: 250, // Wait 250ms before deciding to stream
      chunkSize: 15, // Characters per chunk for simulated streaming
      minStreamLength: 100, // Minimum response length to consider streaming
      ...config,
    };

    console.log('🌊 MirrorStreamingChatProcessor initialized');
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.llmManager.isInitialized) {
      await this.llmManager.initialize();
    }

    this.initialized = true;
    console.log('✅ MirrorStreamingChatProcessor initialized');
    this.emit('initialized');
  }

  // ============================================================================
  // DUMP MESSAGE HANDLING WITH STREAMING
  // ============================================================================

  /**
   * Process a DUMP message with optional streaming
   */
  async processDumpMessage(
    message: DinaUniversalMessage,
    onStream?: StreamCallback
  ): Promise<DinaResponse> {
    const startTime = performance.now();
    const requestId = message.id || uuidv4();

    console.log(`🌊 Processing streaming chat message: ${requestId}`);

    try {
      const payload = message.payload.data || message.payload;
      const {
        query,
        groupId,
        userId,
        username,
        context,
        streaming = true,
      } = payload;

      if (!query || typeof query !== 'string') {
        throw new Error('Query is required');
      }

      // FIX: Normalize context before processing to handle both flat and nested formats
      const normalizedCtx = normalizeContext(context || {});

      // Process with streaming support
      const result = await this.processWithStreaming({
        requestId,
        groupId: groupId || 'unknown',
        userId: userId || message.security?.user_id || 'anonymous',
        username: username || 'User',
        query,
        context: normalizedCtx,
        streaming: streaming && this.streamingConfig.enabled,
      }, onStream);

      const processingTime = performance.now() - startTime;

      return createDinaResponse({
        request_id: requestId,
        status: 'success',
        payload: {
          response: result.response,
          streamed: result.streamed,
          metadata: {
            processingTimeMs: processingTime,
            chunks: result.chunks,
            modelUsed: result.model,
          },
        },
        metrics: { processing_time_ms: processingTime },
      });

    } catch (error) {
      console.error(`❌ Streaming chat error ${requestId}:`, error);

      return createDinaResponse({
        request_id: requestId,
        status: 'error',
        payload: {
          response: 'I encountered an issue. Please try again.',
          error: (error as Error).message,
        },
        metrics: {
          processing_time_ms: performance.now() - startTime,
        },
        error: {
          code: 'STREAMING_CHAT_ERROR',
          message: (error as Error).message,
        },
      });
    }
  }

  // ============================================================================
  // STREAMING PROCESSING
  // ============================================================================

  /**
   * Process query with delayed streaming decision
   * Uses generate() and simulates streaming by chunking the response
   */
  private async processWithStreaming(
    request: StreamingChatRequest,
    onStream?: StreamCallback
  ): Promise<{
    response: string;
    streamed: boolean;
    chunks: number;
    model: string;
  }> {
    const prompt = this.buildPrompt(request);

    // If streaming is disabled or no callback, just get full response
    if (!request.streaming || !onStream) {
      const response = await this.getFullResponse(prompt, request);
      return {
        response,
        streamed: false,
        chunks: 1,
        model: 'default',
      };
    }

    return new Promise(async (resolve, reject) => {
      try {
        // Get full response first
        const llmResponse = await this.llmManager.generate(prompt, {
          maxTokens: this.MAX_RESPONSE_TOKENS,
          temperature: this.DEFAULT_TEMPERATURE,
          user_id: request.userId,
          conversation_id: `chat_${request.groupId}`,
        });

        const fullResponse = llmResponse.response || '';
        const modelUsed = llmResponse.model || 'default';

        // Decide whether to stream based on response length
        const shouldStream = fullResponse.length >= this.streamingConfig.minStreamLength;

        if (!shouldStream) {
          // Quick response - emit as single chunk
          onStream(fullResponse, true, {
            chunkIndex: 0,
            totalChunks: 1,
            complete: true,
          });

          resolve({
            response: fullResponse,
            streamed: false,
            chunks: 1,
            model: modelUsed,
          });
          return;
        }

        // Stream the response in chunks
        console.log(`🌊 Streaming response for ${request.requestId}`);
        let chunkCount = 0;
        const chunkSize = this.streamingConfig.chunkSize;

        for (let i = 0; i < fullResponse.length; i += chunkSize) {
          const chunk = fullResponse.slice(i, i + chunkSize);
          const isDone = i + chunkSize >= fullResponse.length;

          onStream(chunk, isDone, {
            chunkIndex: chunkCount,
            totalChunks: Math.ceil(fullResponse.length / chunkSize),
            complete: isDone,
          });

          chunkCount++;

          // Small delay between chunks for realistic streaming feel
          if (!isDone) {
            await new Promise(r => setTimeout(r, 20));
          }
        }

        resolve({
          response: fullResponse,
          streamed: true,
          chunks: chunkCount,
          model: modelUsed,
        });

      } catch (error) {
        onStream('', true, { error: (error as Error).message });
        reject(error);
      }
    });
  }

  /**
   * Get full response without streaming
   */
  private async getFullResponse(
    prompt: string,
    request: StreamingChatRequest
  ): Promise<string> {
    const llmResponse = await this.llmManager.generate(prompt, {
      maxTokens: this.MAX_RESPONSE_TOKENS,
      temperature: this.DEFAULT_TEMPERATURE,
      user_id: request.userId,
    });

    return llmResponse.response || this.extractTextFromResponse(llmResponse);
  }

  // ============================================================================
  // SSE ENDPOINT HANDLER (for HTTP streaming)
  // ============================================================================

  /**
   * Handle SSE streaming request
   * This method is designed to work with Express response objects
   */
  async handleSSERequest(
    request: StreamingChatRequest,
    res: any // Express Response with SSE
  ): Promise<void> {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendSSE = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await this.processWithStreaming(
        request,
        (chunk, isDone, metadata) => {
          if (isDone) {
            sendSSE({ type: 'done', metadata });
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            sendSSE({
              type: 'chunk',
              content: chunk,
              ...metadata,
            });
          }
        }
      );
    } catch (error) {
      sendSSE({
        type: 'error',
        error: (error as Error).message,
      });
      res.end();
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
  private buildPrompt(request: StreamingChatRequest): string {
    const { query, username, context } = request;

    let contextSection = '';

    if (context.groupInfo) {
      contextSection += `\nGroup: ${context.groupInfo.name || 'Unknown'}`;
      if (context.groupInfo.goal) {
        contextSection += ` | Purpose: ${context.groupInfo.goal}`;
      }
    }

    if (context.members?.length) {
      contextSection += `\nMembers: ${context.members.slice(0, 8).map(m => m.username).join(', ')}`;
    }

    let conversationContext = '';
    if (context.recentMessages?.length) {
      conversationContext = '\n\nRecent messages:\n';
      conversationContext += context.recentMessages
        .slice(-8)
        .map(m => `${m.username}: ${m.content.slice(0, 100)}`)
        .join('\n');
    }

    return `${this.SYSTEM_PROMPT}
${contextSection}
${conversationContext}

${username} asks: ${query}

Dina:`;
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private extractTextFromResponse(response: any): string {
    if (typeof response === 'string') return response.trim();
    if (response?.content) return response.content.trim();
    if (response?.text) return response.text.trim();
    if (response?.choices?.[0]?.message?.content) {
      return response.choices[0].message.content.trim();
    }
    return String(response).trim();
  }

  // ============================================================================
  // HEALTH CHECK
  // ============================================================================

  async healthCheck(): Promise<{ status: string; details: any }> {
    return {
      status: this.initialized ? 'healthy' : 'initializing',
      details: {
        streaming: this.streamingConfig.enabled,
        version: this.PROCESSOR_VERSION,
      },
    };
  }

  async shutdown(): Promise<void> {
    console.log('🛑 Shutting down MirrorStreamingChatProcessor');
    this.initialized = false;
  }
}

export default MirrorStreamingChatProcessor;
