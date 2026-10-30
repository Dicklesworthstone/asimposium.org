import { z } from "zod";
import { PublicLedgerProblemIdSchema } from "./ledger.ts";
import { ProblemNextResponseSchema } from "./mega-commands.ts";
import { MoveDiscoveryOmissionSchema, MoveTemplatesDocSchema } from "./moves.ts";

export const PUBLIC_MOVES_PAGE_SIZE = 4;

/** Live keyset traversal. A continuation is an ordering boundary, not a
 * historical snapshot or a grant to discover private/unlisted work. */
export const PublicMovesQuerySchema = z
  .object({
    after: PublicLedgerProblemIdSchema.optional(),
  })
  .strict();
export type PublicMovesQuery = z.infer<typeof PublicMovesQuerySchema>;

/** Anonymous readers discover work, never acquire a Fellow's permissions. */
export const PublicProblemMovesSchema = ProblemNextResponseSchema.extend({
  viewer: z
    .object({
      role: z.literal("none"),
      effective_permissions: z
        .object({
          read: z.literal(true),
          session_open: z.literal(false),
          workshop_push: z.literal(false),
          promote: z.literal(false),
          review: z.literal(false),
        })
        .strict(),
    })
    .strict(),
  captured_cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  omitted: z.array(MoveDiscoveryOmissionSchema).max(32),
  selection_boundary: z.string().min(1).max(2048),
});
export type PublicProblemMoves = z.infer<typeof PublicProblemMovesSchema>;

export const PublicMoveDiscoverySchema = z
  .object({
    scope: z.literal("public-needs"),
    problems: z.array(PublicProblemMovesSchema).max(PUBLIC_MOVES_PAGE_SIZE),
    scanned: z.number().int().min(0).max(PUBLIC_MOVES_PAGE_SIZE),
    next_after: PublicLedgerProblemIdSchema.nullable(),
    degraded: z.boolean(),
    omitted: z.array(MoveDiscoveryOmissionSchema).max(32),
    selection_boundary: z.string().min(1).max(2048),
  })
  .strict();
export type PublicMoveDiscovery = z.infer<typeof PublicMoveDiscoverySchema>;

/** The existing moves map remains the complete template catalog. The separate
 * discovery member contains selected work, never a synthetic Fellow. Static
 * catalog producers remain valid against the served schema. */
export const MovesDocumentSchema = MoveTemplatesDocSchema.extend({
  discovery: PublicMoveDiscoverySchema.optional(),
});
export const PublicMovesResponseSchema = MoveTemplatesDocSchema.extend({
  discovery: PublicMoveDiscoverySchema,
});
export type PublicMovesResponse = z.infer<typeof PublicMovesResponseSchema>;
