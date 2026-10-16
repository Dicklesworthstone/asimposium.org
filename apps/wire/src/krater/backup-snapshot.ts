import type { D1Database } from "@cloudflare/workers-types";
import type { ProblemExportEvent } from "./export.ts";
import type { KraterCheckpoint } from "./krater.ts";

const PAGE = 200;
interface Head { publicSeq: number; chainDigest: string; chainVersion: number; eventCount: number }
type EventRow = Omit<ProblemExportEvent, "payloadJson"> & {
  payloadJson: string | null;
  contentSha256: string | null;
  redactedAt: string | null;
  sidecarProblem: string | null;
  sidecarSeq: number | null;
};

/** Capture one committed head, then read only its immutable prefix. Later
 * appends neither extend the run nor invalidate its pin. Envelopes and current
 * content availability are read together. The caller MUST still run the
 * canonical export-chain verifier before publishing these bytes.
 *
 * This is not an atomic D1/R2 erasure boundary: the deletion journal still
 * governs older backups and changes arriving after a payload page was read.
 */
export async function readBackupSnapshot(db: D1Database, problemId: string): Promise<{
  events: ProblemExportEvent[];
  checkpoints: KraterCheckpoint[];
  chainDigest: string;
  cursor: number;
} | null> {
  const head = await db.prepare(`SELECT p.public_seq AS publicSeq, p.chain_digest AS chainDigest,
      p.chain_version AS chainVersion,
      (SELECT COUNT(*) FROM events e WHERE e.problem_id = p.id) AS eventCount
    FROM problems p WHERE p.id = ?`).bind(problemId).first<Head>();
  if (!head) throw new Error("BACKUP_PROBLEM_NOT_FOUND");
  if (!Number.isSafeInteger(head.publicSeq) || head.publicSeq < 0 ||
      head.eventCount !== head.publicSeq) throw new Error("BACKUP_HEAD_INVALID");
  if (head.publicSeq === 0) return null;
  if (head.chainVersion !== 2 || !/^[a-f0-9]{64}$/.test(head.chainDigest))
    throw new Error("BACKUP_HEAD_INVALID");

  const events: ProblemExportEvent[] = [];
  let after = 0;
  while (after < head.publicSeq) {
    const limit = Math.min(PAGE, head.publicSeq - after);
    const page = await db.prepare(`SELECT e.id AS eventId, e.problem_id AS problemId,
        e.seq, e.type, e.object_kind AS objectKind, e.object_id AS objectId,
        e.object_version AS objectVersion, e.payload_sha256 AS payloadSha256,
        e.created_at AS createdAt, e.actor_fellow_id AS actorFellowId,
        e.actor_sponsor_id AS actorSponsorId, e.actor_session_id AS actorSessionId,
        e.model_string_self_declared AS modelStringSelfDeclared, e.harness,
        e.writer_credential_id AS writerCredentialId,
        ch.row_digest AS rowDigest, ch.chain_digest AS chainDigest, ch.chain_version AS chainVersion,
        ch.problem_id AS sidecarProblem, ch.seq AS sidecarSeq,
        c.payload_json AS payloadJson, c.payload_sha256 AS contentSha256, c.redacted_at AS redactedAt
      FROM events e LEFT JOIN event_chain_v2 ch ON ch.event_id = e.id
      LEFT JOIN event_content c ON c.event_id = e.id
      WHERE e.problem_id = ? AND e.seq > ? AND e.seq <= ? ORDER BY e.seq LIMIT ?`)
      .bind(problemId, after, head.publicSeq, limit).all<EventRow>();
    if (!Array.isArray(page.results) || page.results.length !== limit)
      throw new Error("BACKUP_EVENT_PREFIX_INCOMPLETE");
    for (const row of page.results) {
      const { payloadJson, contentSha256, redactedAt, sidecarProblem, sidecarSeq, ...event } = row;
      if (row.seq !== after + 1 || row.problemId !== problemId || row.chainVersion !== 2 ||
          sidecarProblem !== problemId || sidecarSeq !== row.seq)
        throw new Error("BACKUP_EVENT_IDENTITY_INVALID");
      if (typeof payloadJson !== "string" || redactedAt !== null || contentSha256 !== row.payloadSha256)
        throw new Error(`backup of ${problemId} is missing event_content payload bytes for ${row.eventId}`);
      events.push({ ...event, payloadJson });
      after = row.seq;
    }
  }
  if (events.at(-1)?.chainDigest !== head.chainDigest)
    throw new Error("BACKUP_HEAD_PREFIX_MISMATCH");

  const checkpoints: KraterCheckpoint[] = [];
  after = 0;
  while (after < head.publicSeq) {
    const page = await db.prepare(`SELECT c.problem_id AS problemId, c.checkpoint_seq AS checkpointSeq,
        ch.root_chain_digest AS rootChainDigest, ch.checkpoint_digest AS checkpointDigest,
        c.checkpoint_version AS checkpointVersion, c.checkpoint_mode AS checkpointMode,
        ch.chain_version AS chainVersion
      FROM integrity_checkpoints c LEFT JOIN checkpoint_chain_v2 ch
        ON ch.problem_id = c.problem_id AND ch.checkpoint_seq = c.checkpoint_seq
      WHERE c.problem_id = ? AND c.checkpoint_seq > ? AND c.checkpoint_seq <= ?
      ORDER BY c.checkpoint_seq LIMIT ?`).bind(problemId, after, head.publicSeq, PAGE)
      .all<KraterCheckpoint>();
    if (!Array.isArray(page.results) || page.results.length > PAGE)
      throw new Error("BACKUP_CHECKPOINT_PAGE_INVALID");
    for (const pin of page.results) {
      if (!Number.isSafeInteger(pin.checkpointSeq) || pin.checkpointSeq <= after ||
          pin.checkpointSeq > head.publicSeq || pin.problemId !== problemId ||
          pin.chainVersion !== 2 || pin.checkpointVersion !== 1 || pin.checkpointMode !== "unsigned-v0")
        throw new Error("BACKUP_CHECKPOINT_IDENTITY_INVALID");
      checkpoints.push(pin);
      after = pin.checkpointSeq;
    }
    if (page.results.length < PAGE) break;
  }
  return { events, checkpoints, chainDigest: head.chainDigest, cursor: head.publicSeq };
}
