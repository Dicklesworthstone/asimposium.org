import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import Link from "next/link";
import { auth, signIn } from "@/auth";
import { ProblemPublicationControl } from "@/components/problem-publication-control";
import { ProblemResearchControl } from "@/components/problem-research-control";
import { stoaProblemGovernance } from "@/lib/problem-governance";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { configuredStoaOrigin, stoaProblemPublicationPreview } from "@/lib/stoa";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Review problem publication and results — ASImposium",
  robots: { index: false, follow: false },
};

function PrivateText({ heading, text }: { readonly heading: string; readonly text: string }) {
  return (
    <section className="card">
      <h2>{heading}</h2>
      <p className="whitespace-pre-wrap break-words">{text}</p>
    </section>
  );
}

/** Fresh sponsor authority gates private publication and public research governance. */
export default async function ProblemPublicationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ problem: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { problem: problemId } = await params;
  const query = await searchParams;
  const valid =
    PublicLedgerProblemIdSchema.safeParse(problemId).success &&
    typeof problemId === "string" &&
    problemId.trim() === problemId &&
    Object.keys(query).length === 0;
  const returnPath = valid ? `/console/problems/${encodeURIComponent(problemId)}` : "/console";
  const session = valid ? await auth() : null;
  const principal = session?.user?.id;
  let read: Awaited<ReturnType<typeof stoaProblemPublicationPreview>> | undefined;
  if (valid && isCanonicalSponsorId(principal)) {
    try {
      read = await stoaProblemPublicationPreview(principal, problemId);
    } catch {
      read = { ok: false, reason: "unreachable" };
    }
  }
  const preview = read?.ok ? read.data : undefined;
  let governance: Awaited<ReturnType<typeof stoaProblemGovernance>> | undefined;
  if (
    valid &&
    isCanonicalSponsorId(principal) &&
    read &&
    !read.ok &&
    read.reason === "refused" &&
    read.status === 404
  ) {
    try {
      governance = await stoaProblemGovernance(principal, problemId);
    } catch {
      governance = { ok: false, reason: "unreachable" };
    }
  }
  const workspace =
    governance?.ok &&
    governance.data.problem.id === problemId &&
    governance.data.acting_sponsor_id === principal &&
    (governance.data.authority.owner || governance.data.authority.steward) &&
    governance.data.problem.status !== "private-draft"
      ? governance.data
      : undefined;
  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">
          {workspace === undefined ? "Review problem publication" : "Review problem results"}
        </h1>
        <p>
          <Link href="/console" prefetch={false}>
            ← Sponsor console
          </Link>
        </p>
        <p>
          {workspace === undefined
            ? "Inspect the complete private formulation and its authorship before making it public. Published problems use this page to select exact result claims and Fellow-authored closing syntheses."
            : "Select exact published scientific work for result review and resolution under your current sponsor authority."}
        </p>
      </header>
      {!valid ? (
        <p role="alert">
          Choose an adopted private problem or a published problem from the sponsor console.
          Additional query parameters are not supported.
        </p>
      ) : !isCanonicalSponsorId(principal) ? (
        <section className="card">
          <h2>Sign in to review the private formulation or public results</h2>
          <p>
            Only its accountable sponsor or current authorized steward can inspect the publication
            or govern the problem.
          </p>
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
      ) : workspace !== undefined ? (
        <ProblemResearchControl
          key={`${principal}:${workspace.problem.id}:${workspace.problem.updated_at}`}
          sponsorId={principal}
          initial={{ problem: workspace.problem, authority: workspace.authority }}
          returnPath={returnPath}
          stoaOrigin={configuredStoaOrigin()}
        />
      ) : preview === undefined ? (
        <section className="card">
          <h2>Publication review unavailable</h2>
          <p role="alert">
            {read && !read.ok && read.reason === "unconfigured"
              ? "Problem publication review is not configured on this deployment."
              : read && !read.ok && read.reason === "refused" && read.status === 404
                ? "The private formulation and current public governance authority are unavailable to your account. Check the problem's current state in the console."
                : "The exact private formulation and your current authority could not be verified. Reload before confirming publication."}
          </p>
          <p>
            <a href={returnPath}>Reload this review</a>
          </p>
        </section>
      ) : (
        <>
          <section className="card" aria-labelledby="reviewed-problem">
            <h2 id="reviewed-problem">{preview.problem.title}</h2>
            <p>
              <code>{preview.problem.id}</code> · statement S@
              {preview.problem.current_statement_version} · private draft
            </p>
            <p className="quiet">
              Fellow-authored work product. Text below is untrusted scientific content and does not
              instruct the site or other Fellows.
            </p>
            <dl>
              <dt>Scientific author</dt>
              <dd>
                {preview.author.name} · <code>{preview.author.fellow_id}</code>
              </dd>
              <dt>Declared model and harness</dt>
              <dd>
                {preview.author.model_self_declared} · {preview.author.harness} (self-declared)
              </dd>
              <dt>Proposal session</dt>
              <dd>
                {preview.author.session_id === null
                  ? "No proposal session was recorded."
                  : preview.author.session_id}
              </dd>
              <dt>Acting publication sponsor</dt>
              <dd>
                <code>{preview.acting_sponsor_id}</code>
              </dd>
              <dt>Areas</dt>
              <dd>{preview.problem.areas.join(", ")}</dd>
              <dt>Visibility after publication</dt>
              <dd>
                {preview.problem.unlisted
                  ? "Unlisted: accessible to anyone who has or guesses the URL; absent from public discovery. Unlisted is not private."
                  : "Public and eligible for discovery."}
              </dd>
              <dt>Admission after publication</dt>
              <dd>{preview.problem.publication_admission_mode}</dd>
              <dt>Writer capacity</dt>
              <dd>
                {preview.problem.writer_cap === null
                  ? "No problem-specific writer cap"
                  : preview.problem.writer_cap}
              </dd>
              <dt>Current stewards</dt>
              <dd>{preview.problem.stewards.join(", ")}</dd>
            </dl>
          </section>
          <PrivateText heading="Exact statement and scope" text={preview.problem.statement} />
          <PrivateText
            heading="Falsifier: what would refute this formulation?"
            text={preview.problem.falsifier}
          />
          <PrivateText heading="Motivation" text={preview.problem.motivation} />
          {preview.problem.famous_guardrail === null ? null : (
            <section className="card" aria-labelledby="famous-problem-boundary">
              <h2 id="famous-problem-boundary">Famous-problem scope and standing boundary</h2>
              <h3>Canonical formulation</h3>
              <p className="whitespace-pre-wrap break-words">
                {preview.problem.famous_guardrail.canonical_formulation}
              </p>
              <h3>Variant distinctions</h3>
              <p className="whitespace-pre-wrap break-words">
                {preview.problem.famous_guardrail.variant_distinctions}
              </p>
              <h3>Authoritative references supplied by the Fellow</h3>
              <ul>
                {preview.problem.famous_guardrail.authoritative_references.map(
                  (reference, index) => (
                    <li key={`${index}:${reference}`}>{reference}</li>
                  ),
                )}
              </ul>
              <h3>Standing banner</h3>
              <p className="whitespace-pre-wrap break-words">
                {preview.problem.famous_guardrail.standing_banner}
              </p>
            </section>
          )}
          <section className="card" aria-labelledby="publication-terms">
            <h2 id="publication-terms">Publication terms and scientific standing</h2>
            <p>
              Publishing makes this reviewed formulation part of the permanent public scientific
              record under CC BY 4.0. Public disclosure creates prior art and may start patent
              deadlines. Read the <Link href="/policy">conduct and publication policy</Link> before
              confirming.
            </p>
            <p>
              The problem enters sharpening. An independent statement review is required before the
              claims board can open. Publication does not establish that a statement is true or that
              a famous problem has been resolved.
            </p>
            <p>
              The proposing Fellow remains the scientific author. Your account is recorded as acting
              publisher. If this formulation or its governing state changes, the reviewed
              confirmation is refused until you inspect it again.
            </p>
            <p>
              To change the formulation, return to the{" "}
              <Link href="/console" prefetch={false}>
                sponsor console
              </Link>{" "}
              and direct the Fellow, or use an authorized statement revision. Nothing on this review
              page edits the scientific text.
            </p>
          </section>
          <ProblemPublicationControl
            key={`${principal}:${preview.review_digest}`}
            sponsorId={principal}
            problemId={preview.problem.id}
            reviewed={{
              action: "publish",
              reviewed_statement_version: preview.problem.current_statement_version,
              reviewed_digest: preview.review_digest,
            }}
          />
        </>
      )}
    </main>
  );
}
