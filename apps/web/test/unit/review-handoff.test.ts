import { describe, expect, test } from "bun:test";
import type { SponsorFellowSummary } from "@asimposium/contracts";
import { SponsorDirectiveRequestSchema } from "@asimposium/contracts/directives";
import { initialMintFirstDirective, initialMintProblemBinding } from "../../app/console/join-paste";
import {
  parseReviewHandoff,
  reviewDirectiveText,
  reviewFellows,
  reviewHandoffForClaim,
  reviewHandoffFromQuery,
  reviewHandoffHref,
  reviewSourceHref,
} from "../../lib/review-handoff";
import { consolePageHref } from "../../lib/workshop-index";

const source = { problemId: "P-4DSP", target: "C-7@2", through: "85" };

describe("exact claim review navigation", () => {
  test("queue and claim identifiers preserve the immutable version and cursor through console navigation", () => {
    expect(reviewHandoffForClaim("P-4DSP", "C-7", 2, 85)).toEqual(source);
    const link = new URL(reviewHandoffHref(source), "https://asimposium.org");
    expect(link.pathname).toBe("/console");
    expect(link.hash).toBe("#review-request-title");
    expect(reviewHandoffFromQuery(Object.fromEntries(link.searchParams))).toEqual(source);
    expect(reviewSourceHref(source)).toBe("/p/P-4DSP/claims/C-7%402?through=85");
    const page = new URL(consolePageHref({
      onboardingProblem: source.problemId,
      reviewContext: source,
      fellowCursor: "older-fellows",
      workshopAfter: { fellow_id: "fellow-01JXYZ", problem_id: "P-7KQZ" },
      workshopsAnchor: true,
    }), "https://asimposium.org");
    expect(reviewHandoffFromQuery(Object.fromEntries(page.searchParams))).toEqual(source);
    expect(page.searchParams.get("fellow_cursor")).toBe("older-fellows");
    expect(page.searchParams.get("workshop_cursor")).toContain("P-7KQZ");
    expect(page.hash).toBe("#workshops-title");
  });

  test("PLANTED: partial, duplicate, unpinned, noncanonical and external targets cannot become review context", () => {
    for (const bad of [
      null, [], {}, { ...source, extra: "directive" },
      { ...source, problemId: ["P-4DSP", "P-7KQZ"] },
      { ...source, problemId: "https://attacker.invalid" },
      { ...source, problemId: "P-4DSP\n" },
      { ...source, target: "C-7" }, { ...source, target: "C-7@02" },
      { ...source, target: "C-7@2\n" }, { ...source, target: "../C-7@2" },
      { ...source, target: ["C-7@2", "C-7@3"] },
      { ...source, target: "C-7@9007199254740992" },
      { ...source, through: "085" }, { ...source, through: "85\n" },
      { ...source, through: "1e2" }, { ...source, through: -1 },
      { ...source, through: ["85", "86"] }, { ...source, through: undefined },
    ]) expect(parseReviewHandoff(bad)).toBeUndefined();
    expect(reviewHandoffFromQuery({ problem: "P-4DSP", review: "C-7@2" })).toBeUndefined();
    expect(reviewHandoffHref(undefined)).toBe("/reviews");
    expect(reviewHandoffForClaim("P-4DSP", "C-7", 1.5, 85)).toBeUndefined();
    expect(reviewHandoffForClaim("P-4DSP", "C-7", 2, Infinity)).toBeUndefined();
  });

  test("a review target cannot silently change the chosen problem in a console return link", () => {
    const page = new URL(consolePageHref({
      onboardingProblem: "P-7KQZ", reviewContext: source,
    }), "https://asimposium.org");
    expect(page.searchParams.get("problem")).toBe("P-7KQZ");
    expect(page.searchParams.has("review")).toBe(false);
    expect(page.searchParams.has("review_through")).toBe(false);
  });

  test("the authored routing request fits a directive and never imports public statement text", () => {
    const text = reviewDirectiveText(source);
    expect(text).toContain("P-4DSP, exact claim C-7@2");
    expect(text).toContain("ledger cursor 85");
    expect(text).toContain("isolated review pack");
    expect(text).toContain("capable-of-failure check");
    expect(text).toContain("not a scientific review or a permission grant");
    const largest = reviewHandoffForClaim(
      "P-" + "A".repeat(31), "C-" + "1".repeat(40), Number.MAX_SAFE_INTEGER, 999999999999999,
    );
    expect(largest).toBeDefined();
    expect(SponsorDirectiveRequestSchema.safeParse({
      fellow_id: "FEL-12345678", problem_id: largest!.problemId,
      verb: "focus", text: reviewDirectiveText(largest!),
    }).success).toBe(true);
  });
});

describe("review enrollment preserves exact recovery bodies", () => {
  test("a fresh enrollment receives the source problem and the fixed first review directive", () => {
    expect(initialMintProblemBinding(undefined, source.problemId)).toBe(source.problemId);
    expect(initialMintFirstDirective(undefined, source)).toBe(reviewDirectiveText(source));
    expect(initialMintFirstDirective(undefined, undefined)).toBe("");
  });

  test("an existing first directive and assignment win over a different review link", () => {
    const retained = {
      requested_scopes: ["review"] as const,
      problem_binding: "P-7KQZ",
      first_directive: "Continue the original adversarial check.",
    };
    const draft = { ...retained, requested_scopes: [...retained.requested_scopes] };
    expect(initialMintProblemBinding(draft, source.problemId)).toBe("P-7KQZ");
    expect(initialMintFirstDirective(draft, source)).toBe(retained.first_directive);
    expect(draft).toEqual({ ...retained, requested_scopes: ["review"] });
  });

  test("PLANTED: a retained intentionally unbound, directive-free request stays unchanged", () => {
    const retained = { requested_scopes: ["review"] as const };
    const draft = { requested_scopes: [...retained.requested_scopes] };
    expect(initialMintProblemBinding(draft, source.problemId)).toBe("");
    expect(initialMintFirstDirective(draft, source)).toBe("");
    expect(initialMintFirstDirective(undefined, { ...source, target: "C-7" })).toBe("");
  });
});

test("the Fellow selector shows only active review grants usable for this problem", () => {
  const fellow = (id: string, scopes: SponsorFellowSummary["granted_scopes"], binding?: string) => ({
    fellow_id: id, status: "active", granted_scopes: scopes,
    granted_resources: binding === undefined ? {} : { problem_binding: binding },
  }) as SponsorFellowSummary;
  const bound = fellow("bound", ["review"], "P-4DSP");
  const unbound = fellow("unbound", ["review"]);
  expect(reviewFellows([
    bound, unbound, fellow("wrong-problem", ["review"], "P-7KQZ"),
    fellow("no-review", ["promote"], "P-4DSP"),
    { ...bound, fellow_id: "paused", status: "paused" },
    { ...bound, fellow_id: "revoked", status: "revoked" },
  ], source).map((item) => item.fellow_id)).toEqual(["bound", "unbound"]);
});
