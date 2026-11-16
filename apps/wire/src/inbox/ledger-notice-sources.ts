import { type SponsorInboxSourceRef, SponsorInboxSourceRefSchema } from "@asimposium/contracts";
import { eventContentHiddenSql } from "../krater/public-content.ts";
import { ledgerNoticeActions } from "./ledger-notice-actions.ts";

export interface LedgerNoticeSources {
  source_evidence_id: string | null;
  source_review_id: string | null;
  source_answer_reference: string | null;
}

/** Shared by Fellow actions and sponsor read references. The notice alias is
 * code-owned. A retained cause or matching projection is not enough: expose
 * only the exact same-problem, still-public, unwithdrawn publication. */
export function ledgerNoticeSourceSql(notice: string): Record<keyof LedgerNoticeSources, string> {
  const source = `FROM events e JOIN event_content c ON c.event_id = e.id
    JOIN problems p ON p.id = e.problem_id
    WHERE ${notice}.notice_type = 'object_critique'
      AND e.id = ${notice}.caused_by_event_id AND e.problem_id = ${notice}.problem_id
      AND e.object_version = 1 AND e.seq <= p.public_seq AND p.status <> 'private-draft'
      AND c.redacted_at IS NULL AND c.payload_sha256 = e.payload_sha256
      AND json_valid(c.payload_json)
      AND NOT ${eventContentHiddenSql("e")}
      AND NOT EXISTS (SELECT 1 FROM scientific_withdrawals retired WHERE retired.source_event_id = e.id)`;
  const payload = "CASE WHEN json_valid(c.payload_json) THEN c.payload_json ELSE '{}' END";
  return {
    source_evidence_id: `(SELECT e.object_id ${source}
      AND e.type = 'evidence.created' AND e.object_kind = 'evidence'
      AND ((json_extract(${payload}, '$.bears_on_kind') = 'claim'
        AND ${notice}.target_id = json_extract(${payload}, '$.bears_on_id') || '@' ||
          json_extract(${payload}, '$.bears_on_version'))
        OR (json_extract(${payload}, '$.bears_on_kind') = 'hypothesis'
          AND ${notice}.target_id = json_extract(${payload}, '$.bears_on_id')
          AND json_extract(${payload}, '$.bears_on_version') IS NULL)))`,
    source_review_id: `(SELECT e.object_id ${source}
      AND e.type = 'review.created' AND e.object_kind = 'review'
      AND ${notice}.target_id = json_extract(${payload}, '$.target_claim_id') || '@' ||
        json_extract(${payload}, '$.target_version'))`,
    source_answer_reference: `(SELECT json_extract(${payload}, '$.resolved_by_object') ${source}
      AND e.type = 'question.answered' AND e.object_kind = 'question'
      AND e.object_id = ${notice}.target_id
      AND json_extract(${payload}, '$.question_id') = ${notice}.target_id)`,
  };
}

export function ledgerNoticeSourceColumnsSql(notice: string): string {
  return Object.entries(ledgerNoticeSourceSql(notice))
    .map(([column, expression]) => `${expression} AS ${column}`)
    .join(",\n");
}

/** Re-evaluate each selected source in the final authority/visibility snapshot.
 * A hide, withdrawal, redaction or changed answer cannot race the response. */
export function ledgerNoticeSourcePinsSql(notice: string, pin: string): string {
  return Object.entries(ledgerNoticeSourceSql(notice))
    .map(([column, expression]) => `${expression} IS json_extract(${pin}.value, '$.${column}')`)
    .join(" AND ");
}

/** Reuse the Fellow's server-selected public reads, dropping the target's own
 * link. The sponsor gets canonical identities only, never an executable
 * next_action or an authored URL/reason. Human routes are built by the client. */
export function ledgerNoticeSourceRefs(
  noticeType: string,
  problemId: string | null,
  targetId: string | null,
  sources: LedgerNoticeSources,
): SponsorInboxSourceRef[] {
  if (noticeType !== "object_critique" || problemId === null) return [];
  const actions = ledgerNoticeActions(
    noticeType,
    problemId,
    targetId,
    null,
    sources.source_evidence_id,
    sources.source_review_id,
    sources.source_answer_reference,
  );
  const prefix = `/p/${problemId}/`;
  const references = new Set<SponsorInboxSourceRef>();
  for (const action of actions) {
    if (!action.url.startsWith(prefix)) continue;
    const match = /^(claims|evidence|reviews)\/([^/]+)\.json(?![\s\S])/.exec(
      action.url.slice(prefix.length),
    );
    const reference = SponsorInboxSourceRefSchema.safeParse(match?.[2]);
    if (!match || !reference.success || reference.data === targetId) continue;
    const segment = reference.data.startsWith("C-")
      ? "claims"
      : reference.data.startsWith("E-")
        ? "evidence"
        : "reviews";
    if (match[1] === segment) references.add(reference.data);
  }
  return [...references];
}
