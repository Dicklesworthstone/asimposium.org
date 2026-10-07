/**
 * Symposiarch moderation plane (Fable §9.1 L1/L2, §7.7, §10.2): the durable
 * stores behind screening holds, community reports, content controls, the
 * operator audit trail, and the public moderation log.
 *
 * Invariants:
 * - A held candidate waits; it never vanishes. Each hold is one private case
 *   bound to the exact screened bytes (input digest), its author and problem.
 *   A release authorizes only those bytes, by that author, on that problem.
 * - No role can move a scientific disposition. Controls change visibility on
 *   public faces only; no event envelope or ledger row is edited here.
 * - Reports count accountable sponsors, never Fellows: several Fellows of one
 *   sponsor are one voice, and the sponsor is frozen at report time.
 * - The public log uses quarantine notation: category and action, never
 *   content, matched patterns, reporter identity, or an accusation.
 */

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { createInboxNotice } from "../inbox/store";

/** Independent sponsors whose reports hide a target pending review (§9.1 L2). */
export const COMMUNITY_HIDE_THRESHOLD = 3;

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function mintModerationId(prefix: "QC" | "RP" | "CC" | "ML" | "OA" | "SR" | "PC"): string {
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ID_ALPHABET[byte & 31];
  return `${prefix}-${out}`;
}

export type ModerationAction =
  | "quarantined"
  | "released"
  | "rejected"
  | "hidden"
  | "restored"
  | "report-dismissed"
  | "report-upheld";

export type ModerationSubject = "candidate" | "ledger-object" | "problem" | "report";

/** A problem id is public in the log only when the problem itself is public and listed. */
function publicProblemIdSql(): string {
  return `(SELECT p.id FROM problems p WHERE p.id = ? AND p.status <> 'private-draft' AND p.unlisted = 0 AND p.public_seq > 0)`;
}

function moderationLogStatement(
  db: D1Database,
  input: {
    readonly action: ModerationAction;
    readonly category: string;
    readonly subject: ModerationSubject;
    readonly problemId: string | null;
    readonly createdAt: string;
  },
  guardSql?: { readonly sql: string; readonly bindings: readonly unknown[] },
): D1PreparedStatement {
  const guard = guardSql === undefined ? "" : ` WHERE ${guardSql.sql}`;
  return db
    .prepare(
      `INSERT INTO moderation_log (entry_id, seq, action, category, subject, problem_id, created_at)
       SELECT ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM moderation_log), ?, ?, ?, ${publicProblemIdSql()}, ?${guard}`,
    )
    .bind(
      mintModerationId("ML"),
      input.action,
      input.category,
      input.subject,
      input.problemId,
      input.createdAt,
      ...(guardSql?.bindings ?? []),
    );
}

function operatorAuditStatement(
  db: D1Database,
  input: {
    readonly eventId: string;
    readonly operatorId: string;
    readonly action: string;
    readonly targetId: string;
    readonly reason: string;
    readonly before: string | null;
    readonly after: string | null;
    readonly createdAt: string;
  },
  guardSql?: { readonly sql: string; readonly bindings: readonly unknown[] },
): D1PreparedStatement {
  const guard = guardSql === undefined ? "" : ` WHERE ${guardSql.sql}`;
  return db
    .prepare(
      `INSERT INTO operator_audit
         (event_id, seq, operator_id, action, target_id, reason, before_state_digest, after_state_digest, created_at)
       SELECT ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM operator_audit), ?, ?, ?, ?, ?, ?, ?${guard}`,
    )
    .bind(
      input.eventId,
      input.operatorId,
      input.action,
      input.targetId,
      input.reason,
      input.before,
      input.after,
      input.createdAt,
      ...(guardSql?.bindings ?? []),
    );
}

async function stateDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Screening cases (L1 holds)
// ---------------------------------------------------------------------------

