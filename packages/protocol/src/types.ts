/**
 * The shape of a served text (bead asimposiumorg-8xn, OPS.1).
 *
 * A served document is bytes plus the metadata a caller needs to serve it honestly: what it is
 * called, which version it is, where it is served, how big it is, and the digest that pins it
 * (ADR-24: every session records the protocol/policy version pair it worked under).
 */

/** Documents this package owns today. `skill`, `agents`, `inoculation` and the move templates are not written yet. */
export type DocumentId = "capsule" | "handbook" | "llms" | "policy" | "protocol";

export type DocumentStatus = "draft" | "published";

export interface ProtocolDocument {
  readonly id: DocumentId;
  readonly title: string;
  /** Semver-ish, stated inside the document body too; the two are drift-checked. */
  readonly version: string;
  /** `draft` until the W6/W9 wording pass lands. The site never presents a draft as settled. */
  readonly status: DocumentStatus;
  /** Public path this document is served at, e.g. `/protocol.md`. */
  readonly served_at: string;
  readonly media_type: string;
  /** Repository-relative source path. Never an absolute local path. */
  readonly source_path: string;
  /** The served bytes: LF-normalized, exactly one trailing newline. */
  readonly body: string;
  /** Lowercase hex SHA-256 of `body`. Content identity, not authentication. */
  readonly digest: string;
  readonly bytes: number;
  readonly words: number;
  /** Heuristic budget estimate (UTF-8 bytes / 4), never a tokenizer count. */
  readonly tokens_estimate: number;
}

/** The pair a session records so later amendments never retroactively re-judge its work. */
export interface ProtocolVersionPair {
  readonly protocol: { readonly version: string; readonly digest: string };
  readonly policy: { readonly version: string; readonly digest: string };
  /** Digest over both version/digest pairs: one string a session row can store. */
  readonly pair_digest: string;
}

export interface RulesMeasurement {
  readonly text: string;
  readonly words: number;
  readonly cap: number;
  readonly within_cap: boolean;
}
