import {
  canonicalJson,
  ProblemGovernanceKeySchema,
  type ProblemLifecycleActionRequest,
  type ProblemStatementAuthor,
  type ProblemStatementProposal,
  ProblemStatementProposalListResponseSchema,
  type ProblemStatementProposalRequest,
  ProblemStatementProposalRequestSchema,
  ProblemStatementProposalResponseSchema,
  ProblemStatementProposalSchema,
  type ProblemStatementRevisionPreview,
  ProblemStatementRevisionPreviewSchema,
  ProblemStatementRevisionResponseSchema,
} from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  authorizeFellowWrite,
  type FellowCredentialBinding,
  type FellowProblemMembershipRole,
  fellowCanAccessPrivateProblem,
} from "../enrollment/service.ts";
import { validatedProblem } from "../http/envelope.ts";
import { sha256Hex } from "../krater/krater.ts";
import { normHash } from "../split/policy.ts";
import { problemBoundariesRequired, problemBoundaryFields } from "./boundaries.ts";

const SCHEMA = "https://a.asimposium.org/schemas/problems.v1.json";
const TTL = 86_400_000;
const WRITABLE = "('private-draft','sharpening','active','dormant','under-result-review')";
const SPONSOR_LIVE = `EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = ? AND tombstoned_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = ?)`;

export function privateStatementResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("vary", "Authorization");
  return new Response(response.body, { status: response.status, headers });
}
const json = (body: unknown, status = 200) =>
  privateStatementResponse(Response.json(body, { status }));
export const statementProposalAbsent = () =>
  privateStatementResponse(
    validatedProblem({
      status: 404,
      code: "PROBLEM_NOT_FOUND",
      title: "Statement proposal unavailable",
      detail: "No statement proposal is available to this principal.",
      fixHint: "Read your current problem workspace and use its exact proposal identifier.",
      rule: "A5",
      extensions: {
        schema: SCHEMA,
        example: { method: "GET", path: "/v1/sponsors/problems/PROBLEM/statement-proposals" },
      },
    }),
  );
const denied = () =>
  privateStatementResponse(
    validatedProblem({
      status: 403,
      code: "WRITE_REFUSED",
      title: "Statement proposal is not authorized",
      detail: "Current authority does not permit this operation.",
      fixHint: "Check your current Fellow grant, problem membership and sponsor workspace.",
    }),
  );
const stale = () =>
  privateStatementResponse(
    validatedProblem({
      status: 409,
      code: "OBJECT_VERSION_CONFLICT",
      title: "Statement proposal changed or is stale",
      detail:
        "The exact proposal, base statement, source author or accepting authority is no longer current. Nothing was changed by this attempt.",
      fixHint:
        "Read the current formulation and proposal preview. Submit a deliberate replacement proposal if its base changed; retain the original key to recover an already accepted command.",
      rule: "A5",
      extensions: {
        schema: SCHEMA,
        example: { method: "GET", path: "/v1/sponsors/problems/PROBLEM/statement-proposals" },
      },
    }),
  );
const conflict = () =>
  privateStatementResponse(
    validatedProblem({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      title: "This key identifies another statement command",
      detail: "No replacement command was accepted for this key.",
      fixHint:
        "Retry the original request unchanged with its original key, or use a new key for deliberately changed work.",
      rule: "A5",
      extensions: {
        schema: SCHEMA,
        example: { headers: { "Idempotency-Key": "statement-proposal-1" } },
      },
    }),
  );
const badKey = () =>
  privateStatementResponse(
    validatedProblem({
      status: 400,
      code: "IDEMPOTENCY_KEY_INVALID",
      title: "A stable Idempotency-Key is required",
      detail: "This command requires a replay key retained for 24 hours.",
      fixHint:
        "Use 1–160 letters, digits, dots, underscores or hyphens; retry the exact request with the same key.",
      rule: "A5",
      extensions: {
        schema: SCHEMA,
        example: { headers: { "Idempotency-Key": "statement-proposal-1" } },
      },
    }),
  );

