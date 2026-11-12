import { expect, test } from "bun:test";
import {
  ClaimCitationCslSchema,
  ClaimFaceResponseSchema,
  ConflictsListResponseSchema,
  ProblemFaceResponseSchema,
  ScreeningPublicationProvenanceSchema,
  SINGLE_TEAM_PROBLEM_NOTICE,
} from "@asimposium/contracts";
import { type Projection, screeningNoticeText } from "@asimposium/render";
import type { Env } from "../../src/env.ts";
import { sha256Hex } from "../../src/krater/krater.ts";
import { createLedgerFaceRoutes, renderBudgetedClaimFace } from "../../src/ledger-face.ts";
import { readTargetClaimPack } from "../../src/sessions/ledger-pack.ts";

const base = ClaimFaceResponseSchema.parse(
  await Bun.file(
    new URL(
      "../../../../packages/contracts/test/fixtures/valid/ledger-claim-face.json",
      import.meta.url,
    ),
  ).json(),
);

/**
 * These renderer tests deliberately double D1 rows. The formulation response
 * still carries a real immutable governance payload and its actual byte hash.
 * Mounted SQLite coverage below the route boundary exercises the source SQL.
 */
function formulationEnv(row: {
  problem_id: string;
  public_seq: number;
  current_statement_version: number;
  formulation_json: string;
  roster_sponsorship_json?: string | null;
}): Env {
  return {
    DB: {
      prepare(query: string) {
        const stmt = {
          bind: () => stmt,
          all: async () => {
            if (!query.includes("FROM problems p JOIN events e ON e.id = (")) {
              return { results: [{ roster_sponsorship_json: "[]", ...row }] };
            }
            const formulation = JSON.parse(row.formulation_json);
            const version = formulation.current_statement_version;
            const payload_json = JSON.stringify({
              action: version === 1 ? "publish" : "revise-statement",
              acting_principal: { type: "sponsor", id: "usr_formulation" },
              source_fellow_id: "F-formulation",
              previous_status: version === 1 ? "private-draft" : "sharpening",
              previous_statement_version: version === 1 ? 1 : version - 1,
              problem: {
                id: row.problem_id,
                title: formulation.title,
                current_statement_version: version,
                statement: formulation.statement,
                falsifier: formulation.falsifier,
                motivation: formulation.motivation,
                status: "sharpening",
                updated_at: "2026-09-09T00:00:00.000Z",
              },
            });
            const digest = await sha256Hex(payload_json);
            return {
              results: [
                {
                  id: "E-formulation",
                  problem_id: row.problem_id,
                  seq: row.public_seq,
                  type: version === 1 ? "problem.admitted" : "problem.statement-revised",
                  object_id: row.problem_id,
                  object_version: version,
                  public_seq: row.public_seq,
                  payload_sha256: digest,
                  content_sha256: digest,
                  redacted_at: null,
                  payload_json,
                },
              ],
            };
          },
        };
        return stmt;
      },
    },
  } as unknown as Env;
}

