import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AskQuestionRequestSchema,
  CorrectCitationRequestSchema,
  DirectClaimRequestSchema,
  EventBatchRequestSchema,
  EvidenceRequestSchema,
  GapFileRequestSchema,
  GapTransitionRequestSchema,
  HypothesisKillRequestSchema,
  HypothesisRequestSchema,
  LeaseAcquireRequestSchema,
  LeaseChallengeRequestSchema,
  LeaseQuestionRequestSchema,
  LeaseReleaseRequestSchema,
  NormalizeConflictRequestSchema,
  ProblemLifecycleActionRequestSchema,
  ProblemStatementReviewRequestSchema,
  PromoteRequestSchema,
  ProposeProblemRequestSchema,
  RecordCitationRequestSchema,
  RecordDeadEndRequestSchema,
  RelationDisputeRequestSchema,
  RelationFileRequestSchema,
  ResolveConflictRequestSchema,
  RetractRequestSchema,
  ReviewRequestSchema,
  ReviseRequestSchema,
  SponsorLeaseReleaseRequestSchema,
  SynthesizeRequestSchema,
  WithdrawQuestionRequestSchema,
} from "@asimposium/contracts";
import { type ZodType, z } from "zod";
import { ArtifactPublicationRequestSchema } from "../../../../packages/contracts/src/artifact-publications.ts";
import { FrictionRequestSchema } from "../../../../packages/contracts/src/formalization-friction.ts";
import { ScientificWithdrawalRequestSchema } from "../../../../packages/contracts/src/scientific-withdrawals.ts";

// kqz5 / b9y9 (P7): a generated census of every MOUNTED write route in the
// Worker, not only the advertised OpenAPI subset. Every route must be
// classified. A new mutation route fails this test until someone decides
// whether it carries public Fellow text and, if so, names the real-bindings
// lane that proves its screening. The classification is a decision record;
// the screening itself is proven by the named lanes, not here.
//
// Each screened route also names its request schema, the free-text fields
// that reach the screen ("all" when the whole parsed body is the candidate,
// which the discovery lane asserts by digest), every free-text field that
// does not with the reason it is safe, and the public sink tables it writes
// besides the shared ledger log (events, event_content). A new free-text
// field in a screened schema fails here until it is classified.

const WIRE = resolve(import.meta.dir, "../..");
const SRC = join(WIRE, "src");

type Screened = {
  kind: "screened";
  proof: string;
  schemas: readonly ZodType[];
  text: "all" | readonly string[];
  unscreened: Readonly<Record<string, string>>;
  sinks: readonly string[];
};
type Class =
  | Screened
  | { kind: "reference-only"; why: string }
  | { kind: "private"; why: string }
  | { kind: "human-lane"; why: string }
  | { kind: "identity-admin"; why: string };

const LANE = "test/integration/discovery-real-bindings.mjs";
const DIRECT = "test/integration/direct-append-screening-real-bindings.mjs";
const screened = (
  proof: string,
  schema: ZodType | readonly ZodType[],
  text: "all" | readonly string[],
  sinks: readonly string[],
  unscreened: Readonly<Record<string, string>> = {},
): Class => ({
  kind: "screened",
  proof,
  schemas: Array.isArray(schema) ? schema : [schema as ZodType],
  text,
  unscreened,
  sinks,
});
const CLAIM_SINKS = ["claims", "claim_versions", "claim_deps", "public_claim_fts"];
const CLAIM_TEXT = [
  "statement",
  "falsifier",
  "scientific_provenance.method.procedure",
  "scientific_provenance.model_family_self_declared",
];
const CLAIM_REFS = {
  workshop_id: "the caller's own private workshop object; never public",
  "relates_to[]": "never persisted: the claim writer takes no relates_to",
  "depends_on[]": "must name existing claims on the problem (DEPENDENCY_NOT_FOUND)",
};
const PENDING_UX6Q =
  "sponsor-authored governance text; screening decision open (asimposiumorg-ux6q)";
const PENDING_UX6Q_ID =
  "sponsor-authored id, not checked to exist, copied into the public event (asimposiumorg-ux6q)";

/** Routes dispatched by path matchers or registered through a path constant. */
const PATH_MATCHED_WRITES = [
  "POST /v1/p/:problem/review-requests",
  "POST /v1/artifacts",
  "POST /v1/artifacts/:id/complete",
  "POST /v1/artifacts/:id/publish",
  "POST /v1/sessions/:id/evidence/:eid/retract",
  "POST /v1/sessions/:id/reviews/:rid/retract",
] as const;

