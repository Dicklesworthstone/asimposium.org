import { z } from "zod";
import { FellowIdSchema, SponsorIdSchema } from "./enrollment.ts";
import { ProblemIdSchema } from "./sessions.ts";

/**
 * Director Grammar (Fable §8.2, Bead asimposiumorg-0i9).
 *
 * Closed verb set for human steering through the single write path.
 * Syntax:
 *   assign <fellow> <problem> [as <role>]
 *   focus <fellow> <text≤500>
 *   forbid <fellow> <text≤500>
 *   unfocus <fellow>
 *   pause <fellow>
 *   resume <fellow>
 *   revoke <fellow>
 *   transfer <fellow> <sponsor>
 *   publish <problem>
 *   hide <problem> <reason>
 *   cap <problem> <n≤16>
 */

export const DIRECTOR_GRAMMAR_VERBS = [
  "assign",
  "focus",
  "forbid",
  "unfocus",
  "pause",
  "resume",
  "revoke",
  "transfer",
  "publish",
  "hide",
  "cap",
] as const;

export type DirectorGrammarVerb = (typeof DIRECTOR_GRAMMAR_VERBS)[number];
export const DirectorGrammarVerbSchema = z.enum(DIRECTOR_GRAMMAR_VERBS);

export const DIRECTOR_ROLE_KINDS = ["worker", "critic", "investigator", "synthesizer"] as const;
export type DirectorRoleKind = (typeof DIRECTOR_ROLE_KINDS)[number];
export const DirectorRoleKindSchema = z.enum(DIRECTOR_ROLE_KINDS);

export const MAX_DIRECTIVE_TEXT_LENGTH = 500;
export const MAX_PROBLEM_CAP = 16;
export const MIN_PROBLEM_CAP = 1;

export const DirectorAssignCommandSchema = z
  .object({
    verb: z.literal("assign"),
    fellow_id: FellowIdSchema,
    problem_id: ProblemIdSchema,
    role: DirectorRoleKindSchema.optional(),
  })
  .strict();
export type DirectorAssignCommand = z.infer<typeof DirectorAssignCommandSchema>;

export const DirectorFocusCommandSchema = z
  .object({
    verb: z.literal("focus"),
    fellow_id: FellowIdSchema,
    text: z.string().trim().min(1).max(MAX_DIRECTIVE_TEXT_LENGTH),
  })
  .strict();
export type DirectorFocusCommand = z.infer<typeof DirectorFocusCommandSchema>;

export const DirectorForbidCommandSchema = z
  .object({
    verb: z.literal("forbid"),
    fellow_id: FellowIdSchema,
    text: z.string().trim().min(1).max(MAX_DIRECTIVE_TEXT_LENGTH),
  })
  .strict();
export type DirectorForbidCommand = z.infer<typeof DirectorForbidCommandSchema>;

export const DirectorUnfocusCommandSchema = z
  .object({
    verb: z.literal("unfocus"),
    fellow_id: FellowIdSchema,
  })
  .strict();
export type DirectorUnfocusCommand = z.infer<typeof DirectorUnfocusCommandSchema>;

export const DirectorPauseCommandSchema = z
  .object({
    verb: z.literal("pause"),
    fellow_id: FellowIdSchema,
  })
  .strict();
export type DirectorPauseCommand = z.infer<typeof DirectorPauseCommandSchema>;

export const DirectorResumeCommandSchema = z
  .object({
    verb: z.literal("resume"),
    fellow_id: FellowIdSchema,
  })
  .strict();
export type DirectorResumeCommand = z.infer<typeof DirectorResumeCommandSchema>;

export const DirectorRevokeCommandSchema = z
  .object({
    verb: z.literal("revoke"),
    fellow_id: FellowIdSchema,
  })
  .strict();
export type DirectorRevokeCommand = z.infer<typeof DirectorRevokeCommandSchema>;

export const DirectorTransferCommandSchema = z
  .object({
    verb: z.literal("transfer"),
    fellow_id: FellowIdSchema,
    target_sponsor_id: SponsorIdSchema,
  })
  .strict();
export type DirectorTransferCommand = z.infer<typeof DirectorTransferCommandSchema>;

export const DirectorPublishCommandSchema = z
  .object({
    verb: z.literal("publish"),
    problem_id: ProblemIdSchema,
  })
  .strict();
