import type { ReactNode } from "react";
import Link from "next/link";
import { auth, signIn } from "@/auth";
import { requireOperatorSession } from "@/lib/admin";
import {
  stoaIntegrityCases,
  stoaOperatorIntegrityCase,
  stoaSponsorIntegrityCase,
} from "@/lib/integrity-cases";
import {
  integrityAuthIsRecent,
  integrityCaseHref,
  integrityListHref,
  parseIntegrityHistoryQuery,
  parseIntegrityListQuery,
  type IntegrityAudience,
  type IntegritySearchParams,
} from "@/lib/integrity-view";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { IntegrityCasesList, IntegrityCaseView } from "./integrity-case-view";
import { ResolveIntegrityCaseForm, RespondToIntegrityCaseForm } from "./integrity-forms";

async function identity(audience: IntegrityAudience) {
  if (audience === "operator") {
    const session = await requireOperatorSession();
    if (session.state !== "authorized" && session.state !== "step_up_required")
      return { id: null, canWrite: false, forbidden: session.state === "forbidden" };
    return {
      id: session.operatorId,
      canWrite: session.state === "authorized" && integrityAuthIsRecent(session.authIssuedAt),
      forbidden: false,
    };
  }
  const session = await auth();
  const sponsorId = session?.user?.id;
  return { id: isCanonicalSponsorId(sponsorId) ? sponsorId : null, canWrite: true, forbidden: false };
}

function SignIn({ returnPath, reauthenticate = false }: {
  readonly returnPath: string;
  readonly reauthenticate?: boolean;
}) {
  return <form action={async () => {
    "use server";
    await signIn("google", { redirectTo: returnPath }, { prompt: "select_account", max_age: "0" });
  }} className="card">
    <p>{reauthenticate ? "Operator writes require authentication within the last 15 minutes." : "Sign in with the account responsible for these cases."}</p>
    <button className="btn-google" type="submit">{reauthenticate ? "Re-authenticate with Google" : "Sign in with Google"}</button>
  </form>;
}

function Frame({ audience, children }: { readonly audience: IntegrityAudience; readonly children: ReactNode }) {
  return <main className="landing col console" id="content">
    <header className="masthead console-head">
      <h1 className="console-title">Scientific-integrity cases</h1>
      <p><Link href={audience === "operator" ? "/admin" : "/console"} prefetch={false}>
        {audience === "operator" ? "← Operator console" : "← Sponsor console"}
      </Link>{" · "}<Link href={integrityListHref(audience)} prefetch={false}>Case list</Link></p>
      <p>{audience === "operator"
        ? "Investigate concrete concerns against pinned publications, hear the affected sponsor, and record an accountable outcome."
        : "Read concerns about publications under your sponsorship, respond to operators, and appeal an outcome once."}</p>
      <p>This is a private case workspace. Public notices contain neutral source and case-state information.</p>
    </header>
    {children}
  </main>;
}

function Unavailable({ returnPath, missing = false }: { readonly returnPath: string; readonly missing?: boolean }) {
  return <section className="card" role="alert">
    <h2>{missing ? "Case unavailable to this account" : "Case history unavailable"}</h2>
    <p>{missing ? "No case is available at this link for the signed-in account." : "Stoa could not return a verified case record. An unavailable read does not mean that there are no cases."}</p>
    <p><a href={returnPath}>Retry this page</a></p>
  </section>;
}

export async function IntegrityWorkspace({ audience, caseId, query }: {
  readonly audience: IntegrityAudience;
  readonly caseId?: string;
  readonly query: IntegritySearchParams;
}) {
  const principal = await identity(audience);
  const listQuery = caseId === undefined ? parseIntegrityListQuery(query) : null;
  const readQuery = caseId === undefined ? null : parseIntegrityHistoryQuery(caseId, query);
  const returnPath = caseId === undefined ? integrityListHref(audience, listQuery?.before)
    : readQuery === null ? integrityListHref(audience) : integrityCaseHref(audience, caseId, readQuery.after_revision);
  if (principal.id === null) return <Frame audience={audience}>
    {principal.forbidden ? <p role="alert">This account is not an allowlisted operator.</p> : <p>Sign in to read your private scientific-integrity cases.</p>}
    <SignIn returnPath={returnPath} />
  </Frame>;
  if (caseId === undefined) {
    if (listQuery === null) return <Frame audience={audience}>
      <h2>Invalid case history link</h2><p>Use a complete case cursor from the case list. Repeated or unrelated query fields are not accepted.</p>
      <p><Link href={integrityListHref(audience)} prefetch={false}>Read current cases</Link></p>
    </Frame>;
    const result = await stoaIntegrityCases(principal.id, audience, listQuery).catch(() => null);
    return <Frame audience={audience}>{result?.ok
      ? <IntegrityCasesList page={result.data} audience={audience} />
      : <Unavailable returnPath={returnPath} />}
      {audience === "operator" ? <p>Open a new case from a pending integrity report in the{" "}
        <Link href="/admin" prefetch={false}>operator report queue</Link>.</p> : null}
    </Frame>;
  }
  if (readQuery === null) return <Frame audience={audience}>
    <h2>Invalid case link</h2><p>Use a complete IC case identifier and a canonical history revision.</p>
    <p><Link href={integrityListHref(audience)} prefetch={false}>Read current cases</Link></p>
  </Frame>;
  const result = await (audience === "operator"
    ? stoaOperatorIntegrityCase(principal.id, readQuery)
    : stoaSponsorIntegrityCase(principal.id, readQuery)).catch(() => null);
  if (!result?.ok) return <Frame audience={audience}><Unavailable returnPath={returnPath}
    missing={result !== null && !result.ok && result.status === 404} /></Frame>;
  const page = result.data;
  const item = page.case;
  const controls: ReactNode = audience === "operator" ? <>
    {!principal.canWrite ? <SignIn returnPath={returnPath} reauthenticate /> : null}
    {item.state === "open" && page.has_more ? <p>Continue through the later case history before recording an outcome.</p> : null}
    {item.state === "resolved" ? <p>The current outcome is recorded. Further decisions require a sponsor appeal.</p> : null}
    <ResolveIntegrityCaseForm operatorId={principal.id} caseId={caseId} revision={item.revision}
      initialKey={"integrity-resolve-" + crypto.randomUUID()} appealed={item.appeals_used === 1}
      available={principal.canWrite && item.state === "open" && !page.has_more} />
  </> : <>
    {item.state === "resolved" && item.appeals_used === 1
      ? <p>The appeal outcome is recorded. This case has used its one appeal; its full history remains available above.</p> : null}
    <RespondToIntegrityCaseForm sponsorId={principal.id} caseId={caseId} revision={item.revision}
      initialKey={"integrity-respond-" + crypto.randomUUID()} appeal={item.state === "resolved"}
      available={item.state === "open" || item.appeals_used === 0} />
  </>;
  return <Frame audience={audience}><IntegrityCaseView page={page} audience={audience}
    afterRevision={readQuery.after_revision}
    reportId={audience === "operator" && "report_id" in page && typeof page.report_id === "string" ? page.report_id : undefined}
    actions={controls} /></Frame>;
}