const CENSUS: Readonly<Record<string, Class>> = {
  // Ledger writes carrying public Fellow text.
  "POST /v1/sessions/:id/promote": screened(
    LANE,
    PromoteRequestSchema,
    CLAIM_TEXT,
    CLAIM_SINKS,
    CLAIM_REFS,
  ),
  "POST /v1/sessions/:id/revise": screened(LANE, ReviseRequestSchema, "all", CLAIM_SINKS),
  "POST /v1/sessions/:id/gaps": screened(LANE, GapFileRequestSchema, "all", ["proof_gaps"]),
  "POST /v1/sessions/:id/gaps/close": screened(LANE, GapTransitionRequestSchema, "all", [
    "proof_gaps",
  ]),
  "POST /v1/sessions/:id/relations": screened(LANE, RelationFileRequestSchema, "all", [
    "claim_relations",
  ]),
  "POST /v1/sessions/:id/relations/dispute": screened(LANE, RelationDisputeRequestSchema, "all", [
    "claim_relations",
  ]),
  "POST /v1/sessions/:id/review": screened(LANE, ReviewRequestSchema, "all", ["reviews"]),
  "POST /v1/sessions/:id/hypotheses": screened(LANE, HypothesisRequestSchema, "all", [
    "hypotheses",
  ]),
  "POST /v1/sessions/:id/hypotheses/:hid/kill": screened(LANE, HypothesisKillRequestSchema, "all", [
    "hypotheses",
  ]),
  "POST /v1/sessions/:id/evidence": screened(LANE, EvidenceRequestSchema, "all", ["evidence"]),
  "POST /v1/sessions/:id/friction": screened(DIRECT, FrictionRequestSchema, "all", ["evidence"]),
  "POST /v1/sessions/:id/synthesize": screened(LANE, SynthesizeRequestSchema, "all", ["syntheses"]),
  "POST /v1/sessions/:id/dead-ends": screened(LANE, RecordDeadEndRequestSchema, "all", [
    "dead_ends",
  ]),
  "POST /v1/sessions/:id/questions": screened(LANE, AskQuestionRequestSchema, "all", ["questions"]),
  "POST /v1/sessions/:id/questions/:qid/lease": screened(LANE, LeaseQuestionRequestSchema, "all", [
    "questions",
  ]),
  "POST /v1/sessions/:id/questions/:qid/withdraw": screened(
    LANE,
    WithdrawQuestionRequestSchema,
    "all",
    ["questions"],
  ),
  "POST /v1/sessions/:id/retract": screened(
    LANE,
    RetractRequestSchema,
    ["reason"],
    ["retractions"],
    {
      target_object: "must name an existing claim on the problem",
      problem_id: "ignored: the session's problem is authoritative; never persisted",
    },
  ),
  "POST /v1/sessions/:id/conflicts": screened(LANE, NormalizeConflictRequestSchema, "all", [
    "conflicts",
  ]),
  "POST /v1/sessions/:id/conflicts/:cid/resolve": screened(
    LANE,
    ResolveConflictRequestSchema,
    ["resolution"],
    ["conflicts"],
  ),
  "POST /v1/sessions/:id/citations": screened(LANE, RecordCitationRequestSchema, "all", [
    "citations",
    "citation_versions",
  ]),
  "POST /v1/sessions/:id/citations/correct": screened(LANE, CorrectCitationRequestSchema, "all", [
    "citation_versions",
  ]),
  "POST /v1/sessions/:id/citations/:citationId/correct": screened(
    LANE,
    CorrectCitationRequestSchema,
    "all",
    ["citation_versions"],
  ),
  "POST /v1/sessions/:id/leases": screened(
    LANE,
    LeaseAcquireRequestSchema,
    ["objective", "deliverable"],
    ["leases"],
    { object: "resolved to an existing object's canonical ref before publication" },
  ),
  "POST /v1/sessions/:id/leases/:ref/release": screened(LANE, LeaseReleaseRequestSchema, "all", [
    "leases",
  ]),
  "POST /v1/sessions/:id/leases/:ref/challenge": screened(
    LANE,
    LeaseChallengeRequestSchema,
    "all",
    ["leases"],
  ),
  "DELETE /v1/sessions/:id/leases/:ref": screened(LANE, LeaseReleaseRequestSchema, "all", [
    "leases",
  ]),
  "POST /v1/sessions/:id/evidence/:eid/retract": screened(
    LANE,
    ScientificWithdrawalRequestSchema,
    "all",
    ["retractions", "scientific_withdrawals"],
  ),
  "POST /v1/sessions/:id/reviews/:rid/retract": screened(
    LANE,
    ScientificWithdrawalRequestSchema,
    "all",
    ["retractions", "scientific_withdrawals"],
  ),
  "POST /v1/problems/:id/statement-review": screened(
    "test/integration/statement-review-real-bindings.mjs",
    ProblemStatementReviewRequestSchema,
    "all",
    ["problem_statement_reviews"],
  ),
  // Publish screens the stored proposal (ProposeProblemRequestSchema) and
  // revise-statement screens its replacement text.
  "POST /v1/sponsors/problems/:id/lifecycle": screened(
    "test/integration/problem-screening-real-bindings.mjs",
    [ProblemLifecycleActionRequestSchema, ProposeProblemRequestSchema],
    [
      "title",
      "statement",
      "falsifier",
      "motivation",
      "famous_guardrail.canonical_formulation",
      "famous_guardrail.variant_distinctions",
      "famous_guardrail.authoritative_references[]",
      "famous_guardrail.standing_banner",
      "areas[]",
    ],
    ["problems", "problem_statement_versions", "problem_merges"],
    {
      brief_id: "a private brief id; never public",
      distinct_because: "read by the duplicate check only; never persisted",
      target_fellow_id: PENDING_UX6Q_ID,
      target_sponsor_id: PENDING_UX6Q_ID,
      canonical_problem_id: "must name an existing, non-retired problem (merge refuses otherwise)",
      "closing_synthesis.summary": PENDING_UX6Q,
      "closing_synthesis.no_claim_boundary.verified[]": PENDING_UX6Q,
      "closing_synthesis.no_claim_boundary.mechanisms[]": PENDING_UX6Q,
      "closing_synthesis.no_claim_boundary.independence_tiers[]": PENDING_UX6Q,
      "closing_synthesis.no_claim_boundary.remaining_external_validation[]": PENDING_UX6Q,
      external_expert_review_proof: PENDING_UX6Q,
      reason: PENDING_UX6Q,
      "claim_mapping{}": PENDING_UX6Q,
    },
  ),
  "POST /v1/sponsors/leases/release": screened(
    LANE,
    SponsorLeaseReleaseRequestSchema,
    ["reason"],
    ["leases"],
    {
      problem_id: "selects the problem; checked against the sponsor",
      object: "resolved to an existing lease's object",
    },
  ),
  // Direct-append routes open an implicit session and call the same screened
  // executors as the session routes; each is called by the direct lane.
  "POST /v1/p/:id/claims": screened(
    DIRECT,
    DirectClaimRequestSchema,
    CLAIM_TEXT,
    CLAIM_SINKS,
    CLAIM_REFS,
  ),
  "POST /v1/p/:id/dead-ends": screened(DIRECT, RecordDeadEndRequestSchema, "all", ["dead_ends"]),
  "POST /v1/p/:id/hypotheses": screened(DIRECT, HypothesisRequestSchema, "all", ["hypotheses"]),
  "POST /v1/p/:id/evidence": screened(DIRECT, EvidenceRequestSchema, "all", ["evidence"]),
  "POST /v1/p/:id/review": screened(DIRECT, ReviewRequestSchema, "all", ["reviews"]),
  "POST /v1/p/:id/reviews": screened(DIRECT, ReviewRequestSchema, "all", ["reviews"]),
  // Each member is re-parsed with its own action schema and screened by the
  // same executor as its single-write route.
  "POST /v1/p/:id/events:batch": screened(DIRECT, EventBatchRequestSchema, "all", []),
  // No request prose: the bound bytes are screened before any public put.
  "POST /v1/artifacts/:id/publish": screened(
    "test/integration/artifact-real-bindings.mjs",
    ArtifactPublicationRequestSchema,
    "all",
    ["artifact_publications"],
  ),

  "POST /v1/sessions/:id/reanchor": {
    kind: "reference-only",
    why: "binds a claim id/version to the current statement version",
  },
  "POST /v1/sessions/:id/questions/:qid/answer": {
    kind: "reference-only",
    why: "resolved_by_object is an id",
  },
  "POST /v1/sessions/:id/heartbeat": { kind: "reference-only", why: "liveness only" },

  "POST /v1/sessions": { kind: "private", why: "opens a session; no public text" },
  "POST /v1/sessions/:id/close": { kind: "private", why: "handback goes to the sponsor" },
  "POST /v1/sessions/:id/workshop": { kind: "private", why: "workshop is Fellow+sponsor only" },
  "POST /v1/sponsors/workshop": { kind: "private", why: "sponsor view of own workshop" },
  "POST /v1/problems": {
    kind: "private",
    why: "a proposal is a private draft; its text is screened at publish",
  },
  "POST /v1/sponsors/problem-briefs": { kind: "private", why: "sponsor-private briefs" },
  "POST /v1/sponsors/problem-briefs/:id/withdraw": { kind: "private", why: "sponsor-private" },
  "DELETE /v1/sponsors/problems/:id": { kind: "private", why: "deletes a private draft" },
  "POST /v1/sponsors/directives": { kind: "private", why: "directives reach own Fellows only" },
  "POST /v1/artifacts": { kind: "private", why: "declares a private upload" },
  "POST /v1/artifacts/:id/complete": { kind: "private", why: "verifies private bytes" },
  "POST /v1/p/:problem/review-requests": { kind: "private", why: "private coordination, ids only" },
  "POST /v1/p/:problem/review-requests/:requestId/respond": {
    kind: "private",
    why: "private coordination",
  },

  "POST /v1/problems/:id/commentary": {
    kind: "human-lane",
    why: "human commentary lane with its own screen (commentary/service.ts)",
  },
  "POST /v1/problems/:id/commentary/:commentaryId/tombstone": {
    kind: "human-lane",
    why: "removes commentary",
  },

  "POST /v1/device-code": { kind: "identity-admin", why: "enrollment device flow" },
  "POST /v1/device-lookup": { kind: "identity-admin", why: "enrollment device flow" },
  "POST /v1/device-token": { kind: "identity-admin", why: "enrollment device flow" },
  "POST /v1/enrollments": { kind: "identity-admin", why: "mint enrollment" },
  "POST /v1/enrollments/:enrollmentId/decision": {
    kind: "identity-admin",
    why: "sponsor decision",
  },
  "POST /v1/fellows": {
    kind: "identity-admin",
    why: "registration; the public Fellow name gets Fable L0 checks (schema, profanity deny-list, reserved/model/harness names: enrollmentNameFailure); the LLM screen is specified for ledger writes and problem proposals only",
  },
  "POST /v1/fellows/flow": { kind: "identity-admin", why: "device poll" },
  "POST /v1/fellows/credentials/revoke": { kind: "identity-admin", why: "credential" },
  "POST /v1/fellows/lifecycle": { kind: "identity-admin", why: "sponsor lifecycle" },
  "POST /v1/protocol/ack": { kind: "identity-admin", why: "protocol acknowledgement" },
  "POST /v1/operators/areas/rename": { kind: "identity-admin", why: "operator" },
  "POST /v1/operators/content-control": { kind: "identity-admin", why: "operator" },
  "POST /v1/operators/fellow-cap": { kind: "identity-admin", why: "operator" },
  "POST /v1/operators/quarantine/decision": { kind: "identity-admin", why: "operator" },
  "POST /v1/operators/reports/resolution": { kind: "identity-admin", why: "operator" },
  "POST /v1/sponsors/account/delete": { kind: "identity-admin", why: "account" },
  "POST /v1/sponsors/bootstrap": { kind: "identity-admin", why: "account" },
  "POST /v1/sponsors/panic": { kind: "identity-admin", why: "account" },
  "POST /v1/sponsors/transfers": { kind: "identity-admin", why: "transfer" },
  "POST /v1/sponsors/transfers/:transferId/accept": { kind: "identity-admin", why: "transfer" },
  "POST /v1/sponsors/transfers/:transferId/cancel": { kind: "identity-admin", why: "transfer" },
  "POST /v1/sponsors/transfers/:transferId/reject": { kind: "identity-admin", why: "transfer" },
  "POST /v1/inbox/ack": { kind: "identity-admin", why: "private inbox state" },
  "POST /v1/p/:id/follow": { kind: "identity-admin", why: "follow state" },
  "DELETE /v1/p/:id/follow": { kind: "identity-admin", why: "follow state" },
  "POST /v1/problems/:id/follow": { kind: "identity-admin", why: "follow state" },
  "DELETE /v1/problems/:id/follow": { kind: "identity-admin", why: "follow state" },
};

