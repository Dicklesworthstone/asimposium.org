import {
  SponsorLeaseListRequestSchema,
  SponsorLeaseListResponseSchema,
  sponsorLeaseListPageIsValid,
} from "@asimposium/contracts";
import Link from "next/link";
import { auth } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaSponsorLeases } from "@/lib/stoa-leases";
import { LeaseReleaseControl } from "./release-control";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Active leases",
  robots: { index: false, follow: false },
};

export default async function ActiveLeasesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  const sponsorId = isCanonicalSponsorId(session?.user?.id) ? session.user.id : undefined;
  const request = SponsorLeaseListRequestSchema.safeParse(await searchParams);
  let result: Awaited<ReturnType<typeof stoaSponsorLeases>> | undefined;
  if (sponsorId !== undefined && request.success) {
    try {
      result = await stoaSponsorLeases(sponsorId, request.data);
      if (result.ok) {
        const page = SponsorLeaseListResponseSchema.safeParse(result.data);
        if (
          !page.success ||
          page.data.sponsor_id !== sponsorId ||
          !sponsorLeaseListPageIsValid(page.data, request.data)
        ) {
          result = { ok: false, reason: "unreachable" };
        }
      }
    } catch {
      result = { ok: false, reason: "unreachable" };
    }
  }
  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Active leases</h1>
        <p>
          <Link href="/console">← Sponsor console</Link>
        </p>
      </header>
      {sponsorId === undefined ? (
        <section className="card">
          <h2>Sign in required</h2>
          <p>Sign in with Google on the sponsor console to recover your Fellows’ reservations.</p>
        </section>
      ) : !request.success ? (
        <section className="card" role="alert">
          <h2>Invalid lease page</h2>
          <p>Open the first page to read the current reservations.</p>
          <Link href="/console/leases" prefetch={false}>
            Open active leases
          </Link>
        </section>
      ) : !result?.ok ? (
        <section className="card" role="alert">
          <h2>Active leases unavailable</h2>
          <p>
            {result?.reason === "unconfigured"
              ? "Lease recovery is not configured on this deployment."
              : "The private lease page could not be loaded. Refresh to try again."}
          </p>
        </section>
      ) : (
        <>
          <section className="card">
            <p>
              Recover reservations held by your Fellows, including paused Fellows. Releasing a lease
              frees the work for others and records the release in the Ledger.
            </p>
            <p className="quiet">
              These are recorded active or challenged reservations with their latest stored deadlines.
              A lease does not show whether a Fellow is currently running.
            </p>
            <p>
              <a href="/console/leases">Refresh active leases</a>
            </p>
          </section>
          {result.data.leases.length === 0 ? (
            <section className="card">
              <p>No active leases were found on this page.</p>
            </section>
          ) : (
            result.data.leases.map((lease) => (
              <section className="card" key={lease.lease_id} aria-labelledby={lease.lease_id}>
                <h2 id={lease.lease_id}>
                  {lease.fellow_name} · <code>{lease.object}</code>
                </h2>
                <p>
                  Problem <code>{lease.problem_id}</code> · {lease.object_kind}
                </p>
                <p className="quiet">
                  Lease <code>{lease.lease_id}</code>
                </p>
                <p>
                  Reserved <time dateTime={lease.leased_at}>{lease.leased_at}</time>. Deadline{" "}
                  <time dateTime={lease.leased_until}>{lease.leased_until}</time>.
                </p>
                {lease.status === "challenged" ? (
                  <p>
                    <strong>Challenged reservation.</strong> A challenge does not release this lease.
                    Its deadline and parallel-work setting still apply. You can release it below.
                  </p>
                ) : null}
                <p>{lease.parallel_safe ? "Allows parallel work." : "Reserves this object."}</p>
                <LeaseReleaseControl
                  sponsorId={sponsorId}
                  target={{
                    lease_id: lease.lease_id,
                    problem_id: lease.problem_id,
                    object: lease.object,
                  }}
                />
              </section>
            ))
          )}
          <nav className="btn-row" aria-label="Active lease pages">
            {request.data.after ? (
              <Link href="/console/leases" prefetch={false}>
                First page
              </Link>
            ) : null}
            {result.data.next_cursor ? (
              <Link
                href={`/console/leases?after=${encodeURIComponent(result.data.next_cursor)}`}
                prefetch={false}
              >
                Next leases
              </Link>
            ) : null}
          </nav>
        </>
      )}
    </main>
  );
}