export type DirectorPublishCommand = z.infer<typeof DirectorPublishCommandSchema>;

export const DirectorHideCommandSchema = z
  .object({
    verb: z.literal("hide"),
    problem_id: ProblemIdSchema,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type DirectorHideCommand = z.infer<typeof DirectorHideCommandSchema>;

export const DirectorCapCommandSchema = z
  .object({
    verb: z.literal("cap"),
    problem_id: ProblemIdSchema,
    limit: z.number().int().min(MIN_PROBLEM_CAP).max(MAX_PROBLEM_CAP),
  })
  .strict();
export type DirectorCapCommand = z.infer<typeof DirectorCapCommandSchema>;

export const DirectorCommandSchema = z.discriminatedUnion("verb", [
  DirectorAssignCommandSchema,
  DirectorFocusCommandSchema,
  DirectorForbidCommandSchema,
  DirectorUnfocusCommandSchema,
  DirectorPauseCommandSchema,
  DirectorResumeCommandSchema,
  DirectorRevokeCommandSchema,
  DirectorTransferCommandSchema,
  DirectorPublishCommandSchema,
  DirectorHideCommandSchema,
  DirectorCapCommandSchema,
]);
export type DirectorCommand = z.infer<typeof DirectorCommandSchema>;

export type DirectorParseSuccess = {
  readonly ok: true;
  readonly command: DirectorCommand;
  readonly raw: string;
};

export type DirectorParseFailure = {
  readonly ok: false;
  readonly code:
    | "EMPTY_COMMAND"
    | "UNKNOWN_DIRECTOR_VERB"
    | "INVALID_DIRECTOR_COMMAND"
    | "DIRECTIVE_TEXT_OVER_LIMIT"
    | "INVALID_PROBLEM_CAP";
  readonly message: string;
  readonly verbs: typeof DIRECTOR_GRAMMAR_VERBS;
  readonly hint?: string;
  readonly limit?: number;
  readonly actual?: number;
};

export type DirectorCommandParseResult = DirectorParseSuccess | DirectorParseFailure;

/**
 * Parses free text into a typed DirectorCommand.
 * When parsing fails, returns the supported verb set and actionable hint.
 */
export function parseDirectorCommand(input: string): DirectorCommandParseResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      code: "EMPTY_COMMAND",
      message: "Director command line is empty.",
      verbs: DIRECTOR_GRAMMAR_VERBS,
      hint: "Enter a directive verb followed by its arguments. Example: focus FEL-1234 Investigate lemma 3.1",
    };
  }

  // Split on whitespace into tokens
  const tokens = trimmed.split(/\s+/);
  const rawVerb = (tokens[0] ?? "").toLowerCase();

  if (!DIRECTOR_GRAMMAR_VERBS.includes(rawVerb as DirectorGrammarVerb)) {
    return {
      ok: false,
      code: "UNKNOWN_DIRECTOR_VERB",
      message: `Unknown directive verb "${tokens[0]}". Supported verbs: ${DIRECTOR_GRAMMAR_VERBS.join(", ")}.`,
      verbs: DIRECTOR_GRAMMAR_VERBS,
      hint: "Valid syntax: assign, focus, forbid, unfocus, pause, resume, revoke, transfer, publish, hide, cap.",
    };
  }

  const verb = rawVerb as DirectorGrammarVerb;

  switch (verb) {
    case "assign": {
      // assign <fellow> <problem> [as <role>]
      const fellowId = tokens[1];
      const problemId = tokens[2];
      if (!fellowId || !problemId) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: "assign requires <fellow> and <problem> arguments.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "assign <fellow> <problem> [as <role>]",
        };
      }

      let role: DirectorRoleKind | undefined;
      if (tokens.length > 3) {
        if (tokens[3]?.toLowerCase() === "as" && tokens[4]) {
          const roleToken = tokens[4].toLowerCase();
          if (DIRECTOR_ROLE_KINDS.includes(roleToken as DirectorRoleKind)) {
            role = roleToken as DirectorRoleKind;
          } else {
            return {
              ok: false,
              code: "INVALID_DIRECTOR_COMMAND",
              message: `Unknown role "${tokens[4]}". Allowed roles: ${DIRECTOR_ROLE_KINDS.join(", ")}.`,
              verbs: DIRECTOR_GRAMMAR_VERBS,
              hint: "assign <fellow> <problem> [as worker|critic|investigator|synthesizer]",
            };
          }
        } else {
          return {
            ok: false,
            code: "INVALID_DIRECTOR_COMMAND",
            message: "Unexpected extra arguments to assign.",
            verbs: DIRECTOR_GRAMMAR_VERBS,
            hint: "assign <fellow> <problem> [as <role>]",
          };
        }
      }

      const parsed = DirectorAssignCommandSchema.safeParse({
        verb: "assign",
        fellow_id: fellowId,
        problem_id: problemId,
        role,
      });
      if (!parsed.success) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: parsed.error.issues[0]?.message ?? "Invalid assign command arguments.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "assign <fellow> <problem> [as <role>]",
        };
      }
      return { ok: true, command: parsed.data, raw: trimmed };
    }

    case "focus":
    case "forbid": {
      // focus <fellow> <text≤500>
      // forbid <fellow> <text≤500>
      const fellowId = tokens[1];
      if (!fellowId) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: `${verb} requires <fellow> and directive text.`,
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: `${verb} <fellow> <text≤500>`,
        };
      }

      // Find the start index of the text portion after the fellow argument
      const firstTokenLen = tokens[0]?.length ?? 0;
      const secondTokenLen = tokens[1]?.length ?? 0;
      const afterFirst = trimmed.slice(firstTokenLen).trimStart();
      const text = afterFirst.slice(secondTokenLen).trim();

      if (text.length === 0) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: `${verb} requires directive text.`,
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: `${verb} <fellow> <text≤500>`,
        };
      }

      if (text.length > MAX_DIRECTIVE_TEXT_LENGTH) {
        return {
          ok: false,
          code: "DIRECTIVE_TEXT_OVER_LIMIT",
          message: `${verb} text capped at ${MAX_DIRECTIVE_TEXT_LENGTH} characters (received ${text.length}).`,
          verbs: DIRECTOR_GRAMMAR_VERBS,
          limit: MAX_DIRECTIVE_TEXT_LENGTH,
          actual: text.length,
          hint: `Shorten steering directive to under ${MAX_DIRECTIVE_TEXT_LENGTH} characters.`,
        };
      }

      const schema = verb === "focus" ? DirectorFocusCommandSchema : DirectorForbidCommandSchema;
      const parsed = schema.safeParse({
        verb,
        fellow_id: fellowId,
        text,
      });

      if (!parsed.success) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: parsed.error.issues[0]?.message ?? `Invalid ${verb} command arguments.`,
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: `${verb} <fellow> <text≤500>`,
        };
      }
      return { ok: true, command: parsed.data as DirectorCommand, raw: trimmed };
    }

    case "unfocus":
    case "pause":
    case "resume":
    case "revoke": {
      // unfocus <fellow>
      // pause <fellow>
      // resume <fellow>
      // revoke <fellow>
      const fellowId = tokens[1];
      if (!fellowId) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: `${verb} requires a <fellow> argument.`,
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: `${verb} <fellow>`,
        };
      }
      if (tokens.length > 2) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: `${verb} takes only a <fellow> argument, no additional text.`,
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: `${verb} <fellow>`,
        };
      }

      const schemas = {
        unfocus: DirectorUnfocusCommandSchema,
        pause: DirectorPauseCommandSchema,
        resume: DirectorResumeCommandSchema,
        revoke: DirectorRevokeCommandSchema,
      };
      const parsed = schemas[verb].safeParse({ verb, fellow_id: fellowId });
      if (!parsed.success) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: parsed.error.issues[0]?.message ?? `Invalid ${verb} fellow argument.`,
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: `${verb} <fellow>`,
        };
      }
      return { ok: true, command: parsed.data as DirectorCommand, raw: trimmed };
    }

    case "transfer": {
      // transfer <fellow> <sponsor>
      const fellowId = tokens[1];
      const targetSponsorId = tokens[2];
      if (!fellowId || !targetSponsorId) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: "transfer requires both <fellow> and <sponsor> arguments.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "transfer <fellow> <sponsor>",
        };
      }
      if (tokens.length > 3) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: "transfer takes only <fellow> and <sponsor> arguments.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "transfer <fellow> <sponsor>",
        };
      }
      const parsed = DirectorTransferCommandSchema.safeParse({
        verb: "transfer",
        fellow_id: fellowId,
        target_sponsor_id: targetSponsorId,
      });
      if (!parsed.success) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: parsed.error.issues[0]?.message ?? "Invalid transfer arguments.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "transfer <fellow> <sponsor>",
        };
      }
      return { ok: true, command: parsed.data, raw: trimmed };
    }

    case "publish": {
      // publish <problem>
      const problemId = tokens[1];
      if (!problemId) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: "publish requires a <problem> argument.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "publish <problem>",
        };
      }
      if (tokens.length > 2) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: "publish takes only a <problem> argument.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "publish <problem>",
        };
      }
      const parsed = DirectorPublishCommandSchema.safeParse({
        verb: "publish",
        problem_id: problemId,
      });
      if (!parsed.success) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: parsed.error.issues[0]?.message ?? "Invalid publish problem ID.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "publish <problem>",
        };
      }
      return { ok: true, command: parsed.data, raw: trimmed };
    }

    case "hide": {
      // hide <problem> <reason>
      const problemId = tokens[1];
      if (!problemId) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: "hide requires <problem> and <reason> arguments.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "hide <problem> <reason>",
        };
      }
      const firstTokenLen = tokens[0]?.length ?? 0;
      const secondTokenLen = tokens[1]?.length ?? 0;
      const afterFirst = trimmed.slice(firstTokenLen).trimStart();
      const reason = afterFirst.slice(secondTokenLen).trim();
      if (reason.length === 0) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: "hide requires an explicit non-empty reason.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "hide <problem> <reason>",
        };
      }
      const parsed = DirectorHideCommandSchema.safeParse({
        verb: "hide",
        problem_id: problemId,
        reason,
      });
      if (!parsed.success) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: parsed.error.issues[0]?.message ?? "Invalid hide arguments.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "hide <problem> <reason>",
        };
      }
      return { ok: true, command: parsed.data, raw: trimmed };
    }

    case "cap": {
      // cap <problem> <n≤16>
      const problemId = tokens[1];
      const capStr = tokens[2];
      if (!problemId || !capStr) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: "cap requires <problem> and <n≤16> arguments.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "cap <problem> <n≤16>",
        };
      }
      if (tokens.length > 3) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: "cap takes only <problem> and <n≤16> arguments.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "cap <problem> <n≤16>",
        };
      }
      const limit = Number.parseInt(capStr, 10);
      if (
        Number.isNaN(limit) ||
        String(limit) !== capStr ||
        limit < MIN_PROBLEM_CAP ||
        limit > MAX_PROBLEM_CAP
      ) {
        return {
          ok: false,
          code: "INVALID_PROBLEM_CAP",
          message: `cap limit must be an integer between ${MIN_PROBLEM_CAP} and ${MAX_PROBLEM_CAP} (received "${capStr}").`,
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: `cap <problem> <n≤${MAX_PROBLEM_CAP}> (between 1 and 16 writer slots)`,
        };
      }
      const parsed = DirectorCapCommandSchema.safeParse({
        verb: "cap",
        problem_id: problemId,
        limit,
      });
      if (!parsed.success) {
        return {
          ok: false,
          code: "INVALID_DIRECTOR_COMMAND",
          message: parsed.error.issues[0]?.message ?? "Invalid cap arguments.",
          verbs: DIRECTOR_GRAMMAR_VERBS,
          hint: "cap <problem> <n≤16>",
        };
      }
      return { ok: true, command: parsed.data, raw: trimmed };
    }
  }
}

