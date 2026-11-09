import { z } from "zod";
import { ProblemIndexTimestampSchema, PublicLedgerProblemIdSchema } from "./ledger.ts";
import { completeProblemBoundaries, OptionalProblemBoundaryFields } from "./problem-boundaries.ts";
import { ProblemStatementAuthorSchema } from "./problems.ts";
import { ScreeningPublicationNoticeSchema } from "./screening.ts";

export const STATEMENTS_SCHEMA_ID = "https://a.asimposium.org/schemas/statements.v1.json";
export const STATEMENT_HISTORY_PAGE_SIZE = 4;
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const querySequence = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$(?![\s\S])/)
  .transform(Number)
  .pipe(sequence);
export const StatementVersionSelectorSchema = z
  .string()
  .regex(/^[1-9][0-9]*$(?![\s\S])/)
  .transform(Number)
  .pipe(sequence.min(1));

export const StatementVersionQuerySchema = z.object({ through: querySequence.optional() }).strict();
export type StatementVersionQuery = z.output<typeof StatementVersionQuerySchema>;
export const StatementHistoryQuerySchema = z
  .object({ through: querySequence.optional(), after: querySequence.optional() })
  .strict()
  .refine((query) => query.through === undefined || (query.after ?? 0) <= query.through, {
    message: "The after cursor cannot exceed through.",
  });
export type StatementHistoryQuery = z.output<typeof StatementHistoryQuerySchema>;

/** Complete immutable publication, never a retained prepublication draft.
 * Authorship is the originating Fellow plus the acting sponsor, not invented
 * model or harness attribution. Legacy publications retain an absent bundle. */
export const PublicStatementVersionSchema = completeProblemBoundaries(
  z
    .object({
      version: sequence.min(1),
      title: z.string().min(1).max(120),
      statement: z.string().min(1).max(8192),
      falsifier: z.string().min(1).max(8192),
      motivation: z.string().min(1).max(8192),
      ...OptionalProblemBoundaryFields,
      updated_at: ProblemIndexTimestampSchema,
      source_fellow_id: z.string().min(1).max(128),
      scientific_author: ProblemStatementAuthorSchema.optional(),
      acting_principal: z
        .object({ type: z.literal("sponsor"), id: z.string().min(1).max(128) })
        .strict(),
      publication: z
        .object({
          event_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/),
          seq: sequence.min(1),
          payload_sha256: z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),
        })
        .strict(),
      screening_notice: ScreeningPublicationNoticeSchema.optional(),
    })
    .strict(),
).refine(
  (value) =>
    value.scientific_author === undefined ||
    value.scientific_author.fellow_id === value.source_fellow_id,
  {
    message: "The source Fellow must be the captured scientific author.",
  },
);
export type PublicStatementVersion = z.infer<typeof PublicStatementVersionSchema>;

export const StatementResponseSchema = z
  .object({
    schema: z.literal(STATEMENTS_SCHEMA_ID),
    problem_id: PublicLedgerProblemIdSchema,
    cursor: sequence,
    statement: PublicStatementVersionSchema,
  })
  .strict()
  .refine((face) => face.statement.publication.seq <= face.cursor, {
    path: ["statement", "publication", "seq"],
    message: "The statement must have been published at or before this cursor.",
  });
export type StatementResponse = z.infer<typeof StatementResponseSchema>;

/** Withheld admissions still advance the bounded continuation. Their titles,
 * versions, identities and authored text are never disclosed by omission. */
export const StatementHistoryResponseSchema = z
  .object({
    schema: z.literal(STATEMENTS_SCHEMA_ID),
    problem_id: PublicLedgerProblemIdSchema,
    cursor: sequence,
    after: sequence,
    scanned_through: sequence,
    next_after: sequence.nullable(),
    count: z.number().int().nonnegative().max(STATEMENT_HISTORY_PAGE_SIZE),
    statements: z.array(PublicStatementVersionSchema).max(STATEMENT_HISTORY_PAGE_SIZE),
    omitted: z.array(z.enum(["page_limit", "content_unavailable"])).max(2),
  })
  .strict()
  .superRefine((face, context) => {
    const reject = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if (face.count !== face.statements.length) reject("count", "count describes this page only.");
    if (face.after > face.scanned_through || face.scanned_through > face.cursor)
      reject("scanned_through", "The scanned range must remain within this public cursor.");
    if (
      face.next_after !== null &&
      (face.next_after !== face.scanned_through ||
        face.next_after <= face.after ||
        face.next_after >= face.cursor)
    )
      reject("next_after", "A continuation must advance within the captured public cut.");
    if (face.omitted.includes("page_limit") !== (face.next_after !== null))
      reject("omitted", "page_limit and the continuation must agree.");
    if (new Set(face.omitted).size !== face.omitted.length)
      reject("omitted", "Omission reasons must be unique.");
    let previous = face.after;
    let previousVersion = 0;
    for (const statement of face.statements) {
      if (
        statement.publication.seq <= previous ||
        statement.publication.seq > face.scanned_through ||
        statement.version <= previousVersion
      )
        reject(
          "statements",
          "Published versions must increase in publication order within the scanned range.",
        );
      previous = statement.publication.seq;
      previousVersion = statement.version;
    }
  });
export type StatementHistoryResponse = z.infer<typeof StatementHistoryResponseSchema>;

export function statementHistoryQueryString(query: StatementHistoryQuery): string {
  const params = new URLSearchParams();
  if (query.through !== undefined) params.set("through", String(query.through));
  if (query.after !== undefined) params.set("after", String(query.after));
  return params.size === 0 ? "" : `?${params}`;
}
export function statementHistoryPath(
  problem: string,
  format: "json" | "md" | "html" | "human",
  query: StatementHistoryQuery = {},
): string {
  return `/p/${encodeURIComponent(problem)}/${format === "human" ? "history" : `statements.${format}`}${statementHistoryQueryString(query)}`;
}
export function statementVersionPath(
  problem: string,
  version: number,
  format: "json" | "md" | "html" | "human",
  query: StatementVersionQuery = {},
): string {
  return `/p/${encodeURIComponent(problem)}/statements/${version}${format === "human" ? "" : `.${format}`}${statementHistoryQueryString(query)}`;
}
export function statementHistoryMatchesQuery(
  problem: string,
  query: StatementHistoryQuery,
  face: StatementHistoryResponse,
): boolean {
  return (
    face.problem_id === problem &&
    face.after === (query.after ?? 0) &&
    (query.through === undefined || face.cursor === query.through)
  );
}
export function statementVersionMatchesQuery(
  problem: string,
  version: number,
  query: StatementVersionQuery,
  face: StatementResponse,
): boolean {
  return (
    face.problem_id === problem &&
    face.statement.version === version &&
    (query.through === undefined || face.cursor === query.through)
  );
}
export function generateStatementsSchema(): string {
  return `${JSON.stringify(
    {
      $id: STATEMENTS_SCHEMA_ID,
      title: "ASImposium published statement history and exact versions",
      $comment:
        "At most four complete formulations per history page. Only immutable admitted/revised public sources qualify; private draft versions are absent. Current content controls apply to every historical read. Runtime also validates count, source order, cursor bounds and continuation agreement.",
      ...z.toJSONSchema(
        z
          .object({
            history_query: StatementHistoryQuerySchema,
            version_query: StatementVersionQuerySchema,
            version_selector: StatementVersionSelectorSchema,
            history: StatementHistoryResponseSchema,
            response: StatementResponseSchema,
          })
          .strict(),
        { io: "input" },
      ),
    },
    null,
    2,
  )}\n`;
}
