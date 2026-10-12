import type { DiscriminationRequest } from "./discrimination.ts";

export const DISCRIMINATION_SCHEMA_ID = "https://a.asimposium.org/schemas/discrimination.v1.json";
export const DISCRIMINATION_FORMAT = "asimposium.discrimination.v1";
export const DISCRIMINATION_MAX_TARGETS = 8;
export const DISCRIMINATION_REQUEST_MAX_BYTES = 32 * 1024;
export const DISCRIMINATION_BATCH_MAX_BYTES = 256 * 1024;

/** Domain checks shared by the Zod request and the retained report reader.
 * Distinct strings are not proof that predictions actually discriminate. */
export function discriminationIssues(input: {
  mode: string;
  selected_hypothesis_id?: string;
  work: {
    prediction_timing_self_declared: string;
    cases: readonly { hypothesis_id: string; prediction: string }[];
  };
}): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const ids = new Set<string>();
  const predictions = new Set<string>();
  input.work.cases.forEach((item, index) => {
    if (ids.has(item.hypothesis_id)) {
      issues.push({
        path: ["work", "cases", index, "hypothesis_id"],
        message: "Each hypothesis may appear only once in an experiment.",
      });
    }
    ids.add(item.hypothesis_id);
    predictions.add(item.prediction.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim());
  });
  if (predictions.size < 2) {
    issues.push({
      path: ["work", "cases"],
      message: "State at least two different predicted outcomes, not repeated measurements all routes predict.",
    });
  }
  if (input.work.prediction_timing_self_declared === "after-observation" && input.mode !== "exploratory") {
    issues.push({
      path: ["mode"],
      message: "Predictions reconstructed after observing the result are exploratory, not a confirmatory test.",
    });
  }
  if (input.selected_hypothesis_id !== undefined) {
    if (!ids.has(input.selected_hypothesis_id)) {
      issues.push({ path: ["selected_hypothesis_id"], message: "The selected hypothesis must be one of the reported cases." });
    }
    if (input.mode !== "exploratory") {
      issues.push({ path: ["mode"], message: "Evidence used to select a hypothesis is exploratory; report an independent confirmatory test separately." });
    }
  }
  return issues;
}

/** Serialize one deliberately authored experiment, then attach the SAME report
 * to each target. These members are not independent replications. No direction,
 * source, observation, result or certification is invented by the adapter.
 * Input and output validation belong to discriminationBatchRequest. */
export function discriminationMembers(problemId: string, request: DiscriminationRequest) {
  const report = JSON.stringify({
    format: DISCRIMINATION_FORMAT,
    problem_id: problemId,
    kind: request.kind,
    source: request.source,
    mode: request.mode,
    ...(request.reproduction === undefined ? {} : { reproduction: request.reproduction }),
    ...(request.computation_domain_or_floor === undefined ? {} : { computation_domain_or_floor: request.computation_domain_or_floor }),
    ...(request.selected_hypothesis_id === undefined ? {} : { selected_hypothesis_id: request.selected_hypothesis_id }),
    work: request.work,
  });
  return request.work.cases.map((item) => ({
    tempId: `tmp:discriminate-${item.hypothesis_id}`,
    causedBy: [],
    action: "evidence" as const,
    data: {
      bears_on_kind: "hypothesis" as const,
      bears_on_id: item.hypothesis_id,
      direction: item.direction,
      kind: request.kind,
      source: request.source,
      mode: request.mode,
      ...(request.reproduction === undefined ? {} : { reproduction: request.reproduction }),
      ...(request.computation_domain_or_floor === undefined ? {} : { computation_domain_or_floor: request.computation_domain_or_floor }),
      ...(request.selected_hypothesis_id === undefined ? {} : { selected_hypothesis_id: request.selected_hypothesis_id }),
      body_md: report,
    },
  }));
}
