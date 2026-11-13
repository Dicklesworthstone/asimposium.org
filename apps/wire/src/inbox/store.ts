import {
  type EnrollmentNextAction,
  type ImpactEchoKind,
  type InboxAckRequest,
  type InboxAckResponse,
  type InboxItem,
  type InboxNoticeType,
  type InboxQuery,
  type InboxResponse,
  type ProblemFollowResponse,
  ProblemIdSchema,
  ScreeningPromotionHoldResponseSchema,
  SessionIdSchema,
} from "@asimposium/contracts";
import { ArtifactPublicationReceiptSchema } from "@asimposium/contracts/artifact-publications";
import type { D1Database } from "@cloudflare/workers-types";
import { ACTIVE_DIRECTIVE_AUTHORITY_SQL } from "../directives/active-source.ts";
import type { FellowCredentialBinding } from "../enrollment/service.ts";
import {
  FOLLOW_DELETE_SQL,
  FOLLOW_INSERT_SQL,
  FOLLOW_RECIPIENTS_SQL,
  FOLLOW_STATUS_SQL,
  INBOX_UNACKNOWLEDGED_SQL,
  UNEXPIRED_INBOX_NOTICE_SQL,
  VISIBLE_INBOX_NOTICE_SQL,
} from "./follow-access.ts";
import { ledgerNoticeActions } from "./ledger-notice-actions.ts";
import {
  INBOX_NOTICE_RECEIPT_SQL,
  INSERT_INBOX_NOTICE_ONCE_SQL,
  inboxNoticeId,
} from "./notice-write.ts";
import { reviewInvitationLink } from "./review-invitation-link.ts";

export interface NoticeCreateInput {
  id?: string;
  fellowId: string;
  problemId?: string | null;
  noticeType: InboxNoticeType;
  title: string;
  detail?: string | null;
  impactKind?: ImpactEchoKind | null;
  causedByEventId?: string | null;
  targetId?: string | null;
  expiresAt?: number | null;
  createdAt?: number;
}

export class InboxReadAuthorityError extends Error {
  constructor() {
    super("INBOX_READ_AUTHORITY_CHANGED");
  }
}

export interface InboxReadAuthority {
  readonly binding: FellowCredentialBinding;
  readonly revalidate: () => Promise<FellowCredentialBinding | undefined>;
}

function sameInboxAuthority(
  before: FellowCredentialBinding,
  after: FellowCredentialBinding,
): boolean {
  return (
    after.fellowId === before.fellowId &&
    after.sponsorId === before.sponsorId &&
    after.credentialId === before.credentialId &&
    after.tokenHash === before.tokenHash &&
    after.credentialProfile === before.credentialProfile &&
    after.fellowStatus === before.fellowStatus &&
    after.name === before.name &&
    after.model === before.model &&
    after.harness === before.harness &&
    after.issuedAt === before.issuedAt &&
    after.expiresAt === before.expiresAt &&
    after.revokedAt === before.revokedAt &&
    JSON.stringify(after.grantedScopes) === JSON.stringify(before.grantedScopes) &&
    JSON.stringify(after.grantedResources) === JSON.stringify(before.grantedResources)
  );
}

// This is a continuation guard for an already canonically authenticated
// binding, not a second way to authenticate. Pin that original authority as
// well as the shared mutable credential checks. Scope order and object-key
// order are immaterial; all supported resource values are scalar.
const INBOX_READ_AUTHORITY_SQL = `${ACTIVE_DIRECTIVE_AUTHORITY_SQL}
  AND t.issued_at >= g.granted_at
  AND t.issued_at = ?10 AND t.expires_at = ?11
  AND t.credential_profile = ?12 AND f.status = ?13
  AND f.name = ?14 AND f.model = ?15 AND f.harness = ?16
  AND (SELECT COUNT(*) FROM json_each(t.granted_scopes_json)) =
    (SELECT COUNT(*) FROM json_each(?8))
  AND NOT EXISTS (
    SELECT type, atom FROM json_each(t.granted_scopes_json)
    EXCEPT SELECT type, atom FROM json_each(?8)
  )
  AND NOT EXISTS (
    SELECT type, atom FROM json_each(?8)
    EXCEPT SELECT type, atom FROM json_each(t.granted_scopes_json)
  )
  AND (SELECT COUNT(*) FROM json_each(t.granted_resources_json)) =
    (SELECT COUNT(*) FROM json_each(?9))
  AND NOT EXISTS (
    SELECT key, type, atom FROM json_each(t.granted_resources_json)
    EXCEPT SELECT key, type, atom FROM json_each(?9)
  )
  AND NOT EXISTS (
    SELECT key, type, atom FROM json_each(?9)
    EXCEPT SELECT key, type, atom FROM json_each(t.granted_resources_json)
  )`;

