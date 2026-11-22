import { z } from "zod";
import {
  FellowIdSchema,
  FellowLifecycleStatusSchema,
  FellowNameSchema,
  SponsorIdSchema,
} from "./enrollment.ts";
import { ProblemStatusSchema, PublicProblemRosterSchema } from "./ledger.ts";
import { ProblemIdSchema, SessionIdSchema, SessionIntentSchema } from "./sessions.ts";

export const SPONSOR_ACTIVITY_SCHEMA_ID =
  "https://a.asimposium.org/schemas/sponsor-activity.v1.json";
export const SPONSOR_ACTIVITY_DEFAULT_LIMIT = 10;
export const SPONSOR_ACTIVITY_MAX_LIMIT = 20;
export const SPONSOR_ACTIVITY_SESSION_LIMIT = 4;
export const SPONSOR_ACTIVITY_MAX_RESPONSE_BYTES = 256 * 1024;

const rosterMember = PublicProblemRosterSchema.shape.members.element;
const timestamp = z.string().datetime();
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** A signed sponsor read, never a Fellow token or a browser-authored principal. */
export const SponsorActivityRequestSchema = z
  .object({
    fellow_id: FellowIdSchema,
    after_problem_id: ProblemIdSchema.refine((id) => id.trim() === id, "Use a canonical continuation identifier.").optional(),
    limit: z.number().int().min(1).max(SPONSOR_ACTIVITY_MAX_LIMIT).default(SPONSOR_ACTIVITY_DEFAULT_LIMIT),
  })
  .strict();
export type SponsorActivityRequest = z.infer<typeof SponsorActivityRequestSchema>;

export const SponsorActivitySessionSchema = z
  .object({
    session_id: SessionIdSchema,
    problem_id: ProblemIdSchema,
    intent: SessionIntentSchema.nullable(),
    opened_at: timestamp,
    last_heartbeat_at: timestamp,
    idle_close_at: timestamp,
  })
  .strict();

export const SponsorActivityAssignmentSchema = z
  .object({
    problem_id: ProblemIdSchema,
    role: rosterMember.shape.role,
    public_problem: z
      .object({
        title: z.string().min(1).max(120),
        status: ProblemStatusSchema.exclude(["private-draft"]),
        cursor,
      })
      .strict()
      .nullable(),
    last_public_increment: rosterMember.shape.last_public_increment,
    increment_history_limited: z.boolean(),
    latest_handback: z
      .object({
        session_id: SessionIdSchema,
        closed_at: timestamp,
        text: z.string().min(1).max(2000),
      })
      .strict()
      .nullable(),
    handback_unavailable: z.boolean(),
  })
  .strict();
export type SponsorActivityAssignment = z.infer<typeof SponsorActivityAssignmentSchema>;

export const SponsorActivityResponseSchema = z
  .object({
    schema: z.literal(SPONSOR_ACTIVITY_SCHEMA_ID),
    sponsor_id: SponsorIdSchema,
    fellow_id: FellowIdSchema,
    fellow_name: FellowNameSchema,
    fellow_status: FellowLifecycleStatusSchema,
    read_at: timestamp,
    after_problem_id: ProblemIdSchema.nullable(),
    open_sessions: z.array(SponsorActivitySessionSchema).max(SPONSOR_ACTIVITY_SESSION_LIMIT),
    assignments: z.array(SponsorActivityAssignmentSchema).max(SPONSOR_ACTIVITY_MAX_LIMIT),
    next_cursor: ProblemIdSchema.nullable(),
    has_more: z.boolean(),
    omitted: z
      .array(z.enum(["assignment_limit", "session_limit", "public_activity_unavailable", "increment_history_limited", "handback_unavailable"]))
      .max(5),
  })
  .strict()
  .superRefine((page, context) => {
    const invalid = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if (new Set(page.omitted).size !== page.omitted.length)
      invalid("omitted", "Omission reasons must be unique.");
    let previous = page.after_problem_id ?? "";
    for (const item of page.assignments) {
      if (item.problem_id <= previous)
        invalid("assignments", "Assignments must advance in distinct problem identifier order.");
      previous = item.problem_id;
      if (item.public_problem === null && item.last_public_increment !== null)
        invalid("assignments", "Unavailable public problems cannot expose public increments.");
      if (item.last_public_increment !== null && item.public_problem !== null &&
        item.last_public_increment.seq > item.public_problem.cursor)
        invalid("assignments", "A material increment cannot exceed its public snapshot.");
      if (item.handback_unavailable && item.latest_handback !== null)
        invalid("assignments", "An unavailable handback cannot supply text.");
    }
    if (page.has_more !== page.omitted.includes("assignment_limit") ||
      (page.has_more ? page.next_cursor === null || page.next_cursor !== page.assignments.at(-1)?.problem_id : page.next_cursor !== null))
      invalid("next_cursor", "Assignment continuation must identify the last emitted assignment.");
    if (new Set(page.open_sessions.map((session) => session.session_id)).size !== page.open_sessions.length)
      invalid("open_sessions", "Sessions must be distinct.");
    for (const [reason, present] of [
      ["public_activity_unavailable", page.assignments.some((item) => item.public_problem === null)],
      ["increment_history_limited", page.assignments.some((item) => item.increment_history_limited)],
      ["handback_unavailable", page.assignments.some((item) => item.handback_unavailable)],
    ] as const) {
      if (page.omitted.includes(reason) !== present)
        invalid("omitted", "Omissions must describe the actual emitted assignment page.");
    }
  });
export type SponsorActivityResponse = z.infer<typeof SponsorActivityResponseSchema>;

export function sponsorActivityMatchesRequest(
  sponsor: string,
  request: SponsorActivityRequest,
  page: SponsorActivityResponse,
): boolean {
  return page.sponsor_id === sponsor && page.fellow_id === request.fellow_id &&
    page.after_problem_id === (request.after_problem_id ?? null) &&
    page.assignments.length <= request.limit &&
    (!page.has_more || page.assignments.length === request.limit);
}

export function generateSponsorActivitySchema(): string {
  return `${JSON.stringify({
    ...z.toJSONSchema(z.object({ request: SponsorActivityRequestSchema, response: SponsorActivityResponseSchema }).strict(), { io: "input" }),
    $id: SPONSOR_ACTIVITY_SCHEMA_ID,
    description: "Current-sponsor-only work overview. Session heartbeats are recorded timestamps, not proof of current work. Assignments are current memberships in problem identifier order; refresh the first page for newly assigned earlier identifiers. Handbacks are private, untrusted Fellow work products. Public increments contain metadata only and obey current visibility. Reads do not open sessions, acknowledge notices, or change scientific standing.",
  }, null, 2)}\n`;
}
