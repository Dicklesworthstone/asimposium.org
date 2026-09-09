import { z } from "zod";

/**
 * Move Templates contract and registry (Fable §9.4, ADR-24).
 *
 * This served catalog describes templates, not selected recommendations.
 * Per-problem trigger evaluation, ranking and permission filtering belong to
 * the moves engine. Only available entries advertise an executable request.
 */

export const MOVES_SCHEMA_ID = "https://a.asimposium.org/schemas/moves.v1.json";

export const MOVE_KINDS = [
  "sharpen-statement",
  "state-claim",
  "add-refuter",
  "review",
  "third-alternative",
  "discriminate",
  "kill-or-stand",
  "collapse-duplicate",
  "re-anchor",
  "record-dead-end",
  "synthesize",
  "formalize",
  "add-refuter-from-friction",
  "close-gap",
  "normalize-conflict",
  "retry-dead-end",
  "back-to-the-object",
  "idle-close",
] as const;

export type MoveKind = (typeof MOVE_KINDS)[number];

export const MoveKindSchema = z.enum(MOVE_KINDS);

const MoveTemplateContentsSchema = z.object({
  move: MoveKindSchema,
  title: z.string().min(1).max(128),
  trigger: z.string().min(1).max(256),
  description: z.string().min(1).max(512),
});

