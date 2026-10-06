/**
 * Operator moderation controls (Fable §8.1 /admin, §9.1, §14.3): the durable
 * implementations behind the signed-operator routes the Agora console calls.
 * Every mutation records an operator_audit row and a public moderation-log
 * entry in the same transaction; none touches a scientific disposition or an
 * event envelope. The enrollment router authenticates the operator and parses
 * the body; these functions own the store and the response shapes.
 */

import {
  ADMIN_TARGET_KINDS,
  type AdminAuditEvent,
  AdminAuditHistoryResponseSchema,
  type AdminContentControlRequest,
  AdminContentControlResponseSchema,
  AdminQuarantineCaseDetailSchema,
  type AdminQuarantineDecisionRequest,
  AdminQuarantineDecisionResponseSchema,
  type AdminQuarantineItem,
  AdminQuarantineQueueResponseSchema,
  type AdminReportResolutionRequest,
  AdminReportResolutionResponseSchema,
  AdminReportsQueueResponseSchema,
  ReportReasonSchema,
  SCREENING_DECISION_PATHS,
  SCREENING_PROVIDER_STATUSES,
  ScreeningCoarseCategorySchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope";
import {
  applyOperatorControl,
  decideScreeningCase,
  getScreeningCase,
  listOperatorAudit,
  listPendingCases,
  listPendingReports,
  resolveReport,
  type ScreeningCaseRow,
} from "./store";

const SCREENING_SCHEMA = "https://a.asimposium.org/schemas/screening.v1.json";
const HEX64 = /^[a-f0-9]{64}$/;

function privateJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}

function notFound(example: Record<string, unknown>): Response {
  const response = validatedProblem({
    status: 404,
    code: "MODERATION_TARGET_NOT_FOUND",
    title: "No such moderation target",
    detail: "No case, report or public object matches this id. Nothing was changed.",
    fixHint: "Use an id from the operator queue or a public face, then retry.",
    rule: "A5",
    extensions: { schema: SCREENING_SCHEMA, example },
  });
  response.headers.set("cache-control", "private, no-store");
  return response;
}

function stateConflict(detail: string, example: Record<string, unknown>): Response {
  const response = validatedProblem({
    status: 409,
    code: "MODERATION_STATE_CONFLICT",
    title: "This moderation item is not in the state the action needs",
    detail,
    fixHint: "Refetch the queue; decided items are records and are never decided twice.",
    rule: "A5",
    extensions: { schema: SCREENING_SCHEMA, example, suggested_action: "refetch_and_reapply" },
  });
  response.headers.set("cache-control", "private, no-store");
  return response;
}

function oneOf<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function queueItem(row: ScreeningCaseRow): AdminQuarantineItem {
  const category = ScreeningCoarseCategorySchema.safeParse(row.coarse_category);
  return {
    id: row.case_id,
    target_id: `${row.problem_id}/${row.route}`.slice(0, 128),
    created_at: row.created_at,
    coarse_category: category.success ? category.data : "provider-unavailable",
    decision_path: oneOf(SCREENING_DECISION_PATHS, row.decision_path, "provider-error-fail-closed"),
    provider_status: oneOf(SCREENING_PROVIDER_STATUSES, row.provider_status, "error"),
    input_digest: row.input_digest,
    context_frontier_digest: row.context_digest,
    model_version: row.model_version,
    policy_version: row.policy_version,
    configuration_digest: row.configuration_digest,
    reviewer_state: "pending-operator-review",
    appeal_status: "none",
  };
}

export async function operatorQuarantineQueue(db: D1Database): Promise<Response> {
  const { rows, totalPending } = await listPendingCases(db);
  return privateJson(
    AdminQuarantineQueueResponseSchema.parse({
      items: rows.map(queueItem),
      total_pending: totalPending,
    }),
  );
}

export async function operatorQuarantineCase(db: D1Database, caseId: string): Promise<Response> {
  const row = /^QC-[0-9A-HJKMNP-TV-Z]{26}$/.test(caseId)
    ? await getScreeningCase(db, caseId)
    : undefined;
  if (row === undefined) return notFound({ case_id: "QC-0123456789ABCDEFGHJKMNPQRS" });
  let candidate: { kind: string; statement: string; falsifier: string | null };
  try {
    candidate = JSON.parse(row.candidate_json);
  } catch {
    candidate = { kind: "unknown", statement: "", falsifier: null };
  }
  return privateJson(
    AdminQuarantineCaseDetailSchema.parse({
      item: queueItem(row),
      problem_id: row.problem_id,
      route: row.route,
      fellow_id: row.fellow_id,
      sponsor_id: row.sponsor_id,
      outcome: row.outcome,
      state: row.state,
      candidate,
      decided_at: row.decided_at,
      decision_reason: row.decision_reason,
    }),
  );
}

