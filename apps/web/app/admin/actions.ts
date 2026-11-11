"use server";

import {
  AdminAreaRenameRequestSchema,
  AdminAreaRenameResponseSchema,
  AdminContentControlRequestSchema,
  AdminContentControlResponseSchema,
  AdminQuarantineDecisionRequestSchema,
  AdminQuarantineDecisionResponseSchema,
  AdminReportResolutionRequestSchema,
  AdminReportResolutionResponseSchema,
  assertNoScientificDispositionOverride,
  parseModerationControlTarget,
} from "@asimposium/contracts";

import { requireOperatorSession } from "@/lib/admin";
import type {
  AdminModerationAttempt,
  AdminModerationKind,
  AdminModerationReceipt,
  AdminModerationState,
} from "@/lib/admin-moderation";
import {
  type StoaCall,
  stoaAdminContentControl,
  stoaAdminRenameArea,
  stoaAdminResolveQuarantine,
  stoaAdminResolveReport,
} from "@/lib/stoa";

const FIELDS = {
  quarantine: ["case_id", "decision", "reason"],
  report: ["report_id", "resolution", "reason"],
  content: ["target_id", "target_kind", "action", "reason"],
  area: ["area_id", "new_title", "reason"],
} as const;

function validKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,160}$/.exec(value)?.[0] === value;
}

function readDraft(kind: AdminModerationKind, form: FormData): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const field of [...FIELDS[kind], "idempotency_key"]) {
    const value = form.get(field);
    // An invalid hidden key cannot be repaired in the form; render its fresh
    // server-provided key instead. No invalid attempt has been dispatched.
    if (field === "idempotency_key" && !validKey(value)) continue;
    if (typeof value === "string") draft[field] = value.slice(0, field === "reason" ? 1000 : 160);
  }
  return draft;
}

function parseAttempt(
  kind: AdminModerationKind,
  form: FormData,
): AdminModerationAttempt | undefined {
  // Read all names before selecting fields: scientific override attempts must
  // be refused rather than silently stripped by the UI's narrower command.
  assertNoScientificDispositionOverride(Object.fromEntries(form));
  const fields = FIELDS[kind];
  const allowed = new Set<string>([
    ...fields,
    "idempotency_key",
    "confirmed_review",
    "expected_operator_id",
  ]);
  for (const name of form.keys()) {
    if (!name.startsWith("$ACTION_") && (!allowed.has(name) || form.getAll(name).length !== 1))
      return undefined;
  }
  const key = form.get("idempotency_key");
  if (!validKey(key)) return undefined;
  const raw = Object.fromEntries(fields.map((field) => [field, form.get(field)]));
  if (typeof raw.reason === "string") raw.reason = raw.reason.trim();
  if (kind === "area") {
    // Timestamp is derived from freshly verified auth before dispatch, never
    // accepted from the form or treated as part of the replayable intent.
    const parsed = AdminAreaRenameRequestSchema.safeParse({ ...raw, step_up_authenticated_at: 0 });
    if (!parsed.success) return undefined;
    const request = { area_id: parsed.data.area_id, new_title: parsed.data.new_title, reason: parsed.data.reason };
    return { kind, key, request };
  }
  if (kind === "quarantine") {
    const command = AdminQuarantineDecisionRequestSchema.safeParse(raw);
    return command.success ? { kind, key, request: command.data } : undefined;
  }
  if (kind === "report") {
    const command = AdminReportResolutionRequestSchema.safeParse(raw);
    return command.success ? { kind, key, request: command.data } : undefined;
  }
  const command = AdminContentControlRequestSchema.safeParse(raw);
  if (!command.success || command.data.action === "ban_sponsor") return undefined;
  // Share exact selectors with Worker admission. Publication authority is
  // checked there; neither surface silently broadens an @version pin.
  const target = parseModerationControlTarget(command.data.target_kind, command.data.target_id);
  return target === undefined ? undefined : { kind, key, request: command.data };
}

function matchedReceipt(
  attempt: AdminModerationAttempt,
  value: unknown,
): AdminModerationReceipt | undefined {
  if (attempt.kind === "area") {
    const parsed = AdminAreaRenameResponseSchema.safeParse(value);
    return parsed.success &&
      parsed.data.area_id === attempt.request.area_id &&
      parsed.data.new_title === attempt.request.new_title
      ? { kind: attempt.kind, result: parsed.data }
      : undefined;
  }
  if (attempt.kind === "quarantine") {
    const parsed = AdminQuarantineDecisionResponseSchema.safeParse(value);
    return parsed.success &&
      parsed.data.case_id === attempt.request.case_id &&
      parsed.data.decision === attempt.request.decision
      ? { kind: attempt.kind, result: parsed.data }
      : undefined;
  }
  if (attempt.kind === "report") {
    const parsed = AdminReportResolutionResponseSchema.safeParse(value);
    return parsed.success &&
      parsed.data.report_id === attempt.request.report_id &&
      parsed.data.resolution === attempt.request.resolution
      ? { kind: attempt.kind, result: parsed.data }
      : undefined;
  }
  const parsed = AdminContentControlResponseSchema.safeParse(value);
  return parsed.success &&
    parsed.data.target_id === attempt.request.target_id &&
    parsed.data.action === attempt.request.action
    ? { kind: attempt.kind, result: parsed.data }
    : undefined;
}

