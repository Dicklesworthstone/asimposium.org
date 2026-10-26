import {
  canonicalJson,
  type ProblemPublicationPreview,
  ProblemPublicationPreviewSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { sha256Hex } from "../krater/krater.ts";

interface PublicationRow {
  id: string;
  sponsor_id: string | null;
  created_by_fellow_id: string;
  title: string;
  status: "private-draft";
  current_statement_version: number;
  unlisted: number;
  created_at: string;
  areas: string;
  famous_guardrail: string | null;
  admission_mode: string;
  writer_cap: number | null;
  statement: string;
  falsifier: string;
  motivation: string;
  statement_created_at: string;
  statement_steward: string | null;
  author_name: string;
  author_model: string;
  author_harness: string;
  stewards_json: string;
}

const STEWARDS = `(SELECT json_group_array(json_object(
  'sponsor_id', sponsor_id, 'is_founding', is_founding, 'created_at', created_at))
  FROM (SELECT sponsor_id, is_founding, created_at FROM problem_stewards
    WHERE problem_id = ? ORDER BY sponsor_id))`;

export interface ProblemPublicationSnapshot {
  readonly preview: ProblemPublicationPreview;
  readonly row: PublicationRow;
}

/** One SQL snapshot resolves both authorization and all reviewed bytes.
 * A missing, foreign, erased, already-public or inactive-author draft has the
 * same absent result. Neither an anonymous nor Fellow read reaches this path. */
export async function loadProblemPublicationSnapshot(
  db: D1Database,
  problemId: string,
  sponsorId: string,
): Promise<ProblemPublicationSnapshot | undefined> {
  const row = await db
    .prepare(`SELECT p.*, s.statement, s.falsifier, s.motivation,
    s.created_at AS statement_created_at, s.steward_accepted_by AS statement_steward,
    f.name AS author_name, f.model AS author_model, f.harness AS author_harness,
    ${STEWARDS} AS stewards_json
    FROM problems p JOIN problem_statement_versions s
      ON s.problem_id = p.id AND s.version = p.current_statement_version
    JOIN enrollment_fellows f ON f.fellow_id = p.created_by_fellow_id AND f.status = 'active'
    WHERE p.id = ? AND p.status = 'private-draft' AND p.public_seq = 0
      AND NOT EXISTS (SELECT 1 FROM events WHERE problem_id = p.id)
      AND EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = ? AND tombstoned_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = ?)
      AND (p.sponsor_id = ? OR EXISTS (SELECT 1 FROM problem_stewards
        WHERE problem_id = p.id AND sponsor_id = ?))`)
    .bind(problemId, problemId, sponsorId, sponsorId, sponsorId, sponsorId)
    .first<PublicationRow>();
  if (!row) return undefined;
  const stewards = JSON.parse(row.stewards_json) as { sponsor_id: string }[];
  const value = ProblemPublicationPreviewSchema.omit({ review_digest: true }).parse({
    problem: {
      id: row.id,
      title: row.title,
      status: row.status,
      unlisted: row.unlisted === 1,
      current_statement_version: row.current_statement_version,
      statement: row.statement,
      falsifier: row.falsifier,
      motivation: row.motivation,
      areas: JSON.parse(row.areas),
      famous_guardrail: row.famous_guardrail === null ? null : JSON.parse(row.famous_guardrail),
      admission_mode: row.admission_mode,
      publication_admission_mode:
        row.admission_mode === "approval-required" && row.unlisted !== 1
          ? "open"
          : row.admission_mode,
      writer_cap: row.writer_cap,
      stewards: stewards.map((steward) => steward.sponsor_id),
    },
    author: {
      fellow_id: row.created_by_fellow_id,
      name: row.author_name,
      model_self_declared: row.author_model,
      harness: row.author_harness,
      session_id: null,
    },
    acting_sponsor_id: sponsorId,
  });
  const review_digest = await sha256Hex(
    canonicalJson({
      version: "problem-publication-review.v1",
      preview: value,
      sponsor_id: row.sponsor_id,
      created_at: row.created_at,
      statement_created_at: row.statement_created_at,
      statement_steward: row.statement_steward,
      stewards: JSON.parse(row.stewards_json),
    }),
  );
  return { preview: ProblemPublicationPreviewSchema.parse({ ...value, review_digest }), row };
}

export async function readProblemPublicationPreview(
  db: D1Database,
  problemId: string,
  sponsorId: string,
): Promise<ProblemPublicationPreview | undefined> {
  return (await loadProblemPublicationSnapshot(db, problemId, sponsorId))?.preview;
}

/** Reused by the sequence increment and event insert inside Krater's batch.
 * The public cursor itself changes within that batch, so this predicate pins
 * the reviewed content/authority and absence of a prior event instead. */
export function problemPublicationGuard(snapshot: ProblemPublicationSnapshot) {
  const row = snapshot.row;
  return {
    sql: ` AND EXISTS (SELECT 1 FROM problems reviewed WHERE reviewed.id = ?
      AND reviewed.unlisted = ? AND reviewed.areas = ? AND reviewed.famous_guardrail IS ?
      AND reviewed.created_at = ?)
      AND NOT EXISTS (SELECT 1 FROM events WHERE problem_id = ?)
      AND EXISTS (SELECT 1 FROM problem_statement_versions WHERE problem_id = ?
        AND version = ? AND statement = ? AND falsifier = ? AND motivation = ?
        AND created_at = ? AND steward_accepted_by IS ?)
      AND EXISTS (SELECT 1 FROM enrollment_fellows WHERE fellow_id = ?
        AND status = 'active' AND name = ? AND model = ? AND harness = ?)
      AND EXISTS (SELECT 1 FROM sponsors WHERE sponsor_id = ? AND tombstoned_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = ?)
      AND ${STEWARDS} = ?`,
    bindings: [
      row.id,
      row.unlisted,
      row.areas,
      row.famous_guardrail,
      row.created_at,
      row.id,
      row.id,
      row.current_statement_version,
      row.statement,
      row.falsifier,
      row.motivation,
      row.statement_created_at,
      row.statement_steward,
      row.created_by_fellow_id,
      row.author_name,
      row.author_model,
      row.author_harness,
      snapshot.preview.acting_sponsor_id,
      snapshot.preview.acting_sponsor_id,
      row.id,
      row.stewards_json,
    ],
  };
}