interface ProposalRow {
  proposal_id: string;
  problem_id: string;
  fellow_id: string;
  sponsor_id: string;
  session_id: string;
  model_self_declared: string;
  harness: string;
  base_statement_version: number;
  payload_json: string;
  payload_digest: string;
  created_at: string;
  accepted_statement_version: number | null;
  accepted_event_id: string | null;
  accepted_at: string | null;
}
interface SnapshotRow extends ProposalRow {
  title: string;
  problem_status: string;
  current_statement_version: number;
  stewardship_version: number;
  source_live: number;
  admission_mode: string;
}

function author(row: ProposalRow): ProblemStatementAuthor {
  return {
    fellow_id: row.fellow_id,
    sponsor_id: row.sponsor_id,
    session_id: row.session_id,
    model_self_declared: row.model_self_declared,
    harness: row.harness,
  };
}
function summary(row: ProposalRow) {
  return {
    proposal_id: row.proposal_id,
    base_statement_version: row.base_statement_version,
    author: author(row),
    created_at: row.created_at,
    status: row.accepted_statement_version === null ? ("pending" as const) : ("accepted" as const),
    accepted_statement_version: row.accepted_statement_version,
  };
}
async function decode(row: ProposalRow): Promise<ProblemStatementProposal | undefined> {
  if ((await sha256Hex(row.payload_json)) !== row.payload_digest) return undefined;
  const parsed = ProblemStatementProposalRequestSchema.safeParse(JSON.parse(row.payload_json));
  if (
    !parsed.success ||
    parsed.data.session_id !== row.session_id ||
    parsed.data.base_statement_version !== row.base_statement_version
  )
    return undefined;
  return ProblemStatementProposalSchema.parse({
    ...summary(row),
    problem_id: row.problem_id,
    statement: parsed.data.statement,
    falsifier: parsed.data.falsifier,
    motivation: parsed.data.motivation,
    ...problemBoundaryFields(parsed.data),
  });
}

/** Parameters 1–4 are the exact authenticated Fellow/sponsor/credential/digest.
 * No session, membership or scope is required to recover an earlier own receipt. */
const FELLOW_AUTHORITY = `SELECT f.fellow_id, f.sponsor_id, f.model, f.harness,
  t.granted_scopes_json, t.granted_resources_json,
  COALESCE(json_extract(t.granted_resources_json,'$.eventBudget'), json_extract(t.granted_resources_json,'$.event_budget')) AS event_budget,
  (SELECT COUNT(*) FROM events WHERE writer_credential_id = t.credential_id) AS events_recorded
  FROM enrollment_fellows f JOIN fellow_tokens t ON t.fellow_id = f.fellow_id AND t.sponsor_id = f.sponsor_id
  JOIN enrollment_grants g ON g.fellow_id = f.fellow_id AND g.sponsor_id = f.sponsor_id
    AND g.granted_scopes_json = t.granted_scopes_json AND g.granted_resources_json = t.granted_resources_json
  JOIN sponsors s ON s.sponsor_id = f.sponsor_id AND s.tombstoned_at IS NULL
  WHERE f.fellow_id = ?1 AND f.sponsor_id = ?2 AND t.credential_id = ?3 AND t.token_hash = ?4
    AND f.status = 'active' AND t.revoked_at IS NULL AND t.credential_profile = 'bearer'
    AND t.issued_at <= unixepoch('subsec') * 1000 AND t.expires_at > unixepoch('subsec') * 1000
    AND COALESCE(json_extract(t.granted_resources_json,'$.fellowGrantExpiresAt'),
      json_extract(t.granted_resources_json,'$.fellow_grant_expires_at'),t.expires_at) > unixepoch('subsec') * 1000
    AND t.issued_at > COALESCE((SELECT panic_at FROM enrollment_sponsor_security WHERE sponsor_id = f.sponsor_id),-1)
    AND g.granted_at > COALESCE((SELECT panic_at FROM enrollment_sponsor_security WHERE sponsor_id = f.sponsor_id),-1)
    AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = f.sponsor_id)`;