export async function operatorQuarantineDecision(
  db: D1Database,
  operatorId: string,
  request: AdminQuarantineDecisionRequest,
): Promise<Response> {
  const result = await decideScreeningCase(db, operatorId, {
    caseId: request.case_id,
    decision: request.decision,
    reason: request.reason,
  });
  if (!result.ok) {
    return result.reason === "not-found"
      ? notFound({ case_id: request.case_id, decision: request.decision, reason: request.reason })
      : stateConflict("This case was already decided. Nothing was changed.", {
          case_id: request.case_id,
          decision: request.decision,
          reason: request.reason,
        });
  }
  return privateJson(
    AdminQuarantineDecisionResponseSchema.parse({
      ok: true,
      case_id: request.case_id,
      decision: request.decision,
      audit_event_id: result.auditEventId,
      decided_at: result.decidedAt,
    }),
  );
}

export async function operatorReportsQueue(db: D1Database): Promise<Response> {
  const { rows, totalPending } = await listPendingReports(db);
  return privateJson(
    AdminReportsQueueResponseSchema.parse({
      reports: rows.map((row) => ({
        report_id: row.report_id,
        target_id: `${row.problem_id}/${row.target_ref}`.slice(0, 128),
        target_kind: oneOf(ADMIN_TARGET_KINDS, row.target_kind, "problem"),
        created_at: row.created_at,
        reporter_class: row.reporter_class,
        category: ReportReasonSchema.safeParse(row.reason).success ? row.reason : "other",
        status: row.status,
      })),
      total_pending: totalPending,
    }),
  );
}

export async function operatorReportResolution(
  db: D1Database,
  operatorId: string,
  request: AdminReportResolutionRequest,
): Promise<Response> {
  const result = await resolveReport(db, operatorId, {
    reportId: request.report_id,
    resolution: request.resolution,
    reason: request.reason,
  });
  if (!result.ok) {
    const example = {
      report_id: request.report_id,
      resolution: request.resolution,
      reason: request.reason,
    };
    return result.reason === "not-found"
      ? notFound(example)
      : stateConflict("This report was already resolved. Nothing was changed.", example);
  }
  return privateJson(
    AdminReportResolutionResponseSchema.parse({
      ok: true,
      report_id: request.report_id,
      resolution: request.resolution,
      audit_event_id: result.auditEventId,
      resolved_at: result.resolvedAt,
    }),
  );
}

/**
 * Hide or restore a public problem or one public object on it. `target_id`
 * is `P-…` for the problem itself, or `P-…/<object id>` for an object.
 * Returns undefined for `ban_sponsor`, which this surface does not implement
 * (the caller answers with the honest unavailable refusal).
 */
export async function operatorContentControl(
  db: D1Database,
  operatorId: string,
  request: AdminContentControlRequest,
): Promise<Response | undefined> {
  if (request.action === "ban_sponsor") return undefined;
  const example = {
    target_id: "P-4DSP/C-12",
    target_kind: "claim",
    action: request.action,
    reason: request.reason,
  };
  const match = /^(P-[A-Z0-9][A-Z0-9-]{1,30})(?:\/([A-Za-z0-9@-]{1,96}))?$/.exec(request.target_id);
  const problemId = match?.[1];
  if (problemId === undefined) return notFound(example);
  const objectRef = match?.[2];
  const problem = await db
    .prepare("SELECT id FROM problems WHERE id = ?")
    .bind(problemId)
    .first<{ id: string }>();
  if (problem === null) return notFound(example);
  if (objectRef === undefined) {
    if (request.target_kind !== "problem") return notFound(example);
  } else {
    const objectId = objectRef.replace(/@[0-9]+$/, "");
    const exists = await db
      .prepare("SELECT object_kind FROM events WHERE problem_id = ? AND object_id = ? LIMIT 1")
      .bind(problemId, objectId)
      .first<{ object_kind: string }>();
    if (exists === null) return notFound(example);
  }
  const result = await applyOperatorControl(db, operatorId, {
    problemId,
    targetKind: request.target_kind,
    targetRef: objectRef ?? "problem",
    visibility: request.action === "hide" ? "hidden" : "visible",
    reason: request.reason,
  });
  if (!result.ok) {
    return stateConflict(
      `The target is already ${request.action === "hide" ? "hidden" : "visible"}. Nothing was changed.`,
      example,
    );
  }
  return privateJson(
    AdminContentControlResponseSchema.parse({
      ok: true,
      target_id: request.target_id,
      action: request.action,
      audit_event_id: result.auditEventId,
      applied_at: result.appliedAt,
    }),
  );
}

export async function operatorAuditHistory(db: D1Database): Promise<Response> {
  const rows = await listOperatorAudit(db);
  const events: AdminAuditEvent[] = rows.map((row) => ({
    event_id: row.event_id,
    timestamp: row.created_at,
    operator_id: row.operator_id,
    action: row.action,
    target_id: row.target_id,
    reason: row.reason,
    ...(row.before_state_digest !== null && HEX64.test(row.before_state_digest)
      ? { before_state_digest: row.before_state_digest }
      : {}),
    ...(row.after_state_digest !== null && HEX64.test(row.after_state_digest)
      ? { after_state_digest: row.after_state_digest }
      : {}),
  }));
  return privateJson(AdminAuditHistoryResponseSchema.parse({ events }));
}
