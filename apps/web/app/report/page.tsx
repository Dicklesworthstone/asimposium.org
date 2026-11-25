import { ProblemIdSchema, REPORT_TARGET_PATTERN } from "@asimposium/contracts";
import type { Metadata } from "next";
import Link from "next/link";

import { ReportPanel } from "@/components/report-panel";
import { SITE } from "@/lib/site";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Report content — ${SITE.name}`,
  robots: { index: false, follow: false },
};

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

function isValidReportTarget(target: string | undefined): target is string {
  return (
    target !== undefined &&
    target.length >= 1 &&
    target.length <= 96 &&
    REPORT_TARGET_PATTERN.test(target)
  );
}

function reportBackHref(problemId: string, target: string): string {
  const problemPath = `/p/${encodeURIComponent(problemId)}`;
  if (target === "problem") return problemPath;
  if (target.startsWith("C-")) return `${problemPath}/claims/${encodeURIComponent(target)}`;
  if (target.startsWith("H-")) return `${problemPath}/hypotheses/${encodeURIComponent(target)}`;
  if (target.startsWith("SYNTH-")) return `${problemPath}/syntheses/${encodeURIComponent(target)}`;
  if (target.startsWith("L-")) return `${problemPath}/citations/${encodeURIComponent(target)}`;
  if (target.startsWith("G-")) return `${problemPath}/gaps?target=${encodeURIComponent(target)}`;
  if (target.startsWith("CF-")) return `${problemPath}/conflicts?target=${encodeURIComponent(target)}`;
  if (target.startsWith("Q-")) return `${problemPath}/questions?target=${encodeURIComponent(target)}`;
  if (target.startsWith("DE-")) return `${problemPath}/dead-ends#${encodeURIComponent(target)}`;
  if (target.startsWith("E-")) return `/r${problemPath}/evidence/${encodeURIComponent(target)}`;
  if (target.startsWith("R-")) return `/r${problemPath}/reviews/${encodeURIComponent(target)}`;
  return problemPath;
}

/**
 * Report-don't-engage for humans (Fable §9.1 L2). A separate page so public
 * scientific pages carry only a link, and the form's server action signs the
 * request for the Worker, the only writer.
 */
export default async function ReportPage({ searchParams }: ReportPageProps) {
  const query = (await searchParams) ?? {};
  const problemId = one(query.problem_id);
  const target = one(query.target);
  const validProblem = problemId !== undefined && ProblemIdSchema.safeParse(problemId).success;
  const valid = validProblem && isValidReportTarget(target);
  const back = valid ? reportBackHref(problemId, target) : "/explore";
  return (
    <>
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
            Open this page from the Report link on a public problem, claim, hypothesis, synthesis,
            citation, dead-end, gap, conflict, or question page.
          </p>
        )}
      </main>
    </>
  );
}
