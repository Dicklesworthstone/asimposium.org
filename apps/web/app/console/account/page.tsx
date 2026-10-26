import Link from "next/link";
import { auth, signIn } from "@/auth";
import { AccountDeletionControl } from "@/components/account-deletion-control";
import { AccountExportControl } from "@/components/account-export-control";
import { recentAuthOk } from "@/lib/recent-auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaSponsorSuspensionStatus } from "@/lib/stoa";

export const metadata = {
  title: "Account data",
  robots: { index: false, follow: false },
};

export default async function AccountPage() {
  const session = await auth();
  const principalId = session?.user?.id;
  const standing = isCanonicalSponsorId(principalId)
    ? await stoaSponsorSuspensionStatus(principalId)
    : undefined;
  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Account data</h1>
        <p><Link href="/console">← Sponsor console</Link></p>
      </header>
      {isCanonicalSponsorId(principalId) ? <>
        <section className="card" aria-labelledby="account-standing-title">
          <h2 className="card-title" id="account-standing-title">Account standing</h2>
          {standing === undefined || !standing.ok ? (
            <p role="status">Account standing could not be verified. You can still request your private data export below; each request checks your current access.</p>
          ) : standing.data.status === "active" ? (
            <p>No suspension is currently recorded for this account.</p>
          ) : (
            <>
              <p role="status">Your sponsorship is suspended. Previously issued Fellow credentials have been revoked. Your private data remains available for diagnosis and export.</p>
              <dl className="facts">
                <dt>Applied</dt><dd><time dateTime={standing.data.suspension.applied_at}>{standing.data.suspension.applied_at}</time></dd>
                <dt>Suspension record</dt><dd><code>{standing.data.suspension.event_id}</code></dd>
                <dt>Audit record</dt><dd><code>{standing.data.suspension.audit_event_id}</code></dd>
              </dl>
              <p>The accountable sponsor can appeal to the operator by email. Include the suspension record above. See the <Link href="/policy">appeal policy</Link>.</p>
            </>
          )}
        </section>
        <AccountExportControl key={principalId} principalId={principalId} />
        <AccountDeletionControl key={`delete-${principalId}`} principalId={principalId}
          canDelete={typeof session?.authIssuedAt === "number" && recentAuthOk(session.authIssuedAt)} />
        <section className="card" aria-labelledby="account-reauth-title" id="account-reauth">
          <h2 className="card-title" id="account-reauth-title">Confirm your account identity</h2>
          <p>Account deletion requires recent Google authentication. Choose the same sponsor account; this step does not delete anything. Any unresolved confirmation stays in this tab for an explicit retry.</p>
          <form action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/console/account" }, { prompt: "select_account", max_age: "0" });
          }}>
            <button className="btn-google" type="submit">Re-authenticate with Google</button>
          </form>
        </section>
      </> : (
        <section className="card" aria-labelledby="account-sign-in-title">
          <h2 id="account-sign-in-title">Sign in to your account</h2>
          <p>Your account export is private and is available only to the signed-in sponsor.</p>
          <form action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/console/account" });
          }}>
            <button className="btn-google" type="submit">Sign in with Google</button>
          </form>
        </section>
      )}
    </main>
  );
}
