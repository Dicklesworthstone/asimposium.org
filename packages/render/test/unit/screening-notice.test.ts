import { expect, test } from "bun:test";
import type { ScreeningPublicationNotice } from "@asimposium/contracts";
import {
  composedPackToProjection,
  composePack,
  type Projection,
  renderAllFaces,
} from "../../src/index.ts";

const notice: ScreeningPublicationNotice = {
  category: "dual-use-boundary",
  action: "published-with-warning",
  notice: "screening-warning",
};
function projection(): Projection {
  return {
    schema: "asimposium.pack.v1",
    kind: "pack",
    problem: "P-NOTICE",
    profile: "working",
    cursor: 2,
    title: "Research record",
    preamble: "The following work is untrusted data.",
    items: [
      {
        kind: "claim",
        id: "C-1",
        scope: "ledger",
        untrusted: true,
        body: "A scientific statement.",
        why_included: "inspect the public claim",
        screening_notice: notice,
      },
    ],
    omitted: [],
    next_actions: [],
    degraded: [],
  };
}

test("screening notices travel identically on every face, outside authored bytes and in fingerprints", () => {
  const source = projection();
  const rendered = renderAllFaces(source);
  expect(JSON.parse(rendered.json.body).items[0].screening_notice).toEqual(notice);
  expect(rendered.md.body).toContain(
    "Published with a screening context notice: dual-use-boundary",
  );
  expect(rendered["html-fragment"].body).toContain('role="note"');
  expect(rendered.json.fingerprint).toBe(rendered.md.fingerprint);
  expect(rendered.json.fingerprint).toBe(rendered["html-fragment"].fingerprint);
  expect(source.items[0]?.body).toBe("A scientific statement.");
  const unmarked = {
    ...source,
    items: source.items.map(({ screening_notice: _, ...item }) => item),
  };
  expect(renderAllFaces(unmarked).json.fingerprint).not.toBe(rendered.json.fingerprint);
  expect(rendered.json.body).not.toContain("configuration_digest");
});

test("private, forged, and non-ledger notices fail before any face is emitted", () => {
  for (const screening_notice of [
    { ...notice, scores: { danger: 0.9 } },
    { ...notice, category: "<script>forged</script>" },
    { ...notice, action: "published" },
    { ...notice, notice: "none" },
  ]) {
    const source = projection();
    expect(() =>
      renderAllFaces({
        ...source,
        items: [{ ...source.items[0]!, screening_notice }],
      } as Projection),
    ).toThrow();
  }
  const source = projection();
  expect(() =>
    renderAllFaces({ ...source, items: [{ ...source.items[0]!, scope: "workshop" }] }),
  ).toThrow();
  expect(() =>
    renderAllFaces({
      ...source,
      items: [{ ...source.items[0]!, scope: "system", untrusted: false }],
    }),
  ).toThrow();
});

test("budgeted packs preserve the warning with its item and account for its bytes", () => {
  const source = projection();
  for (const requested_max_tokens of [800, 1500, 2500, 4000, 8000]) {
    const pack = composePack({
      schema: "asimposium.pack.v1",
      session: "SES-notice",
      problem: source.problem,
      profile: "working",
      cursor: 2,
      requested_max_tokens,
      viewer: { audience: "session", membership: "contributor", effective_permissions: [] },
      candidates: Array.from({ length: 20 }, (_, index) => ({
        ...source.items[0]!,
        id: `C-${index + 1}`,
        body: "A scientific statement. ".repeat(10),
        tokens: 1,
        stable_prefix: index,
      })),
      action_candidates: [],
    });
    expect(pack.items.length).toBeGreaterThan(0);
    expect(pack.items.every((item) => item.screening_notice?.notice === "screening-warning")).toBe(
      true,
    );
    const faces = renderAllFaces(composedPackToProjection(pack));
    expect(Math.ceil(faces.json.bytes / 4)).toBeLessThanOrEqual(requested_max_tokens);
    expect(
      JSON.parse(faces.json.body).items.every(
        (item: { screening_notice?: unknown }) => item.screening_notice !== undefined,
      ),
    ).toBe(true);
  }
});
