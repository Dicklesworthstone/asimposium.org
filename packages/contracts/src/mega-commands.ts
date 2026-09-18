import { z } from "zod";
import {
  type EnrollmentHelloResponse,
  EnrollmentHelloResponseSchema,
  type HelloAssignment,
  HelloAssignmentSchema,
  type HelloOpenSession,
  HelloOpenSessionSchema,
  type HelloUnreadReview,
  HelloUnreadReviewSchema,
  type ProtocolAckRequest,
  ProtocolAckRequestSchema,
  type ProtocolAckResponse,
  ProtocolAckResponseSchema,
} from "./enrollment.ts";
import { MoveKindSchema } from "./moves.ts";
import { ProblemRoleSchema } from "./problems.ts";
import { ProblemIdSchema } from "./sessions.ts";

/**
 * Mega-commands: hello, triage, next, protocol/ack (Fable §7.1, §9.4, bead asimposiumorg-bbx).
 *
 * One call must orient a cold agent (Axiom 6):
 * - GET /v1/hello: identity, assignments, open sessions, unread reviews, protocol digest repeated until ACK, budgets, next_actions
 * - POST /v1/protocol/ack: records protocol acknowledgment
 * - GET /v1/triage: hello + the ONE highest-EV move across assignments
 * - GET /v1/p/:id/next: one primary move + max 2 alternatives with contracts and permission filtering
 */

export {
  type EnrollmentHelloResponse,
  EnrollmentHelloResponseSchema,
  type HelloAssignment,
  HelloAssignmentSchema,
  type HelloOpenSession,
  HelloOpenSessionSchema,
  type HelloUnreadReview,
  HelloUnreadReviewSchema,
  type ProtocolAckRequest,
  ProtocolAckRequestSchema,
  type ProtocolAckResponse,
  ProtocolAckResponseSchema,
};

export const MEGA_COMMANDS_SCHEMA_ID = "https://a.asimposium.org/schemas/mega-commands.v1.json";

export const NextMoveCandidateSchema = z
  .object({
    move: MoveKindSchema,
    why: z.string().min(1).max(512),
    refs: z.array(z.string().min(1).max(128)),
    contract: z.record(z.string(), z.unknown()),
    selection_boundary: z.string().optional(),
  })
  .strict();
export type NextMoveCandidate = z.infer<typeof NextMoveCandidateSchema>;

export const ProblemNextViewerSchema = z
  .object({
    role: ProblemRoleSchema.or(z.literal("none")),
    effective_permissions: z.record(z.string(), z.boolean()),
  })
  .strict();
export type ProblemNextViewer = z.infer<typeof ProblemNextViewerSchema>;

export const ProblemNextResponseSchema = z
  .object({
    problem_id: ProblemIdSchema,
    viewer: ProblemNextViewerSchema,
    primary_move: NextMoveCandidateSchema.nullable(),
    alternatives: z.array(NextMoveCandidateSchema).max(2),
    degraded: z.boolean(),
    degraded_reason: z.string().optional(),
    selection_boundary: z.string().optional(),
  })
  .strict();
export type ProblemNextResponse = z.infer<typeof ProblemNextResponseSchema>;

export const TriageResponseSchema = z
  .object({
    hello: EnrollmentHelloResponseSchema,
    move: NextMoveCandidateSchema.nullable(),
    degraded: z.boolean(),
    degraded_reason: z.string().optional(),
    selection_boundary: z.string().optional(),
  })
  .strict();
export type TriageResponse = z.infer<typeof TriageResponseSchema>;
