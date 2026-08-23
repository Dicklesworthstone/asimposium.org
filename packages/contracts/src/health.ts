import { z } from "zod";

/**
 * `GET /internal/health` success face — the operational scaffold envelope
 * (asimposiumorg-261q).
 *
 * Shape-only readiness: binding *names* and bound/missing states, never
 * values, ids, or secrets. The binding-name enum mirrors the Worker's
 * REQUIRED_BINDINGS list; the wire-side causal drift test pins the two lists
 * together so a binding added in the topology cannot silently miss the
 * served schema (or vice versa).
 */

export const INTERNAL_HEALTH_SCHEMA_ID =
  "https://a.asimposium.org/schemas/internal.health.v1.json";

export const HealthBindingName = z.enum([
  "DB",
  "ARTIFACTS",
  "PUBLIC_ARTIFACTS",
  "KRATER_OUTBOX",
]);

export const HealthBindingState = z.enum(["bound", "missing"]);

export const InternalHealthData = z.object({
  service: z.literal("wire"),
  role: z.literal("stoa"),
  format: z.literal("json"),
  bindings: z.record(HealthBindingName, HealthBindingState),
});

export const NextActionShape = z.object({
  method: z.string(),
  url: z.string(),
  why: z.string(),
});

/** The full success body the mounted route serves, envelope included. */
export const InternalHealthContracts = z.object({
  schema: z.literal(INTERNAL_HEALTH_SCHEMA_ID),
  ok: z.literal(true),
  data: InternalHealthData,
  degraded: z.array(z.string()),
  next_actions: z.array(NextActionShape),
});

export type HealthBindingName = z.infer<typeof HealthBindingName>;
export type HealthBindingState = z.infer<typeof HealthBindingState>;
export type InternalHealthData = z.infer<typeof InternalHealthData>;
export type InternalHealthContracts = z.infer<typeof InternalHealthContracts>;
