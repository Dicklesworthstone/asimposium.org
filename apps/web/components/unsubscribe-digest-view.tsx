import Link from "next/link";
import type { ParsedUnsubscribeToken } from "@/lib/email-preferences";

export function UnsubscribeDigestView({
  status,
  token,
  confirmAction,
}: {
  readonly status: string | undefined;
  readonly token: ParsedUnsubscribeToken | undefined;
  readonly confirmAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Digest email unsubscribe</h1>
        <p>
          <Link href="/console/email-preferences">← Email preferences</Link>
        </p>
      </header>

      {status === "done" ? (
        <section className="card" role="status">
          <h2 className="card-title">Digest turned off</h2>
          <p>
            Your opt-in research digest has been turned off immediately, and any pending digest
            deliveries have been suppressed. Mandatory security, enrollment, and moderation notices
            remain available in your <Link href="/console">Sponsor Console</Link>.
          </p>
        </section>
      ) : status === "invalid" ? (
        <section className="card" role="alert">
          <h2 className="card-title">Unsubscribe link could not be verified</h2>
          <p>
            The signature or parameters on this unsubscribe link were not accepted. Sign in to{" "}
            <Link href="/console/email-preferences">Email preferences</Link> to manage your digest
            setting directly.
          </p>
        </section>
      ) : status === "unavailable" ? (
        <section className="card" role="alert">
          <h2 className="card-title">Service temporarily unavailable</h2>
          <p>
            Stoa could not process the unsubscribe right now. Retry from your email link or sign in
            to <Link href="/console/email-preferences">Email preferences</Link>.
          </p>
        </section>
      ) : token ? (
        <section className="card" aria-labelledby="confirm-unsub-title">
          <h2 className="card-title" id="confirm-unsub-title">
            Confirm digest unsubscribe
          </h2>
          <p>
            Visiting this page does not change your account on its own. Confirm below to turn off
            the optional ASImposium research digest immediately.
          </p>
          <form action={confirmAction}>
            <input type="hidden" name="ref" value={token.ref} />
            <input type="hidden" name="sig" value={token.sig} />
            <button type="submit" className="btn-quiet">
              Turn off digest emails
            </button>
          </form>
        </section>
      ) : (
        <section className="card" role="alert">
          <h2 className="card-title">Incomplete unsubscribe link</h2>
          <p>
            This link is missing a valid signed unsubscribe reference. Sign in to{" "}
            <Link href="/console/email-preferences">Email preferences</Link> to update your digest
            setting.
          </p>
        </section>
      )}
    </main>
  );
}
