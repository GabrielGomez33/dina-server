// File: src/modules/vision/index.ts
// ============================================================================
// DINA VISION (DIVIS) — PUBLIC BARREL
// ============================================================================
// One import surface for the vision subsystem so the DINA core (and tests)
// depend on a single path, not the internal file layout. Mirrors the DIGIM
// web-research barrel pattern, including the lazily-constructed singleton so
// every importer shares one subsystem instance.
// ============================================================================

export { getVisionConfig, __rebuildVisionConfigForTests } from './config/visionConfig';
export type { VisionRuntimeConfig } from './config/visionConfig';

export { probeImage, mimeForFormat } from './ingestion/imageProbe';
export type { ImageFormat, ProbeResult } from './ingestion/imageProbe';

export {
  decodeBase64Image,
  validateImageBuffer,
  parseDataUri,
} from './security/imageGuard';

export { ingestImage, toBuffer } from './ingestion/imageIngestor';
export { ingestVideo, sampleFrameIndices } from './ingestion/videoIngestor';
export type { NormalizedFrame } from './ingestion/videoIngestor';

export { VisionModelClient } from './ollama/visionModel';
export { ImageAnalyzer } from './analysis/imageAnalyzer';
export { VideoAnalyzer } from './analysis/videoAnalyzer';
export { parseFullAnalysis, parseSingleTask, extractJsonObject } from './analysis/structuredParser';
export { buildPrompt, VISION_SYSTEM_PROMPT } from './analysis/promptTemplates';
export { VisionStore } from './storage/visionStore';

export { VisionOrchestrator } from './visionOrchestrator';

export * from './types';

// A lazily-constructed singleton so importers share one subsystem instance.
import { VisionOrchestrator } from './visionOrchestrator';
let _singleton: VisionOrchestrator | null = null;
export function getVisionOrchestrator(): VisionOrchestrator {
  if (!_singleton) _singleton = new VisionOrchestrator();
  return _singleton;
}
