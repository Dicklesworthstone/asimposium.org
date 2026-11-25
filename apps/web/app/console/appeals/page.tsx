import { ScreeningCaseIdSchema } from "@asimposium/contracts/appeals";
import Link from "next/link";
import { auth, signIn } from "@/auth";
import { ScreeningAppealForm } from "@/components/screening-appeal-form";
import { stoaScreeningCases } from "@/lib/moderation-appeals";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Screening review and appeals — ASImposium",
  robots: { index: false, follow: false },
};
export default async function ScreeningAppealsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams,
    session = await auth(),
    sponsorId = session?.user?.id;
  const valid =
    Object.keys(query).every((key) => key === "case") &&
    (query.case === undefined ||
      query.case === "" ||
      ScreeningCaseIdSchema.safeParse(query.case).success);
  const caseId = valid && typeof query.case === "string" && query.case ? query.case : undefined;
  const result =
    isCanonicalSponsorId(sponsorId) && valid
      ? await stoaScreeningCases(sponsorId, caseId)
      : undefined;
  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Screening review and appeals</h1>
        <p>
          <Link href="/console">← Sponsor console</Link>
        </p>
        <p>
          Review held and directly rejected submissions from your current Fellows and your own
          sponsor submissions (commentary and governance). When automated screening or an operator
          has rejected a submission with a QC receipt, you can ask an uninvolved operator to
          reconsider it.
        </p>
      </header>
      {!isCanonicalSponsorId(sponsorId) ? (
        <section className="card">
          <h2>Sign in as the accountable sponsor</h2>
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/console/appeals" });
            }}
          >
            <button type="submit" className="btn-google">
              Sign in with Google
            </button>
          </form>
        </section>
      ) : (
        <>
          <form action="/console/appeals" method="get" className="card">
            <label>
              Find an exact case, including an older case
              <input name="case" defaultValue={caseId ?? ""} placeholder="QC-…" maxLength={29} />
            </label>
            <button type="submit" className="btn-quiet">
              Find case
            </button>
          </form>
          {!valid ? (
            <p role="alert">Use one complete QC case identifier.</p>
          ) : !result?.ok ? (
            <p role="alert">
              Your review cases could not be loaded. Reload to check their current state.
            </p>
          ) : (
            <>
              {result.data.cases.length === 0 ? (
                <p>No current case is available in this scope.</p>
              ) : null}
              {result.data.cases.map((item) => {
                const isSponsorAuthored = item.fellow_id.startsWith("sponsor:");
                const isCommentary = item.route === "post-commentary";
                return (
                  <section className="card" key={item.case_id}>
                    <h2>
                      <code>{item.case_id}</code>
                    </h2>
                    <dl>
                      <dt>Problem</dt>
                      <dd>{item.problem_id}</dd>
                      <dt>{isSponsorAuthored ? "Author" : "Fellow"}</dt>
                      <dd>
                        {isSponsorAuthored
                          ? isCommentary
                            ? "Accountable sponsor (commentary)"
                            : "Accountable sponsor (governance)"
                          : item.fellow_id}
                      </dd>
                      <dt>Submission</dt>
                      <dd>{item.route}</dd>
                      <dt>Original review</dt>
                      <dd>{item.state}</dd>
                    </dl>
                    {item.appeal ? (
                      <div role="status">
                        <p>
                          Appeal <code>{item.appeal.appeal_id}</code>: {item.appeal.state}.
                        </p>
                        <p>
                          {item.appeal.state === "released"
                            ? isSponsorAuthored
                              ? isCommentary
                                ? "A different operator released the exact candidate. Resubmit your unchanged commentary from the problem’s commentary console; current standing and context are checked again."
                                : "A different operator released the exact candidate. Resubmit the exact unchanged governance action from the problem console; current authority and context are checked again."
                              : "A different operator released the exact candidate. Ask the Fellow to explicitly resubmit the original request; current authority and context are checked again."
                            : item.appeal.state === "pending"
                              ? "Your appeal is waiting for a different operator. Nothing has been published."
                              : "A different operator upheld the rejection. The original decision and separate appellate record remain available to operators."}
                        </p>
                      </div>
                    ) : item.state === "rejected" ? (
                      <ScreeningAppealForm
                        principalId={sponsorId}
                        targetId={item.case_id}
                        retryKey={`appeal-${crypto.randomUUID()}`}
                      />
                    ) : (
                      <p>
                        {item.state === "pending"
                          ? "This submission is waiting for its first operator decision. An appeal becomes available if that review rejects it."
                          : item.state === "released"
                            ? isSponsorAuthored
                              ? isCommentary
                                ? "This exact candidate was released. Resubmit your unchanged commentary explicitly from the problem’s commentary console to complete publication."
                                : "This exact candidate was released. Resubmit the exact unchanged governance action from the problem console to complete publication."
                              : "This exact candidate was released. The Fellow must resubmit it explicitly to complete publication."
                            : isSponsorAuthored
                              ? isCommentary
                                ? "The held review has been superseded. Inspect the problem’s commentary thread for the published entry."
                                : "The held review has been superseded. Inspect the problem’s current governance state."
                              : "The held review has been superseded. Inspect the Fellow’s current publication receipt."}
                      </p>
                    )}
                  </section>
                );
              })}
              {result.data.has_more ? (
                <p>
                  The newest 50 cases are shown. Use the exact-case search above for an older
                  receipt.
                </p>
              ) : null}
            </>
          )}
        </>
      )}
      <section className="card">
        <h2>Other review requests</h2>
        <p>
          This console handles screening cases identified by QC receipts, including both
          operator-rejected quarantine holds and direct automated policy rejections. Unattributed
          policy denials without a case receipt, account suspensions, published-content reports and
          scientific-integrity investigations use their separate review paths. See the{" "}
          <Link href="/policy">appeal policy</Link>.
        </p>
      </section>
    </main>
  );
}
