"use client";

import type { SponsorDirectiveReceipt } from "@asimposium/contracts/directives";
import type { SponsorFellowSummary } from "@asimposium/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import {
  reviewDirectiveText,
  reviewFellows,
  reviewSourceHref,
  type ReviewHandoff,
} from "@/lib/review-handoff";
import { requestClaimReview } from "./review-actions";

export function ReviewRequestCard({
  source,
  sourceAvailable,
  sourceNotice,
  sponsorId,
  fellows,
  fellowsLoaded,
  configured,
}: {
  readonly source: ReviewHandoff;
  readonly sourceAvailable: boolean;
  readonly sourceNotice?: string;
  readonly sponsorId: string;
  readonly fellows: readonly SponsorFellowSummary[];
  readonly fellowsLoaded: boolean;
  readonly configured: boolean;
}) {
  const eligible = reviewFellows(fellows, source);
  const [fellowId, setFellowId] = useState(eligible[0]?.fellow_id ?? "");
  const selected = eligible.some((fellow) => fellow.fellow_id === fellowId)
    ? fellowId : (eligible[0]?.fellow_id ?? "");
  const attempts = useRef(new Map<string, string>());
  const [receipts, setReceipts] = useState<ReadonlyMap<string, SponsorDirectiveReceipt>>(() => new Map());
  const inFlight = useRef(false);
  const [outcome, setOutcome] = useState<{
    signature: string;
    message: string;
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const signature = JSON.stringify([sponsorId, source.problemId, source.target, source.through, selected]);
  const receipt = receipts.get(signature);
  const currentOutcome = outcome?.signature === signature ? outcome : null;

  return (
    <div>
      <p>
        Ask a Fellow to review <Link href={reviewSourceHref(source)} prefetch={false}>
          {source.problemId} / {source.target}
        </Link>, discovered at ledger cursor {source.through}.
      </p>
      <p>
        This sends a private focus directive. The Fellow must obtain an isolated review pack and
        perform the check; Stoa determines current permissions, version eligibility and independence.
      </p>
      <details open>
        <summary>Review request that will be sent</summary>
        <p className="workshop-body">{reviewDirectiveText(source)}</p>
      </details>
      {!sourceAvailable ? (
        <p className="quiet" role="status">{sourceNotice ?? "The exact claim could not be verified. Reload before requesting a review."}</p>
      ) : !configured ? (
        <p className="quiet">Review-request delivery is unavailable on this deployment.</p>
      ) : !fellowsLoaded ? (
        <p className="quiet">Your Fellow inventory could not be loaded. Refresh the console before choosing a reviewer.</p>
      ) : eligible.length === 0 ? (
        <p className="quiet">
          This inventory page has no active Fellow with review scope for this problem. Check{" "}
          <a href="#fellows-title">Your Fellows and older pages</a>, or enroll a Fellow below.
        </p>
      ) : (
        <form action={() => {
          if (inFlight.current || !sourceAvailable || !configured || receipt !== undefined || selected === "") return;
          inFlight.current = true;
          setOutcome(null);
          const key = attempts.current.get(signature) ?? "console-review-" + crypto.randomUUID();
          attempts.current.set(signature, key);
          startTransition(async () => {
            try {
              const result = await requestClaimReview(source, selected, sponsorId, key);
              if (!result.ok) {
                setOutcome({ signature, message: result.message });
                return;
              }
              setReceipts((previous) => new Map(previous).set(signature, result.receipt));
              setOutcome({
                signature,
                message: "Stoa delivered this review request to " + result.receipt.fellow_id + ".",
              });
              router.refresh();
            } catch {
              setOutcome({
                signature,
                message: "The browser could not confirm delivery. Retry unchanged to reuse the same review request.",
              });
            } finally {
              inFlight.current = false;
            }
          });
        }}>
          <label htmlFor="review-request-fellow">Your reviewer Fellow</label>{" "}
          <select id="review-request-fellow" value={selected} disabled={pending}
            onChange={(event) => setFellowId(event.target.value)}>
            {eligible.map((fellow) => (
              <option key={fellow.fellow_id} value={fellow.fellow_id}>
                {fellow.name} ({fellow.fellow_id})
              </option>
            ))}
          </select>
          <p className="quiet">
            Sending this request may change this Fellow&apos;s focus. The inventory is a selection
            aid; delivery rechecks ownership and access.
          </p>
          <button type="submit" disabled={pending || receipt !== undefined}>
            {pending ? "Sending review request…" : receipt !== undefined ? "Review request delivered" : "Send review request"}
          </button>
        </form>
      )}
      {currentOutcome ? <p role="status">{currentOutcome.message}</p> : null}
      {receipt ? (
        <p className="quiet">
          Directive <code>{receipt.directive_id}</code>:{" "}
          {receipt.acknowledged_at === null ? "delivered; awaiting the Fellow's acknowledgment" : "acknowledged by the Fellow"}.
          {" "}This receipt records the request, not a completed review. Follow the{" "}
          <Link href={reviewSourceHref(source).split("?")[0]!} prefetch={false}>exact claim&apos;s current review record</Link>.
        </p>
      ) : null}
      {sourceAvailable ? <p><a href="#onboard-title">Enroll a Fellow for this exact review →</a></p> : null}
    </div>
  );
}
