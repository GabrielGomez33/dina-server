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
  nodes: Array<Pick<GraphNode, 'occurredAt' | 'occurredSort' | 'embeddingRef'>>,
  edges: Array<Pick<GraphEdge, 'occurredAt' | 'occurredSort'>> = [],
  thresholds: ViewThresholds = DEFAULT_VIEW_THRESHOLDS
): GraphViewType {
  const n = nodes.length;
  if (n === 0) return 'network';

  // A node/edge is "dated" if it carries a sortable year (occurred_sort) — which,
  // unlike occurred_at (DATETIME, CE-only), also covers BCE/prehistoric events. Fall
  // back to occurred_at so pre-backfill rows still count.
  const dated = (x: { occurredAt?: string | null; occurredSort?: number | null }) =>
    x.occurredSort != null || !!x.occurredAt;

  const timedNodes = nodes.filter(dated).length;
  if (timedNodes / n >= thresholds.temporalRatio) return 'temporal';

  // Dates in this graph often live on the RELATIONSHIPS, not the entities (e.g. an
  // event edge "X happened in 1969"). A graph whose edges are mostly dated is a
  // timeline even if few nodes are event-typed.
  const timedEdges = edges.filter(dated).length;
  if (edges.length > 0 && timedEdges / edges.length >= thresholds.temporalRatio) return 'temporal';

  const embedded = nodes.filter((x) => !!x.embeddingRef).length;
  if (n >= thresholds.semanticMinNodes && embedded / n >= thresholds.semanticRatio) return 'semantic';

  return 'network';
}
