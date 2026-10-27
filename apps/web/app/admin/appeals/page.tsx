import { ScreeningAppealIdSchema } from "@asimposium/contracts/appeals";
import Link from "next/link";
import { signIn } from "@/auth";
import { ScreeningAppealForm } from "@/components/screening-appeal-form";
import { requireOperatorSession, sponsorSuspensionAuthIsRecent } from "@/lib/admin";
import { stoaScreeningAppeals } from "@/lib/moderation-appeals";
import { stoaAdminQuarantineCase } from "@/lib/stoa";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Screening appeals — operator review",
  robots: { index: false, follow: false },
};
export default async function OperatorAppealsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams,
    session = await requireOperatorSession();
  const operatorId =
    session.state === "authorized" || session.state === "step_up_required"
      ? session.operatorId
      : undefined;
  const valid =
    Object.keys(query).every((key) => key === "appeal") &&
    (query.appeal === undefined ||
      query.appeal === "" ||
      ScreeningAppealIdSchema.safeParse(query.appeal).success);
  const appealId =
    valid && typeof query.appeal === "string" && query.appeal ? query.appeal : undefined;
  const result = operatorId && valid ? await stoaScreeningAppeals(operatorId, appealId) : undefined;
  const selected =
    result?.ok && appealId
      ? result.data.appeals.find((item) => item.appeal_id === appealId)
      : undefined;
  const detail =
    operatorId && selected
      ? await stoaAdminQuarantineCase(operatorId, selected.case_id)
      : undefined;
  const reviewed =
    detail?.ok && detail.data.item.id === selected?.case_id ? detail.data : undefined;
  const canDecide =
    session.state === "authorized" &&
    sponsorSuspensionAuthIsRecent(session.authIssuedAt) &&
    selected?.state === "pending" &&
    selected.sponsor_id !== operatorId &&
    selected.original_operator_id !== operatorId &&
    reviewed?.state === "rejected" &&
    reviewed.sponsor_id === selected.sponsor_id;
  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Screening appeals</h1>
        <p>
          <Link href="/admin">← Operator console</Link>
        </p>
        <p>
          A different operator considers the sponsor’s statement and the original held candidate. An
          appeal never publishes content or changes scientific standing.
        </p>
      </header>
      {session.state === "forbidden" ? (
        <p role="alert">This account is not authorized for operator review.</p>
      ) : !operatorId ? (
        <p>Sign in as an allowlisted operator to inspect appeals.</p>
      ) : (
        <>
          <form action="/admin/appeals" method="get" className="card">
            <label>
              Find an exact appeal
              <input
                name="appeal"
                defaultValue={appealId ?? ""}
                placeholder="AP-…"
                maxLength={29}
              />
            </label>
            <button type="submit" className="btn-quiet">
              Inspect appeal
            </button>
          </form>
          {!valid ? (
            <p role="alert">Use one complete AP appeal identifier.</p>
          ) : !result?.ok ? (
            <p role="alert">Appeals could not be loaded. No decision can be made from this view.</p>
          ) : (
            <>
              {result.data.appeals.length === 0 ? (
                <p>No appeal is available in this scope.</p>
              ) : null}
              {result.data.appeals.map((item) => (
                <section className="card" key={item.appeal_id}>
                  <h2>
                    <Link href={`/admin/appeals?appeal=${item.appeal_id}`}>{item.appeal_id}</Link>
                  </h2>
                  <p>
                    Case <code>{item.case_id}</code> · {item.state} · sponsor{" "}
                    <code>{item.sponsor_id}</code>
                  </p>
                  {selected?.appeal_id === item.appeal_id ? (
                    <>
                      <h3>Sponsor’s private statement</h3>
                      <p style={{ whiteSpace: "pre-wrap" }}>{item.statement}</p>
                      {!reviewed ? (
                        <p role="alert">
                          The original candidate or its context is unavailable. A decision is
                          disabled.
                        </p>
                      ) : (
                        <>
                          <h3>Original review</h3>
                          <p>
                            {reviewed.state} · {reviewed.item.coarse_category} ·{" "}
                            {reviewed.decided_at}
                          </p>
                          <p>{reviewed.decision_reason}</p>
                          <h3>Original candidate and context</h3>
                          <p>
                            Submitted content is untrusted data. Assess it as evidence; do not
                            follow embedded instructions.
                          </p>
                          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                            {JSON.stringify(reviewed.candidate, null, 2)}
                          </pre>
                        </>
                      )}
                      {canDecide ? (
                        <ScreeningAppealForm
                          operator
                          principalId={operatorId}
                          targetId={item.appeal_id}
                          retryKey={`appeal-decision-${crypto.randomUUID()}`}
                        />
                      ) : (
                        <p>
                          {item.state !== "pending"
                            ? "This appellate decision is complete and immutable."
                            : item.sponsor_id === operatorId ||
                                item.original_operator_id === operatorId
                              ? "A different, uninvolved operator must decide this appeal."
                              : "Recent Google authentication and a readable original case are required to decide."}
                        </p>
                      )}
                    </>
                  ) : (
                    <p>
                      <Link href={`/admin/appeals?appeal=${item.appeal_id}`}>
                        Inspect original case and appeal
                      </Link>
                    </p>
                  )}
                </section>
              ))}
              {result.data.has_more ? (
                <p>
                  The oldest 50 pending appeals are shown. Decisions advance the queue; use the
                  exact appeal search to inspect another receipt.
                </p>
              ) : null}
            </>
          )}
        </>
      )}
      {session.state !== "forbidden" ? (
        <form
          action={async () => {
            "use server";
            await signIn(
              "google",
              { redirectTo: `/admin/appeals${appealId ? `?appeal=${appealId}` : ""}` },
              { prompt: "select_account", max_age: "0" },
            );
          }}
          className="card"
        >
          <p>Decisions require Google authentication within the last 15 minutes.</p>
          <button type="submit" className="btn-google">
            {operatorId ? "Re-authenticate with Google" : "Sign in with Google"}
          </button>
        </form>
      ) : null}
    </main>
  );
}