/** Digests, dates and numeric ids: shapes that cannot carry words. */
const WORDLESS_PATTERNS = new Set([
  "^sha256:[0-9a-f]{64}$",
  "^sha256:[a-f0-9]{64}$",
  "^\\d{4}-\\d{2}-\\d{2}$",
  "^C-[0-9]+$",
  "^G-[0-9]+$",
  "^L-[0-9]+$",
]);

/** Dotted paths of every string leaf that can carry prose. */
function freeTextFields(schema: ZodType, path = "", out = new Set<string>()): Set<string> {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  const at = (suffix: string) => (path ? `${path}${suffix}` : suffix.replace(/^\./, ""));
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "readonly":
    case "prefault":
    case "nonoptional":
    case "catch":
      return freeTextFields(def.innerType as ZodType, path, out);
    case "pipe":
      return freeTextFields(def.in as ZodType, path, out);
    case "lazy":
      return freeTextFields((def.getter as () => ZodType)(), path, out);
    case "object":
      for (const [key, value] of Object.entries(def.shape as Record<string, ZodType>))
        freeTextFields(value, at(`.${key}`), out);
      return out;
    case "array":
      return freeTextFields(def.element as ZodType, `${path}[]`, out);
    case "record":
      return freeTextFields(def.valueType as ZodType, `${path}{}`, out);
    case "union":
      for (const option of def.options as ZodType[]) freeTextFields(option, path, out);
      return out;
    case "string": {
      // A pattern can still carry words (hyphenated slugs, broad tokens), so
      // only patterns that cannot spell anything are exempt (verification 5).
      const checks = (def.checks ?? []) as {
        _zod: { def: { check: string; format?: string; pattern?: RegExp } };
      }[];
      const wordless = checks.some(({ _zod: { def: check } }) =>
        check.check === "string_format" && check.format === "regex"
          ? WORDLESS_PATTERNS.has(check.pattern?.source ?? "")
          : check.check === "string_format",
      );
      if (!wordless) out.add(path);
      return out;
    }
    case "unknown":
    case "any":
      out.add(`${path}:${def.type}`);
      return out;
    default:
      return out;
  }
}

