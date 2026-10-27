import "server-only";
import {
  OperatorScreeningAppealsResponseSchema,
  SCREENING_APPEALS_MAX_RESPONSE_BYTES,
  type ScreeningAppealDecision,
  ScreeningAppealDecisionSchema,
  ScreeningAppealIdSchema,
  ScreeningAppealReceiptSchema,
  type ScreeningAppealRequest,
  ScreeningAppealRequestSchema,
  ScreeningCaseIdSchema,
  SponsorScreeningCasesResponseSchema,
} from "@asimposium/contracts/appeals";
import { callStoa } from "./stoa";

export async function stoaScreeningCases(principalId: string, caseId?: string) {
  if (caseId !== undefined && !ScreeningCaseIdSchema.safeParse(caseId).success)
    return { ok: false, reason: "refused", status: 404 } as const;
  const path = `/v1/sponsors/screening-cases${caseId ? `/${caseId}` : ""}`;
  return callStoa({
    method: "GET",
    route: caseId ? "/v1/sponsors/screening-cases/:caseId" : path,
    path,
    action: caseId ? "sponsor.screening-cases.read" : "sponsor.screening-cases.list",
    principalId,
    body: "",
    parse: (value) => {
      const result = SponsorScreeningCasesResponseSchema.parse(value);
      if (
        caseId &&
        (result.has_more ||
          result.cases.length > 1 ||
          result.cases.some((item) => item.case_id !== caseId))
      )
        throw new Error("Appeal case mismatch");
      return result;
    },
  });
}
export async function stoaSubmitScreeningAppeal(
  principalId: string,
  body: ScreeningAppealRequest,
  idempotencyKey: string,
) {
  const parsed = ScreeningAppealRequestSchema.safeParse(body);
  if (!parsed.success || !/^[A-Za-z0-9._-]{1,160}$/.test(idempotencyKey))
    return { ok: false, reason: "refused", status: 422 } as const;
  const path = "/v1/sponsors/screening-appeals";
  return callStoa({
    method: "POST",
    route: path,
    path,
    action: "sponsor.screening-appeals.submit",
    principalId,
    body: JSON.stringify(parsed.data),
    idempotencyKey,
    parse: (value) => {
      const receipt = ScreeningAppealReceiptSchema.parse(value);
      if (receipt.case_id !== body.case_id) throw new Error("Appeal case mismatch");
      return receipt;
    },
  });
}
export async function stoaScreeningAppeals(principalId: string, appealId?: string) {
  if (appealId !== undefined && !ScreeningAppealIdSchema.safeParse(appealId).success)
    return { ok: false, reason: "refused", status: 404 } as const;
  const path = `/v1/operators/screening-appeals${appealId ? `/${appealId}` : ""}`;
  return callStoa({
    method: "GET",
    route: appealId ? "/v1/operators/screening-appeals/:appealId" : path,
    path,
    action: appealId ? "operator.screening-appeals.read" : "operator.screening-appeals.list",
    principalId,
    principalType: "operator",
    body: "",
    responseMaxBytes: SCREENING_APPEALS_MAX_RESPONSE_BYTES,
    parse: (value) => {
      const result = OperatorScreeningAppealsResponseSchema.parse(value);
      if (
        appealId &&
        (result.has_more ||
          result.appeals.length > 1 ||
          result.appeals.some((item) => item.appeal_id !== appealId))
      )
        throw new Error("Appeal target mismatch");
      return result;
    },
  });
}
export async function stoaDecideScreeningAppeal(
  principalId: string,
  body: ScreeningAppealDecision,
  idempotencyKey: string,
) {
  const parsed = ScreeningAppealDecisionSchema.safeParse(body);
  if (!parsed.success || !/^[A-Za-z0-9._-]{1,160}$/.test(idempotencyKey))
    return { ok: false, reason: "refused", status: 422 } as const;
  const path = "/v1/operators/screening-appeals/decision";
  return callStoa({
    method: "POST",
    route: path,
    path,
    action: "operator.screening-appeals.decide",
    principalId,
    principalType: "operator",
    body: JSON.stringify(parsed.data),
    idempotencyKey,
    parse: (value) => {
      const receipt = ScreeningAppealReceiptSchema.parse(value);
      if (
        receipt.appeal_id !== body.appeal_id ||
        receipt.state !== (body.decision === "release" ? "released" : "upheld")
      )
        throw new Error("Appeal receipt mismatch");
      return receipt;
    },
  });
}
