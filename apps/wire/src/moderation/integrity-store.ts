import { canonicalJson } from "@asimposium/contracts";
import {
  INTEGRITY_CASE_STEP_UP_SECONDS,
  type IntegrityCaseAction,
  type IntegrityCaseOpenRequest,
  type IntegrityCaseReceipt,
  IntegrityCaseReceiptSchema,
  type IntegrityCaseResolveRequest,
  type IntegrityCaseRespondRequest,
} from "@asimposium/contracts/integrity-cases";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { inboxNoticeStatement } from "../inbox/notice-write.ts";
import {
  IntegrityCaseError,
  type IntegritySourceWitness,
  integrityWitnessGuard,
  readIntegrityCorrection,
  readIntegrityReportSource,
  requireUnconflictedIntegrityOperator,
} from "./integrity-source.ts";

export { IntegrityCaseError } from "./integrity-source.ts";

export interface IntegrityCaseRow {
  case_id: string;
  report_id: string;
  problem_id: string;
  target_ref: string;
  source_event_id: string;
  source_digest: string;
  source_seq: number;
  subject_sponsor_id: string;
  subject_fellow_id: string | null;
  reporter_sponsor_id: string;
  reporter_fellow_id: string | null;
  concern: string;
  summary: string;
  public_notice: number;
  state: "open" | "resolved";
  revision: number;
  appeals_used: 0 | 1;
  opened_by: string;
  opened_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  original_resolved_by: string | null;
  outcome: string | null;
  rationale: string | null;
  correction_refs_json: string;
}

export const INTEGRITY_ACTIVE_SPONSOR_SQL =
  "EXISTS (SELECT 1 FROM sponsors owner WHERE owner.sponsor_id = ? AND owner.tombstoned_at IS NULL)";

export async function readIntegrityCaseRow(
  db: D1Database,
  caseId: string,
  sponsorId?: string,
): Promise<IntegrityCaseRow | null> {
  return db.prepare(`SELECT c.*, r.reporter_fellow_id FROM integrity_cases c
    JOIN reports r ON r.report_id = c.report_id
    WHERE c.case_id = ?
      ${sponsorId === undefined ? "" : `AND c.subject_sponsor_id = ? AND ${INTEGRITY_ACTIVE_SPONSOR_SQL}`}`)
    .bind(caseId, ...(sponsorId === undefined ? [] : [sponsorId, sponsorId]))
    .first<IntegrityCaseRow>();
}

export function requireIntegrityStepUp(issuedAt: number, now = Date.now()): void {
  const seconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || issuedAt > seconds ||
    seconds - issuedAt > INTEGRITY_CASE_STEP_UP_SECONDS)
    throw new IntegrityCaseError("STEP_UP");
}

function newId(prefix: "IC" | "IA" | "OA"): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `${prefix}-${Array.from(bytes, (byte) => alphabet[byte & 31]).join("")}`;
}
export async function integrityDigest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
interface IntegrityActor {
  actorClass: "operator" | "sponsor";
  actorId: string;
}
interface IntegrityCommand extends IntegrityActor {
  operation: "open" | "respond" | "resolve";
  keyDigest: string;
  requestDigest: string;
}

async function readReceipt(db: D1Database, command: IntegrityCommand) {
  const row = await db.prepare(`SELECT operation, request_digest, receipt_json,
      case_id, action_id FROM integrity_command_receipts
    WHERE actor_class = ? AND actor_id = ? AND key_digest = ?`)
    .bind(command.actorClass, command.actorId, command.keyDigest)
    .first<{
      operation: string; request_digest: string; receipt_json: string;
      case_id: string; action_id: string;
    }>();
  if (!row) return null;
  if (row.operation !== command.operation || row.request_digest !== command.requestDigest)
    throw new IntegrityCaseError("IDEMPOTENCY");
  const receipt = IntegrityCaseReceiptSchema.parse(JSON.parse(row.receipt_json));
  if (receipt.case_id !== row.case_id || receipt.action_id !== row.action_id)
    throw new Error("INTEGRITY_RECEIPT_INVALID");
  if (command.actorClass === "sponsor" &&
    !(await readIntegrityCaseRow(db, receipt.case_id, command.actorId)))
    throw new IntegrityCaseError("NOT_FOUND");
  return receipt;
}

