import { z } from "zod";
import {
  EVENT_TAIL_CURSOR_PATTERN,
  EVENT_TAIL_ID_PATTERN,
  EVENT_TAIL_MAX_EVENTS,
  EVENT_TAIL_PROBLEM_PATTERN,
  EVENT_TAIL_SCHEMA_ID,
  eventTailCursor,
  eventTailPath,
} from "./event-tail-model.ts";

export * from "./event-tail-model.ts";

const CursorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const IdSchema = z.string().regex(EVENT_TAIL_ID_PATTERN);
const ProblemSchema = z.string().regex(EVENT_TAIL_PROBLEM_PATTERN);
const CursorTextSchema = z
  .string()
  .regex(EVENT_TAIL_CURSOR_PATTERN)
  .refine((value) => eventTailCursor(value) !== undefined, "cursor must be an exact safe integer");
const TimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const PathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^\/p\/[^\s?#]+\/(?:events\.(?:json|ndjson)|claims\/[^\s?#]+\.json|citations\/[^\s?#]+\.json|syntheses\/[^\s?#]+\.json|(?:dead-ends|questions|conflicts|retractions)\.json)(?:\?[^\s#]*)?$/,
  );

export const EventTailQuerySchema = z
  .object({
    since: CursorTextSchema.optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/)
      .optional(),
    through: CursorTextSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.through !== undefined && Number(query.through) < Number(query.since ?? 0))
      context.addIssue({
        code: "custom",
        path: ["through"],
        message: "through cannot precede since",
      });
  });

/** A sequence-only envelope is deliberately unable to contain private identifiers or bodies. */
export const PublicEventEnvelopeSchema = z
  .object({
    record: z.literal("event"),
    problem_id: ProblemSchema,
    seq: CursorSchema.min(1),
    event: z
      .object({
        id: IdSchema,
        type: z
          .string()
          .max(96)
          .regex(/^[a-z][a-z0-9._-]*$/),
        object_kind: z
          .string()
          .max(32)
          .regex(/^[a-z][a-z0-9-]*$/),
        object_id: IdSchema,
        object_version: CursorSchema.min(1),
        created_at: TimestampSchema,
        payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        actor: z
          .object({
            fellow_id: IdSchema.nullable(),
            sponsor_id: IdSchema.nullable(),
            session_id: IdSchema.nullable(),
            model_self_declared: z.string().max(256).nullable(),
            harness_self_declared: z.string().max(256).nullable(),
          })
          .strict(),
        object_url: PathSchema.nullable(),
      })
      .strict()
      .nullable(),
    body_omitted: z.enum(["separate_object_face", "content_unavailable", "undisclosed_event"]),
  })
  .strict()
  .superRefine((entry, context) => {
    if ((entry.event === null) !== (entry.body_omitted === "undisclosed_event"))
      context.addIssue({
        code: "custom",
        message: "undisclosed entries must contain only their sequence",
      });
  });

export const EventTailPageEndSchema = z
  .object({
    control: z.literal("page_end"),
    schema: z.literal(EVENT_TAIL_SCHEMA_ID),
    problem_id: ProblemSchema,
    since: CursorSchema,
    through: CursorSchema,
    next_cursor: CursorSchema,
    has_more: z.boolean(),
    next: PathSchema.nullable(),
    poll: PathSchema,
  })
  .strict();

export const EventTailResponseSchema = z
  .object({
    schema: z.literal(EVENT_TAIL_SCHEMA_ID),
    events: z.array(PublicEventEnvelopeSchema).max(EVENT_TAIL_MAX_EVENTS),
    page_end: EventTailPageEndSchema,
    omitted: z.array(z.string().min(1).max(240)).max(8),
  })
  .strict()
  .superRefine((page, context) => {
    const end = page.page_end;
    if (
      end.since > end.next_cursor ||
      end.next_cursor > end.through ||
      end.next_cursor !== end.since + page.events.length ||
      end.has_more !== end.next_cursor < end.through ||
      (end.next !== null) !== end.has_more ||
      (end.has_more && page.events.length === 0) ||
      page.events.some(
        (entry, index) =>
          entry.seq !== end.since + index + 1 || entry.problem_id !== end.problem_id,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "page must preserve its complete scanned sequence and resume cursor",
      });
    }
    // All continuation links are server-authored canonical requests, never caller prose.
    for (const [key, link] of [
      ["next", end.next],
      ["poll", end.poll],
    ] as const) {
      if (link === null) continue;
      const query = new URL(link, "https://a.asimposium.org").searchParams;
      const limit = Number(query.get("limit"));
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > EVENT_TAIL_MAX_EVENTS ||
        link !==
          eventTailPath(end.problem_id, "json", {
            since: end.next_cursor,
            limit,
            ...(key === "next" ? { through: end.through } : {}),
          })
      )
        context.addIssue({
          code: "custom",
          path: ["page_end", key],
          message: "invalid resume link",
        });
    }
  });

export const EventTailNdjsonPageEndSchema = EventTailPageEndSchema.extend({
  omitted: z.array(z.string().min(1).max(240)).max(8),
});

/** NDJSON is a sequence of event records and exactly one final page_end record. */
export const EventTailContractsSchema = z
  .object({
    query: EventTailQuerySchema,
    response: EventTailResponseSchema,
    ndjson_event: PublicEventEnvelopeSchema,
    ndjson_page_end: EventTailNdjsonPageEndSchema,
  })
  .strict();
