import type { HypothesisEvidenceItemResponse } from "@asimposium/contracts";
import type { DiscriminationReport } from "@asimposium/contracts/discrimination";
import { stableStringify } from "./canonical.ts";

/** Bind a schema-decoded report to the evidence publication that carries it.
 * A JSON-looking body alone cannot acquire this presentation. In particular,
 * a report copied onto another target, source or observation mode is not a
 * coherent experiment view. This is representation checking, not verification
 * that the reported experiment happened or the other cases were published. */
export function discriminationReadback(
  face: HypothesisEvidenceItemResponse,
  report: DiscriminationReport | null,
) {
  const evidence = face.content;
  if (report === null || evidence === null || face.computed === null) return null;
  // The parser owns shape validation; this comparison owns the distinct rule
  // that a caller cannot pair a decoded report with another published body.
  // Object key order is irrelevant, but array order and scientific text are not.
  if (evidence.body_md.length > 64 * 1024) return null;
  try {
    if (stableStringify(JSON.parse(evidence.body_md)) !== stableStringify(report)) return null;
  } catch {
    return null;
  }
  const target = report.work.cases.filter((item) => item.hypothesis_id === face.bears_on.id);
  const reproduction = evidence.reproduction;
  const reportedReproduction = report.reproduction;
  const sameReproduction = reproduction === undefined
    ? reportedReproduction === undefined
    : reportedReproduction !== undefined &&
      reproduction.environment === reportedReproduction.environment &&
      reproduction.seed === reportedReproduction.seed &&
      reproduction.commands.length === reportedReproduction.commands.length &&
      reproduction.commands.every((command, index) => command === reportedReproduction.commands[index]);
  if (
    report.problem_id !== face.problem_id ||
    evidence.bears_on_kind !== "hypothesis" || evidence.bears_on_id !== face.bears_on.id ||
    target.length !== 1 || target[0]?.direction !== evidence.direction ||
    report.kind !== evidence.kind || report.mode !== evidence.mode ||
    report.source.kind !== evidence.source.kind ||
    report.source.locator !== evidence.source.locator ||
    report.source.excerpt !== evidence.source.excerpt ||
    report.selected_hypothesis_id !== evidence.selected_hypothesis_id ||
    report.computation_domain_or_floor !== evidence.computation_domain_or_floor ||
    !sameReproduction
  ) return null;

  return {
    record_kind: "author-reported experiment comparison" as const,
    // Only this publication is established by the enclosing canonical face.
    publication: {
      evidence_id: face.evidence_id,
      problem_id: face.problem_id,
      hypothesis_id: face.bears_on.id,
      event_id: face.publication.event_id,
      seq: face.publication.seq,
      payload_sha256: face.publication.payload_sha256,
      withdrawn: face.withdrawn,
    },
    observation_mode: evidence.mode,
    prediction_timing_self_declared: report.work.prediction_timing_self_declared,
    selected_hypothesis_id: report.selected_hypothesis_id ?? null,
    question: report.work.question,
    protocol: report.work.protocol,
    observation: report.work.observation,
    limitations: report.work.limitations,
    comparisons: report.work.cases.map((item) => ({
      hypothesis_id: item.hypothesis_id,
      is_this_evidence_target: item.hypothesis_id === face.bears_on.id,
      prediction: item.prediction,
      would_count_against: item.would_count_against,
      direction_reported_by_author: item.direction,
      interpretation: item.interpretation,
    })),
    source: { ...report.source },
    reproduction: reportedReproduction === undefined ? null : {
      ...reportedReproduction,
      commands: [...reportedReproduction.commands],
    },
    computation_domain_or_floor: report.computation_domain_or_floor ?? null,
  };
}

export const DISCRIMINATION_READBACK_BOUNDARY =
  "One author-reported experiment, not independent replications or a platform execution result. Prediction timing is self-declared. Only the named evidence publication is established here; the other comparison rows are declarations in its body, not proof of separate publications, current hypothesis status or scientific agreement. A withdrawal remains in force.";
export const DISCRIMINATION_READBACK_MAX_BYTES = 48 * 1024;
