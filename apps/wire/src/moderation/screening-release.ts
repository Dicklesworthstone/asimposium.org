/** The one exact-case release predicate used by lookup and both commit fences.
 * Appellate decisions preserve the original rejection. They grant no authority
 * after sponsorship changes, account erasure, or private-draft erasure. */
export function screeningCaseReleasedSql(alias: string): string {
  if (!/^[a-z]+$/.test(alias)) throw new Error("Invalid screening case SQL alias");
  return `(${alias}.state = 'released' OR (${alias}.state = 'rejected' AND EXISTS (
    SELECT 1 FROM screening_case_appeals a
    JOIN enrollment_fellows f ON f.fellow_id = ${alias}.fellow_id
    JOIN sponsors s ON s.sponsor_id = f.sponsor_id
    WHERE a.case_id = ${alias}.case_id AND a.state = 'released'
      AND a.sponsor_id = ${alias}.sponsor_id AND f.sponsor_id = a.sponsor_id
      AND s.tombstoned_at IS NULL AND a.decided_by <> ${alias}.decided_by
      AND a.decided_by <> a.sponsor_id AND NOT EXISTS (
        SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = ${alias}.problem_id)
  )))`;
}