interface NoticeRow {
  id: string;
  fellow_id: string;
  problem_id: string | null;
  notice_type: string;
  seq: number;
  title: string;
  detail: string | null;
  impact_kind: string | null;
  caused_by_event_id: string | null;
  target_id: string | null;
  acknowledged_at: number | null;
  expires_at: number | null;
  created_at: number;
  source_evidence_id?: string | null;
  source_review_id?: string | null;
}

const reviewCaseIdSchema = ScreeningPromotionHoldResponseSchema.options[0].shape.case_id.unwrap();

/** Enrich only this returned page, without reading artifact bytes or granting
 * publication consent. A notice's exact case, problem and recipient must all
 * agree with the existing immutable publication binding. */
async function artifactPublicationNoticePaths(
  db: D1Database,
  fellowId: string,
  rows: readonly NoticeRow[],
): Promise<Map<string, string>> {
  const candidates = rows
    .filter(
      (row) =>
        row.notice_type === "moderation_outcome" &&
        reviewCaseIdSchema.safeParse(row.target_id).success &&
        ProblemIdSchema.safeParse(row.problem_id).success,
    )
    .map((row) => ({ id: row.id, case_id: row.target_id, problem_id: row.problem_id }));
  const paths = new Map<string, string>();
  if (candidates.length === 0) return paths;

  // One bounded JSON parameter avoids both an N+1 lookup and D1's bind limit.
  const result = await db
    .prepare(`SELECT json_extract(n.value, '$.id') AS notice_id, b.publication_id
      FROM json_each(?) n
      JOIN artifact_publication_reviews r ON r.case_id = json_extract(n.value, '$.case_id')
      JOIN artifact_publications b ON b.publication_id = r.publication_id
      WHERE b.fellow_id = ? AND b.problem_id = json_extract(n.value, '$.problem_id')`)
    .bind(JSON.stringify(candidates), fellowId)
    .all<{ notice_id: string; publication_id: string }>();
  if (!result.success) throw new Error("Artifact notice status lookup is unavailable.");
  for (const row of result.results ?? []) {
    const path = ArtifactPublicationReceiptSchema.shape.status_path.safeParse(
      `/v1/artifact-publications/${row.publication_id}`,
    );
    if (!path.success) continue;
    if (paths.has(row.notice_id)) throw new Error("Artifact notice status binding is ambiguous.");
    paths.set(row.notice_id, path.data);
  }
  return paths;
}

/** A protocol notice may target a closed session. Resolve only the returned
 * page against its recipient and problem; prose and an id-shaped target do
 * not establish a recovery context. The read grants no write permission. */
async function closedSessionNoticePaths(
  db: D1Database,
  fellowId: string,
  rows: readonly NoticeRow[],
): Promise<Map<string, string>> {
  const candidates = rows
    .filter(
      (row) =>
        row.notice_type === "protocol_notice" &&
        SessionIdSchema.safeParse(row.target_id).success &&
        row.target_id === row.target_id?.trim() &&
        ProblemIdSchema.safeParse(row.problem_id).success,
    )
    .map((row) => ({ id: row.id, session_id: row.target_id, problem_id: row.problem_id }));
  const paths = new Map<string, string>();
  if (candidates.length === 0) return paths;

  const result = await db
    .prepare(`SELECT json_extract(n.value, '$.id') AS notice_id, s.session_id
      FROM json_each(?) n JOIN sessions s
        ON s.session_id = json_extract(n.value, '$.session_id')
        AND s.problem_id = json_extract(n.value, '$.problem_id')
      WHERE s.fellow_id = ? AND s.closed_at IS NOT NULL`)
    .bind(JSON.stringify(candidates), fellowId)
    .all<{ notice_id: string; session_id: string }>();
  if (!result.success) throw new Error("Session notice recovery lookup is unavailable.");
  for (const row of result.results ?? []) {
    if (paths.has(row.notice_id)) throw new Error("Session notice recovery binding is ambiguous.");
    paths.set(row.notice_id, `/v1/sessions/${row.session_id}`);
  }
  return paths;
}

