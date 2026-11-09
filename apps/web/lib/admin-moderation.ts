import type {
  AdminContentControlRequest,
  AdminContentControlResponse,
  AdminQuarantineDecisionRequest,
  AdminQuarantineDecisionResponse,
  AdminReportResolutionRequest,
  AdminReportResolutionResponse,
} from "@asimposium/contracts";

export type AdminModerationKind = "quarantine" | "report" | "content";

export type AdminModerationAttempt =
  | { readonly kind: "quarantine"; readonly key: string; readonly request: AdminQuarantineDecisionRequest }
  | { readonly kind: "report"; readonly key: string; readonly request: AdminReportResolutionRequest }
  | { readonly kind: "content"; readonly key: string; readonly request: AdminContentControlRequest };

export type AdminModerationReceipt =
  | { readonly kind: "quarantine"; readonly result: AdminQuarantineDecisionResponse }
  | { readonly kind: "report"; readonly result: AdminReportResolutionResponse }
  | { readonly kind: "content"; readonly result: AdminContentControlResponse };

/** Private action state: no held candidate, detector detail or browser storage. */
export type AdminModerationState =
  | { readonly status: "idle" }
  | {
      readonly status: "invalid";
      readonly message: string;
      readonly draft: Readonly<Record<string, string>>;
    }
  | {
      readonly status: "refused";
      readonly message: string;
      readonly code?: string;
      readonly attempt?: AdminModerationAttempt;
    }
  | {
      readonly status: "unconfirmed";
      readonly message: string;
      readonly attempt: AdminModerationAttempt;
    }
  | {
      readonly status: "committed";
      readonly message: string;
      readonly attempt: AdminModerationAttempt;
      readonly receipt: AdminModerationReceipt;
    };

export function moderationReceiptSummary(receipt: AdminModerationReceipt): {
  readonly target: string;
  readonly decision: string;
  readonly auditEventId: string;
  readonly at: string;
} {
  switch (receipt.kind) {
    case "quarantine":
      return {
        target: receipt.result.case_id,
        decision: receipt.result.decision,
        auditEventId: receipt.result.audit_event_id,
        at: receipt.result.decided_at,
      };
    case "report":
      return {
        target: receipt.result.report_id,
        decision: receipt.result.resolution,
        auditEventId: receipt.result.audit_event_id,
        at: receipt.result.resolved_at,
      };
    case "content":
      return {
        target: receipt.result.target_id,
        decision: receipt.result.action,
        auditEventId: receipt.result.audit_event_id,
        at: receipt.result.applied_at,
      };
  }
}
