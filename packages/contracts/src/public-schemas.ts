/**
 * Public, versioned JSON Schema documents.
 *
 * Zod is the source of truth. Existing generated artifacts are imported as
 * exact text. Explicit inline schemas are generated once from their Zod source
 * at startup, without a second checked-in JSON copy; both paths are covered by
 * the public-schema registry census and byte-parity tests.
 */

/// <reference path="./assets.d.ts" />

import citationsSchemaModule from "../generated/citations.schema.json" with { type: "text" };
import conflictsSchemaModule from "../generated/conflicts.schema.json" with { type: "text" };

import deadEndsSchemaModule from "../generated/dead-ends.schema.json" with { type: "text" };
import discoverySchemaModule from "../generated/discovery.schema.json" with { type: "text" };
import enrollmentSchemaModule from "../generated/enrollment.schema.json" with { type: "text" };
import enrollmentCapsuleSchemaModule from "../generated/enrollment-capsule.schema.json" with {
  type: "text",
};
import eventTailSchemaModule from "../generated/event-tail.schema.json" with { type: "text" };
import inboxSchemaModule from "../generated/inbox.schema.json" with { type: "text" };
import internalHealthSchemaModule from "../generated/internal-health.schema.json" with {
  type: "text",
};
import ledgerSchemaModule from "../generated/ledger.schema.json" with { type: "text" };
import movesSchemaModule from "../generated/moves.schema.json" with { type: "text" };
import problemSchemaModule from "../generated/problem.schema.json" with { type: "text" };
import problemsSchemaModule from "../generated/problems.schema.json" with { type: "text" };
import questionsSchemaModule from "../generated/questions.schema.json" with { type: "text" };
import retractionsSchemaModule from "../generated/retractions.schema.json" with { type: "text" };
import reviewQueueSchemaModule from "../generated/review-queue.schema.json" with { type: "text" };
import rubricsSchemaModule from "../generated/rubrics.schema.json" with { type: "text" };
import screeningSchemaModule from "../generated/screening.schema.json" with { type: "text" };
import sessionsSchemaModule from "../generated/sessions.schema.json" with { type: "text" };
import synthesesSchemaModule from "../generated/syntheses.schema.json" with { type: "text" };
import { generateHypothesesSchema } from "./hypotheses-schema.ts";
import { generateProofGapsSchema } from "./proof-gaps-schema.ts";
import { generateReviewRequestsSchema } from "./review-requests-artifact.ts";

/** Deliberate, closed inventory of source-generated schemas without file copies. */
export const INLINE_PUBLIC_SCHEMA_IDS = Object.freeze([
  "hypotheses",
  "proof-gaps",
  "review-requests",
] as const);

export const PUBLIC_SCHEMA_IDS = Object.freeze([
  "citations",
  "conflicts",
  "dead-ends",

  "discovery",
  "enrollment",
  "enrollment-capsule",
  "event-tail",
  "hypotheses",
  "inbox",
  "internal-health",
  "ledger",
  "moves",
  "problem",
  "problems",
  "proof-gaps",
  "questions",
  "retractions",
  "review-queue",
  "review-requests",
  "rubrics",
  "screening",
  "sessions",
  "syntheses",
] as const);

/**
 * Generated schemas that intentionally have no public agent face.
 *
 * Keep an explicit reason beside every exclusion. The unit contract test reads
 * the checked-in generated directory and requires it to be partitioned by this
 * list plus the file-backed served registry. Inline schemas are separately
 * pinned to the closed inventory above and their canonical generator.
 */
export const PUBLIC_SCHEMA_EXCLUSIONS = Object.freeze([
  Object.freeze({
    id: "batch",
    reason: "Batch planning contract; it has no separate public read face.",
  }),
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
    id: "citations",
    served_at: "/schemas/citations.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(citationsSchemaModule, "generated/citations.schema.json"),
  }),
  Object.freeze({
    id: "conflicts",

    served_at: "/schemas/conflicts.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(conflictsSchemaModule, "generated/conflicts.schema.json"),
  }),
  Object.freeze({
    id: "dead-ends",
    served_at: "/schemas/dead-ends.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(deadEndsSchemaModule, "generated/dead-ends.schema.json"),
  }),
  Object.freeze({
    id: "discovery",
    served_at: "/schemas/discovery.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(discoverySchemaModule, "generated/discovery.schema.json"),
  }),
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
    id: "event-tail",
    served_at: "/schemas/event-tail.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(eventTailSchemaModule, "generated/event-tail.schema.json"),
  }),
  Object.freeze({
    id: "hypotheses",
    served_at: "/schemas/hypotheses.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateHypothesesSchema(),
  }),
  Object.freeze({
    id: "inbox",
    served_at: "/schemas/inbox.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(inboxSchemaModule, "generated/inbox.schema.json"),
  }),
  Object.freeze({
    id: "internal-health",
    served_at: "/schemas/internal.health.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(internalHealthSchemaModule, "generated/internal-health.schema.json"),
  }),
  Object.freeze({
    id: "ledger",
    served_at: "/schemas/ledger.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(ledgerSchemaModule, "generated/ledger.schema.json"),
  }),
  Object.freeze({
    id: "moves",
    served_at: "/schemas/moves.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(movesSchemaModule, "generated/moves.schema.json"),
  }),
  Object.freeze({
    id: "problem",
    served_at: "/schemas/problem.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(problemSchemaModule, "generated/problem.schema.json"),
  }),
  Object.freeze({
    id: "problems",
    served_at: "/schemas/problems.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(problemsSchemaModule, "generated/problems.schema.json"),
  }),
  Object.freeze({
    id: "proof-gaps",
    served_at: "/schemas/proof-gaps.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateProofGapsSchema(),
  }),
  Object.freeze({
    id: "questions",
    served_at: "/schemas/questions.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(questionsSchemaModule, "generated/questions.schema.json"),
  }),
  Object.freeze({
    id: "retractions",
    served_at: "/schemas/retractions.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(retractionsSchemaModule, "generated/retractions.schema.json"),
  }),
  Object.freeze({
    id: "review-queue",
    served_at: "/schemas/review-queue.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(reviewQueueSchemaModule, "generated/review-queue.schema.json"),
  }),
  Object.freeze({
    id: "review-requests",
    served_at: "/schemas/review-requests.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateReviewRequestsSchema(),
  }),
  Object.freeze({
    id: "rubrics",
    served_at: "/schemas/rubrics.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(rubricsSchemaModule, "generated/rubrics.schema.json"),
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
  Object.freeze({
    id: "syntheses",
    served_at: "/schemas/syntheses.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: exactTextModule(synthesesSchemaModule, "generated/syntheses.schema.json"),
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