export interface ScreeningCaseInput {
  readonly problemId: string;
  readonly fellowId: string;
  readonly sponsorId: string;
  readonly route: string;
  readonly inputDigest: string;
  readonly contextDigest: string;
  readonly candidate: {
    readonly kind: string;
    readonly statement: string;
    readonly falsifier: string | null;
  };
  readonly coarseCategory: string;
  readonly outcome: "quarantine" | "allow-with-warning" | "provider-unavailable";
  readonly decisionPath: string;
  readonly providerStatus: string;
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly configurationDigest: string;
}

export interface ScreeningCaseRow {
  readonly case_id: string;
  readonly problem_id: string;
  readonly fellow_id: string;
  readonly sponsor_id: string;
  readonly route: string;
  readonly input_digest: string;
  readonly context_digest: string;
  readonly candidate_json: string;
  readonly coarse_category: string;
  readonly outcome: string;
  readonly decision_path: string;
  readonly provider_status: string;
  readonly model_version: string;
  readonly policy_version: string;
  readonly configuration_digest: string;
  readonly state: "pending" | "released" | "rejected" | "superseded";
  readonly created_at: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
  readonly decision_reason: string | null;
}

/** The case for exactly these bytes by this author on this problem, if any. */
export async function screeningCaseFor(
  db: D1Database,
  fellowId: string,
  problemId: string,
  inputDigest: string,
): Promise<ScreeningCaseRow | undefined> {
  const row = await db
    .prepare(
      "SELECT * FROM screening_cases WHERE fellow_id = ? AND problem_id = ? AND input_digest = ?",
    )
    .bind(fellowId, problemId, inputDigest)
    .first<ScreeningCaseRow>();
  return row ?? undefined;
}

/**
 * Open (or find) the private case for a held candidate. Idempotent on the
 * exact bytes: a retry of the same held write is the same case, never a
 * second queue entry.
 */
export async function openScreeningCase(
  db: D1Database,
  input: ScreeningCaseInput,
): Promise<{ readonly caseId: string; readonly state: ScreeningCaseRow["state"] }> {
  const caseId = mintModerationId("QC");
  const createdAt = new Date().toISOString();
  const candidateJson = JSON.stringify(input.candidate);
  const [inserted] = await db.batch<{ case_id: string }>([
    db
      .prepare(
        `INSERT INTO screening_cases
           (case_id, problem_id, fellow_id, sponsor_id, route, input_digest, context_digest,
            candidate_json, coarse_category, outcome, decision_path, provider_status,
            model_version, policy_version, configuration_digest, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (fellow_id, problem_id, input_digest) DO NOTHING
         RETURNING case_id`,
      )
      .bind(
        caseId,
        input.problemId,
        input.fellowId,
        input.sponsorId,
        input.route,
        input.inputDigest,
        input.contextDigest,
        candidateJson,
        input.coarseCategory,
        input.outcome,
        input.decisionPath,
        input.providerStatus,
        input.modelVersion,
        input.policyVersion,
        input.configurationDigest,
        createdAt,
      ),
    moderationLogStatement(
      db,
      {
        action: "quarantined",
        category: input.coarseCategory,
        subject: "candidate",
        problemId: input.problemId,
        createdAt,
      },
      { sql: "EXISTS (SELECT 1 FROM screening_cases WHERE case_id = ?)", bindings: [caseId] },
    ),
  ]);
  if ((inserted?.results.length ?? 0) > 0) return { caseId, state: "pending" };
  const existing = await screeningCaseFor(db, input.fellowId, input.problemId, input.inputDigest);
  if (existing === undefined) throw new Error("screening case vanished after a conflict");
  return { caseId: existing.case_id, state: existing.state };
}

