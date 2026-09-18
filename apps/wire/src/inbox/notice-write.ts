import type { NoticeCreateInput } from "./store.ts";

/** Allocate the recipient's cursor in the INSERT itself. A separate MAX(seq)
 * preflight lets concurrent producers choose the same cursor and causes a
 * polling client to skip notices. The existing (fellow_id, seq) index supports
 * this lookup; acknowledged/expired history still participates in the head.
 * RETURNING supplies the exact committed cursor, never a guessed receipt. */
export const INSERT_INBOX_NOTICE_SQL = `
  INSERT INTO fellow_inbox_notices (
    id, fellow_id, problem_id, notice_type, seq, title, detail,
    impact_kind, caused_by_event_id, target_id, acknowledged_at,
    expires_at, created_at
  ) VALUES (
    ?, ?, ?, ?,
    (SELECT COALESCE(MAX(seq), 0) + 1 FROM fellow_inbox_notices WHERE fellow_id = ?),
    ?, ?, ?, ?, ?, NULL, ?, ?
  )
  RETURNING seq`;

/** The cause and recipient define a logical delivery, not its retry time or
 * template text. The NOT EXISTS also recognizes notices written with legacy
 * random IDs. Keep the check and cursor allocation in the same SQL statement.
 * Uncaused notices remain distinct unless their producer supplies a stable ID. */
export const INSERT_INBOX_NOTICE_ONCE_SQL = `
  INSERT INTO fellow_inbox_notices (
    id, fellow_id, problem_id, notice_type, seq, title, detail,
    impact_kind, caused_by_event_id, target_id, acknowledged_at,
    expires_at, created_at
  ) SELECT ?1, ?2, ?3, ?4,
    (SELECT COALESCE(MAX(seq), 0) + 1 FROM fellow_inbox_notices WHERE fellow_id = ?5),
    ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12
  WHERE ?9 IS NULL OR NOT EXISTS (
    SELECT 1 FROM fellow_inbox_notices n
    WHERE n.fellow_id = ?2 AND n.problem_id IS ?3 AND n.notice_type = ?4
      AND n.impact_kind IS ?8 AND n.caused_by_event_id = ?9 AND n.target_id IS ?10
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING id`;

export const INBOX_NOTICE_RECEIPT_SQL = `
  SELECT id, fellow_id, problem_id, notice_type, seq, title, detail,
    impact_kind, caused_by_event_id, target_id, acknowledged_at, expires_at, created_at
  FROM fellow_inbox_notices
  WHERE fellow_id = ?1 AND problem_id IS ?2 AND notice_type = ?3
    AND impact_kind IS ?4 AND caused_by_event_id IS ?5 AND target_id IS ?6
    AND (id = ?7 OR ?5 IS NOT NULL)
  ORDER BY seq, id LIMIT 1`;

export async function inboxNoticeId(input: NoticeCreateInput): Promise<string> {
  if (input.id !== undefined) return input.id;
  if (input.causedByEventId === undefined || input.causedByEventId === null) {
    return `NOT-${crypto.randomUUID().replace(/-/g, "")}`;
  }
  const identity = JSON.stringify([
    "inbox-notice-v1",
    input.fellowId,
    input.problemId ?? null,
    input.noticeType,
    input.impactKind ?? null,
    input.causedByEventId,
    input.targetId ?? null,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
