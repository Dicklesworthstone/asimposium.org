import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

export class SessionCloseWorkshopError extends Error {
  constructor(readonly code: "INVALID_SELECTION" | "NOT_FOUND" | "CHANGED") {
    super(`SESSION_CLOSE_WORKSHOP_${code}`);
  }
}

export interface SessionCloseWorkshopPlan {
  readonly statements: readonly D1PreparedStatement[];
  readonly keep: readonly string[];
  readonly discard: readonly string[];
}

interface WorkshopHead {
  workshop_id: string;
  current_version: number;
  type: string;
  title: string;
  body_md: string;
  cas_hash: string | null;
  relates_to_json: string;
  ledger_intent_json: string | null;
  revision_json: string | null;
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
    readonly closedAt: string;
  },
): Promise<SessionCloseWorkshopPlan> {
  const keep = [...input.keep];
  const discard = [...input.discard];
  const all = [...keep, ...discard];
  if (new Set(keep).size !== keep.length || new Set(discard).size !== discard.length ||
      new Set(all).size !== all.length) {
    throw new SessionCloseWorkshopError("INVALID_SELECTION");
  }
  if (all.length === 0) return { statements: [], keep, discard };

  const placeholders = all.map(() => "?").join(",");
  const heads = await db.prepare(`SELECT workshop_id,current_version,type,title,body_md,cas_hash,
      relates_to_json,ledger_intent_json,revision_json
    FROM workshop_objects
    WHERE session_id=? AND problem_id=? AND fellow_id=? AND workshop_id IN (${placeholders})
    ORDER BY workshop_id`)
    .bind(input.sessionId,input.problemId,input.fellowId,...all)
    .all<WorkshopHead>();
  if (heads.results.length !== all.length) throw new SessionCloseWorkshopError("NOT_FOUND");
  const byId = new Map(heads.results.map(row => [row.workshop_id,row]));

  const max = await db.prepare(
    "SELECT COALESCE(MAX(workshop_seq),0) AS n FROM workshop_objects WHERE problem_id=? AND fellow_id=?",
  ).bind(input.problemId,input.fellowId).first<{n:number}>();
  const base = max?.n ?? 0;
  if (!Number.isSafeInteger(base) || base < 0 || base + all.length > SAFE_INTEGER_MAX) {
    throw new SessionCloseWorkshopError("CHANGED");
  }

  const expected = all.map(id => {
    const row=byId.get(id);
    if(!row) throw new SessionCloseWorkshopError("NOT_FOUND");
    if (!Number.isSafeInteger(row.current_version) || row.current_version < 1 ||
        row.current_version >= SAFE_INTEGER_MAX) {
      throw new SessionCloseWorkshopError("CHANGED");
    }
    return row;
  });
  const statements: D1PreparedStatement[] = [
    db.prepare(`WITH expected(id,version) AS (VALUES ${expected.map(()=>"(?,?)").join(",")})
      SELECT CASE WHEN
        (SELECT COUNT(*) FROM expected)=? AND
        NOT EXISTS (SELECT 1 FROM expected x WHERE NOT EXISTS (
          SELECT 1 FROM workshop_objects w
          JOIN sessions s ON s.session_id=w.session_id
          WHERE w.workshop_id=x.id AND w.current_version=x.version
            AND w.session_id=? AND w.problem_id=? AND w.fellow_id=?
            AND s.closed_at IS NULL
        ))
      THEN 1 ELSE json_extract('[]','$[SESSION_CLOSE_WORKSHOP_CHANGED') END`)
      .bind(...expected.flatMap(row=>[row.workshop_id,row.current_version]),expected.length,
        input.sessionId,input.problemId,input.fellowId),
  ];

  all.forEach((id,index)=>{
    const row=byId.get(id)!;
    const action=keep.includes(id) ? "keep" : "discard";
    const state=action==="keep" ? "open" : "discarded";
    const nextVersion=row.current_version+1;
    const nextSeq=base+index+1;
    statements.push(
      db.prepare(`UPDATE workshop_objects SET state=?,current_version=?,workshop_seq=?,updated_at=?
        WHERE workshop_id=? AND session_id=? AND problem_id=? AND fellow_id=? AND current_version=?`)
        .bind(state,nextVersion,nextSeq,input.closedAt,id,input.sessionId,input.problemId,input.fellowId,row.current_version),
      db.prepare(`INSERT INTO workshop_revisions
        (workshop_id,version,problem_id,fellow_id,session_id,type,title,body_md,cas_hash,
         relates_to_json,ledger_intent_json,revision_json,revise_action,created_at)
        SELECT workshop_id,current_version,problem_id,fellow_id,session_id,type,title,body_md,cas_hash,
          relates_to_json,ledger_intent_json,revision_json,?,?
        FROM workshop_objects
        WHERE workshop_id=? AND session_id=? AND problem_id=? AND fellow_id=? AND current_version=?`)
        .bind(action,input.closedAt,id,input.sessionId,input.problemId,input.fellowId,nextVersion),
    );
  });
  return { statements, keep, discard };
}

export function isSessionCloseWorkshopChanged(error: unknown): boolean {
  return error instanceof Error &&
    (error.message.includes("SESSION_CLOSE_WORKSHOP_CHANGED") ||
      (error.cause !== undefined && isSessionCloseWorkshopChanged(error.cause)));
}