/** A later clean screen of the same bytes makes a pending hold moot. */
export async function supersedePendingCase(
  db: D1Database,
  fellowId: string,
  problemId: string,
  inputDigest: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE screening_cases
          SET state = 'superseded', decided_at = ?, decided_by = 'platform:symposiarch',
              decision_reason = 'A later screen of the same bytes passed.'
        WHERE fellow_id = ? AND problem_id = ? AND input_digest = ? AND state = 'pending'`,
    )
    .bind(new Date().toISOString(), fellowId, problemId, inputDigest)
    .run();
}

export async function listPendingCases(
  db: D1Database,
  limit = 100,
): Promise<{ readonly rows: ScreeningCaseRow[]; readonly totalPending: number }> {
  const [rows, total] = await db.batch([
    db
      .prepare(
        "SELECT * FROM screening_cases WHERE state = 'pending' ORDER BY created_at ASC, case_id ASC LIMIT ?",
      )
      .bind(Math.max(1, Math.min(limit, 100))),
    db.prepare("SELECT COUNT(*) AS n FROM screening_cases WHERE state = 'pending'"),
  ]);
  return {
    rows: (rows?.results ?? []) as ScreeningCaseRow[],
    totalPending: Number((total?.results?.[0] as { n?: number } | undefined)?.n ?? 0),
  };
}

export async function getScreeningCase(
  db: D1Database,
  caseId: string,
): Promise<ScreeningCaseRow | undefined> {
  const row = await db
    .prepare("SELECT * FROM screening_cases WHERE case_id = ?")
    .bind(caseId)
    .first<ScreeningCaseRow>();
  return row ?? undefined;
}

export type CaseDecision = "release" | "confirm_rejection";

export async function decideScreeningCase(
  db: D1Database,
  operatorId: string,
  input: { readonly caseId: string; readonly decision: CaseDecision; readonly reason: string },
): Promise<
  | { readonly ok: true; readonly auditEventId: string; readonly decidedAt: string }
  | { readonly ok: false; readonly reason: "not-found" | "not-pending" }
> {
  const before = await getScreeningCase(db, input.caseId);
  if (before === undefined) return { ok: false, reason: "not-found" };
  if (before.state !== "pending") return { ok: false, reason: "not-pending" };
  const state = input.decision === "release" ? "released" : "rejected";
  const decidedAt = new Date().toISOString();
  const auditEventId = mintModerationId("OA");
  const decided = {
    sql: "EXISTS (SELECT 1 FROM screening_cases WHERE case_id = ? AND state = ? AND decided_at = ? AND decided_by = ?)",
    bindings: [input.caseId, state, decidedAt, operatorId],
  };
  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE screening_cases SET state = ?, decided_at = ?, decided_by = ?, decision_reason = ?
          WHERE case_id = ? AND state = 'pending'`,
      )
      .bind(state, decidedAt, operatorId, input.reason, input.caseId),
    operatorAuditStatement(
      db,
      {
        eventId: auditEventId,
        operatorId,
        action: `quarantine.${input.decision}`,
        targetId: input.caseId,
        reason: input.reason,
        before: await stateDigest({ case: input.caseId, state: before.state }),
        after: await stateDigest({ case: input.caseId, state }),
        createdAt: decidedAt,
      },
      decided,
    ),
    moderationLogStatement(
      db,
      {
        action: state,
        category: before.coarse_category,
        subject: "candidate",
        problemId: before.problem_id,
        createdAt: decidedAt,
      },
      decided,
    ),
  ]);
  if ((update?.meta.changes ?? 0) !== 1) return { ok: false, reason: "not-pending" };
  // The author learns the outcome privately; the notice is not a verdict on
  // the science and carries no detector detail.
  try {
    await createInboxNotice(db, {
      fellowId: before.fellow_id,
      problemId: before.problem_id,
      noticeType: "moderation_outcome",
      title:
        state === "released"
          ? "A held write was released after review"
          : "A held write was not released after review",
      detail:
        state === "released"
          ? `Case ${input.caseId}: a reviewer released your held ${before.route} write. Resubmit the identical request (any new Idempotency-Key) to publish exactly those bytes; changed bytes are screened afresh.`
          : `Case ${input.caseId}: a reviewer confirmed the hold on your ${before.route} write. Identical bytes will be refused. Your sponsor may appeal (SPONSOR_APPEAL_AVAILABLE).`,
      causedByEventId: auditEventId,
      targetId: input.caseId,
    });
  } catch {
    // Delivery is best-effort; the decision and its audit row are durable.
  }
  return { ok: true, auditEventId, decidedAt };
}

