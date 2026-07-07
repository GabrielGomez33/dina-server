// File: src/modules/digim/web/memory/embeddingService.ts
// ============================================================================
// DIGIM WEB-RESEARCH — EMBEDDING SERVICE
// ============================================================================
//
// Thin, defensive wrapper around the shared LLM manager's embed() so the rest
// of semantic memory deals in plain `number[]` vectors. It normalizes the two
// shapes Ollama/`DinaLLMManager` can return (a flat number[] or a number[][]
// with one row) and never throws — a failed embed returns null so callers can
// mark the document 'failed' and move on.
// ============================================================================

import { getDigimWebConfig, DigimWebConfig } from '../config/webConfig';

export class EmbeddingService {
  constructor(private llmManager: any, private cfg: DigimWebConfig = getDigimWebConfig()) {}

  /**
   * Embed a piece of text into a vector. Returns null on any failure.
   * Text is clipped to embedMaxChars to respect the embed model's token limit.
   */
  async embed(text: string): Promise<number[] | null> {
    const input = (text || '').trim();
    if (!input) return null;
    if (!this.llmManager || typeof this.llmManager.embed !== 'function') {
      console.warn('⚠️ [embeddingService] llmManager.embed unavailable');
      return null;
    }

    const clipped = input.length > this.cfg.embedMaxChars ? input.slice(0, this.cfg.embedMaxChars) : input;

    try {
      const res = await this.llmManager.embed(clipped, { model_preference: this.cfg.embedModel });
      const vector = extractVector(res);
      if (!vector || vector.length === 0) {
        console.warn('⚠️ [embeddingService] embed returned no usable vector');
        return null;
      }
      return vector;
    } catch (err) {
      console.warn(`⚠️ [embeddingService] embed failed: ${(err as Error).message}`);
      return null;
    }
  }
}

/**
 * Pull a flat number[] out of whatever the LLM manager returned.
 * DinaLLMManager.embed() sets LLMResponse.response = JSON.stringify(embeddings),
 * where `embeddings` may be number[] or number[][] (one row). We also accept an
 * object that already carries an array. Exported for unit testing.
 */
export function extractVector(res: any): number[] | null {
  if (!res) return null;

  // Direct array forms.
  const direct = coerceVector(res.embedding ?? res.embeddings ?? res.vector ?? res);
  if (direct) return direct;

  // LLMResponse.response is a JSON string of the embeddings.
  if (typeof res.response === 'string') {
    try {
      return coerceVector(JSON.parse(res.response));
    } catch {
      return null;
    }
  }
  return null;
}

function coerceVector(value: any): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  // number[][] with one (or more) rows → take the first row.
  if (Array.isArray(value[0])) {
    const row = value[0];
    return isNumberArray(row) ? row : null;
  }
  return isNumberArray(value) ? value : null;
}

function isNumberArray(a: any[]): boolean {
  return a.length > 0 && a.every((x) => typeof x === 'number' && Number.isFinite(x));
}
