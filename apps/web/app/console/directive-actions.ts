"use server";

import {
  AdminContentControlRequestSchema,
  AdminContentControlResponseSchema,
  DIRECTOR_GRAMMAR_VERBS,
  parseDirectorCommand,
  problemHideAuthIsRecent,
  type SponsorProblemHideReceipt,
  SponsorProblemHideReceiptSchema,
} from "@asimposium/contracts";
import {
  type SponsorDirectiveReceipt,
  type SponsorDirectiveRequest,
  SponsorDirectiveRequestSchema,
} from "@asimposium/contracts/directives";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import {
  operatorPrincipalIsAllowed,
  stoaAdminContentControl,
  stoaHideProblem,
  stoaIssueDirective,
  stoaSetProblemWriterCap,
  type SponsorWriterCapReceipt,
} from "@/lib/stoa";

export type DirectiveActionResult =
  | { readonly ok: true; readonly receipt: SponsorDirectiveReceipt }
  | { readonly ok: false; readonly message: string };

export type DirectorExecutionResult =
  | {
      readonly ok: true;
      readonly verb: string;
      readonly message: string;
      readonly receipt?: SponsorDirectiveReceipt;
      readonly writerCap?: SponsorWriterCapReceipt;
      readonly problemHide?: SponsorProblemHideReceipt;
    }
  | {
      readonly ok: false;
      readonly code?: string;
      readonly message: string;
      readonly verbs?: readonly string[];
      readonly hint?: string;
      readonly handoff?: {
        readonly href: string;
        readonly label: string;
      };
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
  if (
    result.data.fellow_id !== parsed.data.fellow_id ||
    result.data.verb !== parsed.data.verb ||
    result.data.text !== (parsed.data.text ?? null) ||
    (parsed.data.problem_id !== undefined && result.data.problem_id !== parsed.data.problem_id)
  ) {
    return {
      ok: false,
      message: "The directive receipt did not match this request. Keep the draft and retry unchanged.",
    };
  }
  return { ok: true, receipt: result.data };
}

