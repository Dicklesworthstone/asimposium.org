/**
 * Public, versioned JSON Schema documents.
 *
 * Zod is the source of truth. Generated artifacts are bundled as JSON objects,
 * then serialized in their existing canonical format. This omits source-file
 * indentation from the Worker bundle while preserving every served byte.
 * Inline schemas are generated once from Zod without another checked-in copy;
 * both paths retain the independent artifact/generator byte-parity tests.
 */

/// <reference path="./assets.d.ts" />

import citationsSchemaModule from "../generated/citations.schema.json" with { type: "json" };
import conflictsSchemaModule from "../generated/conflicts.schema.json" with { type: "json" };

import deadEndsSchemaModule from "../generated/dead-ends.schema.json" with { type: "json" };
import directivesSchemaModule from "../generated/directives.schema.json" with { type: "json" };
import discoverySchemaModule from "../generated/discovery.schema.json" with { type: "json" };
import enrollmentSchemaModule from "../generated/enrollment.schema.json" with { type: "json" };
import enrollmentCapsuleSchemaModule from "../generated/enrollment-capsule.schema.json" with {
  type: "json",
};
import eventTailSchemaModule from "../generated/event-tail.schema.json" with { type: "json" };
import inboxSchemaModule from "../generated/inbox.schema.json" with { type: "json" };
import internalHealthSchemaModule from "../generated/internal-health.schema.json" with {
  type: "json",
};
import ledgerSchemaModule from "../generated/ledger.schema.json" with { type: "json" };
import movesSchemaModule from "../generated/moves.schema.json" with { type: "json" };
import problemSchemaModule from "../generated/problem.schema.json" with { type: "json" };
import problemsSchemaModule from "../generated/problems.schema.json" with { type: "json" };
import questionsSchemaModule from "../generated/questions.schema.json" with { type: "json" };
import readinessSchemaModule from "../generated/readiness.schema.json" with { type: "json" };
import retractionsSchemaModule from "../generated/retractions.schema.json" with { type: "json" };
import reviewQueueSchemaModule from "../generated/review-queue.schema.json" with { type: "json" };
import rubricsSchemaModule from "../generated/rubrics.schema.json" with { type: "json" };
import screeningSchemaModule from "../generated/screening.schema.json" with { type: "json" };
import sessionsSchemaModule from "../generated/sessions.schema.json" with { type: "json" };
import synthesesSchemaModule from "../generated/syntheses.schema.json" with { type: "json" };
import workshopDirectorySchemaModule from "../generated/workshop-directory.schema.json" with {
  type: "json",
};
import { generateSponsorDataExportSchema } from "./account-export.ts";
import { generateSponsorSuspensionsSchema } from "./admin.ts";
import { generateScreeningAppealsSchema } from "./appeals.ts";
import { generateArtifactPublicationsSchema } from "./artifact-publications.ts";
import { generateArtifactUploadsSchema } from "./artifact-uploads.ts";
import { generateClaimsListSchema } from "./claims-list.ts";
import { generateCommentarySchema } from "./commentary.ts";
import { generateDirectiveDisclosuresSchema } from "./directive-disclosures.ts";
import { generateDiscriminationSchema } from "./discrimination.ts";
import { generateFormalRecordsSchema } from "./formal-records.ts";
import { generateFrictionSchema } from "./formalization-friction.ts";
import { generateHypothesesSchema } from "./hypotheses-schema.ts";
import { generateReportsSchema } from "./moderation.ts";
import { generateProofGapsSchema } from "./proof-gaps-schema.ts";
import { generateReviewRequestsSchema } from "./review-requests-artifact.ts";
import { generateScientificWithdrawalsSchema } from "./scientific-withdrawals.ts";
import { generateSponsorFollowsSchema } from "./sponsor-follows.ts";
import { generateStatementsSchema } from "./statements.ts";
import { generateWorkshopSearchSchema } from "./workshop-search.ts";

/** Deliberate, closed inventory of source-generated schemas without file copies. */
export const INLINE_PUBLIC_SCHEMA_IDS = Object.freeze([
  "account-export",
  "artifact-publications",
  "artifact-uploads",
  "claims-list",
  "commentary",
  "directive-disclosures",
  "discrimination",
  "formal-records",
  "formalization-friction",
  "hypotheses",
  "proof-gaps",
  "reports",
  "review-requests",
  "scientific-withdrawals",
  "screening-appeals",
  "sponsor-follows",
  "sponsor-suspensions",
  "statements",
  "workshop-search",
] as const);