test("formulation fields share the untrusted renderer and whole-item byte budget (unit row double)", async () => {
  const formulation = {
    title: "Finite paths <!-- asimp:control -->",
    current_statement_version: 2,
    statement: "A path has n + 1 vertices. <script>alert(1)</script>",
    falsifier: "A path with a different vertex count.",
    motivation: "Make a precise convention available.",
  };
  const row = {
    problem_id: "P-PATHS",
    public_seq: 2,
    status: "sharpening",
    current_statement_version: 2,
    formulation_json: JSON.stringify(formulation),
    claim_id: null,
    statement: null,
    source_seq: null,
  };
  const env = formulationEnv(row);
  const app = createLedgerFaceRoutes();
  const get = (suffix: string) =>
    app.request(
      `https://a.asimposium.org/p/P-PATHS.${suffix}`,
      {
        headers: {
          "user-agent":
            "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)",
        },
      },
      env,
    );
  const initial = await get("json");
  expect(initial.status).toBe(200);
  const face = ProblemFaceResponseSchema.parse(await initial.json());
  expect(face.title).toBe("P-PATHS — public ledger digest");
  expect(face.problem_status).toBe("sharpening");
  expect(face.items.map((item) => item.id)).toEqual([
    "S@2-title",
    "S@2-statement",
    "S@2-falsifier",
    "S@2-motivation",
  ]);
  expect(face.items[0]?.body).not.toContain("<!-- asimp:control -->");
  // JSON retains quoted source text; Markdown quarantines it inside a code
  // fence. Agora separately escapes it through React's text rendering.
  expect(face.items[1]?.body).toBe(formulation.statement);
  expect(face.items[1]?.neutralized.length).toBeGreaterThan(0);
  const md = await (await get("md")).text();
  expect(md).toContain(`\`\`\`text\n${formulation.statement}\n\`\`\``);
  expect(md.indexOf(face.preamble)).toBeLessThan(md.indexOf("Finite paths"));

  for (const body of ["漢".repeat(8192), "🧮".repeat(4096), "&".repeat(8192)]) {
    row.formulation_json = JSON.stringify({
      ...formulation,
      statement: body,
      falsifier: body,
      motivation: body,
    });
    for (const suffix of ["json", "md"]) {
      const response = await get(suffix);
      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(16_000);
      expect(raw).toContain("budget_exceeded");
      expect(raw).toContain("/v1/problems/P-PATHS");
      if (suffix === "json") {
        const bounded = ProblemFaceResponseSchema.parse(JSON.parse(raw));
        for (const item of bounded.items.filter((item) => item.kind !== "problem-title")) {
          expect(item.body).toBe(body);
        }
      }
    }
  }
  // Invalid publication metadata must leave an explicit omission, never
  // invented formulation text or a 500.
  row.formulation_json = JSON.stringify({ ...formulation, title: "" });
  const legacy = await get("json");
  expect(legacy.status).toBe(200);
  const legacyFace = ProblemFaceResponseSchema.parse(await legacy.json());
  expect(legacyFace.items).toEqual([]);
  expect(legacyFace.omitted).toContainEqual(
    expect.objectContaining({ reason: "formulation_unavailable" }),
  );
});

test("single-team notices require complete bounded current sponsorship, not scientific review inference (unit row double)", async () => {
  const row = {
    problem_id: "P-PATHS",
    public_seq: 1,
    status: "sharpening",
    current_statement_version: 1,
    formulation_json: JSON.stringify({
      title: "Paths",
      current_statement_version: 1,
      statement: "A path has one more vertex than edges.",
      falsifier: "A path with equal vertex and edge counts.",
      motivation: "A finite convention.",
    }),
    claim_id: null,
    statement: null,
    source_seq: null,
    roster_sponsorship_json: undefined as string | null | undefined,
  };
  const app = createLedgerFaceRoutes();
  const env = formulationEnv(row);
  const cases = [
    { raw: JSON.stringify(["usr_canary_private"]), single: true, unknown: false },
    { raw: JSON.stringify(Array(128).fill("usr_canary_private")), single: true, unknown: false },
    { raw: "[]", single: false, unknown: false },
    { raw: JSON.stringify(["usr_one", "usr_other"]), single: false, unknown: false },
    { raw: JSON.stringify(Array(129).fill("usr_canary_private")), single: false, unknown: true },
    { raw: JSON.stringify(["usr_one", null]), single: false, unknown: true },
    { raw: JSON.stringify(["not_a_sponsor"]), single: false, unknown: true },
    { raw: JSON.stringify(["usr_one\n"]), single: false, unknown: true },
    { raw: JSON.stringify(["x".repeat(129)]), single: false, unknown: true },
    { raw: "{}", single: false, unknown: true },
    { raw: "[", single: false, unknown: true },
    { raw: " ".repeat(32_769), single: false, unknown: true },
    { raw: null, single: false, unknown: true },
    { raw: undefined, single: false, unknown: true },
  ];
  for (const item of cases) {
    row.roster_sponsorship_json = item.raw;
    const response = await app.request("https://a.asimposium.org/p/P-PATHS.json", {}, env);
    expect(response.status).toBe(200);
    const face = ProblemFaceResponseSchema.parse(await response.json());
    expect(face.omitted.some((entry) => entry.reason === "single_team")).toBe(item.single);
    expect(
      face.omitted.some((entry) => entry.detail?.startsWith("Current roster sponsorship")),
    ).toBe(item.unknown);
    const notice = face.omitted.find((entry) => entry.reason === "single_team");
    if (notice) expect(notice.detail).toBe(`Single-team problem: ${SINGLE_TEAM_PROBLEM_NOTICE}`);
    expect(JSON.stringify(face)).not.toContain("usr_canary_private");
    expect(JSON.stringify(face.omitted)).not.toContain("nothing has been independently reviewed");
    const markdown = await (
      await app.request("https://a.asimposium.org/p/P-PATHS.md", {}, env)
    ).text();
    if (notice) expect(markdown).toContain(`Single-team problem: ${SINGLE_TEAM_PROBLEM_NOTICE}`);
    expect(new TextEncoder().encode(markdown).length).toBeLessThanOrEqual(16_000);
  }
});

