import { expect, test } from "bun:test";
import {
  generateMoveTemplatesDocument,
  type MoveKind,
  PublicMovesResponseSchema,
} from "@asimposium/contracts";
import { listPublicSchemas } from "@asimposium/contracts/public-schemas";
import Ajv2020 from "ajv/dist/2020.js";
import { ProblemLifecycleContractsSchema } from "../../../../packages/contracts/src/problems.ts";
import { SessionsContractsSchema } from "../../../../packages/contracts/src/sessions.ts";
import { createApp } from "../../src/app";
import { generateOpenApiDocument, normalizeOpenApiPath } from "../../src/discovery/discovery";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service";
import { createSessionRouter } from "../../src/sessions/router";

const origin = "https://a.asimposium.org";
const userAgent = "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)";
const evidence = {
  bears_on_id: "C-1",
  bears_on_version: 1,
  direction: "refutes",
  kind: "construction",
  source: { kind: "locator", locator: "https://example.org/counterexample" },
  mode: "confirmatory",
  body_md: "A concrete counterexample at the boundary.",
};
const bodies: Partial<Record<MoveKind, Record<string, unknown>>> = {
  "sharpen-statement": {
    session_id: "S-abcdefghijklmnopqrstuvwxyz",
    statement_version: 1,
    verdict: "statement-clear",
    basis: "The recorded scope, quantifiers and falsifier describe one testable formulation.",
  },
  "state-claim": {
    workshop_id: "W-abcdefghijklmnopqrstuvwxyz",
    statement: "Every even integer is divisible by two.",
    falsifier: "An even integer with a nonzero remainder modulo two.",
  },
  "add-refuter": evidence,
  review: {
    target_claim_id: "C-1",
    target_version: 1,
    verdict: "inform",
    basis: "Checked the boundary case.",
    capable_of_failure: "An input that violates the invariant.",
    rubric: ["Boundary cases"],
    body_md: "The boundary agrees with the proposed statement.",
  },
  "third-alternative": {
    route: "Test a third boundary mechanism.",
    mechanism: "Vary the parity independently.",
    falsifier: "Parity has no effect on the outcome.",
    body_md: "This distinguishes the two earlier routes.",
  },
  discriminate: {
    title: "Compare the parity predictions",
    body_md:
      "Draft an experiment that distinguishes the proposed routes without claiming an observation.",
  },
  "kill-or-stand": {
    hypothesis_id: "H-1",
    killed_by_evidence_id: "E-1",
    reason: "The recorded counterexample fires the falsifier.",
  },
  "collapse-duplicate": { source_claim_id: "C-1", source_version: 1, target: "C-2@1" },
  "re-anchor": { claim_id: "C-1", base_version: 1 },
  "record-dead-end": {
    approach: "Enumerate integers from one to ten to find a missing parity class.",
    what_was_examined: "Every integer from one to ten was classified by its remainder modulo two.",
    why_it_fails: "This finite enumeration introduces no class beyond the two known remainders.",
    retry_predicate: "Retry only if a distinct, precisely defined parity classification is proposed.",
  },
  "retry-dead-end": { supersedes_dead_end_id: "DE-1" },
  "normalize-conflict": {
    claims: [
      { claim_id: "C-1", version: 1 },
      { claim_id: "C-2", version: 1 },
    ],
    aligned_definitions: "Both statements use the same integer remainder definition.",
    aligned_scope: "The scope is the finite integer range from one to ten.",
    aligned_quantifiers: "The universal quantifier applies to each member of that range.",
    smallest_disagreement: "The two claims assign different remainders to the integer six.",
    agreed_facts: ["Both use four as the divisor."],
    discriminating_tests: ["Compute the remainder of six modulo four."],
  },
  formalize: {
    bears_on_id: "C-1",
    bears_on_version: 1,
    direction: "informs",
    source: { kind: "model_memory" },
    mode: "exploratory",
    formal_artifact: {
      language: "lean",
      declaration: "even_zero",
      source: "theorem even_zero : 0 = 0 := rfl",
      toolchain: "Lean 4",
      axiom_report: "No axioms.",
    },
    body_md: "Formal work product; independent compilation remains necessary.",
  },
  "add-refuter-from-friction": evidence,
  "close-gap": { gap_id: "G-1", closed_by: "C-2@1" },
  "idle-close": { handback: "C-1 needs an independent check of its boundary case." },
  synthesize: {},
};