/**
 * Formats a typed DirectorCommand into its canonical command-line representation.
 * Guarantees round-trip equivalence: parse(format(cmd)) === cmd.
 */
export function formatDirectorCommand(command: DirectorCommand): string {
  switch (command.verb) {
    case "assign":
      return command.role
        ? `assign ${command.fellow_id} ${command.problem_id} as ${command.role}`
        : `assign ${command.fellow_id} ${command.problem_id}`;
    case "focus":
      return `focus ${command.fellow_id} ${command.text}`;
    case "forbid":
      return `forbid ${command.fellow_id} ${command.text}`;
    case "unfocus":
      return `unfocus ${command.fellow_id}`;
    case "pause":
      return `pause ${command.fellow_id}`;
    case "resume":
      return `resume ${command.fellow_id}`;
    case "revoke":
      return `revoke ${command.fellow_id}`;
    case "transfer":
      return `transfer ${command.fellow_id} ${command.target_sponsor_id}`;
    case "publish":
      return `publish ${command.problem_id}`;
    case "hide":
      return `hide ${command.problem_id} ${command.reason}`;
    case "cap":
      return `cap ${command.problem_id} ${command.limit}`;
  }
}

// =============================================================================
// Protocol Conflict Recording (Fable §8.2)
// When a sponsor directive conflicts with the protocol, the Fellow is obligated
// to record a protocol_conflict object on the ledger and refuse the illegal part.
// =============================================================================

