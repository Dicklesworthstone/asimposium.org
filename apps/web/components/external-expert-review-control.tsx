"use client";

import {
  ExternalExpertReviewCreateRequestSchema,
  type ExternalExpertReviewCreateRequest,
  type ExternalExpertReviewRecord,
} from "@asimposium/contracts";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  recordExternalReviewAction,
  type RecordExternalReviewActionResult,
} from "@/app/admin/external-reviews/actions";
import {
  clearPendingExternalReview,
  createPendingExternalReview,
  externalReviewRecoveryKey,
  parseExternalReviewBoundary,
  parsePendingExternalReview,
  persistPendingExternalReview,
  serializeExternalReviewRequest,
  type PendingExternalReview,
} from "@/lib/external-expert-review-recovery";

function Items({ items }: { readonly items: readonly string[] }) {
  return <ul>{items.map((item, index) => <li key={index} style={{ whiteSpace: "pre-wrap" }}>{item}</li>)}</ul>;
}

function attestationHref(locator: string): string | undefined {
  if (locator.startsWith("doi:10.")) return "https://doi.org/" + encodeURIComponent(locator.slice(4));
  try {
    const url = new URL(locator);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.href : undefined;
  } catch { return undefined; }
}

export function ExternalReviewContent({
  problemId, input,
}: { readonly problemId: string; readonly input: ExternalExpertReviewCreateRequest }) {
  const target = input.claim_id + "@" + input.claim_version;
  const source = attestationHref(input.attestation_locator);
  return <div>
    <dl>
      <dt>Exact reviewed claim</dt><dd><Link href={"/p/" + encodeURIComponent(problemId) + "/claims/" + encodeURIComponent(target)} prefetch={false}>{problemId}/{target}</Link></dd>
      <dt>External reviewer</dt><dd>{input.reviewer.name} · {input.reviewer.affiliation}</dd>
      <dt>Reviewer identifier</dt><dd>{input.reviewer.identifier}</dd>
      <dt>Verdict</dt><dd><strong>{input.verdict}</strong></dd>
      <dt>Review date</dt><dd><time dateTime={input.reviewed_at}>{input.reviewed_at}</time></dd>
      <dt>Permanent attestation reference</dt><dd>{source === undefined
        ? <code>{input.attestation_locator}</code>
        : <a href={source} rel="noreferrer">{input.attestation_locator}</a>}</dd>
      <dt>Attestation SHA-256</dt><dd className="break-words"><code>{input.attestation_sha256}</code></dd>
    </dl>
    <h4>What was verified</h4><Items items={input.no_claim_boundary.verified} />
    <h4>Verification mechanisms</h4><Items items={input.no_claim_boundary.mechanisms} />
    <h4>Independence tiers</h4><Items items={input.no_claim_boundary.independence_tiers} />
    <h4>Remaining external validation</h4><Items items={input.no_claim_boundary.remaining_external_validation} />
  </div>;
}

export function ExternalExpertReviewRecordView({ record }: { readonly record: ExternalExpertReviewRecord }) {
  return <article className="card" aria-label={"External review " + record.review_record_id}>
    <h3><code>{record.review_record_id}</code></h3>
    <p>{record.revoked_at === null ? "No revocation was recorded at this read." : "Revoked at " + record.revoked_at + "."}</p>
    <ExternalReviewContent problemId={record.problem_id} input={record} />
    <dl>
      <dt>Claim content digest at recording</dt><dd className="break-words"><code>{record.claim_content_digest}</code></dd>
      <dt>Recording operator</dt><dd><code>{record.verified_by_operator_id}</code></dd>
      <dt>Recorded at</dt><dd><time dateTime={record.created_at}>{record.created_at}</time></dd>
    </dl>
    <p>This record does not resolve the problem or change scientific standing. A sponsor may reference its identifier with the exact published closing synthesis; Stoa rechecks admission.</p>
  </article>;
}

