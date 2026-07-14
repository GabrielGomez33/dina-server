// File: src/modules/gpu/index.ts
// ============================================================================
// DINA GPU ARBITER — PUBLIC BARREL
// ============================================================================
// The single import surface for the rest of dina-server:
//
//   import { gpuArbiter, OllamaEngineAdapter } from '../gpu';
//
// Everything a consumer needs (the singleton, the run() helper via the
// singleton, types, errors, and the Ollama adapter) is re-exported here.
// ============================================================================

export * from './types';
export { Clock, VirtualClock, realClock } from './clock';
export {
  GpuArbiter,
  gpuArbiter,
  DEFAULT_ARBITER_CONFIG,
  GpuAcquireTimeoutError,
  GpuAbortError,
  GpuArbiterShutdownError,
} from './gpuArbiter';
export { OllamaEngineAdapter } from './engines/ollamaEngine';
