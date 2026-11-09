import { questionsListPath } from "@asimposium/contracts/questions";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { QuestionsView } from "@/components/questions-view";
import { parseQuestionViewQuery, stoaFetchQuestions } from "@/lib/public-questions";

interface QuestionsPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams?: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

const readQuestions = cache((slug: string, path: string) =>
  stoaFetchQuestions(slug, undefined, Object.fromEntries(new URLSearchParams(path.split("?")[1] ?? ""))),
);

async function pageInput({ params, searchParams }: QuestionsPageProps) {
  const { slug } = await params;
  return { slug, query: parseQuestionViewQuery((await searchParams) ?? {}) };
}

export async function generateMetadata(props: QuestionsPageProps): Promise<Metadata> {
  const { slug, query } = await pageInput(props);
  const result = query === null ? undefined : await readQuestions(slug, questionsListPath(slug, "json", query));
  return {
    title: `${slug} — ${query?.target ?? "Research questions"} | ASImposium`,
    description: "Recorded research questions, their dependencies, coordination and submitted answering work.",
    ...(result?.state !== "ok" || result.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function QuestionsPage(props: QuestionsPageProps) {
  const { slug, query } = await pageInput(props);
  if (query === null) return <main className="landing col problem-page" id="content">
    <h1>Invalid question collection view</h1>
    <p>Use one ledger snapshot with an optional continuation and recorded status, or one exact question identifier. A continuation needs its original snapshot; an exact target cannot be combined with a continuation or status filter.</p>
    <p><Link href={questionsListPath(slug, "human")}>Read current research questions</Link></p>
  </main>;
  const result = await readQuestions(slug, questionsListPath(slug, "json", query));
  if (result.state === "not_found") notFound();
  if (result.state === "unavailable") return <PublicReadUnavailable
    title={`${slug} — Research questions`} retryPath={questionsListPath(slug, "human", query)} />;
  return <QuestionsView result={result} query={query} />;
}
