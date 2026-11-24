"use server";

import { IntegrityCaseRespondRequestSchema } from "@asimposium/contracts/integrity-cases";
import { auth } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaRespondToIntegrityCase } from "@/lib/integrity-cases";
import {
  integrityKeyIsValid,
  integrityWriteState,
  singleIntegrityFormValue,
  type IntegrityActionState,
  type IntegrityAttempt,
} from "@/lib/integrity-view";

export async function respondToIntegrityCaseAction(
  previous: IntegrityActionState,
  form: FormData,
): Promise<IntegrityActionState> {
  const session = await auth().catch(() => null);
  const sponsorId = session?.user?.id;
  const expectedSponsorId = singleIntegrityFormValue(form, "expected_sponsor_id");
  if (!isCanonicalSponsorId(sponsorId) || sponsorId !== expectedSponsorId) return {
    status: "refused", message: "Sign in as the same affected sponsor and reload the case before responding.",
  };
  const caseId = singleIntegrityFormValue(form, "case_id");
  const revisionText = singleIntegrityFormValue(form, "expected_revision");
  const expectedRevision = revisionText !== undefined && /^[1-9][0-9]{0,15}$(?![\s\S])/.test(revisionText)
    ? Number(revisionText) : Number.NaN;
  const retry = previous?.status === "unconfirmed" && previous.attempt?.kind === "respond"
    ? previous.attempt : undefined;
  if (retry !== undefined && retry.principalId !== sponsorId) return {
    status: "refused", message: "The retained request belongs to a different signed-in account. Reload this case.",
  };
  const key = retry?.key ?? singleIntegrityFormValue(form, "idempotency_key");
  if (!retry && singleIntegrityFormValue(form, "confirmed_response") !== "yes") return {
    status: "invalid", message: "Confirm that you want this response or appeal recorded in the private case history.",
  };
  const parsed = IntegrityCaseRespondRequestSchema.safeParse(retry?.request ?? {
    case_id: caseId, expected_revision: expectedRevision,
    response: singleIntegrityFormValue(form, "response"),
  });
  if (!parsed.success || !integrityKeyIsValid(key)) return {
    status: "invalid", message: "Write a response of 10 to 8,000 characters and use the current case revision.",
  };
  if (parsed.data.case_id !== caseId || parsed.data.expected_revision !== expectedRevision) return {
    status: "refused", message: "The retained request does not match this case revision. Reload the case before another action.",
  };
  const attempt: IntegrityAttempt = { kind: "respond", principalId: sponsorId, key, request: parsed.data };
  try {
    return integrityWriteState(attempt, await stoaRespondToIntegrityCase(sponsorId, parsed.data, key));
  } catch {
    return integrityWriteState(attempt, { ok: false, reason: "unreachable" });
  }
}
