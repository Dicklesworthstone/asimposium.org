import { z } from "zod";

/**
 * Move Templates contract and registry (Fable §9.4, ADR-24).
 *
 * A move is a typed next action with its contract attached, schema prefilled
 * where possible. `/v1/p/:id/next`, `triage`, and every `working` pack return
 * one primary move and <= 2 alternatives.
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

export const MoveTemplateSchema = z.object({
  move: MoveKindSchema,
  title: z.string().min(1).max(128),
  trigger: z.string().min(1).max(256),
  description: z.string().min(1).max(512),
  target_contract: z.string().min(1).max(256),
  required_fields: z.array(z.string()).min(1),
  prefilled_hints: z.record(z.string(), z.unknown()).default({}),
});

export type MoveTemplate = z.infer<typeof MoveTemplateSchema>;

export const MoveTemplatesDocSchema = z.object({
  version: z.literal("0.1.0-draft"),
  schema: z.literal(MOVES_SCHEMA_ID),
  moves: z.record(MoveKindSchema, MoveTemplateSchema),
});

export type MoveTemplatesDoc = z.infer<typeof MoveTemplatesDocSchema>;

export const MOVE_TEMPLATES: Record<MoveKind, MoveTemplate> = {
  "sharpen-statement": {
    move: "sharpen-statement",
    title: "Sharpen Statement",
    trigger: "Statement lacks a falsifier or has been flagged as sloppy/loose.",
    description:
      "Refine the statement to bind quantifiers, state regimes, and define falsifiers before other promotion proceeds.",
    target_contract: "https://a.asimposium.org/schemas/problem.v1.json",
    required_fields: ["statement", "falsifier", "regime"],
    prefilled_hints: {},
  },
  "state-claim": {
    move: "state-claim",
    title: "State Claim",
    trigger: "No open claims exist on this problem.",
    description:
      "State a self-contained conjecture, theorem-attempt, counterexample-claim, or bound.",
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["kind", "statement", "falsifier"],
    prefilled_hints: { kind: "conjecture" },
  },
  "add-refuter": {
    move: "add-refuter",
    title: "Add Refuter",
    trigger: "A claim has support but zero recorded refutation attempts.",
    description:
      "Attempt to refute a supported claim; corroborated status requires at least one recorded refutation attempt.",
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["target_claim_id", "direction", "basis", "body_md"],
    prefilled_hints: { direction: "refutes" },
  },
  review: {
    move: "review",
    title: "Epistemic Review",
    trigger: "Unreviewed promoted claim where the requester is not the author.",
    description:
      "Independently review a claim with domain rubric lines and capable-of-failure disclosure.",
    target_contract: "https://a.asimposium.org/schemas/sessions.v1.json",
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
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["statement", "falsifier", "origin"],
    prefilled_hints: { origin: "third-alternative" },
  },
  discriminate: {
    move: "discriminate",
    title: "Strong Inference Discrimination",
    trigger:
      "Several live hypotheses fit all current evidence and no pending test separates them.",
    description:
      "Propose or run a discriminating test whose predicted outcomes diverge across surviving hypotheses.",
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["bears_on", "divergence_rationale", "body_md"],
    prefilled_hints: {},
  },
  "kill-or-stand": {
    move: "kill-or-stand",
    title: "Kill or Stand",
    trigger: "A hypothesis falsifier appears fired in evidence.",
    description:
      "Withdraw the hypothesis acknowledging the refutation, or record a written defense explaining why the test missed.",
    target_contract: "https://a.asimposium.org/schemas/sessions.v1.json",
    required_fields: ["hypothesis_id", "action", "reason"],
    prefilled_hints: {},
  },
  "collapse-duplicate": {
    move: "collapse-duplicate",
    title: "Collapse Duplicate",
    trigger: "Near-duplicate claims flagged by embedding search or P11 rule.",
    description:
      "Link or merge duplicate claims to unify review effort and prevent fragmentation.",
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["source_claim_id", "target_claim_id", "relation_kind"],
    prefilled_hints: { relation_kind: "equivalent-to" },
  },
  "re-anchor": {
    move: "re-anchor",
    title: "Re-anchor Claim",
    trigger: "Statement revision minted S@n+1, drifting from older claim versions.",
    description:
      "Update a claim to bind to the revised active problem statement version.",
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["claim_id", "target_statement_version", "adaptations"],
    prefilled_hints: {},
  },
  "record-dead-end": {
    move: "record-dead-end",
    title: "Record Dead End",
    trigger: "Three supporting anecdotes without a new class, or an exhausted negative route.",
    description:
      "Record an honest null result as a permanent dead end with structured retry_when conditions.",
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["approach", "outcome", "retry_when", "body_md"],
    prefilled_hints: {},
  },
  synthesize: {
    move: "synthesize",
    title: "Synthesize Problem State",
    trigger: "200+ events recorded since the last synthesis.",
    description:
      "Synthesize active hypotheses, established bounds, and open gaps across all contributors.",
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["active_hypotheses", "open_gaps", "summary_md"],
    prefilled_hints: {},
  },
  formalize: {
    move: "formalize",
    title: "Formalize Load-Bearing Claim",
    trigger:
      "Load-bearing claim with dependents in the claim DAG, self-contained statement, and corroborated disposition.",
    description:
      "Target formal verification (e.g. Lean 4) at load-bearing claims rather than trivial lemmas.",
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["claim_id", "formal_language", "artifact_hash"],
    prefilled_hints: { formal_language: "lean4" },
  },
  "add-refuter-from-friction": {
    move: "add-refuter-from-friction",
    title: "Refute from Formalization Friction",
    trigger: "Friction report contains counterexample-scent or statement-too-strong.",
    description:
      "Construct a concrete counterexample seeded by reported formalization friction.",
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["claim_id", "friction_event_id", "counterexample_md"],
    prefilled_hints: { direction: "refutes" },
  },
  "close-gap": {
    move: "close-gap",
    title: "Close Proof Gap",
    trigger: "An open proof gap G-n has no active lease or owner.",
    description:
      "Discharge the exact missing deduction step stated in an open proof gap.",
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["gap_id", "discharging_claim_id", "proof_md"],
    prefilled_hints: {},
  },
  "normalize-conflict": {
    move: "normalize-conflict",
    title: "Normalize Apparent Conflict",
    trigger: "Two claims look incompatible but no conflict object CF-n exists.",
    description:
      "Walk through definition, scope, and quantifier alignment before opening a formal dispute.",
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["claim_a", "claim_b", "scope_alignment", "definition_alignment"],
    prefilled_hints: {},
  },
  "retry-dead-end": {
    move: "retry-dead-end",
    title: "Retry Dead End",
    trigger:
      "A dead end's retry_when trigger fired: blocking claim resolved, statement revised, or gap closed.",
    description:
      "Re-evaluate a previously abandoned route whose blocking condition has now cleared.",
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["dead_end_id", "trigger_event_id", "reopened_approach"],
    prefilled_hints: {},
  },
  "back-to-the-object": {
    move: "back-to-the-object",
    title: "Back to the Object",
    trigger: "Many recent events without an object-level increment (ceremony breaker).",
    description:
      "Redirect focus away from process commentary and back to the oldest open object-level need.",
    target_contract: "https://a.asimposium.org/schemas/ledger.v1.json",
    required_fields: ["object_target", "concrete_increment_md"],
    prefilled_hints: {},
  },
  "idle-close": {
    move: "idle-close",
    title: "Idle Session Close",
    trigger: "Open session with 3+ hours of quiet.",
    description:
      "Close an idle session with a handback to free working leases and preserve workshop progress.",
    target_contract: "https://a.asimposium.org/schemas/sessions.v1.json",
    required_fields: ["session_id", "handback_summary"],
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
    moves: MOVE_TEMPLATES,
  };
}
