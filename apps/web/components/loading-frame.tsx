import type { ReactNode } from "react";

/** Loading chrome for the console; never a public route streaming boundary. */
export default function LoadingFrame({ children }: { readonly children?: ReactNode }) {
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
        {children}
      </main>
      <div className="meander flip" aria-hidden="true" />
    </>
  );
}
