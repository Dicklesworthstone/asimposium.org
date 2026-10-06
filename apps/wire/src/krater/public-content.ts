/**
 * Fable §9.1 L2 / §10.2: a target whose current (latest-version) content
 * control hides it. Visibility lives in content_controls, never on the event:
 * a restore is a later control row, so the content returns unchanged.
 * `problemExpr` and `targetExpr` are SQL expressions from the consuming query.
 */
export function hiddenByContentControlSql(problemExpr: string, targetExpr: string): string {
  return `EXISTS (
  SELECT 1 FROM content_controls hidden_control
  WHERE hidden_control.problem_id = ${problemExpr}
    AND hidden_control.target_ref = ${targetExpr}
    AND hidden_control.visibility = 'hidden'
    AND hidden_control.version = (
      SELECT MAX(latest_control.version) FROM content_controls latest_control
      WHERE latest_control.problem_id = hidden_control.problem_id
        AND latest_control.target_ref = hidden_control.target_ref
    )
)`;
}

/**
 * Read-side law for the current `claims` row (use that exact SQL table name).
 * A retained projection is not publication authority. Its same-problem source
 * event must be public, digest-bound, and still have available content.
 * Content a current control hides (the claim, or its whole problem) is
 * unavailable exactly like redacted content, and returns on restore.
 * Keep this in the consuming SELECT so redaction cannot race a separate probe.
 */
export const PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL = `(EXISTS (
  SELECT 1 FROM events public_event
  JOIN event_content public_content
    ON public_content.event_id = public_event.id
   AND public_content.payload_sha256 = public_event.payload_sha256
  JOIN problems public_problem ON public_problem.id = public_event.problem_id
  WHERE public_event.problem_id = claims.problem_id
    AND public_event.object_id = claims.id AND public_event.object_kind = 'claim'
    AND public_event.type IN ('claim.created', 'claim.revised')
    AND public_event.seq = claims.source_seq
    AND public_event.payload_sha256 = claims.payload_sha256
    AND public_event.seq <= public_problem.public_seq
    AND public_content.redacted_at IS NULL
)
  AND NOT ${hiddenByContentControlSql("claims.problem_id", "claims.id")}
  AND NOT ${hiddenByContentControlSql("claims.problem_id", "'problem'")})`;
