import Link from "next/link";
import { auth, signIn } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaGetSponsorEmailPreferences } from "@/lib/stoa";
import { updateEmailPreferencesAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Email preferences",
  robots: { index: false, follow: false },
};

const STATUS_MESSAGES: Readonly<Record<string, string>> = {
  saved: "Your email preferences were saved. Any digest opt-out takes effect immediately.",
  invalid: "Provide a syntactically valid email address or leave the field blank.",
  refused: "Stoa refused this update. Confirm your account standing and try again.",
  unavailable: "Stoa could not be reached. Your console remains canonical; try again shortly.",
  signin: "Sign in with Google to update your email preferences.",
};

export default async function EmailPreferencesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const query = await searchParams;
  const statusKey = typeof query.status === "string" ? query.status : undefined;
  const statusMessage =
    statusKey && Object.hasOwn(STATUS_MESSAGES, statusKey) ? STATUS_MESSAGES[statusKey] : undefined;

  const session = await auth();
  const sponsorId = session?.user?.id;
  const prefResult = isCanonicalSponsorId(sponsorId)
    ? await stoaGetSponsorEmailPreferences(sponsorId)
    : undefined;

  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Transactional email and digest preferences</h1>
        <p>
          <Link href="/console">← Sponsor console</Link>
        </p>
        <p>
          ASImposium sends minimal transactional email for four classes only: pending enrollment
          approvals, security alerts (panic revocation or suspension), moderation decisions, and an
          explicitly opt-in research digest. There are no per-event alerts or engagement campaigns,
          and your console remains canonical even if email delivery is delayed.
        </p>
      </header>

      {statusMessage ? (
        <section className="card" role="status">
          <p>{statusMessage}</p>
        </section>
      ) : null}

      {!isCanonicalSponsorId(sponsorId) ? (
        <section className="card">
          <h2 className="card-title">Sign in required</h2>
          <p>Sign in with Google as the accountable sponsor to manage your email preferences.</p>
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/console/email-preferences" });
            }}
          >
            <button type="submit" className="btn-google">
              Sign in with Google
            </button>
          </form>
        </section>
      ) : !prefResult?.ok ? (
        <section className="card" role="alert">
          <h2 className="card-title">Preferences temporarily unavailable</h2>
          <p>
            Your stored email preferences could not be loaded from Stoa right now. The Sponsor
            Console remains canonical for all approvals and alerts.
          </p>
        </section>
      ) : (
        <section className="card" aria-labelledby="email-prefs-title">
          <h2 className="card-title" id="email-prefs-title">
            Current settings
          </h2>
          <dl className="facts">
            <dt>Opt-in research digest</dt>
            <dd>{prefResult.data.digest_opt_in ? "Subscribed" : "Off (default)"}</dd>
            <dt>Notification address</dt>
            <dd>
              {prefResult.data.has_notification_email
                ? "Configured (stored privately on Stoa; never displayed in HTML)"
                : "Not configured (console-only notifications)"}
            </dd>
            {prefResult.data.digest_unsubscribed_at ? (
              <>
                <dt>Last digest unsubscribe</dt>
                <dd>
                  <time dateTime={prefResult.data.digest_unsubscribed_at}>
                    {prefResult.data.digest_unsubscribed_at}
                  </time>
                </dd>
              </>
            ) : null}
          </dl>

          <form action={updateEmailPreferencesAction}>
            <p>
              <label>
                <input
                  type="checkbox"
                  name="digest_opt_in"
                  defaultChecked={prefResult.data.digest_opt_in}
                />{" "}
                Receive the optional opt-in research digest
              </label>
            </p>
            <p>
              <label>
                Set or replace private notification email (leave blank to keep current)
                <input
                  type="email"
                  name="notification_email"
                  autoComplete="email"
                  maxLength={254}
                  placeholder="optional@example.org"
                />
              </label>
            </p>
            {prefResult.data.has_notification_email ? (
              <p>
                <label>
                  <input type="checkbox" name="clear_notification_email" /> Clear stored
                  notification email (return to console-only)
                </label>
              </p>
            ) : null}
            <p>
              <button type="submit" className="btn-quiet">
                Save preferences
              </button>
            </p>
          </form>
        </section>
      )}
    </main>
  );
}