const authorityValues = (binding: FellowCredentialBinding) => [
  binding.fellowId,
  binding.sponsorId,
  binding.credentialId,
  binding.tokenHash,
];

/** A closed session remains genuine historical authorship. Current source
 * approval, membership, binding and grant expiry are rechecked on acceptance. */
function sourceAuthoritySql(alias: string): string {
  return `EXISTS (SELECT 1 FROM enrollment_fellows f
    JOIN sponsors s ON s.sponsor_id = f.sponsor_id AND s.tombstoned_at IS NULL
    JOIN enrollment_grants g ON g.fellow_id = f.fellow_id AND g.sponsor_id = f.sponsor_id
    JOIN sessions ss ON ss.session_id = ${alias}.session_id AND ss.fellow_id = f.fellow_id AND ss.problem_id = ${alias}.problem_id
    JOIN problem_memberships m ON m.problem_id = ${alias}.problem_id AND m.fellow_id = f.fellow_id
    JOIN problems source_problem ON source_problem.id = ${alias}.problem_id
    WHERE f.fellow_id = ${alias}.fellow_id AND f.sponsor_id = ${alias}.sponsor_id AND f.status = 'active'
      AND f.model = ${alias}.model_self_declared AND f.harness = ${alias}.harness
      AND g.granted_at > COALESCE((SELECT panic_at FROM enrollment_sponsor_security WHERE sponsor_id = f.sponsor_id),-1)
      AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = f.sponsor_id)
      AND COALESCE(json_extract(g.granted_resources_json,'$.fellowGrantExpiresAt'),
        json_extract(g.granted_resources_json,'$.fellow_grant_expires_at'),9007199254740991) > unixepoch('subsec') * 1000
      AND COALESCE(json_extract(g.granted_resources_json,'$.problemBinding'),
        json_extract(g.granted_resources_json,'$.problem_binding'),${alias}.problem_id) = ${alias}.problem_id
      AND ((source_problem.status = 'private-draft' AND source_problem.sponsor_id = f.sponsor_id
        AND (source_problem.created_by_fellow_id = f.fellow_id OR COALESCE(
          json_extract(g.granted_resources_json,'$.problemBinding'),
          json_extract(g.granted_resources_json,'$.problem_binding')) = source_problem.id))
        OR (source_problem.status <> 'private-draft' AND m.role IN ('contributor','steward')
        AND EXISTS (SELECT 1 FROM json_each(g.granted_scopes_json) WHERE value = 'promote')))
      AND ((SELECT COUNT(*) FROM events WHERE actor_fellow_id = f.fellow_id) +
        (SELECT COUNT(*) FROM problem_statement_proposals used WHERE used.fellow_id = f.fellow_id
          AND used.accepted_event_id IS NOT NULL)) < COALESCE(
        json_extract(g.granted_resources_json,'$.eventBudget'),
        json_extract(g.granted_resources_json,'$.event_budget'),9007199254740991))`;
}