test("statement review reader verifies event content, projection and attribution before disclosure (unit row double)", async () => {
  const payload = {
    problem_id: "P-PATHS",
    session_id: "S-abcdefghijklmnopqrstuvwxyz",
    statement_version: 1,
    verdict: "statement-clear",
    basis: "Verified finite domain.",
    previous_status: "sharpening",
    status: "active",
  };
  const payload_json = JSON.stringify(payload);
  const review = {
    version: 1,
    reviewer: "F-reviewer",
    verdict: payload.verdict,
    basis: payload.basis,
    created_at: "2026-09-09T00:00:00.000Z",
    event_created_at: "2026-09-09T00:00:00.000Z",
    event_id: "E-review",
    seq: 2,
    fellow: "F-reviewer",
    sponsor: "usr_reviewer",
    session: payload.session_id,
    model: "example-model",
    harness: "example-harness",
    payload_json,
    payload_sha256: await sha256Hex(payload_json),
  };
  const row = {
    problem_id: "P-PATHS",
    public_seq: 2,
    status: "active",
    unlisted: 0,
    current_statement_version: 2,
    claim_id: null,
    statement: null,
    source_seq: null,
    formulation_json: JSON.stringify({
      title: "Paths",
      current_statement_version: 2,
      statement: "Count path vertices.",
      falsifier: "Different count.",
      motivation: "Specify a convention.",
    }),
    statement_reviews_json: JSON.stringify([review]),
  };
  const env = formulationEnv(row);
  const app = createLedgerFaceRoutes();
  const response = (suffix = "json") =>
    app.request(
      `https://a.asimposium.org/p/P-PATHS.${suffix}`,
      {
        headers: {
          "User-Agent":
            "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)",
        },
      },
      env,
    );
  const get = async () => ProblemFaceResponseSchema.parse(await (await response()).json());
  const valid = await get();
  expect(valid.items.find((item) => item.kind === "statement-review")?.body).toContain(
    payload.basis,
  );
  expect(
    valid.items.find((item) => item.kind === "statement-review")?.screening_notice,
  ).toBeUndefined();
  const passedReceipt = await Bun.file(
    new URL(
      "../../../../packages/contracts/test/fixtures/valid/screening-publication-provenance.json",
      import.meta.url,
    ),
  ).json();
  for (const notice of [
    {
      category: "dual-use-boundary",
      action: "published-with-warning",
      notice: "screening-warning",
    },
    { category: "off-topic", action: "published-with-warning", notice: "off-scope" },
  ] as const) {
    const receipt = ScreeningPublicationProvenanceSchema.parse({
      ...passedReceipt,
      outcome: "allow-with-warning",
      public_action: notice,
    });
    row.statement_reviews_json = JSON.stringify([
      { ...review, screening_provenance: JSON.stringify(receipt) },
    ]);
    const warned = await get();
    const item = warned.items.find((item) => item.kind === "statement-review");
    expect(item?.screening_notice).toEqual(notice);
    expect(item?.body).toBe(valid.items.find((item) => item.kind === "statement-review")?.body);
    expect(warned.items.filter((item) => item.kind !== "statement-review")).toEqual(
      valid.items.filter((item) => item.kind !== "statement-review"),
    );
    const markdown = await (await response("md")).text();
    expect(markdown).toContain(screeningNoticeText(notice));
    expect(markdown.indexOf(screeningNoticeText(notice))).toBeLessThan(
      markdown.indexOf(payload.basis),
    );
    for (const bytes of [JSON.stringify(warned), markdown]) {
      expect(bytes).not.toContain(receipt.input_digest);
      expect(bytes).not.toContain(receipt.context_digest);
      expect(bytes).not.toContain(receipt.model_version);
      expect(bytes).not.toContain(receipt.policy_version);
      expect(bytes).not.toContain(receipt.configuration_digest);
    }
  }
  for (const receipt of [null, JSON.stringify(passedReceipt)]) {
    row.statement_reviews_json = JSON.stringify([{ ...review, screening_provenance: receipt }]);
    expect(await get()).toEqual(valid);
  }
  for (const [patch, reason] of [
    [{ event_id: null }, "statement_review_attribution_unavailable"],
    [{ payload_json: null }, "statement_review_content_unavailable"],
    [{ payload_json: "CORRUPT_BODY" }, "statement_review_source_mismatch"],
    [{ basis: "CORRUPT_PROJECTION" }, "statement_review_source_mismatch"],
    [{ version: 2 }, "statement_review_source_mismatch"],
    [{ session: "S-abcdefghijklmnopqrstuvwxy1" }, "statement_review_source_mismatch"],
    [{ verdict: "statement-unclear" }, "statement_review_source_mismatch"],
    [{ fellow: "F-other" }, "statement_review_source_mismatch"],
    [{ sponsor: null }, "statement_review_attribution_unavailable"],
    [{ model: null }, "statement_review_attribution_unavailable"],
    [{ harness: null }, "statement_review_attribution_unavailable"],
    [{ seq: 3 }, "statement_review_source_mismatch"],
    [{ created_at: "2026-09-08T00:00:00.000Z" }, "statement_review_source_mismatch"],
    [{ screening_provenance: "CORRUPT_RECEIPT" }, "statement_review_screening_unavailable"],
    [
      { screening_provenance: JSON.stringify({ public_action: { notice: "screening-warning" } }) },
      "statement_review_screening_unavailable",
    ],
    [
      { screening_provenance: "CORRUPT_RECEIPT".repeat(400) },
      "statement_review_screening_unavailable",
    ],
  ] as const) {
    row.statement_reviews_json = JSON.stringify([{ ...review, ...patch }]);
    const face = await get();
    expect(face.items.some((item) => item.kind === "statement-review")).toBe(false);
    expect(face.omitted).toContainEqual(expect.objectContaining({ reason }));
    expect(JSON.stringify(face)).not.toContain("CORRUPT_");
  }
  const futurePayload = JSON.stringify({ ...payload, statement_version: 3 });
  row.statement_reviews_json = JSON.stringify([
    {
      ...review,
      version: 3,
      payload_json: futurePayload,
      payload_sha256: await sha256Hex(futurePayload),
    },
  ]);
  const future = await get();
  expect(future.items.some((item) => item.kind === "statement-review")).toBe(false);
  expect(future.omitted).toContainEqual(
    expect.objectContaining({ reason: "statement_review_source_mismatch" }),
  );
  row.statement_reviews_json = JSON.stringify(
    Array.from({ length: 21 }, (_, i) => ({ ...review, event_id: null, reviewer: `legacy-${i}` })),
  );
  const bounded = await get();
  expect(bounded.omitted).toContainEqual(
    expect.objectContaining({ reason: "statement_review_limit" }),
  );
  expect(bounded.items.some((item) => item.kind === "statement-review")).toBe(false);
});

