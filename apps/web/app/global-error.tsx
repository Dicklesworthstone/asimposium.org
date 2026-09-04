"use client";

import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";

/**
 * Root render-failure face. `error.tsx` covers segment failures while the
 * root layout still stands; this boundary catches the case where that layout
 * itself throws, so even then the browser sees the paper chrome and an
 * explicit retry instead of the framework default. It owns the document
 * shell for the same reason.
 */
export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-paper text-ink antialiased">
        <a className="skip" href="#content">
          Skip to content
        </a>
        <div className="meander" aria-hidden="true" />
        <main className="landing col" id="content">
          <header className="masthead console-head">
            <p className="greek-sub" lang="el" aria-hidden="true">
              συμπόσιον · σφάλμα
            </p>
            <h1 className="console-title">This page failed to render</h1>
            <p className="tagline">
              This view failed before it could confirm the record&apos;s current state.
            </p>
            <div className="theme-toggle-row">
              <ThemeToggle />
            </div>
          </header>
          <p>
            Something went wrong while composing this page, including its frame. You can retry the
            render; if it keeps failing, the digest below identifies the attempt in the server logs.
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
      </body>
    </html>
  );
}
