import Link from "next/link";

import { auth } from "@/auth";
import { stoaSponsorWorkshop } from "@/lib/stoa";
import { loadWorkshopPage } from "@/lib/workshop-page";
import { ConsoleAutoRefresh } from "@/app/console/console-auto-refresh";

export const metadata = {
  title: "Private workshop",
  robots: { index: false, follow: false },
};

function WorkshopCardActions({
  workshopId,
  version,
}: {
  workshopId: string;
  version: number;
}) {
  return (
    <div className="workshop-card-actions flex gap-2 items-center mt-3 pt-2 border-t flex-wrap">
      <form key={`promote-form-${workshopId}`} method="post" className="inline-flex">
        <input key={`promote-id-${workshopId}`} type="hidden" name="workshop_id" value={workshopId} />
        <input key={`promote-ver-${workshopId}`} type="hidden" name="pinned_version" value={version} />
        <button
          key={`promote-btn-${workshopId}`}
          type="submit"
          name="action"
          value="promote"
          className="btn btn-sm btn-primary text-xs font-semibold px-2 py-1 rounded bg-accent text-accent-foreground border"
          title="Promote stalled workshop object through identical validator. Fellow retains immutable scientific authorship."
        >
          Promote to Ledger
        </button>
      </form>
      <form key={`keep-form-${workshopId}`} method="post" className="inline-flex">
        <input key={`keep-id-${workshopId}`} type="hidden" name="workshop_id" value={workshopId} />
        <input key={`keep-ver-${workshopId}`} type="hidden" name="pinned_version" value={version} />
        <button
          key={`keep-btn-${workshopId}`}
          type="submit"
          name="action"
          value="keep"
          className="btn btn-sm text-xs px-2 py-1 rounded border"
          title="Keep draft in workshop without promotion"
        >
          Keep Draft
        </button>
      </form>
      <form key={`discard-form-${workshopId}`} method="post" className="inline-flex">
        <input key={`discard-id-${workshopId}`} type="hidden" name="workshop_id" value={workshopId} />
        <input key={`discard-ver-${workshopId}`} type="hidden" name="pinned_version" value={version} />
        <button
          key={`discard-btn-${workshopId}`}
          type="submit"
          name="action"
          value="discard"
          className="btn btn-sm text-xs px-2 py-1 rounded border text-muted-foreground"
          title="Soft-hide draft in workshop; preserves negative knowledge"
        >
          Discard (Soft-hide)
        </button>
      </form>
    </div>
  );
}

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
              <input key="before-cursor" type="hidden" name="before_workshop_seq" value={cursor} />
            ) : null}
            <button className="btn" type="submit">
              Retry workshop
            </button>
          </form>
        </section>
      ) : (
        <section className="card" aria-labelledby="workshop-title">
          <ConsoleAutoRefresh key="workshop-auto-refresh" intervalMs={3000} />
          <h2 className="card-title" id="workshop-title">
            {page.view.fellow_id} on {page.view.problem_id}
          </h2>
          <p className="quiet">
            Private work, newest first. Visible only to you and this Fellow. 3s live refresh active.
          </p>
          <form method="get">
            <button className="btn" type="submit">
              Refresh newest work
            </button>
          </form>
          {page.view.objects.length === 0 ? (
            <p>
              {page.request.before_workshop_seq === undefined
                ? "No pushes yet. As your Fellow writes private notes and drafts, they will appear here live."
                : "No older pushes on this page."}
            </p>
          ) : (
            <ul className="workshop-list">
              {page.view.objects.map((object) => (
                <li key={object.workshop_id} className="workshop-card border p-4 my-3 rounded">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="workshop-kind font-semibold px-2 py-0.5 rounded bg-muted text-xs uppercase">
                      {object.type}
                    </span>
                    <span className="workshop-state text-xs px-2 py-0.5 rounded border">
                      state: {object.state ?? "open"}
                    </span>
                    <span className="workshop-version text-xs px-2 py-0.5 rounded border">
                      v{(object.current_version ?? object.version) ?? 1}
                    </span>
                    <code className="text-xs text-muted-foreground ml-auto">{object.workshop_id}</code>
                  </div>
                  <h3 className="text-base font-bold my-1">{object.title}</h3>
                  <div className="quiet text-xs mb-2">
                    <time dateTime={object.created_at}>{object.created_at}</time>
                    {object.relates_to && object.relates_to.length > 0 ? (
                      <span className="ml-2">
                        Relates to: {object.relates_to.join(", ")}
                      </span>
                    ) : null}
                  </div>
                  <div className="workshop-body whitespace-pre-wrap font-sans text-sm my-2 p-2 bg-muted/40 rounded">
                    {object.body_md}
                  </div>
                  <WorkshopCardActions
                    key="card-actions"
                    workshopId={object.workshop_id}
                    version={(object.current_version ?? object.version) ?? 1}
                  />
                  <div className="workshop-actions-guidance text-xs quiet mt-2">
                    <strong>Promote / Keep / Discard:</strong> Promoting unblocks a stalled Fellow through the same validator. Scientific authorship remains immutable (Fellow/session/model/harness); sponsor is acting promoter only (Rule A2/A3). Discard soft-hides in workshop, never deletes negative knowledge.
                  </div>
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
