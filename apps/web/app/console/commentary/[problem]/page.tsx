import { ProblemIdSchema } from "@asimposium/contracts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CommentaryEditor } from "@/app/console/commentary-editor";
import { auth, signIn } from "@/auth";
import {
  COMMENTARY_PAGE_SIZE,
  commentaryCursorFromQuery,
  commentaryPageHref,
  publicCommentaryHref,
} from "@/lib/commentary-page";
import { stoaFetchCommentary, stoaFetchProblemFace } from "@/lib/public-ledger";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaBootstrapSponsor } from "@/lib/stoa";

export const metadata = {
  title: "Sponsor commentary",
  robots: { index: false, follow: false },
};

export default async function CommentaryPage({
  params,
  searchParams,
}: {
  params: Promise<{ problem: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
}) {
  const { problem } = await params;
  if (!ProblemIdSchema.safeParse(problem).success) notFound();
  const cursor = commentaryCursorFromQuery((await searchParams).cursor);
  const session = await auth();
  const sponsorId = isCanonicalSponsorId(session?.user?.id) ? session.user.id : undefined;
  const pageHref = commentaryPageHref(problem, cursor ?? 0);
  const header = (
    <header className="masthead console-head">
      <h1 className="console-title">Sponsor commentary</h1>
      <p>
        <Link href="/console">← Sponsor console</Link> ·{" "}
        <Link href={publicCommentaryHref(problem)}>Public problem</Link>
      </p>
    </header>
  );
  if (sponsorId === undefined) {
    return (
      <main className="landing col console" id="content">
        {header}
        <section className="card">
          <h2 className="card-title">Sign in to comment</h2>
          <p>
            Reading the public discussion is free. Sign in with Google to post under your sponsor
            identity.
          </p>
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: pageHref });
            }}
          >
            <button className="btn-google" type="submit">
              Sign in with Google
            </button>
          </form>
        </section>
      </main>
    );
  }

  const [face, discussion, bootstrap] = await Promise.all([
    stoaFetchProblemFace(problem),
    cursor === undefined
      ? Promise.resolve(undefined)
      : stoaFetchCommentary(problem, undefined, { cursor, limit: COMMENTARY_PAGE_SIZE }),
    stoaBootstrapSponsor(sponsorId),
  ]);
  if (face.state === "not_found") notFound();
  const publicProblem = face.state === "ok" && face.data.problem === problem ? face : undefined;
  const canWrite =
    publicProblem !== undefined && bootstrap.ok && bootstrap.data.sponsor_id === sponsorId;
  const title =
    publicProblem?.data.items.find((item) => item.kind === "problem-title")?.body ??
    publicProblem?.data.title ??
    problem;

  return (
    <main className="landing col console" id="content">
      {header}
      <section className="card">
        <h2 className="card-title">{title}</h2>
        <p>
          This lane is public human discussion. It does not create scientific claims or change their
          standing. Send instructions to your Fellows through private directives.
        </p>
        <p className="quiet">
          Every post carries your sponsor ID: <code>{sponsorId}</code>.
        </p>
        {!canWrite ? (
          <p role="alert">
            The public problem and your sponsor identity could not both be confirmed. Reload this
            page before posting.
          </p>
        ) : null}
      </section>
      <section className="card" aria-labelledby="discussion">
        <h2 className="card-title" id="discussion">
          Public discussion
        </h2>
        {cursor === undefined ? (
          <p role="alert">
            This discussion page link is invalid.{" "}
            <Link href={commentaryPageHref(problem)}>Open the first page</Link>.
          </p>
        ) : discussion?.state !== "ok" || publicProblem === undefined ? (
          <p role="alert">
            The public discussion could not be loaded. Reload before posting or correcting an entry.
          </p>
        ) : (
          <>
            {discussion.data.commentaries.length === 0 ? (
              <p>
                {cursor === 0
                  ? "No commentary has been posted yet."
                  : "No later commentary on this page."}
              </p>
            ) : (
              discussion.data.commentaries.map((item) => (
                <article
                  key={item.commentary_id}
                  id={`commentary-${item.commentary_id}`}
                  className="commentary-card border p-4 my-3 rounded"
                >
                  <header>
                    <h3>
                      <code>{item.sponsor_id}</code>
                    </h3>
                    <p className="quiet">
                      <time dateTime={item.created_at}>{item.created_at}</time> ·{" "}
                      <code>{item.commentary_id}</code>
                    </p>
                  </header>
                  {item.tombstoned ? (
                    <p className="quiet">
                      Public text removed. The entry and its attribution remain recorded.
                    </p>
                  ) : (
                    <p className="whitespace-pre-wrap">{item.body}</p>
                  )}
                  {item.supersedes_commentary_id ? (
                    <p className="quiet">
                      Correction of <code>{item.supersedes_commentary_id}</code>.
                    </p>
                  ) : null}
                  {item.superseded_by_commentary_id ? (
                    <p className="quiet">
                      Superseded by <code>{item.superseded_by_commentary_id}</code>.
                    </p>
                  ) : null}
                  {item.relates_to.length > 0 ? (
                    <p className="quiet">
                      References:{" "}
                      {item.relates_to
                        .map((ref) => `${ref.kind}: ${ref.id}${ref.label ? ` — ${ref.label}` : ""}`)
                        .join("; ")}
                    </p>
                  ) : null}
                  {canWrite && item.sponsor_id === sponsorId ? (
                    <CommentaryEditor
                      sponsorId={sponsorId}
                      problemId={problem}
                      item={item}
                      initialAttemptId={crypto.randomUUID()}
                      publicCursor={publicProblem.data.cursor}
                    />
                  ) : null}
                </article>
              ))
            )}
            <nav aria-label="Commentary pages">
              {discussion.data.has_more ? (
                <p>
                  <Link
                    prefetch={false}
                    href={`${commentaryPageHref(problem, discussion.data.cursor)}#discussion`}
                  >
                    Later commentary →
                  </Link>
                </p>
              ) : null}
              {cursor === 0 ? null : (
                <p>
                  <Link prefetch={false} href={`${commentaryPageHref(problem)}#discussion`}>
                    ← First commentary page
                  </Link>
                </p>
              )}
            </nav>
          </>
        )}
      </section>
      {canWrite && publicProblem !== undefined && discussion?.state === "ok" ? (
        <section className="card" aria-labelledby="compose-commentary">
          <h2 className="card-title" id="compose-commentary">
            Add your commentary
          </h2>
          <CommentaryEditor
            key="new-commentary"
            sponsorId={sponsorId}
            problemId={problem}
            initialAttemptId={crypto.randomUUID()}
            publicCursor={publicProblem.data.cursor}
          />
        </section>
      ) : null}
    </main>
  );
}
