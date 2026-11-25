"use server";

import {
  INTEGRITY_CASE_MAX_CORRECTIONS,
  IntegrityCaseOpenRequestSchema,
  IntegrityCaseResolveRequestSchema,
} from "@asimposium/contracts/integrity-cases";
import { requireOperatorSession } from "@/lib/admin";
import { stoaOpenIntegrityCase, stoaResolveIntegrityCase } from "@/lib/integrity-cases";
import {
  integrityAuthIsRecent,
  integrityKeyIsValid,
  integrityWriteState,
  singleIntegrityFormValue,
  type IntegrityActionState,
  type IntegrityAttempt,
} from "@/lib/integrity-view";

async function currentOperator(expectedOperatorId: string | undefined) {
  const session = await requireOperatorSession().catch(() => null);
  if ((session?.state !== "authorized" && session?.state !== "step_up_required") ||
    session.operatorId !== expectedOperatorId) return { state: "refused" } as const;
  return session.state === "authorized" && integrityAuthIsRecent(session.authIssuedAt)
    ? { state: "authorized", session } as const
    : { state: "step-up", operatorId: session.operatorId } as const;
}

const authRefusal = (): IntegrityActionState => ({
  status: "refused",
  message: "Re-authenticate as the same operator and reload this exact report or case before acting.",
});
const invalid = (message: string): IntegrityActionState => ({ status: "invalid", message });

/** Expiry is not a decision about the pending write; retain its bounded, same-owner intent. */
function pendingStepUp(
  previous: IntegrityActionState,
  operatorId: string,
  kind: "open" | "resolve",
): IntegrityActionState {
  if (previous?.status !== "unconfirmed" || previous.attempt?.kind !== kind ||
    previous.attempt.principalId !== operatorId || !integrityKeyIsValid(previous.attempt.key))
    return authRefusal();
  const attempt = previous.attempt;
  const message = "This request still has an unconfirmed outcome. Re-authenticate as the same operator in another tab, keep this page open, and retry the unchanged operation here. No new write was sent.";
  if (attempt.kind === "open") {
    const parsed = IntegrityCaseOpenRequestSchema.safeParse(attempt.request);
    if (parsed.success) return { status: "unconfirmed", message,
      attempt: { kind: "open", principalId: operatorId, key: attempt.key, request: parsed.data } };
  } else if (attempt.kind === "resolve") {
    const parsed = IntegrityCaseResolveRequestSchema.safeParse(attempt.request);
    if (parsed.success) return { status: "unconfirmed", message,
      attempt: { kind: "resolve", principalId: operatorId, key: attempt.key, request: parsed.data } };
  }
  return authRefusal();
}

export async function openIntegrityCaseAction(
  previous: IntegrityActionState,
  form: FormData,
): Promise<IntegrityActionState> {
  const access = await currentOperator(singleIntegrityFormValue(form, "expected_operator_id"));
  if (access.state === "refused") return authRefusal();
  if (access.state === "step-up") return pendingStepUp(previous, access.operatorId, "open");
  const session = access.session;
  const reportId = singleIntegrityFormValue(form, "report_id");
  const retry = previous?.status === "unconfirmed" && previous.attempt?.kind === "open"
    ? previous.attempt : undefined;
  if (retry !== undefined && retry.principalId !== session.operatorId) return authRefusal();
  const key = retry?.key ?? singleIntegrityFormValue(form, "idempotency_key");
  const noticeValues = form.getAll("public_notice");
  const noticeValid = noticeValues.length === 0 ||
    (noticeValues.length === 1 && noticeValues[0] === "yes");
  if (!retry && (singleIntegrityFormValue(form, "confirmed_review") !== "yes" || !noticeValid))
    return invalid("Review the captured report, confirm that you have no conflict, and describe the concern before opening a case.");
  // Authentication is fresh dispatch context; the retained operation and key stay identical.
  const parsed = IntegrityCaseOpenRequestSchema.safeParse(retry === undefined ? {
    report_id: reportId,
    concern: singleIntegrityFormValue(form, "concern"),
    summary: singleIntegrityFormValue(form, "summary"),
    conflict_declaration: singleIntegrityFormValue(form, "conflict_declaration"),
    public_notice: noticeValues.length === 1,
    auth_issued_at: session.authIssuedAt,
  } : { ...retry.request, auth_issued_at: session.authIssuedAt });
  if (!parsed.success || !integrityKeyIsValid(key))
    return invalid("Choose a concern, write a private summary of 10 to 4,000 characters, and confirm the review and absence of conflicts.");
  if (parsed.data.report_id !== reportId || parsed.data.auth_issued_at !== session.authIssuedAt)
    return authRefusal();
  const attempt: IntegrityAttempt = { kind: "open", principalId: session.operatorId, key, request: parsed.data };
  try {
    return integrityWriteState(attempt,
      await stoaOpenIntegrityCase(session.operatorId, parsed.data, key));
  } catch {
    return integrityWriteState(attempt, { ok: false, reason: "unreachable" });
  }
}

