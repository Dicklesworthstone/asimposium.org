import {
  type ProblemFamousGuardrail,
  type SaveProblemBriefRequest,
  SaveProblemBriefRequestSchema,
  type SponsorProblemBrief,
} from "@asimposium/contracts";

export interface ProblemBriefFields {
  readonly title: string;
  readonly statement: string;
  readonly falsifier: string;
  readonly motivation: string;
  readonly scope?: string;
  readonly outOfScope?: string;
  readonly successCriteria?: string;
  readonly areas: string;
  readonly assignedFellowId: string;
  readonly famousGuardrail?: ProblemFamousGuardrail;
}

export type ProblemBriefEditSource = Pick<SponsorProblemBrief, "id" | "version">;

export const PROBLEM_BRIEF_FORM_ERROR =
  "Give a title, statement, falsifier, motivation and at least one area. Complete all three research boundaries together. If a famous-problem guardrail is included, complete its formulation, distinctions, references and standing banner.";

/** Keep every authored field intact when opening an existing private brief. */
export function problemBriefFields(
  brief?: SponsorProblemBrief,
  defaultAssignee = "",
): ProblemBriefFields {
  return {
    title: brief?.title ?? "",
    statement: brief?.statement ?? "",
    falsifier: brief?.falsifier ?? "",
    motivation: brief?.motivation ?? "",
    scope: brief?.scope ?? "",
    outOfScope: brief?.out_of_scope ?? "",
    successCriteria: brief?.success_criteria ?? "",
    areas: brief?.areas.join(", ") ?? "",
    assignedFellowId: brief === undefined ? defaultAssignee : (brief.assigned_fellow_id ?? ""),
    ...(brief?.famous_guardrail === undefined
      ? {}
      : { famousGuardrail: structuredClone(brief.famous_guardrail) }),
  };
}

/** The same contract shapes create and edit; an edit pins the version reviewed. */
export function problemBriefRequest(
  input: ProblemBriefFields,
  source?: ProblemBriefEditSource,
): SaveProblemBriefRequest | null {
  const areas = input.areas
    .split(",")
    .map((area) => area.trim().toLowerCase())
    .filter((area) => area.length > 0);
  const boundaries = {
    scope: input.scope,
    out_of_scope: input.outOfScope,
    success_criteria: input.successCriteria,
  };
  const hasBoundaries = Object.values(boundaries).some(
    (value) => value !== undefined && value !== "",
  );
  // Opening an editor must not normalize scientific text the sponsor did not
  // change. New briefs retain the console's existing trimming behavior.
  const text = (value: string) => (source === undefined ? value.trim() : value);
  if (
    [input.title, input.statement, input.falsifier, input.motivation].some(
      (value) => value.trim().length === 0,
    )
  )
    return null;
  const parsed = SaveProblemBriefRequestSchema.safeParse({
    ...(source === undefined ? {} : { id: source.id, expected_version: source.version }),
    title: text(input.title),
    statement: text(input.statement),
    falsifier: text(input.falsifier),
    motivation: text(input.motivation),
    ...(hasBoundaries ? boundaries : {}),
    areas,
    ...(input.assignedFellowId === "" ? {} : { assigned_fellow_id: input.assignedFellowId }),
    ...(input.famousGuardrail === undefined ? {} : { famous_guardrail: input.famousGuardrail }),
  });
  return parsed.success ? parsed.data : null;
}

export const BRIEF_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

export type ProblemBriefCommand =
  | { readonly kind: "save"; readonly request: SaveProblemBriefRequest }
  | { readonly kind: "withdraw"; readonly id: string; readonly expectedVersion: number };

export interface ProblemBriefAttempt {
  readonly command: ProblemBriefCommand;
  readonly key: string;
  readonly startedAt: number;
}

/** A retry owns a detached copy, never the fields the sponsor continues editing. */
export function problemBriefAttempt(
  command: ProblemBriefCommand,
  key: string,
  startedAt = Date.now(),
): ProblemBriefAttempt {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(key) || !Number.isSafeInteger(startedAt) || startedAt < 0) {
    throw new Error("Invalid private-brief attempt");
  }
  return { command: structuredClone(command), key, startedAt };
}

export function problemBriefAttemptExpired(
  attempt: ProblemBriefAttempt,
  now = Date.now(),
): boolean {
  return (
    !Number.isSafeInteger(now) ||
    now < attempt.startedAt ||
    now - attempt.startedAt >= BRIEF_RETRY_WINDOW_MS
  );
}