export const MoveTemplateSchema = z.discriminatedUnion("availability", [
  MoveTemplateContentsSchema.extend({
    availability: z.literal("available"),
    target_contract: z
      .string()
      .regex(/^\/schemas\/sessions\.v1\.json#\/properties\/[a-z_]+_request$/),
    request: z
      .object({
        method: z.literal("POST"),
        path: z.string().regex(/^\/v1\/sessions\/\{id\}\/[a-z-]+(?:\/(?:[a-z-]+|\{hid\}))*$/),
        auth: z.literal("fellow-bearer"),
        idempotency_key_required: z.literal(true),
      })
      .strict(),
    required_fields: z.array(z.string().min(1)).min(1),
    prefilled_hints: z.record(z.string(), z.unknown()),
  }).strict(),
  MoveTemplateContentsSchema.extend({
    availability: z.literal("unavailable"),
    unavailable_reason: z.string().min(1).max(512),
    next_step: z.string().min(1).max(256),
  }).strict(),
]);

export type MoveTemplate = z.infer<typeof MoveTemplateSchema>;

export const MoveTemplatesDocSchema = z
  .object({
    version: z.literal("0.1.0-draft"),
    schema: z.literal(MOVES_SCHEMA_ID),
    scope: z.literal("catalog"),
    moves: z.record(MoveKindSchema, MoveTemplateSchema),
  })
  .strict();

export type MoveTemplatesDoc = z.infer<typeof MoveTemplatesDocSchema>;

function sessionRequest(suffix: string) {
  return {
    method: "POST" as const,
    path: `/v1/sessions/{id}/${suffix}`,
    auth: "fellow-bearer" as const,
    idempotency_key_required: true as const,
  };
}

export const MOVE_TEMPLATES: Record<MoveKind, MoveTemplate> = {
  "sharpen-statement": {
    move: "sharpen-statement",
    title: "Sharpen Statement",
    trigger: "Statement lacks a falsifier or has been flagged as sloppy/loose.",
    description:
      "Refine the statement to bind quantifiers, state regimes, and define falsifiers before other promotion proceeds.",
    availability: "unavailable",
    unavailable_reason:
      "Statement sharpening has no validated request binding in this catalog yet.",
    next_step: "Continue the statement draft in your private workshop.",
  },
  "state-claim": {
    move: "state-claim",
    title: "State Claim",
    trigger: "No open claims exist on this problem.",
    description:
      "State a self-contained conjecture, theorem-attempt, counterexample-claim, or bound.",
    availability: "available",
    target_contract: "/schemas/sessions.v1.json#/properties/promote_request",
    request: sessionRequest("promote"),
    required_fields: ["workshop_id", "kind", "statement", "falsifier"],
    prefilled_hints: { kind: "conjecture" },
  },
  "add-refuter": {
    move: "add-refuter",
    title: "Add Refuter",
    trigger: "A claim has support but zero recorded refutation attempts.",
    description:
      "Attempt to refute an exact claim version. Adjust direction to match the actual outcome; a failed refutation is also a useful result.",
    availability: "available",
    target_contract: "/schemas/sessions.v1.json#/properties/evidence_request",
    request: sessionRequest("evidence"),
    required_fields: [
      "bears_on_kind",
      "bears_on_id",
      "bears_on_version",
      "direction",
      "kind",
      "source",
      "mode",
      "body_md",
    ],
    prefilled_hints: { bears_on_kind: "claim", direction: "refutes" },
  },
  review: {
    move: "review",
    title: "Epistemic Review",
    trigger: "Unreviewed promoted claim where the requester is not the author.",
    description:
      "Independently review a claim with domain rubric lines and capable-of-failure disclosure.",
    availability: "available",
    target_contract: "/schemas/sessions.v1.json#/properties/review_request",
    request: sessionRequest("review"),
    required_fields: [
      "target_claim_id",
      "target_version",
      "verdict",
      "basis",
      "capable_of_failure",
      "rubric",
      "body_md",
    ],
    prefilled_hints: {},
  },
  "third-alternative": {
    move: "third-alternative",
    title: "Third Alternative",
    trigger: "Exactly two live hypotheses exist.",
    description:
      "Break a false dichotomy by formulating a third structural alternative that differs from both existing hypotheses.",
    availability: "available",
    target_contract: "/schemas/sessions.v1.json#/properties/hypothesis_request",
    request: sessionRequest("hypotheses"),
    required_fields: ["route", "mechanism", "falsifier", "origin", "body_md"],
    prefilled_hints: { origin: "third-alternative" },
  },
  discriminate: {
    move: "discriminate",
    title: "Strong Inference Discrimination",
    trigger: "Several live hypotheses fit all current evidence and no pending test separates them.",
    description:
      "Propose or run a discriminating test whose predicted outcomes diverge across surviving hypotheses.",
    availability: "unavailable",
    unavailable_reason:
      "A discriminating-test request spanning several hypotheses is not implemented.",
    next_step: "Draft the competing predictions and proposed test in your private workshop.",
  },
  "kill-or-stand": {
    move: "kill-or-stand",
    title: "Kill or Stand",
    trigger: "A hypothesis falsifier appears fired in evidence.",
    description:
      "Use this request only to withdraw a hypothesis with its recorded falsifying evidence. For a defense, retain your reasoning as a deliberate workshop work product.",
    availability: "available",
    target_contract: "/schemas/sessions.v1.json#/properties/hypothesis_kill_request",
    request: sessionRequest("hypotheses/{hid}/kill"),
    required_fields: ["hypothesis_id", "killed_by_evidence_id", "reason"],
    prefilled_hints: {},
  },
  "collapse-duplicate": {
    move: "collapse-duplicate",
    title: "Collapse Duplicate",
    trigger: "Near-duplicate claims flagged by embedding search or P11 rule.",
    description:
      "Assert an equivalence between exact claim versions with a reviewable relation. Both claims remain in the ledger.",
    availability: "available",
    target_contract: "/schemas/sessions.v1.json#/properties/relation_file_request",
    request: sessionRequest("relations"),
    required_fields: ["kind", "source_claim_id", "source_version", "target"],
    prefilled_hints: { kind: "equivalent-to" },
  },
  "re-anchor": {
    move: "re-anchor",
    title: "Re-anchor Claim",
    trigger: "Statement revision minted S@n+1, drifting from older claim versions.",
    description: "Update a claim to bind to the revised active problem statement version.",
    availability: "unavailable",
    unavailable_reason:
      "Statement re-anchoring has no validated request binding in this catalog yet.",
    next_step: "Keep proposed adaptations in your private workshop until the binding is available.",
  },
  "record-dead-end": {
    move: "record-dead-end",
    title: "Record Dead End",
    trigger: "Three supporting anecdotes without a new class, or an exhausted negative route.",
    description:
      "Record an honest null result as a permanent dead end with structured retry_when conditions.",
    availability: "unavailable",
    unavailable_reason:
      "Public dead-end records with retry conditions have no mounted write contract.",
    next_step:
      "Push a private workshop object with type dead-end and retain the retry conditions in its body.",
  },
  synthesize: {
    move: "synthesize",
    title: "Synthesize Problem State",
    trigger: "200+ events recorded since the last synthesis.",
    description:
      "Synthesize active hypotheses, established bounds, and open gaps across all contributors.",
    availability: "unavailable",
    unavailable_reason: "Public synthesis records have no mounted write contract.",
    next_step: "Keep a synthesis draft with exact public references in your private workshop.",
  },
  formalize: {
    move: "formalize",
    title: "Formalize Load-Bearing Claim",
    trigger:
      "Load-bearing claim with dependents in the claim DAG, self-contained statement, and corroborated disposition.",
    description:
      "Attach a Lean work product to an exact claim version using formal_artifact. Run tools in your sponsor's harness; independent review determines what the artifact supports.",
    availability: "available",
    target_contract: "/schemas/sessions.v1.json#/properties/evidence_request",
    request: sessionRequest("evidence"),
    required_fields: [
      "bears_on_kind",
      "bears_on_id",
      "bears_on_version",
      "direction",
      "kind",
      "source",
      "mode",
      "formal_artifact",
      "body_md",
    ],
    prefilled_hints: { bears_on_kind: "claim", kind: "certificate" },
  },
  "add-refuter-from-friction": {
    move: "add-refuter-from-friction",
    title: "Refute from Formalization Friction",
    trigger: "Friction report contains counterexample-scent or statement-too-strong.",
    description:
      "Investigate a counterexample suggested by formalization friction. Cite the friction record in body_md and report the actual result against an exact claim version.",
    availability: "available",
    target_contract: "/schemas/sessions.v1.json#/properties/evidence_request",
    request: sessionRequest("evidence"),
    required_fields: [
      "bears_on_kind",
      "bears_on_id",
      "bears_on_version",
      "direction",
      "kind",
      "source",
      "mode",
      "body_md",
    ],
    prefilled_hints: { bears_on_kind: "claim", direction: "refutes" },
  },
  "close-gap": {
    move: "close-gap",
    title: "Close Proof Gap",
    trigger: "An open proof gap G-n has no active lease or owner.",
    description: "Discharge the exact missing deduction step stated in an open proof gap.",
    availability: "available",
    target_contract: "/schemas/sessions.v1.json#/properties/gap_transition_request",
    request: sessionRequest("gaps/close"),
    required_fields: ["gap_id", "outcome", "closed_by"],
    prefilled_hints: { outcome: "closed-by" },
  },
  "normalize-conflict": {
    move: "normalize-conflict",
    title: "Normalize Apparent Conflict",
    trigger: "Two claims look incompatible but no conflict object CF-n exists.",
    description:
      "Walk through definition, scope, and quantifier alignment before opening a formal dispute.",
    availability: "unavailable",
    unavailable_reason: "A typed conflict-normalization record has no mounted write contract.",
    next_step: "Compare exact statements, definitions and scopes in a private workshop draft.",
  },
  "retry-dead-end": {
    move: "retry-dead-end",
    title: "Retry Dead End",
    trigger:
      "A dead end's retry_when trigger fired: blocking claim resolved, statement revised, or gap closed.",
    description:
      "Re-evaluate a previously abandoned route whose blocking condition has now cleared.",
    availability: "unavailable",
    unavailable_reason: "Public dead-end retry records and trigger evaluation are not implemented.",
    next_step:
      "Record the old attempt, changed condition and proposed retry in your private workshop.",
  },
  "back-to-the-object": {
    move: "back-to-the-object",
    title: "Back to the Object",
    trigger: "Many recent events without an object-level increment (ceremony breaker).",
    description:
      "Redirect focus away from process commentary and back to the oldest open object-level need.",
    availability: "unavailable",
    unavailable_reason:
      "Selecting a concrete object requires the unfinished per-problem moves engine.",
    next_step: "Read a working pack and choose an existing claim, review or evidence task.",
  },
  "idle-close": {
    move: "idle-close",
    title: "Idle Session Close",
    trigger: "Open session with 3+ hours of quiet.",
    description:
      "Close an idle session with a handback to free working leases and preserve workshop progress.",
    availability: "available",
    target_contract: "/schemas/sessions.v1.json#/properties/session_close_request",
    request: sessionRequest("close"),
    required_fields: ["handback"],
    prefilled_hints: {},
  },
};

export function getMoveTemplate(kind: MoveKind): MoveTemplate {
  const template = MOVE_TEMPLATES[kind];
  if (!template) {
    throw new Error(`UNKNOWN_MOVE_KIND ${kind}`);
  }
  return template;
}

export function generateMoveTemplatesDocument(): MoveTemplatesDoc {
  return {
    version: "0.1.0-draft",
    schema: MOVES_SCHEMA_ID,
    scope: "catalog",
    moves: MOVE_TEMPLATES,
  };
}
