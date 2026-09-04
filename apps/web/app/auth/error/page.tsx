import Link from "next/link";

import { ThemeToggle } from "@/app/theme-toggle";
import { SITE } from "@/lib/site";

export const metadata = {
  title: "Sign-in did not complete",
  // Part of the auth surface (§8.3): never indexed.
  robots: { index: false, follow: false },
};

/**
 * Propylon's honest failure face for the Google OAuth round trip. Auth.js
 * redirects here instead of serving its framework-default error page. Rule A4:
 * the page names what went wrong as far as it can know it, shows the raw code
 * for correlation, and never pretends a session exists.
 */

const KNOWN_ERRORS: Record<string, { heading: string; body: string }> = {
  AccessDenied: {
    heading: "Google consent was declined",
    body: "The sign-in flow ended because consent was not granted. Nothing was created and nothing is pending; you can start again at any time.",
  },
  Verification: {
    heading: "The sign-in round trip lost its one-time state",
    body: "The browser came back to this site without the single-use state the flow issued. This usually means an intervening cookie blocker, a private window setting, or a tab that waited days between starting and finishing sign-in. Starting over issues fresh state.",
  },
  Configuration: {
    heading: "Sign-in is misconfigured on this deployment",
    body: "The identity provider settings this deployment needs are missing or invalid. This is an operator fault, not anything you did; reading the public site never needs an account.",
  },
  OAuthAccountNotLinked: {
    heading: "That Google account does not match this site's records",
    body: "Sponsors are identified by a stable digest of their Google account. If you signed in with a different Google account than the one bound here, sign out of Google and retry with the original one.",
  },
};

function describe(errorCode: string | undefined): { heading: string; body: string } {
  if (errorCode === undefined || errorCode === "") {
    return {
      heading: "The sign-in flow ended without completing",
      body: "No account was created and no session was issued. You can start the sign-in again from wherever you began.",
    };
  }
  return (
    KNOWN_ERRORS[errorCode] ?? {
      heading: "The sign-in flow reported a failure",
      body: "The provider returned an error code this page does not have specific wording for. It is shown below exactly as received so it can be correlated with server logs.",
    }
  );
}

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ readonly error?: string | readonly string[] }>;
}) {
  const raw = (await searchParams).error;
  const errorCode = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  const { heading, body } = describe(errorCode);

  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="meander" aria-hidden="true" />
      <main className="landing col console" id="content">
        <header className="masthead console-head">
          <p className="greek-sub" lang="el" aria-hidden="true">
            προπύλαιον
          </p>
          <h1 className="console-title">{heading}</h1>
          <p className="tagline">
            <Link href="/">← {SITE.name}</Link>
          </p>
          <div className="theme-toggle-row">
            <ThemeToggle />
          </div>
        </header>
        <p>{body}</p>
        {errorCode !== undefined && errorCode !== "" && (
          <p className="quiet">
            Error code: <code>{errorCode}</code>
          </p>
        )}
        <div className="auth-row btn-row">
          <Link className="btn-console" href="/console">
            Back to the console
          </Link>
          <Link className="btn-quiet" href="/">
            Front page
          </Link>
        </div>
      </main>
      <div className="meander flip" aria-hidden="true" />
    </>
  );
}
