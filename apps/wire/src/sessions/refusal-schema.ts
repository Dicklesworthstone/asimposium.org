import { getPublicSchemaSlice } from "@asimposium/contracts/public-schemas";
import type { MiddlewareHandler } from "hono";

/**
 * Session contract refusals teach with a `schema` link. Pointing every one of
 * them at the whole sessions.v1.json (over 200 KB) cost a real cold-agent
 * session about 650 KB of reads to fix one field. This narrows the link to the
 * one request shape the refused route accepts, served as a standalone slice.
 */
export const SESSIONS_SCHEMA_URL = "https://a.asimposium.org/schemas/sessions.v1.json";

const SLICE_BASE = "https://a.asimposium.org/schemas/sessions.v1/";
const ID = "[^/]+";

/** Method + path shape → the sessions.v1.json property that route accepts. */
const ROUTE_REQUEST_SCHEMAS: readonly (readonly [string, RegExp, string])[] = [
  ["POST", /^\/v1\/sessions$/, "session_open_request"],
  ["GET", new RegExp(`^/v1/sessions/${ID}/pack$`), "pack_target_query"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/workshop$`), "workshop_push_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/promote$`), "promote_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/close$`), "session_close_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/heartbeat$`), "session_heartbeat_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/review$`), "review_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/evidence$`), "evidence_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/hypotheses$`), "hypothesis_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/hypotheses/${ID}/kill$`), "hypothesis_kill_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/revise$`), "revise_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/gaps$`), "gap_file_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/gaps/close$`), "gap_transition_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/relations$`), "relation_file_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/relations/dispute$`), "relation_dispute_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/reanchor$`), "reanchor_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/synthesize$`), "synthesize_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/dead-ends$`), "record_dead_end_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/questions$`), "ask_question_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/questions/${ID}/lease$`), "lease_question_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/questions/${ID}/answer$`), "answer_question_request"],
  [
    "POST",
    new RegExp(`^/v1/sessions/${ID}/questions/${ID}/withdraw$`),
    "withdraw_question_request",
  ],
  ["POST", new RegExp(`^/v1/sessions/${ID}/retract$`), "retract_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/conflicts$`), "normalize_conflict_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/conflicts/${ID}/resolve$`), "resolve_conflict_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/leases$`), "lease_acquire_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/leases/${ID}/release$`), "lease_release_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/leases/${ID}/challenge$`), "lease_challenge_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/citations$`), "record_citation_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/citations/correct$`), "correct_citation_request"],
  ["POST", new RegExp(`^/v1/sessions/${ID}/citations/${ID}/correct$`), "correct_citation_request"],
];

export const SESSION_REQUEST_SCHEMA_PROPERTIES: readonly string[] = ROUTE_REQUEST_SCHEMAS.map(
  ([, , property]) => property,
);

/** The slice URL for the request shape a session route accepts, if one is mapped. */
export function sessionRequestSchemaUrl(method: string, pathname: string): string | undefined {
  for (const [routeMethod, pattern, property] of ROUTE_REQUEST_SCHEMAS) {
    if (routeMethod !== method || !pattern.test(pathname)) continue;
    const url = `${SLICE_BASE}${property}.json`;
    return getPublicSchemaSlice(new URL(url).pathname) === undefined ? undefined : url;
  }
  return undefined;
}

/**
 * Rewrite a 400/422 problem document's whole-document `schema` link to the
 * refused route's request slice. Every other byte of the refusal is kept.
 */
export const narrowSessionRefusalSchema: MiddlewareHandler = async (c, next) => {
  await next();
  const response = c.res;
  // Only body/contract refusals (400, 422) teach a request shape. A 404, 409
  // or 429 teaches recovery, which the request shape does not describe.
  if (response.status !== 400 && response.status !== 422) return;
  if (!(response.headers.get("content-type") ?? "").includes("application/problem+json")) return;
  const url = sessionRequestSchemaUrl(c.req.method, new URL(c.req.url).pathname);
  if (url === undefined) return;
  const text = await response.clone().text();
  let problem: unknown;
  try {
    problem = JSON.parse(text);
  } catch {
    return;
  }
  if (
    problem === null ||
    typeof problem !== "object" ||
    Array.isArray(problem) ||
    (problem as { schema?: unknown }).schema !== SESSIONS_SCHEMA_URL
  ) {
    return;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  // Hono's res setter copies the previous response's headers (including a
  // stale content-length) onto the new one; clear it first.
  c.res = undefined;
  c.res = new Response(JSON.stringify({ ...(problem as object), schema: url }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