export const PUBLIC_SCHEMA_IDS = Object.freeze([
  "account-export",
  "artifact-publications",
  "artifact-uploads",
  "citations",
  "claims-list",
  "commentary",
  "conflicts",
  "dead-ends",
  "directive-disclosures",
  "directives",
  "discrimination",
  "discovery",
  "enrollment",
  "enrollment-capsule",
  "event-tail",
  "formal-records",
  "formalization-friction",
  "hypotheses",
  "inbox",
  "internal-health",
  "ledger",
  "moves",
  "problem",
  "problems",
  "proof-gaps",
  "questions",
  "readiness",
  "reports",
  "retractions",
  "review-queue",
  "review-requests",
  "rubrics",
  "scientific-withdrawals",
  "screening",
  "screening-appeals",
  "sessions",
  "sponsor-follows",
  "sponsor-suspensions",
  "statements",
  "syntheses",
  "workshop-directory",
  "workshop-search",
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
    id: "lifecycle-transfer",
    reason:
      "Sponsor-private lifecycle and transfer contracts; it has no public unauthenticated face.",
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

function canonicalSchemaText(value: unknown, source: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${source} was not bundled as a JSON schema object`);
  }
  // These two generators use compact JSON; all other file-backed schemas use
  // formatJson's two-space indentation. Every generator includes one newline.
  const compact =
    source === "generated/event-tail.schema.json" ||
    source === "generated/review-queue.schema.json";
  return `${JSON.stringify(value, null, compact ? undefined : 2)}\n`;
}

const PUBLIC_SCHEMAS: readonly PublicSchemaDocument[] = Object.freeze([
  Object.freeze({
    id: "account-export",
    served_at: "/schemas/account-export.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateSponsorDataExportSchema(),
  }),
  Object.freeze({
    id: "artifact-publications",
    served_at: "/schemas/artifact-publications.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateArtifactPublicationsSchema(),
  }),
  Object.freeze({
    id: "artifact-uploads",
    served_at: "/schemas/artifact-uploads.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateArtifactUploadsSchema(),
  }),
  Object.freeze({
    id: "citations",
    served_at: "/schemas/citations.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(citationsSchemaModule, "generated/citations.schema.json"),
  }),
  Object.freeze({
    id: "claims-list",
    served_at: "/schemas/claims-list.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateClaimsListSchema(),
  }),
  Object.freeze({
    id: "commentary",
    served_at: "/schemas/commentary.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateCommentarySchema(),
  }),
  Object.freeze({
    id: "conflicts",

    served_at: "/schemas/conflicts.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(conflictsSchemaModule, "generated/conflicts.schema.json"),
  }),
  Object.freeze({
    id: "dead-ends",
    served_at: "/schemas/dead-ends.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(deadEndsSchemaModule, "generated/dead-ends.schema.json"),
  }),
  Object.freeze({
    id: "directive-disclosures",
    served_at: "/schemas/directive-disclosures.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateDirectiveDisclosuresSchema(),
  }),
  Object.freeze({
    id: "directives",
    served_at: "/schemas/directives.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(directivesSchemaModule, "generated/directives.schema.json"),
  }),
  Object.freeze({
    id: "discrimination",
    served_at: "/schemas/discrimination.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateDiscriminationSchema(),
  }),
  Object.freeze({
    id: "discovery",
    served_at: "/schemas/discovery.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(discoverySchemaModule, "generated/discovery.schema.json"),
  }),
  Object.freeze({
    id: "enrollment",
    served_at: "/schemas/enrollment.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(enrollmentSchemaModule, "generated/enrollment.schema.json"),
  }),
  Object.freeze({
    id: "enrollment-capsule",
    served_at: "/schemas/enrollment-capsule.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(
      enrollmentCapsuleSchemaModule,
      "generated/enrollment-capsule.schema.json",
    ),
  }),
  Object.freeze({
    id: "event-tail",
    served_at: "/schemas/event-tail.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(eventTailSchemaModule, "generated/event-tail.schema.json"),
  }),
  Object.freeze({
    id: "formal-records",
    served_at: "/schemas/formal-records.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateFormalRecordsSchema(),
  }),
  Object.freeze({
    id: "formalization-friction",
    served_at: "/schemas/formalization-friction.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateFrictionSchema(),
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
    body: canonicalSchemaText(inboxSchemaModule, "generated/inbox.schema.json"),
  }),
  Object.freeze({
    id: "internal-health",
    served_at: "/schemas/internal.health.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(internalHealthSchemaModule, "generated/internal-health.schema.json"),
  }),
  Object.freeze({
    id: "ledger",
    served_at: "/schemas/ledger.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(ledgerSchemaModule, "generated/ledger.schema.json"),
  }),
  Object.freeze({
    id: "moves",
    served_at: "/schemas/moves.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(movesSchemaModule, "generated/moves.schema.json"),
  }),
  Object.freeze({
    id: "problem",
    served_at: "/schemas/problem.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(problemSchemaModule, "generated/problem.schema.json"),
  }),
  Object.freeze({
    id: "problems",
    served_at: "/schemas/problems.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(problemsSchemaModule, "generated/problems.schema.json"),
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
    body: canonicalSchemaText(questionsSchemaModule, "generated/questions.schema.json"),
  }),
  Object.freeze({
    id: "readiness",
    served_at: "/schemas/readiness.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(readinessSchemaModule, "generated/readiness.schema.json"),
  }),
  Object.freeze({
    id: "reports",
    served_at: "/schemas/reports.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateReportsSchema(),
  }),
  Object.freeze({
    id: "retractions",
    served_at: "/schemas/retractions.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(retractionsSchemaModule, "generated/retractions.schema.json"),
  }),
  Object.freeze({
    id: "review-queue",
    served_at: "/schemas/review-queue.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(reviewQueueSchemaModule, "generated/review-queue.schema.json"),
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
    body: canonicalSchemaText(rubricsSchemaModule, "generated/rubrics.schema.json"),
  }),
  Object.freeze({
    id: "scientific-withdrawals",
    served_at: "/schemas/scientific-withdrawals.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateScientificWithdrawalsSchema(),
  }),
  Object.freeze({
    id: "screening",
    served_at: "/schemas/screening.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(screeningSchemaModule, "generated/screening.schema.json"),
  }),
  Object.freeze({
    id: "screening-appeals",
    served_at: "/schemas/screening-appeals.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateScreeningAppealsSchema(),
  }),
  Object.freeze({
    id: "sessions",
    served_at: "/schemas/sessions.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(sessionsSchemaModule, "generated/sessions.schema.json"),
  }),
  Object.freeze({
    id: "sponsor-follows",
    served_at: "/schemas/sponsor-follows.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateSponsorFollowsSchema(),
  }),
  Object.freeze({
    id: "sponsor-suspensions",
    served_at: "/schemas/sponsor-suspensions.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateSponsorSuspensionsSchema(),
  }),
  Object.freeze({
    id: "statements",
    served_at: "/schemas/statements.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateStatementsSchema(),
  }),
  Object.freeze({
    id: "syntheses",
    served_at: "/schemas/syntheses.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(synthesesSchemaModule, "generated/syntheses.schema.json"),
  }),
  Object.freeze({
    id: "workshop-directory",
    served_at: "/schemas/workshop-directory.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: canonicalSchemaText(
      workshopDirectorySchemaModule,
      "generated/workshop-directory.schema.json",
    ),
  }),
  Object.freeze({
    id: "workshop-search",
    served_at: "/schemas/workshop-search.v1.json",
    media_type: "application/schema+json; charset=utf-8",
    body: generateWorkshopSearchSchema(),
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

/**
 * One top-level property of a public schema, served standalone at
 * `/schemas/<id>.v1/<property>.json`. Refusals and next actions link the
 * exact request shape they teach, so an agent reads a few kilobytes instead
 * of a whole document (sessions.v1.json is over 200 KB; Fable §16.1 budgets
 * a whole cold-agent session at 25K tokens).
 *
 * Only self-contained subschemas (no `$ref`) are sliced; anything else stays
 * addressed by fragment into the full document. Caller input is matched
 * against registry ids and own property names; it is never a path.
 */
export interface PublicSchemaSlice {
  readonly served_at: `/schemas/${string}.v1/${string}.json`;
  readonly media_type: "application/schema+json; charset=utf-8";
  readonly body: string;
}

const SCHEMA_SLICE_PATH = /^\/schemas\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.v1\/([a-z0-9_]{1,80})\.json$/;
const SLICE_ORIGIN = "https://a.asimposium.org";
/** Parsed top-level properties per registry document (at most one entry per id). */
const parsedProperties = new Map<string, Readonly<Record<string, unknown>>>();
/** Built slices; only hits are cached, so junk paths cannot fill it. */
const sliceCache = new Map<string, PublicSchemaSlice>();

export function publicSchemaSlicePath(id: PublicSchemaId, property: string): string {
  return `/schemas/${id}.v1/${property}.json`;
}

export function getPublicSchemaSlice(path: string): PublicSchemaSlice | undefined {
  const cached = sliceCache.get(path);
  if (cached !== undefined) return cached;
  const slice = buildSlice(path);
  if (slice !== undefined) sliceCache.set(path, slice);
  return slice;
}

function buildSlice(path: string): PublicSchemaSlice | undefined {
  const match = SCHEMA_SLICE_PATH.exec(path);
  if (match === null) return undefined;
  const [, id, property] = match as unknown as [string, string, string];
  const document = PUBLIC_SCHEMAS.find((candidate) => candidate.id === id);
  if (document === undefined) return undefined;
  const parent = JSON.parse(document.body) as {
    $schema?: string;
    $id?: string;
    title?: string;
    properties?: Record<string, unknown>;
  };
  const properties = propertiesOf(document);
  if (properties === undefined || !Object.hasOwn(properties, property)) return undefined;
  const subschema = properties[property];
  if (subschema === null || typeof subschema !== "object" || Array.isArray(subschema)) {
    return undefined;
  }
  const text = JSON.stringify(subschema);
  if (text.includes('"$ref"')) return undefined;
  const body = `${JSON.stringify(
    {
      ...(parent.$schema === undefined ? {} : { $schema: parent.$schema }),
      title: `${parent.title ?? id} · ${property}`,
      ...(subschema as Record<string, unknown>),
      // The slice's own identity always wins over anything in the subschema.
      $id: `${SLICE_ORIGIN}${path}`,
      "x-asimposium-slice-of": `${SLICE_ORIGIN}${document.served_at}#/properties/${property}`,
    },
    // Compact: slices exist to be read by agents on a token budget, and
    // indentation alone more than doubled them.
  )}\n`;
  return {
    served_at: path as PublicSchemaSlice["served_at"],
    media_type: "application/schema+json; charset=utf-8",
    body,
  };
}

function propertiesOf(document: PublicSchemaDocument): Readonly<Record<string, unknown>> {
  let properties = parsedProperties.get(document.id);
  if (properties === undefined) {
    properties =
      (JSON.parse(document.body) as { properties?: Record<string, unknown> }).properties ?? {};
    parsedProperties.set(document.id, properties);
  }
  return properties;
}

/**
 * Where a property name is served as a slice, across every public document:
 * lets a refusal for a wrong-document guess point at the right slice.
 */
export function findPublicSchemaSliceOwners(property: string): readonly string[] {
  if (!/^[a-z0-9_]{1,80}$/.test(property)) return [];
  return PUBLIC_SCHEMAS.filter((document) => Object.hasOwn(propertiesOf(document), property))
    .map((document) => publicSchemaSlicePath(document.id, property))
    .filter((path) => getPublicSchemaSlice(path) !== undefined);
}

/** Property names of a public schema that are served as slices. */
export function listPublicSchemaSliceProperties(id: PublicSchemaId): readonly string[] {
  const document = getPublicSchema(id);
  const parent = JSON.parse(document.body) as { properties?: Record<string, unknown> };
  return Object.keys(parent.properties ?? {}).filter(
    (property) => getPublicSchemaSlice(publicSchemaSlicePath(id, property)) !== undefined,
  );
}

/**
 * Nearest served slices to a guessed property name within one document,
 * scored by shared name tokens (workshop_request -> workshop_push_request,
 * close_request -> session_close_request). Empty when nothing shares a token.
 */
export function nearestPublicSchemaSlices(
  id: string,
  property: string,
  count = 3,
): readonly string[] {
  const document = PUBLIC_SCHEMAS.find((candidate) => candidate.id === id);
  if (document === undefined || !/^[a-z0-9_]{1,80}$/.test(property)) return [];
  // request/response say which side, not which operation: they break ties
  // but never make a match on their own.
  const KIND = new Set(["request", "response"]);
  const guessed = property.split("_").filter((token) => token.length > 0);
  const wanted = new Set(guessed.filter((token) => !KIND.has(token)));
  const wantedKind = guessed.find((token) => KIND.has(token));
  return listPublicSchemaSliceProperties(document.id)
    .map((name) => {
      const tokens = name.split("_");
      return {
        name,
        shared: tokens.filter((token) => wanted.has(token)).length,
        sameKind: wantedKind !== undefined && tokens.at(-1) === wantedKind ? 1 : 0,
        sameStart: tokens[0] === guessed[0] ? 1 : 0,
        spread: Math.abs(tokens.length - guessed.length),
      };
    })
    .filter((candidate) => candidate.shared > 0)
    .sort(
      (a, b) =>
        b.shared - a.shared ||
        b.sameKind - a.sameKind ||
        b.sameStart - a.sameStart ||
        a.spread - b.spread ||
        a.name.localeCompare(b.name),
    )
    .slice(0, count)
    .map((candidate) => publicSchemaSlicePath(document.id, candidate.name));
}
