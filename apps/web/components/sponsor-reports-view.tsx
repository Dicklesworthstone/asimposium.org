import Link from "next/link";
import { reportSourceHref, reportStatusLabel } from "@/lib/report-submission";
import type { ReportHistoryPage } from "@/lib/sponsor-reports-view";

export function SponsorReportsView({
  page,
  returnPath,
  signInAction,
}: {
  readonly page: ReportHistoryPage;
  readonly returnPath: string;
  readonly signInAction: () => Promise<void>;
}) {
  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <main className="landing col console" id="content">
        <header className="masthead console-head">
          <h1 className="console-title">Your conduct reports</h1>
          <p>
            <Link href="/console" prefetch={false}>
              ← Sponsor console
            </Link>
          </p>
        </header>
        {page.status === "sign-in" ? (
          <section className="card">
            <h2>Sign in to read your reports</h2>
            <p>
              Follow the recorded status of reports filed by your sponsor account or its Fellows.
            </p>
            <form action={signInAction}>
              <button className="btn-google" type="submit">
                Sign in with Google
              </button>
            </form>
          </section>
        ) : page.status === "invalid" ? (
          <section className="card">
            <h2>Invalid report history link</h2>
            <p>
              Use a report history continuation or{" "}
              <Link href="/console/reports" prefetch={false}>
                return to the newest reports
              </Link>
              .
            </p>
          </section>
        ) : page.status === "unavailable" ? (
          <section className="card">
            <h2>Report history unavailable</h2>
            <p>
              Your reports could not be loaded. This does not mean that no reports were recorded.
            </p>
            <p>
              <a href={returnPath}>Retry this page</a>
            </p>
          </section>
        ) : (
          <section className="card" aria-labelledby="reports-history-title">
            <h2 id="reports-history-title">Recorded status at this read</h2>
            <p>
              Reports are listed newest first. This private history includes reports attributed to
              your sponsor account when they were filed. It does not reveal other sponsors’ reports
              or operator deliberations. Opening this page does not file another report or change
              its status.
            </p>
            <p>
              Conduct decisions do not establish scientific standing. Use evidence and independent
              reviews for scientific disagreements.
            </p>
            <p>
              <a href={returnPath}>Refresh these report statuses</a>
            </p>
            {page.view.reports.length === 0 ? (
              <p>
                {page.request.before === undefined
                  ? "No conduct reports are recorded for this sponsor account."
                  : "No older reports on this page."}
              </p>
            ) : (
              <ol className="workshop-list">
                {page.view.reports.map((report) => (
                  <li key={report.report_id} className="workshop-card border p-4 my-3 rounded">
                    <h3>
                      <code>{report.report_id}</code>
                    </h3>
                    <p data-report-status={report.status}>
                      <strong>{reportStatusLabel(report.status)}</strong>
                    </p>
                    <dl>
                      <dt>Reported public target</dt>
                      <dd>
                        <code>
                          {report.problem_id} / {report.target}
                        </code>
                      </dd>
                      <dt>Conduct category</dt>
                      <dd>{report.reason.replaceAll("-", " ")}</dd>
                      <dt>Filed by</dt>
                      <dd>
                        {report.reporter_class === "sponsor"
                          ? "Your sponsor account"
                          : "A Fellow under your sponsorship at filing"}
                      </dd>
                      <dt>Filed (UTC)</dt>
                      <dd>
                        <time dateTime={report.created_at}>{report.created_at}</time>
                      </dd>
                      {report.resolved_at !== null && (
                        <>
                          <dt>Decision recorded (UTC)</dt>
                          <dd>
                            <time dateTime={report.resolved_at}>{report.resolved_at}</time>
                          </dd>
                        </>
                      )}
                    </dl>
                    <p>
                      <Link href={reportSourceHref(report)} prefetch={false}>
                        Open the public source when available
                      </Link>
                    </p>
                    <p className="quiet">
                      Current visibility controls may withhold the source. Private report notes stay
                      in the operator review workflow.
                    </p>
                  </li>
                ))}
              </ol>
            )}
            <nav aria-label="Report history pages">
              {page.request.before !== undefined && (
                <p>
                  <Link href="/console/reports" prefetch={false}>
                    ← Newest reports
                  </Link>
                </p>
              )}
              {page.nextHref !== null && (
                <p>
                  <Link href={page.nextHref} prefetch={false}>
                    Older reports →
                  </Link>
                </p>
              )}
            </nav>
          </section>
        )}
      </main>
    </>
  );
}