// Receipt insertion is the last statement of the mutation batch. A duplicate
// key rolls the entire losing transaction back. Fresh authorization is supplied
// by the router on every retry; the receipt is never an authorization token.
async function runCommand(
  db: D1Database,
  actor: IntegrityActor,
  operation: IntegrityCommand["operation"],
  request: unknown,
  key: string,
  execute: (command: IntegrityCommand) => Promise<void>,
): Promise<IntegrityCaseReceipt> {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(key)) throw new IntegrityCaseError("IDEMPOTENCY");
  const command: IntegrityCommand = {
    ...actor,
    operation,
    keyDigest: await integrityDigest(key),
    requestDigest: await integrityDigest(canonicalJson({ operation, request })),
  };
  const prior = await readReceipt(db, command);
  if (prior) return prior;
  try {
    await execute(command);
  } catch (error) {
    const concurrent = await readReceipt(db, command);
    if (concurrent) return concurrent;
    throw error;
  }
  const saved = await readReceipt(db, command);
  if (!saved) throw new IntegrityCaseError("CONFLICT");
  return saved;
}

async function completionStatements(
  db: D1Database,
  command: IntegrityCommand,
  row: Pick<IntegrityCaseRow, "case_id" | "problem_id" | "subject_sponsor_id" | "subject_fellow_id">,
  action: IntegrityCaseAction,
  receipt: IntegrityCaseReceipt,
): Promise<D1PreparedStatement[]> {
  const guard = "EXISTS (SELECT 1 FROM integrity_case_actions WHERE action_id = ? AND case_id = ?)";
  const guardBindings = [action.action_id, row.case_id];
  const statements = [
    db.prepare(`INSERT INTO integrity_case_actions
      (action_id,case_id,revision,kind,actor_class,actor_id,body_json,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE changes() = 1
        AND EXISTS (SELECT 1 FROM integrity_cases WHERE case_id = ? AND revision = ?)`)
      .bind(
        action.action_id, row.case_id, action.revision, action.kind, action.actor_class,
        action.actor_id, canonicalJson(action.body), action.created_at, row.case_id, action.revision,
      ),
  ];
  if (command.actorClass === "operator") {
    statements.push(db.prepare(`INSERT INTO operator_audit
      (event_id,seq,operator_id,action,target_id,reason,before_state_digest,after_state_digest,created_at)
      SELECT ?, (SELECT COALESCE(MAX(seq),0)+1 FROM operator_audit), ?,?,?,?,NULL,?,?
      WHERE ${guard}`)
      .bind(
        newId("OA"), command.actorId, `integrity.${action.kind}`, row.case_id,
        `Recorded integrity case ${action.kind}; scientific standing unchanged.`,
        await integrityDigest(canonicalJson(receipt)), action.created_at, ...guardBindings,
      ));
  }
  if (action.kind === "resolved" || action.kind === "appealed") {
    const outcome = action.kind === "resolved" ? action.body.outcome : null;
    const resolved = outcome !== null;
    const status = outcome === "confirmed" ? "upheld" :
      resolved ? "dismissed" : "pending";
    const reason = !resolved ? null :
      outcome === "inconclusive"
        ? `Integrity case ${row.case_id} concluded without a finding; the report is administratively closed.`
        : `Integrity case ${row.case_id} concluded. The attributed outcome is in the restricted case record.`;
    statements.push(db.prepare(`UPDATE reports SET status = ?, resolved_at = ?,
      resolved_by = ?, resolution_reason = ?
      WHERE report_id = (SELECT report_id FROM integrity_cases WHERE case_id = ?)
        AND reason = 'integrity' AND ${guard}`)
      .bind(
        status, resolved ? action.created_at : null, resolved ? command.actorId : null,
        reason, row.case_id, ...guardBindings,
      ));
  }
  if (row.subject_fellow_id !== null) {
    statements.push(await inboxNoticeStatement(db, {
      fellowId: row.subject_fellow_id,
      problemId: row.problem_id,
      noticeType: "moderation_outcome",
      title: action.kind === "opened" ? "A private integrity review needs your sponsor" :
        action.kind === "resolved" ? "A private integrity review has an outcome" :
          action.kind === "appealed" ? "Your sponsor requested an integrity review appeal" :
            "Your sponsor responded to an integrity review",
      detail: `Case ${row.case_id} has an attributed ${action.kind} record. Your accountable sponsor can read and respond through the private console. This review does not change a scientific disposition.`,
      causedByEventId: action.action_id,
      targetId: row.case_id,
      createdAt: Date.parse(action.created_at),
    }, {
      sql: `${guard} AND EXISTS (SELECT 1 FROM enrollment_fellows f
        JOIN sponsors s ON s.sponsor_id = f.sponsor_id
        WHERE f.fellow_id = ? AND f.sponsor_id = ? AND s.tombstoned_at IS NULL)`,
      bindings: [...guardBindings, row.subject_fellow_id, row.subject_sponsor_id],
    }));
  }
  statements.push(db.prepare(`INSERT INTO integrity_command_receipts
    (actor_class,actor_id,key_digest,operation,request_digest,case_id,action_id,receipt_json,created_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE ${guard}`)
    .bind(
      command.actorClass, command.actorId, command.keyDigest, command.operation,
      command.requestDigest, row.case_id, action.action_id, canonicalJson(receipt),
      action.created_at, ...guardBindings,
    ));
  return statements;
}

