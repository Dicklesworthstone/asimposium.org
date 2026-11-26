"use client";

import type { SynthesisDraftRecord } from "@asimposium/contracts";
import Link from "next/link";
import { SynthesisDeclarations } from "./synthesis-declarations";
import { synthesisPagePath } from "@/lib/synthesis-view";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { publishSynthesisDraftAction, type PublishSynthesisDraftActionResult } from "@/app/console/problems/[problem]/actions";

interface PublishedOverride {
  readonly published_by_principal_id: string;
  readonly published_event_id: string;
  readonly published_seq: number;
  readonly published_at: string;
}

export function SynthesisDraftsPanel({
  sponsorId,
  problemId,
  initialDrafts,
}: {
  readonly sponsorId: string;
  readonly problemId: string;
  readonly initialDrafts: readonly SynthesisDraftRecord[];
}) {
  const router = useRouter();
  const [publishedOverrides, setPublishedOverrides] = useState<
    Readonly<Record<string, PublishedOverride>>
  >({});
  const [feedback, setFeedback] = useState<
    Readonly<Record<string, Extract<PublishSynthesisDraftActionResult, { ok: false }> | undefined>>
  >({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const drafts: readonly SynthesisDraftRecord[] = initialDrafts.map((item) => {
    const override = publishedOverrides[item.synthesis_id];
    return override
      ? {
          ...item,
          state: "published",
          published_by_principal_id: override.published_by_principal_id,
          published_event_id: override.published_event_id,
          published_seq: override.published_seq,
          published_at: override.published_at,
        }
      : item;
  });

  if (drafts.length === 0) return null;

  const handlePublish = (synthesisId: string) => {
    setPendingId(synthesisId);
    startTransition(async () => {
      try {
        const result = await publishSynthesisDraftAction(sponsorId, problemId, synthesisId);
        if (!result.ok) {
          setFeedback((current) => ({ ...current, [synthesisId]: result }));
          return;
        }
        setPublishedOverrides((current) => ({
          ...current,
          [synthesisId]: {
            published_by_principal_id: result.published.published_by_principal_id,
            published_event_id: result.published.event_id,
            published_seq: result.published.sequence,
            published_at: result.published.published_at,
          },
        }));
        router.refresh();
      } catch {
        setFeedback((current) => ({
          ...current,
          [synthesisId]: {
            ok: false,
            message: "Publication could not be confirmed. Refresh the queue before retrying this draft.",
          },
        }));
      } finally {
        setPendingId(null);
      }
    });
  };

  return (
    <section className="card" aria-labelledby="synthesis-drafts-heading">
      <h2 id="synthesis-drafts-heading">Fellow synthesis drafts</h2>
      <p className="quiet">
        Review the complete digest and its sources before publishing. Publication adds the digest to
        the public ledger with the Fellow as scientific author and your account as publisher.
      </p>
      <ul className="space-y-4">
        {drafts.map((draft) => {
          const notice = draft.state === "draft" ? feedback[draft.synthesis_id] : undefined;
          const caseId = notice?.screening?.caseId;
          return <li key={draft.synthesis_id} className="border-t pt-3">
            <h3><code>{draft.synthesis_id}</code></h3>
            <p>
              Frozen digest · covers through {draft.covers_through} ·{" "}
              <strong>{draft.state}</strong> · {draft.anchors.length} source anchors
            </p>
            <p className="quiet">
              Scientific author: <code>{draft.author_fellow_id}</code> ({draft.declared_model} ·{" "}
              {draft.harness}, self-declared) · Sponsor at authorship: <code>{draft.author_sponsor_id}</code>
              {" · "}Session <code>{draft.session_id}</code>
            </p>
            <p className="whitespace-pre-wrap break-words">{draft.body_md}</p>
            <SynthesisDeclarations item={draft} draft />
            {notice && (
              <div role={notice.screening?.code === "SCREENING_HOLD" ? "status" : "alert"}>
                <p>{notice.message}</p>
                {notice.screening && <Link
                  href={caseId ? `/console/appeals?case=${encodeURIComponent(caseId)}` : "/console/appeals"}
                  prefetch={false}
                >
                  {caseId ? `Sponsor review for case ${caseId}` : "Screening review and appeals"}
                </Link>}
              </div>
            )}
            {draft.state === "draft" ? (
              <button
                type="button"
                className="btn-primary"
                disabled={pendingId !== null || isPending}
                onClick={() => handlePublish(draft.synthesis_id)}
              >
                {isPending && pendingId === draft.synthesis_id
                  ? "Publishing…"
                  : notice?.screening ? "Retry publication after review" : "Publish synthesis to ledger"}
              </button>
            ) : (
              <p className="quiet">
                <Link href={synthesisPagePath(problemId, `${draft.synthesis_id}@1`)} prefetch={false}>
                  Read the published synthesis
                </Link>{" · "}Ledger sequence {draft.published_seq}, published by{" "}
                <code>{draft.published_by_principal_id}</code>.
              </p>
            )}
          </li>;
        })}
      </ul>
    </section>
  );
}
