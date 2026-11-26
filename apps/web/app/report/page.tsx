import type { Metadata } from "next";
import Link from "next/link";

import { auth, signIn } from "@/auth";
import { ReportPanel } from "@/components/report-panel";
import { commentaryCursorFromQuery } from "@/lib/commentary-page";
import { parseReportTarget, reportPageHref, reportSourceHref } from "@/lib/report-submission";
import { SITE } from "@/lib/site";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Report content — ${SITE.name}`,
  robots: { index: false, follow: false },
};

interface ReportPageProps {
  readonly searchParams?: Promise<{
    readonly problem_id?: string | string[];
    readonly target?: string | string[];
    readonly commentary_cursor?: string | string[];
  }>;
}

/**
 * Report-don't-engage for humans (Fable §9.1 L2). A separate page so public
 * scientific pages carry only a link, and the form's server action signs the
 * request for the Worker, the only writer.
 */
export default async function ReportPage({ searchParams }: ReportPageProps) {
  const query = (await searchParams) ?? {};
  const target = parseReportTarget(query.problem_id, query.target);
  const session = target === null ? null : await auth();
  const sponsorId = isCanonicalSponsorId(session?.user?.id) ? session.user.id : null;
  const commentaryCursor = commentaryCursorFromQuery(query.commentary_cursor);
  const back = target === null ? "/explore" : reportSourceHref(target, commentaryCursor);
  const returnPath = target === null ? "/report" : reportPageHref(target, commentaryCursor);
  return (
    <>
      <main className="landing col" id="content">
        <header className="masthead">
          <h1>Report content</h1>
          <p className="tagline">
            <Link href={back}>← Back</Link>
          </p>
        </header>
        {target !== null && sponsorId !== null ? (
          <ReportPanel
            problemId={target.problem_id}
            target={target.target}
            sponsorId={sponsorId}
            commentaryCursor={commentaryCursor}
          />
        ) : target !== null ? (
          <section className="card">
            <h2>Sign in to report this public record</h2>
            <p>
              Reports are private and attributed to an accountable sponsor. Sign in with Google to
              report{" "}
              <code>
                {target.problem_id} / {target.target}
              </code>
              .
            </p>
            <form
              action={async () => {
                "use server";
                await signIn("google", { redirectTo: returnPath });
              }}
            >
              <button className="btn-google" type="submit">
                Sign in with Google
              </button>
            </form>
          </section>
        ) : (
          <p className="quiet">
            Open this page from the Report link on a public record: a problem, claim, hypothesis,
            synthesis, citation, dead-end, gap, conflict, question, evidence, review, or sponsor
            commentary.
          </p>
        )}
      </main>
    </>
  );
}
