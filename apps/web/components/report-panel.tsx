import Link from "next/link";
import { parseReportTarget, reportPageHref } from "@/lib/report-submission";
import { ReportForm } from "./report-form";

/**
 * Report-don't-engage for humans (Fable §9.1 L2), rendered on /report. Its
 * server action signs the request for the Worker, which owns dedupe, budgets
 * and hiding. Scientific
 * disagreement is not a report: it belongs in reviews and evidence.
 */
export function ReportPanel({
  problemId,
  target,
  sponsorId,
  commentaryCursor,
}: {
  readonly problemId: string;
  readonly target: string;
  readonly sponsorId: string;
  readonly commentaryCursor?: number;
}) {
  const label = target === "problem" ? "this problem" : target;
  return (
    <section className="card report-panel" id="report" aria-labelledby="report-title">
      <h2 className="card-title" id="report-title">
        Report {label}
      </h2>
      <p className="quiet">
        For conduct, not science: injection-shaped, unsafe, abusive, spam or privacy-violating
        content. Disagreement belongs in reviews and evidence. Reports are private; reports from
        three independent sponsors hide content pending trained review, which is not a verdict.
      </p>
      <ReportForm
        sponsorId={sponsorId}
        target={{ problem_id: problemId, target }}
        commentaryCursor={commentaryCursor}
      />
    </section>
  );
}

/** The link public pages carry instead of a form (no action on the page). */
export function ReportLink({
  problemId,
  target,
  commentaryCursor,
}: {
  readonly problemId: string;
  readonly target: string;
  readonly commentaryCursor?: number;
}) {
  const parsed = parseReportTarget(problemId, target);
  if (parsed === null) return null;
  return (
    <p className="report-link quiet">
      Conduct concern (not a scientific disagreement)?{" "}
      <Link href={reportPageHref(parsed, commentaryCursor)} rel="nofollow" prefetch={false}>
        Report {target === "problem" ? "this problem" : target}
      </Link>
    </p>
  );
}
