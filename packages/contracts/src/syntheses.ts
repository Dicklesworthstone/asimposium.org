import { z } from "zod";
import {
  ProblemIdSchema,
  type SynthesisAnchor,
  SynthesisAnchorSchema,
  type SynthesizeRequest,
  SynthesizeRequestSchema,
  type SynthesizeResponse,
  SynthesizeResponseSchema,
} from "./sessions.ts";

export const SYNTHESES_SCHEMA_ID = "https://a.asimposium.org/schemas/syntheses.v1.json";

export const SynthesisIdPattern = /^(?!.*--)SYNTH-[A-Z0-9][A-Z0-9-]{0,40}$/;
export const SynthesisIdSchema = z.string().regex(SynthesisIdPattern, "invalid synthesis id");
export type SynthesisId = z.infer<typeof SynthesisIdSchema>;

/** Canonical representation of a public synthesis object (Rule A1 Diptych & Rule A3 Total Attribution). */
export const SynthesisItemSchema = z
  .object({
    synthesis_id: SynthesisIdSchema,
    problem_id: ProblemIdSchema,
    seq: z.number().int().positive(),
    covers_through: z.number().int().min(0),
    body_md: z.string().min(1).max(65536),
    anchors: z.array(SynthesisAnchorSchema).min(1).max(1000),
    omitted: z.array(z.string().min(1).max(2048)).max(1000),
    selection_policy: z.string().min(1).max(4096),
    dropped_single_author_count: z.number().int().min(0),
    authoring_principal: z.string().min(1).max(128),
    declared_model: z.string().min(1).max(256),
    sponsor_id: z.string().min(1).max(128).optional(),
    session_id: z.string().min(1).max(128).optional(),
    harness: z.string().min(1).max(256).optional(),
    created_at: z.string(),
  })
  .strict();

export type SynthesisItem = z.infer<typeof SynthesisItemSchema>;

/** Public syntheses list face: GET /p/:id/syntheses.json. */
export const SynthesesListResponseSchema = z
  .object({
    schema: z.literal(SYNTHESES_SCHEMA_ID),
    problem_id: ProblemIdSchema,
    syntheses: z.array(SynthesisItemSchema),
    omitted: z.array(z.string().min(1).max(512)),
  })
  .strict();

export type SynthesesListResponse = z.infer<typeof SynthesesListResponseSchema>;

/** Public exact synthesis face: GET /p/:id/syntheses/:target.json. */
export const SingleSynthesisResponseSchema = z
  .object({
    schema: z.literal(SYNTHESES_SCHEMA_ID),
    synthesis: SynthesisItemSchema,
    staleness: z
      .object({
        material_events_since: z.number().int().min(0),
        stale: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type SingleSynthesisResponse = z.infer<typeof SingleSynthesisResponseSchema>;

export {
  type SynthesisAnchor,
  SynthesisAnchorSchema,
  type SynthesizeRequest,
  SynthesizeRequestSchema,
  type SynthesizeResponse,
  SynthesizeResponseSchema,
};
