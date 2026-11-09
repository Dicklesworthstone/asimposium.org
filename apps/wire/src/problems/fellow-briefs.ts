import {
  FELLOW_PROBLEM_BRIEF_PAGE_SIZE,
  FellowProblemBriefListQuerySchema,
  FellowProblemBriefListResponseSchema,
  FellowProblemBriefReadQuerySchema,
  FellowProblemBriefReadResponseSchema,
  fellowProblemBriefListUrl,
  fellowProblemBriefReadUrl,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import {
  authorizeFellowWrite,
  type EnrollmentService,
  type FellowCredentialBinding,
} from "../enrollment/service.ts";
import type { Env } from "../env.ts";
import { type ValidatedProblemInput, validatedProblem } from "../http/envelope.ts";
import { problemBoundaryFields, type StoredProblemBoundaries } from "./boundaries.ts";

const SCHEMA = "https://a.asimposium.org/schemas/problems.v1.json";

/** This is private assigned intent for drafting a new problem. A credential
 * limited to an existing problem cannot inspect unrelated sponsor briefs.
 * Suspicious-review Fellows retain reads; write authority is checked separately. */
export function fellowMayReadAssignedBriefs(
  binding: FellowCredentialBinding,
  now: number,
): boolean {
  return (
    (binding.fellowStatus === "active" || binding.fellowStatus === "suspicious_review") &&
    binding.revokedAt === undefined &&
    binding.issuedAt <= now &&
    binding.expiresAt > now &&
    binding.grantedScopes.includes("propose-problems") &&
    binding.grantedResources.problemBinding === undefined &&
    (binding.grantedResources.fellowGrantExpiresAt === undefined ||
      binding.grantedResources.fellowGrantExpiresAt > now)
  );
}

// The read and the current authority share one D1 statement. Reassignment,
// withdrawal, transfer, suspension, panic and token retirement cannot leave an
// authenticated snapshot authorizing a later private body read.
const authoritySql = (withUsage: boolean) => `SELECT f.fellow_id, f.status AS fellow_status,
    COALESCE(json_extract(t.granted_resources_json, '$.eventBudget'),
      json_extract(t.granted_resources_json, '$.event_budget')) AS event_budget,
    ${
      withUsage
        ? `CASE WHEN COALESCE(json_extract(t.granted_resources_json, '$.eventBudget'),
      json_extract(t.granted_resources_json, '$.event_budget')) IS NULL THEN 0 ELSE
      (SELECT COUNT(*) FROM events WHERE writer_credential_id = t.credential_id) END`
        : "0"
    } AS events_recorded
  FROM enrollment_fellows f
  JOIN fellow_tokens t ON t.fellow_id = f.fellow_id AND t.sponsor_id = f.sponsor_id
  JOIN enrollment_grants g ON g.fellow_id = f.fellow_id AND g.sponsor_id = f.sponsor_id
    AND g.granted_scopes_json = t.granted_scopes_json
    AND g.granted_resources_json = t.granted_resources_json
  JOIN sponsors sponsor ON sponsor.sponsor_id = f.sponsor_id AND sponsor.tombstoned_at IS NULL
  WHERE f.fellow_id = ?1 AND f.sponsor_id = ?2
    AND t.credential_id = ?3 AND t.token_hash = ?4
    AND t.credential_profile = 'bearer' AND t.revoked_at IS NULL
    AND f.status IN ('active', 'suspicious_review')
    AND t.issued_at <= unixepoch('subsec') * 1000
    AND t.expires_at > unixepoch('subsec') * 1000
    AND COALESCE(json_extract(t.granted_resources_json, '$.fellowGrantExpiresAt'),
      json_extract(t.granted_resources_json, '$.fellow_grant_expires_at'),
      t.expires_at) > unixepoch('subsec') * 1000
    AND json_extract(t.granted_resources_json, '$.problemBinding') IS NULL
    AND json_extract(t.granted_resources_json, '$.problem_binding') IS NULL
    AND EXISTS (SELECT 1 FROM json_each(t.granted_scopes_json) WHERE value = 'propose-problems')
    AND t.issued_at > COALESCE((SELECT panic_at FROM enrollment_sponsor_security
      WHERE sponsor_id = f.sponsor_id), -1)
    AND g.granted_at > COALESCE((SELECT panic_at FROM enrollment_sponsor_security
      WHERE sponsor_id = f.sponsor_id), -1)
    AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = f.sponsor_id)`;

interface BriefRow extends StoredProblemBoundaries {
  id: string | null;
  sponsor_id: string;
  version: number;
  assigned_fellow_id: string;
  title: string;
  statement: string;
  falsifier: string;
  motivation: string;
  areas: string;
  famous_guardrail: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  fellow_status: FellowCredentialBinding["fellowStatus"];
  event_budget: number | null;
  events_recorded: number;
}

function privateResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}

function refusal(input: ValidatedProblemInput): Response {
  return privateResponse(validatedProblem(input));
}

const invalidToken = () =>
  refusal({
    status: 401,
    code: "FELLOW_TOKEN_INVALID",
    title: "Fellow authorization is not accepted",
    detail: "The current credential cannot authorize this private assigned-brief read.",
    fixHint: "Use a current, unbound Fellow credential approved to propose problems.",
  });

