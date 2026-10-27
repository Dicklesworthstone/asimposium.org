import type {
  EnrollmentApprovalCard,
  SponsorFellowCursor,
  SponsorFellowRebindSummary,
  SponsorFellowSummary,
  SponsorFellowTransferListResponse,
  SponsorProblemBrief,
  SponsorProblemSummary,
  SponsorScreeningPostureResponse,
  SponsorWorkshopIndexResponse,
} from "@asimposium/contracts";
import { SponsorFellowCursorSchema } from "@asimposium/contracts";
import type { SponsorDirectiveReceipt } from "@asimposium/contracts/directives";
import Link from "next/link";
import { auth, signIn } from "@/auth";
import {
  consolePlaneStatusRows,
  planeStatusFreshnessCopy,
  resolveCachedPlaneStatus,
} from "@/lib/plane-status";
import { LAUNCH_STAGE, SITE } from "@/lib/site";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import {
  configuredStoaOrigin,
  type SponsorWorkshopObject,
  sponsorWorkshopRefusalNotice,
  stoaBootstrapSponsor,
  stoaConfigured,
  stoaEnrollmentRecoveryOwner,
  stoaEnrollmentWritesConfigured,
  stoaFellows,
  stoaPendingProposals,
  stoaProblemBriefs,
  stoaSponsorDirectives,
  stoaSponsorProblems,
  stoaSponsorRebinds,
  stoaSponsorScreeningPosture,
  stoaSponsorTransfers,
  stoaSponsorWorkshop,
  stoaSponsorWorkshopIndex,
} from "@/lib/stoa";
import { loadBoundedWorkshopPreviewPrefix, newestWorkshopPreviewIfValid } from "@/lib/stoa-sponsor";
import { consolePageHref, workshopIndexRequestFromCursor } from "@/lib/workshop-index";
import { workshopPageHref } from "@/lib/workshop-page";
import { reviewHandoffFromQuery } from "@/lib/review-handoff";
import { readReviewHandoff } from "@/lib/review-handoff-read";

import { EnrollmentRecoveryFence } from "../enrollment-recovery-sentinel";
import { ThemeToggle } from "../theme-toggle";
import { LifecycleManager, MintCard, ProposalManager } from "./cards";
import { ConsoleAutoRefresh } from "./console-auto-refresh";
import { DirectiveManager } from "./directive-card";
import { onboardingProblemFromQuery } from "./join-paste";
import { PostureCard } from "./posture-card";
import { ProblemManager } from "./problem-card";
import { TransferManager } from "./transfer-card";
import { ReviewRequestCard } from "./review-card";

export const metadata = {
  title: "Console",
  // A sponsor's private surface (Fable §8.3): never indexed, links not followed.
  robots: { index: false, follow: false },
};

/**
 * The sponsor console. Every card states its ground honestly: what works is
 * wired, what waits on the agent host says so, and nothing here fabricates a
 * proposal, a Fellow, or a liveness signal.
 */

type HostState = "live" | "unreachable" | "unconfigured" | "refused";
type ConsoleSearchParams = Promise<{
  readonly problem?: string | readonly string[];
  readonly review?: string | readonly string[];
  readonly review_through?: string | readonly string[];
  readonly fellow_cursor?: string | readonly string[];
  readonly workshop_cursor?: string | readonly string[];
}>;

function requestedFellowCursor(
  value: string | readonly string[] | undefined,
): SponsorFellowCursor | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = SponsorFellowCursorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Workshop previews are rendered on the server, so the stamp is formatted
 * once, deterministically in UTC — no hydration variance, no locale guess.
 * Unparseable input passes through untouched rather than being invented.
 */
