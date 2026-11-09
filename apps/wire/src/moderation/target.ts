import {
  MODERATION_LEDGER_TARGETS,
  type ModerationControlTarget,
  moderationLedgerTarget,
  moderationObjectIdIsValid,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

const CREATION_EVENT_SQL =
  "CASE e.object_kind " +
  MODERATION_LEDGER_TARGETS.map(
    ({ kind, created }) => "WHEN '" + kind + "' THEN '" + created + "'",
  ).join(" ") +
  " END";

/** Trusted SQL aliases only. Generic gap leases use the legacy proof_gap kind;
 * their three known coordination events do not create another scientific object.
 * Every other differing kind, including unknown lease events, remains ambiguous. */
export function conflictingModerationIdentitySql(sourceAlias: string, publicSeq: string): string {
  return (
    "EXISTS (SELECT 1 FROM events other_kind" +
    " WHERE other_kind.problem_id = " +
    sourceAlias +
    ".problem_id" +
    " AND other_kind.object_id = " +
    sourceAlias +
    ".object_id" +
    " AND other_kind.seq <= " +
    publicSeq +
    " AND other_kind.object_kind <> " +
    sourceAlias +
    ".object_kind" +
    " AND NOT (" +
    sourceAlias +
    ".object_kind = 'gap'" +
    " AND other_kind.object_kind = 'proof_gap'" +
    " AND other_kind.type IN ('lease.acquired', 'lease.released', 'lease.challenged')))"
  );
}

export interface ModerationTargetGuard {
  readonly sql: string;
  readonly bindings: readonly string[];
}

/** Recheck authority in the visibility INSERT, after all asynchronous reads.
 * Historic reports can retain their original disposition workflow without a
 * reconstructed creation source, but must never control an ambiguous identity. */
export function moderationTargetGuard(
  target: {
    readonly problemId: string;
    readonly targetKind: string;
    readonly targetRef: string;
  },
  options: { readonly requirePublication?: boolean } = {},
): ModerationTargetGuard {
  const denied = { sql: "0", bindings: [] };
  if (
    /\s/.test(target.problemId) ||
    !PublicLedgerProblemIdSchema.safeParse(target.problemId).success
  )
    return denied;
  if (target.targetKind === "problem") {
    return target.targetRef !== "problem"
      ? denied
      : {
          sql:
            "EXISTS (SELECT 1 FROM problems control_scope WHERE control_scope.id = ?" +
            " AND control_scope.status <> 'private-draft' AND control_scope.public_seq > 0)",
          bindings: [target.problemId],
        };
  }
  const descriptor = moderationLedgerTarget(target.targetKind);
  const requirePublication = options.requirePublication !== false;
  if (
    !descriptor ||
    (requirePublication && !moderationObjectIdIsValid(target.targetKind, target.targetRef))
  )
    return denied;
  return {
    sql: [
      "EXISTS (SELECT 1 FROM problems control_scope",
      "CROSS JOIN (SELECT ? AS problem_id, ? AS object_id, ? AS object_kind) control_identity",
      "WHERE control_scope.id = control_identity.problem_id",
      "AND control_scope.status <> 'private-draft' AND control_scope.public_seq > 0",
      "AND NOT " + conflictingModerationIdentitySql("control_identity", "control_scope.public_seq"),
      requirePublication
        ? [
            "AND EXISTS (SELECT 1 FROM events control_creation",
            "WHERE control_creation.problem_id = control_identity.problem_id",
            "AND control_creation.object_id = control_identity.object_id",
            "AND control_creation.object_kind = control_identity.object_kind",
            "AND control_creation.object_version = 1 AND control_creation.type = ?",
            "AND control_creation.seq <= control_scope.public_seq)",
          ].join(" ")
        : "",
      ")",
    ].join(" "),
    bindings: [
      target.problemId,
      target.targetRef,
      target.targetKind,
      ...(requirePublication ? [descriptor.created] : []),
    ],
  };
}

/** Admit the actual immutable publication, not an uncommitted projection or
 * lifecycle-only row. Current hiding is intentionally irrelevant to admission:
 * the same audited command must be able to restore a hidden publication.
 * Raw object references are shared by content_controls across kinds. Refuse
 * ambiguous identities instead of letting one kind's command hide another. */
export async function resolveModerationTarget(
  db: D1Database,
  problemId: string,
  targetRef: string,
  targetKind?: string,
): Promise<ModerationControlTarget | undefined> {
  if (/\s/.test(problemId) || !PublicLedgerProblemIdSchema.safeParse(problemId).success)
    return undefined;
  if (targetRef === "problem") {
    if (targetKind !== undefined && targetKind !== "problem") return undefined;
    const problem = await db
      .prepare(
        "SELECT id FROM problems WHERE id = ? AND status <> 'private-draft' AND public_seq > 0",
      )
      .bind(problemId)
      .first<{ id: string }>();
    return problem === null
      ? undefined
      : { problemId, targetKind: "problem", targetRef: "problem" };
  }
  if (targetKind !== undefined && !moderationObjectIdIsValid(targetKind, targetRef))
    return undefined;
  if (!MODERATION_LEDGER_TARGETS.some(({ kind }) => moderationObjectIdIsValid(kind, targetRef)))
    return undefined;
  const row = await db
    .prepare(
      [
        "SELECT e.object_kind FROM events e JOIN problems p ON p.id = e.problem_id",
        "WHERE p.id = ? AND p.status <> 'private-draft' AND p.public_seq > 0",
        "AND e.object_id = ? AND e.object_version = 1 AND e.seq <= p.public_seq",
        "AND e.type = " + CREATION_EVENT_SQL,
        targetKind === undefined ? "" : "AND e.object_kind = ?",
        "AND NOT " + conflictingModerationIdentitySql("e", "p.public_seq"),
        "ORDER BY e.seq ASC LIMIT 1",
      ].join("\n"),
    )
    .bind(problemId, targetRef, ...(targetKind === undefined ? [] : [targetKind]))
    .first<{ object_kind: string }>();
  const descriptor = row === null ? undefined : moderationLedgerTarget(row.object_kind);
  if (!descriptor || !moderationObjectIdIsValid(descriptor.kind, targetRef)) return undefined;
  return { problemId, targetKind: descriptor.kind, targetRef };
}

/** Reports retain their established whole-claim tally even when the author
 * reports an exact version. The requested version must itself be published;
 * source capture separately preserves that exact reference for investigation. */
export async function resolveReportTarget(
  db: D1Database,
  problemId: string,
  reference: string,
): Promise<ModerationControlTarget | undefined> {
  const pin = /^(C-[0-9]+)@([1-9][0-9]{0,8})$/.exec(reference);
  const target = await resolveModerationTarget(db, problemId, pin?.[1] ?? reference);
  if (target === undefined || pin === null) return target;
  if (target.targetKind !== "claim") return undefined;
  const source = await db
    .prepare(
      [
        "SELECT e.seq FROM events e JOIN problems p ON p.id = e.problem_id",
        "WHERE e.problem_id = ? AND e.object_kind = 'claim' AND e.object_id = ?",
        "AND e.object_version = ? AND e.type IN ('claim.created', 'claim.revised')",
        "AND e.seq <= p.public_seq AND p.status <> 'private-draft' LIMIT 1",
      ].join("\n"),
    )
    .bind(problemId, target.targetRef, Number(pin[2]))
    .first<{ seq: number }>();
  return source === null ? undefined : target;
}