export async function submitStatementProposal(
  db: D1Database,
  binding: FellowCredentialBinding,
  problemId: string,
  request: ProblemStatementProposalRequest,
  key: string | null,
): Promise<Response> {
  const parsedKey = ProblemGovernanceKeySchema.safeParse(key);
  if (!parsedKey.success) return badKey();
  const now = Date.now(),
    createdAt = new Date(now).toISOString();
  const keyDigest = await sha256Hex(parsedKey.data);
  const payload = canonicalJson(request);
  const payloadDigest = await sha256Hex(payload);
  const requestDigest = await sha256Hex(canonicalJson({ problem_id: problemId, request }));
  const values = authorityValues(binding);
  const replay = async (): Promise<Response | undefined> => {
    const row = await db
      .prepare(`WITH authority AS (${FELLOW_AUTHORITY})
      SELECT r.*, EXISTS(SELECT 1 FROM authority) AS authority_live FROM problem_statement_proposal_receipts r
      WHERE r.fellow_id = ?1 AND r.key_digest = ?5 AND r.expires_at > ?6`)
      .bind(...values, keyDigest, now)
      .first<{
        request_digest: string;
        sponsor_id: string;
        proposal_id: string;
        authority_live: number;
      }>();
    if (!row) return undefined;
    if (!row.authority_live || row.sponsor_id !== binding.sponsorId) return denied();
    if (row.request_digest !== requestDigest) return conflict();
    const proposal = await db
      .prepare(
        "SELECT * FROM problem_statement_proposals WHERE proposal_id = ? AND fellow_id = ? AND sponsor_id = ?",
      )
      .bind(row.proposal_id, binding.fellowId, binding.sponsorId)
      .first<ProposalRow>();
    if (!proposal) return statementProposalAbsent();
    const decoded = await decode(proposal);
    if (!decoded) return statementProposalAbsent();
    // Replay the original submitted state, not a later acceptance projection.
    return json(
      ProblemStatementProposalResponseSchema.parse({
        proposal: {
          ...decoded,
          status: "pending",
          accepted_statement_version: null,
        },
      }),
      201,
    );
  };
  const previous = await replay();
  if (previous) return previous;
  const state = await db
    .prepare(`WITH authority AS (${FELLOW_AUTHORITY})
    SELECT p.id, p.status, p.unlisted, p.sponsor_id, p.created_by_fellow_id, p.current_statement_version,
      p.admission_mode, a.event_budget, a.events_recorded, m.role,
      (SELECT scope FROM problem_statement_versions WHERE problem_id = p.id AND version = p.current_statement_version) AS scope
    FROM authority a JOIN problems p ON p.id = ?5
    JOIN sessions ss ON ss.session_id = ?6 AND ss.problem_id = p.id AND ss.fellow_id = a.fellow_id
      AND ss.closed_at IS NULL AND julianday(ss.idle_close_at) > julianday('now')
    JOIN problem_memberships m ON m.problem_id = p.id AND m.fellow_id = a.fellow_id`)
    .bind(...values, problemId, request.session_id)
    .first<{
      id: string;
      status: string;
      unlisted: number;
      sponsor_id: string | null;
      created_by_fellow_id: string | null;
      current_statement_version: number;
      admission_mode: string;
      event_budget: number | null;
      events_recorded: number;
      role: FellowProblemMembershipRole;
      scope: string | null;
    }>();
  if (!state) return (await replay()) ?? denied();
  const isPrivate = state.status === "private-draft";
  const permission = authorizeFellowWrite({
    effect: isPrivate ? "workshop.push" : "promote",
    credential: binding,
    target: {
      kind: "existing-problem",
      problemId,
      publication: isPrivate ? "private-draft" : "published",
      unlisted: state.unlisted === 1,
      membershipRole: state.role,
    },
    usage: { eventsRecorded: state.events_recorded, artifactBytesRecorded: 0 },
    now,
  });
  if (
    permission.decision !== "allow" ||
    (isPrivate &&
      !fellowCanAccessPrivateProblem(
        binding,
        { id: problemId, sponsorId: state.sponsor_id, creatorFellowId: state.created_by_fellow_id },
        now,
      ))
  )
    return denied();
  if (
    state.current_statement_version !== request.base_statement_version ||
    !["private-draft", "sharpening", "active", "dormant", "under-result-review"].includes(
      state.status,
    ) ||
    state.admission_mode === "archived-read-only"
  )
    return stale();
  if (state.scope !== null && request.scope === undefined)
    return privateStatementResponse(problemBoundariesRequired());
  const proposalId = `SPR-${crypto.randomUUID()}`;
  try {
    await db.batch([
      db
        .prepare(
          "DELETE FROM problem_statement_proposal_receipts WHERE fellow_id = ? AND key_digest = ? AND expires_at <= ?",
        )
        .bind(binding.fellowId, keyDigest, now),
      db
        .prepare(`WITH authority AS (${FELLOW_AUTHORITY})
        INSERT INTO problem_statement_proposals(proposal_id,problem_id,fellow_id,sponsor_id,session_id,
          model_self_declared,harness,base_statement_version,payload_json,payload_digest,created_at)
        SELECT ?5,p.id,a.fellow_id,a.sponsor_id,ss.session_id,a.model,a.harness,?6,?7,?8,?9
        FROM authority a JOIN problems p ON p.id = ?10 JOIN sessions ss ON ss.session_id = ?11
          AND ss.fellow_id = a.fellow_id AND ss.problem_id = p.id AND ss.closed_at IS NULL
          AND julianday(ss.idle_close_at) > julianday('now')
        JOIN problem_memberships m ON m.problem_id = p.id AND m.fellow_id = a.fellow_id
        WHERE p.current_statement_version = ?6 AND p.status = ?12 AND p.status IN ${WRITABLE}
          AND p.admission_mode <> 'archived-read-only'
          AND (a.event_budget IS NULL OR a.events_recorded < a.event_budget)
          AND COALESCE(json_extract(a.granted_resources_json,'$.problemBinding'),
            json_extract(a.granted_resources_json,'$.problem_binding'),p.id) = p.id
          AND ((p.status = 'private-draft' AND p.sponsor_id = a.sponsor_id
            AND (p.created_by_fellow_id = a.fellow_id OR COALESCE(json_extract(a.granted_resources_json,'$.problemBinding'),
              json_extract(a.granted_resources_json,'$.problem_binding')) = p.id))
            OR (p.status <> 'private-draft' AND m.role IN ('contributor','steward')
              AND EXISTS(SELECT 1 FROM json_each(a.granted_scopes_json) WHERE value = 'promote')))
          AND NOT EXISTS(SELECT 1 FROM private_draft_erasures WHERE problem_id = p.id)
          AND (SELECT COUNT(*) FROM problem_statement_proposals WHERE problem_id = p.id
            AND fellow_id = a.fellow_id AND accepted_at IS NULL AND base_statement_version = p.current_statement_version) < 64`)
        .bind(
          ...values,
          proposalId,
          request.base_statement_version,
          payload,
          payloadDigest,
          createdAt,
          problemId,
          request.session_id,
          state.status,
        ),
      db
        .prepare(`INSERT INTO problem_statement_proposal_receipts
        (fellow_id,sponsor_id,problem_id,key_digest,request_digest,proposal_id,created_at,expires_at)
        SELECT fellow_id,sponsor_id,problem_id,?,?,proposal_id,?,? FROM problem_statement_proposals WHERE proposal_id = ?`)
        .bind(keyDigest, requestDigest, now, now + TTL, proposalId),
    ]);
  } catch (error) {
    const winner = await replay();
    if (winner) return winner;
    throw error;
  }
  return (await replay()) ?? stale();
}