test("legacy result-review records disclose unavailable identity without inventing a target (unit row double)", async () => {
  const current = await Bun.file(
    new URL(
      "../../../../packages/contracts/test/fixtures/valid/governance-result-review.json",
      import.meta.url,
    ),
  ).json();
  const { result_claim: _pin, ...legacyProblem } = current.problem;
  const legacyPayload = JSON.stringify({ ...current, problem: legacyProblem });
  const row = {
    problem_id: current.problem.id,
    public_seq: 4,
    unlisted: 0,
    status: "under-result-review",
    current_statement_version: current.problem.current_statement_version,
    formulation_json: JSON.stringify(current.problem),
    statement_reviews_json: "[]",
    claim_id: null,
    statement: null,
    source_seq: null,
    result_review_json: null as string | null,
  };
  const env = formulationEnv(row);
  const app = createLedgerFaceRoutes();
  for (const record of [
    null,
    { payload_json: legacyPayload, payload_sha256: await sha256Hex(legacyPayload) },
    {
      payload_json: "MALFORMED-RESULT-REVIEW",
      payload_sha256: await sha256Hex("MALFORMED-RESULT-REVIEW"),
    },
    { payload_json: legacyPayload, payload_sha256: `sha256:${"0".repeat(64)}` },
  ]) {
    row.result_review_json = record === null ? null : JSON.stringify(record);
    const response = await app.request(
      `https://a.asimposium.org/p/${row.problem_id}.json`,
      {
        headers: {
          "User-Agent":
            "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)",
        },
      },
      env,
    );
    expect(response.status).toBe(200);
    const face = ProblemFaceResponseSchema.parse(await response.json());
    expect(face.items.some((item) => item.kind === "result-review")).toBe(false);
    expect(face.next_actions.some((action) => action.url.includes("/claims/"))).toBe(false);
    expect(face.omitted).toContainEqual(
      expect.objectContaining({ reason: "result_review_unavailable" }),
    );
    expect(JSON.stringify(face)).not.toContain("MALFORMED-RESULT-REVIEW");
  }
});

