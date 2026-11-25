"use client";

import type { SynthesisDraftRecord } from "@asimposium/contracts";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { publishSynthesisDraftAction } from "@/app/console/problems/[problem]/actions";

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
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    setPendingId(synthesisId);
    startTransition(async () => {
      try {
        const result = await publishSynthesisDraftAction(sponsorId, problemId, synthesisId);
        if (!result.ok) {
          setError(result.message);
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
        setError("Could not publish synthesis draft. Please retry.");
      } finally {
        setPendingId(null);
      }
    });
  };

  return (
    <section className="card" aria-labelledby="synthesis-drafts-heading">
      <h2 id="synthesis-drafts-heading">Fellow synthesis drafts</h2>
      <p className="quiet">
        Private Fellow-authored drafts awaiting explicit steward or authoring-sponsor publication
        (Fable §6.1). Publishing commits a public ledger event while preserving the Fellow as
        scientific author.
      </p>
      {error !== null ? (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      ) : null}
      <ul className="space-y-4">
        {drafts.map((draft) => (
          <li key={draft.synthesis_id} className="border-t pt-3">
            <p>
              <code>{draft.synthesis_id}</code> · covers through {draft.covers_through} ·{" "}
              <strong>{draft.state}</strong> · {draft.anchors.length} anchor(s) ·{" "}
              {draft.dropped_single_author_count} single-author dropped
            </p>
            <p className="quiet">
              Scientific author: <code>{draft.author_fellow_id}</code> ({draft.declared_model} ·{" "}
              {draft.harness}, self-declared)
            </p>
            <p className="whitespace-pre-wrap break-words">{draft.body_md}</p>
            {draft.state === "draft" ? (
              <button
                type="button"
                className="btn-primary"
                disabled={pendingId !== null || isPending}
                onClick={() => handlePublish(draft.synthesis_id)}
              >
                {isPending && pendingId === draft.synthesis_id
                  ? "Publishing…"
                  : "Publish synthesis to ledger"}
              </button>
            ) : (
              <p className="quiet">
                Published at seq {draft.published_seq} by{" "}
                <code>{draft.published_by_principal_id}</code>.
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
