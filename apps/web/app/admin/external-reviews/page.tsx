import { PublicLedgerProblemIdSchema, type ExternalExpertReviewRecord } from "@asimposium/contracts";
import Link from "next/link";
import { signIn } from "@/auth";
import {
  ExternalExpertReviewControl,
  ExternalExpertReviewRecordView,
} from "@/components/external-expert-review-control";
import { requireOperatorSession } from "@/lib/admin";
import { stoaExternalExpertReviews } from "@/lib/external-expert-reviews";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "External expert review attestations — ASImposium",
  description: "Private operator inspection and recording of external review attestations.",
  robots: { index: false, follow: false },
};

/** Record attribution and source checks without changing scientific dispositions. */
export default async function ExternalExpertReviewsPage({
  searchParams,
}: { readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> }) {
  const query = await searchParams;
  const valid = Object.keys(query).every((key) => key === "problem") &&
    (query.problem === undefined || query.problem === "" ||
      (typeof query.problem === "string" && query.problem.trim() === query.problem &&
        PublicLedgerProblemIdSchema.safeParse(query.problem).success));
  const problemId = valid && typeof query.problem === "string" && query.problem !== "" ? query.problem : undefined;
  const returnPath = "/admin/external-reviews" + (problemId === undefined ? "" : "?problem=" + encodeURIComponent(problemId));
  const session = await requireOperatorSession();
  const operatorId = session.state === "authorized" || session.state === "step_up_required" ? session.operatorId : undefined;
  let records: readonly ExternalExpertReviewRecord[] | null = null;
  if (operatorId !== undefined && problemId !== undefined) {
    try {
      const result = await stoaExternalExpertReviews(operatorId, problemId);
      if (result.ok) records = result.data;
    } catch { /* An interrupted inspection is unavailable, never an empty history. */ }
  }
  return <main className="landing col console" id="content">
    <header className="masthead console-head">
      <h1 className="console-title">External expert review attestations</h1>
      <p><Link href="/admin" prefetch={false}>← Operator console</Link></p>
      <p>Inspect external review records and record verified attribution, a permanent source, and the exact limits of an expert review. Famous-problem resolution separately checks the resulting reference and all scientific requirements.</p>
    </header>
    {session.state === "forbidden" ? <p role="alert">This account is not authorized for operator controls.</p>
      : operatorId === undefined ? <p>Sign in as an allowlisted operator to inspect and record external reviews.</p>
      : <>
        {!valid && <p role="alert">Choose one canonical problem identifier. Repeated values and other filters are not supported.</p>}
        <form action="/admin/external-reviews" method="get" className="card">
          <label>Problem identifier<input name="problem" defaultValue={problemId ?? ""} required maxLength={128} placeholder="P-…" /></label>
          <button type="submit" className="btn-quiet">Inspect external reviews</button>
        </form>
        {problemId !== undefined && <>
          <ExternalExpertReviewControl key={operatorId + ":" + problemId}
            operatorId={operatorId} problemId={problemId} canChange={session.state === "authorized"}
            historyAvailable={records !== null} returnPath={returnPath} />
          {records === null ? <section className="card">
            <h2>External review history unavailable</h2>
            <p role="alert">The operator review records could not be read. Reload before recording a new attestation; no empty history is inferred.</p>
          </section> : <>
            <section aria-labelledby="external-review-history">
              <h2 id="external-review-history">Recent recorded attestations</h2>
              <p>This inspection returns up to 50 recent records for <code>{problemId}</code>. Older records may exist. Reload after recording a review to inspect current history and any revocations.</p>
              {records.length === 0 ? <p>No external review records were returned.</p>
                : records.map((record) => <ExternalExpertReviewRecordView key={record.review_record_id} record={record} />)}
            </section>
          </>}
        </>}
      </>}
    {session.state !== "forbidden" && <section className="card">
      <h2>{session.state === "unauthenticated" ? "Operator sign-in" : "Operator authentication"}</h2>
      <p>Recording requires current operator authority and Google authentication within the last 15 minutes.</p>
      <form action={async () => {
        "use server";
        await signIn("google", { redirectTo: returnPath }, { prompt: "select_account" });
      }}>
        <button type="submit" className="btn-google">{session.state === "unauthenticated" ? "Sign in with Google" : "Re-authenticate with Google"}</button>
      </form>
    </section>}
  </main>;
}
