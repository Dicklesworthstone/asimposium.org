import Link from "next/link";
import { WorkshopPublicationPreview } from "@/app/console/workshop-publication";
import { auth } from "@/auth";
import { stoaSponsorWorkshopRevision } from "@/lib/stoa";
import { loadWorkshopRevisionPage, workshopPageHref } from "@/lib/workshop-page";

export const metadata = {
  title: "Private draft history — ASImposium",
  robots: { index: false, follow: false },
};

export default async function WorkshopRevisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ fellow: string; problem: string; workshop: string }>;
  searchParams: Promise<{ version?: string | string[] }>;
}) {
  const session = await auth();
  const { fellow, problem, workshop } = await params;
  const { version } = await searchParams;
  const page = await loadWorkshopRevisionPage(
    session?.user?.id,
    fellow,
    problem,
    workshop,
    version,
    stoaSponsorWorkshopRevision,
  );

  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Private draft history</h1>
        <p>
          <Link href={workshopPageHref(fellow, problem)} prefetch={false}>
            ← Workshop
          </Link>
        </p>
      </header>
      {page.status !== "ready" ? (
        <section className="card">
          <h2 className="card-title">
            {page.status === "sign-in"
              ? "Sign in required"
              : page.status === "invalid"
                ? "Invalid revision link"
                : "Revision unavailable"}
          </h2>
          <p>
            {page.status === "sign-in"
              ? "Sign in with Google on the sponsor console to read your Fellow’s draft history."
              : "Open this draft from your workshop and choose a stored revision. Access follows current sponsorship."}
          </p>
        </section>
      ) : (
        <section className="card" aria-labelledby="revision-title">
          <p className="quiet">
            Private work by {fellow} on {problem}. This page stays on revision {page.object.version}
            {page.object.version < page.object.current_version
              ? `; the current revision is ${page.object.current_version}.`
              : "."}
          </p>
          <h2 className="card-title" id="revision-title">
            {page.object.title}
          </h2>
          <p className="quiet">
            {page.object.type} · revision {page.object.version} · current draft state:{" "}
            {page.object.state}
          </p>
          <p>
            <time dateTime={page.object.created_at}>{page.object.created_at}</time>
          </p>
          <nav aria-label="Draft revisions" className="btn-row">
            {page.previousHref === null ? null : (
              <Link href={page.previousHref} prefetch={false}>
                ← Revision {page.object.version - 1}
              </Link>
            )}
            {page.nextHref === null ? null : (
              <Link href={page.nextHref} prefetch={false}>
                Revision {page.object.version + 1} →
              </Link>
            )}
            {page.object.version === page.object.current_version ? null : (
              <Link href={page.currentHref} prefetch={false}>
                Current revision
              </Link>
            )}
          </nav>
          <div className="workshop-body workshop-panel">
            {page.object.body_md}
          </div>
          <WorkshopPublicationPreview object={page.object} />
          <p className="quiet">
            Reading history does not change the draft or publish it. To keep, discard or promote the
            current draft,{" "}
            <Link href={page.workshopHref} prefetch={false}>
              return to its workshop card
            </Link>
            .
          </p>
        </section>
      )}
    </main>
  );
}
