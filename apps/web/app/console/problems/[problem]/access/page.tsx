import Link from "next/link";
import { PublicLedgerProblemIdSchema, SponsorProblemGovernanceQuerySchema } from "@asimposium/contracts";
import { auth, signIn } from "@/auth";
import { ProblemAccessControl } from "@/components/problem-access-control";
import { stoaProblemGovernance } from "@/lib/problem-governance";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Problem admission and membership — ASImposium",
  robots: { index: false, follow: false },
};

/** A private current-authority read; roster pages have a fixed server-side bound. */
export default async function ProblemAccessPage({ params, searchParams }: {
  readonly params: Promise<{ problem: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { problem: problemId } = await params;
  const query = SponsorProblemGovernanceQuerySchema.safeParse(await searchParams);
  const valid = PublicLedgerProblemIdSchema.safeParse(problemId).success &&
    typeof problemId === "string" && problemId.trim() === problemId && query.success;
  const returnPath = valid && query.success
    ? `/console/problems/${encodeURIComponent(problemId)}/access${query.data.after === undefined ? "" : `?after=${encodeURIComponent(query.data.after)}`}`
    : "/console";
  const session = valid ? await auth() : null;
  const principal = session?.user?.id;
  let read: Awaited<ReturnType<typeof stoaProblemGovernance>> | undefined;
  if (valid && query.success && isCanonicalSponsorId(principal)) {
    try { read = await stoaProblemGovernance(principal, problemId, query.data); }
    catch { read = { ok: false, reason: "unreachable" }; }
  }
  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Problem admission and membership</h1>
        <p><Link href="/console" prefetch={false}>← Sponsor console</Link></p>
        <p>Manage who can join a workspace and the roles of its Fellow members.</p>
      </header>
      {!valid ? <p role="alert">Choose a problem from the sponsor console. Only one bounded membership cursor is supported.</p>
        : !isCanonicalSponsorId(principal) ? (
          <section className="card">
            <h2>Sign in to inspect problem access</h2>
            <p>Only the accountable sponsor or a current authorized steward can inspect this workspace.</p>
            <form action={async () => {
              "use server";
              await signIn("google", { redirectTo: returnPath });
            }}><button className="btn-google" type="submit">Sign in with Google</button></form>
          </section>
        ) : read?.ok && query.success ? (
          <ProblemAccessControl key={`${principal}:${problemId}:${query.data.after ?? ""}`} sponsorId={principal} initial={read.data} query={query.data} returnPath={returnPath} />
        ) : (
          <section className="card">
            <h2>Problem access unavailable</h2>
            <p role="alert">{read && !read.ok && read.reason === "unconfigured"
              ? "Problem access controls are not configured on this deployment."
              : "The current workspace and your owner or steward authority could not be verified. Reload before making an access change."}</p>
            <p><a href={returnPath}>Reload current problem access</a></p>
          </section>
        )}
    </main>
  );
}
