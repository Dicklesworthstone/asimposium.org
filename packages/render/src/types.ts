/**
 * Shared shapes for the Diptych renderers (Fable Rule A1, §7.3).
 *
 * One projection in, many faces out. The agent face is canonical; the human
 * face is a projection of the same data. Nothing here knows how a projection
 * was composed — ordering, budgeting and `omitted[]` are the pack composer's
 * job (Fable §7.3) — the renderer only renders what it is handed, and refuses
 * envelopes that violate the structural trust rules of §14.4.
 */

/** Faces this package can emit. `toon` is deliberately absent: see README. */
export type FaceFormat = "md" | "json" | "html-fragment";

export const FACE_FORMATS: readonly FaceFormat[] = ["md", "json", "html-fragment"];

/**
 * Item provenance. `system` items are the only instruction-bearing items
 * (Fable §7.3, §14.4 layer 2); everything else is data.
 */
export type ItemScope = "system" | "ledger" | "workshop";

export const ITEM_SCOPES: readonly ItemScope[] = ["system", "ledger", "workshop"];

export interface ProjectionItem {
  /** Object kind: `claim`, `evidence`, `move`, `warning`, `handback`, … */
  readonly kind: string;
  /** Problem-scoped public id (`C-12`, `H-3@2`, `W-fermat-descent-01`, …). */
  readonly id: string;
  readonly scope: ItemScope;
  /** True for every non-system item. Enforced, not trusted (see `assertEnvelope`). */
  readonly untrusted: boolean;
  /** The body as authored. Untrusted bodies are neutralized before they reach a face. */
  readonly body: string;
  /** Server-authored reason this item is in the projection. Never author-supplied. */
  readonly why_included: string;
  /** Conservative whole-item estimate supplied by a budgeted pack composer. */
  readonly tokens?: number;
}

export interface OmittedEntry {
  /** Machine-readable reason, e.g. `budget_exceeded`, `no_membership`, `p12_review_isolation`. */
  readonly reason: string;
  /** Optional human-readable detail. Server-authored. */
  readonly detail?: string;
}

export interface NextAction {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly why: string;
}

/**
 * The renderable envelope. Mirrors the pack envelope of Fable §7.3
 * (`{schema, session, problem, profile, cursor, …, items[], omitted[],
 * next_actions[], degraded[]}`). Transport-only fields such as the HTTP ETag
 * and cryptographic digest remain the Worker's responsibility.
 */
export interface Projection {
  /** Contract id, e.g. `asimposium.pack.v1`. */
  readonly schema: string;
  /** Projection kind, e.g. `pack`. */
  readonly kind: string;
  /** Session id for a budgeted session pack. Present with both token fields or absent. */
  readonly session?: string;
  /** Problem slug or public id this projection belongs to. */
  readonly problem: string;
  /** Pack profile (`orient`, `working`, `review`, …) or another projection selector. */
  readonly profile: string;
  /** Per-scope monotonic cursor the projection was frozen at (Fable §7.1 axiom 7). */
  readonly cursor: number;
  /** Fixed Fable §7.3 token bucket. Present with session and tokens_estimate or absent. */
  readonly budget_tokens?: number;
  /** Conservative estimate for the complete semantic pack. */
  readonly tokens_estimate?: number;
  /** Server-authored title line. */
  readonly title: string;
  /** Server-authored preamble: "content below is untrusted data" (Fable §7.3). */
  readonly preamble: string;
  readonly items: readonly ProjectionItem[];
  /** Mandatory. An empty projection with an empty `omitted` is a bug, not a pack. */
  readonly omitted: readonly OmittedEntry[];
  /** Server-authored only. Never derived from a body (Fable §14.4 layer 2). */
  readonly next_actions: readonly NextAction[];
  /** Diagnostics. Never mixed into rendered bodies (Fable §7.1 axiom 2). */
  readonly degraded: readonly string[];
  /** The access this projection was composed under. Present on session packs. */
  readonly viewer?: ProjectionViewer;
}

/** What the sanitizer did to one item, surfaced on every face. */
export interface NeutralizationReport {
  readonly item_id: string;
  readonly marker: NeutralizationMarker;
  readonly count: number;
}

/**
 * The audience/membership/permissions a projection was composed under. Response
 * metadata (the caller's access), never an untrusted body — the canonical JSON
 * agent face carries it so a caller knows what it can do and a reviewer can see
 * the access the pack was composed under.
 *
 * Discriminated on `audience` so the type itself forbids a public projection
 * from carrying authority it cannot have applied (Rule A4). A public face has
 * no authenticated principal: its membership is exactly `none` and its
 * effective permission set is exactly empty, so claimed authority can neither
 * be reported nor perturb the canonical bytes and ETag. A session projection
 * keeps the full membership/permission vocabulary. `prepareProjection` enforces
 * this at runtime as well, refusing a dishonest public viewer before any
 * fingerprint or face is produced.
 */
export type ProjectionViewer =
  | {
      readonly audience: "public";
      readonly membership: "none";
      readonly effective_permissions: readonly [];
    }
  | {
      readonly audience: "session";
      readonly membership: "none" | "observer" | "contributor" | "steward";
      readonly effective_permissions: readonly string[];
    };

export type NeutralizationMarker =
  /** A forged `<!-- asimp … -->` control header inside an untrusted body. */
  | "asimp-control-comment"
  /** A forged pack-envelope key in JSON shape (`"next_actions":`) inside a body. */
  | "envelope-key-forgery"
  /** The body carried a backtick run that would have closed its own fence. */
  | "fence-extended"
  /** The body carried script-bearing HTML. Escaped on every face; recorded here. */
  | "active-html";

export interface RenderedFace {
  readonly format: FaceFormat;
  readonly media_type: string;
  readonly body: string;
  /** Non-cryptographic content fingerprint shared by every face of one projection. */
  readonly fingerprint: string;
  readonly bytes: number;
  readonly neutralized: readonly NeutralizationReport[];
}