export async function readOwnStatementProposal(
  db: D1Database,
  binding: FellowCredentialBinding,
  problemId: string,
  proposalId: string,
): Promise<Response> {
  const row = await db
    .prepare(`WITH authority AS (${FELLOW_AUTHORITY})
    SELECT r.* FROM problem_statement_proposals r JOIN authority a
      ON a.fellow_id = r.fellow_id AND a.sponsor_id = r.sponsor_id
    WHERE r.problem_id = ?5 AND r.proposal_id = ?6`)
    .bind(...authorityValues(binding), problemId, proposalId)
    .first<ProposalRow>();
  const proposal = row ? await decode(row) : undefined;
  return proposal ? json({ proposal }) : statementProposalAbsent();
}

export async function listStatementProposals(
  db: D1Database,
  problemId: string,
  sponsorId: string,
  after?: string,
): Promise<Response> {
  const allowed = await db
    .prepare(`SELECT 1 FROM problems p WHERE p.id = ? AND ${SPONSOR_LIVE}
    AND (p.sponsor_id = ? OR EXISTS(SELECT 1 FROM problem_stewards WHERE problem_id = p.id AND sponsor_id = ?))`)
    .bind(problemId, sponsorId, sponsorId, sponsorId, sponsorId)
    .first();
  if (!allowed) return statementProposalAbsent();
  const rows =
    (
      await db
        .prepare(`SELECT r.proposal_id,r.base_statement_version,r.fellow_id,r.sponsor_id,
    r.session_id,r.model_self_declared,r.harness,r.created_at,r.accepted_statement_version
    FROM problem_statement_proposals r JOIN problems p ON p.id = r.problem_id
    WHERE r.problem_id = ? AND r.proposal_id > ? AND ${SPONSOR_LIVE}
      AND (p.sponsor_id = ? OR EXISTS(SELECT 1 FROM problem_stewards WHERE problem_id = p.id AND sponsor_id = ?))
    ORDER BY r.proposal_id LIMIT 17`)
        .bind(problemId, after ?? "", sponsorId, sponsorId, sponsorId, sponsorId)
        .all<ProposalRow>()
    ).results ?? [];
  const hasMore = rows.length > 16,
    page = rows.slice(0, 16);
  return json(
    ProblemStatementProposalListResponseSchema.parse({
      problem_id: problemId,
      acting_sponsor_id: sponsorId,
      proposals: page.map(summary),
      next_after: hasMore ? (page.at(-1)?.proposal_id ?? null) : null,
      omitted: hasMore ? ["page_limit"] : [],
    }),
  );
}

