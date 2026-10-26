import Link from "next/link";
import { auth, signIn } from "@/auth";
import { DirectiveDisclosureControl } from "@/components/directive-disclosure-control";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { directiveDisclosureHref, directiveDisclosureSelection } from "@/lib/directive-disclosure-target";
import { stoaDirectiveDisclosure } from "@/lib/directive-disclosures";
import { configuredStoaOrigin } from "@/lib/stoa";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Sponsor directive disclosure — ASImposium",
  description: "Review a sponsor's exact claim disclosure scope and record a public declaration.",
  robots: { index: false, follow: false },
};

/** One exact claim means one bounded, freshly authenticated private read. */
export default async function DirectiveDisclosurePage({ searchParams }: {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const selection = directiveDisclosureSelection(await searchParams);
  const target = selection.state === "selected" ? selection.target : undefined;
  const returnPath = directiveDisclosureHref(target);
  const session = await auth();
  const sponsorId = session?.user?.id;
  let result: Awaited<ReturnType<typeof stoaDirectiveDisclosure>> | undefined;
  if (isCanonicalSponsorId(sponsorId) && target !== undefined) {
    try { result = await stoaDirectiveDisclosure(sponsorId, target); }
    catch { result = { ok: false, reason: "unreachable" }; }
  }

  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Sponsor directive disclosure</h1>
        <p><Link href="/console">← Sponsor console</Link></p>
        <p>Review the private steering for one exact claim version before recording your own public declaration. Each accountable sponsor resolves their own part of the result’s history.</p>
      </header>
      {selection.state === "invalid" ? <p role="alert">Choose one problem, one claim and one positive version number. Repeated values, additional filters and unpinned claims are not supported.</p> : null}
      <form action="/console/disclosures" method="get" className="card">
        <label>Problem identifier<input name="problem" defaultValue={target?.problemId ?? ""} required maxLength={128} placeholder="P-SP4D" /></label>
        <label>Claim identifier<input name="claim" defaultValue={target?.claimId ?? ""} required maxLength={47} placeholder="C-1" /></label>
        <label>Exact claim version<input name="version" type="number" min={1} step={1} max={Number.MAX_SAFE_INTEGER} defaultValue={target?.version ?? ""} required /></label>
        <button className="btn-quiet" type="submit">Inspect this claim’s disclosure scope</button>
      </form>
      {!isCanonicalSponsorId(sponsorId) ? (
        <section className="card" aria-labelledby="disclosure-sign-in-title">
          <h2 id="disclosure-sign-in-title">Sign in to inspect your sponsor scope</h2>
          <p>The current sponsor’s own directives are private. Another sponsor’s directive bodies are never shown here.</p>
          <form action={async () => {
            "use server";
            await signIn("google", { redirectTo: returnPath });
          }}>
            <button className="btn-google" type="submit">Sign in with Google</button>
          </form>
        </section>
      ) : result === undefined ? null : !result.ok ? (
        <section className="card" aria-labelledby="disclosure-unavailable-title">
          <h2 id="disclosure-unavailable-title">Disclosure scope unavailable</h2>
          <p role="alert">{result.reason === "unconfigured"
            ? "Disclosure controls are not configured on this deployment."
            : result.reason === "refused" && result.status === 404
              ? "This exact claim version is unavailable to the signed-in account. Verify the problem, claim and version."
              : "The exact claim lineage and your sponsor authority could not be verified. Reload before making a declaration."}</p>
          <p><a href={returnPath}>Reload this inspection</a></p>
        </section>
      ) : (
        <DirectiveDisclosureControl
          key={`${sponsorId}:${result.data.lineage_digest}:${result.data.scopes.map((scope) => `${scope.scope_id}:${scope.revision}`).join(":")}`}
          sponsorId={sponsorId}
          initial={result.data}
          returnPath={returnPath}
          stoaOrigin={configuredStoaOrigin()}
        />
      )}
    </main>
  );
}
