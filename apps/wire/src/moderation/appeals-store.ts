import {
  APPEAL_STEP_UP_SECONDS,
  OperatorScreeningAppealsResponseSchema,
  type ScreeningAppealDecision,
  ScreeningAppealReceiptSchema,
  type ScreeningAppealRequest,
  SponsorScreeningCasesResponseSchema,
} from "@asimposium/contracts/appeals";
import type { D1Database } from "@cloudflare/workers-types";
import { inboxNoticeStatement } from "../inbox/notice-write";
import { canonicalJson, sha256Hex } from "../krater/krater";
import { mintModerationId } from "./store";

export class ScreeningAppealError extends Error {
  constructor(readonly code: "NOT_FOUND" | "CONFLICT" | "STEP_UP" | "REVIEWER") {
    super(`SCREENING_APPEAL_${code}`);
  }
}
interface AppealRow {
  appeal_id: string;
  case_id: string;
  sponsor_id: string;
  statement: string;
  request_digest: string;
  key_hash: string;
  submitted_at: string;
  state: "pending" | "released" | "upheld";
  decided_at: string | null;
  decided_by: string | null;
  decision_digest: string | null;
  decision_key_hash: string | null;
  audit_event_id: string | null;
}
const OWNED_CASE = `c.sponsor_id = ?1 AND f.sponsor_id = ?1 AND s.tombstoned_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = c.problem_id)`;
const JOIN_OWNER = `JOIN enrollment_fellows f ON f.fellow_id = c.fellow_id
  JOIN sponsors s ON s.sponsor_id = f.sponsor_id`;
