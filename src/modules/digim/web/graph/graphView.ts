// File: src/modules/digim/web/graph/graphView.ts
// ============================================================================
// DIGIM RELATIONSHIP GRAPH — ADAPTIVE VIEW SELECTION (Phase 2.4b)
// ============================================================================
//
// "The system picks the best view for the data." A pure function over the
// subgraph's shape — no rendering, no state — so it's trivially testable:
//
//   • Mostly time-stamped nodes (events)  → TEMPORAL  (x = time; show ripples)
//   • Mostly embedded, larger cloud        → SEMANTIC  (project vectors; topic clusters)
//   • Otherwise                            → NETWORK   (force-directed web of relations)
//
// This only RECOMMENDS; a caller/renderer may override. Keeping it pure means the
// recommendation can never disagree with a stored flag or drift over time.
// ============================================================================

import { GraphNode, GraphEdge, GraphViewType } from './graphTypes';

export interface ViewThresholds {
  /** Fraction of time-stamped nodes at/above which temporal wins. */
  temporalRatio: number;
  /** Fraction of embedded nodes at/above which semantic wins... */
  semanticRatio: number;
  /** ...but only once the cloud is at least this big (small graphs read better as networks). */
  semanticMinNodes: number;
}

export const DEFAULT_VIEW_THRESHOLDS: ViewThresholds = {
  temporalRatio: 0.5,
  semanticRatio: 0.6,
  semanticMinNodes: 8,
};

/**
 * Recommend the most useful view for a subgraph. Deterministic and total
 * (always returns a valid view, even for an empty graph).
 */
export function suggestView(
  nodes: Array<Pick<GraphNode, 'occurredAt' | 'embeddingRef'>>,
  _edges: GraphEdge[] = [],
  thresholds: ViewThresholds = DEFAULT_VIEW_THRESHOLDS
): GraphViewType {
  const n = nodes.length;
  if (n === 0) return 'network';

  const timed = nodes.filter((x) => !!x.occurredAt).length;
  if (timed / n >= thresholds.temporalRatio) return 'temporal';

  const embedded = nodes.filter((x) => !!x.embeddingRef).length;
  if (n >= thresholds.semanticMinNodes && embedded / n >= thresholds.semanticRatio) return 'semantic';

  return 'network';
}