async function applyModeration(
  kind: AdminModerationKind,
  previous: AdminModerationState,
  form: FormData,
): Promise<AdminModerationState> {
  const session = await requireOperatorSession();
  if (
    session.state !== "authorized" ||
    form.getAll("expected_operator_id").length !== 1 ||
    session.operatorId !== form.get("expected_operator_id")
  ) {
    return {
      status: "refused",
      message:
        "Re-authenticate as the same operator and reload this page before deciding. No command was sent.",
    };
  }
  let attempt: AdminModerationAttempt | undefined;
  try {
    attempt = parseAttempt(kind, form);
  } catch {
    /* A scientific override is never dispatched. */
  }
  if (attempt === undefined || form.get("confirmed_review") !== "yes")
    return {
      status: "invalid",
      message:
        "Review the selected target and decision, confirm the review, and enter an audit reason of 10 to 1,000 characters. Content controls require a whole published object matching the selected kind, without an @version suffix; scientific state cannot be overridden.",
      draft: readDraft(kind, form),
    };
  if (
    previous.status === "unconfirmed" &&
    JSON.stringify(previous.attempt) !== JSON.stringify(attempt)
  )
    return {
      ...previous,
      message:
        "The pending decision must be retried with its exact target, reason and key. Reload and inspect the audit log before starting a different decision.",
    };
  // Action state arrives from the browser. Even a caller-supplied terminal
  // state cannot establish success: each submission needs a fresh Worker
  // receipt. Replaying its exact key is safe and never reapplies the decision.
  const unconfirmed = (
    message = "The decision could not be confirmed. Its exact draft and retry key are retained. Retry unchanged to recover the Worker's receipt, or inspect the audit log before starting another decision.",
  ): AdminModerationState => ({
    status: "unconfirmed",
    attempt,
    message,
  });
  try {
    const result: StoaCall<unknown> =
      attempt.kind === "area"
        ? await stoaAdminRenameArea(
            session.operatorId,
            { ...attempt.request, step_up_authenticated_at: session.authIssuedAt },
            attempt.key,
          )
        : attempt.kind === "quarantine"
          ? await stoaAdminResolveQuarantine(session.operatorId, attempt.request, attempt.key)
          : attempt.kind === "report"
            ? await stoaAdminResolveReport(session.operatorId, attempt.request, attempt.key)
            : await stoaAdminContentControl(session.operatorId, attempt.request, attempt.key);
    if (!result.ok) {
      if (result.reason === "unconfigured")
        return {
          status: "refused",
          attempt,
          message:
            "Operator controls are not configured on this deployment. No command was sent. Reload after configuration is restored.",
        };
      if (result.status !== undefined && result.status >= 400 && result.status < 500)
        return {
          status: "refused",
          attempt,
          ...(result.problemCode ? { code: result.problemCode } : {}),
          message:
            result.status === 401 || result.status === 403
              ? "The Worker refused this operator's authority. Re-authenticate and reload before deciding again. No success was confirmed."
              : result.status === 409
                ? "The Worker refused a conflicting decision. Inspect the current queue and audit log before starting a new decision; do not assume this action was applied."
                : result.status === 404
                  ? "The selected moderation target is no longer available. Reload and inspect its current state; no success was confirmed."
                  : "The Worker refused this decision. Reload the current target and review the command before trying again; no success was confirmed.",
        };
      return unconfirmed();
    }
    const receipt = matchedReceipt(attempt, result.data);
    if (receipt === undefined)
      return unconfirmed(
        "The Worker response did not contain a valid receipt for this exact target and decision. No success was confirmed. Retry unchanged to recover the receipt, or inspect the audit log.",
      );
    return {
      status: "committed",
      attempt,
      receipt,
      message:
        receipt.kind === "area"
          ? "Area rename recorded. The slug and problem assignments are unchanged. Reload its public face to inspect the current label."
          : receipt.kind === "quarantine"
            ? receipt.result.decision === "release"
              ? "Release recorded. The author may resubmit the exact held candidate; this decision does not itself publish it."
              : "Rejection recorded. The held submission remains unpublished; the author can use the appeal process."
            : receipt.kind === "report"
              ? `Report ${receipt.result.resolution === "dismiss" ? "dismissal" : "upholding"} recorded. Refresh the queue and public target to inspect the current moderation outcome.`
              : `Content ${receipt.result.action === "hide" ? "hide" : "restore"} recorded. The receipt records this decision; later decisions or other holds may change current visibility.`,
    };
  } catch {
    return unconfirmed();
  }
}

/** Progressive forms share a reviewed draft/key, but never share authority. */
export async function resolveQuarantineAction(
  previous: AdminModerationState,
  form: FormData,
): Promise<AdminModerationState> {
  return applyModeration("quarantine", previous, form);
}
export async function resolveReportAction(
  previous: AdminModerationState,
  form: FormData,
): Promise<AdminModerationState> {
  return applyModeration("report", previous, form);
}
export async function contentControlAction(
  previous: AdminModerationState,
  form: FormData,
): Promise<AdminModerationState> {
  return applyModeration("content", previous, form);
}
export async function renameAreaAction(
  previous: AdminModerationState,
  form: FormData,
): Promise<AdminModerationState> {
  return applyModeration("area", previous, form);
}
