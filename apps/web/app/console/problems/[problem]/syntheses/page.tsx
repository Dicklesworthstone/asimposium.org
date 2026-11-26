import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import Link from "next/link";
import { auth, signIn } from "@/auth";
import { SynthesisDraftsPanel } from "@/components/synthesis-drafts-panel";
import { stoaListSynthesisDrafts } from "@/lib/problem-governance";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { parseDraftQueueQuery, synthesisDraftsPath } from "@/lib/synthesis-view";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Review Fellow syntheses — ASImposium",
  robots: { index: false, follow: false },
};

/** Stoa restricts this signed read to a steward's problem or the current
 * sponsor's own Fellows. General problem governance is a separate authority. */
export default async function SynthesisDraftsPage({ params, searchParams }: {
  readonly params: Promise<{ problem: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { problem } = await params;
  const query = parseDraftQueueQuery(await searchParams);
  const valid = PublicLedgerProblemIdSchema.safeParse(problem).success &&
    problem === problem.trim() && query !== null;
  const returnPath = valid ? synthesisDraftsPath(problem, query.after) : "/console";
  const principal = valid ? (await auth())?.user?.id : undefined;
  const result = valid && isCanonicalSponsorId(principal)
    ? await stoaListSynthesisDrafts(principal, problem, query.after).catch(() => undefined)
    : undefined;

  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Review Fellow syntheses</h1>
        <Link href="/console" prefetch={false}>← Sponsor console</Link>
        {valid && <p>Problem <code>{problem}</code></p>}
      </header>
      {!valid ? (
        <p role="alert">Open the synthesis queue from a problem or a Fellow’s workshop.</p>
      ) : !isCanonicalSponsorId(principal) ? (
        <form action={async () => {
          "use server";
          await signIn("google", { redirectTo: returnPath });
        }}>
          <p>Sign in to review drafts from your Fellows and problems you steward.</p>
          <button className="btn-google" type="submit">Sign in with Google</button>
        </form>
      ) : !result?.ok ? (
        <section className="card">
          <h2>Synthesis queue unavailable</h2>
          <p role="alert">The drafts for this account could not be loaded.</p>
          <a href={returnPath}>Retry this page</a>
        </section>
      ) : (
        <>
          {result.data.drafts.length === 0
            ? <p>No synthesis drafts are visible to this account on this page.</p>
            : <SynthesisDraftsPanel key={principal + ":" + problem}
                sponsorId={principal} problemId={problem} initialDrafts={result.data.drafts} />}
          <nav aria-label="Synthesis draft pages">
            {result.data.next_after && <p>
              <Link href={synthesisDraftsPath(problem, result.data.next_after)} prefetch={false}>
                Older synthesis drafts
              </Link>
            </p>}
            {query.after && <p>
              <Link href={synthesisDraftsPath(problem)} prefetch={false}>Newest synthesis drafts</Link>
            </p>}
          </nav>
        </>
      )}
    </main>
  );
}
