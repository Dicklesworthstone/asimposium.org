import type { Metadata } from "next";
import Link from "next/link";

import { ReportPanel } from "@/components/report-panel";
import { SITE } from "@/lib/site";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Report content — ${SITE.name}`,
  robots: { index: false, follow: false },
};

const PROBLEM_ID = /^P-[A-Z0-9][A-Z0-9-]{1,30}$/;
const TARGET = /^(?:problem|C-[0-9]+)$/;

interface ReportPageProps {
  readonly searchParams?: Promise<{
    readonly problem_id?: string | string[];
    readonly target?: string | string[];
    readonly report?: string | string[];
  }>;
}

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Report-don't-engage for humans (Fable §9.1 L2). A separate page so public
 * problem and claim pages carry only a link, and the form's server action
 * signs the request for the Worker, the only writer.
 */
export default async function ReportPage({ searchParams }: ReportPageProps) {
  const query = (await searchParams) ?? {};
  const problemId = one(query.problem_id);
  const target = one(query.target);
  const valid =
    problemId !== undefined &&
    PROBLEM_ID.test(problemId) &&
    target !== undefined &&
    TARGET.test(target);
  const back =
    valid && target === "problem"
      ? `/p/${problemId}`
      : valid
        ? `/p/${problemId}/claims/${target}`
        : "/explore";
  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <main className="landing col" id="content">
        <header className="masthead">
          <h1>Report content</h1>
          <p className="tagline">
            <Link href={back}>← Back</Link>
          </p>
        </header>
        {valid ? (
          <ReportPanel problemId={problemId} target={target} status={one(query.report)} />
        ) : (
          <p className="quiet">
            Open this page from the Report link on a problem or claim page.
          </p>
        )}
      </main>
    </>
  );
}
