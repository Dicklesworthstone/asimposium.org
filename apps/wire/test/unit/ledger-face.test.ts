import { expect, test } from "bun:test";
import { ClaimCitationCslSchema, ClaimFaceResponseSchema } from "@asimposium/contracts";
import type { Projection } from "@asimposium/render";
import type { Env } from "../../src/env.ts";
import { sha256Hex } from "../../src/krater/krater.ts";
import { createLedgerFaceRoutes, renderBudgetedClaimFace } from "../../src/ledger-face.ts";

const base = ClaimFaceResponseSchema.parse(
  await Bun.file(
    new URL(
      "../../../../packages/contracts/test/fixtures/valid/ledger-claim-face.json",
      import.meta.url,
    ),
  ).json(),
);

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
      { headers: { "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" } },
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
