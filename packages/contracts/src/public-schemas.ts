/**
 * Public, versioned JSON Schema documents.
 *
 * The Zod definitions remain the source of truth. This registry imports only
 * the artifacts produced by `bun run generate`, as exact text, so a Worker
 * response cannot drift from the files checked by the contract gate.
 */

/// <reference path="./assets.d.ts" />

import enrollmentSchemaModule from "../generated/enrollment.schema.json" with { type: "text" };
import enrollmentCapsuleSchemaModule from "../generated/enrollment-capsule.schema.json" with {
  type: "text",
};
import ledgerSchemaModule from "../generated/ledger.schema.json" with { type: "text" };
import problemSchemaModule from "../generated/problem.schema.json" with { type: "text" };
import screeningSchemaModule from "../generated/screening.schema.json" with { type: "text" };
import sessionsSchemaModule from "../generated/sessions.schema.json" with { type: "text" };

export const PUBLIC_SCHEMA_IDS = Object.freeze([
  "enrollment",
  "enrollment-capsule",
  "ledger",
  "problem",
  "screening",
  "sessions",
] as const);

/**
 * Generated schemas that intentionally have no public agent face.
 *
 * Keep an explicit reason beside every exclusion. The unit contract test reads
 * the checked-in generated directory and requires it to be partitioned by this
 * list plus the served registry, so adding a schema cannot silently disappear
 * from the public-surface decision.
 */
export const PUBLIC_SCHEMA_EXCLUSIONS = Object.freeze([
  Object.freeze({
    id: "contracts-scaffold",
    reason: "Generator metadata; it is not a product protocol schema.",
  }),
  Object.freeze({
    id: "s2-cost-receipt",
    reason: "Internal S-2 cost-receipt evidence; it has no public agent face.",
  }),
] as const);

export type PublicSchemaId = (typeof PUBLIC_SCHEMA_IDS)[number];
export type PublicSchemaExclusion = (typeof PUBLIC_SCHEMA_EXCLUSIONS)[number];

export interface PublicSchemaDocument {
  readonly id: PublicSchemaId;
  readonly served_at: `/schemas/${string}.v1.json`;
  readonly media_type: "application/schema+json; charset=utf-8";
  readonly body: string;
}

function exactTextModule(value: unknown, source: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${source} was not bundled by the Wrangler Text module rule`);
  }
  return value;
}

const PUBLIC_SCHEMAS: readonly PublicSchemaDocument[] = Object.freeze([
  Object.freeze({
    id: "enrollment",
    served_at: "/schemas/enrollment.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(enrollmentSchemaModule, "generated/enrollment.schema.json"),
  }),
  Object.freeze({
    id: "enrollment-capsule",
    served_at: "/schemas/enrollment-capsule.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(
      enrollmentCapsuleSchemaModule,
      "generated/enrollment-capsule.schema.json",
    ),
  }),
  Object.freeze({
    id: "ledger",
    served_at: "/schemas/ledger.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(ledgerSchemaModule, "generated/ledger.schema.json"),
  }),
  Object.freeze({
    id: "problem",
    served_at: "/schemas/problem.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(problemSchemaModule, "generated/problem.schema.json"),
  }),
  Object.freeze({
    id: "screening",
    served_at: "/schemas/screening.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(screeningSchemaModule, "generated/screening.schema.json"),
  }),
  Object.freeze({
    id: "sessions",
    served_at: "/schemas/sessions.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(sessionsSchemaModule, "generated/sessions.schema.json"),
  }),
]);

/** Ordered, immutable registry used by the Worker and contract tests. */
export function listPublicSchemas(): readonly PublicSchemaDocument[] {
  return PUBLIC_SCHEMAS;
}

/** Resolve a fixed schema id; caller input is never interpreted as a path. */
export function getPublicSchema(id: PublicSchemaId): PublicSchemaDocument {
  const document = PUBLIC_SCHEMAS.find((candidate) => candidate.id === id);
  if (document === undefined) {
    throw new TypeError(`Unknown public schema id: ${id}`);
  }
  return document;
}
