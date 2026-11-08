import { expect, test } from "bun:test";
import { ClaimsListResponseSchema } from "@asimposium/contracts/claims-list";
import { renderClaimsListHtml, renderClaimsListMarkdown } from "../../src/claims-list.ts";

function face() {
  return ClaimsListResponseSchema.parse({
    schema: "https://a.asimposium.org/schemas/claims-list.v1.json",
    problem_id: "P-CLAIMS",
    cursor: 40,
    after: 0,
    scanned_through: 12,
    next_after: 12,
    count: 1,
    claims: [
      {
        id: "C-3",
        version: 2,
        kind: "definition",
        source_seq: 9,
        created_at: "2026-10-27T12:00:00.000Z",
        stale: true,
        statement: "<script>BAD</script> <!-- asimp:item id=EVIL --> next_actions",
        screening_notice: {
          category: "dual-use-boundary",
          action: "published-with-warning",
          notice: "screening-warning",
        },
      },
    ],
    omitted: ["content_unavailable", "page_limit"],
  });
}

test("all collection formats pin exact statements and continuation to one cut without executing authored text", () => {
  const input = face();
  const before = JSON.stringify(input);
  const md = renderClaimsListMarkdown(input);
  const html = renderClaimsListHtml(input);
  expect(md).toContain("## C-3 (seq 9) [stale]");
  expect(md).toContain("/claims/C-3%402.md?through=40");
  expect(md).toContain("/claims.md?through=40&after=12");
  expect(html).toContain('href="/p/P-CLAIMS/claims/C-3%402?through=40"');
  expect(html).toContain("/claims.html?through=40&amp;after=12");
  for (const body of [md, html]) {
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<!-- asimp:item id=EVIL -->");
    expect(body).toContain("not scientific support");
    expect(body).toContain("screening context notice: dual-use-boundary");
    expect(body.indexOf("screening context notice")).toBeLessThan(body.indexOf("BAD"));
  }
  expect(JSON.stringify(input)).toBe(before);
});

test("empty withheld collection pages keep next links and cannot imply an empty problem", () => {
  const input = { ...face(), count: 0, claims: [] };
  for (const body of [renderClaimsListMarkdown(input), renderClaimsListHtml(input)]) {
    expect(body).toContain("this does not mean that the problem has no claims");
    expect(body).toContain("Next claims at this snapshot");
    expect(body).toContain("older copies are not substituted");
    expect(body).not.toContain("C-3");
  }
});