function buildNoticeNextActions(
  noticeType: string,
  problemId?: string | null,
  targetId?: string | null,
  artifactStatusPath?: string,
  closedSessionPath?: string,
): EnrollmentNextAction[] {
  if (noticeType === "protocol_notice" && closedSessionPath !== undefined) {
    return [
      {
        action: "orient",
        url: closedSessionPath,
        reason:
          "Inspect this closed session before opening another session to continue your private workshop.",
      },
    ];
  }
  if (noticeType === "moderation_outcome" && artifactStatusPath !== undefined) {
    return [
      {
        action: "orient",
        url: artifactStatusPath,
        reason:
          "Inspect this artifact publication's current delivery and recovery state before deciding whether to retry.",
      },
    ];
  }
  const invitation = reviewInvitationLink(problemId, targetId);
  if (noticeType === "review_decline" && invitation !== null) {
    return [
      {
        action: "orient",
        url: invitation,
        reason:
          "The invited reviewer declined. Inspect the invitation's current state before requesting another review.",
      },
    ];
  }
  if (noticeType === "review_request" && invitation !== null) {
    return [
      {
        action: "review",
        url: invitation,
        reason:
          "Inspect the invitation's current state before accepting, declining or recording completion. This notice is not a scientific verdict.",
      },
    ];
  }
  switch (noticeType) {
    case "sponsor_directive":
      return [
        {
          action: "acknowledge",
          url: "/v1/inbox/ack",
          reason: "Confirm receipt of sponsor directive.",
        },
      ];
    case "statement_revision":
      return [
        {
          action: "orient",
          url: problemId ? `/v1/p/${problemId}/next` : "/v1/triage",
          reason: "Orient with the new statement revision before further writes.",
        },
      ];
    case "lease_expiry_warning":
      return [
        {
          action: "orient",
          url: problemId ? `/v1/p/${problemId}/next` : "/v1/triage",
          reason: "Finish and hand back, or release the lease if the work is done or abandoned.",
        },
      ];
    case "review_request":
      return [
        {
          action: "review",
          url: problemId ? `/v1/p/${problemId}/next` : "/v1/triage",
          reason: "Review requested peer submission.",
        },
      ];
    default:
      return [];
  }
}

function rowToItem(
  row: NoticeRow,
  artifactStatusPath?: string,
  closedSessionPath?: string,
): InboxItem {
  const nextActions = [
    ...buildNoticeNextActions(
      row.notice_type,
      row.problem_id,
      row.target_id,
      artifactStatusPath,
      closedSessionPath,
    ),
    ...ledgerNoticeActions(
      row.notice_type,
      row.problem_id,
      row.target_id,
      row.impact_kind,
      row.source_evidence_id,
      row.source_review_id,
    ),
  ];
  return {
    id: row.id,
    type: row.notice_type as InboxNoticeType,
    seq: row.seq,
    created_at: row.created_at,
    acknowledged_at: row.acknowledged_at,
    expires_at: row.expires_at,
    caused_by_event_id: row.caused_by_event_id,
    problem_id: row.problem_id,
    target_id: row.target_id,
    title: row.title,
    detail: row.detail,
    impact_kind: (row.impact_kind as ImpactEchoKind) ?? null,
    ...(nextActions.length > 0 ? { next_actions: nextActions } : {}),
  };
}

export async function createInboxNotice(
  db: D1Database,
  input: NoticeCreateInput,
): Promise<InboxItem> {
  const now = input.createdAt ?? Date.now();
  const id = await inboxNoticeId(input);
  // Read the durable row in the same transaction as the guarded insert. A
  // replay returns the original text, timestamp, expiry and acknowledgment;
  // it cannot turn an already-read notice back into a fresh unread item.
  const results = await db.batch<NoticeRow>([
    db
      .prepare(INSERT_INBOX_NOTICE_ONCE_SQL)
      .bind(
        id,
        input.fellowId,
        input.problemId ?? null,
        input.noticeType,
        input.fellowId,
        input.title,
        input.detail ?? null,
        input.impactKind ?? null,
        input.causedByEventId ?? null,
        input.targetId ?? null,
        input.expiresAt ?? null,
        now,
      ),
    db
      .prepare(INBOX_NOTICE_RECEIPT_SQL)
      .bind(
        input.fellowId,
        input.problemId ?? null,
        input.noticeType,
        input.impactKind ?? null,
        input.causedByEventId ?? null,
        input.targetId ?? null,
        id,
      ),
  ]);
  const receipt = results[1]?.results[0];
  if (!receipt || !Number.isSafeInteger(receipt.seq) || receipt.seq < 1) {
    throw new Error("Inbox notice insertion produced no valid cursor receipt.");
  }

  // OPS.2a structured diagnostic log; replay is not a newly created notice.
  console.info(
    JSON.stringify({
      facility: "OPS.2a",
      stage: results[0]?.results.length ? "inbox-notice-created" : "inbox-notice-replayed",
      notice_id: receipt.id,
      fellow_id: input.fellowId,
      notice_type: input.noticeType,
      seq: receipt.seq,
      caused_by_event_id: input.causedByEventId ?? null,
      timestamp: now,
    }),
  );

  return rowToItem(receipt);
}

