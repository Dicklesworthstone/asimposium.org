import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DIRECTIVE_DISCLOSURES_SCHEMA_ID,
  DirectiveDisclosurePublicationSchema,
  generateDirectiveDisclosuresSchema,
  SponsorDirectiveDisclosureReceiptSchema,
  SponsorDirectiveDisclosureRequestSchema,
  SponsorDirectiveDisclosureStateSchema,
} from "../../src/directive-disclosures.ts";

const request = JSON.parse(
  readFileSync(new URL("../fixtures/valid/directive-disclosure.json", import.meta.url), "utf8"),
);
const target = {
  problem_id: "P-DISCLOSE",
  claim_id: "C-1",
  version: 1,
  content_digest: `sha256:${"c".repeat(64)}`,
  publication_event_id: "E-claim-one",
  publication_seq: 1,
  statement_version: 1,
};
const publication = {
  kind: "directive-disclosure",
  target,
  scope_id: request.scope_id,
  coverage_digest: "d".repeat(64),
  revision: 1,
  decision: "disclose",
  sponsor_id: "usr_disclosure",
  fellow_id: "fellow-disclosure",
  disclosures: request.disclosures,
  recorded_at: "2026-10-26T12:00:00.000Z",
};
const { kind: _kind, ...publicFields } = publication;
const receipt = {
  schema: DIRECTIVE_DISCLOSURES_SCHEMA_ID,
  event_id: `DD-${"e".repeat(32)}`,
  seq: 2,
  ...publicFields,
};

describe("exact-result directive disclosure contracts", () => {
  test("typed initial instructions and later directives share one bounded safe-summary contract", () => {
    expect(SponsorDirectiveDisclosureRequestSchema.safeParse(request).success).toBe(true);
    expect(DirectiveDisclosurePublicationSchema.safeParse(publication).success).toBe(true);
    expect(SponsorDirectiveDisclosureReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(JSON.parse(generateDirectiveDisclosuresSchema()).$id).toBe(
      DIRECTIVE_DISCLOSURES_SCHEMA_ID,
    );
  });

  test("the caller cannot assert authority or manufacture a prior-sponsor clearance", () => {
    const forged = JSON.parse(
      readFileSync(
        new URL("../fixtures/invalid/directive-disclosure-forged-authority.json", import.meta.url),
        "utf8",
      ),
    );
    expect(SponsorDirectiveDisclosureRequestSchema.safeParse(forged).success).toBe(false);
    for (const field of ["sponsor_id", "fellow_id", "target", "coverage_digest"])
      expect(
        SponsorDirectiveDisclosureRequestSchema.safeParse({ ...request, [field]: "forged" })
          .success,
      ).toBe(false);
  });

  test("decision semantics, source identity and duplicate bounds apply to all public records", () => {
    for (const [schema, base] of [
      [SponsorDirectiveDisclosureRequestSchema, request],
      [DirectiveDisclosurePublicationSchema, publication],
      [SponsorDirectiveDisclosureReceiptSchema, receipt],
    ] as const) {
      expect(schema.safeParse({ ...base, decision: "disclose", disclosures: [] }).success).toBe(
        false,
      );
      expect(schema.safeParse({ ...base, decision: "withdraw" }).success).toBe(false);
      expect(
        schema.safeParse({ ...base, disclosures: [request.disclosures[0], request.disclosures[0]] })
          .success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...base,
          disclosures: [{ ...request.disclosures[0], source_kind: "directive" }],
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...base,
          disclosures: [{ ...request.disclosures[0], summary: "x".repeat(501) }],
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...base, decision: "no-undisclosed", disclosures: [] }).success,
      ).toBe(true);
    }
  });

  test("a private read cannot contain another sponsor's instruction body", () => {
    const scope = {
      scope_id: request.scope_id,
      sponsor_id: publication.sponsor_id,
      fellow_id: publication.fellow_id,
      can_attest: true,
      status: "complete",
      revision: 1,
      receipt,
      directives: [
        {
          directive_id: request.disclosures[0].directive_id,
          source_kind: "enrollment-instruction",
          verb: "initial",
          text: "Private steering.",
          created_at: 1,
        },
      ],
    };
    const state = {
      schema: DIRECTIVE_DISCLOSURES_SCHEMA_ID,
      target,
      lineage_digest: "f".repeat(64),
      status: "complete",
      scopes: [scope],
    };
    expect(SponsorDirectiveDisclosureStateSchema.safeParse(state).success).toBe(true);
    const source = scope.directives[0];
    if (!source) throw new Error("The fixture requires one private instruction.");
    expect(
      SponsorDirectiveDisclosureStateSchema.safeParse({
        ...state,
        scopes: [{ ...scope, directives: [{ ...source, text: "x".repeat(2_000) }] }],
      }).success,
    ).toBe(true);
    expect(
      SponsorDirectiveDisclosureStateSchema.safeParse({
        ...state,
        scopes: [{ ...scope, directives: [{ ...source, text: "x".repeat(2_001) }] }],
      }).success,
    ).toBe(false);
    expect(
      SponsorDirectiveDisclosureStateSchema.safeParse({
        ...state,
        scopes: [
          {
            ...scope,
            directives: [
              {
                ...source,
                directive_id: `DIR-${"d".repeat(32)}`,
                source_kind: "directive",
                verb: "focus",
                text: "x".repeat(501),
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      SponsorDirectiveDisclosureStateSchema.safeParse({
        ...state,
        scopes: [{ ...scope, can_attest: false }],
      }).success,
    ).toBe(false);
    expect(
      SponsorDirectiveDisclosureStateSchema.safeParse({
        ...state,
        scopes: [{ ...scope, can_attest: false, directives: [] }],
      }).success,
    ).toBe(true);
    expect(
      SponsorDirectiveDisclosureStateSchema.safeParse({ ...state, scopes: [scope, scope] }).success,
    ).toBe(false);
  });
});
