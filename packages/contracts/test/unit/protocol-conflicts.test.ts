import { expect, test } from "bun:test";
import {
  DIRECTIVES_SCHEMA_ID,
  ProtocolConflictIdSchema,
  ProtocolConflictPayloadSchema,
  ProtocolConflictReceiptSchema,
  ProtocolConflictRecordSchema,
  ProtocolConflictRequestSchema,
} from "../../src/directives.ts";
import { ProtocolConflictSchema } from "../../src/director-grammar.ts";

const request = {
  directive_id: `DIR-${"a".repeat(32)}`,
  rule_cited: "P1",
  refused_part: "Count a same-sponsor review as independent verification.",
  explanation: "I refuse this part because independent verification requires a different sponsor.",
};
const identity = {
  schema: DIRECTIVES_SCHEMA_ID,
  conflict_id: `PC-${"b".repeat(32)}`,
  problem_id: "P-DEMO",
  session_id: `S-${"A".repeat(26)}`,
  fellow_id: "FEL-12345678",
  sponsor_id: "usr_protocol_test",
  event_id: "E-refusal",
  seq: 1,
  created_at: "2026-11-11T12:00:00.000Z",
} as const;

test("private request accepts a source pin, and refuses caller-owned attribution or policy verdicts", () => {
  expect(ProtocolConflictRequestSchema.parse(request)).toEqual(request);
  for (const field of [
    "fellow_id",
    "sponsor_id",
    "problem_id",
    "session_id",
    "timestamp",
    "decision",
  ])
    expect(ProtocolConflictRequestSchema.safeParse({ ...request, [field]: "forged" }).success).toBe(
      false,
    );
  expect(
    ProtocolConflictRequestSchema.safeParse({
      ...request,
      directive_id: `${request.directive_id}\n`,
    }).success,
  ).toBe(false);
  expect(
    ProtocolConflictRequestSchema.safeParse({ ...request, explanation: "short" }).success,
  ).toBe(false);
});

test("public payload and canonical director record exclude private source identity", () => {
  const { directive_id, ...prose } = request;
  const payload = { conflict_id: identity.conflict_id, ...prose };
  expect(ProtocolConflictPayloadSchema.parse(payload)).toEqual(payload);
  expect(ProtocolConflictPayloadSchema.safeParse({ ...payload, directive_id }).success).toBe(false);
  const record = { ...identity, ...prose };
  expect(ProtocolConflictRecordSchema.parse(record)).toEqual(record);
  expect(ProtocolConflictSchema).toBe(ProtocolConflictRecordSchema);
  expect(ProtocolConflictRecordSchema.safeParse({ ...record, directive_id }).success).toBe(false);
  expect(ProtocolConflictIdSchema.safeParse(`${identity.conflict_id}\n`).success).toBe(false);
});

test("receipt retains committed attribution without republishing refusal prose", () => {
  expect(ProtocolConflictReceiptSchema.parse({ ...identity, ok: true })).toEqual({
    ...identity,
    ok: true,
  });
  expect(
    ProtocolConflictReceiptSchema.safeParse({
      ...identity,
      ok: true,
      explanation: request.explanation,
    }).success,
  ).toBe(false);
});