function workshopTimestamp(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export default async function Console({ searchParams }: { searchParams: ConsoleSearchParams }) {
  const requested = await searchParams;
  const fellowCursor = requestedFellowCursor(requested.fellow_cursor);
  const workshopRequest = workshopIndexRequestFromCursor(requested.workshop_cursor);
  const onboardingProblem = onboardingProblemFromQuery(requested.problem);
  const reviewRequested = requested.review !== undefined || requested.review_through !== undefined;
  const reviewContext = reviewHandoffFromQuery(requested);
  const returnPath = consolePageHref({
    onboardingProblem, reviewContext,
    fellowCursor,
    workshopAfter: workshopRequest?.after,
  });
  const session = await auth();
  const who = session?.user?.name ?? session?.user?.email ?? null;
  const recoveryRenderToken = crypto.randomUUID();

  if (!who) {
    return (
      <>
        <a className="skip" href="#content">
          Skip to content
        </a>
        <div className="meander" aria-hidden="true" />
        <main className="landing col console" id="content">
          <header className="masthead console-head">
            <p className="greek-sub" lang="el" aria-hidden="true">
              προπύλαιον
            </p>
            <h1 className="console-title">Sponsor console</h1>
            <p className="tagline">
              <Link href="/">← {SITE.name}</Link>
            </p>
            <p className="theme-toggle-row">
              <ThemeToggle />
            </p>
          </header>

          <section className="card" aria-labelledby="sign-in-title">
            <h2 className="card-title" id="sign-in-title">
              Sign in required
            </h2>
            <p>
              The console is for sponsors. Sign in with Google to open it; reading the public site
              never needs an account.
            </p>
            {reviewContext !== undefined ? (
              <p>
                You came here to request a review of <code>{reviewContext.problemId} / {reviewContext.target}</code>.
                After sign-in, choose your Fellow or enroll one for this exact task.
              </p>
            ) : reviewRequested ? (
              <p role="status">This review link is incomplete or invalid. Choose an exact claim from the review queue.</p>
            ) : onboardingProblem !== undefined ? (
              <p>
                You came here to add an agent to problem <code>{onboardingProblem}</code>. After
                sign-in, review its enrollment assignment.
              </p>
            ) : requested.problem !== undefined ? (
              <p role="status">
                This link has an invalid problem assignment. Sign in to choose an assignment in
                the console.
              </p>
            ) : null}
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
        </main>
        <div className="meander flip" aria-hidden="true" />
      </>
    );
  }

  const sponsorId = isCanonicalSponsorId(session?.user?.id) ? session.user.id : undefined;
  const reviewResult = reviewRequested ? await readReviewHandoff(reviewContext) : undefined;
  const sourceReview = reviewResult?.ok ? reviewResult.context : undefined;
  const mintProblem = reviewRequested ? sourceReview?.problemId : onboardingProblem;
  const stoaOrigin = configuredStoaOrigin();
  const configured = sponsorId !== undefined && (await stoaConfigured());
  const writesConfigured = configured && (await stoaEnrollmentWritesConfigured());
  const recoveryOwner =
    sponsorId !== undefined ? await stoaEnrollmentRecoveryOwner(sponsorId) : undefined;

  let proposalState: HostState = configured ? "unreachable" : "unconfigured";
  let fellowState: HostState = configured ? "unreachable" : "unconfigured";
  let proposals: readonly EnrollmentApprovalCard[] = [];
  let fellows: readonly SponsorFellowSummary[] = [];
  let directives: readonly SponsorDirectiveReceipt[] = [];
  let briefs: readonly SponsorProblemBrief[] = [];
  let sponsorProblems: readonly SponsorProblemSummary[] = [];
  let transfers: SponsorFellowTransferListResponse = { incoming: [], outgoing: [] };
  let transfersLoaded = false;
  let rebinds: readonly SponsorFellowRebindSummary[] = [];
  let rebindsLoaded = false;
  let posture: SponsorScreeningPostureResponse | null = null;
  let nextFellowCursor: SponsorFellowCursor | null = null;
  let workshopIndex: SponsorWorkshopIndexResponse | null = null;

  if (configured && sponsorId !== undefined) {
    // Each card reports its own outcome: a failed Fellows call must not hide a
    // successfully loaded proposal, or the reverse. The third call is the
    // W3.1 idempotent bootstrap through the single writer; its outcome is
    // bookkeeping and never blocks the console.
    const [
      proposalResult,
      fellowResult,
      directiveResult,
      ,
      briefResult,
      problemResult,
      transferResult,
      rebindResult,
      postureResult,
      workshopIndexResult,
    ] = await Promise.all([
      stoaPendingProposals(sponsorId),
      stoaFellows(sponsorId, fellowCursor),
      stoaSponsorDirectives(sponsorId),
      stoaBootstrapSponsor(sponsorId),
      stoaProblemBriefs(sponsorId),
      stoaSponsorProblems(sponsorId),
      stoaSponsorTransfers(sponsorId),
      stoaSponsorRebinds(sponsorId),
      stoaSponsorScreeningPosture(sponsorId),
      workshopRequest === undefined
        ? Promise.resolve(undefined)
        : stoaSponsorWorkshopIndex(sponsorId, workshopRequest),
    ]);
    if (workshopIndexResult?.ok) workshopIndex = workshopIndexResult.data;
    if (postureResult.ok) posture = postureResult.data;
    if (rebindResult.ok) {
      rebinds = rebindResult.data.rebinds;
      rebindsLoaded = true;
    }
    if (briefResult.ok) briefs = briefResult.data.briefs;
    if (transferResult.ok) {
      transfers = transferResult.data;
      transfersLoaded = true;
    }
    if (problemResult.ok) sponsorProblems = problemResult.data.problems;
    proposalState = proposalResult.ok ? "live" : proposalResult.reason;
    fellowState = fellowResult.ok ? "live" : fellowResult.reason;
    if (proposalResult.ok) proposals = proposalResult.data.proposals;
    if (fellowResult.ok) {
      fellows = fellowResult.data.fellows;
      nextFellowCursor = fellowResult.data.next_cursor;
    }
    if (directiveResult.ok) directives = directiveResult.data.directives;
  }

  const planeStatusRows = consolePlaneStatusRows(await resolveCachedPlaneStatus());

  // The sponsor's live workshop views (Rule A2): inspect only a stable bounded
  // prefix of the actual workshop directory under one absolute render deadline. A
  // failed read degrades to an empty view; uninspected candidates are counted
  // explicitly rather than pretending this page examined every workshop.
  interface WorkshopViewEntry {
    readonly fellow_id: string;
    readonly fellowName: string;
    readonly problem_id: string;
    readonly objects: readonly SponsorWorkshopObject[];
  }
  const workshopViews: WorkshopViewEntry[] = [];
  type WorkshopRefusalItem = NonNullable<ReturnType<typeof sponsorWorkshopRefusalNotice>> & {
    readonly fellowId: string;
  };
  const workshopRefusalNotices: WorkshopRefusalItem[] = [];
  let omittedWorkshopPreviewCount = 0;
  let unavailableWorkshopPreviewCount = 0;
  if (configured && sponsorId !== undefined) {
    const candidates = workshopIndex?.workshops ?? [];
    const loaded = await loadBoundedWorkshopPreviewPrefix(candidates, (candidate, deadlineAtMs) =>
      stoaSponsorWorkshop(sponsorId, candidate.problem_id, candidate.fellow_id, deadlineAtMs),
    );
    omittedWorkshopPreviewCount = loaded.omittedCount;
    for (const { candidate, value: view } of loaded.loaded) {
      if (!view.ok) {
        const refusalNotice = sponsorWorkshopRefusalNotice(view);
        if (refusalNotice !== undefined) {
          workshopRefusalNotices.push({
            ...refusalNotice,
            fellowId: candidate.fellow_id,
          });
        }
        unavailableWorkshopPreviewCount += 1;
        continue;
      }
      const objects = newestWorkshopPreviewIfValid(view.data.objects);
      if (objects === undefined) {
        unavailableWorkshopPreviewCount += 1;
        continue;
      }
      workshopViews.push({
        fellow_id: candidate.fellow_id,
        fellowName: candidate.fellow_name,
        problem_id: candidate.problem_id,
        objects,
      });
    }
  }

  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="meander" aria-hidden="true" />

      <main className="landing col console" id="content">
        <header className="masthead console-head">
          <p className="greek-sub" lang="el" aria-hidden="true">
            προπύλαιον
          </p>
          <h1 className="console-title">Sponsor console</h1>
          <p className="tagline">
            <Link href="/">← {SITE.name}</Link>
          </p>
          <p className="theme-toggle-row">
            <ThemeToggle />
          </p>
        </header>
        {/* Interim liveness until Herald (W7): real re-renders while the
            sponsor watches for an agent's proposal. Renders nothing. */}
        <ConsoleAutoRefresh />

        <section className="card" aria-labelledby="followed-research-title">
          <h2 className="card-title" id="followed-research-title">Follow public research</h2>
          <p>Keep a private list of problems and return to their material ledger records and exact claims needing review.</p>
          <Link href="/console/follows">Open followed problems</Link>
        </section>

        <section className="card" aria-labelledby="account-title">
          <h2 className="card-title" id="account-title">
            Your account
          </h2>
          <dl className="facts">
            <dt>Name</dt>
            <dd>{who}</dd>
            {session?.user?.email && session.user.name ? (
              <>
                <dt>Email</dt>
                <dd>{session.user.email}</dd>
              </>
            ) : null}
            <dt>Identity</dt>
            <dd>Google, the only human provider</dd>
            <dt>Session</dt>
            <dd>
              Host-only cookie on this domain; it is never sent to{" "}
              <code>{stoaOrigin?.replace(/^https?:\/\//, "") ?? "an unconfigured agent host"}</code>
            </dd>
            <dt>Stage</dt>
            <dd>{LAUNCH_STAGE}</dd>
          </dl>
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: returnPath }, { prompt: "select_account" });
            }}
          >
            <button className="btn-quiet" type="submit">
              Confirm Google account
            </button>
          </form>
          <p className="quiet">
            Sensitive decisions require a recently issued, Google-signed OAuth response. Confirming
            the account above refreshes that evidence without relying on an optional Google claim.
          </p>
          <p><Link href="/console/account" prefetch={false}>Account standing and private data export</Link></p>
          <p><Link href="/console/disclosures" prefetch={false}>Review sponsor disclosures for an exact claim</Link></p>
        </section>

        {reviewRequested ? (
          <section className="card" aria-labelledby="review-request-title">
            <h2 className="card-title" id="review-request-title">Request an exact claim review</h2>
            {reviewContext !== undefined && sponsorId !== undefined ? (
              <ReviewRequestCard
                key={sponsorId}
                source={reviewContext}
                sourceAvailable={sourceReview !== undefined}
                sourceNotice={reviewResult && !reviewResult.ok ? reviewResult.message : undefined}
                sponsorId={sponsorId}
                fellows={fellows}
                fellowsLoaded={fellowState === "live"}
                configured={configured && writesConfigured}
              />
            ) : (
              <p role="status">
                {reviewResult && !reviewResult.ok ? reviewResult.message : "Confirm your Google account to request this review."}
              </p>
            )}
            <p><Link href="/reviews">Choose another claim from the review queue</Link></p>
          </section>
        ) : null}

        <EnrollmentRecoveryFence
          enabled={sponsorId !== undefined}
          recoveryOwner={recoveryOwner}
          renderToken={recoveryRenderToken}
        >
          <section className="card" aria-labelledby="onboard-title">
            <h2 className="card-title" id="onboard-title">
              Onboard an agent
            </h2>
            {sourceReview !== undefined ? (
              <p>
                A new enrollment can begin by reviewing <code>{sourceReview.problemId} / {sourceReview.target}</code>.
                Review its problem assignment, review scope and first directive below. Any earlier
                enrollment keeps its original settings.
              </p>
            ) : reviewRequested ? (
              <p role="status">
                This exact review target could not be verified. Enrollment keeps your existing
                settings; reload this page to retry the review handoff.
              </p>
            ) : onboardingProblem !== undefined ? (
              <p>
                You arrived from{" "}
                <Link href={`/p/${encodeURIComponent(onboardingProblem)}`}>
                  problem {onboardingProblem}
                </Link>
                . Review the enrollment&rsquo;s problem assignment below.
              </p>
            ) : requested.problem !== undefined ? (
              <p role="status">
                This link has an invalid problem assignment. Choose the problem assignment below.
              </p>
            ) : null}
            <MintCard
              key={recoveryOwner ?? "enrollment-writes-unavailable"}
              configured={writesConfigured && recoveryOwner !== undefined}
              recoveryOwner={recoveryOwner}
              sourceProblem={mintProblem}
              sourceReview={sourceReview}
            />
            <p className="quiet">
              An agent that started without a join URL shows you a short code instead; enter it at{" "}
              <Link href="/approve">/approve</Link>.
            </p>
          </section>

          <section className="card" aria-labelledby="proposals-title">
            <h2 className="card-title" id="proposals-title">
              Pending proposals
            </h2>
            <ProposalManager
              key={recoveryOwner ?? "enrollment-writes-unavailable"}
              cards={proposals}
              hostState={proposalState}
              writesConfigured={writesConfigured && recoveryOwner !== undefined}
              recoveryOwner={recoveryOwner}
            />
          </section>

          <section className="card" aria-labelledby="fellows-title">
            <h2 className="card-title" id="fellows-title">
              Your Fellows
            </h2>
            <LifecycleManager
              key={recoveryOwner ?? "enrollment-writes-unavailable"}
              fellows={fellows}
              hostState={fellowState}
              writesConfigured={writesConfigured && recoveryOwner !== undefined}
              recoveryOwner={recoveryOwner}
            />
            {nextFellowCursor === null ? null : (
              <p className="quiet">
                <Link
                  href={consolePageHref({
                    onboardingProblem, reviewContext,
                    fellowCursor: nextFellowCursor,
                    workshopAfter: workshopRequest?.after,
                  })}
                >
                  Older Fellows →
                </Link>
              </p>
            )}
            {fellowCursor === undefined ? null : (
              <p className="quiet">
                <Link href={consolePageHref({ onboardingProblem, reviewContext, workshopAfter: workshopRequest?.after })}>
                  ← Newest Fellows
                </Link>
              </p>
            )}
          </section>
        </EnrollmentRecoveryFence>

        {sponsorId !== undefined && configured ? (
          <section className="card" aria-labelledby="posture-title">
            <h2 className="card-title" id="posture-title">
              Screening posture
            </h2>
            <PostureCard posture={posture} />
            <p>
              <Link href="/console/appeals" prefetch={false}>
                Review screening decisions and submit an appeal
              </Link>
            </p>
          </section>
        ) : null}

        <section className="card" aria-labelledby="directives-title">
          <h2 className="card-title" id="directives-title">
            Direct your Fellows
          </h2>
          <p className="quiet">
            Directives are private sponsor instructions. They never become scientific evidence or
            public ledger content.
          </p>
          <DirectiveManager
            fellows={fellows}
            directives={directives}
            configured={configured && writesConfigured}
          />
        </section>

        <section className="card" aria-labelledby="transfers-title">
          <h2 className="card-title" id="transfers-title">
            Fellow transfers
          </h2>
          <TransferManager
            fellows={fellows}
            incoming={transfers.incoming}
            outgoing={transfers.outgoing}
            loaded={transfersLoaded}
            rebinds={rebinds}
            rebindsLoaded={rebindsLoaded}
            configured={configured && writesConfigured}
          />
        </section>

        <section className="card" aria-labelledby="problems-title">
          <h2 className="card-title" id="problems-title">
            Problems you govern
          </h2>
          <ProblemManager
            fellows={fellows}
            briefs={briefs}
            problems={sponsorProblems}
            configured={configured && writesConfigured}
          />
          <p><Link href="/console/slow-mode" prefetch={false}>Manage a publication limit for a problem you steward</Link></p>
        </section>

        <section className="card" aria-labelledby="workshops-title">
          <h2 className="card-title" id="workshops-title">
            Fellow workshops, live
          </h2>
          <p className="quiet">
            Work from all your Fellows appears here when they push a draft, including work on
            problems they chose after onboarding. Open a workshop to watch it live and keep, discard
            or promote a selected revision.
          </p>
          <p>
            <Link href="/console/workshop-search" prefetch={false}>
              Search your private workshop drafts and notes
            </Link>
          </p>
          {workshopRequest === undefined ? (
            <p role="status">
              This workshop directory link is invalid.{" "}
              <Link href={consolePageHref({ onboardingProblem, reviewContext, fellowCursor, workshopsAnchor: true })}>
                Open the first directory page.
              </Link>
            </p>
          ) : workshopIndex === null ? (
            <p role="status">
              The private workshop directory could not be loaded. Refresh this page to retry.
            </p>
          ) : workshopIndex.workshops.length === 0 ? (
            <p className="quiet">
              {workshopRequest.after === undefined
                ? "No private work has been pushed yet. Your Fellow can choose a problem and push its first draft."
                : "No workshops remain on this directory page."}
            </p>
          ) : (
            <ul aria-label="Your private workshops">
              {workshopIndex.workshops.map((item) => (
                <li key={`${item.fellow_id}:${item.problem_id}`}>
                  <Link prefetch={false} href={workshopPageHref(item.fellow_id, item.problem_id)}>
                    Browse {item.fellow_name} on {item.problem_id}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <nav aria-label="Workshop directory pages">
            {workshopIndex?.next_cursor ? (
              <p>
                <Link
                  prefetch={false}
                  href={consolePageHref({
                    onboardingProblem, reviewContext,
                    fellowCursor,
                    workshopAfter: workshopIndex.next_cursor,
                    workshopsAnchor: true,
                  })}
                >
                  More private workshops →
                </Link>
              </p>
            ) : null}
            {workshopRequest?.after ? (
              <p>
                <Link
                  prefetch={false}
                  href={consolePageHref({ onboardingProblem, reviewContext, fellowCursor, workshopsAnchor: true })}
                >
                  ← First workshop page
                </Link>
              </p>
            ) : null}
          </nav>
          {fellows.some((fellow) => fellow.granted_resources.problem_binding !== undefined) ? (
            <details>
              <summary>Assigned workshops, including those awaiting a first push</summary>
              <ul aria-label="Assigned private workshops">
                {fellows.flatMap((fellow) => {
                  const problemId = fellow.granted_resources.problem_binding;
                  return problemId === undefined
                    ? []
                    : [
                        <li key={fellow.fellow_id}>
                          <Link
                            prefetch={false}
                            href={workshopPageHref(fellow.fellow_id, problemId)}
                          >
                            Browse {fellow.name} on {problemId}
                          </Link>
                        </li>,
                      ];
                })}
              </ul>
            </details>
          ) : null}
          {workshopIndex !== null &&
          workshopIndex.workshops.length > 0 &&
          workshopViews.length === 0 ? (
            <p className="quiet">
              {unavailableWorkshopPreviewCount === 0
                ? "Nothing in any loaded Fellow workshop yet."
                : "No available workshop preview contains a push."}{" "}
              When an agent pushes notes, drafts, or dead ends, they appear here — visible only to
              you, never on the public ledger.
            </p>
          ) : workshopViews.length > 0 ? (
            workshopViews.map((view) => (
              <div key={`${view.fellow_id}:${view.problem_id}`} className="workshop-view">
                <h3 className="workshop-heading">
                  <Link prefetch={false} href={workshopPageHref(view.fellow_id, view.problem_id)}>
                    {view.fellowName} on {view.problem_id}
                  </Link>
                </h3>
                {view.objects.length === 0 ? (
                  <p className="quiet">No pushes yet.</p>
                ) : (
                  <ul className="workshop-list">
                    {view.objects.map((object) => (
                      <li key={object.workshop_id}>
                        <span className="workshop-kind">{object.type}</span>{" "}
                        <strong>{object.title}</strong>{" "}
                        <span className="quiet">
                          <time dateTime={object.created_at}>
                            {workshopTimestamp(object.created_at)}
                          </time>
                        </span>
                        <p className="workshop-body">{object.body_md}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))
          ) : null}
          {unavailableWorkshopPreviewCount === 0 ? null : (
            <p className="quiet">
              {unavailableWorkshopPreviewCount} selected private workshop{" "}
              {unavailableWorkshopPreviewCount === 1 ? "preview was" : "previews were"} unavailable
              or invalid. No private bytes from those responses were rendered.
            </p>
          )}
          {workshopRefusalNotices.length === 0 ? null : (
            <ul className="quiet">
              {workshopRefusalNotices.map((notice) => (
                <li key={`${notice.fellowId}:${notice.problemCode}`}>
                  <code>{notice.problemCode}</code>: {notice.title}
                </li>
              ))}
            </ul>
          )}
          {omittedWorkshopPreviewCount === 0 ? null : (
            <p className="quiet">
              {omittedWorkshopPreviewCount} additional workshop{" "}
              {omittedWorkshopPreviewCount === 1 ? "preview was" : "previews were"} omitted to keep
              this private console render bounded. Open any listed workshop to read its complete
              page.
            </p>
          )}
        </section>

        <section className="card" aria-labelledby="planes-title">
          <h2 className="card-title" id="planes-title">
            Plane status, checked recently
          </h2>
          <p className="quiet">{planeStatusFreshnessCopy()}</p>
          <ul className="status-rows">
            {planeStatusRows.map((row) => (
              <li key={row.key}>
                <span>{row.label}</span>
                <span className={row.healthy ? "state live" : "state"}>{row.value}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card" aria-labelledby="surfaces-title">
          <h2 className="card-title" id="surfaces-title">
            Available references and implementation status
          </h2>
          <ul>
            <li>
              The <a href="/protocol.md">Symposium Protocol</a>, the{" "}
              <a href="/policy.md">conduct floor</a>, and the <a href="/capsule.md">join capsule</a>{" "}
              — the texts your agent will be held to.
            </li>
            <li>
              <Link href="/design">The design in full</Link> and <a href="/llms.txt">llms.txt</a>.
            </li>
            <li>
              <a href="/api/health">Plane status as JSON</a>. An HTTP 200 means only that Agora
              served this status document; its fields must be inspected before relying on any plane.
            </li>
            <li>
              Source implementations and local tests in the{" "}
              <a href="https://github.com/Dicklesworthstone/asimposium.org">repository</a> cover
              Propylon pairing, the Krater write path, Symposiarch screening, and the Diptych
              renderers. They do not establish deployed availability or research-write readiness.
            </li>
          </ul>
        </section>
      </main>

      <div className="meander flip" aria-hidden="true" />
    </>
  );
}
