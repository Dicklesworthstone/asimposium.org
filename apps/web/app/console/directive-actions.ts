"use server";

import {
  parseDirectorCommand,
} from "@asimposium/contracts";
import {
  SponsorDirectiveRequestSchema,
  type SponsorDirectiveReceipt,
  type SponsorDirectiveRequest,
} from "@asimposium/contracts/directives";
import { auth } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaIssueDirective } from "@/lib/stoa";

export type DirectiveActionResult =
  | { readonly ok: true; readonly receipt: SponsorDirectiveReceipt }
  | { readonly ok: false; readonly message: string };

export type DirectorExecutionResult =
  | {
      readonly ok: true;
      readonly verb: string;
      readonly message: string;
      readonly receipt?: SponsorDirectiveReceipt;
    }
  | {
      readonly ok: false;
      readonly code?: string;
      readonly message: string;
      readonly verbs?: readonly string[];
      readonly hint?: string;
    };

export async function issueSponsorDirective(
  request: SponsorDirectiveRequest,
  idempotencyKey: string,
): Promise<DirectiveActionResult> {
  const session = await auth();
  if (!session?.user || !isCanonicalSponsorId(session.user.id)) {
    return { ok: false, message: "Sign in again before issuing a directive." };
  }
  const parsed = SponsorDirectiveRequestSchema.safeParse(request);
  if (!parsed.success || !/^[A-Za-z0-9._-]{1,160}$/.test(idempotencyKey)) {
    return { ok: false, message: "The directive draft is invalid." };
  }
  const result = await stoaIssueDirective(session.user.id, parsed.data, idempotencyKey);
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "unconfigured"
          ? "Directive delivery is not configured on this deployment."
          : result.reason === "refused"
            ? "Stoa refused the directive. Refresh the console and check the Fellow assignment."
            : "Directive delivery could not be confirmed. Retry with the same draft.",
    };
  }
  return { ok: true, receipt: result.data };
}

export async function executeDirectorCommand(
  rawInput: string,
  idempotencyKey: string,
): Promise<DirectorExecutionResult> {
  const parseResult = parseDirectorCommand(rawInput);
  if (!parseResult.ok) {
    return {
      ok: false,
      code: parseResult.code,
      message: parseResult.message,
      verbs: parseResult.verbs,
      hint: parseResult.hint,
    };
  }

  const session = await auth();
  if (!session?.user || !isCanonicalSponsorId(session.user.id)) {
    return { ok: false, message: "Sign in again before issuing a directive." };
  }

  const cmd = parseResult.command;
  switch (cmd.verb) {
    case "focus":
    case "forbid":
    case "unfocus": {
      const dirReq: SponsorDirectiveRequest = {
        fellow_id: cmd.fellow_id,
        verb: cmd.verb,
        ...(cmd.verb === "unfocus" ? {} : { text: cmd.text }),
      };
      const issued = await issueSponsorDirective(dirReq, idempotencyKey);
      if (!issued.ok) {
        return { ok: false, message: issued.message };
      }
      return {
        ok: true,
        verb: cmd.verb,
        message:
          cmd.verb === "unfocus"
            ? `Focus cleared for Fellow ${cmd.fellow_id}.`
            : `${cmd.verb} directive delivered to Fellow ${cmd.fellow_id}.`,
        receipt: issued.receipt,
      };
    }

    case "assign":
      return {
        ok: true,
        verb: "assign",
        message: `Assignment parsed: Fellow ${cmd.fellow_id} → Problem ${cmd.problem_id}${cmd.role ? ` (role: ${cmd.role})` : ""}. Confirm assignment in Fellow settings.`,
      };

    case "pause":
    case "resume":
    case "revoke":
      return {
        ok: true,
        verb: cmd.verb,
        message: `${cmd.verb} command parsed for Fellow ${cmd.fellow_id}. Confirm state transition with recent authentication on the Fellow lifecycle card.`,
      };

    case "transfer":
      return {
        ok: true,
        verb: "transfer",
        message: `Transfer command parsed: Fellow ${cmd.fellow_id} → Sponsor ${cmd.target_sponsor_id}. Both outgoing and receiving sponsors must confirm through W3.8 bilateral cards.`,
      };

    case "publish":
      return {
        ok: true,
        verb: "publish",
        message: `Publish command parsed for Problem ${cmd.problem_id}. Confirm formulation and publication through the problem lifecycle card.`,
      };

    case "hide":
      return {
        ok: true,
        verb: "hide",
        message: `Hide command parsed for Problem ${cmd.problem_id} (Reason: ${cmd.reason}). Confirm through problem governance card.`,
      };

    case "cap":
      return {
        ok: true,
        verb: "cap",
        message: `Cap command parsed: Problem ${cmd.problem_id} capped to ${cmd.limit} writer slots.`,
      };
  }
}

