import "server-only";

import {
  type AdminAuditEvent,
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
