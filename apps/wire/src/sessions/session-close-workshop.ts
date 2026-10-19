import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

export class SessionCloseWorkshopError extends Error {
  readonly code: "INVALID_SELECTION" | "NOT_FOUND" | "CHANGED";
  constructor(code: "INVALID_SELECTION" | "NOT_FOUND" | "CHANGED") {
    super(`SESSION_CLOSE_WORKSHOP_${code}`);
    this.code = code;
  }
}

export interface SessionCloseWorkshopPromotion {
  readonly workshopId: string;
  readonly expectedVersion: number;
  readonly publicationJson: string;
  readonly eventId: string;
}

export interface SessionCloseWorkshopPlan {
  readonly statements: readonly D1PreparedStatement[];
  /** Rebind publication time without refreshing the captured private heads. */
  readonly statementsAt: (closedAt: string) => readonly D1PreparedStatement[];
  readonly keep: readonly string[];
  readonly discard: readonly string[];
}

interface WorkshopHead {
  workshop_id: string;
  current_version: number;
}

const SAFE_INTEGER_MAX = 9007199254740991;

export async function prepareSessionCloseWorkshopActions(
  db: D1Database,
  input: {
    readonly sessionId: string;
    readonly problemId: string;
    readonly fellowId: string;
    readonly keep: readonly string[];
    readonly discard: readonly string[];
    readonly promote?: readonly SessionCloseWorkshopPromotion[];
    readonly closedAt: string;
  },
): Promise<SessionCloseWorkshopPlan> {
  const keep = [...input.keep];
  const discard = [...input.discard];
  const promote = [...(input.promote ?? [])];
  const all = [...promote.map((item) => item.workshopId), ...keep, ...discard];
  if (
    new Set(keep).size !== keep.length ||
    new Set(discard).size !== discard.length ||
    new Set(all).size !== all.length
  ) {
    throw new SessionCloseWorkshopError("INVALID_SELECTION");
  }
  if (all.length === 0)
    return { statements: [], statementsAt: () => [], keep, discard };

  // One JSON binding keeps large selections within D1's parameter limit.
  // IDs remain data, including quotes and other SQL-looking characters.
  const heads = await db
    .prepare(`SELECT workshop_id,current_version
    FROM workshop_objects
    WHERE session_id=? AND problem_id=? AND fellow_id=?
      AND workshop_id IN (SELECT value FROM json_each(?))
    ORDER BY workshop_id`)
    .bind(input.sessionId, input.problemId, input.fellowId, JSON.stringify(all))
    .all<WorkshopHead>();
  if (heads.results.length !== all.length) throw new SessionCloseWorkshopError("NOT_FOUND");
  const byId = new Map(heads.results.map((row) => [row.workshop_id, row]));

  const max = await db
    .prepare(
      "SELECT COALESCE(MAX(workshop_seq),0) AS n FROM workshop_objects WHERE problem_id=? AND fellow_id=?",
    )
    .bind(input.problemId, input.fellowId)
    .first<{ n: number }>();
  const base = max?.n ?? 0;
  if (!Number.isSafeInteger(base) || base < 0 || base + all.length > SAFE_INTEGER_MAX) {
    throw new SessionCloseWorkshopError("CHANGED");
  }

  const promotionById = new Map(promote.map((item) => [item.workshopId, item]));
  const expected = all.map((id) => {
    const row = byId.get(id);
    if (!row) throw new SessionCloseWorkshopError("NOT_FOUND");
    if (
      !Number.isSafeInteger(row.current_version) ||
      row.current_version < 1 ||
      row.current_version >= SAFE_INTEGER_MAX ||
      (promotionById.has(id) &&
        promotionById.get(id)?.expectedVersion !== row.current_version)
    ) {
      throw new SessionCloseWorkshopError("CHANGED");
    }
    return row;
  });
  // Capture selection and sequence once, before screening. Only the final
  // publication timestamp may change when the prepared close is committed.
  const statementsAt = (closedAt: string): readonly D1PreparedStatement[] => {
    // Head versions alone do not protect the shared private-feed sequence:
    // an unselected object (even in another session) can advance it. Check
    // both snapshots inside the caller's atomic close batch, before any writes.
    const statements: D1PreparedStatement[] = [
      db
        .prepare(`WITH expected(id,version) AS (
          SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)
        ), publications(id,version,publication,event_id) AS (
          SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),
            json_extract(value,'$[2]'),json_extract(value,'$[3]') FROM json_each(?)
        )
        SELECT CASE WHEN
          (SELECT COUNT(*) FROM expected)=? AND
          (SELECT COALESCE(MAX(workshop_seq),0) FROM workshop_objects
            WHERE problem_id=? AND fellow_id=?)=? AND
          NOT EXISTS (SELECT 1 FROM expected x WHERE NOT EXISTS (
            SELECT 1 FROM workshop_objects w
            JOIN sessions s ON s.session_id=w.session_id
            WHERE w.workshop_id=x.id AND w.current_version=x.version
              AND w.session_id=? AND w.problem_id=? AND w.fellow_id=?
              AND s.closed_at IS NULL
          )) AND
          NOT EXISTS (SELECT 1 FROM publications x WHERE NOT EXISTS (
            SELECT 1 FROM workshop_objects w JOIN workshop_revisions source
              ON source.workshop_id=w.workshop_id AND source.version=w.current_version
            JOIN events e ON e.id=x.event_id AND e.problem_id=w.problem_id
              AND e.type='claim.created' AND e.object_kind='claim'
            WHERE w.workshop_id=x.id AND w.current_version=x.version
              AND w.state='open' AND w.type='claim-draft' AND w.revision_json IS NULL
              AND w.publication_json=x.publication AND source.publication_json=x.publication
              AND source.session_id=w.session_id AND source.fellow_id=w.fellow_id
              AND source.problem_id=w.problem_id
          ))
        THEN 1 ELSE json_extract('[]','$[SESSION_CLOSE_WORKSHOP_CHANGED') END`)
        .bind(
          JSON.stringify(expected.map((row) => [row.workshop_id, row.current_version])),
          JSON.stringify(promote.map((item) => [
            item.workshopId, item.expectedVersion, item.publicationJson, item.eventId,
          ])),
          expected.length,
          input.problemId,
          input.fellowId,
          base,
          input.sessionId,
          input.problemId,
          input.fellowId,
        ),
    ];

    // The selection order fixes sequence assignment, not SQLite's row order.
    // Keep these private actions to three statements regardless of draft count:
    // guard, transition all heads, then snapshot all resulting revisions. Clone
    // bodies in SQL, including publication drafts, without loading them into JS.
    const selectionJson = JSON.stringify(all);
    const keepJson = JSON.stringify(keep);
    const promoteJson = JSON.stringify(promote.map((item) => ({
      id: item.workshopId, event_id: item.eventId,
    })));
    statements.push(
      db
        .prepare(`UPDATE workshop_objects
        SET state=CASE
              WHEN workshop_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))
                THEN 'archived'
              WHEN workshop_id IN (SELECT value FROM json_each(?))
                THEN 'open' ELSE 'discarded' END,
            current_version=current_version+1,
            workshop_seq=?+1+(SELECT CAST(key AS INTEGER) FROM json_each(?)
              WHERE value=workshop_objects.workshop_id),
            updated_at=?
        WHERE session_id=? AND problem_id=? AND fellow_id=?
          AND workshop_id IN (SELECT value FROM json_each(?))`)
        .bind(
          promoteJson,
          keepJson,
          base,
          selectionJson,
          closedAt,
          input.sessionId,
          input.problemId,
          input.fellowId,
          selectionJson,
        ),
      db
        .prepare(`INSERT INTO workshop_revisions
        (workshop_id,version,problem_id,fellow_id,session_id,type,title,body_md,cas_hash,
         relates_to_json,ledger_intent_json,revision_json,publication_json,revise_action,created_at,
         publication_event_id)
        SELECT workshop_id,current_version,problem_id,fellow_id,session_id,type,title,body_md,cas_hash,
          relates_to_json,ledger_intent_json,revision_json,publication_json,
          CASE
            WHEN workshop_id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) THEN 'archive'
            WHEN workshop_id IN (SELECT value FROM json_each(?)) THEN 'keep' ELSE 'discard'
          END,?,
          (SELECT json_extract(value,'$.event_id') FROM json_each(?)
            WHERE json_extract(value,'$.id')=workshop_objects.workshop_id)
        FROM workshop_objects
        WHERE session_id=? AND problem_id=? AND fellow_id=?
          AND workshop_id IN (SELECT value FROM json_each(?))`)
        .bind(
          promoteJson,
          keepJson,
          closedAt,
          promoteJson,
          input.sessionId,
          input.problemId,
          input.fellowId,
          selectionJson,
        ),
    );
    return statements;
  };
  return { statements: statementsAt(input.closedAt), statementsAt, keep, discard };
}

export function isSessionCloseWorkshopChanged(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("SESSION_CLOSE_WORKSHOP_CHANGED") ||
      (error.cause !== undefined && isSessionCloseWorkshopChanged(error.cause)))
  );
}
