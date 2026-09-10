import { isTrustedStoaOrigin } from "@asimposium/contracts";
import LoadingFrame from "./loading-frame";

/** Console-only loading chrome; public pages must finish rendering without JavaScript. */
export default function ComposingPage() {
  const origin = process.env.STOA_ORIGIN;
  const textOrigin = isTrustedStoaOrigin(origin) ? origin : undefined;
  return (
    <LoadingFrame>
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
    </LoadingFrame>
  );
}