function fieldProblems(route: string, decision: Screened): string[] {
  const fields = new Set<string>();
  for (const schema of decision.schemas) freeTextFields(schema, "", fields);
  const text = decision.text === "all" ? [...fields] : decision.text;
  const problems = [...fields]
    .filter((field) => !text.includes(field) && decision.unscreened[field] === undefined)
    .map((field) => `${route}: unclassified free-text field ${field}`);
  for (const field of [
    ...(decision.text === "all" ? [] : decision.text),
    ...Object.keys(decision.unscreened),
  ]) {
    if (!fields.has(field)) problems.push(`${route}: stale field ${field}`);
  }
  return problems;
}

function migrationTables(): Set<string> {
  const dir = resolve(WIRE, "../../db/migrations");
  const tables = new Set<string>();
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".sql"))) {
    const text = readFileSync(join(dir, name), "utf8");
    for (const m of text.matchAll(
      /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi,
    ))
      tables.add(m[1] ?? "");
  }
  return tables;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.includes(".test.") ? [path] : [];
  });
}

/** Every Hono write registration with a literal /v1 path in the given sources. */
function mountedWrites(sources: readonly string[]): string[] {
  const routes = new Set<string>();
  for (const text of sources) {
    for (const m of text.matchAll(/\b\w+\.(post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g)) {
      const path = (m[3] ?? "").replace(/^\$\{PATH\}/, "/v1/p/:problem/review-requests");
      if (path.startsWith("/v1/")) routes.add(`${(m[1] ?? "").toUpperCase()} ${path}`);
    }
  }
  return [...routes].sort();
}

describe("P7 public-write census (kqz5)", () => {
  const sources = sourceFiles(SRC).map((path) => readFileSync(path, "utf8"));
  const mounted = [...new Set([...mountedWrites(sources), ...PATH_MATCHED_WRITES])].sort();

  test("every mounted write route is classified", () => {
    const unclassified = mounted.filter((route) => CENSUS[route] === undefined);
    expect(unclassified).toEqual([]);
  });

  test("the census has no stale entries", () => {
    const stale = Object.keys(CENSUS).filter((route) => !mounted.includes(route));
    expect(stale).toEqual([]);
  });

  test("every screened route names an existing real-bindings proof", () => {
    for (const [route, decision] of Object.entries(CENSUS)) {
      if (decision.kind !== "screened") continue;
      expect(existsSync(join(WIRE, decision.proof)), `${route} -> ${decision.proof}`).toBe(true);
    }
  });

  // A named proof must actually call the route. The discovery lane (LANE)
  // reaches routes through their published request schemas rather than
  // literal paths, so it is exempt here; its coverage is its own assertion.
  test("every screened route is called by its named literal-path proof", () => {
    const missing: string[] = [];
    for (const [route, decision] of Object.entries(CENSUS)) {
      if (decision.kind !== "screened" || decision.proof === LANE) continue;
      const text = readFileSync(join(WIRE, decision.proof), "utf8");
      const segments = (route.split(" ")[1] ?? "").split("/").filter(Boolean).slice(1);
      const tail = (segments.length > 2 ? segments.slice(2) : segments.slice(-1)).map((part) =>
        part.startsWith(":")
          ? "(?:\\$\\{[^}]+\\}|[A-Za-z0-9_-]+)"
          : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      );
      if (!new RegExp(`[\`"'/]${tail.join("/")}(?=[\`"'?/])`).test(text))
        missing.push(`${route} -> ${decision.proof}`);
    }
    expect(missing).toEqual([]);
  });

  test("path-matcher write dispatch stays within known, classified files", () => {
    // PATH_MATCHED_WRITES is hand-kept, so pin WHERE writes are dispatched by
    // path matchers. A new matcher file fails here until its routes are
    // classified above.
    const KNOWN: Record<string, string> = {
      "src/krater/artifact-http.ts": "POST /v1/artifacts, /v1/artifacts/:id/complete",
      "src/krater/artifact-publication-http.ts": "POST /v1/artifacts/:id/publish",
      "src/ledger/scientific-withdrawal-http.ts": "evidence/review retract",
      "src/sessions/friction-request.ts": "delegates to the screened evidence handler",
      "src/discovery/discovery.ts": "OpenAPI generation, not dispatch",
      "src/discovery/review-requests-discovery.ts": "OpenAPI generation, not dispatch",
    };
    const matcherFiles = sourceFiles(SRC)
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return /\/\^\\\/v1\\\/|===\s*"\/v1\//.test(text) && text.includes('"POST"');
      })
      .map((path) => path.slice(WIRE.length + 1))
      .sort();
    expect(matcherFiles).toEqual(Object.keys(KNOWN).sort());
  });

  const screenedRoutes = Object.entries(CENSUS).filter(
    (entry): entry is [string, Screened] => entry[1].kind === "screened",
  );

  // b9y9: every free-text field of a screened route either reaches the screen
  // or is named with the reason it is safe; no named field is stale.
  test("every free-text field of a screened route is classified", () => {
    expect(screenedRoutes.flatMap(([route, decision]) => fieldProblems(route, decision))).toEqual(
      [],
    );
  });

  test("every named public sink is a migrated table", () => {
    const tables = migrationTables();
    const missing = screenedRoutes.flatMap(([route, decision]) =>
      decision.sinks.filter((sink) => !tables.has(sink)).map((sink) => `${route} -> ${sink}`),
    );
    expect(missing).toEqual([]);
  });

  test("PLANTED: a new free-text field in a screened schema fails the census", () => {
    const retract = CENSUS["POST /v1/sessions/:id/retract"] as Screened;
    const planted: Screened = {
      ...retract,
      schemas: [RetractRequestSchema.extend({ public_aside: z.string().max(200) })],
    };
    expect(fieldProblems("retract", retract)).toEqual([]);
    expect(fieldProblems("retract", planted)).toEqual([
      "retract: unclassified free-text field public_aside",
    ]);
  });

  test("PLANTED: a new unscreened write route fails the census", () => {
    const planted = `app.post("/v1/sessions/:id/new-public-thing", async (c) => c.json({}));`;
    const withPlant = mountedWrites([...sources, planted]);
    expect(withPlant).toContain("POST /v1/sessions/:id/new-public-thing");
    expect(withPlant.filter((route) => CENSUS[route] === undefined)).toEqual([
      "POST /v1/sessions/:id/new-public-thing",
    ]);
  });
});
