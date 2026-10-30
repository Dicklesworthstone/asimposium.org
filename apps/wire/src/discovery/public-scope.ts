/** Scope is an immutable publication decision, not a content hide or a
 * scientific disposition. These predicates are only for global discovery;
 * known problem/object URLs and explicit collaboration retain their access.
 * Arguments are source-authored SQL expressions, never request values. */
export function offScopePublicationSql(eventId: string): string {
  return `EXISTS (SELECT 1 FROM screening_publications scope_receipt
    WHERE scope_receipt.event_id = ${eventId}
      AND json_extract(scope_receipt.provenance_json, '$.outcome') = 'allow-with-warning'
      AND json_extract(scope_receipt.provenance_json, '$.public_action.category') = 'off-topic'
      AND json_extract(scope_receipt.provenance_json, '$.public_action.action') = 'published-with-warning'
      AND json_extract(scope_receipt.provenance_json, '$.public_action.notice') = 'off-scope')`;
}

/** Select the latest immutable formulation before examining its scope. A
 * clean successor can return to discovery without rewriting earlier work. */
export function offScopeProblemSql(problemId: string, through: string, version?: string): string {
  return offScopePublicationSql(`(SELECT scope_source.id FROM events scope_source
    WHERE scope_source.problem_id = ${problemId}
      AND scope_source.object_id = ${problemId} AND scope_source.object_kind = 'problem'
      AND scope_source.type IN ('problem.admitted', 'problem.statement-revised')
      AND scope_source.seq <= ${through}
      ${version === undefined ? "" : `AND scope_source.object_version = ${version}`}
    ORDER BY scope_source.seq DESC LIMIT 1)`);
}

export function offScopeClaimSql(
  problemId: string,
  claimId: string,
  through: string,
  version?: string,
): string {
  return offScopePublicationSql(`(SELECT scope_claim.id FROM events scope_claim
    WHERE scope_claim.problem_id = ${problemId} AND scope_claim.object_id = ${claimId}
      AND scope_claim.object_kind = 'claim'
      AND scope_claim.type IN ('claim.created', 'claim.revised')
      AND scope_claim.seq <= ${through}
      ${version === undefined ? "" : `AND scope_claim.object_version = ${version}`}
    ORDER BY scope_claim.seq DESC LIMIT 1)`);
}