test("available move guidance agrees with mounted POSTs, published schemas and actual validators", () => {
  const replayProtector = new AesGcmEnrollmentReplayProtector(new Uint8Array(32));
  const service = new EnrollmentService({
    stoaOrigin: origin,
    agoraOrigin: "https://asimposium.org",
    store: new InMemoryEnrollmentStore(),
    replayProtector,
  });
  const mounted = new Set(
    createSessionRouter({ service, replayProtector }).routes.map(
      (route) => `${route.method} ${normalizeOpenApiPath(route.path)}`,
    ),
  );
  // A template names its problem slot explicitly; Hono names that same path
  // position :id. Only placeholder names vary. Every literal and method must
  // agree with exactly one actual registered route and its OpenAPI operation.
  const routeShape = (route: string) => route.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, "{}");
  const openapi = JSON.parse(generateOpenApiDocument());
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const families = { sessions: SessionsContractsSchema, problems: ProblemLifecycleContractsSchema };
  const served = listPublicSchemas();
  let count = 0;
  for (const template of Object.values(generateMoveTemplatesDocument().moves)) {
    if (template.availability !== "available") continue;
    count++;
    const routes = [...mounted].filter(
      (route) =>
        routeShape(route) === routeShape(`${template.request.method} ${template.request.path}`),
    );
    expect(routes, template.move).toHaveLength(1);
    const registeredPath = routes[0]?.slice(template.request.method.length + 1);
    if (!registeredPath) throw new Error(`Missing registered move route: ${template.move}`);
    const operation = openapi.paths[registeredPath]?.post;
    expect(operation?.security, template.move).toEqual([{ bearerAuth: [] }]);
    // The move links a served slice; OpenAPI references the same property by
    // fragment. Both must name the same request shape.
    const slice = /^\/schemas\/(sessions|problems)\.v1\/([a-z_]+)\.json$/.exec(
      template.target_contract,
    );
    expect(slice, template.move).not.toBeNull();
    if (!slice || !slice[1] || !slice[2])
      throw new Error(`Unknown move contract: ${template.move}`);
    const family = slice[1] as keyof typeof families;
    const property = slice[2];
    const definition = Object.entries(families[family].shape).find(([key]) => key === property);
    const schema = served.find((row) => row.id === family);
    if (!definition || !schema)
      throw new Error(`Missing canonical move contract: ${template.move}`);
    const contract = definition[1];
    const document = JSON.parse(schema.body);
    expect(operation?.requestBody.content["application/json"].schema.$ref, template.move).toBe(
      `${origin}/schemas/${family}.v1.json#/properties/${property}`,
    );
    const body = { ...bodies[template.move], ...template.prefilled_hints };
    expect(contract.safeParse(body).success, template.move).toBe(true);
    const validate = ajv.compile(document.properties[property]);
    expect(validate(body), `${template.move}: ${JSON.stringify(validate.errors)}`).toBe(true);
    for (const field of template.required_fields)
      expect(Object.hasOwn(body, field), `${template.move}.${field}`).toBe(true);
    for (const field of Object.keys(body)) {
      const { [field]: _removed, ...missing } = body;
      if (!contract.safeParse(missing).success)
        expect(template.required_fields, template.move).toContain(field);
    }
  }
  expect(count).toBe(17);
  expect(Object.keys(bodies)).toHaveLength(count);
});

test("the formerly served close and third-alternative fields are invalid requests", () => {
  expect(
    SessionsContractsSchema.shape.session_close_request.safeParse({
      session_id: "S-abcdefghijklmnopqrstuvwxyz",
      handback_summary: "Check C-1.",
    }).success,
  ).toBe(false);
  expect(
    SessionsContractsSchema.shape.hypothesis_request.safeParse({
      statement: "Try the boundary.",
      falsifier: "A failing boundary.",
      origin: "third-alternative",
    }).success,
  ).toBe(false);
});

test("public move aliases retain the strict catalog and disclose unavailable live discovery", async () => {
  const app = createApp();
  const expectedCatalog = generateMoveTemplatesDocument();
  let expectedBody: string | undefined;
  for (const path of ["/moves", "/moves.json"]) {
    const response = await app.request(origin + path, { headers: { "User-Agent": userAgent } });
    expect(response.status).toBe(200);
    const body = await response.text();
    const { discovery, ...catalog } = PublicMovesResponseSchema.parse(JSON.parse(body));
    expect(catalog).toEqual(expectedCatalog);
    expect(discovery).toMatchObject({
      scope: "public-needs",
      problems: [],
      scanned: 0,
      next_after: null,
      degraded: true,
    });
    expect(discovery.omitted.some((item) => item.reason === "selector_unavailable")).toBe(true);
    expectedBody ??= body;
    expect(body).toBe(expectedBody);
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    const unchanged = await app.request(origin + path, {
      headers: { "User-Agent": userAgent, "If-None-Match": etag ?? "" },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
  }
});