export interface StatementRevisionSnapshot {
  readonly row: SnapshotRow;
  readonly preview: ProblemStatementRevisionPreview;
}
export async function loadStatementRevisionSnapshot(
  db: D1Database,
  problemId: string,
  proposalId: string,
  sponsorId: string,
): Promise<StatementRevisionSnapshot | undefined> {
  const row = await db
    .prepare(`SELECT r.*,p.title,p.status AS problem_status,p.current_statement_version,
    p.stewardship_version, p.admission_mode, ${sourceAuthoritySql("r")} AS source_live
    FROM problem_statement_proposals r JOIN problems p ON p.id = r.problem_id
    WHERE r.problem_id = ? AND r.proposal_id = ? AND ${SPONSOR_LIVE}
      AND (p.sponsor_id = ? OR EXISTS(SELECT 1 FROM problem_stewards WHERE problem_id = p.id AND sponsor_id = ?))
      AND NOT EXISTS(SELECT 1 FROM private_draft_erasures WHERE problem_id = p.id)`)
    .bind(problemId, proposalId, sponsorId, sponsorId, sponsorId, sponsorId)
    .first<SnapshotRow>();
  if (!row) return undefined;
  const proposal = await decode(row);
  if (!proposal) return undefined;
  const value = {
    problem: {
      id: problemId,
      title: row.title,
      status: row.problem_status,
      current_statement_version: row.current_statement_version,
    },
    proposal,
    acting_sponsor_id: sponsorId,
    can_accept:
      row.accepted_at === null &&
      row.source_live === 1 &&
      row.admission_mode !== "archived-read-only" &&
      row.current_statement_version === row.base_statement_version &&
      ["private-draft", "sharpening", "active", "dormant", "under-result-review"].includes(
        row.problem_status,
      ),
  };
  const digest = await sha256Hex(
    canonicalJson({
      schema: "statement-revision-review.v1",
      preview: value,
      payload_digest: row.payload_digest,
      stewardship_version: row.stewardship_version,
    }),
  );
  return {
    row,
    preview: ProblemStatementRevisionPreviewSchema.parse({ ...value, review_digest: digest }),
  };
}

/** Bind exact stored prose/attribution, base version, current source authority
 * and reviewed steward roster into the same transaction as acceptance. */
