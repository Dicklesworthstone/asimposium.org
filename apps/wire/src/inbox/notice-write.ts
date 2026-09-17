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
