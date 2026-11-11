import type {
  AdminAreaRenameRequest,
  AdminAreaRenameResponse,
  AdminContentControlRequest,
  AdminContentControlResponse,
  AdminQuarantineDecisionRequest,
  AdminQuarantineDecisionResponse,
  AdminReportResolutionRequest,
  AdminReportResolutionResponse,
} from "@asimposium/contracts";

export type AdminModerationKind = "quarantine" | "report" | "content" | "area";

export type AdminModerationAttempt =
  | {
      readonly kind: "area";
      readonly key: string;
      readonly request: Omit<AdminAreaRenameRequest, "step_up_authenticated_at">;
    }
  | {
      readonly kind: "quarantine";
      readonly key: string;
      readonly request: AdminQuarantineDecisionRequest;
    }
  | {
      readonly kind: "report";
      readonly key: string;
      readonly request: AdminReportResolutionRequest;
    }
  | {
      readonly kind: "content";
      readonly key: string;
      readonly request: AdminContentControlRequest;
    };

export type AdminModerationReceipt =
  | { readonly kind: "area"; readonly result: AdminAreaRenameResponse }
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
    case "area":
      return {
        target: receipt.result.area_id,
        decision: receipt.result.new_title,
        auditEventId: receipt.result.audit_event_id,
        at: receipt.result.renamed_at,
      };
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
