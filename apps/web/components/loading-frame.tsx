import type { ReactNode } from "react";

/** Loading chrome for the console; never a public route streaming boundary.
 * Uses `<section>` rather than a second `<main id="content">` or skip link so
 * `/console` rendered without JavaScript never duplicates landmarks or IDs
 * beside the streamed page markup. */
export default function LoadingFrame({ children }: { readonly children?: ReactNode }) {
  return (
    <section
      className="landing col console loading-frame"
      role="status"
      aria-live="polite"
      aria-labelledby="loading-frame-title"
    >
      <header className="masthead console-head">
        <h1 className="console-title" id="loading-frame-title">
          Composing this page
        </h1>
        <p className="tagline">
          This view has not yet confirmed the record&apos;s current state.
        </p>
      </header>
      <p className="quiet">
        Reads are in flight; this page renders when they answer or report refusal.
      </p>
      {children}
    </section>
  );
}
