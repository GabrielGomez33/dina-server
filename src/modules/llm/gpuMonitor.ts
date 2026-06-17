// File: src/modules/llm/gpuMonitor.ts
// ============================================================================
// DINA GPU / OLLAMA RESIDENCY MONITOR
// ============================================================================
//
// THE PROBLEM THIS SOLVES
// -----------------------
// When the NVIDIA driver/library version drifts (e.g. an unattended apt upgrade
// without a reboot), CUDA/NVML breaks and Ollama silently falls back to running
// every model 100% on CPU. Latency regresses to pre-GPU levels and *nothing*
// surfaces it — you only notice because responses got slow. That exact failure
// took down @Dina's response times.
//
// This monitor polls Ollama's /api/ps endpoint, compares each loaded model's
// `size_vram` against its total `size`, and classifies residency:
//   • gpu        — everything loaded is ~100% in VRAM (healthy)
//   • partial    — at least one model is split GPU/CPU (degraded — offloading)
//   • cpu        — models are loaded but 0% in VRAM (GPU effectively dead)
//   • idle       — no models currently loaded
//   • unreachable— Ollama did not answer
//
// On any transition into a degraded state it logs a loud, structured alert and
// exposes the latest snapshot via getStatus() so the mirror module / health
// endpoints can show operators "Dina is running on CPU" immediately.
//
// It performs only read-only HTTP GETs, never throws into the caller, and all
// timers are unref()'d so it can never keep the process alive on its own.
// ============================================================================

import { getLlmConfig } from './llmConfig';

export type GpuResidencyState = 'gpu' | 'partial' | 'cpu' | 'idle' | 'unreachable' | 'unknown';

export interface LoadedModelResidency {
  name: string;
  /** Total model size in bytes (weights + KV cache as reported by Ollama). */
  sizeBytes: number;
  /** Portion resident in VRAM, in bytes. */
  sizeVramBytes: number;
  /** Percentage of the model resident on the GPU (0-100). */
  gpuPercent: number;
  processor: 'gpu' | 'cpu' | 'split';
  expiresAt?: string;
}

export interface GpuMonitorStatus {
  state: GpuResidencyState;
  healthy: boolean;
  /** Human-readable one-liner suitable for an admin banner. */
  summary: string;
  loadedModels: LoadedModelResidency[];
  consecutiveDegraded: number;
  lastCheck: string | null;
  lastHealthy: string | null;
  ollamaReachable: boolean;
  checkedSince: string;
}

interface OllamaPsModel {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
  expires_at?: string;
}

const BYTES_PER_GB = 1024 * 1024 * 1024;
const fmtGb = (bytes: number): string => `${(bytes / BYTES_PER_GB).toFixed(2)}GB`;

export class GpuMonitor {
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  private state: GpuResidencyState = 'unknown';
  private loadedModels: LoadedModelResidency[] = [];
  private consecutiveDegraded = 0;
  private lastCheck: string | null = null;
  private lastHealthy: string | null = null;
  private ollamaReachable = false;
  private summary = 'GPU residency not yet checked';
  private readonly checkedSince = new Date().toISOString();

