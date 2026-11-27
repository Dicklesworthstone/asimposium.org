import { describe, expect, test } from "bun:test";
import type { SponsorFellowSummary } from "@asimposium/contracts";
import { SponsorDirectiveRequestSchema } from "@asimposium/contracts/directives";
import { initialMintFirstDirective, initialMintProblemBinding } from "../../app/console/join-paste";
import {
  isStatementReview,
  parseReviewHandoff,
  reviewDirectiveText,
  reviewFellows,
  reviewHandoffForClaim,
  reviewHandoffForStatement,
  reviewHandoffFromQuery,
  reviewHandoffHref,
  reviewSourceHref,
  reviewSponsorEligible,
  statementReviewVersion,
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
  const author = fellow("author", ["review"], "P-4DSP");
  expect(reviewFellows([
    bound, unbound, author, fellow("wrong-problem", ["review"], "P-7KQZ"),
    fellow("no-review", ["promote"], "P-4DSP"),
    { ...bound, fellow_id: "paused", status: "paused" },
    { ...bound, fellow_id: "revoked", status: "revoked" },
  ], source, author.fellow_id).map((item) => item.fellow_id)).toEqual(["bound", "unbound"]);
  expect(reviewFellows([author], source, author.fellow_id)).toEqual([]);
  expect(reviewFellows([bound, unbound], source, undefined)).toEqual([]);
  expect(reviewFellows([bound, unbound], source, "")).toEqual([]);
});

describe("exact statement review handoff", () => {
  const statement = { problemId: "P-4DSP", target: "S@2", through: "85" };
  const sponsor = "usr_independent_reviewer";
  const authorSponsor = "usr_statement_author";

  test("pins the public formulation and cut through sign-in and Fellow pagination", () => {
    expect(reviewHandoffForStatement("P-4DSP", 2, 85)).toEqual(statement);
    expect(isStatementReview(statement)).toBe(true);
    expect(statementReviewVersion(statement)).toBe(2);
    expect(isStatementReview(source)).toBe(false);
    expect(reviewSourceHref(statement)).toBe("/p/P-4DSP/statements/2?through=85");
    const link = new URL(reviewHandoffHref(statement), "https://asimposium.org");
    expect(reviewHandoffFromQuery(Object.fromEntries(link.searchParams))).toEqual(statement);
    const paged = new URL(consolePageHref({
      onboardingProblem: statement.problemId, reviewContext: statement, fellowCursor: "older-fellows",
    }), "https://asimposium.org");
    expect(reviewHandoffFromQuery(Object.fromEntries(paged.searchParams))).toEqual(statement);
    expect(paged.searchParams.get("fellow_cursor")).toBe("older-fellows");
  });

  test("rejects malformed, ambiguous and noncanonical statement versions", () => {
    for (const target of ["S", "S@0", "S@02", "S@-1", "S@1.5", "S@2\n", "S@9007199254740992", "S@2/title", "S@2@3"]) {
      expect(parseReviewHandoff({ ...statement, target })).toBeUndefined();
    }
    expect(reviewHandoffForStatement("P-4DSP", 0, 85)).toBeUndefined();
    expect(reviewHandoffForStatement("P-4DSP", 2.5, 85)).toBeUndefined();
    expect(reviewHandoffForStatement("P-4DSP", 2, Infinity)).toBeUndefined();
    expect(reviewHandoffFromQuery({ problem: "P-4DSP", review: ["S@1", "S@2"], review_through: "85" })).toBeUndefined();
  });

  test("uses the statement write path even when a working pack has no sharpening move", () => {
    const text = reviewDirectiveText(statement);
    expect(text).toContain("P-4DSP/S@2 at cursor 85");
    expect(text).toContain("sharpen-statement session");
    expect(text).toContain("current formulation");
    expect(text).toContain("Stop if the version changed");
    expect(text).toContain("POST /v1/problems/P-4DSP/statement-review");
    expect(text).toContain("session_id, statement_version=2, your own verdict and basis");
    expect(text).toContain("stable Idempotency-Key");
    expect(text).not.toContain("isolated review pack");
    expect(text).not.toContain("statement-clear");
    const largest = reviewHandoffForStatement(
      "P-" + "A".repeat(31), Number.MAX_SAFE_INTEGER, 999999999999999,
    );
    expect(largest).toBeDefined();
    expect(reviewDirectiveText(largest!).length).toBeLessThanOrEqual(500);
    expect(SponsorDirectiveRequestSchema.safeParse({
      fellow_id: "FEL-12345678", problem_id: largest!.problemId,
      verb: "focus", text: reviewDirectiveText(largest!),
    }).success).toBe(true);
  });

  test("a fresh enrollment inherits the exact statement task without changing retained recovery bodies", () => {
    expect(initialMintProblemBinding(undefined, statement.problemId)).toBe(statement.problemId);
    expect(initialMintFirstDirective(undefined, statement)).toBe(reviewDirectiveText(statement));
    const retained = { requested_scopes: ["review" as const], first_directive: "Finish the earlier task." };
    expect(initialMintProblemBinding(retained, statement.problemId)).toBe("");
    expect(initialMintFirstDirective(retained, statement)).toBe(retained.first_directive);
  });

  test("author sponsorship cannot become independent by selecting or enrolling a different Fellow", () => {
    expect(reviewSponsorEligible(statement, sponsor, authorSponsor)).toBe(true);
    expect(reviewSponsorEligible(statement, authorSponsor, authorSponsor)).toBe(false);
    expect(reviewSponsorEligible(statement, sponsor, undefined)).toBe(false);
    expect(reviewSponsorEligible(statement, undefined, authorSponsor)).toBe(false);
    expect(reviewSponsorEligible(source, sponsor, sponsor)).toBe(true);
    const fellow = (id: string, scopes: SponsorFellowSummary["granted_scopes"], binding?: string) => ({
      fellow_id: id, status: "active", granted_scopes: scopes,
      granted_resources: binding === undefined ? {} : { problem_binding: binding },
    }) as SponsorFellowSummary;
    const eligible = fellow("FEL-12345678", ["review"], statement.problemId);
    const unbound = fellow("FEL-12345679", ["review"]);
    const author = fellow("FEL-87654321", ["review"], statement.problemId);
    const candidates = [
      eligible, unbound, author,
      fellow("wrong-problem", ["review"], "P-7KQZ"),
      fellow("no-review", ["promote"], statement.problemId),
      { ...eligible, fellow_id: "paused", status: "paused" as const },
      { ...eligible, fellow_id: "revoked", status: "revoked" as const },
    ];
    expect(reviewFellows(candidates, statement, author.fellow_id, sponsor, authorSponsor))
      .toEqual([eligible, unbound]);
    expect(reviewFellows(candidates, statement, author.fellow_id, authorSponsor, authorSponsor))
      .toEqual([]);
    expect(reviewFellows(candidates, statement, author.fellow_id, sponsor)).toEqual([]);
  });
});
