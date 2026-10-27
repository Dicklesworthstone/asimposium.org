import { expect, test } from "bun:test";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import type { Env } from "../../src/env";
import { createScreeningAppealsApp } from "../../src/moderation/appeals-http";
import { decideScreeningCase } from "../../src/moderation/store";
import { screenPublicCandidate } from "../../src/screening/public-candidate";
import { publicationContextFixture, SPONSOR } from "../support/publication-context";
import { syntheticScreeningObservation } from "../support/screening";

test("appeal HTTP returns contract-valid private refusal and success envelopes across the human lifecycle", async () => {
  const f = await publicationContextFixture();
  try {
    const hold = await screenPublicCandidate(
      (input) =>
        syntheticScreeningObservation(input, {
          decision: "quarantine",
          coarse_category: "injection",
          provider_status: "ok",
        }),
      { DB: f.db } as Env,
      f.input(),
      { sponsorId: SPONSOR, route: "hypotheses" },
    );
    if (!(hold instanceof Response)) throw new Error("Expected held case");
    const caseId = ((await hold.json()) as { case_id: string }).case_id;
    let operator = "usr_original_operator";
    const verified: string[] = [];
    const app = createScreeningAppealsApp({
      db: f.db,
      verifiedSponsor: async (request, route, action) => {
        verified.push(`${route} ${action}`);
        return {
          principal: { type: "sponsor", sponsorId: SPONSOR },
          rawBody: new Uint8Array(await request.arrayBuffer()),
        };
      },
      verifiedOperator: async (request, route, action) => {
        verified.push(`${route} ${action}`);
        return {
          principal: { type: "operator", operatorId: operator, serviceEnvelopeKid: "fixture" },
          rawBody: new Uint8Array(await request.arrayBuffer()),
        };
      },
    });
    const post = async (path: string, body: unknown, status: number, key = "test-appeal") => {
      const response = await app.request(`https://a.asimposium.org${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      const data = await response.json();
      if (status >= 400) expect(ProblemDocumentSchema.safeParse(data).success).toBe(true);
      return data as Record<string, unknown>;
    };
    const request = {
      case_id: caseId,
      statement: "Please reconsider the exact scope of this held mathematical candidate.",
    };
    const path = "/v1/sponsors/screening-appeals",
      decisionPath = "/v1/operators/screening-appeals/decision";
    await post(path, request, 404);
    await post(path, { ...request, sponsor_id: "usr_other" }, 422);
    await decideScreeningCase(f.db, operator, {
      caseId,
      decision: "confirm_rejection",
      reason: "The original reviewer rejects this exact candidate.",
    });
    const receipt = await post(path, request, 200);
    expect(receipt.state).toBe("pending");
    expect(await post(path, request, 200)).toEqual(receipt);
    const decision = {
      appeal_id: receipt.appeal_id,
      decision: "release",
      reason: "An independent review considers the exact candidate and context.",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    };
    await post(decisionPath, decision, 403, "decision");
    operator = "usr_appeal_operator";
    const stale = await post(
      decisionPath,
      { ...decision, step_up_authenticated_at: 0 },
      403,
      "decision",
    );
    expect(stale.code).toBe("STEP_UP_REQUIRED");
    expect(stale.schema).toBeUndefined();
    const released = await post(decisionPath, decision, 200, "decision");
    expect(released.state).toBe("released");
    await post(decisionPath, { ...decision, decision: "uphold" }, 409, "decision");
    expect(verified).toContain("/v1/sponsors/screening-appeals sponsor.screening-appeals.submit");
    expect(verified).toContain(
      "/v1/operators/screening-appeals/decision operator.screening-appeals.decide",
    );
  } finally {
    f.sql.close();
  }
});
