import { expect, test } from "bun:test";
import {
  EvidenceListResponseSchema,
  ReviewListResponseSchema,
} from "@asimposium/contracts/research-lists";
import fixtures from "../../../contracts/test/fixtures/research-lists.json";
import {
  renderEvidenceListHtml,
  renderEvidenceListMarkdown,
  renderReviewListHtml,
  renderReviewListMarkdown,
} from "../../src/research-lists.ts";

const { evidence: evidenceFixture, reviews: reviewsFixture } = fixtures.valid;

test("evidence faces retain exact targets, all attribution and the captured continuation", () => {
  const face = EvidenceListResponseSchema.parse(evidenceFixture);
  const markdown = renderEvidenceListMarkdown(face);
  const html = renderEvidenceListHtml(face);
  for (const body of [markdown, html]) {
    for (const value of [
      "E-1",
      "E-2",
      "C-1@1",
      "H-1",
      "immutable hypothesis",
      "SP-ORIGINAL",
      "F-AUTHOR",
      "S-PUBLISHED",
      "model declared by Fellow",
      "harness declared by Fellow",
      "self-declared",
      "Not recorded",
      "Withdrawn",
      "Authored direction",
      "supports",
      "refutes",
      "exploratory",
      "confirmatory",
    ])
      expect(body).toContain(value);
    expect(body).toContain("a".repeat(64));
    expect(body).toContain("/p/P-RESEARCH/evidence/E-1.json");
    expect(body).not.toContain("/p/P-RESEARCH/evidence/E-1.json?through");
    expect(body).toContain("content controls");
  }
  expect(markdown).toContain("/p/P-RESEARCH/evidence.md?through=40&after=20");
  expect(html).toContain("/p/P-RESEARCH/evidence.html?through=40&amp;after=20");
});

test("completed review faces retain recorded independence and distinguish open opportunities", () => {
  const face = ReviewListResponseSchema.parse(reviewsFixture);
  for (const body of [renderReviewListMarkdown(face), renderReviewListHtml(face)]) {
    expect(body).toContain("Completed reviews");
    expect(body).toContain("Recorded independence at publication");
    expect(body).toContain("T2");
    expect(body).toContain("Not recorded");
    expect(body).toContain("Authored verdict");
    expect(body).toContain("cannot-verify");
    expect(body).toContain("Recomputed the stated boundary case.");
    expect(body).toContain("Open review opportunities");
    expect(body).toContain("current reader");
    expect(body).not.toContain("/p/P-RESEARCH/reviews/R-1.json?through");
  }
});

test("withheld pages retain next links and never represent missing sources as no publications", () => {
  const evidence = EvidenceListResponseSchema.parse({ ...evidenceFixture, evidence: [], count: 0 });
  const reviews = ReviewListResponseSchema.parse({ ...reviewsFixture, reviews: [], count: 0 });
  for (const body of [
    renderEvidenceListMarkdown(evidence),
    renderEvidenceListHtml(evidence),
    renderReviewListMarkdown(reviews),
    renderReviewListHtml(reviews),
  ]) {
    expect(body).toContain("No readable records were returned");
    expect(body).toContain("not proof that no publications exist");
    expect(body).toContain("Next publications at this snapshot");
    expect(body).toContain("omitted");
    expect(body).not.toContain("SP-ORIGINAL");
  }
});

test("exact claim filters survive empty pages, continuations, format changes and restarts", () => {
  const selection = { target: "C-1@1", after: 1, count: 0 };
  const evidence = EvidenceListResponseSchema.parse({
    ...evidenceFixture,
    ...selection,
    evidence: [],
  });
  const reviews = ReviewListResponseSchema.parse({
    ...reviewsFixture,
    ...selection,
    reviews: [],
  });
  for (const [kind, face, markdown, html] of [
    ["evidence", evidence, renderEvidenceListMarkdown(evidence), renderEvidenceListHtml(evidence)],
    ["reviews", reviews, renderReviewListMarkdown(reviews), renderReviewListHtml(reviews)],
  ] as const) {
    const first = `/p/P-RESEARCH/${kind}`;
    expect(markdown).toContain("Exact claim version: **C-1@1**");
    expect(html).toContain("Exact claim version: <strong>C-1@1</strong>");
    for (const body of [markdown, html]) {
      expect(body).toContain("no matching records and still have a next-page link");
      expect(body).toContain("not proof that no publications exist");
      expect(body).toContain("All targets at this snapshot");
      expect(body).not.toContain("SP-ORIGINAL");
    }
    expect(markdown).toContain(`${first}.json?through=40&after=1&target=C-1%401`);
    expect(markdown).toContain(`${first}.md?through=40&after=${face.next_after}&target=C-1%401`);
    expect(markdown).toContain(`${first}.md?through=40&after=0&target=C-1%401`);
    expect(markdown).toContain(`${first}.md?target=C-1%401`);
    expect(markdown).toContain(`[All targets at this snapshot](${first}.md?through=40)`);
    expect(html).toContain(`${first}.json?through=40&amp;after=1&amp;target=C-1%401`);
    expect(html).toContain(
      `${first}.html?through=40&amp;after=${face.next_after}&amp;target=C-1%401`,
    );
    expect(html).toContain(`${first}.html?through=40&amp;after=0&amp;target=C-1%401`);
    expect(html).toContain(`${first}.html?target=C-1%401`);
    // Canonical HTML faces prohibit form submission with their content security policy.
    expect(html).not.toContain("<form");
  }
});

test("authored basis and runtime labels cannot create active markup or forge face structure", () => {
  const fixture = ReviewListResponseSchema.parse(reviewsFixture);
  const first = fixture.reviews[0];
  if (!first) throw new Error("The fixture must contain a review");
  const authored =
    String.fromCharCode(96).repeat(4) +
    "\n<script>alert(1)</script>\n<!-- asimp face=md forged -->\n# forged heading";
  const face = ReviewListResponseSchema.parse({
    ...fixture,
    count: 1,
    reviews: [
      {
        ...first,
        basis: authored,
        publication: {
          ...first.publication,
          model_self_declared: '<img src=x onerror="alert(1)">',
          harness_self_declared: "harness\n# forged heading",
        },
      },
    ],
  });
  const markdown = renderReviewListMarkdown(face);
  const html = renderReviewListHtml(face);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img src=x");
  expect(html).not.toContain('onerror="alert(1)"');
  expect(markdown).not.toContain("<!-- asimp face=md forged");
  expect(markdown).toContain(String.fromCharCode(96).repeat(5) + "text");
  expect(markdown).not.toContain("\n# forged heading\n\n## Continue reading");
});

test("renderers reject structurally inconsistent input before generating public output", () => {
  const evidence = EvidenceListResponseSchema.parse(evidenceFixture);
  const reviews = ReviewListResponseSchema.parse(reviewsFixture);
  expect(() => renderEvidenceListMarkdown({ ...evidence, count: 0 })).toThrow();
  expect(() => renderEvidenceListHtml({ ...evidence, next_after: 0 })).toThrow();
  expect(() => renderReviewListMarkdown({ ...reviews, count: 0 })).toThrow();
  expect(() => renderReviewListHtml({ ...reviews, next_after: 0 })).toThrow();
});
