// File: src/modules/gpu/engines/ollamaEngine.ts
// ============================================================================
// DINA GPU ARBITER — OLLAMA ENGINE ADAPTER
// ============================================================================
//
// Teaches the arbiter how to FREE the VRAM Ollama holds so an exclusive visuals
// job (FLUX/Wan/HunyuanVideo/LoRA) can use the whole card, and how to re-warm
// Ollama afterward.
//
// HOW OLLAMA HOLDS VRAM
// ---------------------
// dina-server loads models with `keep_alive: 24h`, so the warm set (qwen2.5:3b
// + mistral:7b + mxbai-embed-large ≈ 10 GB) stays resident. Ollama unloads a
// model when it receives a request for it with `keep_alive: 0`. So to drain, we:
//   1. GET /api/ps            → list currently-loaded models
//   2. for each, POST /api/generate {model, keep_alive:0, prompt:""}   (unload)
//      (embedding models are unloaded via /api/embed with keep_alive:0)
//   3. poll /api/ps until VRAM is released (or a short timeout)
//
// To restore, we re-warm the chat model with a 1-token generate so the next
// @Dina message is fast again.
//
// EVERYTHING here is best-effort and NEVER throws — a drain failure must not
// crash the scheduler; the residency monitor + watchdog are the safety nets.
// ============================================================================

import { EngineAdapter } from '../types';

interface OllamaEngineOptions {
  /** Base URL of the Ollama daemon (default http://localhost:11434). */
  baseUrl?: string;
  /** Model to re-warm on restore (default qwen2.5:3b, the interactive chat model). */
  warmModel?: string;
  /** Max ms to wait for VRAM to actually drain before giving up (default 15s). */
  drainTimeoutMs?: number;
  /** Poll interval while waiting for drain (default 500ms). */
  pollIntervalMs?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

interface PsModel {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
}

const BYTES_PER_MB = 1024 * 1024;

export class OllamaEngineAdapter implements EngineAdapter {
  readonly name = 'ollama';

  private readonly baseUrl: string;
  private readonly warmModel: string;
  private readonly drainTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: OllamaEngineOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.warmModel = opts.warmModel ?? process.env.DINA_CHAT_MODEL ?? 'qwen2.5:3b';
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 15000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Unload every loaded model and wait (bounded) for VRAM to actually free. */
  async drain(reason: string): Promise<number> {
    let loaded: PsModel[];
    try {
      loaded = await this.listLoaded();
    } catch (err) {
      console.warn(`⚠️ [ollamaEngine] /api/ps unreachable during drain (${reason}); assuming nothing to free.`);
      return 0;
    }
    if (loaded.length === 0) return 0;

    const beforeMb = totalVramMb(loaded);

    // Ask Ollama to unload each model. Failures per-model are non-fatal.
    await Promise.all(
      loaded.map(async (m) => {
        const model = m.name || m.model;
        if (!model) return;
        try {
          await this.unload(model);
        } catch (err) {
          console.warn(`⚠️ [ollamaEngine] failed to unload ${model}: ${(err as Error).message}`);
        }
      }),
    );

    // Poll until VRAM is released or we hit the timeout — Ollama frees memory
    // asynchronously after acknowledging the unload request.
    const deadline = Date.now() + this.drainTimeoutMs;
    let remainingMb = beforeMb;
    while (Date.now() < deadline) {
      await this.sleep(this.pollIntervalMs);
      try {
        const still = await this.listLoaded();
        remainingMb = totalVramMb(still);
        if (remainingMb <= 1) break;
      } catch {
        break; // if ps goes unreachable, stop waiting; best-effort
      }
    }

    const freedMb = Math.max(0, Math.round(beforeMb - remainingMb));
    return freedMb;
  }

  /** Re-warm the interactive chat model so the next @Dina message is fast. */
  async restore(reason: string): Promise<void> {
    try {
      await this.fetchJson(`${this.baseUrl}/api/generate`, {
        model: this.warmModel,
        prompt: 'ok',
        stream: false,
        keep_alive: process.env.DINA_KEEP_ALIVE ?? '24h',
        options: { num_predict: 1, temperature: 0 },
      });
    } catch (err) {
      console.warn(`⚠️ [ollamaEngine] re-warm failed (${reason}, non-fatal): ${(err as Error).message}`);
    }
  }

  // --------------------------------------------------------------------------

  private async listLoaded(): Promise<PsModel[]> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/ps`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { models?: PsModel[] };
      return Array.isArray(data.models) ? data.models : [];
    } finally {
      clearTimeout(t);
    }
  }

  private async unload(model: string): Promise<void> {
    const endpoint = model.includes('embed') ? '/api/embed' : '/api/generate';
    const body = model.includes('embed')
      ? { model, input: '', keep_alive: 0 }
      : { model, prompt: '', stream: false, keep_alive: 0 };
    await this.fetchJson(`${this.baseUrl}${endpoint}`, body);
  }

  private async fetchJson(url: string, body: unknown): Promise<void> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Drain the body so the socket is freed; content is irrelevant here.
      await res.text().catch(() => undefined);
    } finally {
      clearTimeout(t);
    }
  }
}

function totalVramMb(models: PsModel[]): number {
  let bytes = 0;
  for (const m of models) bytes += typeof m.size_vram === 'number' ? m.size_vram : 0;
  return bytes / BYTES_PER_MB;
}
