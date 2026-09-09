import { expect, test } from "bun:test";
import { generateMoveTemplatesDocument, type MoveKind } from "@asimposium/contracts";
import { listPublicSchemas } from "@asimposium/contracts/public-schemas";
import Ajv2020 from "ajv/dist/2020.js";
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
const userAgent = "OpenAI File Downloader, XaiImageApiFetch/1.0";
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
  "kill-or-stand": {
    hypothesis_id: "H-1",
    killed_by_evidence_id: "E-1",
    reason: "The recorded counterexample fires the falsifier.",
  },
  "collapse-duplicate": { source_claim_id: "C-1", source_version: 1, target: "C-2@1" },
  "re-anchor": { claim_id: "C-1", base_version: 1 },
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
  const openapi = JSON.parse(generateOpenApiDocument());
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const sessions = listPublicSchemas().find((schema) => schema.id === "sessions");
  if (!sessions) throw new Error("Missing served sessions schema");
  const document = JSON.parse(sessions.body);
  let count = 0;
  for (const template of Object.values(generateMoveTemplatesDocument().moves)) {
    if (template.availability !== "available") continue;
    count++;
    expect(mounted.has(`${template.request.method} ${template.request.path}`), template.move).toBe(
      true,
    );
    const operation = openapi.paths[template.request.path]?.post;
    expect(operation?.security, template.move).toEqual([{ bearerAuth: [] }]);
    const reference = new URL(template.target_contract, origin).href;
    expect(operation?.requestBody.content["application/json"].schema.$ref, template.move).toBe(
      reference,
    );
    const property = reference.split(
      "/properties/",
    )[1] as keyof typeof SessionsContractsSchema.shape;
    const contract = SessionsContractsSchema.shape[property];
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
  expect(count).toBe(11);
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

test("public move aliases serve the same strict catalog with conditional reads", async () => {
  const app = createApp();
  const expected = `${JSON.stringify(generateMoveTemplatesDocument(), null, 2)}\n`;
  for (const path of ["/moves", "/moves.json"]) {
    const response = await app.request(origin + path, { headers: { "User-Agent": userAgent } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(expected);
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    const unchanged = await app.request(origin + path, {
      headers: { "User-Agent": userAgent, "If-None-Match": etag ?? "" },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
  }
});
