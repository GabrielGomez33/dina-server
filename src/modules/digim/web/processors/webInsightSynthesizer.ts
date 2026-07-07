// File: src/modules/digim/web/processors/webInsightSynthesizer.ts
// ============================================================================
// DIGIM WEB-RESEARCH — INSIGHT SYNTHESIZER
// ============================================================================
//
// The "generate insights from information gathered" stage. Takes the documents
// produced by the gathering pipeline and drives the LLM to synthesise a
// structured WebInsight (summary, key insights, entities, topics, trends,
// confidence, source attribution, caveats).
//
// Follows the mature mirror synthesizer pattern EXACTLY:
//   * Constructor-injected llmManager (per-module isolation via its own instance).
//   * Local Logger shim.
//   * callLLM() wrapped in Promise.race against a hard timeout; passes BOTH
//     maxTokens and max_tokens plus model_preference.
//   * parseJsonResponse<T>() strips code fences and clamps to the JSON object.
//   * normalizeInsight() defensively coerces every field — never trusts the
//     model's JSON shape.
//
// The synthesizer is grounded: the prompt forbids fabrication and requires the
// model to attribute claims to the numbered sources it is given. If no
// documents were gathered it returns an honest empty-insight rather than
// hallucinating.
// ============================================================================

import { getDigimWebConfig, DigimWebConfig } from '../config/webConfig';
import { GatheredDocument, WebInsight } from '../types';

class Logger {
  constructor(private ctx: string) {}
  info(msg: string, meta?: any) { console.log(`✅ [${this.ctx}] ${msg}`, meta ?? ''); }
  warn(msg: string, meta?: any) { console.warn(`⚠️ [${this.ctx}] ${msg}`, meta ?? ''); }
  error(msg: string, meta?: any) { console.error(`❌ [${this.ctx}] ${msg}`, meta ?? ''); }
}

export class WebInsightSynthesizer {
  private logger = new Logger('WebInsightSynthesizer');
  private llmManager: any;
  private initialized = false;

  constructor(llmManager: any, private cfg: DigimWebConfig = getDigimWebConfig()) {
    this.llmManager = llmManager;
  }

