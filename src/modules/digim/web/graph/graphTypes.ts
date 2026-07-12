// File: src/modules/digim/web/graph/graphTypes.ts
// ============================================================================
// DIGIM RELATIONSHIP GRAPH — SHARED TYPES (Phase 2.4b)
// ============================================================================
// One canonical vocabulary for the graph. The SAME node/edge shapes feed all
// three views (network / temporal / semantic) — the view differs only in how a
// renderer lays these out, never in the data.
// ============================================================================

export type EntityType =
  | 'person' | 'organization' | 'location' | 'event' | 'technology' | 'concept' | 'other';

export type GraphViewType = 'network' | 'temporal' | 'semantic';

/** A node in the graph (an entity or a time-stamped event). */
export interface GraphNode {
  id: string;
  name: string;
  type: EntityType | string;
  /** ISO time — populated for events; the temporal view's x-axis. */
  occurredAt?: string | null;
  /** Node weight = how often the entity appears (centrality proxy). */
  mentionCount: number;
  /** Link to the entity's vector (semantic view); null if not embedded. */
  embeddingRef?: string | null;
}

/** A directed, weighted, provenance-bearing edge. */
export interface GraphEdge {
  id: string;
  subjectId: string;
  predicate: string;
  objectId: string;
  /** Edge weight = number of distinct sources that asserted this relationship. */
  corroborationCount: number;
  confidence: number;
  occurredAt?: string | null;
  /** Source URLs backing this edge (provenance). */
  sources?: string[];
}

/** A subgraph returned by a query, plus the view the system recommends for it. */
export interface Subgraph {
  focus: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  suggestedView: GraphViewType;
}

/** An entity to upsert (input to GraphStore). */
export interface EntityInput {
  name: string;
  type?: string;
  occurredAt?: string | null;
  embeddingRef?: string | null;
}

/** A relationship triple to upsert (input to GraphStore). */
export interface RelationshipInput {
  subject: EntityInput;
  predicate: string;
  object: EntityInput;
  confidence?: number;
  occurredAt?: string | null;
  /** Provenance for corroboration. */
  sourceUrl?: string;
  sourceContentId?: string | null;
}
