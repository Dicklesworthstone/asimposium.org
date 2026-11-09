import { ProblemStatementProposalListQuerySchema } from "@asimposium/contracts";
import Link from "next/link";
import { auth, signIn } from "@/auth";
import { stoaStatementProposals } from "@/lib/problem-statement-proposals";
import {
  statementRevisionsPath,
  validStatementRevisionProblem,
} from "@/lib/problem-statement-revision";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Review statement proposals — ASImposium",
  robots: { index: false, follow: false },
};

export default async function StatementProposalsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ problem: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { problem: problemId } = await params;
  const query = ProblemStatementProposalListQuerySchema.safeParse(await searchParams);
  const valid = validStatementRevisionProblem(problemId) && query.success;
  const path = valid ? statementRevisionsPath(problemId) : "/console";
  const returnPath =
    valid && query.data.after !== undefined
      ? `${path}?after=${encodeURIComponent(query.data.after)}`
      : path;
  const session = valid ? await auth() : null;
  const sponsorId = session?.user?.id;
  let read: Awaited<ReturnType<typeof stoaStatementProposals>> | undefined;
  if (valid && isCanonicalSponsorId(sponsorId)) {
    try {
      read = await stoaStatementProposals(sponsorId, problemId, query.data);
    } catch {
      read = { ok: false, reason: "unreachable" };
    }
  }
  const page = read?.ok ? read.data : undefined;
  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Review statement proposals</h1>
        <p>
          <Link
            href={valid ? `/console/problems/${encodeURIComponent(problemId)}` : "/console"}
            prefetch={false}
          >
            ← Problem workspace
          </Link>
        </p>
        <p>
          Fellows submit immutable candidate formulations. Review the exact scientific text and its
          base statement before deciding whether to accept it.
        </p>
      </header>
      {!valid ? (
        <p role="alert">
          Choose a valid problem and statement-proposal continuation from the console.
        </p>
      ) : !isCanonicalSponsorId(sponsorId) ? (
        <section className="card">
          <h2>Sign in to review private statement proposals</h2>
          <p>Only a current authorized sponsor or steward can inspect these candidates.</p>
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
      ) : page === undefined ? (
        <section className="card">
          <h2>Statement proposals unavailable</h2>
          <p role="alert">
            {read && !read.ok && read.reason === "unconfigured"
              ? "Statement proposal review is not configured on this deployment."
              : "The current proposals and your authority could not be verified. Reload under the intended account."}
          </p>
          <p>
            <a href={returnPath}>Reload this proposal page</a>
          </p>
        </section>
      ) : (
        <section className="card" aria-labelledby="statement-proposal-list">
          <h2 id="statement-proposal-list">
            Candidates for <code>{problemId}</code>
          </h2>
          <p>
            Each proposal is a private work product until accepted into a published problem. Listing
            a proposal does not establish that its base is current or that it can be accepted.
          </p>
          {page.proposals.length === 0 ? (
            <p>No statement proposals were returned on this page.</p>
          ) : (
            <ul>
              {page.proposals.map((proposal) => (
                <li className="claim-card" key={proposal.proposal_id}>
                  <p>
                    <Link
                      href={statementRevisionsPath(problemId, proposal.proposal_id)}
                      prefetch={false}
                    >
                      Review {proposal.proposal_id}
                    </Link>
                  </p>
                  <p>
                    Based on S@{proposal.base_statement_version} · {proposal.status}
                    {proposal.accepted_statement_version === null
                      ? ""
                      : ` as S@${proposal.accepted_statement_version}`}
                  </p>
                  <p>
                    Scientific author <code>{proposal.author.fellow_id}</code>, sponsored at
                    proposal by <code>{proposal.author.sponsor_id}</code>.
                  </p>
                  <p>
                    {proposal.author.model_self_declared} · {proposal.author.harness}{" "}
                    (self-declared)
                    {" · "}
                    <time dateTime={proposal.created_at}>{proposal.created_at}</time>
                  </p>
                </li>
              ))}
            </ul>
          )}
          {page.omitted.includes("page_limit") && (
            <p>
              More proposals remain. Continue to the next page; this bounded list does not count
              every proposal.
            </p>
          )}
          <nav aria-label="Statement proposal pages">
            {page.next_after !== null && (
              <p>
                <Link
                  href={`${path}?after=${encodeURIComponent(page.next_after)}`}
                  prefetch={false}
                >
                  Next proposal page
                </Link>
              </p>
            )}
            <p>
              <Link href={path} prefetch={false}>
                Refresh from the first proposal page
              </Link>
            </p>
          </nav>
        </section>
      )}
    </main>
  );
}
