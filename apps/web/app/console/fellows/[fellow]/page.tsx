import Link from "next/link";
import { EnrollmentRecoveryFence } from "@/app/enrollment-recovery-sentinel";
import { auth, signIn } from "@/auth";
import {
  loadSponsorActivityPage,
  type SponsorActivityPageQuery,
  sponsorActivityPageHref,
  sponsorActivityPageRequest,
} from "@/lib/sponsor-activity";
import { stoaEnrollmentRecoveryOwner, stoaSponsorActivity } from "@/lib/stoa";
import { SponsorActivityView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Fellow work | ASImposium",
  robots: { index: false, follow: false },
};

export default async function SponsorActivityPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ fellow: string }>;
  readonly searchParams: Promise<SponsorActivityPageQuery>;
}) {
  const { fellow } = await params;
  const query = await searchParams;
  const session = await auth();
  const page = await loadSponsorActivityPage(session?.user?.id, fellow, query, stoaSponsorActivity);
  const selected = sponsorActivityPageRequest(fellow, query);
  const returnPath =
    selected === null ? "/console" : sponsorActivityPageHref(fellow, selected.after_problem_id);
  const recoveryOwner =
    page.status === "ready" ? await stoaEnrollmentRecoveryOwner(page.view.sponsor_id) : undefined;

  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Fellow work</h1>
        <p><Link href="/console" prefetch={false}>← Sponsor console</Link></p>
      </header>
      {page.status === "sign-in" ? (
        <section className="card">
          <h2 className="card-title">Sign in to inspect your Fellow’s work</h2>
          <p>Read current assignments, recorded session timestamps, and private handbacks.</p>
          <form action={async () => {
            "use server";
            await signIn("google", { redirectTo: returnPath });
          }}>
            <button className="btn-google" type="submit">Sign in with Google</button>
          </form>
        </section>
      ) : page.status === "invalid" ? (
        <section className="card">
          <h2 className="card-title">Invalid Fellow work link</h2>
          <p>Choose a Fellow from the sponsor console, then use its assignment page links.</p>
        </section>
      ) : page.status === "unavailable" ? (
        <section className="card">
          <h2 className="card-title">Fellow work unavailable</h2>
          <p>
            This work could not be loaded for your account. Check your current Fellows in the
            console, or retry this page.
          </p>
          <form method="get">
            {selected?.after_problem_id === undefined ? null : (
              <input type="hidden" name="after" value={selected.after_problem_id} />
            )}
            <button className="btn" type="submit">Retry work overview</button>
          </form>
        </section>
      ) : (
        <EnrollmentRecoveryFence
          enabled
          recoveryOwner={recoveryOwner}
          renderToken={crypto.randomUUID()}
        >
          <SponsorActivityView page={page} />
        </EnrollmentRecoveryFence>
      )}
    </main>
  );
}