function receipt(row: AppealRow) {
  return ScreeningAppealReceiptSchema.parse({
    appeal_id: row.appeal_id,
    case_id: row.case_id,
    state: row.state,
    submitted_at: row.submitted_at,
    decided_at: row.decided_at,
    audit_event_id: row.audit_event_id,
  });
}
async function keyDigest(key: string) {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(key)) throw new ScreeningAppealError("CONFLICT");
  return sha256Hex(key);
}
export async function sponsorScreeningCases(db: D1Database, sponsorId: string, caseId?: string) {
  const rows = await db
    .prepare(`SELECT c.*, a.appeal_id, a.state AS appeal_state,
    a.submitted_at, a.decided_at AS appeal_decided_at, a.audit_event_id
    FROM screening_cases c ${JOIN_OWNER}
    LEFT JOIN screening_case_appeals a ON a.case_id = c.case_id
    WHERE ${OWNED_CASE} AND (?2 IS NULL OR c.case_id = ?2)
    ORDER BY c.created_at DESC, c.case_id DESC LIMIT 51`)
    .bind(sponsorId, caseId ?? null)
    .all<Record<string, unknown>>();
  return SponsorScreeningCasesResponseSchema.parse({
    has_more: rows.results.length > 50,
    cases: rows.results.slice(0, 50).map((row) => ({
      case_id: row.case_id,
      problem_id: row.problem_id,
      fellow_id: row.fellow_id,
      route: row.route,
      state: row.state,
      created_at: row.created_at,
      appeal: row.appeal_id
        ? {
            appeal_id: row.appeal_id,
            case_id: row.case_id,
            state: row.appeal_state,
            submitted_at: row.submitted_at,
            decided_at: row.appeal_decided_at,
            audit_event_id: row.audit_event_id,
          }
        : null,
    })),
  });
}
export async function submitScreeningAppeal(
  db: D1Database,
  sponsorId: string,
  request: ScreeningAppealRequest,
  key: string,
) {
  const keyHash = await keyDigest(key),
    digest = await sha256Hex(canonicalJson(request));
  // Replays also recheck current ownership; old sponsorship cannot read an appeal.
  const owned = await db
    .prepare(`SELECT c.case_id FROM screening_cases c ${JOIN_OWNER}
    WHERE ${OWNED_CASE} AND c.case_id = ?2 AND c.state = 'rejected'`)
    .bind(sponsorId, request.case_id)
    .first();
  if (!owned) throw new ScreeningAppealError("NOT_FOUND");
  const prior = await db
    .prepare(`SELECT a.* FROM screening_case_appeals a
    JOIN screening_cases c ON c.case_id = a.case_id ${JOIN_OWNER}
    WHERE ${OWNED_CASE} AND a.sponsor_id = ?1 AND (a.key_hash = ?2 OR a.case_id = ?3)`)
    .bind(sponsorId, keyHash, request.case_id)
    .all<AppealRow>();
  if (prior.results.length) {
    const row = prior.results[0];
    if (
      !row ||
      prior.results.length !== 1 ||
      row.key_hash !== keyHash ||
      row.request_digest !== digest ||
      row.case_id !== request.case_id
    )
      throw new ScreeningAppealError("CONFLICT");
    return receipt(row);
  }
  const appealId = mintModerationId("AP");
  await db
    .prepare(`INSERT INTO screening_case_appeals
    (appeal_id,case_id,sponsor_id,statement,request_digest,key_hash,submitted_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
    .bind(
      appealId,
      request.case_id,
      sponsorId,
      request.statement,
      digest,
      keyHash,
      new Date().toISOString(),
    )
    .run();
  const row = await db
    .prepare(`SELECT a.* FROM screening_case_appeals a
    JOIN screening_cases c ON c.case_id = a.case_id ${JOIN_OWNER}
    WHERE ${OWNED_CASE} AND a.sponsor_id = ?1 AND a.key_hash = ?2`)
    .bind(sponsorId, keyHash)
    .first<AppealRow>();
  if (!row || row.case_id !== request.case_id || row.request_digest !== digest)
    throw new ScreeningAppealError("CONFLICT");
  return receipt(row);
}
export async function operatorScreeningAppeals(db: D1Database, appealId?: string) {
  const rows = await db
    .prepare(`SELECT a.*, c.problem_id, c.fellow_id, c.decided_by AS original_operator_id
    FROM screening_case_appeals a JOIN screening_cases c ON c.case_id = a.case_id
    ${JOIN_OWNER} WHERE ((?1 IS NULL AND a.state = 'pending') OR a.appeal_id = ?1) AND c.state = 'rejected'
      AND c.sponsor_id = a.sponsor_id AND f.sponsor_id = a.sponsor_id AND s.tombstoned_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = c.problem_id)
    ORDER BY a.submitted_at, a.appeal_id LIMIT 51`)
    .bind(appealId ?? null)
    .all<
      AppealRow & {
        problem_id: string;
        fellow_id: string;
        original_operator_id: string;
        route: string;
      }
    >();
  return OperatorScreeningAppealsResponseSchema.parse({
    has_more: rows.results.length > 50,
    appeals: rows.results.slice(0, 50).map((row) => ({
      ...receipt(row),
      sponsor_id: row.sponsor_id,
      fellow_id: row.fellow_id,
      problem_id: row.problem_id,
      statement: row.statement,
      original_operator_id: row.original_operator_id,
    })),
  });
}
export async function decideScreeningAppeal(
  db: D1Database,
  operatorId: string,
  request: ScreeningAppealDecision,
  key: string,
) {
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(request.step_up_authenticated_at) ||
    request.step_up_authenticated_at < 0 ||
    request.step_up_authenticated_at > now ||
    now - request.step_up_authenticated_at > APPEAL_STEP_UP_SECONDS
  )
    throw new ScreeningAppealError("STEP_UP");
  const keyHash = await keyDigest(key);
  // Authentication freshness is renewed on retry, not part of the durable intent.
  const digest = await sha256Hex(
    canonicalJson({
      appeal_id: request.appeal_id,
      decision: request.decision,
      reason: request.reason,
    }),
  );
  const row = await db
    .prepare(`SELECT a.*, c.fellow_id, c.problem_id, c.coarse_category, c.route,
    c.decided_by AS original_operator_id FROM screening_case_appeals a
    JOIN screening_cases c ON c.case_id = a.case_id ${JOIN_OWNER}
    WHERE a.appeal_id = ? AND c.state = 'rejected' AND c.sponsor_id = a.sponsor_id
      AND f.sponsor_id = a.sponsor_id AND s.tombstoned_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM private_draft_erasures e WHERE e.problem_id = c.problem_id)`)
    .bind(request.appeal_id)
    .first<
      AppealRow & {
        fellow_id: string;
        problem_id: string;
        coarse_category: string;
        original_operator_id: string;
        route: string;
      }
    >();
  if (!row) throw new ScreeningAppealError("NOT_FOUND");
  if (operatorId === row.sponsor_id || operatorId === row.original_operator_id)
    throw new ScreeningAppealError("REVIEWER");
  if (row.state !== "pending") {
    if (
      row.decision_digest !== digest ||
      row.decision_key_hash !== keyHash ||
      row.decided_by !== operatorId
    )
      throw new ScreeningAppealError("CONFLICT");
    return receipt(row);
  }
  const at = new Date().toISOString(),
    auditId = mintModerationId("OA");
  const state = request.decision === "release" ? "released" : "upheld";
  const guard =
    "EXISTS(SELECT 1 FROM screening_case_appeals WHERE appeal_id = ? AND audit_event_id = ?)";
  await db.batch([
    db
      .prepare(`UPDATE screening_case_appeals SET state = ?, decided_at = ?, decided_by = ?,
      decision_reason = ?, decision_key_hash = ?, decision_digest = ?, audit_event_id = ?
      WHERE appeal_id = ? AND state = 'pending'`)
      .bind(state, at, operatorId, request.reason, keyHash, digest, auditId, row.appeal_id),
    db
      .prepare(`INSERT INTO operator_audit (event_id,seq,operator_id,action,target_id,reason,
      before_state_digest,after_state_digest,created_at)
      SELECT ?, (SELECT COALESCE(MAX(seq),0)+1 FROM operator_audit), ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`)
      .bind(
        auditId,
        operatorId,
        `screening-appeal.${request.decision}`,
        row.appeal_id,
        request.reason,
        await sha256Hex(canonicalJson({ appeal: row.appeal_id, state: "pending" })),
        await sha256Hex(canonicalJson({ appeal: row.appeal_id, state })),
        at,
        row.appeal_id,
        auditId,
      ),
    db
      .prepare(`INSERT INTO moderation_log(entry_id,seq,action,category,subject,problem_id,created_at)
      SELECT ?, (SELECT COALESCE(MAX(seq),0)+1 FROM moderation_log), ?, ?, 'candidate',
      (SELECT id FROM problems WHERE id = ? AND status <> 'private-draft' AND unlisted=0 AND public_seq>0), ?
      WHERE ${guard}`)
      .bind(
        mintModerationId("ML"),
        state === "released" ? "released" : "rejected",
        row.coarse_category,
        row.problem_id,
        at,
        row.appeal_id,
        auditId,
      ),
    await inboxNoticeStatement(
      db,
      {
        fellowId: row.fellow_id,
        problemId: row.problem_id,
        noticeType: "moderation_outcome",
        title:
          state === "released"
            ? "A screening appeal was released"
            : "A screening appeal was upheld",
        detail:
          state === "released"
            ? row.route === "artifact-publications"
              ? `Case ${row.case_id}: the sponsor's appeal approved the held artifact. Read its publication status and use its recovery action with a current owned session. Fresh consent and unchanged sources are required before publication.`
              : `Case ${row.case_id}: the sponsor's appeal was released. Resubmit exactly the original request to publish after the current authorization and context checks. No content was published by the appeal.`
            : `Case ${row.case_id}: a different reviewer upheld the rejection after considering the sponsor's appeal. No content was published.`,
        causedByEventId: auditId,
        targetId: row.case_id,
        createdAt: Date.parse(at),
      },
      { sql: guard, bindings: [row.appeal_id, auditId] },
    ),
  ]);
  const decided = await db
    .prepare("SELECT * FROM screening_case_appeals WHERE appeal_id = ?")
    .bind(row.appeal_id)
    .first<AppealRow>();
  if (
    !decided ||
    decided.decision_digest !== digest ||
    decided.decided_by !== operatorId ||
    decided.decision_key_hash !== keyHash
  )
    throw new ScreeningAppealError("CONFLICT");
  return receipt(decided);
}