export async function getInboxNotices(
  db: D1Database,
  fellowId: string,
  query: InboxQuery,
  now: number = Date.now(),
  authority?: InboxReadAuthority,
): Promise<InboxResponse> {
  if (authority !== undefined && authority.binding.fellowId !== fellowId)
    throw new InboxReadAuthorityError();
  const limit = query.limit ?? 50;
  const since = query.since;
  const unreadOnly = query.unread_only ?? false;

  let sql = `
    SELECT id, fellow_id, problem_id, notice_type, seq, title, detail,
           impact_kind, caused_by_event_id, target_id, acknowledged_at,
           expires_at, created_at,
           (SELECT e.object_id FROM events e JOIN event_content c ON c.event_id = e.id
             WHERE e.id = fellow_inbox_notices.caused_by_event_id
             AND e.problem_id = fellow_inbox_notices.problem_id
             AND e.type = 'evidence.created' AND e.object_kind = 'evidence'
             AND e.object_version = 1
             AND (fellow_inbox_notices.target_id LIKE 'H-%' OR
               CASE WHEN c.redacted_at IS NULL AND json_valid(c.payload_json)
                 AND c.payload_sha256 = e.payload_sha256 THEN
                   json_extract(c.payload_json, '$.bears_on_kind') = 'claim'
                   AND fellow_inbox_notices.target_id =
                     json_extract(c.payload_json, '$.bears_on_id') || '@' ||
                     json_extract(c.payload_json, '$.bears_on_version')
               ELSE 0 END)) AS source_evidence_id,
           (SELECT e.object_id FROM events e JOIN event_content c ON c.event_id = e.id
             WHERE e.id = fellow_inbox_notices.caused_by_event_id
               AND e.problem_id = fellow_inbox_notices.problem_id
               AND e.type = 'review.created' AND e.object_kind = 'review'
               AND e.object_version = 1
               AND CASE WHEN c.redacted_at IS NULL AND json_valid(c.payload_json)
                 AND c.payload_sha256 = e.payload_sha256 THEN
                   fellow_inbox_notices.target_id =
                     json_extract(c.payload_json, '$.target_claim_id') || '@' ||
                     json_extract(c.payload_json, '$.target_version')
               ELSE 0 END) AS source_review_id
    FROM fellow_inbox_notices
    WHERE fellow_id = ? AND ${VISIBLE_INBOX_NOTICE_SQL} AND ${UNEXPIRED_INBOX_NOTICE_SQL}
  `;
  const binds: (string | number)[] = [fellowId, now];

  if (since !== undefined) {
    sql += " AND seq > ?";
    binds.push(since);
  }

  if (unreadOnly) {
    sql += " AND acknowledged_at IS NULL";
  }

  sql += " ORDER BY seq ASC LIMIT ?";
  binds.push(limit + 1);

  const stmt = db.prepare(sql);
  const rowsResult = await stmt.bind(...binds).all<NoticeRow>();
  const rows = rowsResult.results ?? [];

  const hasMore = rows.length > limit;
  const slicedRows = hasMore ? rows.slice(0, limit) : rows;
  const artifactPaths = await artifactPublicationNoticePaths(db, fellowId, slicedRows);
  const sessionPaths = await closedSessionNoticePaths(db, fellowId, slicedRows);
  const items = slicedRows.map((row) =>
    rowToItem(row, artifactPaths.get(row.id), sessionPaths.get(row.id)),
  );

  const nextCursor = items.length > 0 ? (items[items.length - 1]?.seq ?? null) : null;

  // Canonical reauthentication still proves enrollment, transfer and grant
  // origins. It happens BEFORE the final snapshot: a membership change during
  // that await must not invalidate an earlier notice-visibility check.
  if (authority !== undefined) {
    let currentBinding: FellowCredentialBinding | undefined;
    try {
      currentBinding = await authority.revalidate();
    } catch {
      // A failed authority lookup cannot release any previous private data.
    }
    if (!currentBinding || !sameInboxAuthority(authority.binding, currentBinding))
      throw new InboxReadAuthorityError();
  }

  // Hydration may await other reads after this page was selected. Recheck
  // every returned row AND the lookahead under the same current visibility
  // and credential snapshot as the count. A lost private membership or
  // withdrawn hypothesis notice must not survive as content, a count or a
  // has_more existence hint. No service/storage await follows this statement.
  const current = await db
    .prepare(`WITH authority AS (
      ${authority === undefined ? "SELECT 1 AS permitted" : INBOX_READ_AUTHORITY_SQL}
    ), eligible AS (
      SELECT * FROM fellow_inbox_notices WHERE fellow_id = ?1
        AND ${VISIBLE_INBOX_NOTICE_SQL}
        AND ${UNEXPIRED_INBOX_NOTICE_SQL.replace("?", "?6")}
    ) SELECT
      (SELECT COUNT(*) FROM eligible WHERE acknowledged_at IS NULL) AS unack,
      (SELECT COUNT(*) FROM eligible n JOIN json_each(?7) pin
        ON n.id = json_extract(pin.value, '$.id')
        AND n.seq = json_extract(pin.value, '$.seq')
        AND n.acknowledged_at IS json_extract(pin.value, '$.acknowledged_at')) AS matched
    FROM authority`)
    .bind(
      fellowId,
      authority?.binding.sponsorId ?? null,
      // Inbox discovery remains global to this Fellow; a problem-specific
      // read scope is not silently introduced by the shared authority guard.
      null,
      authority?.binding.credentialId ?? null,
      authority?.binding.tokenHash ?? null,
      authority === undefined ? now : Date.now(),
      JSON.stringify(rows.map(({ id, seq, acknowledged_at }) => ({ id, seq, acknowledged_at }))),
      ...(authority === undefined
        ? []
        : [
            JSON.stringify(authority.binding.grantedScopes),
            JSON.stringify(authority.binding.grantedResources),
            authority.binding.issuedAt,
            authority.binding.expiresAt,
            authority.binding.credentialProfile,
            authority.binding.fellowStatus,
            authority.binding.name,
            authority.binding.model,
            authority.binding.harness,
          ]),
    )
    .first<{ unack: number; matched: number }>();
  if (!current && authority !== undefined) throw new InboxReadAuthorityError();
  if (
    !current ||
    !Number.isSafeInteger(current.unack) ||
    current.unack < 0 ||
    current.matched !== rows.length
  )
    throw new Error("INBOX_PAGE_CHANGED");
  const unacknowledgedCount = current.unack;

  const omitted: string[] = [];
  if (hasMore) {
    omitted.push("limit_reached");
  }

  return {
    fellow_id: fellowId,
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
    unacknowledged_count: unacknowledgedCount,
    omitted,
  };
}

