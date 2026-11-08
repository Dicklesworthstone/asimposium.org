import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { hiddenByContentControlSql } from "../krater/public-content.ts";
import {
  type PublishedProblemFormulation,
  readPublishedProblemFormulation,
} from "../ledger/problem-formulation-read.ts";

interface MoveProblemHead {
  readonly public_seq: number;
  readonly current_statement_version: number;
  readonly status: string;
  readonly unlisted: number;
  readonly admission_mode: string;
  readonly hidden: number;
}

export interface FormulationMoveContext {
  readonly head: MoveProblemHead;
  readonly source: PublishedProblemFormulation;
}

type FormulationMoveRead =
  | { readonly kind: "ready"; readonly context: FormulationMoveContext }
  | { readonly kind: "inactive" | "unavailable" };

const HEAD_SQL = `SELECT p.public_seq, p.current_statement_version, p.status, p.unlisted,
  p.admission_mode, CASE WHEN ${hiddenByContentControlSql("p.id", "'problem'")}
    THEN 1 ELSE 0 END AS hidden FROM problems p WHERE p.id = ?`;

/** Selected actions are current work, not a historical replay. The captured
 * cursor, mutable routing state and verified formulation must describe one
 * cut. Unlisted work is legal here: the provider already authorizes its scope. */
export async function readFormulationMoveContext(
  db: D1Database,
  problemId: string,
  cursor: number,
): Promise<FormulationMoveRead> {
  if (
    !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0
  )
    return { kind: "unavailable" };
  const head = await db.prepare(HEAD_SQL).bind(problemId).first<MoveProblemHead>();
  if (!head) return { kind: "unavailable" };
  if (
    head.status === "private-draft" ||
    head.status === "resolved" ||
    head.status === "retired" ||
    head.admission_mode === "archived-read-only"
  )
    return { kind: "inactive" };
  if (
    head.public_seq !== cursor ||
    head.hidden !== 0 ||
    !Number.isSafeInteger(head.current_statement_version) ||
    head.current_statement_version < 1 ||
    !["active", "sharpening", "dormant", "under-result-review"].includes(head.status) ||
    ![0, 1].includes(head.unlisted)
  )
    return { kind: "unavailable" };
  const source = await readPublishedProblemFormulation(db, problemId, cursor);
  if (
    source === undefined ||
    source.problem.current_statement_version !== head.current_statement_version
  )
    return { kind: "unavailable" };
  return { kind: "ready", context: { head, source } };
}

/** Recheck after async claim/anchor reads. A concurrent revision, lifecycle
 * change, hide or byte withdrawal must invalidate the prepared action. */
export async function formulationMoveContextStillCurrent(
  db: D1Database,
  problemId: string,
  cursor: number,
  expected: FormulationMoveContext,
): Promise<boolean> {
  const current = await readFormulationMoveContext(db, problemId, cursor);
  return current.kind === "ready" && JSON.stringify(current.context) === JSON.stringify(expected);
}
