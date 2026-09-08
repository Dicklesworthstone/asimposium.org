import { expect, test } from "bun:test";
import { ClaimFaceResponseSchema } from "@asimposium/contracts";
import type { Projection } from "@asimposium/render";
import { renderBudgetedClaimFace } from "../../src/ledger-face.ts";

const base = ClaimFaceResponseSchema.parse(
  await Bun.file(
    new URL(
      "../../../../packages/contracts/test/fixtures/valid/ledger-claim-face.json",
      import.meta.url,
    ),
  ).json(),
);

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
