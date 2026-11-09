import { AdminReportIdSchema } from "@asimposium/contracts";
import Link from "next/link";
import { signIn } from "@/auth";
import { getReportDetail, requireOperatorSession } from "@/lib/admin";
import { AdminModerationControl } from "../../moderation-control";
import { ReportEvidence } from "../report-evidence";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Report review — ASImposium",
  robots: { index: false, follow: false },
};

export default async function ReportReviewPage({ params }: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  const valid = AdminReportIdSchema.safeParse(reportId).success;
  const session = await requireOperatorSession();
  const operatorId = session.state === "authorized" || session.state === "step_up_required" ? session.operatorId : undefined;
  const result = operatorId && valid ? await getReportDetail(operatorId, reportId) : undefined;
  const detail = result?.state === "ok" ? result.detail : undefined;
  const permalink = valid ? `/admin/reports/${reportId}` : "/admin";
  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Review a report</h1>
        <p><Link href="/admin" prefetch={false}>← Operator console</Link></p>
        <p>Review the private allegation and captured publication before deciding. Visibility decisions do not alter scientific standing.</p>
      </header>
      {session.state === "forbidden" ? <p role="alert">This account is not authorized for operator review.</p>
        : !operatorId ? <p>Sign in as an allowlisted operator to inspect this report.</p>
        : !valid ? <p role="alert">Use a complete RP report identifier from the operator queue.</p>
        : detail === undefined ? <p role="alert">{result?.state === "not-found" ? "No report matches this identifier." : "The report could not be loaded. Reload this page to retry."}</p>
        : <>
          <ReportEvidence detail={detail} />
          <AdminModerationControl operatorId={operatorId} kind="report" permalink={permalink}
            initialKey={`admin-report-${crypto.randomUUID()}`}
            available={session.state === "authorized" && detail.report.status === "pending" && detail.source.state === "available"}
            targets={[{ id: reportId, label: `${reportId} · ${detail.problem_id}/${detail.target_ref} · ${detail.report.category}` }]} />
        </>}
      {(session.state === "unauthenticated" || session.state === "step_up_required") ? <form action={async () => {
        "use server";
        await signIn("google", { redirectTo: permalink }, { prompt: "select_account", max_age: "0" });
      }} className="card">
        <p>Decisions require Google authentication within the last 15 minutes.</p>
        <button className="btn-google" type="submit">{operatorId ? "Re-authenticate with Google" : "Sign in with Google"}</button>
      </form> : null}
    </main>
  );
}
