import { ReportResponseSchema, type ReportReason } from "@asimposium/contracts";
import type { IntegrityCaseOpenRequest, IntegrityCaseResolveRequest } from "@asimposium/contracts/integrity-cases";
import { writeLedgerEvent } from "../../src/krater/krater.ts";
import { fileReportRequest } from "../../src/moderation/router.ts";
import { publicationContextFixture, FELLOW, PROBLEM, SPONSOR } from "./publication-context.ts";

export { FELLOW, PROBLEM, SPONSOR };
export const INTEGRITY_REPORTER = "usr_integrity_reporter";
export const INTEGRITY_OPERATOR = "usr_integrity_operator";
export const INTEGRITY_APPEAL_OPERATOR = "usr_integrity_appeal";
export const INTEGRITY_SUMMARY = "PRIVATE_INTEGRITY_SUMMARY: check the exact supplied source, without assuming wrongdoing.";
export const INTEGRITY_RESPONSE = "PRIVATE_SPONSOR_RESPONSE: the cited page contains a corrected statement and the original wording was an honest error.";
export const INTEGRITY_RATIONALE = "PRIVATE_INTEGRITY_RATIONALE: I considered the exact source and sponsor response; scientific standing remains independently computed.";

export function openRequest(reportId: string): IntegrityCaseOpenRequest {
  return {
    report_id: reportId, concern: "fabricated-source", summary: INTEGRITY_SUMMARY,
    public_notice: true, conflict_declaration: "no-conflict",
    auth_issued_at: Math.floor(Date.now() / 1000),
  };
}
export function resolveRequest(caseId: string, revision: number): IntegrityCaseResolveRequest {
  return {
    case_id: caseId, expected_revision: revision, outcome: "honest-error",
    rationale: INTEGRITY_RATIONALE, correction_refs: [], conflict_declaration: "no-conflict",
    auth_issued_at: Math.floor(Date.now() / 1000),
  };
}

// Uses all production migrations and the real SQL methods on SQLite. This is
// unit proof of the lifecycle, not a claim about native Workerd/D1 execution.
export async function integrityCaseFixture() {
  const f = await publicationContextFixture();
  for (const sponsorId of [INTEGRITY_REPORTER, INTEGRITY_OPERATOR, INTEGRITY_APPEAL_OPERATOR, "usr_integrity_other"])
    f.sql.query("INSERT INTO sponsors(sponsor_id,created_at,last_seen_at) VALUES(?,?,?)")
      .run(sponsorId, Date.now(), Date.now());
  let serial = 0;
  async function publish(
    objectId = "C-1",
    version = 1,
    options: { body?: string; sponsor?: string; fellow?: string | null; evidence?: boolean } = {},
  ) {
    const base = f.command(f.input()).input;
    const eventId = `E-integrity-${++serial}`;
    const payload = options.evidence ? {
      evidence_id: objectId,
      bears_on_kind: "claim", bears_on_id: "C-1", bears_on_version: 1,
      kind: "argument", direction: "informs", mode: "exploratory",
      body_md: options.body ?? "A bounded report requiring independent scrutiny.",
      computed_class: "assertion",
    } : {
      claim_id: objectId, kind: "conjecture",
      statement: options.body ?? `Exact source ${objectId}@${version}.`,
      falsifier: "A counterexample within the stated finite domain.",
      ...(version > 1 ? { base_version: version - 1 } : {}),
    };
    return writeLedgerEvent(f.db, {
      ...base, eventId, idempotencyKey: eventId,
      eventType: options.evidence ? "evidence.created" : version === 1 ? "claim.created" : "claim.revised",
      objectKind: options.evidence ? "evidence" : "claim", objectId, objectVersion: version,
      payloadJson: JSON.stringify(payload),
      attribution: {
        ...base.attribution,
        sponsorId: options.sponsor ?? SPONSOR,
        fellowId: options.fellow === undefined ? FELLOW : options.fellow,
      },
    }, { statementsAfterEvent: () => [] });
  }
  async function report(
    target = "C-1@1",
    reporterSponsor = INTEGRITY_REPORTER,
    reason: ReportReason = "integrity",
  ) {
    const response = await fileReportRequest(f.db, {
      reporterClass: "sponsor", reporterFellowId: null, reporterSponsorId: reporterSponsor,
    }, {
      problem_id: PROBLEM, target, reason,
      note: "PRIVATE_REPORTER_NOTE: verify the exact original source without advertising an allegation.",
    });
    if (response.status !== 201)
      throw new Error(`Expected fresh report, got ${response.status}: ${await response.text()}`);
    return ReportResponseSchema.parse(await response.json());
  }
  return { ...f, publish, report };
}
