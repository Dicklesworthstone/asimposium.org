import "server-only";

import {
  type AdminAuditEvent,
  type AdminQuarantineCaseDetail,
  type AdminQuarantineItem,
  type AdminReportItem,
  ScientificDispositionOverrideProhibitedError,
} from "@asimposium/contracts";

import { auth } from "@/auth";
import { recentAuthOk } from "./recent-auth";
import { isCanonicalSponsorId } from "./sponsor-id";
import {
  operatorPrincipalIsAllowed,
  stoaAdminAuditHistory,
  stoaAdminQuarantineCase,
  stoaAdminQuarantineQueue,
  stoaAdminReportsQueue,
} from "./stoa";

export { ScientificDispositionOverrideProhibitedError };

export type OperatorSessionResult =
  | { readonly state: "unauthenticated" }
  | { readonly state: "forbidden"; readonly principalId: string }
  | {
      readonly state: "step_up_required";
      readonly operatorId: string;
      readonly authIssuedAt: number | undefined;
    }
  | {
      readonly state: "authorized";
      readonly operatorId: string;
      readonly authIssuedAt: number;
    };

/**
 * Validates the operator principal against Google OAuth session, the configured allowlist,
 * and the recent step-up authentication window (Fable §5.1, §8.4 / Rule A5).
 */
export async function requireOperatorSession(): Promise<OperatorSessionResult> {
  const session = await auth();
  const principalId = session?.user?.id;

  if (!principalId || !isCanonicalSponsorId(principalId)) {
    return { state: "unauthenticated" };
  }

  if (!operatorPrincipalIsAllowed(principalId)) {
    return { state: "forbidden", principalId };
  }

  const authIssuedAt = session?.authIssuedAt;
  if (!recentAuthOk(authIssuedAt)) {
    return { state: "step_up_required", operatorId: principalId, authIssuedAt };
  }

  return { state: "authorized", operatorId: principalId, authIssuedAt: authIssuedAt as number };
}

/**
 * Bounded read for quarantine queue items. Returns an empty queue with state
 * when the agent host is unreachable or unconfigured.
 */
export async function getQuarantineQueue(
  operatorId: string,
): Promise<{ readonly state: "ok" | "unconfigured" | "unreachable"; readonly items: readonly AdminQuarantineItem[] }> {
  const result = await stoaAdminQuarantineQueue(operatorId);
  if (!result.ok) {
    return { state: result.reason === "unconfigured" ? "unconfigured" : "unreachable", items: [] };
  }
  return { state: "ok", items: result.data.items };
}

/**
 * The held bytes of each pending case, so an operator never decides blind.
 * A case whose detail cannot be read is shown as unavailable, never guessed.
 */
export async function getQuarantineCaseDetails(
  operatorId: string,
  caseIds: readonly string[],
): Promise<ReadonlyMap<string, AdminQuarantineCaseDetail>> {
  const details = await Promise.all(
    caseIds.slice(0, 25).map(async (caseId) => {
      const result = await stoaAdminQuarantineCase(operatorId, caseId);
      return result.ok ? ([caseId, result.data] as const) : undefined;
    }),
  );
  return new Map(details.filter((entry) => entry !== undefined));
}

/**
 * Bounded read for reports queue items.
 */
export async function getReportsQueue(
  operatorId: string,
): Promise<{ readonly state: "ok" | "unconfigured" | "unreachable"; readonly reports: readonly AdminReportItem[] }> {
  const result = await stoaAdminReportsQueue(operatorId);
  if (!result.ok) {
    return { state: result.reason === "unconfigured" ? "unconfigured" : "unreachable", reports: [] };
  }
  return { state: "ok", reports: result.data.reports };
}

/**
 * Bounded read for operator audit history.
 */
export async function getAuditHistory(
  operatorId: string,
): Promise<{ readonly state: "ok" | "unconfigured" | "unreachable"; readonly events: readonly AdminAuditEvent[] }> {
  const result = await stoaAdminAuditHistory(operatorId);
  if (!result.ok) {
    return { state: result.reason === "unconfigured" ? "unconfigured" : "unreachable", events: [] };
  }
  return { state: "ok", events: result.data.events };
}
