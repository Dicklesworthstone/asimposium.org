"use server";

import { canonicalJson, ReportRequestSchema, ReportResponseSchema } from "@asimposium/contracts";

import { auth } from "@/auth";
import {
  parseReportTarget,
  type ReportActionState,
  type ReportDraft,
  type ReportTarget,
  reportReceiptMatchesTarget,
} from "@/lib/report-submission";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaSponsorReport } from "@/lib/stoa";

function singleString(form: FormData, key: string): string | undefined {
  const values = form.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : undefined;
}

/**
 * Fable §9.1 L2. Only a matching Worker receipt confirms a report. The same
 * sponsor and canonical request have the same retry key without putting a
 * private note in a URL or browser storage. Stoa also deduplicates reports
 * permanently by sponsor family and target, independently of key retention.
 */
export async function reportContentAction(
  expectedSponsorId: string,
  target: ReportTarget,
  _previous: ReportActionState,
  formData: FormData,
): Promise<ReportActionState> {
  const reason = singleString(formData, "reason");
  const note = singleString(formData, "note");
  const draft: ReportDraft = {
    reason: typeof reason === "string" && reason.length <= 32 ? reason : "",
    note: typeof note === "string" && note.length <= 500 ? note : "",
  };
  const previouslyUncertain = _previous?.status === "refused" && _previous.uncertain === true;
  const refuse = (
    message: string,
    uncertain = previouslyUncertain,
  ): Extract<ReportActionState, { status: "refused" }> => ({
    status: "refused",
    message,
    draft,
    uncertain,
  });
  try {
    const session = await auth();
    if (session?.user === undefined || !isCanonicalSponsorId(session.user.id)) {
      return {
        status: "refused",
        message:
          "Sign in with Google again, then retry this report. Keep this page open to retain your draft.",
        draft,
        uncertain: previouslyUncertain,
        signInRequired: true,
      };
    }
    if (!isCanonicalSponsorId(expectedSponsorId) || session.user.id !== expectedSponsorId) {
      return refuse(
        "Your signed-in account changed. Return to the original account before retrying this report.",
      );
    }
    const parsedTarget = parseReportTarget(target?.problem_id, target?.target);
    const parsed = ReportRequestSchema.safeParse({
      ...parsedTarget,
      reason,
      ...(note?.trim() === "" ? {} : { note }),
    });
    if (!parsed.success || note === undefined) {
      return refuse(
        "Choose a valid conduct category and a note of at most 500 characters. Use the report link on the public record for its exact target.",
      );
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalJson({ sponsor: session.user.id, request: parsed.data })),
    );
    const key = `sponsor-report-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const result = await stoaSponsorReport(session.user.id, parsed.data, key);
    if (!result.ok) {
      if (result.reason === "unconfigured")
        return refuse("Reporting is not configured on this deployment. Your draft remains here.");
      if (result.reason === "unreachable" || result.status === undefined || result.status >= 500)
        return refuse(
          "The report outcome could not be confirmed. It may already be recorded. Retry this unchanged report to recover its receipt.",
          true,
        );
      if (result.status === 401)
        return {
          ...refuse("Sign in with Google again, then retry this report."),
          signInRequired: true,
        };
      if (result.status === 429)
        return refuse(
          "Stoa refused this attempt because the report budget is spent. Keep your draft and retry after the budget window.",
        );
      if (result.status === 404)
        return refuse(
          "Stoa could not find a reportable public record at this target. Return to the record and check its current visibility.",
        );
      return refuse(
        "Stoa refused this attempt. Check the public target and remove any credentials or private data from the note before retrying.",
      );
    }
    const receipt = ReportResponseSchema.safeParse(result.data);
    if (!receipt.success || !reportReceiptMatchesTarget(receipt.data, parsed.data))
      return refuse(
        "The report receipt did not match this target. Retry this unchanged report to recover a matching receipt.",
        true,
      );
    return { status: "committed", receipt: receipt.data };
  } catch {
    return refuse(
      "The report outcome could not be confirmed. It may already be recorded. Retry this unchanged report to recover its receipt.",
      true,
    );
  }
}