export async function ackInboxNotices(
  db: D1Database,
  fellowId: string,
  request: InboxAckRequest,
  now: number = Date.now(),
): Promise<InboxAckResponse> {
  let acknowledgedCount = 0;

  if (request.notice_ids && request.notice_ids.length > 0) {
    const placeholders = request.notice_ids.map(() => "?").join(", ");
    const updateSql = `
      UPDATE fellow_inbox_notices
      SET acknowledged_at = ?
      WHERE fellow_id = ?
        AND id IN (${placeholders})
        AND acknowledged_at IS NULL
        AND ${VISIBLE_INBOX_NOTICE_SQL}
        AND ${UNEXPIRED_INBOX_NOTICE_SQL}
    `;
    const result = await db
      .prepare(updateSql)
      .bind(now, fellowId, ...request.notice_ids, now)
      .run();
    acknowledgedCount = result.meta?.changes ?? 0;
  } else if (request.until_seq !== undefined) {
    const updateSql = `
      UPDATE fellow_inbox_notices
      SET acknowledged_at = ?
      WHERE fellow_id = ?
        AND seq <= ?
        AND acknowledged_at IS NULL
        AND ${VISIBLE_INBOX_NOTICE_SQL}
        AND ${UNEXPIRED_INBOX_NOTICE_SQL}
    `;
    const result = await db.prepare(updateSql).bind(now, fellowId, request.until_seq, now).run();
    acknowledgedCount = result.meta?.changes ?? 0;
  }

  // Check remaining unacknowledged count
  const unackRow = await db
    .prepare(INBOX_UNACKNOWLEDGED_SQL)
    .bind(fellowId, now)
    .first<{ unack: number }>();
  const unacknowledgedCount = unackRow?.unack ?? 0;

  // OPS.2a structured diagnostic log
  console.info(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "inbox-ack",
      fellow_id: fellowId,
      notice_ids: request.notice_ids ?? [],
      acknowledged_count: acknowledgedCount,
      unacknowledged_count: unacknowledgedCount,
      until_seq: request.until_seq ?? null,
      timestamp: now,
    }),
  );

  return {
    acknowledged_count: acknowledgedCount,
    unacknowledged_count: unacknowledgedCount,
  };
}

