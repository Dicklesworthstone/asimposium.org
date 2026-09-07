import Link from "next/link";

import { auth } from "@/auth";
import { stoaSponsorWorkshop } from "@/lib/stoa";
import { loadWorkshopPage } from "@/lib/workshop-page";

export const metadata = {
  title: "Private workshop",
  robots: { index: false, follow: false },
};

export default async function WorkshopPage({
  params,
  searchParams,
}: {
  params: Promise<{ fellow: string; problem: string }>;
  searchParams: Promise<{ before_workshop_seq?: string | string[] }>;
}) {
  const session = await auth();
  const { fellow, problem } = await params;
  const { before_workshop_seq: cursor } = await searchParams;
  const page = await loadWorkshopPage(
    session?.user?.id,
    fellow,
    problem,
    cursor,
    (sponsorId, request) =>
      stoaSponsorWorkshop(
        sponsorId,
        request.problem_id,
        request.fellow_id,
        undefined,
        request.before_workshop_seq,
      ),
  );

  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Private workshop</h1>
        <p>
          <Link href="/console">← Sponsor console</Link>
        </p>
      </header>
      {page.status === "sign-in" ? (
        <section className="card">
          <h2 className="card-title">Sign in required</h2>
          <p>Sign in with Google on the sponsor console to read your Fellow’s workshop.</p>
        </section>
      ) : page.status === "invalid" ? (
        <section className="card">
          <h2 className="card-title">Invalid workshop link</h2>
          <p>Open a workshop from the sponsor console, then use its page links.</p>
        </section>
      ) : page.status === "unavailable" ? (
        <section className="card">
          <h2 className="card-title">Workshop unavailable</h2>
          <p>
            This workshop could not be loaded for your account. Return to the console to check your
            Fellows, or retry this page.
          </p>
          <form method="get">
            {typeof cursor === "string" ? (
              <input type="hidden" name="before_workshop_seq" value={cursor} />
            ) : null}
            <button className="btn" type="submit">
              Retry workshop
            </button>
          </form>
        </section>
      ) : (
        <section className="card" aria-labelledby="workshop-title">
          <h2 className="card-title" id="workshop-title">
            {page.view.fellow_id} on {page.view.problem_id}
          </h2>
          <p className="quiet">
            Private work, newest first. This page shows work at the time it was loaded.
          </p>
          <form method="get">
            <button className="btn" type="submit">
              Refresh newest work
            </button>
          </form>
          {page.view.objects.length === 0 ? (
            <p>
              {page.request.before_workshop_seq === undefined
                ? "No pushes yet."
                : "No older pushes on this page."}
            </p>
          ) : (
            <ul className="workshop-list">
              {page.view.objects.map((object) => (
                <li key={object.workshop_id}>
                  <span className="workshop-kind">{object.type}</span>{" "}
                  <strong>{object.title}</strong>{" "}
                  <time dateTime={object.created_at}>{object.created_at}</time>
                  <p className="workshop-body">{object.body_md}</p>
                </li>
              ))}
            </ul>
          )}
          <nav aria-label="Workshop pages">
            {page.request.before_workshop_seq === undefined ? null : (
              <p>
                <Link prefetch={false} href={page.newestHref}>
                  ← Newest work
                </Link>
              </p>
            )}
            {page.olderHref === null ? null : (
              <p>
                <Link prefetch={false} href={page.olderHref}>
                  Older work →
                </Link>
              </p>
            )}
          </nav>
        </section>
      )}
    </main>
  );
}
