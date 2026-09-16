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
): EnrollmentNextAction[] {
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
  const nextActions = buildNoticeNextActions(row.notice_type, row.problem_id);
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
  const id =
    input.id ??
    `NOT-${now.toString(36)}-${crypto.randomUUID().replace(/-/g, "").substring(0, 8).toUpperCase()}`;

  // Compute next monotonic seq for this fellow
  const seqRow = await db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM fellow_inbox_notices WHERE fellow_id = ?",
    )
    .bind(input.fellowId)
    .first<{ next_seq: number }>();
  const seq = seqRow?.next_seq ?? 1;

  await db
    .prepare(
      `INSERT INTO fellow_inbox_notices (
         id, fellow_id, problem_id, notice_type, seq, title, detail,
         impact_kind, caused_by_event_id, target_id, acknowledged_at,
         expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      id,
      input.fellowId,
      input.problemId ?? null,
      input.noticeType,
      seq,
      input.title,
      input.detail ?? null,
      input.impactKind ?? null,
      input.causedByEventId ?? null,
      input.targetId ?? null,
      input.expiresAt ?? null,
      now,
    )
    .run();

  // OPS.2a structured diagnostic log
  console.info(
    JSON.stringify({
      facility: "OPS.2a",
      stage: "inbox-notice-created",
      notice_id: id,
      fellow_id: input.fellowId,
      notice_type: input.noticeType,
      seq,
      caused_by_event_id: input.causedByEventId ?? null,
      timestamp: now,
    }),
  );

  return rowToItem({
    id,
    fellow_id: input.fellowId,
    problem_id: input.problemId ?? null,
    notice_type: input.noticeType,
    seq,
    title: input.title,
    detail: input.detail ?? null,
    impact_kind: input.impactKind ?? null,
    caused_by_event_id: input.causedByEventId ?? null,
    target_id: input.targetId ?? null,
    acknowledged_at: null,
    expires_at: input.expiresAt ?? null,
    created_at: now,
  });
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
    WHERE fellow_id = ?
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
    .prepare(
      "SELECT COUNT(*) AS unack FROM fellow_inbox_notices WHERE fellow_id = ? AND acknowledged_at IS NULL",
    )
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
    `;
    const result = await db
      .prepare(updateSql)
      .bind(now, fellowId, ...request.notice_ids)
      .run();
    acknowledgedCount = result.meta?.changes ?? request.notice_ids.length;
  } else if (request.until_seq !== undefined) {
    const updateSql = `
      UPDATE fellow_inbox_notices
      SET acknowledged_at = ?
      WHERE fellow_id = ?
        AND seq <= ?
        AND acknowledged_at IS NULL
    `;
    const result = await db.prepare(updateSql).bind(now, fellowId, request.until_seq).run();
    acknowledgedCount = result.meta?.changes ?? 0;
  }

  // Check remaining unacknowledged count
  const unackRow = await db
    .prepare(
      "SELECT COUNT(*) AS unack FROM fellow_inbox_notices WHERE fellow_id = ? AND acknowledged_at IS NULL",
    )
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

export async function followProblem(
  db: D1Database,
  principalId: string,
  problemId: string,
  now: number = Date.now(),
): Promise<{ notFound?: boolean; response?: ProblemFollowResponse }> {
  // Check problem exists
  const problemRow = await db
    .prepare("SELECT id FROM problems WHERE id = ?")
    .bind(problemId)
    .first<{ id: string }>();

  if (!problemRow) {
    return { notFound: true };
  }

  await db
    .prepare(
      `INSERT INTO problem_follows (principal_id, problem_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT (principal_id, problem_id) DO NOTHING`,
    )
    .bind(principalId, problemId, now)
    .run();

  const followRow = await db
    .prepare("SELECT created_at FROM problem_follows WHERE principal_id = ? AND problem_id = ?")
    .bind(principalId, problemId)
    .first<{ created_at: number }>();

  // OPS.2a structured diagnostic log
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
      followed_at: followRow?.created_at ?? now,
    },
  };
}

export async function unfollowProblem(
  db: D1Database,
  principalId: string,
  problemId: string,
  now: number = Date.now(),
): Promise<{ notFound?: boolean; response?: ProblemFollowResponse }> {
  // Check problem exists
  const problemRow = await db
    .prepare("SELECT id FROM problems WHERE id = ?")
    .bind(problemId)
    .first<{ id: string }>();

  if (!problemRow) {
    return { notFound: true };
  }

  await db
    .prepare("DELETE FROM problem_follows WHERE principal_id = ? AND problem_id = ?")
    .bind(principalId, problemId)
    .run();

  // OPS.2a structured diagnostic log
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
  // Check problem exists
  const problemRow = await db
    .prepare("SELECT id FROM problems WHERE id = ?")
    .bind(problemId)
    .first<{ id: string }>();

  if (!problemRow) {
    return { notFound: true };
  }

  const followRow = await db
    .prepare("SELECT created_at FROM problem_follows WHERE principal_id = ? AND problem_id = ?")
    .bind(principalId, problemId)
    .first<{ created_at: number }>();

  return {
    response: {
      problem_id: problemId,
      following: followRow !== null && followRow !== undefined,
      followed_at: followRow ? followRow.created_at : null,
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
    .prepare(
      `SELECT DISTINCT principal_id FROM (
         SELECT principal_id FROM problem_follows WHERE problem_id = ?
         UNION
         SELECT fellow_id AS principal_id FROM problem_memberships WHERE problem_id = ?
       ) WHERE principal_id IS NOT NULL`,
    )
    .bind(problemId, problemId)
    .all<{ principal_id: string }>();

  const fellows = (rows.results ?? [])
    .map((r) => r.principal_id)
    .filter((id) => typeof id === "string" && !id.startsWith("asimp_sp_"));

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