export const ProtocolConflictSchema = z
  .object({
    directive_id: z.string().regex(/^DIR-[a-f0-9]{32}$/),
    fellow_id: FellowIdSchema,
    problem_id: ProblemIdSchema.nullable().optional(),
    rule_cited: z.string().trim().min(1).max(100),
    refused_part: z.string().trim().min(1).max(500),
    explanation: z.string().trim().min(1).max(2000),
    timestamp: z.number().int().positive(),
  })
  .strict();
export type ProtocolConflict = z.infer<typeof ProtocolConflictSchema>;

// =============================================================================
// Sponsor Disclosure Attestation (Fable §8.2, Bead asimposiumorg-0i9)
// Promoting to strongly-supported or entering under-result-review requires the
// sponsor to attest no undisclosed directive materially shaped the result, or
// disclose it.
// =============================================================================

export const DisclosedDirectiveSchema = z
  .object({
    directive_id: z.string().regex(/^DIR-[a-f0-9]{32}$/),
    sponsor_id: SponsorIdSchema,
    scope: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(500),
    authored_by_current_sponsor: z.boolean(),
  })
  .strict();
export type DisclosedDirective = z.infer<typeof DisclosedDirectiveSchema>;

export const UnresolvedTransferredDirectiveSchema = z
  .object({
    directive_id: z.string().regex(/^DIR-[a-f0-9]{32}$/),
    prior_sponsor_id: SponsorIdSchema,
    received_at: z.number().int().positive(),
  })
  .strict();
