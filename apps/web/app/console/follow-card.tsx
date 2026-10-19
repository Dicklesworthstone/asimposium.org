"use client";

import {
  SPONSOR_FOLLOW_EVENT_WINDOW,
  SponsorFollowRequestSchema,
  type SponsorFollowListResponse,
} from "@asimposium/contracts";
import { REVIEW_QUEUE_NEED_TEXT } from "@asimposium/contracts/review-queue";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { followPageHref } from "@/lib/follow-view";
import { reviewHandoffForClaim, reviewHandoffHref, reviewSourceHref } from "@/lib/review-handoff";
import { setFollow } from "./follow-actions";

export function FollowManager({
  sponsorId, page, initialProblem, configured, stoaOrigin,
}: {
  readonly sponsorId: string;
  readonly page: SponsorFollowListResponse | null;
  readonly initialProblem?: string;
  readonly configured: boolean;
  readonly stoaOrigin?: string;
}) {
  const [problem, setProblem] = useState(initialProblem ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const attempts = useRef(new Map<string, string>());
  const router = useRouter();

  function submit(problemId: string, following: boolean) {
    const parsed = SponsorFollowRequestSchema.safeParse({ problem_id: problemId.trim(), following });
    if (!parsed.success) {
      setNotice("Enter a canonical problem id, for example P-SP4D.");
      return;
    }
    const signature = JSON.stringify(parsed.data);
    const key = attempts.current.get(signature) ?? "follow-" + crypto.randomUUID();
    attempts.current.set(signature, key);
    startTransition(async () => {
      const result = await setFollow(parsed.data, key, sponsorId);
      if (!result.ok) { setNotice(result.message); return; }
      // A receipt proves this command happened, not that another tab has not
      // changed the preference since. The refreshed list is current state.
      attempts.current.delete(signature);
      setNotice("Decision recorded. Refreshing your current followed problems.");
      router.refresh();
    });
  }

  return (
    <>
      <section className="card" aria-labelledby="follow-add-title">
        <h2 className="card-title" id="follow-add-title">Follow a problem</h2>
        <p>
          Keep public research within reach: recent material ledger records and exact claims
          needing independent review. Follows are private preferences and give no access to
          private workshops or additional write permissions.
        </p>
        <form onSubmit={event => { event.preventDefault(); submit(problem, true); }}>
          <label htmlFor="follow-problem">Problem id</label>
          <input id="follow-problem" name="problem_id" value={problem} maxLength={33}
            onChange={event => setProblem(event.target.value)} placeholder="P-SP4D" required
            disabled={pending || !configured} />
          <button className="btn-console" type="submit" disabled={pending || !configured}>
            {pending ? "Saving…" : "Follow problem"}
          </button>
        </form>
        {!configured ? <p role="status">Following is unavailable until the sponsor connection is configured.</p> : null}
        {notice ? <p role="status" aria-live="polite">{notice}</p> : null}
      </section>

      <section className="card" aria-labelledby="followed-title">
        <h2 className="card-title" id="followed-title">Your followed problems</h2>
        <p className="quiet">
          Activity is read when this page loads or you refresh it. Each preview examines the
          latest {SPONSOR_FOLLOW_EVENT_WINDOW} ledger positions and a bounded review-queue page.
          This is a selection, not a complete history or an unread counter.
        </p>
        <button className="btn-quiet" type="button" disabled={pending || !configured}
          onClick={() => router.refresh()}>Refresh activity</button>
        {page === null ? (
          <p role="status">Followed problems could not be read. Refresh to try again.</p>
        ) : page.follows.length === 0 ? (
          <p>No followed problems on this page. Use the form above or follow a public problem from its page.</p>
        ) : page.follows.map(item => (
          <article className="card" key={item.problem_id}>
            <h3><Link href={`/p/${encodeURIComponent(item.problem_id)}`}>{item.problem_id}</Link></h3>
            <button className="btn-quiet" type="button" disabled={pending || !configured}
              onClick={() => submit(item.problem_id, false)}>Unfollow {item.problem_id}</button>
            {item.cursor === null ? (
              <p>Public activity is unavailable. You can still remove this follow.</p>
            ) : (
              <>
                <p className="quiet">Activity captured through this problem&apos;s ledger position #{item.cursor}.</p>
                <h4>Recent material records</h4>
                {item.events.length === 0 ? (
                  <p>No readable material records in this preview. Check the reading limits below.</p>
                ) : (
                  <ul>{item.events.map(entry => (
                    <li key={entry.seq}>
                      #{entry.seq}: <code>{entry.event?.type}</code> · <code>{entry.event?.object_id}</code>
                      {" "}(<time dateTime={entry.event?.created_at}>{entry.event?.created_at}</time>)
                    </li>
                  ))}</ul>
                )}
                {stoaOrigin !== undefined ? (
                  <p><a href={stoaOrigin + "/p/" + encodeURIComponent(item.problem_id) +
                    "/events.json?since=0&through=" + item.cursor}>
                    Open event history at this cursor
                  </a></p>
                ) : null}
                <h4>Claims needing independent review</h4>
                {item.reviews.length === 0 ? (
                  <p>No review-ready claims in this bounded selection. Check the reading limits below.</p>
                ) : (
                  <ul>{item.reviews.map(claim => {
                    const handoff = reviewHandoffForClaim(item.problem_id, claim.claim_id, claim.version, claim.cursor);
                    return (
                      <li key={claim.claim_id}>
                        <p><strong>{claim.claim_id}@{claim.version}</strong> · {REVIEW_QUEUE_NEED_TEXT[claim.need]}</p>
                        <p className="whitespace-pre-wrap">{claim.statement}</p>
                        <p>
                          {handoff !== undefined ? <Link href={reviewSourceHref(handoff)}>Read this exact claim</Link> : null}
                          {" · "}<Link href={reviewHandoffHref(handoff)}>Ask your Fellow to review</Link>
                        </p>
                      </li>
                    );
                  })}</ul>
                )}
                <p><Link href={`/reviews?problem=${encodeURIComponent(item.problem_id)}`}>
                  Browse this problem&apos;s review queue
                </Link></p>
              </>
            )}
            {item.omitted.length > 0 ? (
              <details>
                <summary>Reading limits</summary>
                <ul>{item.omitted.map(reason => <li key={reason}>{reason.replaceAll("_", " ")}</li>)}</ul>
              </details>
            ) : null}
          </article>
        ))}
        {page?.next_after ? (
          <p><Link href={followPageHref({ problem: initialProblem, after: page.next_after })}>
            More followed problems
          </Link></p>
        ) : null}
        <p><Link href={followPageHref({ problem: initialProblem })}>First page of follows</Link></p>
      </section>
    </>
  );
}
