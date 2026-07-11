// File: src/modules/digim/web/tools/httpFetchTool.ts
// ============================================================================
// DIGIM WEB-RESEARCH — HTTP FETCH TOOL (Phase 2.2)
// ============================================================================
//
// The cheap, default acquisition tool. A THIN adapter over the proven WebFetcher
// — WebFetcher's battle-tested logic (SSRF guard on every hop, manual redirects,
// byte cap, politeness, retries) is untouched. This wrapper only presents it
// through the FetchTool interface and stamps `tool: 'http'`.
//
// isAvailable() is always true: plain fetch() is a Node built-in.
// ============================================================================

import { getDigimWebConfig, DigimWebConfig } from '../config/webConfig';
import { WebFetcher } from '../gatherers/webFetcher';
import { FetchTool } from './fetchTool';
import { FetchResult } from '../types';

export class HttpFetchTool implements FetchTool {
  readonly name = 'http';
  readonly cost = 'cheap' as const;
  private fetcher: WebFetcher;

  constructor(cfg: DigimWebConfig = getDigimWebConfig(), fetcher?: WebFetcher) {
    this.fetcher = fetcher ?? new WebFetcher(cfg);
  }

  isAvailable(): boolean {
    return true;
  }

  async fetch(url: string): Promise<FetchResult> {
    const result = await this.fetcher.fetchUrl(url);
    // Stamp provenance without mutating WebFetcher's return shape.
    return { ...result, tool: this.name };
  }
}
