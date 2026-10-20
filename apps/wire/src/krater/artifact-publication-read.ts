import type { D1Database } from "@cloudflare/workers-types";
import {
  livePublicationPin,
  PUBLICATION_LIVE_PIN_SQL,
  type PublicationPin,
  publicationPinBindings,
} from "./artifact-publication-outbox.ts";
import {
  ARTIFACT_PUBLICATION_SCHEMA,
  ArtifactPublicationError,
  PUBLICATION_EVIDENCE_PIN_SQL,
  PUBLICATION_JOIN,
  type PublicationJob,
  publicationEvidencePinBindings,
  readPublicationEvidence,
  readPublicationJob,
} from "./artifact-publication-store.ts";
import { eventContentHiddenSql } from "./public-content.ts";

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
async function resolvePublicArtifactManifest(
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
    .prepare(`SELECT p.unlisted FROM problems p WHERE p.id = ?
      AND ${PUBLICATION_LIVE_PIN_SQL}`)
    .bind(problem, ...publicationPinBindings(row, pin))
    .first<{ unlisted: number }>();
  if (!current || ![0, 1].includes(current.unlisted)) return notFound();
  return { face: manifest(row), unlisted: current.unlisted === 1, pin };
}
export async function readPublicArtifactManifest(
  db: D1Database,
  origin: string,
  problem: string,
  id: string,
) {
  const { face, unlisted } = await resolvePublicArtifactManifest(db, origin, problem, id);
  return { face, unlisted };
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
  const resolved: { face: ReturnType<typeof manifest>; pin: PublicationPin }[] = [];
  for (const row of scanned) {
    try {
      resolved.push(await resolvePublicArtifactManifest(db, origin, problem, row.publication_id));
    } catch (error) {
      if (!(error instanceof ArtifactPublicationError) || error.code !== "NOT_FOUND") throw error;
    }
  }
  // One final read covers every already-hashed source body in this bounded
  // page. An earlier publication can be hidden while a later item is read;
  // evidence/target moderation invalidates the entire owning face. Pagination
  // still advances by scanned delivery rows, including now-hidden entries.
  const owner = await readPublicationEvidence(db, problem, evidence);
  const current = await db
    .prepare(`SELECT ${
      resolved.length === 0
        ? "'[]'"
        : `(
    SELECT json_group_array(b.publication_id) FROM json_each(?) pinned
    JOIN artifact_publications b ON b.publication_id = json_extract(pinned.value,'$.publication_id')
    JOIN artifact_publication_jobs j ON j.publication_id = b.publication_id AND j.state = 'published'
    JOIN events e ON e.id = b.event_id AND e.payload_sha256 = b.event_sha256
      AND e.problem_id = b.problem_id AND e.object_id = b.publication_id
      AND e.type = 'artifact.publication-requested' AND e.object_kind = 'artifact' AND e.object_version = 1
    JOIN event_content c ON c.event_id = e.id AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
      AND c.payload_json = json_extract(pinned.value,'$.event_json')
    JOIN problems p ON p.id = e.problem_id AND p.status <> 'private-draft' AND e.seq <= p.public_seq
    WHERE b.problem_id = v.problem_id AND b.evidence_id = v.evidence_id
      AND b.evidence_event_id = v.evidence_event_id AND b.evidence_sha256 = v.evidence_sha256
      AND b.fellow_id = v.fellow_id AND b.sponsor_id = v.sponsor_id AND b.artifact_origin = ?
      AND NOT ${eventContentHiddenSql("e")}
  )`
    } AS publication_ids FROM artifact_publication_evidence v
    WHERE ${PUBLICATION_EVIDENCE_PIN_SQL}`)
    .bind(
      ...(resolved.length === 0
        ? []
        : [
            JSON.stringify(
              resolved.map(({ face, pin }) => ({
                publication_id: face.publication_id,
                event_json: pin.event,
              })),
            ),
            origin,
          ]),
      ...publicationEvidencePinBindings(owner),
    )
    .first<{ publication_ids: string }>();
  if (!current) return notFound();
  const visible = new Set(JSON.parse(current.publication_ids) as string[]);
  const artifacts = resolved
    .filter(({ face }) => visible.has(face.publication_id))
    .map(({ face }) => face);
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
