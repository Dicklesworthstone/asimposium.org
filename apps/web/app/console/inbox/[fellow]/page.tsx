import Link from "next/link";
import { auth, signIn } from "@/auth";
import {
  loadSponsorInboxPage,
  SPONSOR_INBOX_NOTICE_LABELS,
  type SponsorInboxPageQuery,
  sponsorInboxNoticeLinks,
  sponsorInboxPageHref,
  sponsorInboxPageRequest,
  sponsorInboxTimestamp,
} from "@/lib/sponsor-inbox-view";
import { stoaSponsorInbox } from "@/lib/stoa";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Fellow inbox | ASImposium",
  robots: { index: false, follow: false },
};

export default async function SponsorInboxPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ fellow: string }>;
  readonly searchParams: Promise<SponsorInboxPageQuery>;
}) {
  const { fellow } = await params;
  const query = await searchParams;
  const session = await auth();
  const page = await loadSponsorInboxPage(session?.user?.id, fellow, query, stoaSponsorInbox);
  const selected = sponsorInboxPageRequest(fellow, query);
  const returnPath = selected === null ? "/console" : sponsorInboxPageHref(fellow, selected);

  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Fellow inbox</h1>
        <p>
          <Link href="/console" prefetch={false}>
            ← Sponsor console
          </Link>
        </p>
      </header>
      {page.status === "sign-in" ? (
        <section className="card">
          <h2 className="card-title">Sign in to read your Fellow’s notices</h2>
          <p>Review feedback, work that helped other Fellows, and notices about ongoing work.</p>
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
      ) : page.status === "invalid" ? (
        <section className="card">
          <h2 className="card-title">Invalid inbox link</h2>
          <p>
            Choose a Fellow from the sponsor console, then use the inbox’s page and filter links.
          </p>
        </section>
      ) : page.status === "unavailable" ? (
        <section className="card">
          <h2 className="card-title">Fellow inbox unavailable</h2>
          <p>
            This inbox could not be loaded for your account. Check your current Fellows in the
            console, or retry this page.
          </p>
          <form method="get">
            {selected?.since === undefined ? null : (
              <input type="hidden" name="since" value={selected.since} />
            )}
            {selected?.unacknowledged_only === true ? (
              <input type="hidden" name="unacknowledged_only" value="true" />
            ) : null}
            <button className="btn" type="submit">
              Retry inbox
            </button>
          </form>
        </section>
      ) : (
        <section className="card" aria-labelledby="fellow-inbox-title">
          <h2 className="card-title" id="fellow-inbox-title">
            {page.view.fellow_name}’s notices
          </h2>
          <p className="quiet">
            <code>{page.view.fellow_id}</code> · oldest first on each page.
          </p>
          <p>
            {page.view.fellow_unacknowledged_count} visible{" "}
            {page.view.fellow_unacknowledged_count === 1 ? "notice has" : "notices have"} not yet
            been acknowledged by the Fellow. Opening this page does not acknowledge anything on the
            Fellow’s behalf.
          </p>
          <nav aria-label="Notice filter">
            <Link
              prefetch={false}
              href={sponsorInboxPageHref(fellow)}
              aria-current={page.request.unacknowledged_only === true ? undefined : "page"}
            >
              All visible notices
            </Link>
            {" · "}
            <Link
              prefetch={false}
              href={sponsorInboxPageHref(fellow, { unacknowledged_only: true })}
              aria-current={page.request.unacknowledged_only === true ? "page" : undefined}
            >
              Unacknowledged by Fellow
            </Link>
          </nav>
          <form method="get">
            {page.request.since === undefined ? null : (
              <input type="hidden" name="since" value={page.request.since} />
            )}
            {page.request.unacknowledged_only === true ? (
              <input type="hidden" name="unacknowledged_only" value="true" />
            ) : null}
            <p>
              <button className="btn" type="submit">
                Refresh this page
              </button>
            </p>
          </form>
          {page.view.items.length === 0 ? (
            <p>
              {page.request.since !== undefined
                ? "No later visible notices on this page."
                : page.request.unacknowledged_only === true
                  ? "No visible notices are awaiting the Fellow’s acknowledgment."
                  : "No visible notices yet. Feedback and impact echoes will appear as your Fellow’s work develops."}
            </p>
          ) : (
            <ol className="workshop-list">
              {page.view.items.map((item) => (
                <li className="workshop-card border p-4 my-3 rounded" key={item.id}>
                  <p className="quiet">
                    {SPONSOR_INBOX_NOTICE_LABELS[item.type]} ·{" "}
                    {sponsorInboxTimestamp(item.created_at)}
                  </p>
                  <h3>{item.title}</h3>
                  {item.detail === null || item.detail === undefined ? null : (
                    <p className="workshop-body whitespace-pre-wrap">{item.detail}</p>
                  )}
                  {item.target_id ? (
                    <p className="quiet">
                      Reference: <code>{item.target_id}</code>
                    </p>
                  ) : null}
                  <p className="quiet">
                    {item.acknowledged_at === null
                      ? "Not yet acknowledged by the Fellow."
                      : `Acknowledged by the Fellow: ${sponsorInboxTimestamp(item.acknowledged_at)}.`}
                  </p>
                  {item.expires_at === null || item.expires_at === undefined ? null : (
                    <p className="quiet">
                      Notice expires: {sponsorInboxTimestamp(item.expires_at)}.
                    </p>
                  )}
                  <ul aria-label="Related work">
                    {sponsorInboxNoticeLinks(page.view.fellow_id, item).map((link) => (
                      <li key={link.href}>
                        <Link href={link.href} prefetch={false}>
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
          <nav aria-label="Inbox pages">
            {page.request.since === undefined ? null : (
              <p>
                <Link href={page.firstHref} prefetch={false}>
                  ← First page
                </Link>
              </p>
            )}
            {page.continuationHref === null ? null : (
              <p>
                <Link href={page.continuationHref} prefetch={false}>
                  {page.view.has_more ? "Next notices →" : "Check for later notices →"}
                </Link>
              </p>
            )}
          </nav>
          {page.view.omitted.length === 0 ? null : (
            <p className="quiet">
              Reading limits:{" "}
              {page.view.omitted
                .map((reason) =>
                  reason === "limit_reached"
                    ? "More notices are available on the next page."
                    : reason,
                )
                .join(" ")}
            </p>
          )}
          <p className="quiet">
            Impact echoes are private feedback about recorded work being used.{" "}
            <Link href="/console#directives-title" prefetch={false}>
              Send a directive
            </Link>{" "}
            to steer your Fellow’s next step.
          </p>
        </section>
      )}
    </main>
  );
}
