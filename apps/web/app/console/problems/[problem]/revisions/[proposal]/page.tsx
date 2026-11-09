import Link from "next/link";
import { auth, signIn } from "@/auth";
import { ProblemStatementRevisionControl } from "@/components/problem-statement-revision-control";
import { StatementRevisionPreview } from "@/components/problem-statement-revision-preview";
import { stoaStatementRevisionPreview } from "@/lib/problem-statement-proposals";
import {
  statementRevisionsPath,
  validStatementProposalId,
  validStatementRevisionProblem,
} from "@/lib/problem-statement-revision";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Review an exact statement revision — ASImposium",
  robots: { index: false, follow: false },
};

export default async function StatementRevisionPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ problem: string; proposal: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { problem: problemId, proposal: proposalId } = await params;
  const query = await searchParams;
  const valid =
    validStatementRevisionProblem(problemId) &&
    validStatementProposalId(proposalId) &&
    Object.keys(query).length === 0;
  const returnPath = valid ? statementRevisionsPath(problemId, proposalId) : "/console";
  const session = valid ? await auth() : null;
  const sponsorId = session?.user?.id;
  let read: Awaited<ReturnType<typeof stoaStatementRevisionPreview>> | undefined;
  if (valid && isCanonicalSponsorId(sponsorId)) {
    try {
      read = await stoaStatementRevisionPreview(sponsorId, problemId, proposalId);
    } catch {
      read = { ok: false, reason: "unreachable" };
    }
  }
  const preview = read?.ok ? read.data : undefined;
  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Review an exact statement revision</h1>
        <p>
          <Link href={valid ? statementRevisionsPath(problemId) : "/console"} prefetch={false}>
            ← Statement proposals
          </Link>
        </p>
        <p>
          Inspect the complete candidate and its scientific authorship. Acceptance uses the exact
          reviewed proposal and preserves the statement lineage.
        </p>
      </header>
      {!valid ? (
        <p role="alert">Choose an exact statement proposal from the current problem workspace.</p>
      ) : !isCanonicalSponsorId(sponsorId) ? (
        <section className="card">
          <h2>Sign in to inspect this private proposal</h2>
          <p>The current sponsor or steward must review the exact candidate before accepting it.</p>
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
        <>
          {preview === undefined ? (
            <section className="card">
              <h2>Exact proposal unavailable</h2>
              <p role="alert">
                The complete candidate and your current authority could not be verified. Reload
                under the intended sponsor account before making a new acceptance.
              </p>
              <p>
                <a href={returnPath}>Reload this exact preview</a>
              </p>
            </section>
          ) : (
            <StatementRevisionPreview preview={preview} />
          )}
          <ProblemStatementRevisionControl
            key={`${sponsorId}:${problemId}:${proposalId}:${preview?.review_digest ?? "recovery"}`}
            sponsorId={sponsorId}
            problemId={problemId}
            isPrivate={preview?.problem.status === "private-draft"}
            reviewed={
              preview?.can_accept
                ? {
                    action: "revise-statement",
                    proposal_id: preview.proposal.proposal_id,
                    reviewed_statement_version: preview.proposal.base_statement_version,
                    reviewed_digest: preview.review_digest,
                  }
                : null
            }
          />
        </>
      )}
    </main>
  );
}
