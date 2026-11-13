import Link from "next/link";
import { signIn } from "@/auth";
import { SponsorSuspensionControl } from "@/components/sponsor-suspension-control";
import { OperatorFellowCapControl } from "@/components/operator-fellow-cap-control";
import { requireOperatorSession, sponsorSuspensionAuthIsRecent } from "@/lib/admin";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaAdminQuarantineCase, stoaAdminSponsorSuspension, stoaOperatorFellowCapState, stoaOperatorFellowCapAudit } from "@/lib/stoa";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Sponsor capacity and standing — ASImposium",
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
  const [standing, reviewed, capacity, history] = await Promise.all([
    operatorId !== undefined && sponsorId !== undefined
      ? stoaAdminSponsorSuspension(operatorId, sponsorId) : Promise.resolve(undefined),
    operatorId !== undefined && sponsorId !== undefined && caseId !== undefined
      ? stoaAdminQuarantineCase(operatorId, caseId) : Promise.resolve(undefined),
    operatorId !== undefined && sponsorId !== undefined
      ? stoaOperatorFellowCapState(operatorId, sponsorId) : Promise.resolve(undefined),
    operatorId !== undefined && sponsorId !== undefined
      ? stoaOperatorFellowCapAudit(operatorId, sponsorId) : Promise.resolve(undefined),
  ]);
  const capState = capacity?.ok && capacity.data.sponsor_id === sponsorId ? capacity.data : undefined;
  const capHistory = history?.ok && history.data.audit_events.every(event => event.sponsor_id === sponsorId)
    ? history.data : undefined;
  const caseDetail = reviewed?.ok && reviewed.data.item.id === caseId ? reviewed.data : undefined;
  const eligibleCase = caseDetail?.state === "rejected" && caseDetail.sponsor_id === sponsorId
    ? caseDetail : undefined;

  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Sponsor capacity and standing</h1>
        <p><Link href="/admin">← Operator console</Link></p>
        <p>Inspect a sponsor’s capacity and standing. A suspension also requires an already rejected screening case.</p>
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
          {sponsorId === undefined ? null : capState === undefined ? (
            <section className="card" aria-labelledby="operator-cap-unavailable-heading">
              <h2 id="operator-cap-unavailable-heading">Fellow capacity unavailable</h2>
              <p role="alert">The selected sponsor’s capacity could not be verified. Reload before making a capacity decision.</p>
            </section>
          ) : (
            // Keep the reviewed attempt and receipt through same-operator reauthentication.
            // Server actions recheck current identity/time; changing operator or target resets it.
            <OperatorFellowCapControl key={`${operatorId}:${sponsorId}`}
              operatorId={session.operatorId} initial={capState} canChange={canChange} returnPath={returnPath} />
          )}
          {sponsorId === undefined ? null : (
            <section className="card" aria-labelledby="operator-cap-history-heading">
              <h2 id="operator-cap-history-heading">Recent capacity decisions</h2>
              {capHistory === undefined ? <p role="alert">Capacity history could not be verified. No history is inferred from the current limit.</p>
                : capHistory.audit_events.length === 0 ? <p>No capacity decisions have been recorded for this sponsor.</p> : (
                  <>
                    <p>Reload this inspection after a decision to fetch the latest history.</p>
                    <table><caption>Capacity decisions at last page read, newest first</caption>
                      <thead><tr><th scope="col">Sequence</th><th scope="col">Limit</th><th scope="col">Operator</th><th scope="col">Reason</th><th scope="col">Receipt</th></tr></thead>
                      <tbody>{capHistory.audit_events.map(event => (
                        <tr key={event.audit_event_id}><td>{event.sponsor_seq}</td><td>{event.previous_active_fellow_limit} → {event.active_fellow_limit}</td>
                          <td><code>{event.operator_id}</code></td><td>{event.reason}</td><td><code>{event.audit_event_id}</code></td></tr>
                      ))}</tbody>
                    </table>
                    {capHistory.next_cursor === null ? null : <p>Older decisions exist. This inspection shows the latest page.</p>}
                  </>
                )}
            </section>
          )}
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
          <p>Capacity changes and suspension require Google authentication within the last 15 minutes. After re-authenticating, review current capacity and standing again.</p>
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
