import { z } from "zod";
import { type BindingState, bindingHealthSnapshot, type RequiredBinding } from "../env";
import { problem, SCHEMA_BASE, success, validatedProblem } from "./envelope";

/**
 * `GET /internal/health` — the operational scaffold face.
 *
 * It is deliberately *not* a product endpoint: it opens no session, reads no
 * projection, and touches neither D1 nor R2. It answers exactly one question —
 * "is this Worker wired to its bindings?" — and it answers it in binding
 * *names*, never binding values, ids, or secrets.
 */

export const HEALTH_FORMATS = ["json"] as const;

export type HealthFormat = (typeof HEALTH_FORMATS)[number];

export const HEALTH_SCHEMA = `${SCHEMA_BASE}/internal.health.v1.json`;

/**
 * Local request-shape validation only. Product object schemas are the single
 * responsibility of `@asimposium/contracts` (W1); this package must never grow
 * a second schema tree (AGENTS.md, "Contracts Before Endpoints").
 */
const HealthQuery = z.object({
  format: z.enum(HEALTH_FORMATS).default("json"),
});

export interface HealthData {
  service: "wire";
  role: "stoa";
  format: HealthFormat;
  bindings: Record<RequiredBinding, BindingState>;
}

export interface HealthRequest {
  /** Every raw `?format=` value, in query-string order. */
  formats: readonly string[];
  env: unknown;
}

export function handleHealth(request: HealthRequest): Response {
  const parsed =
    request.formats.length > 1
      ? null
      : HealthQuery.safeParse(request.formats.length === 0 ? {} : { format: request.formats[0] });

  // Fable §7.1 axiom 9: never silent-fail. An unknown format is a 400 that
  // names the allowed list rather than a quiet fallback to the default.
  if (parsed === null || !parsed.success) {
    return validatedProblem({
      status: 400,
      code: "UNKNOWN_FORMAT",
      title: "Unsupported response format",
      detail: "The ?format= value is not one this route serves.",
      fixHint: "Drop ?format= or use one of the values in `allowed`.",
      rule: "A5",
      extensions: {
        schema: "https://a.asimposium.org/schemas/problem.v1.json",
        example: { method: "GET", path: "/internal/health?format=json" },
        allowed: [...HEALTH_FORMATS],
      },
      headers: { "cache-control": "no-store" },
    });
  }

  const { missing, bindings } = bindingHealthSnapshot(request.env);

  // Fail closed: a Worker that cannot reach its system of record reports
  // unavailable rather than serving a cheerful 200 it cannot back up.
  if (missing.length > 0) {
    return problem({
      status: 503,
      code: "BINDING_MISSING",
      title: "Required Worker bindings are not configured",
      detail: `Missing or wrong-shaped bindings: ${missing.join(", ")}.`,
      fixHint:
        "Bind every name in `missing` in the Worker configuration for this environment, then redeploy.",
      extensions: { missing, bindings },
      headers: { "cache-control": "no-store" },
    });
  }

  return success<HealthData>({
    schema: HEALTH_SCHEMA,
    data: {
      service: "wire",
      role: "stoa",
      format: parsed.data.format,
      bindings,
    },
    headers: { "cache-control": "no-store" },
  });
}
