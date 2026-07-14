// File: src/modules/saga/systems/comfyClient.ts
// ============================================================================
// DINA SAGA — COMFYUI CLIENT (single source of truth for ComfyUI I/O)
// ============================================================================
// Wraps ComfyUI's HTTP + WebSocket API behind one method:
//
//   executeWorkflow(graph, handlers) → Promise<ComfyResult>
//
// Protocol (ComfyUI API):
//   POST /prompt {prompt, client_id}          → { prompt_id }
//   WS   /ws?clientId=…  events:
//     {type:'progress',  data:{value,max,prompt_id}}          sampling steps
//     {type:'executing', data:{node,prompt_id}}               node null ⇒ done
//     {type:'execution_error', data:{...}}                    failure
//   GET  /history/{prompt_id}                 → outputs (filenames)
//   POST /interrupt                           cancel the running prompt
//
// ROBUSTNESS RULES (all exercised in the harness via injected fake transport):
//   • Overall timeout — a hung ComfyUI can never hold the caller (or the GPU
//     lease above it) forever; on timeout we send /interrupt best-effort.
//   • AbortSignal — user cancellation interrupts the prompt and rejects.
//   • Stall detection — no WS event for `stallMs` ⇒ treated as a hang.
//   • Every exit path (resolve/reject) closes the socket exactly once.
//   • The transport (fetch + WS factory) is injected — hermetic tests drive
//     every path without a real ComfyUI.
// ============================================================================

export interface ComfyEvent {
  type: string;
  data?: any;
}

export interface ComfySocket {
  close(): void;
}

/** Injected transport — production adapts global fetch + 'ws'; tests fake it. */
export interface ComfyTransport {
  post(path: string, body: unknown, timeoutMs: number): Promise<any>;
  get(path: string, timeoutMs: number): Promise<any>;
  openSocket(clientId: string, onEvent: (e: ComfyEvent) => void, onError: (err: Error) => void): ComfySocket;
}

export interface ComfyExecuteHandlers {
  /** Sampling step progress (value/max) — feed the ProgressMapper. */
  onStep?: (value: number, max: number) => void;
  /** A named node started executing — phase transitions. */
  onNode?: (nodeId: string) => void;
  signal?: AbortSignal;
  /** Hard ceiling for the whole execution (default 30 min). */
  timeoutMs?: number;
  /** Max silence between WS events before declaring a stall (default 120s). */
  stallMs?: number;
}

export interface ComfyResult {
  promptId: string;
  /** Raw outputs section from /history — filenames per node. */
  outputs: Record<string, any>;
  elapsedMs: number;
}

export class ComfyError extends Error {
  constructor(
    public readonly kind: 'submit' | 'execution' | 'timeout' | 'stall' | 'aborted' | 'transport',
    message: string,
  ) {
    super(message);
    this.name = 'ComfyError';
  }
}

export class ComfyClient {
  constructor(
    private readonly transport: ComfyTransport,
    private readonly clientId: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async executeWorkflow(graph: Record<string, any>, handlers: ComfyExecuteHandlers = {}): Promise<ComfyResult> {
    const timeoutMs = positive(handlers.timeoutMs, 30 * 60_000);
    const stallMs = positive(handlers.stallMs, 120_000);
    const started = this.now();

    if (handlers.signal?.aborted) throw new ComfyError('aborted', 'Cancelled before submission');

    // 1. Submit.
    let promptId: string;
    try {
      const res = await this.transport.post('/prompt', { prompt: graph, client_id: this.clientId }, 30_000);
      promptId = res?.prompt_id;
      if (!promptId) throw new Error('no prompt_id in response');
    } catch (e) {
      throw new ComfyError('submit', `ComfyUI rejected the workflow: ${(e as Error).message}`);
    }

    // 2. Track over WS until done / error / timeout / stall / abort.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let lastEventAt = this.now();
      let socket: ComfySocket | null = null;

      const timers: NodeJS.Timeout[] = [];
      const arm = (ms: number, fn: () => void): void => {
        const t = setTimeout(fn, ms);
        if (t.unref) t.unref();
        timers.push(t);
      };

      const finish = (err: Error | null): void => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        if (handlers.signal && onAbort) handlers.signal.removeEventListener('abort', onAbort);
        try {
          socket?.close();
        } catch {
          /* socket close is best-effort */
        }
        err ? reject(err) : resolve();
      };

      const interruptAnd = (err: ComfyError): void => {
        // Best-effort interrupt so the GPU stops burning on a job nobody waits for.
        void this.transport.post('/interrupt', {}, 10_000).catch(() => undefined);
        finish(err);
      };

      const onAbort = (): void => interruptAnd(new ComfyError('aborted', 'Cancelled by caller'));
      if (handlers.signal) handlers.signal.addEventListener('abort', onAbort, { once: true });

      arm(timeoutMs, () => interruptAnd(new ComfyError('timeout', `Execution exceeded ${timeoutMs}ms`)));

      const stallCheck = (): void => {
        if (settled) return;
        const silence = this.now() - lastEventAt;
        if (silence >= stallMs) {
          interruptAnd(new ComfyError('stall', `No ComfyUI events for ${silence}ms (stalled)`));
          return;
        }
        arm(stallMs - silence, stallCheck);
      };
      arm(stallMs, stallCheck);

      socket = this.transport.openSocket(
        this.clientId,
        (e) => {
          lastEventAt = this.now();
          const d = e.data ?? {};
          // Events for other prompts (another client) are ignored.
          if (d.prompt_id && d.prompt_id !== promptId) return;
          switch (e.type) {
            case 'progress':
              if (typeof d.value === 'number' && typeof d.max === 'number') handlers.onStep?.(d.value, d.max);
              break;
            case 'executing':
              if (d.node === null || d.node === undefined) finish(null); // graph complete
              else handlers.onNode?.(String(d.node));
              break;
            case 'execution_error':
              finish(new ComfyError('execution', `ComfyUI execution error: ${JSON.stringify(d).slice(0, 500)}`));
              break;
            default:
              break; // status/executed/etc — informational
          }
        },
        (err) => finish(new ComfyError('transport', `ComfyUI websocket error: ${err.message}`)),
      );
    });

    // 3. Collect outputs.
    let outputs: Record<string, any> = {};
    try {
      const hist = await this.transport.get(`/history/${promptId}`, 30_000);
      outputs = hist?.[promptId]?.outputs ?? {};
    } catch {
      // History fetch failing after a successful run is non-fatal — the files
      // are on disk; the worker resolves them by output directory.
    }

    return { promptId, outputs, elapsedMs: this.now() - started };
  }

  /** Liveness probe for health checks / calibration preflight. */
  async ping(): Promise<boolean> {
    try {
      await this.transport.get('/system_stats', 5_000);
      return true;
    } catch {
      return false;
    }
  }
}

function positive(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback;
}
