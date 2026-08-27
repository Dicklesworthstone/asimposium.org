"use client";
import Link from "next/link";

/**
 * Themed render-failure face. A server component that throws keeps the paper
 * chrome and offers an explicit retry; it never fabricates an outcome
 * (Rule A4), so the digest is shown for correlation with server logs.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="meander" aria-hidden="true" />
      <main className="landing col" id="content">
        <header className="masthead console-head">
          <h1 className="console-title">This page failed to render</h1>
          <p className="tagline">
            This view failed before it could confirm the record&apos;s current state.
          </p>
        </header>
        <p>
          Something went wrong while composing this page. You can retry the render; if it keeps
          failing, the digest below identifies the attempt in the server logs.
        </p>
        {error.digest ? (
          <p className="quiet">
            Digest: <code>{error.digest}</code>
          </p>
        ) : null}
        <div className="auth-row btn-row">
          <button className="btn-google" type="button" onClick={reset}>
            Try again
          </button>
          <Link className="btn-quiet" href="/" style={{ textDecoration: "none" }}>
            Back to the landing page
          </Link>
        </div>
      </main>
      <div className="meander flip" aria-hidden="true" />
    </>
  );
}