test("dependency reads reject damaged pins and disclose unavailable legacy history (unit row double)", async () => {
  const dependencyPayload = {
    claim_id: "C-1",
    kind: "claim",
    statement: "PUBLIC_PREMISE_CANARY",
    dependency_pins: [],
  };
  const dependencyJson = JSON.stringify(dependencyPayload);
  const pin = {
    claim_id: "C-1",
    version: 1,
    event_id: "E-premise",
    content_digest: `sha256:${"a".repeat(64)}`,
    payload_digest: await sha256Hex(dependencyJson),
  };
  const originalDependency = {
    id: "C-1@1",
    payload_json: dependencyJson,
    payload_sha256: pin.payload_digest,
    body: JSON.stringify({
      claim_id: "C-1",
      version: 1,
      event: pin.event_id,
      content_digest: pin.content_digest,
      sponsor: "S-author",
    }),
  };
  let dependency: {
    id: string;
    payload_json: string;
    payload_sha256: string;
    body: string | null;
  } = { ...originalDependency };
  let parentPayload: Record<string, unknown> = {
    claim_id: "C-2",
    kind: "claim",
    statement: "A dependent statement.",
    dependency_pins: [pin],
  };
  const statement = { bind: () => statement };
  const screeningStatement = {
    bind: () => screeningStatement,
    // Explicit legacy absence in this dependency-only UNIT row double.
    all: async () => ({ success: true, results: [] }),
  };
  const db = {
    prepare: (query: string) =>
      query.replace(/\s+/g, " ").trim() ===
      "SELECT e.seq, s.provenance_json FROM events e JOIN screening_publications s ON s.event_id = e.id WHERE e.problem_id = ? AND e.seq IN (SELECT value FROM json_each(?))"
        ? screeningStatement
        : statement,
    batch: async () => {
      const payload_json = JSON.stringify(parentPayload);
      const payload_sha256 = await sha256Hex(payload_json);
      const attribution = {
        problem_id: "P-UNIT",
        fellow: "F-author",
        sponsor: "S-author",
        session: "S-unit",
        model_self_declared: "declared-model",
        harness_self_declared: "declared-harness",
      };
      const premise = dependency.body === null ? null : JSON.parse(dependency.body);
      return [
        {
          results: [
            {
              id: "C-2@1",
              payload_json,
              payload_sha256,
              body: JSON.stringify({ sponsor: "S-author", seq: 2 }),
            },
          ],
        },
        { results: [] },
        { results: [] },
        {
          results: [
            {
              ...attribution,
              event_id: "E-dependent",
              claim_id: "C-2",
              version: 1,
              type: "claim.created",
              seq: 2,
              ordinal: 1,
              content_digest: `sha256:${await sha256Hex(String(parentPayload.statement))}`,
              payload_json,
              payload_sha256,
            },
            {
              ...attribution,
              event_id: premise?.event ?? pin.event_id,
              claim_id: "C-1",
              version: premise?.version ?? 1,
              type: "claim.created",
              seq: 1,
              ordinal: 2,
              content_digest: premise?.content_digest ?? null,
              payload_json: premise === null ? null : dependency.payload_json,
              payload_sha256: dependency.payload_sha256,
            },
          ],
        },
        // This row double tests dependency identity only. No supplied scientific
        // rows means the assessment explicitly stays unavailable, never strong.
        { results: [] },
        // The canonical proof-obligation reader shares this snapshot. This
        // dependency-only fixture has a readable scope and no gap filings.
        { results: [{ id: "P-UNIT", status: "active", public_seq: 2, unlisted: 0 }] },
        { results: [] },
      ];
    },
  } as unknown as Env["DB"];
  const read = () => readTargetClaimPack(db, "P-UNIT", 2, "C-2@1");
  expect((await read()).candidates.some((item) => item.kind === "claim-dependency")).toBe(true);
  for (const change of [
    { payload_json: JSON.stringify({ ...dependencyPayload, statement: "CORRUPT_PREMISE_CANARY" }) },
    {
      payload_json: JSON.stringify({ ...dependencyPayload, claim_id: "C-9" }),
      payload_sha256: await sha256Hex(JSON.stringify({ ...dependencyPayload, claim_id: "C-9" })),
    },
    { body: null },
    {
      body: JSON.stringify({ version: 2, event: pin.event_id, content_digest: pin.content_digest }),
    },
    { body: JSON.stringify({ version: 1, event: "E-wrong", content_digest: pin.content_digest }) },
    {
      body: JSON.stringify({
        version: 1,
        event: pin.event_id,
        content_digest: `sha256:${"b".repeat(64)}`,
      }),
    },
  ]) {
    dependency = { ...originalDependency, ...change };
    const section = await read();
    expect(section.candidates.some((item) => item.kind === "claim-dependency")).toBe(false);
    expect(section.omitted).toContainEqual({
      reason: "dependency_history_unavailable",
      detail: "C-2@1: incomplete transitive dependency history or traversal/byte bounds",
    });
    expect(JSON.stringify(section)).not.toContain("CORRUPT_PREMISE_CANARY");
  }
  dependency = { ...originalDependency };
  for (const dependency_pins of [undefined, null, ["C-1"], [{ claim_id: "C-1" }], [pin, pin]]) {
    parentPayload = { ...parentPayload, dependency_pins };
    const section = await read();
    expect(section.candidates.some((item) => item.kind === "claim-dependency")).toBe(false);
    expect(section.omitted).toContainEqual({
      reason: "dependency_history_unavailable",
      detail: "C-2@1",
    });
  }
});

