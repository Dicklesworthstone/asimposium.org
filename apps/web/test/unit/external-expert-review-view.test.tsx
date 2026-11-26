import { expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { externalReviewRecord } from "../fixtures/external-expert-review";

mock.module("server-only", () => ({}));
const { ExternalExpertReviewRecordView } = await import("../../components/external-expert-review-control");

test("the operator receipt displays exact attribution, target, source, boundaries and revocation without declaring resolution", () => {
  const html = renderToStaticMarkup(createElement(ExternalExpertReviewRecordView, { record: {
    ...externalReviewRecord, reviewer: { ...externalReviewRecord.reviewer, name: "<script>private()</script>" },
  } }));
  expect(html).toContain(externalReviewRecord.review_record_id);
  expect(html).toContain("C-3%402");
  expect(html).toContain(externalReviewRecord.claim_content_digest);
  expect(html).toContain(externalReviewRecord.attestation_sha256);
  expect(html).toContain(externalReviewRecord.verified_by_operator_id);
  for (const items of Object.values(externalReviewRecord.no_claim_boundary))
    for (const item of items) expect(html).toContain(item);
  expect(html).toContain("does not resolve the problem");
  expect(html).toContain("&lt;script&gt;private()");
  expect(html).not.toContain("<script>");
  const revoked = renderToStaticMarkup(createElement(ExternalExpertReviewRecordView, {
    record: { ...externalReviewRecord, revoked_at: "2026-11-26T13:00:00.000Z" },
  }));
  expect(revoked).toContain("Revoked at 2026-11-26T13:00:00.000Z");
});

test("unsafe attestation locators remain inert text and never create executable links", () => {
  for (const locator of ["javascript:alert(1)", "https://user:password@example.org/review"]) {
    const html = renderToStaticMarkup(createElement(ExternalExpertReviewRecordView, {
      record: { ...externalReviewRecord, attestation_locator: locator },
    }));
    expect(html).not.toContain('href="' + locator);
    expect(html).toContain(locator);
  }
});