  /** Start periodic monitoring. Idempotent and safe to call from any instance. */
  start(): void {
    if (this.started) return;
    const cfg = getLlmConfig();
    if (!cfg.monitorEnabled) {
      console.log('🟨 [gpuMonitor] Disabled via DINA_GPU_MONITOR=false');
      return;
    }
    this.started = true;
    console.log(`🩺 [gpuMonitor] Starting GPU residency monitor (every ${Math.round(cfg.monitorIntervalMs / 1000)}s)`);

    // Kick an immediate check, then schedule.
    void this.checkOnce();
    this.timer = setInterval(() => {
      void this.checkOnce();
    }, Math.max(10000, cfg.monitorIntervalMs));
    // Never let the monitor alone keep the event loop alive.
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /** Latest snapshot — synchronous, cheap, safe to call on every request. */
  getStatus(): GpuMonitorStatus {
    return {
      state: this.state,
      healthy: this.state === 'gpu' || this.state === 'idle',
      summary: this.summary,
      loadedModels: this.loadedModels,
      consecutiveDegraded: this.consecutiveDegraded,
      lastCheck: this.lastCheck,
      lastHealthy: this.lastHealthy,
      ollamaReachable: this.ollamaReachable,
      checkedSince: this.checkedSince,
    };
  }

  /**
   * Force a fresh check and return the snapshot. Used by on-demand diagnostics
   * endpoints so operators always get live data, not a cached value.
   */
  async refresh(): Promise<GpuMonitorStatus> {
    await this.checkOnce();
    return this.getStatus();
  }

  // --------------------------------------------------------------------------
  // INTERNALS
  // --------------------------------------------------------------------------

  private async checkOnce(): Promise<void> {
    const cfg = getLlmConfig();
    const previous = this.state;
    this.lastCheck = new Date().toISOString();

    let psModels: OllamaPsModel[];
    try {
      psModels = await this.fetchPs(cfg.ollamaBaseUrl);
      this.ollamaReachable = true;
    } catch (err) {
      this.ollamaReachable = false;
      this.loadedModels = [];
      this.state = 'unreachable';
      this.summary = `Ollama unreachable at ${cfg.ollamaBaseUrl} (${(err as Error).message})`;
      this.consecutiveDegraded++;
      this.alertOnTransition(previous, this.state);
      return;
    }

    const models: LoadedModelResidency[] = psModels.map((m) => {
      const name = m.name || m.model || 'unknown';
      const sizeBytes = typeof m.size === 'number' ? m.size : 0;
      const sizeVramBytes = typeof m.size_vram === 'number' ? m.size_vram : 0;
      const gpuPercent = sizeBytes > 0 ? Math.round((sizeVramBytes / sizeBytes) * 100) : 0;
      const processor: 'gpu' | 'cpu' | 'split' =
        gpuPercent >= 99 ? 'gpu' : gpuPercent <= 1 ? 'cpu' : 'split';
      return { name, sizeBytes, sizeVramBytes, gpuPercent, processor, expiresAt: m.expires_at };
    });

    this.loadedModels = models;
    this.state = this.classify(models);

    if (this.state === 'gpu' || this.state === 'idle') {
      this.consecutiveDegraded = 0;
      this.lastHealthy = this.lastCheck;
    } else {
      this.consecutiveDegraded++;
    }

    this.summary = this.buildSummary(models);
    this.alertOnTransition(previous, this.state);
  }

  private classify(models: LoadedModelResidency[]): GpuResidencyState {
    if (models.length === 0) return 'idle';
    const anyCpuSplit = models.some((m) => m.processor !== 'gpu');
    const allCpu = models.every((m) => m.processor === 'cpu');
    if (allCpu) return 'cpu';
    if (anyCpuSplit) return 'partial';
    return 'gpu';
  }

  private buildSummary(models: LoadedModelResidency[]): string {
    if (models.length === 0) return 'No models currently loaded (idle)';
    const parts = models.map((m) => `${m.name} ${m.gpuPercent}% GPU (${fmtGb(m.sizeVramBytes)}/${fmtGb(m.sizeBytes)})`);
    switch (this.state) {
      case 'gpu':
        return `✅ All models on GPU — ${parts.join('; ')}`;
      case 'partial':
        return `⚠️ CPU offload detected — ${parts.join('; ')}`;
      case 'cpu':
        return `🔴 Running 100% on CPU (GPU unavailable) — ${parts.join('; ')}`;
      default:
        return parts.join('; ');
    }
  }

  private alertOnTransition(previous: GpuResidencyState, current: GpuResidencyState): void {
    if (previous === current) {
      // Still degraded — emit a periodic reminder, but not every single tick.
      if ((current === 'cpu' || current === 'unreachable') && this.consecutiveDegraded % 5 === 0) {
        console.error(`🔴 [gpuMonitor] STILL DEGRADED (${this.consecutiveDegraded} checks): ${this.summary}`);
      }
      return;
    }

    switch (current) {
      case 'cpu':
        console.error('🔴🔴🔴 [gpuMonitor] CRITICAL: Ollama is running models on CPU — GPU is not being used!');
        console.error(`🔴 [gpuMonitor] ${this.summary}`);
        console.error('🔴 [gpuMonitor] Likely cause: NVIDIA driver/library version mismatch. Run `nvidia-smi`; if it errors, REBOOT the host. See ops/GPU_RUNBOOK.md');
        break;
      case 'partial':
        console.error('⚠️ [gpuMonitor] WARNING: a model is split across GPU and CPU (VRAM exceeded — offloading).');
        console.error(`⚠️ [gpuMonitor] ${this.summary}`);
        break;
      case 'unreachable':
        console.error(`🔴 [gpuMonitor] Ollama unreachable: ${this.summary}`);
        break;
      case 'gpu':
        console.log(`✅ [gpuMonitor] GPU healthy — ${this.summary}`);
        break;
      case 'idle':
        console.log('🟦 [gpuMonitor] No models loaded (idle).');
        break;
      default:
        break;
    }
  }

  private async fetchPs(baseUrl: string): Promise<OllamaPsModel[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${baseUrl}/api/ps`, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { models?: OllamaPsModel[] };
      return Array.isArray(data.models) ? data.models : [];
    } finally {
      clearTimeout(timeout);
    }
  }
}

// Process-wide singleton — shared across every DinaLLMManager instance.
export const gpuMonitor = new GpuMonitor();