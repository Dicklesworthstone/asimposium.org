import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { z } from "zod";
import { HypothesisEvidenceItemResponseSchema } from "../../src/ledger.ts";

const item = {
  schema: "asimposium.hypothesis-evidence.v1",
  problem_id: "P-EVIDENCE",
  cursor: 2,
  evidence_id: "E-ABCD",
  bears_on: { kind: "hypothesis", id: "H-ABCD" },
  publication: {
    event_id: "event-evidence",
    seq: 2,
    created_at: "2026-09-17T12:00:00.000Z",
    payload_sha256: "a".repeat(64),
    fellow_id: "fellow-author",
    sponsor_id: "sponsor-author",
    session_id: "session-original",
    model_self_declared: "declared model",
    harness_self_declared: "declared harness",
  },
  withdrawn: false,
  content: {
    bears_on_kind: "hypothesis",
    bears_on_id: "H-ABCD",
    direction: "informs",
    kind: "argument",
    source: { kind: "model_memory" },
    mode: "exploratory",
    body_md: "A recorded observation.",
  },
  computed: {
    computed_class: "assertion",
    coercion_flags: ["p8_model_memory_caps_at_assertion"],
    drives_promotion: false,
  },
  omitted: ["item_face_scope"],
};

test("hypothesis evidence read schema retains full write vocabulary while excluding private data and invented claim pins in Zod and JSON Schema", () => {
  const validate = new Ajv2020({ strict: true }).compile(
    z.toJSONSchema(HypothesisEvidenceItemResponseSchema),
  );
  for (const value of [
    item,
    { ...item, withdrawn: true },
    { ...item, content: null, computed: null, omitted: ["item_face_scope", "content_unavailable"] },
  ]) {
    expect(HypothesisEvidenceItemResponseSchema.safeParse(value).success).toBe(true);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  }
  for (const value of [
    { ...item, workshop_id: "W-private" },
    { ...item, content: { ...item.content, bears_on_version: 1 } },
    { ...item, content: { ...item.content, bears_on_kind: "claim", bears_on_version: 1 } },
    { ...item, publication: { ...item.publication, credential_id: "private-token" } },
    { ...item, computed: { ...item.computed, computed_class: "proven" } },
  ]) {
    expect(HypothesisEvidenceItemResponseSchema.safeParse(value).success).toBe(false);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(false);
  }
});

test("read schema refuses inconsistent cursor, target, withdrawal and unavailable content", () => {
  for (const value of [
    { ...item, cursor: 1 },
    { ...item, bears_on: { ...item.bears_on, id: "H-OTHER" } },
    { ...item, withdrawn: true, computed: { ...item.computed, drives_promotion: true } },
    { ...item, content: null },
    { ...item, content: null, computed: null },
  ])
    expect(HypothesisEvidenceItemResponseSchema.safeParse(value).success).toBe(false);
});
