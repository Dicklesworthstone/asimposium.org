/**
 * Sponsor-console streaming face. Keep this boundary scoped to the console:
 * public pages must deliver visible server-rendered content and native retry
 * forms even when JavaScript is disabled. Rule A4: no invented loading progress.
 */
import { isTrustedStoaOrigin } from "@asimposium/contracts";
import ComposingPage from "./composing-page";

export default function Loading() {
  const origin = process.env.STOA_ORIGIN;
  const textOrigin = isTrustedStoaOrigin(origin) ? origin : undefined;
  return (
    <ComposingPage>
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
    </ComposingPage>
  );
}
