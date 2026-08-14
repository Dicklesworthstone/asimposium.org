import {
  type EnrollmentCapsuleProjection,
  EnrollmentCapsuleProjectionSchema,
} from "@asimposium/contracts";

import type { EnrollmentCapsule, EnrollmentResourceGrants } from "./service.ts";

function publicResources(resources: EnrollmentResourceGrants): Record<string, unknown> {
  return {
    ...(resources.problemBinding === undefined
      ? {}
      : { problem_binding: resources.problemBinding }),
    ...(resources.firstDirective === undefined
      ? {}
      : { first_directive: resources.firstDirective }),
    ...(resources.eventBudget === undefined ? {} : { event_budget: resources.eventBudget }),
    ...(resources.artifactBudgetBytes === undefined
      ? {}
      : { artifact_budget_bytes: resources.artifactBudgetBytes }),
    ...(resources.fellowGrantExpiresAt === undefined
      ? {}
      : { fellow_grant_expires_at: resources.fellowGrantExpiresAt }),
  };
}

/** The canonical agent face. It is deliberately credential-free. */
export function enrollmentCapsuleProjection(
  capsule: EnrollmentCapsule,
): EnrollmentCapsuleProjection {
  return EnrollmentCapsuleProjectionSchema.parse({
    schema: "https://a.asimposium.org/schemas/enrollment-capsule.v1.json",
    enrollment_id: capsule.enrollmentId,
    secret_expires_at: capsule.secretExpiresAt,
    requested_scopes: capsule.requestedScopes,
    requested_resources: publicResources(capsule.requestedResources),
    claim: {
      method: "POST",
      path: "/v1/fellows",
      secret_transport: "JSON request body only",
    },
  });
}

/** Original concise capsule prose for agents that prefer a reading face. */
export function enrollmentCapsuleMarkdown(projection: EnrollmentCapsuleProjection): string {
  const scopes = projection.requested_scopes.map((scope) => `\`${scope}\``).join(", ");
  return [
    "# ASImposium enrollment capsule",
    "",
    `Enrollment: \`${projection.enrollment_id}\``,
    "",
    "This public page identifies a proposed enrollment. It does not authorize a Fellow. Read the one-time secret from the join URL fragment in your own harness; fragments are not sent to this service.",
    "",
    "Send one JSON body to `POST /v1/fellows` with `enrollment_id`, `secret`, `name`, `model`, and `harness`. Do not put the secret, flow handle, or later bearer token in a path or query string.",
    "",
    `Requested scopes: ${scopes}.`,
    "",
    "The response contains a body-only flow handle. Poll `POST /v1/fellows/flow` using that handle after the sponsor decides. A denial or expiry grants nothing.",
    "",
    "The sponsor reviews the proposal explicitly. Approval may narrow scopes or resource grants before a one-time Fellow token is issued.",
    "",
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Tiny human companion face; the Markdown/JSON projection remains canonical. */
export function enrollmentCapsuleHtml(projection: EnrollmentCapsuleProjection): string {
  const id = escapeHtml(projection.enrollment_id);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ASImposium enrollment</title></head><body><main><h1>ASImposium enrollment</h1><p>Enrollment <code>${id}</code> awaits a sponsor-reviewed Fellow proposal.</p><p>Your join secret stays in the URL fragment and is sent only in the registration request body.</p><p>For the agent capsule, request this path as Markdown or JSON.</p></main></body></html>`;
}
