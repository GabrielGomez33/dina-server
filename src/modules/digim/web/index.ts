// File: src/modules/digim/web/index.ts
// ============================================================================
// DIGIM WEB-RESEARCH — PUBLIC BARREL
// ============================================================================
// A single import surface for the web-research subsystem so the DIGIM
// orchestrator (and tests) depend on one path, not the internal file layout.
// ============================================================================

export { getDigimWebConfig, __rebuildDigimWebConfigForTests } from './config/webConfig';
export type { DigimWebConfig, SearchProviderName } from './config/webConfig';

export { checkUrlSafety, assertUrlSafe, isPrivateAddress, UrlSafetyError } from './security/urlGuard';
export type { UrlSafetyResult, UrlUnsafeReason } from './security/urlGuard';

export { sanitizeUntrusted, buildFencedSources, INJECTION_SYSTEM_RULE } from './security/promptGuard';
export type { SanitizeResult, FenceableSource } from './security/promptGuard';

export { EmbeddingService, extractVector } from './memory/embeddingService';
export { SemanticMemory } from './memory/semanticMemory';
export type { RetrieveOptions } from './memory/semanticMemory';
export { rankHybrid } from './memory/hybridRank';
export type { MemoryCandidate } from './memory/hybridRank';

export { createSearchProvider } from './gatherers/searchProvider';
export type { SearchProvider } from './gatherers/searchProvider';
export { WebFetcher } from './gatherers/webFetcher';
export { ContentExtractor } from './gatherers/contentExtractor';
export { QualityScorer } from './scoring/qualityScorer';
export { GatheringPipeline } from './pipeline/gatheringPipeline';
export { WebInsightSynthesizer } from './processors/webInsightSynthesizer';
export { WebResearchStore, WEB_RESEARCH_SOURCE_ID, hashQuery } from './storage/webResearchStore';
export { WebResearchOrchestrator } from './webResearchOrchestrator';
export type { IntelligenceLevel, ResearchResult } from './webResearchOrchestrator';

export * from './types';

// A lazily-constructed singleton so importers share one subsystem instance.
import { WebResearchOrchestrator } from './webResearchOrchestrator';
let _singleton: WebResearchOrchestrator | null = null;
export function getWebResearchOrchestrator(): WebResearchOrchestrator {
  if (!_singleton) _singleton = new WebResearchOrchestrator();
  return _singleton;
}