export function createFellowBriefRouter(options: {
  service: Pick<EnrollmentService, "credentialBinding">;
  db?: D1Database;
}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  for (const detail of [false, true]) {
    app.get(detail ? "/v1/problem-briefs/read" : "/v1/problem-briefs", async (c) => {
      try {
        const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization")?.trim() ?? "")?.[1];
        const binding = token ? await options.service.credentialBinding(token) : undefined;
        if (!binding || !fellowMayReadAssignedBriefs(binding, Date.now())) return invalidToken();
        const params = new URL(c.req.url).searchParams;
        const duplicate = [...params.keys()].some((key) => params.getAll(key).length !== 1);
        const parsed = (
          detail ? FellowProblemBriefReadQuerySchema : FellowProblemBriefListQuerySchema
        ).safeParse(Object.fromEntries(params));
        if (duplicate || !parsed.success)
          return refusal({
            status: 400,
            code: "SCHEMA_INVALID",
            title: "Invalid private-brief query",
            detail: detail
              ? "Supply exactly one brief_id."
              : "Only one optional after continuation is accepted.",
            fixHint:
              "Start at /v1/problem-briefs, then follow its exact read_url and next_url links. Listing is live; restart for newly assigned or edited briefs.",
            rule: "A5",
            extensions: { schema: SCHEMA, example: detail ? { brief_id: "brief-example" } : {} },
          });
        const db = options.db ?? c.env?.DB;
        if (!db) throw new Error("BRIEFS_UNAVAILABLE");
        const query = parsed.data;
        const cut = "brief_id" in query ? query.brief_id : (query.after ?? null);
        const result = await db
          .prepare(`WITH authority AS (${authoritySql(detail)}), visible AS (
          SELECT ${detail ? "b.*" : "b.id, b.title, b.updated_at"}
          FROM sponsor_problem_briefs b
          WHERE EXISTS (SELECT 1 FROM authority)
            AND b.sponsor_id = ?2 AND b.assigned_fellow_id = ?1 AND b.status = 'active'
            AND ${detail ? "b.id = ?5" : "(?5 IS NULL OR b.id COLLATE BINARY > ?5)"}
          ORDER BY b.id COLLATE BINARY LIMIT ${detail ? 1 : FELLOW_PROBLEM_BRIEF_PAGE_SIZE + 1}
        ) SELECT a.fellow_status, a.event_budget, a.events_recorded, v.*
          FROM authority a LEFT JOIN visible v ON 1 = 1 ORDER BY v.id COLLATE BINARY`)
          .bind(binding.fellowId, binding.sponsorId, binding.credentialId, binding.tokenHash, cut)
          .all<BriefRow>();
        if (!result.success) throw new Error("BRIEFS_UNAVAILABLE");
        const first = result.results[0];
        if (!first) return invalidToken();
        if (!detail) {
          const rows = result.results.filter(
            (row): row is BriefRow & { id: string } => row.id !== null,
          );
          const selected = rows.slice(0, FELLOW_PROBLEM_BRIEF_PAGE_SIZE);
          const after = rows.length > selected.length ? (selected.at(-1)?.id ?? null) : null;
          return privateResponse(
            c.json(
              FellowProblemBriefListResponseSchema.parse({
                briefs: selected.map((row) => ({
                  id: row.id,
                  title: row.title,
                  updated_at: row.updated_at,
                  read_url: fellowProblemBriefReadUrl(row.id),
                })),
                next_after: after,
                next_url: after === null ? null : fellowProblemBriefListUrl(after),
                omitted: after === null ? [] : ["page_limit"],
              }),
            ),
          );
        }
        if (first.id === null)
          return refusal({
            status: 404,
            code: "BRIEF_NOT_FOUND",
            title: "Assigned brief unavailable",
            detail:
              "No active brief at this identifier is assigned to this Fellow by its current sponsor.",
            fixHint:
              "Refresh /v1/problem-briefs. Ask your sponsor to assign a brief if the list is empty.",
            rule: "A5",
            extensions: { schema: SCHEMA, example: { method: "GET", path: "/v1/problem-briefs" } },
          });
        const resources = { ...binding.grantedResources };
        if (first.event_budget === null) delete resources.eventBudget;
        else resources.eventBudget = first.event_budget;
        const mayPropose =
          authorizeFellowWrite({
            effect: "propose-problems",
            credential: {
              ...binding,
              fellowStatus: first.fellow_status,
              grantedResources: resources,
            },
            target: { kind: "new-problem", initialPublication: "private-draft", unlisted: false },
            usage: { eventsRecorded: first.events_recorded, artifactBytesRecorded: 0 },
            now: Date.now(),
          }).decision === "allow";
        return privateResponse(
          c.json(
            FellowProblemBriefReadResponseSchema.parse({
              brief: {
                id: first.id,
                sponsor_id: first.sponsor_id,
                version: first.version,
                assigned_fellow_id: first.assigned_fellow_id,
                title: first.title,
                statement: first.statement,
                falsifier: first.falsifier,
                motivation: first.motivation,
                ...problemBoundaryFields(first),
                areas: JSON.parse(first.areas),
                ...(first.famous_guardrail === null
                  ? {}
                  : { famous_guardrail: JSON.parse(first.famous_guardrail) }),
                status: first.status,
                created_at: first.created_at,
                updated_at: first.updated_at,
              },
              next_actions: mayPropose
                ? [
                    {
                      method: "POST",
                      url: "/v1/problems",
                      schema: `${SCHEMA}#/properties/propose_request`,
                      why: "Read this private sponsor intent, then propose your own exact formulation with this brief_id. Adoption creates a private draft; it does not publish a problem.",
                    },
                  ]
                : [],
            }),
          ),
        );
      } catch {
        return refusal({
          status: 503,
          code: "INTERNAL_ERROR",
          title: "Assigned briefs unavailable",
          detail: "The private assigned-brief read could not be completed safely.",
          fixHint: "Retry the same read before assuming that no brief is assigned to you.",
        });
      }
    });
  }
  return app;
}
