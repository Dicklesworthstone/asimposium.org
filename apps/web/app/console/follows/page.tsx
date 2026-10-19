import type { SponsorFollowListResponse } from "@asimposium/contracts";
import Link from "next/link";
import { auth, signIn } from "@/auth";
import { followPageHref, followPageQuery } from "@/lib/follow-view";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { configuredStoaOrigin, stoaConfigured, stoaSponsorFollows } from "@/lib/stoa";
import { FollowManager } from "../follow-card";

export const metadata = {
  title: "Followed research | ASImposium",
  robots: { index: false, follow: false },
};

export default async function FollowedProblems({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly problem?: string | string[]; readonly after?: string | string[] }>;
}) {
  const requested = await searchParams;
  const query = followPageQuery(requested);
  const session = await auth();
  const sponsorId = session?.user?.id;
  if (query === undefined) {
    return (
      <main className="landing col console" id="content">
        <h1>Choose a valid followed-problem page</h1>
        <p>This link has an invalid problem or continuation.</p>
        <Link href="/console/follows">Open the first page</Link>
      </main>
    );
  }
  const returnPath = followPageHref(query);
  if (!isCanonicalSponsorId(sponsorId)) {
    return (
      <main className="landing col console" id="content">
        <h1>Follow public research</h1>
        <p>Sign in to keep a private list of problems and see their latest material records and review needs.</p>
        {query.problem ? <p>Selected problem: <code>{query.problem}</code>. Following requires your decision after sign-in.</p> : null}
        <form action={async () => { "use server"; await signIn("google", { redirectTo: returnPath }); }}>
          <button className="btn-google" type="submit">Sign in with Google</button>
        </form>
        <p><Link href="/problems">Read public problems</Link></p>
      </main>
    );
  }
  const configured = await stoaConfigured();
  let page: SponsorFollowListResponse | null = null;
  if (configured) {
    const result = await stoaSponsorFollows(sponsorId, query.after === undefined ? {} : { after: query.after });
    if (result.ok) page = result.data;
  }
  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Followed research</h1>
        <p><Link href="/console">← Sponsor console</Link>{" · "}<Link href="/problems">Find public problems</Link></p>
      </header>
      <FollowManager key={sponsorId + ":" + (query.problem ?? "")} sponsorId={sponsorId}
        page={page} initialProblem={query.problem} configured={configured} stoaOrigin={configuredStoaOrigin()} />
    </main>
  );
}