interface FollowStatusRow {
  problem_id: string;
  created_at: number | null;
}

export async function followProblem(
  db: D1Database,
  principalId: string,
  problemId: string,
  now: number = Date.now(),
): Promise<{ notFound?: boolean; response?: ProblemFollowResponse }> {
  // D1 batch is one transaction: visibility cannot change between the guarded
  // mutation and its receipt. A denied target is indistinguishable from absent.
  const results = await db.batch<FollowStatusRow>([
    db.prepare(FOLLOW_INSERT_SQL).bind(principalId, now, problemId, principalId),
    db.prepare(FOLLOW_STATUS_SQL).bind(principalId, problemId, principalId),
  ]);
  const row = results[1]?.results[0];
  if (!row) return { notFound: true };
  if (row.created_at === null) throw new Error("Follow mutation produced no durable receipt.");

  console.info(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "problem-follow",
      principal_id: principalId,
      problem_id: problemId,
      following: true,
      timestamp: now,
    }),
  );

  return {
    response: {
      problem_id: problemId,
      following: true,
      followed_at: row.created_at,
    },
  };
}

export async function unfollowProblem(
  db: D1Database,
  principalId: string,
  problemId: string,
  now: number = Date.now(),
): Promise<{ notFound?: boolean; response?: ProblemFollowResponse }> {
  const results = await db.batch<FollowStatusRow>([
    db.prepare(FOLLOW_DELETE_SQL).bind(principalId, problemId, principalId),
    db.prepare(FOLLOW_STATUS_SQL).bind(principalId, problemId, principalId),
  ]);
  const row = results[1]?.results[0];
  if (!row) return { notFound: true };
  if (row.created_at !== null) throw new Error("Unfollow mutation left a durable follow.");

  console.info(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "problem-unfollow",
      principal_id: principalId,
      problem_id: problemId,
      following: false,
      timestamp: now,
    }),
  );

  return {
    response: {
      problem_id: problemId,
      following: false,
      followed_at: null,
    },
  };
}

export async function getProblemFollowStatus(
  db: D1Database,
  principalId: string,
  problemId: string,
): Promise<{ notFound?: boolean; response?: ProblemFollowResponse }> {
  const row = await db
    .prepare(FOLLOW_STATUS_SQL)
    .bind(principalId, problemId, principalId)
    .first<FollowStatusRow>();
  if (!row) return { notFound: true };
  return {
    response: {
      problem_id: problemId,
      following: row.created_at !== null,
      followed_at: row.created_at,
    },
  };
}

export async function notifyProblemFollowersOfStatementRevision(
  db: D1Database,
  problemId: string,
  statementVersion: number,
  causedByEventId: string,
): Promise<void> {
  const rows = await db
    .prepare(FOLLOW_RECIPIENTS_SQL)
    .bind(problemId)
    .all<{ principal_id: string }>();

  const fellows = (rows.results ?? []).map((row) => row.principal_id);

  for (const fellowId of fellows) {
    await createInboxNotice(db, {
      fellowId,
      problemId,
      noticeType: "statement_revision",
      title: `Problem ${problemId} statement revised (version ${statementVersion})`,
      detail: `The statement for problem ${problemId} was revised to version ${statementVersion}. Re-orient before submitting further writes.`,
      causedByEventId,
    });
  }
}