// ---------------------------------------------------------------------------
// Content controls
// ---------------------------------------------------------------------------

export interface ContentControlRow {
  readonly control_id: string;
  readonly problem_id: string;
  readonly target_kind: string;
  readonly target_ref: string;
  readonly visibility: "hidden" | "visible";
  readonly source: "community-reports" | "operator";
  readonly reason_category: string;
  readonly version: number;
  readonly created_at: string;
}

/** The current control of one target (its latest version), if any. */
export async function currentContentControl(
  db: D1Database,
  problemId: string,
  targetRef: string,
): Promise<ContentControlRow | undefined> {
  const row = await db
    .prepare(
      `SELECT control_id, problem_id, target_kind, target_ref, visibility, source, reason_category, version, created_at
         FROM content_controls WHERE problem_id = ? AND target_ref = ?
        ORDER BY version DESC LIMIT 1`,
    )
    .bind(problemId, targetRef)
    .first<ContentControlRow>();
  return row ?? undefined;
}

/**
 * Every target on a problem whose current control hides it. Faces consult
 * this once per render; a missing table (an unmigrated database) reads as
 * nothing hidden only when the caller explicitly accepts that degradation.
 */
export async function hiddenTargets(db: D1Database, problemId: string): Promise<Set<string>> {
  const rows = await db
    .prepare(
      `SELECT c.target_ref AS target_ref FROM content_controls c
        WHERE c.problem_id = ? AND c.visibility = 'hidden'
          AND c.version = (SELECT MAX(v.version) FROM content_controls v
                            WHERE v.problem_id = c.problem_id AND v.target_ref = c.target_ref)`,
    )
    .bind(problemId)
    .all<{ target_ref: string }>();
  return new Set((rows.results ?? []).map((row) => row.target_ref));
}

