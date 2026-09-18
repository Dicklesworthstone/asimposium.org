import type { D1Database } from "@cloudflare/workers-types";
import { livePublicationPin } from "./artifact-publication-outbox.ts";
import {
  ARTIFACT_PUBLICATION_SCHEMA,
  ArtifactPublicationError,
  PUBLICATION_JOIN,
  type PublicationJob,
  readPublicationEvidence,
  readPublicationJob,
} from "./artifact-publication-store.ts";

export const ARTIFACT_PUBLICATION_PAGE_SIZE = 20;
const notFound = (): never => {
  throw new ArtifactPublicationError("NOT_FOUND");
};
function manifest(row: PublicationJob) {
  return {
    schema: ARTIFACT_PUBLICATION_SCHEMA,
    publication_id: row.publication_id,
    problem_id: row.problem_id,
    evidence: {
      evidence_id: row.evidence_id,
      event_id: row.evidence_event_id,
      digest: `sha256:${row.evidence_sha256}`,
    },
    artifact: {
      sha256: row.sha256,
      size_bytes: row.size_bytes,
      encoding: row.encoding,
      content_type: row.content_type,
      download_url: `${row.artifact_origin}/sha256/${row.sha256}`,
    },
    author: { fellow_id: row.fellow_id, sponsor_id: row.sponsor_id },
    publication_event: {
      event_id: row.event_id,
      seq: row.event_seq,
      digest: `sha256:${row.event_sha256}`,
    },
    license: row.license,
    verification: "bytes-only" as const,
    published_at: row.published_at!,
    delivery_cursor: row.delivery_cursor!,
  };
}
export async function readPublicArtifactManifest(
  db: D1Database,
  origin: string,
  problem: string,
  id: string,
) {
  const row = await readPublicationJob(db, id);
  if (
    !row ||
    row.problem_id !== problem ||
    row.artifact_origin !== origin ||
    row.state !== "published"
  )
    return notFound();
  const pin = await livePublicationPin(db, row);
  if (!pin) return notFound();
  // Recheck visibility after asynchronous hashing. Only exact, still-available
  // public bytes can support this face; no private upload identifier is served.
  const current = await db
    .prepare(`SELECT p.unlisted FROM artifact_publications b
    JOIN problems p ON p.id = b.problem_id AND p.status <> 'private-draft'
    JOIN artifact_publication_evidence v ON v.problem_id = b.problem_id AND v.evidence_event_id = b.evidence_event_id
      AND v.evidence_sha256 = b.evidence_sha256 AND v.evidence_json = ?
    JOIN event_content c ON c.event_id = b.event_id AND c.payload_sha256 = b.event_sha256
      AND c.redacted_at IS NULL AND c.payload_json = ?
    WHERE b.publication_id = ? AND b.problem_id = ?`)
    .bind(pin.evidence, pin.event, id, problem)
    .first<{ unlisted: number }>();
  if (!current || ![0, 1].includes(current.unlisted)) return notFound();
  return { face: manifest(row), unlisted: current.unlisted === 1 };
}

/** Pagination is by delivery cursor, NOT the earlier request-event sequence:
 * a slow older upload that finishes later must remain discoverable by polling. */
export async function readEvidenceArtifacts(
  db: D1Database,
  origin: string,
  problem: string,
  evidence: string,
  after = 0,
  through?: number,
) {
  await readPublicationEvidence(db, problem, evidence);
  const head = await db
    .prepare("SELECT cursor FROM public_cursor WHERE singleton = 1")
    .first<{ cursor: number }>();
  if (!head || !Number.isSafeInteger(head.cursor) || head.cursor < 0)
    throw new ArtifactPublicationError("UNAVAILABLE");
  const cut = through ?? head.cursor;
  if (
    !Number.isSafeInteger(after) ||
    !Number.isSafeInteger(cut) ||
    after < 0 ||
    cut < after ||
    cut > head.cursor
  )
    throw new ArtifactPublicationError("CONFLICT");
  const result = await db
    .prepare(`${PUBLICATION_JOIN} WHERE b.problem_id = ? AND b.evidence_id = ? AND b.artifact_origin = ?
    AND j.state = 'published' AND j.delivery_cursor > ? AND j.delivery_cursor <= ?
    ORDER BY j.delivery_cursor LIMIT ${ARTIFACT_PUBLICATION_PAGE_SIZE + 1}`)
    .bind(problem, evidence, origin, after, cut)
    .all<PublicationJob>();
  if (!result.success) throw new ArtifactPublicationError("UNAVAILABLE");
  const scanned = result.results.slice(0, ARTIFACT_PUBLICATION_PAGE_SIZE);
  const artifacts: ReturnType<typeof manifest>[] = [];
  for (const row of scanned) {
    try {
      artifacts.push(
        (await readPublicArtifactManifest(db, origin, problem, row.publication_id)).face,
      );
    } catch (error) {
      if (!(error instanceof ArtifactPublicationError) || error.code !== "NOT_FOUND") throw error;
    }
  }
  // Do not return a partial list after its owning evidence was redacted mid-read.
  await readPublicationEvidence(db, problem, evidence);
  const more = result.results.length > ARTIFACT_PUBLICATION_PAGE_SIZE;
  const next = more ? scanned.at(-1)!.delivery_cursor! : null;
  const path = `/p/${problem}/evidence/${evidence}/artifacts.json`;
  return {
    schema: ARTIFACT_PUBLICATION_SCHEMA,
    problem_id: problem,
    evidence_id: evidence,
    after,
    through: cut,
    artifacts,
    next_after: next,
    next_path: next === null ? null : `${path}?after=${next}&through=${cut}`,
    poll_path: `${path}?after=${cut}`,
  };
}