export async function resolveIntegrityCaseAction(
  previous: IntegrityActionState,
  form: FormData,
): Promise<IntegrityActionState> {
  const access = await currentOperator(singleIntegrityFormValue(form, "expected_operator_id"));
  if (access.state === "refused") return authRefusal();
  if (access.state === "step-up") return pendingStepUp(previous, access.operatorId, "resolve");
  const session = access.session;
  const caseId = singleIntegrityFormValue(form, "case_id");
  const revisionText = singleIntegrityFormValue(form, "expected_revision");
  const expectedRevision = revisionText !== undefined && /^[1-9][0-9]{0,15}$(?![\s\S])/.test(revisionText)
    ? Number(revisionText) : Number.NaN;
  const retry = previous?.status === "unconfirmed" && previous.attempt?.kind === "resolve"
    ? previous.attempt : undefined;
  if (retry !== undefined && retry.principalId !== session.operatorId) return authRefusal();
  const key = retry?.key ?? singleIntegrityFormValue(form, "idempotency_key");
  const problems = form.getAll("correction_problem");
  const targets = form.getAll("correction_target");
  if (!retry && (singleIntegrityFormValue(form, "confirmed_review") !== "yes" ||
    problems.length !== targets.length || problems.length > INTEGRITY_CASE_MAX_CORRECTIONS ||
    problems.some((value) => typeof value !== "string") ||
    targets.some((value) => typeof value !== "string")))
    return invalid("Review the case and its source, confirm the absence of conflicts, and pair every correction with its problem.");
  const corrections = problems.map((value, index) => ({
    problem_id: typeof value === "string" ? value.trim() : "",
    target_ref: typeof targets[index] === "string" ? (targets[index] as string).trim() : "",
  })).filter((ref) => ref.problem_id !== "" || ref.target_ref !== "");
  // The Worker excludes auth freshness from idempotent scientific-integrity intent.
  const parsed = IntegrityCaseResolveRequestSchema.safeParse(retry === undefined ? {
    case_id: caseId, expected_revision: expectedRevision,
    outcome: singleIntegrityFormValue(form, "outcome"),
    rationale: singleIntegrityFormValue(form, "rationale"),
    correction_refs: corrections,
    conflict_declaration: singleIntegrityFormValue(form, "conflict_declaration"),
    auth_issued_at: session.authIssuedAt,
  } : { ...retry.request, auth_issued_at: session.authIssuedAt });
  if (!parsed.success || !integrityKeyIsValid(key))
    return invalid("Choose an outcome, explain it in 10 to 4,000 characters, and use at most eight distinct published correction references. Claims must include their exact version, for example C-12@3.");
  if (parsed.data.case_id !== caseId || parsed.data.expected_revision !== expectedRevision ||
    parsed.data.auth_issued_at !== session.authIssuedAt) return authRefusal();
  const attempt: IntegrityAttempt = { kind: "resolve", principalId: session.operatorId, key, request: parsed.data };
  try {
    return integrityWriteState(attempt,
      await stoaResolveIntegrityCase(session.operatorId, parsed.data, key));
  } catch {
    return integrityWriteState(attempt, { ok: false, reason: "unreachable" });
  }
}