export function statementRevisionGuard(snapshot: StatementRevisionSnapshot) {
  const { row, preview } = snapshot;
  return {
    sql: ` AND stewardship_version = ? AND admission_mode <> 'archived-read-only' AND EXISTS(
    SELECT 1 FROM problem_statement_proposals r WHERE r.proposal_id = ? AND r.problem_id = ?
      AND r.payload_json = ? AND r.payload_digest = ? AND r.base_statement_version = ?
      AND r.fellow_id = ? AND r.sponsor_id = ? AND r.session_id = ?
      AND r.model_self_declared = ? AND r.harness = ? AND r.created_at = ?
      AND r.accepted_at IS NULL AND ${sourceAuthoritySql("r")})
    AND ${SPONSOR_LIVE}`,
    bindings: [
      row.stewardship_version,
      row.proposal_id,
      row.problem_id,
      row.payload_json,
      row.payload_digest,
      row.base_statement_version,
      row.fellow_id,
      row.sponsor_id,
      row.session_id,
      row.model_self_declared,
      row.harness,
      row.created_at,
      preview.acting_sponsor_id,
      preview.acting_sponsor_id,
    ],
  };
}
export const statementRevisionStale = stale;
export function statementProposalAcceptanceStatement(
  db: D1Database,
  snapshot: StatementRevisionSnapshot,
  version: number,
  at: string,
  eventId: string,
): D1PreparedStatement {
  return db
    .prepare(`UPDATE problem_statement_proposals SET accepted_statement_version = ?,accepted_at = ?,accepted_event_id = ?
    WHERE proposal_id = ? AND accepted_at IS NULL AND EXISTS(SELECT 1 FROM events WHERE id = ?)`)
    .bind(version, at, eventId, snapshot.row.proposal_id, eventId);
}

type AcceptAction = Extract<ProblemLifecycleActionRequest, { action: "revise-statement" }>;
export function statementRevisionReceipt(
  action: AcceptAction,
  sourceFellowId: string,
  eventId: string | null,
) {
  return {
    proposal_id: action.proposal_id,
    reviewed_digest: action.reviewed_digest,
    base_statement_version: action.reviewed_statement_version,
    accepted_statement_version: action.reviewed_statement_version + 1,
    source_fellow_id: sourceFellowId,
    event_id: eventId,
  };
}

export async function replayPrivateStatementAcceptance(
  db: D1Database,
  problemId: string,
  sponsorId: string,
  action: AcceptAction,
  key: string | null,
): Promise<Response | undefined> {
  const parsedKey = ProblemGovernanceKeySchema.safeParse(key);
  if (!parsedKey.success) return badKey();
  const digest = await sha256Hex(
    canonicalJson({ problem_id: problemId, sponsor_id: sponsorId, action }),
  );
  const receipt = await db
    .prepare(`SELECT * FROM private_statement_acceptance_receipts
    WHERE problem_id = ? AND sponsor_id = ? AND key_digest = ? AND expires_at > ? AND ${SPONSOR_LIVE}`)
    .bind(problemId, sponsorId, await sha256Hex(parsedKey.data), Date.now(), sponsorId, sponsorId)
    .first<{
      request_digest: string;
      proposal_id: string;
      source_fellow_id: string;
      accepted_at: string;
      accepted_statement_version: number;
    }>();
  if (!receipt) return undefined;
  if (receipt.request_digest !== digest) return conflict();
  return json(
    ProblemStatementRevisionResponseSchema.parse({
      problem: {
        id: problemId,
        status: "private-draft",
        current_statement_version: receipt.accepted_statement_version,
        updated_at: receipt.accepted_at,
      },
      statement_revision: statementRevisionReceipt(action, receipt.source_fellow_id, null),
    }),
  );
}

