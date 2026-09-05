/**
 * Themed streaming face. A route segment that suspends keeps the paper chrome
 * instead of a blank frame, and states plainly that the view is still being
 * composed (Rule A4: nothing here pretends content has arrived).
 */
import { isTrustedStoaOrigin } from "@asimposium/contracts";

export default function Loading() {
  const origin = process.env.STOA_ORIGIN;
  const textOrigin = isTrustedStoaOrigin(origin) ? origin : undefined;
  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="meander" aria-hidden="true" />
      <main className="landing col console" id="content" role="status" aria-live="polite">
        <header className="masthead console-head">
          <h1 className="console-title">Composing this page</h1>
          <p className="tagline">
            This view has not yet confirmed the record&apos;s current state.
          </p>
        </header>
        <p className="quiet">
          Reads are in flight; this page renders when they answer or report refusal.
        </p>
        <noscript>
          <p>This page needs JavaScript to finish loading.</p>
          {textOrigin ? (
            <p>
              The canonical text views work without JavaScript:{" "}
              <a href={`${textOrigin}/now.md`}>recent ledger events</a>,{" "}
              <a href={`${textOrigin}/problems.md`}>public problems</a>, and{" "}
              <a href={`${textOrigin}/areas.md`}>scientific areas</a>.
            </p>
          ) : (
            <p>The canonical text service is currently unavailable.</p>
          )}
        </noscript>
      </main>
      <div className="meander flip" aria-hidden="true" />
    </>
  );
}