test("citation route verifies payload bytes and pins before exposing export content (unit row double)", async () => {
  const payload = { claim_id: "C-1", kind: "claim", statement: "Two is a positive even integer." };
  const original = JSON.stringify(payload);
  const row = {
    type: "claim.created",
    version: 1,
    fellow_id: "F-UNIT-CITATION",
    published_at: "2026-01-01T00:00:00.000Z",
    payload_json: original,
    payload_sha256: await sha256Hex(original),
  };
  const statement = { bind: () => statement, first: async () => row };
  const env = { DB: { prepare: () => statement } } as unknown as Env;
  const app = createLedgerFaceRoutes();
  const url = "https://a.asimposium.org/p/P-UNIT/claims/C-1@1.csl.json";
  const get = () =>
    app.request(
      url,
      {
        headers: {
          "user-agent":
            "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)",
        },
      },
      env,
    );
  const valid = await get();
  expect(valid.status).toBe(200);
  expect(ClaimCitationCslSchema.parse(await valid.json()).title).toBe(payload.statement);
  // A matching stored digest column alone does not prove the content bytes.
  row.payload_json = JSON.stringify({ ...payload, statement: "CORRUPT_CITATION_BODY_CANARY" });
  const mismatch = await get();
  expect(mismatch.status).toBe(404);
  expect(await mismatch.text()).not.toContain("CORRUPT_CITATION_BODY_CANARY");
  for (const invalid of [
    { ...payload, claim_id: "C-2" },
    { ...payload, statement: undefined },
    null,
  ]) {
    row.payload_json = JSON.stringify(invalid);
    row.payload_sha256 = await sha256Hex(row.payload_json);
    const response = await get();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(payload.statement);
  }
});

