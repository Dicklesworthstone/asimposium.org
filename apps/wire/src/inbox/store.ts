import type {
  EnrollmentNextAction,
  ImpactEchoKind,
  InboxAckRequest,
  InboxAckResponse,
  InboxItem,
  InboxNoticeType,
  InboxQuery,
  InboxResponse,
  ProblemFollowResponse,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import {
  FOLLOW_DELETE_SQL,
  FOLLOW_INSERT_SQL,
  FOLLOW_RECIPIENTS_SQL,
  FOLLOW_STATUS_SQL,
  INBOX_UNACKNOWLEDGED_SQL,
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
}

function buildNoticeNextActions(
  noticeType: string,
  problemId?: string | null,
  targetId?: string | null,
): EnrollmentNextAction[] {
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

function rowToItem(row: NoticeRow): InboxItem {
  const nextActions = [
    ...buildNoticeNextActions(row.notice_type, row.problem_id, row.target_id),
    ...ledgerNoticeActions(row.notice_type, row.problem_id, row.target_id, row.impact_kind),
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
): Promise<InboxResponse> {
  const limit = query.limit ?? 50;
  const since = query.since;
  const unreadOnly = query.unread_only ?? false;

  let sql = `
    SELECT id, fellow_id, problem_id, notice_type, seq, title, detail,
           impact_kind, caused_by_event_id, target_id, acknowledged_at,
           expires_at, created_at
    FROM fellow_inbox_notices
    WHERE fellow_id = ? AND ${VISIBLE_INBOX_NOTICE_SQL}
  `;
  const binds: (string | number)[] = [fellowId];

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
  const items = slicedRows.map(rowToItem);

  const nextCursor = items.length > 0 ? (items[items.length - 1]?.seq ?? null) : null;

  // Total unacknowledged count for this fellow
  const unackRow = await db
    .prepare(INBOX_UNACKNOWLEDGED_SQL)
    .bind(fellowId)
    .first<{ unack: number }>();
  const unacknowledgedCount = unackRow?.unack ?? 0;

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
    `;
    const result = await db
      .prepare(updateSql)
      .bind(now, fellowId, ...request.notice_ids)
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
    `;
    const result = await db.prepare(updateSql).bind(now, fellowId, request.until_seq).run();
    acknowledgedCount = result.meta?.changes ?? 0;
  }

  // Check remaining unacknowledged count
  const unackRow = await db
    .prepare(INBOX_UNACKNOWLEDGED_SQL)
    .bind(fellowId)
    .first<{ unack: number }>();
  const unacknowledgedCount = unackRow?.unack ?? 0;

  // OPS.2a structured diagnostic log
  console.info(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "inbox-ack",
      fellow_id: fellowId,
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