/** Keep the attestation and retry key together until its authoritative outcome is known. */
export function ExternalExpertReviewControl({
  operatorId, problemId, canChange, historyAvailable, returnPath,
}: {
  readonly operatorId: string;
  readonly problemId: string;
  readonly canChange: boolean;
  readonly historyAvailable: boolean;
  readonly returnPath: string;
}) {
  const [draft, setDraft] = useState<ExternalExpertReviewCreateRequest | null>(null);
  const [formInput, setFormInput] = useState<ExternalExpertReviewCreateRequest | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<PendingExternalReview | null>(null);
  const [result, setResult] = useState<RecordExternalReviewActionResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, startTransition] = useTransition();
  const lock = useRef(false);
  const disabled = !ready || !canChange || !historyAvailable || pending || attempt !== null || result?.ok === true;

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const raw = sessionStorage.getItem(externalReviewRecoveryKey(operatorId, problemId));
        setAttempt(raw === null ? null : parsePendingExternalReview(raw, operatorId, problemId));
        setReady(true);
      } catch {
        setMessage("The browser could not recover valid pending review details. No new record will be sent. Inspect recorded reviews and reload under the same operator account.");
      }
    });
    return () => { cancelled = true; };
  }, [operatorId, problemId]);

  function send(saved: PendingExternalReview) {
    if (lock.current || !ready || !canChange || saved.operatorId !== operatorId ||
        saved.problemId !== problemId) return;
    try {
      persistPendingExternalReview(sessionStorage, saved);
    } catch {
      setMessage("The exact attestation and retry key could not be retained. Nothing was sent; recover any pending review before retrying.");
      return;
    }
    lock.current = true;
    setAttempt(saved);
    setMessage(null);
    startTransition(async () => {
      try {
        const reply = await recordExternalReviewAction(operatorId, problemId, saved.input, saved.key, true);
        setResult(reply);
        if (reply.ok || !reply.retainAttempt) {
          clearPendingExternalReview(sessionStorage, saved);
          setAttempt(null);
          setDraft(null);
          setConfirmed(false);
        }
      } catch {
        setMessage("The reply or local recovery cleanup could not be confirmed. Keep the displayed receipt if one arrived, and recover this unchanged command before recording another review.");
      } finally {
        lock.current = false;
      }
    });
  }

  function reviewForm(data: FormData) {
    if (disabled || lock.current) return;
    const text = (name: string) => String(data.get(name) ?? "");
    const boundary = parseExternalReviewBoundary(text("no_claim_boundary"));
    if (boundary === null) {
      setMessage("Enter the exact no-claim boundary as JSON with all four arrays. Preserve the published wording, embedded newlines, and item order; do not add fields. The input limit is 128,000 characters.");
      return;
    }
    let reviewedAt = "";
    try { reviewedAt = new Date(text("reviewed_at") + "Z").toISOString(); } catch { /* Schema teaches below. */ }
    const parsed = ExternalExpertReviewCreateRequestSchema.safeParse({
      claim_id: text("claim_id"), claim_version: Number(text("claim_version")),
      reviewer: { name: text("reviewer_name"), affiliation: text("reviewer_affiliation"), identifier: text("reviewer_identifier") },
      attestation_locator: text("attestation_locator"), attestation_sha256: text("attestation_sha256"),
      verdict: text("verdict"), reviewed_at: reviewedAt,
      no_claim_boundary: boundary,
    });
    if (!parsed.success) {
      setMessage("Complete every field with an exact claim version, an HTTPS or DOI attestation reference, its 64-character lowercase SHA-256 digest, and at least one item per boundary section (up to 500 characters per item; 50 per independence tier).");
      return;
    }
    if (serializeExternalReviewRequest(parsed.data) === null) {
      setMessage("The complete attestation exceeds the 64 KiB signed-request limit. Nothing was sent or saved for retry. Select a closing synthesis whose complete boundary fits; do not truncate or rewrite its scientific limits here.");
      return;
    }
    setDraft(parsed.data);
    setFormInput(parsed.data);
    setConfirmed(false);
    setResult(null);
    setMessage(null);
  }

  return <section className="card" aria-labelledby="record-external-review">
    <h2 id="record-external-review">Record a checked external expert attestation</h2>
    <p>Inspect the source yourself before recording it. This form records your verification of its attribution and exact scope; ASImposium does not fetch or independently validate the external attestation.</p>
    {!canChange && <p role="alert">Recent operator authentication is required. Re-authenticate below, then recover or review the same attestation.</p>}
    {message !== null && <p role="alert">{message}</p>}
    {result !== null && (result.ok
      ? <div role="status"><p>{result.record.revoked_at === null
        ? "External review recorded. Give the exact EER identifier to the accountable sponsor."
        : "The recorded review was recovered with a revocation. It cannot authorize resolution."}</p><ExternalExpertReviewRecordView record={result.record} /></div>
      : <p role="alert">{result.message}</p>)}
    {attempt !== null ? <div>
      <h3>Pending attestation</h3>
      <p>The exact submitted review is retained in this browser tab for receipt recovery. New records remain paused while its outcome is unknown.</p>
      <ExternalReviewContent problemId={problemId} input={attempt.input} />
      <button type="button" className="btn-action" disabled={!canChange || !ready || pending || result?.ok === true}
        onClick={() => send(attempt)}>Recover this unchanged attestation</button>
    </div> : draft !== null ? <div>
      <h3>Review the exact attestation to be recorded</h3>
      <ExternalReviewContent problemId={problemId} input={draft} />
      <fieldset disabled={disabled}>
        <legend>Confirm your source check</legend>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I inspected the external source, checked its digest and reviewer attribution, and confirm the displayed verdict and complete scope without claiming a scientific override.</label>
        <button type="button" className="btn-action" disabled={!confirmed} onClick={() => {
          if (!confirmed || disabled || lock.current) return;
          send(createPendingExternalReview(operatorId, problemId, draft, "external-review-" + crypto.randomUUID()));
        }}>Record this exact attestation</button>
        <button type="button" className="btn-quiet" onClick={() => { setDraft(null); setConfirmed(false); }}>Edit before recording</button>
      </fieldset>
    </div> : result?.ok !== true && <form onSubmit={(event) => { event.preventDefault(); reviewForm(new FormData(event.currentTarget)); }}>
      <fieldset disabled={disabled}>
        <legend>External review of one exact claim version</legend>
        <label>Claim identifier<input name="claim_id" defaultValue={formInput?.claim_id ?? ""} required maxLength={47} placeholder="C-1" /></label>
        <label>Claim version<input name="claim_version" defaultValue={formInput?.claim_version ?? ""} type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} required /></label>
        <label>Reviewer name<input name="reviewer_name" defaultValue={formInput?.reviewer.name ?? ""} required maxLength={200} /></label>
        <label>Reviewer affiliation<input name="reviewer_affiliation" defaultValue={formInput?.reviewer.affiliation ?? ""} required maxLength={240} /></label>
        <label>Reviewer identifier<input name="reviewer_identifier" defaultValue={formInput?.reviewer.identifier ?? ""} required maxLength={240} /></label>
        <label>Permanent attestation URL or DOI<input name="attestation_locator" defaultValue={formInput?.attestation_locator ?? ""} required minLength={8} maxLength={1024} placeholder="https://… or doi:10.…" /></label>
        <label>Attestation SHA-256<input name="attestation_sha256" defaultValue={formInput?.attestation_sha256 ?? ""} required minLength={64} maxLength={64} pattern="[a-f0-9]{64}" autoComplete="off" spellCheck={false} /></label>
        <label>Verdict<select name="verdict" defaultValue={formInput?.verdict ?? "withheld"}>
          <option value="withheld">Withheld</option><option value="supports-resolution">Supports resolution</option><option value="rejects-resolution">Rejects resolution</option>
        </select></label>
        <label>Review date and time (UTC)<input name="reviewed_at" defaultValue={formInput?.reviewed_at.slice(0, 19) ?? ""} type="datetime-local" step={1} required /></label>
        <p>Copy the exact no_claim_boundary object from the reviewed closing synthesis. JSON preserves each item's wording, embedded newlines and order. The readable confirmation follows; the Worker checks exact agreement when resolution is requested.</p>
        <label>Exact no-claim boundary (JSON)<textarea name="no_claim_boundary"
          defaultValue={formInput === null ? "" : JSON.stringify(formInput.no_claim_boundary, null, 2)}
          rows={12} required maxLength={128_000} spellCheck={false}
          placeholder={'{"verified":["…"],"mechanisms":["…"],"independence_tiers":["T2"],"remaining_external_validation":["…"]}'} /></label>
        <button type="submit" className="btn-quiet">Review attestation before recording</button>
      </fieldset>
    </form>}
    <p><a href={returnPath}>Reload recorded reviews</a> · <Link href={"/console/problems/" + encodeURIComponent(problemId)} prefetch={false}>Open sponsor result controls</Link></p>
  </section>;
}
