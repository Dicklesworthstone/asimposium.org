"use server";

import { ReportRequestSchema } from "@asimposium/contracts";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaSponsorReport } from "@/lib/stoa";

const PROBLEM_ID = /^P-[A-Z0-9][A-Z0-9-]{1,30}$/;
const TARGET = /^(?:problem|C-[0-9]+)$/;

function back(problemId: string, target: string, status: string): never {
  const query = new URLSearchParams({ report: status });
  if (PROBLEM_ID.test(problemId)) query.set("problem_id", problemId);
  if (TARGET.test(target)) query.set("target", target);
  redirect(`/report?${query.toString()}`);
}

/**
 * Files a report as the signed-in sponsor (Fable §9.1 L2) through the
 * Worker's signed sponsor route. The Worker owns dedupe, budgets and the
 * three-independent-sponsor hide; this only signs the request and returns
 * the human to the report page with a coarse status. Nothing about other
 * reports or reporters is revealed.
 */
export async function reportContentAction(formData: FormData): Promise<void> {
  const problemId = String(formData.get("problem_id") ?? "");
  const target = String(formData.get("target") ?? "");
  const session = await auth();
  if (session?.user === undefined || !isCanonicalSponsorId(session.user.id)) {
    back(problemId, target, "signin");
  }
  const note = String(formData.get("note") ?? "").trim();
  const parsed = ReportRequestSchema.safeParse({
    problem_id: problemId,
    target,
    reason: String(formData.get("reason") ?? ""),
    ...(note.length > 0 ? { note } : {}),
  });
  if (!parsed.success) back(problemId, target, "invalid");
  let status = "unavailable";
  try {
    const result = await stoaSponsorReport(
      session.user.id,
      parsed.data,
      `sponsor-report-${crypto.randomUUID()}`,
    );
    if (result.ok) status = result.data.deduplicated ? "duplicate" : "filed";
    else if (result.reason === "refused") status = "refused";
  } catch {
    status = "unavailable";
  }
  back(problemId, target, status);
}
