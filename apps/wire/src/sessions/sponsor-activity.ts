import {
  ProblemStatusSchema,
  SPONSOR_ACTIVITY_MAX_LIMIT,
  SPONSOR_ACTIVITY_MAX_RESPONSE_BYTES,
  SPONSOR_ACTIVITY_SCHEMA_ID,
  SPONSOR_ACTIVITY_SESSION_LIMIT,
  type SponsorActivityAssignment,
  SponsorActivityAssignmentSchema,
  type SponsorActivityRequest,
  SponsorActivityRequestSchema,
  type SponsorActivityResponse,
  SponsorActivityResponseSchema,
  SponsorActivitySessionSchema,
  SponsorIdSchema,
  sponsorActivityMatchesRequest,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { z } from "zod";
import { cancelUnconsumedRequestBody, parseExactJsonBytes } from "../auth/http.ts";
import type { DirectiveRouterOptions } from "../directives/router.ts";
import type { Env } from "../env.ts";
import { validatedProblem } from "../http/envelope.ts";
import { eventContentHiddenSql, hiddenByContentControlSql } from "../krater/public-content.ts";
import { isObjectLevelEvent } from "../mega-commands/materiality.ts";

export const SPONSOR_ACTIVITY_ROUTE = "/v1/sponsors/fellow-activity";
const EVENT_SCAN_LIMIT = 50;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

const publicProblemAvailable = `p.status <> 'private-draft'
  AND length(CAST(p.title AS BLOB)) BETWEEN 1 AND 480
  AND NOT ${hiddenByContentControlSql("p.id", "'problem'")}
  AND NOT ${hiddenByContentControlSql("p.id", "p.id")}`;

// These sources are inspected inside SQLite only. No research body, excerpt,
// private directive, credential, or arbitrary payload is returned to the reader.
const targetId = "json_extract(c.payload_json, '$.bears_on_id')";
const reviewTargetId = "json_extract(c.payload_json, '$.target_claim_id')";
const targetVersion = `CASE WHEN recent.type = 'review.created'
  THEN json_extract(c.payload_json, '$.target_version')
  ELSE json_extract(c.payload_json, '$.bears_on_version') END`;
const eventAvailable = `c.event_id IS NOT NULL AND c.redacted_at IS NULL
  AND json_valid(c.payload_json) AND NOT ${eventContentHiddenSql("recent")}
  AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals w WHERE w.source_event_id = recent.id)
  AND (recent.type NOT IN ('review.created', 'evidence.created') OR EXISTS (
    SELECT 1 FROM events target JOIN event_content target_content ON target_content.event_id = target.id
      AND target_content.payload_sha256 = target.payload_sha256 AND target_content.redacted_at IS NULL
    WHERE target.problem_id = recent.problem_id
      AND target.object_id = CASE WHEN recent.type = 'review.created' THEN ${reviewTargetId} ELSE ${targetId} END
      AND target.seq < recent.seq AND target.seq <= p.public_seq
      AND ((target.object_kind = 'claim' AND target.type IN ('claim.created', 'claim.revised')
        AND target.object_version = ${targetVersion}
        AND (recent.type = 'review.created' OR json_extract(c.payload_json, '$.bears_on_kind') = 'claim'))
        OR (recent.type = 'evidence.created' AND target.object_kind = 'hypothesis'
          AND json_extract(c.payload_json, '$.bears_on_kind') = 'hypothesis'
          AND target.type = 'hypothesis.created' AND target.object_version = 1
          AND ${targetVersion} IS NULL))
      AND json_valid(target_content.payload_json) AND NOT ${eventContentHiddenSql("target")}
      AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals w WHERE w.source_event_id = target.id)
  ))`;

// Current sponsor custody matches private workshop reads, including retained
// work after a Fellow is paused or revoked. Erased private problems never enter
// the page or its lookahead. Memberships are actual roles, not grant bindings or
// focus directives. Open sessions remain visible independently of pagination.
const SNAPSHOT_SQL = `WITH owned_fellow AS MATERIALIZED (
  SELECT f.fellow_id, f.name, f.status FROM enrollment_fellows f
  JOIN sponsors s ON s.sponsor_id = f.sponsor_id AND s.tombstoned_at IS NULL
  WHERE f.sponsor_id = ?1 AND f.fellow_id = ?2
), assignment_page AS MATERIALIZED (
  SELECT m.problem_id, m.role FROM problem_memberships m JOIN owned_fellow f ON f.fellow_id = m.fellow_id
  WHERE m.problem_id > ?3 AND NOT EXISTS (
    SELECT 1 FROM private_draft_erasures erased WHERE erased.problem_id = m.problem_id)
  ORDER BY m.problem_id ASC LIMIT ?4
)
SELECT f.name, f.status,
  (SELECT json_group_array(json_object(
    'session_id', session_id, 'problem_id', problem_id, 'intent', intent,
    'opened_at', opened_at, 'last_heartbeat_at', last_heartbeat_at, 'idle_close_at', idle_close_at
  )) FROM (
    SELECT s.session_id, s.problem_id, s.intent, s.opened_at, s.last_heartbeat_at, s.idle_close_at
    FROM sessions s WHERE s.fellow_id = f.fellow_id AND s.closed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM private_draft_erasures erased WHERE erased.problem_id = s.problem_id)
    ORDER BY s.opened_at DESC, s.session_id DESC LIMIT ${SPONSOR_ACTIVITY_SESSION_LIMIT + 1}
  )) AS sessions_json,
  (SELECT json_group_array(json(assignment_json)) FROM (
    SELECT json_object(
    'problem_id', a.problem_id, 'role', a.role,
    'public_problem', CASE WHEN ${publicProblemAvailable} THEN json_object(
      'title', p.title, 'status', p.status, 'cursor', p.public_seq) ELSE NULL END,
    'latest_handback', CASE WHEN hb.session_id IS NOT NULL THEN json_object(
      'session_id', hb.session_id, 'closed_at', hb.closed_at,
      'text', CASE WHEN length(CAST(hb.handback AS BLOB)) <= 8000 THEN hb.handback END) ELSE NULL END,
    'events', json(CASE WHEN ${publicProblemAvailable} THEN (
      SELECT json_group_array(json(event_json)) FROM (
        SELECT json_object(
        'seq', recent.seq, 'type', recent.type, 'object_kind', recent.object_kind,
        'created_at', recent.created_at, 'available', CASE WHEN ${eventAvailable} THEN 1 ELSE 0 END,
        'materiality_status', CASE WHEN recent.type IN (
          'problem.statement-reviewed', 'problem.statement-revised', 'problem.statement-updated')
          AND json_valid(c.payload_json)
          AND json_type(c.payload_json, '$.previous_status') = 'text'
          AND json_extract(c.payload_json, '$.previous_status') IN
            ('private-draft', 'sharpening', 'active', 'dormant', 'under-result-review', 'resolved', 'retired')
          THEN json_extract(c.payload_json, '$.previous_status') END,
        'low_substance', CASE WHEN recent.type = 'dead_end.recorded'
          AND instr(c.payload_json, 'low-substance-dead-end') > 0 THEN 1 ELSE 0 END
      ) AS event_json FROM (
        SELECT e.id, e.problem_id, e.seq, e.type, e.object_kind, e.object_id,
          e.object_version, e.created_at, e.payload_sha256 FROM events e
        WHERE e.problem_id = a.problem_id AND e.actor_fellow_id = f.fellow_id
          AND e.seq <= p.public_seq ORDER BY e.seq DESC LIMIT ${EVENT_SCAN_LIMIT + 1}
      ) recent LEFT JOIN event_content c ON c.event_id = recent.id AND c.payload_sha256 = recent.payload_sha256
      ORDER BY recent.seq DESC
      )
    ) ELSE '[]' END)
  ) AS assignment_json FROM assignment_page a JOIN problems p ON p.id = a.problem_id
  LEFT JOIN sessions hb ON hb.session_id = (
    SELECT previous.session_id FROM sessions previous
    WHERE previous.fellow_id = f.fellow_id AND previous.problem_id = a.problem_id
      AND previous.closed_at IS NOT NULL AND previous.handback IS NOT NULL
    ORDER BY previous.closed_at DESC, previous.session_id DESC LIMIT 1
  ) ORDER BY a.problem_id ASC
  )) AS assignments_json
FROM owned_fellow f`;

const metadataSchema = z
  .object({
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.string().min(1).max(100),
    object_kind: z.string().min(1).max(100),
    created_at: z.string().datetime(),
    available: z.union([z.literal(0), z.literal(1)]),
    materiality_status: ProblemStatusSchema.nullable(),
    low_substance: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();
const assignmentSnapshotSchema = SponsorActivityAssignmentSchema.omit({
  last_public_increment: true,
  increment_history_limited: true,
  latest_handback: true,
  handback_unavailable: true,
})
  .extend({
    latest_handback: z
      .object({
        session_id: SponsorActivityAssignmentSchema.shape.latest_handback.unwrap().shape.session_id,
        closed_at: z.string().datetime(),
        text: z.string().max(2000).nullable(),
      })
      .strict()
      .nullable(),
    events: z.array(metadataSchema).max(EVENT_SCAN_LIMIT + 1),
  })
  .strict();

function lastIncrement(
  events: readonly z.infer<typeof metadataSchema>[],
): Pick<SponsorActivityAssignment, "last_public_increment" | "increment_history_limited"> {
  let newerUnavailable = false;
  let previous = Number.POSITIVE_INFINITY;
  for (const event of events.slice(0, EVENT_SCAN_LIMIT)) {
    if (event.seq >= previous) throw new Error("SPONSOR_ACTIVITY_ORDER_INVALID");
    previous = event.seq;
    const expectedKind = event.type.split(".")[0];
    if (
      event.available !== 1 ||
      (event.object_kind !== expectedKind &&
        !(expectedKind === "dead_end" && event.object_kind === "dead-end")) ||
      (event.type.startsWith("problem.statement-") &&
        !ProblemStatusSchema.safeParse(event.materiality_status).success)
    ) {
      newerUnavailable = true;
      continue;
    }
    if (
      !isObjectLevelEvent({
        type: event.type,
        object_kind: event.object_kind,
        problem_status:
          typeof event.materiality_status === "string" ? event.materiality_status : null,
        extract: event.low_substance === 1 ? "low-substance-dead-end" : null,
      })
    )
      continue;
    return {
      last_public_increment: SponsorActivityAssignmentSchema.shape.last_public_increment.parse({
        seq: event.seq,
        type: event.type,
        created_at: event.created_at,
      }),
      increment_history_limited: newerUnavailable,
    };
  }
  return {
    last_public_increment: null,
    increment_history_limited: newerUnavailable || events.length > EVENT_SCAN_LIMIT,
  };
}

interface Snapshot {
  name: string;
  status: string;
  sessions_json: string;
  assignments_json: string;
}

/** Two bounded snapshots fence ownership, erasure and content changes before
 * private text leaves this read. Neither pass mutates sessions, presence,
 * notices, membership, credentials, or research. */
export async function readSponsorActivity(
  db: D1Database,
  sponsorId: string,
  input: SponsorActivityRequest,
  now = Date.now(),
): Promise<SponsorActivityResponse | undefined> {
  const request = SponsorActivityRequestSchema.parse(input);
  const read = () =>
    db
      .prepare(SNAPSHOT_SQL)
      .bind(sponsorId, request.fellow_id, request.after_problem_id ?? "", request.limit + 1)
      .first<Snapshot>();
  const snapshot = await read();
  if (snapshot === null) return undefined;
  if (
    new TextEncoder().encode(snapshot.sessions_json + snapshot.assignments_json).byteLength >
    MAX_SNAPSHOT_BYTES
  )
    throw new Error("SPONSOR_ACTIVITY_SNAPSHOT_TOO_LARGE");
  const sessions = SponsorActivitySessionSchema.array()
    .max(SPONSOR_ACTIVITY_SESSION_LIMIT + 1)
    .parse(JSON.parse(snapshot.sessions_json));
  const rows = assignmentSnapshotSchema
    .array()
    .max(SPONSOR_ACTIVITY_MAX_LIMIT + 1)
    .parse(JSON.parse(snapshot.assignments_json));
  const assignments = rows.slice(0, request.limit).map(({ events, latest_handback, ...item }) => ({
    ...item,
    ...lastIncrement(events),
    latest_handback: latest_handback?.text === null ? null : latest_handback,
    handback_unavailable: latest_handback !== null && latest_handback.text === null,
  }));
  const hasMore = rows.length > request.limit;
  const response = SponsorActivityResponseSchema.parse({
    schema: SPONSOR_ACTIVITY_SCHEMA_ID,
    sponsor_id: sponsorId,
    fellow_id: request.fellow_id,
    fellow_name: snapshot.name,
    fellow_status: snapshot.status,
    read_at: new Date(now).toISOString(),
    after_problem_id: request.after_problem_id ?? null,
    open_sessions: sessions.slice(0, SPONSOR_ACTIVITY_SESSION_LIMIT),
    assignments,
    has_more: hasMore,
    next_cursor: hasMore ? (assignments.at(-1)?.problem_id ?? null) : null,
    omitted: [
      ...(hasMore ? ["assignment_limit"] : []),
      ...(sessions.length > SPONSOR_ACTIVITY_SESSION_LIMIT ? ["session_limit"] : []),
      ...(assignments.some((item) => item.public_problem === null)
        ? ["public_activity_unavailable"]
        : []),
      ...(assignments.some((item) => item.increment_history_limited)
        ? ["increment_history_limited"]
        : []),
      ...(assignments.some((item) => item.handback_unavailable) ? ["handback_unavailable"] : []),
    ],
  });
  if (!sponsorActivityMatchesRequest(sponsorId, request, response))
    throw new Error("SPONSOR_ACTIVITY_PAGE_INVALID");
  const current = await read();
  if (current === null) return undefined;
  if (
    current.name !== snapshot.name ||
    current.status !== snapshot.status ||
    current.sessions_json !== snapshot.sessions_json ||
    current.assignments_json !== snapshot.assignments_json
  )
    throw new Error("SPONSOR_ACTIVITY_CHANGED");
  return response;
}

function privateResponse(response: Response): Response {
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}

function unavailable(): Response {
  return privateResponse(
    validatedProblem({
      status: 503,
      code: "INTERNAL_ERROR",
      title: "Fellow work could not be read",
      detail: "A complete work overview under current sponsorship could not be established.",
      fixHint:
        "Refresh this page to inspect current recorded work. Do not share private handback text in diagnostics.",
    }),
  );
}

export function createSponsorActivityRouter(
  options: Pick<DirectiveRouterOptions, "verifiedSponsor"> & { readonly db?: D1Database },
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(() => unavailable());
  app.post(SPONSOR_ACTIVITY_ROUTE, async (c) => {
    let sponsorId: string;
    let rawBody: Uint8Array;
    try {
      const verified = await options.verifiedSponsor(
        c.req.raw,
        SPONSOR_ACTIVITY_ROUTE,
        "fellow.activity.read",
      );
      if (verified instanceof Response) return privateResponse(verified);
      if (
        verified.principal.type !== "sponsor" ||
        !SponsorIdSchema.safeParse(verified.principal.sponsorId).success ||
        !(verified.rawBody instanceof Uint8Array)
      )
        return unavailable();
      sponsorId = verified.principal.sponsorId;
      rawBody = verified.rawBody;
    } finally {
      cancelUnconsumedRequestBody(c.req.raw);
    }
    let input: unknown;
    if (new URL(c.req.url).search === "" && rawBody.byteLength <= 2048) {
      try {
        input = parseExactJsonBytes(rawBody);
      } catch {
        input = undefined;
      }
    }
    const parsed = SponsorActivityRequestSchema.safeParse(input);
    if (!parsed.success)
      return privateResponse(
        validatedProblem({
          status: 422,
          code: "SCHEMA_INVALID",
          title: "Invalid Fellow work request",
          detail: "Use a bounded signed JSON request without query parameters.",
          fixHint:
            "Send fellow_id and optional after_problem_id and limit; copy next_cursor for the next assignment page.",
          rule: "A5",
          extensions: {
            schema: SPONSOR_ACTIVITY_SCHEMA_ID,
            example: { fellow_id: "fellow-example", limit: 10 },
          },
        }),
      );
    const response = await readSponsorActivity(options.db ?? c.env.DB, sponsorId, parsed.data);
    if (response === undefined)
      return privateResponse(
        validatedProblem({
          status: 404,
          code: "ROUTE_NOT_FOUND",
          title: "No such Fellow work overview",
          detail: "No Fellow visible to this sponsor matches the request.",
          fixHint: "Choose a Fellow currently listed in your sponsor console.",
        }),
      );
    const bytes = new TextEncoder().encode(JSON.stringify(response));
    if (bytes.byteLength > SPONSOR_ACTIVITY_MAX_RESPONSE_BYTES) return unavailable();
    return privateResponse(
      new Response(bytes, { headers: { "content-type": "application/json; charset=utf-8" } }),
    );
  });
  return app;
}
