import type { D1Database } from "@cloudflare/workers-types";
import { writeLedgerEvent } from "../../src/krater/krater.ts";

export const EVIDENCE_LIST_TIME = "2026-10-27T12:00:00.000Z";
export const EVIDENCE_LIST_ATTRIBUTION = {
  fellowId: "F-RESEARCH-FIXTURE",
  sponsorId: "usr_research_fixture",
  sessionId: "S-RESEARCH-FIXTURE",
  modelSelfDeclared: "synthetic original model",
  harness: "read-fixture",
};

export function evidenceListPayload(
  target: { kind: "claim"; id: string; version: number } | { kind: "hypothesis"; id: string },
) {
  return {
    bears_on_kind: target.kind,
    bears_on_id: target.id,
    bears_on_version: target.kind === "claim" ? target.version : null,
    direction: "informs",
    kind: "negative-result",
    source: { kind: "model_memory" },
    mode: "exploratory",
    body_md: "The finite search found no witness in the reported range.",
    computation_domain_or_floor: null,
    reproduction: null,
    selected_hypothesis_id: null,
    falsification_check: null,
    formal_artifact: null,
    computed_class: "assertion",
    coercion_flags: ["p8_model_memory_caps_at_assertion"],
  };
}

/** Explicit immutable-publication fixture for inventory reads. It bypasses
 * admission and screening, and never proves a scientific write journey. */
export async function appendEvidenceListFixture(
  db: D1Database,
  problem: string,
  number: number,
  target: { kind: "claim"; id: string; version: number } | { kind: "hypothesis"; id: string } = {
    kind: "claim",
    id: "C-1",
    version: 1,
  },
) {
  const id = `E-${number}`;
  const payload = evidenceListPayload(target);
  return writeLedgerEvent(
    db,
    {
      problemId: problem,
      eventId: `EV-${problem}-E-${number}`,
      idempotencyKey: `fixture-${problem}-E-${number}`,
      requestDigest: "a".repeat(64),
      eventType: "evidence.created",
      objectKind: "evidence",
      objectId: id,
      objectVersion: 1,
      createdAt: EVIDENCE_LIST_TIME,
      payloadJson: JSON.stringify(payload),
      attribution: EVIDENCE_LIST_ATTRIBUTION,
    },
    {
      statementsAfterEvent: (context) => [
        db
          .prepare(`INSERT INTO evidence
          (evidence_id,problem_id,bears_on_kind,bears_on_id,bears_on_version,direction,kind,
          source_kind,mode,computed_class,coercion_flags_json,author_fellow_id,body_md,
          created_at,source_event_id,source_seq)
          VALUES(?,?,?,?,?,'informs','negative-result','model_memory','exploratory',
          'assertion',?,?,?,?,?,?)`)
          .bind(
            id,
            problem,
            target.kind,
            target.id,
            target.kind === "claim" ? target.version : null,
            JSON.stringify(payload.coercion_flags),
            EVIDENCE_LIST_ATTRIBUTION.fellowId,
            payload.body_md,
            EVIDENCE_LIST_TIME,
            context.eventId,
            context.sequence,
          ),
      ],
    },
  );
}

export const EVIDENCE_HYPOTHESIS_PAYLOAD = {
  route: "Finite search",
  mechanism: "Enumerate the bounded candidate family.",
  falsifier: "A counterexample outside the proposed family.",
  expected_evidence: null,
  discriminating_predictions: [],
  origin: "proposed",
  body_md: "An immutable hypothesis publication.",
};

export async function appendEvidenceHypothesisFixture(db: D1Database, problem: string) {
  return writeLedgerEvent(
    db,
    {
      problemId: problem,
      eventId: `EV-${problem}-H-1`,
      idempotencyKey: `fixture-${problem}-H-1`,
      requestDigest: "a".repeat(64),
      eventType: "hypothesis.created",
      objectKind: "hypothesis",
      objectId: "H-1",
      objectVersion: 1,
      createdAt: EVIDENCE_LIST_TIME,
      payloadJson: JSON.stringify(EVIDENCE_HYPOTHESIS_PAYLOAD),
      attribution: EVIDENCE_LIST_ATTRIBUTION,
    },
    {
      statementsAfterEvent: (context) => [
        db
          .prepare(`INSERT INTO hypotheses
          (hypothesis_id,problem_id,route,mechanism,falsifier,origin,author_fellow_id,
          created_at,source_event_id,source_seq)
          VALUES('H-1',?,?,?,?,'proposed',?,?,?,?)`)
          .bind(
            problem,
            EVIDENCE_HYPOTHESIS_PAYLOAD.route,
            EVIDENCE_HYPOTHESIS_PAYLOAD.mechanism,
            EVIDENCE_HYPOTHESIS_PAYLOAD.falsifier,
            EVIDENCE_LIST_ATTRIBUTION.fellowId,
            EVIDENCE_LIST_TIME,
            context.eventId,
            context.sequence,
          ),
      ],
    },
  );
}