export async function acceptPrivateStatementProposal(
  db: D1Database,
  problemId: string,
  sponsorId: string,
  action: AcceptAction,
  key: string | null,
): Promise<Response> {
  const previous = await replayPrivateStatementAcceptance(db, problemId, sponsorId, action, key);
  if (previous) return previous;
  const snapshot = await loadStatementRevisionSnapshot(
    db,
    problemId,
    action.proposal_id,
    sponsorId,
  );
  if (
    !snapshot?.preview.can_accept ||
    snapshot.row.problem_status !== "private-draft" ||
    snapshot.preview.review_digest !== action.reviewed_digest ||
    snapshot.row.base_statement_version !== action.reviewed_statement_version
  )
    return (
      (await replayPrivateStatementAcceptance(db, problemId, sponsorId, action, key)) ?? stale()
    );
  const p = snapshot.preview.proposal,
    now = new Date().toISOString(),
    version = p.base_statement_version + 1;
  const guard = statementRevisionGuard(snapshot);
  const keyDigest = await sha256Hex(key as string);
  const digest = await sha256Hex(
    canonicalJson({ problem_id: problemId, sponsor_id: sponsorId, action }),
  );
  const commandGuard = `EXISTS(SELECT 1 FROM private_statement_acceptance_receipts WHERE problem_id = ? AND sponsor_id = ? AND key_digest = ? AND accepted_at = ?)`;
  const commandValues = [problemId, sponsorId, keyDigest, now];
  try {
    await db.batch([
      db
        .prepare(
          "DELETE FROM private_statement_acceptance_receipts WHERE problem_id = ? AND sponsor_id = ? AND key_digest = ? AND expires_at <= ?",
        )
        .bind(problemId, sponsorId, keyDigest, Date.now()),
      db
        .prepare(`INSERT INTO private_statement_acceptance_receipts
        (problem_id,sponsor_id,key_digest,request_digest,proposal_id,source_fellow_id,accepted_statement_version,accepted_at,expires_at)
        SELECT id,?,?,?,?,?,?,?,? FROM problems WHERE id = ? AND status = 'private-draft' AND public_seq = 0
          AND current_statement_version = ? AND NOT EXISTS(SELECT 1 FROM events WHERE problem_id = problems.id)
          AND (sponsor_id = ? OR EXISTS(SELECT 1 FROM problem_stewards WHERE problem_id = problems.id AND sponsor_id = ?))
          ${guard.sql}`)
        .bind(
          sponsorId,
          keyDigest,
          digest,
          p.proposal_id,
          p.author.fellow_id,
          version,
          now,
          Date.parse(now) + TTL,
          problemId,
          p.base_statement_version,
          sponsorId,
          sponsorId,
          ...guard.bindings,
        ),
      db
        .prepare(`INSERT INTO problem_statement_versions
        (problem_id,version,statement,norm_hash,falsifier,motivation,scope,out_of_scope,success_criteria,steward_accepted_by,created_at,scientific_author_json)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${commandGuard}`)
        .bind(
          problemId,
          version,
          p.statement,
          `sha256:${await normHash(p.statement)}`,
          p.falsifier,
          p.motivation,
          p.scope ?? null,
          p.out_of_scope ?? null,
          p.success_criteria ?? null,
          sponsorId,
          now,
          canonicalJson(p.author),
          ...commandValues,
        ),
      db
        .prepare(
          `UPDATE problems SET current_statement_version = ?,updated_at = ? WHERE id = ? AND ${commandGuard}`,
        )
        .bind(version, now, problemId, ...commandValues),
      db
        .prepare(`UPDATE problem_statement_proposals SET accepted_statement_version = ?,accepted_at = ?
        WHERE proposal_id = ? AND accepted_at IS NULL AND ${commandGuard}`)
        .bind(version, now, p.proposal_id, ...commandValues),
    ]);
  } catch (error) {
    const winner = await replayPrivateStatementAcceptance(db, problemId, sponsorId, action, key);
    if (winner) return winner;
    throw error;
  }
  return (await replayPrivateStatementAcceptance(db, problemId, sponsorId, action, key)) ?? stale();
}