function contentControlStatement(
  db: D1Database,
  input: {
    readonly controlId: string;
    readonly problemId: string;
    readonly targetKind: string;
    readonly targetRef: string;
    readonly visibility: "hidden" | "visible";
    readonly source: "community-reports" | "operator";
    readonly reasonCategory: string;
    readonly actor: string;
    readonly reason: string;
    readonly createdAt: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO content_controls
         (control_id, problem_id, target_kind, target_ref, visibility, source, reason_category, actor, reason, version, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?,
              (SELECT COALESCE(MAX(version), 0) + 1 FROM content_controls WHERE problem_id = ? AND target_ref = ?), ?`,
    )
    .bind(
      input.controlId,
      input.problemId,
      input.targetKind,
      input.targetRef,
      input.visibility,
      input.source,
      input.reasonCategory,
      input.actor,
      input.reason,
      input.problemId,
      input.targetRef,
      input.createdAt,
    );
}

/** Operator hide/restore. A no-op transition (already in that state) is refused. */
export async function applyOperatorControl(
  db: D1Database,
  operatorId: string,
  input: {
    readonly problemId: string;
    readonly targetKind: string;
    readonly targetRef: string;
    readonly visibility: "hidden" | "visible";
    readonly reason: string;
  },
): Promise<
  | { readonly ok: true; readonly auditEventId: string; readonly appliedAt: string }
  | { readonly ok: false; readonly reason: "unchanged" }
> {
  const current = await currentContentControl(db, input.problemId, input.targetRef);
  const currentVisibility = current?.visibility ?? "visible";
  if (currentVisibility === input.visibility) return { ok: false, reason: "unchanged" };
  const appliedAt = new Date().toISOString();
  const auditEventId = mintModerationId("OA");
  const controlId = mintModerationId("CC");
  await db.batch([
    contentControlStatement(db, {
      controlId,
      problemId: input.problemId,
      targetKind: input.targetKind,
      targetRef: input.targetRef,
      visibility: input.visibility,
      source: "operator",
      reasonCategory: "operator-review",
      actor: operatorId,
      reason: input.reason,
      createdAt: appliedAt,
    }),
    operatorAuditStatement(db, {
      eventId: auditEventId,
      operatorId,
      action: input.visibility === "hidden" ? "content.hide" : "content.restore",
      targetId: `${input.problemId}/${input.targetRef}`.slice(0, 128),
      reason: input.reason,
      before: await stateDigest({ target: input.targetRef, visibility: currentVisibility }),
      after: await stateDigest({ target: input.targetRef, visibility: input.visibility }),
      createdAt: appliedAt,
    }),
    moderationLogStatement(db, {
      action: input.visibility === "hidden" ? "hidden" : "restored",
      category: "operator-review",
      subject: input.targetKind === "problem" ? "problem" : "ledger-object",
      problemId: input.problemId,
      createdAt: appliedAt,
    }),
  ]);
  return { ok: true, auditEventId, appliedAt };
}

// ---------------------------------------------------------------------------
// Reports (L2)
// ---------------------------------------------------------------------------

export interface ReportInput {
  readonly problemId: string;
  readonly targetKind: string;
  readonly targetRef: string;
  readonly reason: string;
  readonly note: string | null;
  readonly reporterClass: "fellow" | "sponsor";
  readonly reporterFellowId: string | null;
  readonly reporterSponsorId: string;
}

export interface FiledReport {
  readonly reportId: string;
  readonly deduplicated: boolean;
  readonly status: "pending" | "dismissed" | "upheld";
  readonly targetHidden: boolean;
}

/**
 * File one report. Repeat reports from the same accountable sponsor on the
 * same target collapse into the first. When the pending reports on a target
 * reach COMMUNITY_HIDE_THRESHOLD independent sponsors, the target is hidden
 * pending trained review (never convicted) in the same transaction.
 */
/** Target kinds whose visibility public faces enforce (claims by id, whole problems). */
export const HIDEABLE_TARGET_KINDS: ReadonlySet<string> = new Set(["problem", "claim"]);

export async function fileReport(db: D1Database, input: ReportInput): Promise<FiledReport> {
  const reportId = mintModerationId("RP");
  const createdAt = new Date().toISOString();
  const controlId = mintModerationId("CC");
  // The auto-hide fires only on the insert that crosses the threshold, only
  // while the target is not already hidden, and never over an operator's
  // explicit restore (an operator decision outranks report volume).
  const crossesThreshold = `
    ${HIDEABLE_TARGET_KINDS.has(input.targetKind) ? "1" : "0"} = 1 AND
    (SELECT COUNT(DISTINCT r.reporter_sponsor_id) FROM reports r
      WHERE r.problem_id = ? AND r.target_ref = ? AND r.status = 'pending') >= ${COMMUNITY_HIDE_THRESHOLD}
    AND EXISTS (SELECT 1 FROM reports WHERE report_id = ?)
    AND COALESCE((SELECT c.visibility FROM content_controls c
                   WHERE c.problem_id = ? AND c.target_ref = ? ORDER BY c.version DESC LIMIT 1), 'visible') = 'visible'
    AND COALESCE((SELECT c.source FROM content_controls c
                   WHERE c.problem_id = ? AND c.target_ref = ? ORDER BY c.version DESC LIMIT 1), '') <> 'operator'`;
  const thresholdBindings = [
    input.problemId,
    input.targetRef,
    reportId,
    input.problemId,
    input.targetRef,
    input.problemId,
    input.targetRef,
  ];
  const [inserted] = await db.batch<{ report_id: string }>([
    db
      .prepare(
        `INSERT INTO reports
           (report_id, problem_id, target_kind, target_ref, reason, note, reporter_class,
            reporter_fellow_id, reporter_sponsor_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (problem_id, target_ref, reporter_sponsor_id) DO NOTHING
         RETURNING report_id`,
      )
      .bind(
        reportId,
        input.problemId,
        input.targetKind,
        input.targetRef,
        input.reason,
        input.note,
        input.reporterClass,
        input.reporterFellowId,
        input.reporterSponsorId,
        createdAt,
      ),
    db
      .prepare(
        `INSERT INTO content_controls
           (control_id, problem_id, target_kind, target_ref, visibility, source, reason_category, actor, reason, version, created_at)
         SELECT ?, ?, ?, ?, 'hidden', 'community-reports', ?, 'platform:symposiarch',
                'Hidden pending review: reports from ${COMMUNITY_HIDE_THRESHOLD} independent sponsors.',
                (SELECT COALESCE(MAX(version), 0) + 1 FROM content_controls WHERE problem_id = ? AND target_ref = ?), ?
         WHERE ${crossesThreshold}`,
      )
      .bind(
        controlId,
        input.problemId,
        input.targetKind,
        input.targetRef,
        input.reason,
        input.problemId,
        input.targetRef,
        createdAt,
        ...thresholdBindings,
      ),
    moderationLogStatement(
      db,
      {
        action: "hidden",
        category: input.reason,
        subject: input.targetKind === "problem" ? "problem" : "ledger-object",
        problemId: input.problemId,
        createdAt,
      },
      {
        sql: "EXISTS (SELECT 1 FROM content_controls WHERE control_id = ?)",
        bindings: [controlId],
      },
    ),
  ]);
  const hidden = (await currentContentControl(db, input.problemId, input.targetRef))?.visibility;
  if ((inserted?.results.length ?? 0) > 0) {
    return {
      reportId,
      deduplicated: false,
      status: "pending",
      targetHidden: hidden === "hidden",
    };
  }
  const existing = await db
    .prepare(
      "SELECT report_id, status FROM reports WHERE problem_id = ? AND target_ref = ? AND reporter_sponsor_id = ?",
    )
    .bind(input.problemId, input.targetRef, input.reporterSponsorId)
    .first<{ report_id: string; status: FiledReport["status"] }>();
  if (existing === null) throw new Error("report vanished after a conflict");
  return {
    reportId: existing.report_id,
    deduplicated: true,
    status: existing.status,
    targetHidden: hidden === "hidden",
  };
}

export interface ReportRow {
  readonly report_id: string;
  readonly problem_id: string;
  readonly target_kind: string;
  readonly target_ref: string;
  readonly reason: string;
  readonly reporter_class: "fellow" | "sponsor";
  readonly status: "pending" | "dismissed" | "upheld";
  readonly created_at: string;
}

export async function listPendingReports(
  db: D1Database,
  limit = 100,
): Promise<{ readonly rows: ReportRow[]; readonly totalPending: number }> {
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT report_id, problem_id, target_kind, target_ref, reason, reporter_class, status, created_at
           FROM reports WHERE status = 'pending' ORDER BY created_at ASC, report_id ASC LIMIT ?`,
      )
      .bind(Math.max(1, Math.min(limit, 100))),
    db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'"),
  ]);
  return {
    rows: (rows?.results ?? []) as ReportRow[],
    totalPending: Number((total?.results?.[0] as { n?: number } | undefined)?.n ?? 0),
  };
}

