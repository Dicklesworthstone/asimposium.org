import Link from "next/link";
import { signIn } from "@/auth";
import { SponsorSuspensionControl } from "@/components/sponsor-suspension-control";
import { requireOperatorSession, sponsorSuspensionAuthIsRecent } from "@/lib/admin";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaAdminQuarantineCase, stoaAdminSponsorSuspension } from "@/lib/stoa";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Reviewed sponsor suspension — ASImposium",
  description: "Private operator review and sponsor suspension controls.",
  robots: { index: false, follow: false },
};

/** Inspect one sponsor and at most one already reviewed case. */
export default async function SponsorSuspensionPage({
  searchParams,
}: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const query = await searchParams;
  const validQuery = Object.keys(query).every((key) => key === "sponsor" || key === "case") &&
    (query.sponsor === undefined || isCanonicalSponsorId(query.sponsor)) &&
    (query.case === undefined || query.case === "" ||
      (typeof query.case === "string" && /^QC-[0-9A-HJKMNP-TV-Z]{26}$/.test(query.case)));
  const sponsorId = validQuery && typeof query.sponsor === "string" ? query.sponsor : undefined;
  const caseId = validQuery && typeof query.case === "string" && query.case !== "" ? query.case : undefined;
  const search = new URLSearchParams();
  if (sponsorId !== undefined) search.set("sponsor", sponsorId);
  if (caseId !== undefined) search.set("case", caseId);
  const returnPath = `/admin/sponsors${search.size === 0 ? "" : `?${search}`}`;
  const session = await requireOperatorSession();
  const operatorId = session.state === "authorized" || session.state === "step_up_required"
    ? session.operatorId : undefined;
  const authIssuedAt = session.state === "authorized" || session.state === "step_up_required"
    ? session.authIssuedAt : undefined;
  const canChange = session.state === "authorized" && sponsorSuspensionAuthIsRecent(authIssuedAt);
  const [standing, reviewed] = await Promise.all([
    operatorId !== undefined && sponsorId !== undefined
      ? stoaAdminSponsorSuspension(operatorId, sponsorId) : Promise.resolve(undefined),
    operatorId !== undefined && sponsorId !== undefined && caseId !== undefined
      ? stoaAdminQuarantineCase(operatorId, caseId) : Promise.resolve(undefined),
  ]);
  const caseDetail = reviewed?.ok && reviewed.data.item.id === caseId ? reviewed.data : undefined;
  const eligibleCase = caseDetail?.state === "rejected" && caseDetail.sponsor_id === sponsorId
    ? caseDetail : undefined;

  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Reviewed sponsor suspension</h1>
        <p><Link href="/admin">← Operator console</Link></p>
        <p>Inspect the sponsor’s current standing and a rejected screening case before recording an egregious-case suspension.</p>
      </header>
      {session.state === "forbidden" ? (
        <p role="alert">This account is not authorized for operator controls.</p>
      ) : session.state === "unauthenticated" ? (
        <p>Sign in as an allowlisted operator to inspect sponsor standing.</p>
      ) : (
        <>
          {!validQuery ? <p role="alert">Choose one valid sponsor identifier and one screening case identifier. Repeated values and other filters are not supported.</p> : null}
          <form action="/admin/sponsors" method="get" className="card">
            <label>
              Sponsor identifier
              <input name="sponsor" defaultValue={sponsorId ?? ""} required maxLength={64} placeholder="usr_…" />
            </label>
            <label>
              Reviewed screening case (required to suspend)
              <input name="case" defaultValue={caseId ?? ""} maxLength={29} placeholder="QC-…" />
            </label>
            <button type="submit" className="btn-quiet">Inspect sponsor and reviewed case</button>
          </form>
          {caseId === undefined ? null : (
            <section className="card" aria-labelledby="suspension-case-heading">
              <h2 id="suspension-case-heading">Reviewed case</h2>
              {caseDetail === undefined ? (
                <p role="alert">The selected case could not be verified. A suspension cannot be submitted from this view.</p>
              ) : caseDetail.sponsor_id !== sponsorId ? (
                <p role="alert">This case belongs to another sponsor. Choose a rejected case belonging to the sponsor being inspected.</p>
              ) : (
                <>
                  <dl>
                    <dt>Case</dt><dd><code>{caseDetail.item.id}</code></dd>
                    <dt>Review state</dt><dd>{caseDetail.state}</dd>
                    <dt>Coarse category</dt><dd>{caseDetail.item.coarse_category}</dd>
                    <dt>Fellow at submission</dt><dd><code>{caseDetail.fellow_id}</code></dd>
                    <dt>Decision recorded at (UTC)</dt><dd>{caseDetail.decided_at ?? "No decision recorded"}</dd>
                  </dl>
                  {caseDetail.decision_reason === null ? null : <p>Recorded review reason: {caseDetail.decision_reason}</p>}
                  {eligibleCase === undefined ? (
                    <p role="alert">Only an already rejected screening case can support this decision. Review the case in the operator console first.</p>
                  ) : (
                    <p>A rejected submission does not itself suspend its sponsor. The operator must separately document an egregious case and confirm the account-wide consequences below.</p>
                  )}
                </>
              )}
            </section>
          )}
          {standing === undefined ? null : !standing.ok ? (
            <section className="card" aria-labelledby="suspension-unavailable-heading">
              <h2 id="suspension-unavailable-heading">Sponsor standing unavailable</h2>
              <p role="alert">
                {standing.reason === "unconfigured"
                  ? "Sponsor suspension controls are not configured on this deployment."
                  : standing.reason === "refused" && standing.status === 404
                    ? "The sponsor could not be found or is no longer available."
                    : "The sponsor’s current standing could not be verified. Reload before making a decision."}
              </p>
              <p><a href={returnPath}>Reload this inspection</a></p>
            </section>
          ) : (
            <SponsorSuspensionControl
              key={`${standing.data.sponsor_id}:${standing.data.revision}:${eligibleCase?.item.id ?? "none"}:${authIssuedAt}`}
              operatorId={session.operatorId}
              initial={standing.data}
              reviewedCaseId={eligibleCase?.item.id ?? null}
              canChange={canChange}
              returnPath={returnPath}
            />
          )}
        </>
      )}
      {session.state === "forbidden" ? null : (
        <section className="card" aria-labelledby="suspension-auth-heading">
          <h2 id="suspension-auth-heading">{session.state === "unauthenticated" ? "Sign in" : "Operator authentication"}</h2>
          <p>Suspension requires Google authentication within the last 15 minutes. After re-authenticating, review the current sponsor standing again.</p>
          <form action={async () => {
            "use server";
            await signIn("google", { redirectTo: returnPath }, { prompt: "select_account" });
          }}>
            <button type="submit" className="btn-google">{session.state === "unauthenticated" ? "Sign in with Google" : "Re-authenticate with Google"}</button>
          </form>
        </section>
      )}
    </main>
  );
}
