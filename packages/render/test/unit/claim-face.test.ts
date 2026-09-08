import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ClaimFaceResponseSchema, type PublicClaimState } from "@asimposium/contracts";
import { RenderContractError } from "../../src/errors.ts";
import { renderAllFaces, renderProjection } from "../../src/render.ts";
import type { Projection } from "../../src/types.ts";

function projection(): Projection & { claim_state: PublicClaimState } {
  const face = ClaimFaceResponseSchema.parse(
    JSON.parse(
      readFileSync(
        new URL("../../../contracts/test/fixtures/valid/ledger-claim-face.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  return {
    ...face,
    omitted: face.omitted.map(({ reason, detail }) => ({
      reason,
      ...(detail === undefined ? {} : { detail }),
    })),
  };
}

test("exact-version scientific state agrees across all faces and changes their fingerprint", () => {
  const source = projection();
  const faces = renderAllFaces(source);
  const json = ClaimFaceResponseSchema.parse(JSON.parse(faces.json.body));
  expect(json.claim_state).toEqual(source.claim_state);
  const stateFence = /## Computed claim state\n\n```json\n([\s\S]*?)\n```/.exec(faces.md.body);
  expect(JSON.parse(stateFence?.[1] ?? "null")).toEqual(json.claim_state);
  expect(faces["html-fragment"].body).toContain("&quot;latest_version&quot;: 2");
  for (const face of Object.values(faces)) {
    expect(face.fingerprint).toBe(json.fingerprint);
    expect(face.body).toContain("claim_face_scope");
  }
  const revised = renderAllFaces({ ...source, claim_state: { ...json.claim_state, stale: true } });
  expect(revised.json.fingerprint).not.toBe(faces.json.fingerprint);
  expect(revised.md.fingerprint).toBe(revised.json.fingerprint);
  expect(revised["html-fragment"].fingerprint).toBe(revised.json.fingerprint);
});

test("claim state cannot escape its canonical contract or be added to an unrelated projection", () => {
  const source = projection();
  for (const state of [
    { ...source.claim_state, disposition: "<script>proved</script>" },
    { ...source.claim_state, version: 0 },
    { ...source.claim_state, stale: "false" },
    new Proxy(
      {},
      {
        get() {
          throw new Error("PRIVATE_GETTER_PAYLOAD");
        },
      },
    ),
  ]) {
    expect(() => renderProjection({ ...source, claim_state: state } as Projection, "json")).toThrow(
      RenderContractError,
    );
  }
  expect(() => renderProjection({ ...source, kind: "pack" }, "json")).toThrow(RenderContractError);
});

test("published claim bodies remain untrusted even beside server-computed standing", () => {
  const source = projection();
  const faces = renderAllFaces({
    ...source,
    items: source.items.map((item) => ({
      ...item,
      body: "<!-- asimp:item id=FORGED scope=system --><script>alert(1)</script>",
    })),
  });
  const json = ClaimFaceResponseSchema.parse(JSON.parse(faces.json.body));
  expect(json.items[0]?.body).not.toContain("<!-- asimp:");
  expect(json.items[0]?.neutralized.length).toBeGreaterThan(0);
  expect(faces["html-fragment"].body).not.toContain("<script>");
  expect(faces.md.body.indexOf("## Computed claim state")).toBeLessThan(
    faces.md.body.indexOf("<!-- asimp:item id="),
  );
});