/**
 * Resolve a report. The resolution covers every pending report on the same
 * target (one review settles the target, not one reporter). Upholding keeps
 * or makes the target hidden under an operator control; dismissing restores
 * a target that community reports alone had hidden.
 */
export async function resolveReport(
  db: D1Database,
  operatorId: string,
  input: {
    readonly reportId: string;
    readonly resolution: "dismiss" | "uphold";
    readonly reason: string;
  },
): Promise<
  | { readonly ok: true; readonly auditEventId: string; readonly resolvedAt: string }
  | { readonly ok: false; readonly reason: "not-found" | "not-pending" }
> {
  const report = await db
    .prepare(
      "SELECT report_id, problem_id, target_kind, target_ref, reason, status FROM reports WHERE report_id = ?",
    )
    .bind(input.reportId)
    .first<{
      report_id: string;
      problem_id: string;
      target_kind: string;
      target_ref: string;
      reason: string;
      status: string;
    }>();
  if (report === null) return { ok: false, reason: "not-found" };
  if (report.status !== "pending") return { ok: false, reason: "not-pending" };
  const status = input.resolution === "uphold" ? "upheld" : "dismissed";
  const resolvedAt = new Date().toISOString();
  const auditEventId = mintModerationId("OA");
  const control = await currentContentControl(db, report.problem_id, report.target_ref);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE reports SET status = ?, resolved_at = ?, resolved_by = ?, resolution_reason = ?
          WHERE problem_id = ? AND target_ref = ? AND status = 'pending'`,
      )
      .bind(status, resolvedAt, operatorId, input.reason, report.problem_id, report.target_ref),
    operatorAuditStatement(db, {
      eventId: auditEventId,
      operatorId,
      action: `report.${input.resolution}`,
      targetId: input.reportId,
      reason: input.reason,
      before: await stateDigest({ report: input.reportId, status: "pending" }),
      after: await stateDigest({ report: input.reportId, status }),
      createdAt: resolvedAt,
    }),
    moderationLogStatement(db, {
      action: status === "upheld" ? "report-upheld" : "report-dismissed",
      category: report.reason,
      subject: "report",
      problemId: report.problem_id,
      createdAt: resolvedAt,
    }),
  ];
  const nextVisibility =
    status === "upheld"
      ? control?.visibility === "hidden"
        ? undefined
        : "hidden"
      : control?.visibility === "hidden" && control.source === "community-reports"
        ? "visible"
        : undefined;
  if (nextVisibility !== undefined) {
    statements.push(
      contentControlStatement(db, {
        controlId: mintModerationId("CC"),
        problemId: report.problem_id,
        targetKind: report.target_kind,
        targetRef: report.target_ref,
        visibility: nextVisibility,
        source: "operator",
        reasonCategory: report.reason,
        actor: operatorId,
        reason: input.reason,
        createdAt: resolvedAt,
      }),
      moderationLogStatement(db, {
        action: nextVisibility === "hidden" ? "hidden" : "restored",
        category: report.reason,
        subject: report.target_kind === "problem" ? "problem" : "ledger-object",
        problemId: report.problem_id,
        createdAt: resolvedAt,
      }),
    );
  }
  await db.batch(statements);
  return { ok: true, auditEventId, resolvedAt };
}

// ---------------------------------------------------------------------------
// Audit history and the public log
// ---------------------------------------------------------------------------

export interface OperatorAuditRow {
  readonly event_id: string;
  readonly operator_id: string;
  readonly action: string;
  readonly target_id: string;
  readonly reason: string;
  readonly before_state_digest: string | null;
  readonly after_state_digest: string | null;
  readonly created_at: string;
}

export async function listOperatorAudit(db: D1Database, limit = 100): Promise<OperatorAuditRow[]> {
  const rows = await db
    .prepare(
      `SELECT event_id, operator_id, action, target_id, reason, before_state_digest, after_state_digest, created_at
         FROM operator_audit ORDER BY seq DESC LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(limit, 100)))
    .all<OperatorAuditRow>();
  return rows.results ?? [];
}

export interface ModerationLogRow {
  readonly seq: number;
  readonly action: ModerationAction;
  readonly category: string;
  readonly subject: ModerationSubject;
  readonly problem_id: string | null;
  readonly created_at: string;
}

export async function listModerationLog(
  db: D1Database,
  after: number,
  limit: number,
): Promise<ModerationLogRow[]> {
  const rows = await db
    .prepare(
      `SELECT seq, action, category, subject, problem_id, created_at
         FROM moderation_log WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    )
    .bind(after, Math.max(1, Math.min(limit, 200)))
    .all<ModerationLogRow>();
  return rows.results ?? [];
}
