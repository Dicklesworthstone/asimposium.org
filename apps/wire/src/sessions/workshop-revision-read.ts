import type { D1Database } from "@cloudflare/workers-types";

export interface WorkshopReadHead {
  workshop_id: string;
  type: string;
  title: string;
  body_md: string;
  cas_hash: string | null;
  relates_to_json: string;
  revision_json: string | null;
  publication_json: string | null;
  ledger_intent_json: string | null;
  workshop_seq: number;
  created_at: string;
  current_version: number;
  state: string;
}

/** The caller must first select the head under the owning Fellow/problem and
 * recheck its authority after materializing private CAS bytes. Both principals
 * read the same immutable revisions; selecting history never restores a head. */
export async function readWorkshopRevision(
  db: D1Database,
  head: WorkshopReadHead,
  version: number,
): Promise<(WorkshopReadHead & { version: number }) | null> {
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !Number.isSafeInteger(head.current_version) ||
    version > head.current_version
  )
    return null;
  const revision = await db
    .prepare(
      `SELECT workshop_id, version, type, title, body_md, cas_hash, relates_to_json,
        revision_json, publication_json, ledger_intent_json, created_at
       FROM workshop_revisions WHERE workshop_id = ? AND version = ?`,
    )
    .bind(head.workshop_id, version)
    .first<
      Omit<WorkshopReadHead, "workshop_seq" | "current_version" | "state"> & { version: number }
    >();
  if (revision === null) return null;
  if (revision.workshop_id !== head.workshop_id || revision.version !== version)
    throw new Error("Workshop revision identity mismatch");
  return {
    ...revision,
    workshop_seq: head.workshop_seq,
    current_version: head.current_version,
    state: head.state,
  };
}