test("a complete short claim face admits every bounded dependency, evidence, review and proof gap", () => {
  const claim = base.items.find((item) => item.kind === "claim-detail");
  if (claim === undefined) throw new Error("Claim fixture is missing its statement");
  const items = [
    claim,
    ...(["claim-dependency", "claim-evidence", "claim-review"] as const).flatMap((kind, group) =>
      Array.from({ length: 20 }, (_, index) => ({
        ...claim,
        kind,
        id: kind === "claim-dependency" ? `C-${index + 2}@1` : `I-${group}-${index}`,
        body: "Published record.",
      })),
    ),
    ...Array.from({ length: 8 }, (_, index) => ({
      ...claim,
      kind: "claim-proof-gap",
      id: `G-${index + 1}`,
      body: "Open obligation.",
    })),
  ];
  const faces = renderBudgetedClaimFace({
    ...base,
    items,
    omitted: [{ reason: "claim_face_scope" }],
  });
  const json = ClaimFaceResponseSchema.parse(JSON.parse(faces.json.body));
  expect(json.items).toHaveLength(69);
  expect(json.items.map((item) => item.id)).toEqual(items.map((item) => item.id));
  for (const face of Object.values(faces)) {
    expect(face.bytes).toBeLessThanOrEqual(64_000);
    expect(face.body).toContain("G-8");
    expect(face.body).toContain("I-2-19");
  }
  expect(
    ClaimFaceResponseSchema.safeParse({
      ...json,
      items: [...json.items, { ...claim, kind: "claim-proof-gap", id: "G-9" }],
    }).success,
  ).toBe(false);
});

test("public claim byte budgets retain whole stable records across Unicode and HTML expansion", () => {
  const claim = base.items[0];
  if (claim === undefined) throw new Error("Claim fixture is missing its statement");
  for (const body of ["漢".repeat(17_000), "&".repeat(17_000), "normal proof text ".repeat(900)]) {
    const projection: Projection = {
      ...base,
      omitted: [{ reason: "claim_face_scope", detail: "Version history omitted." }],
      items: [
        claim,
        ...Array.from({ length: 8 }, (_, index) => ({
          kind: "claim-evidence",
          id: `E-${index + 1}`,
          scope: "ledger" as const,
          untrusted: true,
          body,
          why_included: "exact claim version evidence",
        })),
      ],
    };
    const faces = renderBudgetedClaimFace(projection);
    const json = ClaimFaceResponseSchema.parse(JSON.parse(faces.json.body));
    expect(json.claim_state).toEqual(base.claim_state);
    expect(json.items[0]?.id).toBe("C-1@1");
    expect(json.items.length).toBeLessThan(projection.items.length);
    expect(json.omitted.some((entry) => entry.reason === "budget_exceeded")).toBe(true);
    expect(json.items.map((item) => item.id)).toEqual(
      projection.items.slice(0, json.items.length).map((item) => item.id),
    );
    for (const item of json.items.slice(1)) expect(item.body).toBe(body);
    for (const face of Object.values(faces)) expect(face.bytes).toBeLessThanOrEqual(64_000);
  }
});