export async function openIntegrityCase(
  db: D1Database,
  operatorId: string,
  request: IntegrityCaseOpenRequest,
  key: string,
): Promise<IntegrityCaseReceipt> {
  requireIntegrityStepUp(request.auth_issued_at);
  const { auth_issued_at: _freshness, ...intent } = request;
  return runCommand(db, { actorClass: "operator", actorId: operatorId }, "open", intent, key,
    async (command) => {
      const source = await readIntegrityReportSource(db, request.report_id);
      const witness = source.witness;
      if (!witness.sponsorId) throw new IntegrityCaseError("SOURCE_UNAVAILABLE");
      const conflict = await requireUnconflictedIntegrityOperator(
        db, operatorId, [witness.sponsorId, source.reporterSponsorId],
        [witness.fellowId, source.reporterFellowId],
      );
      const existing = await db.prepare("SELECT case_id FROM integrity_cases WHERE report_id = ?")
        .bind(request.report_id).first();
      if (existing) throw new IntegrityCaseError("CONFLICT");
      const guard = integrityWitnessGuard(witness);
      const caseId = newId("IC"), actionId = newId("IA"), now = new Date().toISOString();
      const receipt = IntegrityCaseReceiptSchema.parse({
        case_id: caseId, action_id: actionId, revision: 1, state: "open",
        action: "opened", created_at: now, appeals_used: 0,
      });
      const action: IntegrityCaseAction = {
        action_id: actionId, revision: 1, kind: "opened", actor_class: "operator",
        actor_id: operatorId, created_at: now,
        body: { concern: request.concern, summary: request.summary, public_notice: request.public_notice },
      };
      const row = {
        case_id: caseId, problem_id: witness.pin.problem_id,
        subject_sponsor_id: witness.sponsorId, subject_fellow_id: witness.fellowId,
      };
      await db.batch([
        db.prepare(`INSERT INTO integrity_cases
          (case_id,report_id,problem_id,target_ref,source_event_id,source_digest,source_seq,
           subject_sponsor_id,subject_fellow_id,reporter_sponsor_id,concern,summary,
           public_notice,state,revision,appeals_used,opened_by,opened_at,correction_refs_json)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'open',1,0,?,?,'[]'
          WHERE EXISTS (SELECT 1 FROM reports r WHERE r.report_id = ?
            AND r.reason = 'integrity' AND r.status = 'pending'
            AND r.problem_id = ? AND r.source_event_id = ? AND r.source_digest = ?
            AND r.reporter_sponsor_id = ? AND r.reporter_fellow_id IS ?)
            AND ${INTEGRITY_ACTIVE_SPONSOR_SQL} AND ${guard.sql} AND ${conflict.sql}
            AND NOT EXISTS (SELECT 1 FROM integrity_cases WHERE report_id = ?)`)
          .bind(
            caseId, request.report_id, witness.pin.problem_id, witness.pin.target_ref,
            witness.pin.event_id, witness.pin.payload_sha256, witness.pin.seq,
            witness.sponsorId, witness.fellowId, source.reporterSponsorId, request.concern,
            request.summary, request.public_notice ? 1 : 0, operatorId, now,
            request.report_id, witness.pin.problem_id, witness.pin.event_id,
            witness.pin.payload_sha256, source.reporterSponsorId, source.reporterFellowId,
            witness.sponsorId, ...guard.bindings, ...conflict.bindings, request.report_id,
          ),
        ...await completionStatements(db, command, row, action, receipt),
      ]);
    });
}

