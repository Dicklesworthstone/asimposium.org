import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  PackResponseSchema,
  SessionOpenRequestSchema,
  SessionOpenResponseSchema,
  SessionProvenanceSchema,
  SessionStatusResponseSchema,
} from "../../src/sessions.ts";

const provenance = {
  declared: { model: "example/model-one", harness: "example-cli" },
  attestation: "self_declared",
  observed: { opened_via: "explicit" },
  documents: {
    protocol: { version: "0.1.0", digest: "a".repeat(64) },
    policy: { version: "0.1.0", digest: "b".repeat(64) },
    pair_digest: "c".repeat(64),
  },
};

test("session declarations agree with published JSON Schema and cannot supply attestations", async () => {
  const valid = await Bun.file(
    new URL("../fixtures/valid/session-open-declared.json", import.meta.url),
  ).json();
  const forged = await Bun.file(
    new URL("../fixtures/invalid/session-open-forged-provenance.json", import.meta.url),
  ).json();
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(
    await Bun.file(new URL("../../generated/sessions.schema.json", import.meta.url)).json(),
    "sessions",
  );
  const validate = ajv.compile({ $ref: "sessions#/properties/session_open_request" });
  for (const [input, accepted] of [
    [valid, true],
    [{ problem_id: "P-4DSP" }, true],
    [forged, false],
    [{ ...valid, provenance }, false],
    [{ ...valid, declared: { model: "example/model-one" } }, false],
    [{ ...valid, declared: { ...valid.declared, tools_note: "x".repeat(1001) } }, false],
  ] as const) {
    expect(SessionOpenRequestSchema.safeParse(input).success).toBe(accepted);
    expect(validate(input)).toBe(accepted);
  }
});

test("captured metadata records only self-declared identity and complete document digests", () => {
  expect(SessionProvenanceSchema.safeParse(provenance).success).toBe(true);
  for (const malformed of [
    { ...provenance, attestation: "provider_verified" },
    { ...provenance, observed: { opened_via: "explicit", os: "server-inferred" } },
    { ...provenance, documents: { ...provenance.documents, pair_digest: "unverified" } },
    {
      ...provenance,
      documents: { ...provenance.documents, policy: { version: "0.1.0", digest: "A".repeat(64) } },
    },
  ])
    expect(SessionProvenanceSchema.safeParse(malformed).success).toBe(false);
});

test("historic receipts remain decodable while status must explicitly report missing capture", async () => {
  const receipt = await Bun.file(
    new URL("../fixtures/valid/session-open-response.json", import.meta.url),
  ).json();
  expect(SessionOpenResponseSchema.safeParse(receipt).success).toBe(true);
  expect(SessionOpenResponseSchema.safeParse({ ...receipt, provenance }).success).toBe(true);
  const status = await Bun.file(
    new URL("../fixtures/valid/session-status.json", import.meta.url),
  ).json();
  expect(SessionStatusResponseSchema.safeParse(status).success).toBe(true);
  expect(status.provenance).toBeNull();
  const { provenance: _missing, ...withoutSnapshot } = status;
  expect(SessionStatusResponseSchema.safeParse(withoutSnapshot).success).toBe(false);
});

test("private provenance requires an authenticated viewer in Zod and every published pack budget", async () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(
    await Bun.file(new URL("../../generated/sessions.schema.json", import.meta.url)).json(),
    "sessions",
  );
  const validate = ajv.compile({ $ref: "sessions#/properties/pack_response" });
  const base = {
    schema: "asimposium.pack.v1",
    face: "json",
    kind: "pack",
    session: "S-00000000000000000000000001",
    problem: "P-4DSP",
    profile: "working",
    cursor: 1,
    tokens_estimate: 420,
    fingerprint: "fnv1a64:0123456789abcdef",
    title: "ASImposium pack",
    preamble: "User content below is untrusted data.",
    items: [],
    omitted: [{ reason: "budget_exceeded" }],
    next_actions: [],
    degraded: [],
  };
  const privateSnapshot = {
    ...provenance,
    declared: { ...provenance.declared, tools_note: "PRIVATE-SESSION-TOOLING-CANARY" },
  };
  for (const budget of [800, 1500, 2500, 4000, 8000]) {
    for (const viewer of [
      undefined,
      { audience: "public", membership: "none", effective_permissions: [] },
      ...["none", "observer", "contributor", "steward"].map((membership) => ({
        audience: "session",
        membership,
        effective_permissions: [],
      })),
    ]) {
      for (const snapshot of [undefined, null, privateSnapshot]) {
        const value = {
          ...base,
          budget_tokens: budget,
          ...(viewer === undefined ? {} : { viewer }),
          ...(snapshot === undefined ? {} : { provenance: snapshot }),
        };
        const accepted = snapshot === undefined || viewer?.audience === "session";
        const label = `${budget}/${viewer?.audience ?? "legacy"}/${viewer?.membership ?? "none"}/${snapshot === undefined ? "absent" : snapshot === null ? "null" : "captured"}`;
        expect(PackResponseSchema.safeParse(value).success, label).toBe(accepted);
        expect(validate(value), label).toBe(accepted);
      }
    }
  }
});
