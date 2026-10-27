import type { D1Database } from "@cloudflare/workers-types";
import { loadHypothesisEvidenceItem } from "../ledger/hypothesis-evidence-read.ts";
import {
  checkedScientificPayload,
  type ScientificContentIdentity,
  ScientificInputError,
} from "../ledger/scientific-checks.ts";

/** Elimination must use the same readable, digest-checked evidence that a
 * Fellow can inspect. A mutable projection or matching stored hash columns
 * alone cannot establish that the retained scientific bytes are authentic.
 * Return an ephemeral exact-byte witness for the atomic publication batch. */
export async function readHypothesisKillSource(
  db: D1Database,
  problemId: string,
  hypothesisId: string,
  evidenceId: string,
): Promise<ScientificContentIdentity | null> {
  const item = await loadHypothesisEvidenceItem(db, problemId, evidenceId);
  if (
    !item ||
    item.face.withdrawn ||
    item.face.bears_on.id !== hypothesisId ||
    item.face.content?.direction !== "refutes" ||
    item.face.computed === null
  )
    return null;
  const pin = item.face.publication;
  const source = await db
    .prepare(`SELECT c.payload_json, e.payload_sha256
      FROM events e JOIN event_content c ON c.event_id = e.id
        AND c.payload_sha256 = e.payload_sha256 AND c.redacted_at IS NULL
        AND length(CAST(c.payload_json AS BLOB)) BETWEEN 1 AND 524288
      WHERE e.id = ? AND e.problem_id = ? AND e.seq = ?
        AND e.type = 'evidence.created' AND e.object_kind = 'evidence'
        AND e.object_id = ? AND e.object_version = 1 AND e.payload_sha256 = ?
        AND e.actor_fellow_id = ? AND e.actor_sponsor_id = ?`)
    .bind(
      pin.event_id,
      problemId,
      pin.seq,
      evidenceId,
      pin.payload_sha256,
      pin.fellow_id,
      pin.sponsor_id,
    )
    .first<{ payload_json: string; payload_sha256: string }>();
  if (!source) return null;
  try {
    // A changed body between the public read and this bounded capture cannot
    // borrow the earlier read's admission. The later batch pins these bytes.
    await checkedScientificPayload(source);
  } catch (error) {
    if (error instanceof ScientificInputError) return null;
    throw error;
  }
  return {
    eventId: pin.event_id,
    payloadDigest: pin.payload_sha256,
    payloadJson: source.payload_json,
    problemId,
  };
}

/** Only the fixed database invariant marker is classified. Never return/log
 * the database error, which may contain SQL or restricted source details. */
export function isHypothesisKillSourceError(error: unknown): boolean {
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth++) {
    if (typeof error !== "object" || error === null || seen.has(error)) return false;
    seen.add(error);
    try {
      const value = error as { message?: unknown; cause?: unknown };
      if (
        typeof value.message === "string" && value.message.length <= 4096 &&
        /(?:^|[^A-Z0-9_])HYPOTHESIS_KILL_SOURCE_INVALID(?:$|[^A-Z0-9_])/.test(value.message)
      ) return true;
      error = value.cause;
    } catch { return false; }
  }
  return false;
}

/** Map only the final uncaught database abort, after the original writer has
 * attempted replay recovery. Never infer an abort from response bytes, an
 * earlier retry failure, or a new preflight read. A recovered success and an
 * uncertain transport/storage failure keep their original response intact. */
export function hypothesisKillAdmissionResponse(
  error: unknown,
  response: Response,
  refusal: () => Response,
): Response {
  return response.status >= 500 && isHypothesisKillSourceError(error) ? refusal() : response;
}
