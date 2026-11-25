import "server-only";

import {
  INTEGRITY_CASE_MAX_RESPONSE_BYTES,
  IntegrityCaseDetailResponseSchema,
  IntegrityCaseListResponseSchema,
  IntegrityCaseOpenRequestSchema,
  IntegrityCaseQuerySchema,
  IntegrityCaseReadRequestSchema,
  IntegrityCaseReceiptSchema,
  IntegrityCaseResolveRequestSchema,
  IntegrityCaseRespondRequestSchema,
  OperatorIntegrityCaseDetailResponseSchema,
  integrityCaseDetailMatchesRequest,
  integrityCaseListMatchesQuery,
  type IntegrityCaseDetailResponse,
  type IntegrityCaseListResponse,
  type IntegrityCaseOpenRequest,
  type IntegrityCaseQuery,
  type IntegrityCaseReadRequest,
  type IntegrityCaseReceipt,
  type IntegrityCaseResolveRequest,
  type IntegrityCaseRespondRequest,
  type OperatorIntegrityCaseDetailResponse,
} from "@asimposium/contracts/integrity-cases";
import { callStoa, type StoaCall } from "./stoa";

export async function stoaIntegrityCases(
  principalId: string,
  audience: "operator" | "sponsor",
  input: IntegrityCaseQuery,
): Promise<StoaCall<IntegrityCaseListResponse>> {
  const request = IntegrityCaseQuerySchema.parse(input);
  const path = "/v1/" + (audience === "operator" ? "operators" : "sponsors") + "/integrity/cases/query";
  return callStoa({
    method: "POST", route: path, path,
    action: audience + ".integrity.cases.query",
    principalId, principalType: audience,
    body: JSON.stringify(request), responseMaxBytes: INTEGRITY_CASE_MAX_RESPONSE_BYTES,
    parse: (value) => {
      const page = IntegrityCaseListResponseSchema.parse(value);
      if (!integrityCaseListMatchesQuery(request, page) ||
        (audience === "sponsor" && page.cases.some((item) => item.subject_sponsor_id !== principalId)))
        throw new Error("INTEGRITY_CASE_LIST_MISMATCH");
      return page;
    },
  });
}

export function stoaOperatorIntegrityCase(
  principalId: string,
  input: IntegrityCaseReadRequest,
): Promise<StoaCall<OperatorIntegrityCaseDetailResponse>> {
  const request = IntegrityCaseReadRequestSchema.parse(input);
  const path = "/v1/operators/integrity/cases/read";
  return callStoa({
    method: "POST", route: path, path, action: "operator.integrity.cases.read",
    principalId, principalType: "operator", body: JSON.stringify(request),
    responseMaxBytes: INTEGRITY_CASE_MAX_RESPONSE_BYTES,
    parse: (value) => {
      const page = OperatorIntegrityCaseDetailResponseSchema.parse(value);
      if (!integrityCaseDetailMatchesRequest(request, page))
        throw new Error("INTEGRITY_CASE_DETAIL_MISMATCH");
      return page;
    },
  });
}

export function stoaSponsorIntegrityCase(
  principalId: string,
  input: IntegrityCaseReadRequest,
): Promise<StoaCall<IntegrityCaseDetailResponse>> {
  const request = IntegrityCaseReadRequestSchema.parse(input);
  const path = "/v1/sponsors/integrity/cases/read";
  return callStoa({
    method: "POST", route: path, path, action: "sponsor.integrity.cases.read",
    principalId, principalType: "sponsor", body: JSON.stringify(request),
    responseMaxBytes: INTEGRITY_CASE_MAX_RESPONSE_BYTES,
    parse: (value) => {
      const page = IntegrityCaseDetailResponseSchema.parse(value);
      if (page.case.subject_sponsor_id !== principalId ||
        !integrityCaseDetailMatchesRequest(request, page))
        throw new Error("INTEGRITY_CASE_DETAIL_MISMATCH");
      return page;
    },
  });
}

export function stoaOpenIntegrityCase(
  principalId: string,
  input: IntegrityCaseOpenRequest,
  idempotencyKey: string,
): Promise<StoaCall<IntegrityCaseReceipt>> {
  const request = IntegrityCaseOpenRequestSchema.parse(input);
  const path = "/v1/operators/integrity/cases/open";
  return callStoa({
    method: "POST", route: path, path, action: "operator.integrity.cases.open",
    principalId, principalType: "operator", body: JSON.stringify(request), idempotencyKey,
    parse: (value) => {
      const receipt = IntegrityCaseReceiptSchema.parse(value);
      if (receipt.action !== "opened") throw new Error("INTEGRITY_CASE_RECEIPT_MISMATCH");
      return receipt;
    },
  });
}

export function stoaRespondToIntegrityCase(
  principalId: string,
  input: IntegrityCaseRespondRequest,
  idempotencyKey: string,
): Promise<StoaCall<IntegrityCaseReceipt>> {
  const request = IntegrityCaseRespondRequestSchema.parse(input);
  const path = "/v1/sponsors/integrity/cases/respond";
  return callStoa({
    method: "POST", route: path, path, action: "sponsor.integrity.cases.respond",
    principalId, principalType: "sponsor", body: JSON.stringify(request), idempotencyKey,
    parse: (value) => {
      const receipt = IntegrityCaseReceiptSchema.parse(value);
      if (receipt.case_id !== request.case_id || receipt.revision !== request.expected_revision + 1 ||
        (receipt.action !== "response" && receipt.action !== "appealed"))
        throw new Error("INTEGRITY_CASE_RECEIPT_MISMATCH");
      return receipt;
    },
  });
}

export function stoaResolveIntegrityCase(
  principalId: string,
  input: IntegrityCaseResolveRequest,
  idempotencyKey: string,
): Promise<StoaCall<IntegrityCaseReceipt>> {
  const request = IntegrityCaseResolveRequestSchema.parse(input);
  const path = "/v1/operators/integrity/cases/resolve";
  return callStoa({
    method: "POST", route: path, path, action: "operator.integrity.cases.resolve",
    principalId, principalType: "operator", body: JSON.stringify(request), idempotencyKey,
    parse: (value) => {
      const receipt = IntegrityCaseReceiptSchema.parse(value);
      if (receipt.case_id !== request.case_id || receipt.revision !== request.expected_revision + 1 ||
        receipt.action !== "resolved")
        throw new Error("INTEGRITY_CASE_RECEIPT_MISMATCH");
      return receipt;
    },
  });
}