export async function executeDirectorCommand(
  rawInput: string,
  idempotencyKey: string,
): Promise<DirectorExecutionResult> {
  if (typeof rawInput !== "string" || rawInput.length > 2048) {
    return {
      ok: false,
      code: "INVALID_DIRECTOR_COMMAND",
      message: "Enter one director command of at most 2,048 characters.",
      verbs: DIRECTOR_GRAMMAR_VERBS,
    };
  }
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(idempotencyKey)) {
    return { ok: false, message: "The command retry key is invalid. Reload the console before retrying." };
  }
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

    case "assign": {
      // Work roles are requests, not permission grants. A sponsor directive is
      // the existing private steering channel; Stoa rechecks ownership and the
      // Fellow's access to this problem before delivering it.
      const issued = await issueSponsorDirective({
        fellow_id: cmd.fellow_id,
        problem_id: cmd.problem_id,
        verb: "focus",
        text: `Work on problem ${cmd.problem_id}${cmd.role ? ` as ${cmd.role}` : ""}. Open or resume an authorized session and follow its working pack. This work request does not change your permissions or problem membership.`,
      }, idempotencyKey);
      if (!issued.ok) return issued;
      return {
        ok: true,
        verb: "assign",
        message: `Private work request delivered to ${cmd.fellow_id} for ${cmd.problem_id}${cmd.role ? ` (requested role: ${cmd.role})` : ""}. The Fellow's permissions and problem membership are unchanged; session work still requires its participation.`,
        receipt: issued.receipt,
      };
    }

    case "pause":
    case "resume":
    case "revoke":
      return {
        ok: false,
        code: "DIRECTOR_CONFIRMATION_REQUIRED",
        message: `No lifecycle change has been made. Review ${cmd.verb} for ${cmd.fellow_id} on its Fellow card, then use its existing confirmation with a recent Google sign-in.`,
        handoff: { href: "#fellows-title", label: `Review ${cmd.verb} on Your Fellows` },
      };

    case "transfer":
      return {
        ok: false,
        code: "DIRECTOR_CONFIRMATION_REQUIRED",
        message: `No transfer has been offered. Review the transfer of ${cmd.fellow_id} to ${cmd.target_sponsor_id} on Fellow transfers. Both sponsors must confirm through that workflow.`,
        handoff: { href: "#transfers-title", label: "Review Fellow transfer" },
      };

    case "publish":
      return {
        ok: false,
        code: "DIRECTOR_CONFIRMATION_REQUIRED",
        message: `Nothing has been published. Review the adopted formulation of ${cmd.problem_id} and its publication acknowledgment on Problems you sponsor.`,
        handoff: { href: "#problems-title", label: "Review problem publication" },
      };

    case "hide": {
      const authenticatedAt = session.authIssuedAt;
      if (!problemHideAuthIsRecent(authenticatedAt))
        return {
          ok: false,
          code: "STEP_UP_REQUIRED",
          message:
            "Sign in again with Google before hiding a problem, then retry this unchanged command.",
        };
      let receipt: SponsorProblemHideReceipt | undefined;
      let appliedAt: string;
      if (operatorPrincipalIsAllowed(session.user.id)) {
        // Operator authority stays on the existing operator-signed route and allowlist.
        const request = AdminContentControlRequestSchema.safeParse({
          target_id: cmd.problem_id,
          target_kind: "problem",
          action: "hide",
          reason: cmd.reason,
        });
        if (!request.success)
          return {
            ok: false,
            message: "An operator hide requires an audit reason of 10 to 1,000 characters.",
          };
        const result = await stoaAdminContentControl(
          session.user.id,
          request.data,
          idempotencyKey,
        );
        if (!result.ok) return hideFailure(result);
        const matched = AdminContentControlResponseSchema.safeParse(result.data);
        if (
          !matched.success ||
          matched.data.target_id !== cmd.problem_id ||
          matched.data.action !== "hide"
        )
          return hideReceiptMismatch();
        appliedAt = matched.data.applied_at;
      } else {
        const result = await stoaHideProblem(
          session.user.id,
          cmd.problem_id,
          {
            problem_id: cmd.problem_id,
            reason: cmd.reason,
            step_up_authenticated_at: authenticatedAt,
          },
          idempotencyKey,
        );
        if (!result.ok) return hideFailure(result);
        const matched = SponsorProblemHideReceiptSchema.safeParse(result.data);
        if (!matched.success || matched.data.problem_id !== cmd.problem_id)
          return hideReceiptMismatch();
        receipt = matched.data;
        appliedAt = matched.data.applied_at;
      }
      // Problem content also appears in directory, review and other aggregate faces.
      // Invalidate their cached reads only after a matching authoritative receipt.
      try {
        revalidatePath("/", "layout");
      } catch {
        // A cache failure cannot erase the receipt.
      }
      return {
        ok: true,
        verb: "hide",
        message: `Hide recorded for ${cmd.problem_id} at ${appliedAt}. This receipt confirms the decision; later operator decisions may change current visibility. Scientific standing is unchanged.`,
        ...(receipt === undefined ? {} : { problemHide: receipt }),
      };
    }

    case "cap": {
      const changed = await stoaSetProblemWriterCap(
        session.user.id, cmd.problem_id, cmd.limit, idempotencyKey,
      );
      if (!changed.ok) {
        return {
          ok: false,
          message: changed.reason === "unconfigured"
            ? "Writer-cap changes are not configured on this deployment."
            : changed.reason === "refused"
              ? "Stoa refused the writer-cap change. Only the problem's sponsor or a current steward may change its capacity."
              : "The writer-cap change could not be confirmed. Retry the unchanged command to reuse its Idempotency-Key.",
        };
      }
      if (changed.data.id !== cmd.problem_id || changed.data.writer_cap !== cmd.limit) {
        return { ok: false, message: "The writer-cap receipt did not match this command. Retry unchanged." };
      }
      return {
        ok: true,
        verb: "cap",
        message: `Stoa confirmed ${changed.data.writer_cap} writer slots for ${changed.data.id} at ${changed.data.updated_at}.`,
        writerCap: changed.data,
      };
    }
  }
}

function hideReceiptMismatch(): DirectorExecutionResult {
  return {
    ok: false,
    message:
      "The hide receipt did not match this command. Keep the problem, reason and retry key unchanged to recover the recorded decision.",
  };
}

function hideFailure(result: {
  readonly reason: string;
  readonly status?: number;
  readonly problemCode?: string;
}): DirectorExecutionResult {
  return {
    ok: false,
    ...(result.problemCode ? { code: result.problemCode } : {}),
    message:
      result.reason === "unconfigured"
        ? "Problem hiding is not configured on this deployment."
        : result.status === 409
          ? "Stoa refused a conflicting hide command. Inspect current visibility before making a new decision; retry a previously accepted command unchanged to recover its receipt."
          : result.status === 401 || result.status === 403 || result.status === 404
            ? "Stoa refused this hide command. Only the current owning sponsor or an authorized operator can hide a published problem; sign in again if recent authentication is required."
            : "The hide could not be confirmed. Retry the unchanged problem and reason to reuse its Idempotency-Key.",
  };
}