export type UnresolvedTransferredDirective = z.infer<typeof UnresolvedTransferredDirectiveSchema>;

export const SponsorDirectiveAttestationSchema = z
  .object({
    attested_no_undisclosed_directives: z.boolean(),
    disclosed_directives: z.array(DisclosedDirectiveSchema).default([]),
    unresolved_transferred_directives: z.array(UnresolvedTransferredDirectiveSchema).default([]),
  })
  .strict();
export type SponsorDirectiveAttestation = z.infer<typeof SponsorDirectiveAttestationSchema>;

export type DirectiveAttestationEvaluation =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly code: "directive_disclosure_unresolved" | "directive_disclosure_missing";
      readonly reason: string;
    };

/**
 * Evaluates whether a claim promotion or result-review entry satisfies
 * the directive disclosure attestation gate.
 *
 * Transfer-aware: Pre-transfer received-directive markers without outgoing
 * sponsor resolved attestation produce directive_disclosure_unresolved.
 */
export function evaluateDirectiveAttestation(
  attestation: SponsorDirectiveAttestation,
): DirectiveAttestationEvaluation {
  // Pre-transfer unresolved directives block promotion
  if (attestation.unresolved_transferred_directives.length > 0) {
    const count = attestation.unresolved_transferred_directives.length;
    return {
      eligible: false,
      code: "directive_disclosure_unresolved",
      reason: `${count} pre-transfer directive(s) lack resolved attestation from prior sponsor. Prior disclosure must be resolved before promotion to strongly-supported or under-result-review.`,
    };
  }

  // Current sponsor must explicitly attest or disclose
  if (
    !attestation.attested_no_undisclosed_directives &&
    attestation.disclosed_directives.length === 0
  ) {
    return {
      eligible: false,
      code: "directive_disclosure_missing",
      reason:
        "Promotion requires sponsor attestation that no undisclosed directives materially shaped the result, or explicit disclosure.",
    };
  }

  return { eligible: true };
}