test("conflicts Diptych routes serve json, md, and html faces with honest omission metadata", async () => {
  const problemRow = { id: "P-CONFLICTS", unlisted: 0, public_seq: 10, status: "open" };
  const payloadJson = JSON.stringify({
    conflict_id: "CF-1",
    problem_id: "P-CONFLICTS",
    claims: [
      { claim_id: "C-1", version: 1 },
      { claim_id: "C-2", version: 1 },
    ],
    aligned_definitions: "Definitions aligned on prime gap metrics.",
    aligned_scope: "Integers strictly greater than 2.",
    aligned_quantifiers: "For all n > 1000.",
    smallest_disagreement: "O(log^2 p) vs Omega(log^3 p).",
    agreed_facts: ["Prime number theorem holds."],
    discriminating_tests: ["Direct sieve verification up to 10^12."],
    status: "open",
    author_fellow_id: "F-UNIT-CONFLICT",
  });
  const digest = await sha256Hex(payloadJson);
  const conflictRows = [
    {
      conflict_id: "CF-1",
      problem_id: "P-CONFLICTS",
      seq: 1,
      publications: 1,
      event_id: "E-conflict-unit",
      object_version: 1,
      actor_fellow_id: "F-UNIT-CONFLICT",
      created_at: "2026-01-01T00:00:00.000Z",
      actor_sponsor_id: "S-author",
      actor_session_id: "SES-unit",
      model_string_self_declared: "model-unit",
      harness: "harness-unit",
      payload_sha256: digest,
      payload_json: payloadJson,
      last_event_id: "E-conflict-unit",
      last_seq: 1,
      last_type: "conflict.normalized",
      last_object_version: 1,
      lifecycle_events: 1,
      last_created_at: "2026-01-01T00:00:00.000Z",
      last_payload_sha256: digest,
      last_payload_json: null,
      content_limited: 0,
    },
  ];

  const db = {
    prepare: () => ({ bind: (...args: unknown[]) => ({ args }) }),
    batch: async (statements: Array<{ args: unknown[] }>) =>
      statements.map((statement, index) => ({
        success: true,
        results:
          statement.args[0] !== "P-CONFLICTS" ? [] : index === 0 ? [problemRow] : conflictRows,
      })),
  } as unknown as Env["DB"];

  const env = { DB: db } as unknown as Env;
  const app = createLedgerFaceRoutes();

  // JSON face
  const jsonRes = await app.request(
    "https://a.asimposium.org/p/P-CONFLICTS/conflicts.json",
    {},
    env,
  );
  expect(jsonRes.status).toBe(200);
  expect(jsonRes.headers.get("content-type")).toBe("application/json; charset=utf-8");
  const jsonBody = ConflictsListResponseSchema.parse(await jsonRes.json());
  expect(jsonBody.conflicts).toHaveLength(1);
  expect(jsonBody.conflicts[0]?.conflict_id).toBe("CF-1");

  // Markdown face
  const mdRes = await app.request("https://a.asimposium.org/p/P-CONFLICTS/conflicts.md", {}, env);
  expect(mdRes.status).toBe(200);
  expect(mdRes.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  const mdText = await mdRes.text();
  expect(mdText).toContain("## Conflict `CF-1`");
  expect(mdText).toContain("`C-1@1` vs `C-2@1`");

  // HTML face
  const htmlRes = await app.request(
    "https://a.asimposium.org/p/P-CONFLICTS/conflicts.html",
    {},
    env,
  );
  expect(htmlRes.status).toBe(200);
  expect(htmlRes.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const htmlText = await htmlRes.text();
  expect(htmlText).toContain("CF-1");
  expect(htmlText).toContain("C-1@1");

  // 404 for non-existent problem
  const notFoundRes = await app.request(
    "https://a.asimposium.org/p/P-MISSING/conflicts.json",
    {},
    env,
  );
  expect(notFoundRes.status).toBe(404);

  // 304 for ETag match
  const etag = jsonRes.headers.get("etag");
  expect(etag).toBeTruthy();
  const cachedRes = await app.request(
    "https://a.asimposium.org/p/P-CONFLICTS/conflicts.json",
    { headers: { "if-none-match": etag ?? "" } },
    env,
  );
  expect(cachedRes.status).toBe(304);
});