export async function respondToIntegrityCase(
  db: D1Database,
  sponsorId: string,
  request: IntegrityCaseRespondRequest,
  key: string,
): Promise<IntegrityCaseReceipt> {
  // Replays also require the accountable sponsor's current, active account.
  if (!(await readIntegrityCaseRow(db, request.case_id, sponsorId)))
    throw new IntegrityCaseError("NOT_FOUND");
  return runCommand(db, { actorClass: "sponsor", actorId: sponsorId }, "respond", request, key,
    async (command) => {
      const row = await readIntegrityCaseRow(db, request.case_id, sponsorId);
      if (!row) throw new IntegrityCaseError("NOT_FOUND");
      if (row.revision !== request.expected_revision || row.revision >= Number.MAX_SAFE_INTEGER ||
        (row.state === "resolved" && row.appeals_used !== 0))
        throw new IntegrityCaseError("CONFLICT");
      const appeal = row.state === "resolved";
      const kind = appeal ? "appealed" : "response";
      const revision = row.revision + 1;
      const appealsUsed = appeal ? 1 : row.appeals_used;
      const now = new Date().toISOString(), actionId = newId("IA");
      const receipt = IntegrityCaseReceiptSchema.parse({
        case_id: row.case_id, action_id: actionId, revision, state: "open",
        action: kind, created_at: now, appeals_used: appealsUsed,
      });
      const action: IntegrityCaseAction = {
        action_id: actionId, revision, kind, actor_class: "sponsor",
        actor_id: sponsorId, created_at: now, body: { response: request.response },
      };
      await db.batch([
        db.prepare(`UPDATE integrity_cases SET state = 'open', revision = ?, appeals_used = ?,
          resolved_at = NULL, resolved_by = NULL, outcome = NULL, rationale = NULL,
          correction_refs_json = '[]'
          WHERE case_id = ? AND subject_sponsor_id = ? AND revision = ? AND state = ?
            AND appeals_used = ? AND ${INTEGRITY_ACTIVE_SPONSOR_SQL}`)
          .bind(
            revision, appealsUsed, row.case_id, sponsorId, request.expected_revision,
            row.state, row.appeals_used, sponsorId,
          ),
        ...await completionStatements(db, command, row, action, receipt),
      ]);
    });
}

export async function resolveIntegrityCase(
  db: D1Database,
  operatorId: string,
  request: IntegrityCaseResolveRequest,
  key: string,
): Promise<IntegrityCaseReceipt> {
  requireIntegrityStepUp(request.auth_issued_at);
  const { auth_issued_at: _freshness, ...intent } = request;
  return runCommand(db, { actorClass: "operator", actorId: operatorId }, "resolve", intent, key,
    async (command) => {
      const row = await readIntegrityCaseRow(db, request.case_id);
      if (!row) throw new IntegrityCaseError("NOT_FOUND");
      if (row.state !== "open" || row.revision !== request.expected_revision ||
        row.revision >= Number.MAX_SAFE_INTEGER) throw new IntegrityCaseError("CONFLICT");
      if (row.appeals_used === 1 && row.original_resolved_by === operatorId)
        throw new IntegrityCaseError("REVIEWER");
      const witnesses: IntegritySourceWitness[] = [];
      for (const reference of request.correction_refs) {
        const witness = await readIntegrityCorrection(db, reference);
        if (witness.pin.event_id === row.source_event_id ||
          witnesses.some((prior) => prior.pin.event_id === witness.pin.event_id))
          throw new IntegrityCaseError("SOURCE_UNAVAILABLE");
        witnesses.push(witness);
      }
      const conflict = await requireUnconflictedIntegrityOperator(
        db, operatorId,
        [row.subject_sponsor_id, row.reporter_sponsor_id, ...witnesses.map((item) => item.sponsorId)],
        [row.subject_fellow_id, row.reporter_fellow_id, ...witnesses.map((item) => item.fellowId)],
      );
      const corrections = witnesses.map((item) => item.pin);
      const guards = witnesses.map((item) => integrityWitnessGuard(item, true));
      const revision = row.revision + 1, now = new Date().toISOString(), actionId = newId("IA");
      const receipt = IntegrityCaseReceiptSchema.parse({
        case_id: row.case_id, action_id: actionId, revision, state: "resolved",
        action: "resolved", created_at: now, appeals_used: row.appeals_used,
      });
      const action: IntegrityCaseAction = {
        action_id: actionId, revision, kind: "resolved", actor_class: "operator",
        actor_id: operatorId, created_at: now,
        body: { outcome: request.outcome, rationale: request.rationale, corrections },
      };
      await db.batch([
        db.prepare(`UPDATE integrity_cases SET state = 'resolved', revision = ?,
          resolved_at = ?, resolved_by = ?, original_resolved_by = COALESCE(original_resolved_by, ?),
          outcome = ?, rationale = ?, correction_refs_json = ?
          WHERE case_id = ? AND state = 'open' AND revision = ? AND appeals_used = ?
            AND (appeals_used = 0 OR original_resolved_by <> ?)
            AND ${conflict.sql}
            ${guards.map((guard) => `AND (${guard.sql})`).join("\n")}`)
          .bind(
            revision, now, operatorId, operatorId, request.outcome, request.rationale,
            canonicalJson(corrections), row.case_id, request.expected_revision, row.appeals_used,
            operatorId, ...conflict.bindings, ...guards.flatMap((guard) => guard.bindings),
          ),
        ...await completionStatements(db, command, row, action, receipt),
      ]);
    });
}