  async initialize(): Promise<void> {
    // The shared llmManager is initialized by the DIGIM module; guard anyway.
    if (this.llmManager && typeof this.llmManager.isInitialized !== 'undefined' && !this.llmManager.isInitialized) {
      try {
        await this.llmManager.initialize();
      } catch (err) {
        this.logger.warn(`llmManager init failed (synthesis will degrade): ${(err as Error).message}`);
      }
    }
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  /**
   * Synthesize an insight from gathered documents. `level` tunes depth.
   * Always resolves; on LLM failure it returns a graceful degraded insight
   * built from the documents' own metadata.
   */
  async synthesize(
    query: string,
    documents: GatheredDocument[],
    level: 'surface' | 'deep' | 'predictive' = 'surface'
  ): Promise<WebInsight> {
    if (documents.length === 0) {
      return this.emptyInsight('No documents were gathered for this query.');
    }

    const used = documents.slice(0, this.cfg.synthesisMaxDocuments);
    const prompt = this.buildPrompt(query, used, level);

    let raw: string;
    try {
      raw = await this.callLLM(prompt);
    } catch (err) {
      this.logger.error(`LLM synthesis failed, returning degraded insight: ${(err as Error).message}`);
      return this.degradedInsight(query, used);
    }

    try {
      const parsed = this.parseJsonResponse<Partial<WebInsight>>(raw);
      return this.normalizeInsight(parsed, used);
    } catch (err) {
      this.logger.error(`Failed to parse synthesis JSON, returning degraded insight: ${(err as Error).message}`);
      return this.degradedInsight(query, used);
    }
  }

  // --------------------------------------------------------------------------
  // PROMPTING
  // --------------------------------------------------------------------------

  private buildPrompt(query: string, docs: GatheredDocument[], level: string): string {
    const perDoc = this.cfg.synthesisPerDocChars;
    const sourceBlocks = docs
      .map((d, i) => {
        const meta = [
          d.publishedAt ? `published: ${d.publishedAt}` : null,
          d.author ? `author: ${d.author}` : null,
        ]
          .filter(Boolean)
          .join(', ');
        return `[Source ${i + 1}] ${d.title}\nURL: ${d.url}${meta ? `\n(${meta})` : ''}\n${clip(d.content, perDoc)}`;
      })
      .join('\n\n---\n\n');

    const depthGuidance =
      level === 'predictive'
        ? 'Include forward-looking trends and where the topic is heading, but clearly mark predictions as such.'
        : level === 'deep'
          ? 'Go beyond the surface: connect points across sources, note agreements and contradictions.'
          : 'Provide a clear, accurate surface-level synthesis.';

    return `You are DINA's research analyst. Synthesize the numbered web sources below into a factual, grounded briefing on the user's query.

USER QUERY: "${query}"

DEPTH: ${depthGuidance}

RULES:
- Base EVERY claim only on the provided sources. Do NOT invent facts, numbers, or quotes.
- When sources disagree, say so. If evidence is thin, lower your confidence and add a caveat.
- Attribute key claims to sources by their number where relevant.
- You MUST respond with valid JSON ONLY. No markdown, no code fences, no commentary.

Respond with exactly this JSON shape:
{
  "summary": "2-4 sentence grounded synthesis",
  "keyInsights": ["insight 1", "insight 2", "..."],
  "entities": [{"text": "entity name", "type": "person|organization|location|technology|other"}],
  "topics": [{"topic": "topic name", "relevance": 0.0}],
  "trends": [{"trend": "trend description", "direction": "rising|falling|stable|unclear"}],
  "confidence": 0.0,
  "caveats": ["limitation or uncertainty 1"]
}

SOURCES:
${sourceBlocks}`;
  }

  // --------------------------------------------------------------------------
  // LLM CALL (Promise.race timeout, dual token option keys)
  // --------------------------------------------------------------------------

  private async callLLM(prompt: string): Promise<string> {
    if (!this.llmManager || typeof this.llmManager.generate !== 'function') {
      throw new Error('llmManager is not available');
    }

    const generation = this.llmManager.generate(prompt, {
      // Some code paths read maxTokens, the manager reads max_tokens — pass both.
      maxTokens: this.cfg.synthesisMaxTokens,
      max_tokens: this.cfg.synthesisMaxTokens,
      temperature: 0.3,
      model_preference: this.cfg.synthesisModel,
      task: 'digim_web_synthesis',
    });

    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`synthesis timed out after ${this.cfg.synthesisTimeoutMs}ms`)), this.cfg.synthesisTimeoutMs);
      // Do not keep the event loop alive purely for this timer.
      if (typeof (t as any).unref === 'function') (t as any).unref();
    });

    const response = await Promise.race([generation, timeout]);
    return this.extractText(response);
  }

  private extractText(response: any): string {
    if (typeof response === 'string') return response;
    if (response?.response) return response.response;
    if (response?.content) return response.content;
    if (response?.choices?.[0]?.message?.content) return response.choices[0].message.content;
    throw new Error('LLM response had no readable text field');
  }

  // --------------------------------------------------------------------------
  // JSON PARSING (Variant A — fence strip + brace clamp)
  // --------------------------------------------------------------------------

  private parseJsonResponse<T>(response: string): T {
    let cleaned = (response || '').trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }

    try {
      return JSON.parse(cleaned) as T;
    } catch (err) {
      this.logger.error('Failed to parse LLM JSON response', {
        responseLength: response?.length ?? 0,
        firstChars: (response || '').substring(0, 200),
      });
      throw new Error('Failed to parse web synthesis response as JSON');
    }
  }

  // --------------------------------------------------------------------------
  // NORMALIZATION (never trust the model's shape)
  // --------------------------------------------------------------------------

  private normalizeInsight(parsed: Partial<WebInsight>, docs: GatheredDocument[]): WebInsight {
    const sources = docs.map((d) => ({ title: d.title, url: d.url }));
    return {
      summary: ensureString(parsed.summary, 'No summary produced.'),
      keyInsights: ensureStringArray(parsed.keyInsights).slice(0, 20),
      entities: ensureArray(parsed.entities)
        .map((e: any) => ({ text: ensureString(e?.text, ''), type: ensureString(e?.type, 'other') }))
        .filter((e) => e.text.length > 0)
        .slice(0, 40),
      topics: ensureArray(parsed.topics)
        .map((t: any) => ({ topic: ensureString(t?.topic, ''), relevance: clamp01(toNumber(t?.relevance, 0.5)) }))
        .filter((t) => t.topic.length > 0)
        .slice(0, 25),
      trends: ensureArray(parsed.trends)
        .map((t: any) => ({
          trend: ensureString(t?.trend, ''),
          direction: ensureEnum(t?.direction, ['rising', 'falling', 'stable', 'unclear'], 'unclear'),
        }))
        .filter((t) => t.trend.length > 0)
        .slice(0, 15),
      confidence: clamp01(toNumber(parsed.confidence, 0.5)),
      sources,
      caveats: ensureStringArray(parsed.caveats).slice(0, 10),
    };
  }

  // --------------------------------------------------------------------------
  // DEGRADED / EMPTY FALLBACKS
  // --------------------------------------------------------------------------

  /** Build a usable insight from document metadata when the LLM is unavailable. */
  private degradedInsight(query: string, docs: GatheredDocument[]): WebInsight {
    const sources = docs.map((d) => ({ title: d.title, url: d.url }));
    return {
      summary: `Gathered ${docs.length} source(s) relevant to "${query}". Automated synthesis was unavailable; showing source-derived highlights.`,
      keyInsights: docs.slice(0, 8).map((d) => `${d.title} — ${clip(d.content, 200)}`),
      entities: [],
      topics: [],
      trends: [],
      confidence: 0.2,
      sources,
      caveats: ['LLM synthesis failed; this is a non-synthesized fallback built from source metadata.'],
    };
  }

  private emptyInsight(reason: string): WebInsight {
    return {
      summary: reason,
      keyInsights: [],
      entities: [],
      topics: [],
      trends: [],
      confidence: 0,
      sources: [],
      caveats: [reason],
    };
  }
}

// ----------------------------------------------------------------------------
// COERCION HELPERS
// ----------------------------------------------------------------------------

function ensureString(v: any, fallback: string): string {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return fallback;
}

function ensureArray(v: any): any[] {
  return Array.isArray(v) ? v : [];
}

function ensureStringArray(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : String(x ?? '').trim())).filter((s) => s.length > 0);
}

function ensureEnum<T extends string>(v: any, allowed: T[], fallback: T): T {
  return allowed.includes(v) ? v : fallback;
}

function toNumber(v: any, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function clip(text: string, max: number): string {
  if (typeof text !== 'string') return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}
