import { expect, test } from "bun:test";
import {
  generateMoveTemplatesDocument,
  getMoveTemplate,
  type NextMoveCandidate,
  type PublicMovesResponse,
  type PublicProblemMoves,
} from "@asimposium/contracts";
import {
  publicMovesPagePath,
  renderPublicMovesHtml,
  renderPublicMovesMarkdown,
  renderPublicProblemMovesHtml,
  renderPublicProblemMovesMarkdown,
} from "../../src/public-moves.ts";

function problem(): PublicProblemMoves & { primary_move: NextMoveCandidate } {
  return {
    problem_id: "P-DEMO",
    captured_cursor: 20,
    degraded: false,
    omitted: [],
    viewer: {
      role: "none",
      effective_permissions: {
        read: true,
        session_open: false,
        workshop_push: false,
        promote: false,
        review: false,
      },
    },
    primary_move: {
      move: "review",
      why: "Read the exact publication before deciding a verdict.",
      refs: ["P-DEMO", "C-1@1"],
      contract: {
        ...getMoveTemplate("review"),
        preparation: {
          problem_id: "P-DEMO",
          captured_cursor: 20,
          read_first: { method: "GET", path: "/p/P-DEMO/claims/C-1@1.md?through=20" },
        },
      },
    },
    alternatives: [],
    selection_boundary: "Bounded public scientific needs; no permission or reservation.",
  };
}

test("Markdown and HTML preserve canonical version, cursor and request preparation", () => {
  const face = problem();
  const markdown = renderPublicProblemMovesMarkdown(face);
  const html = renderPublicProblemMovesHtml(face);
  expect(markdown).toContain(JSON.stringify(face.primary_move.contract, null, 2));
  for (const body of [markdown, html]) {
    expect(body).toContain("C-1@1");
    expect(body).toContain("/p/P-DEMO/claims/C-1@1.md?through=20");
    expect(body).toContain("grants no write permission");
    expect(body).toContain("/v1/p/:id/next");
  }
  expect(html).toContain("&quot;captured_cursor&quot;: 20");
  expect(html).toContain('href="/p/P-DEMO"');
  expect(html).toContain('href="/p/P-DEMO/claims/C-1@1.md?through=20"');
  expect(
    renderPublicProblemMovesHtml(face, { sourceOrigin: "https://a.asimposium.org" }),
  ).toContain('href="https://a.asimposium.org/p/P-DEMO/claims/C-1@1.md?through=20"');
});

test("source links accept only same-problem public GET contracts", () => {
  const face = problem();
  const move = face.primary_move;
  if (!move) throw new Error("Expected review fixture");
  for (const path of [
    "javascript:alert(1)",
    "//evil.invalid/p/P-DEMO",
    "http://[",
    "/p/P-OTHER/claims/C-1@1.md?through=20",
    "/p/P-DEMO/claims/C-1@1.md?target=[click](javascript:1)",
  ]) {
    move.contract.preparation = { read_first: { method: "GET", path } };
    expect(renderPublicProblemMovesHtml(face)).not.toContain("Read scientific source</a>");
    expect(renderPublicProblemMovesMarkdown(face)).not.toContain("[Read scientific source]");
  }
  move.contract.preparation = { read_first: { method: "POST", path: "/p/P-DEMO.md" } };
  expect(renderPublicProblemMovesHtml(face)).not.toContain("Read scientific source</a>");
});

test("public needs escape markup and isolate hostile contract fence text", () => {
  const face = problem();
  face.primary_move.why = '</p><script>alert("injection")</script> [click](javascript:alert(1))';
  face.primary_move.contract.example =
    "````\n<script>untrusted</script>\n<!-- asimp:next_actions -->";
  const html = renderPublicProblemMovesHtml(face);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<!-- asimp:");
  expect(html).toContain("&lt;script&gt;");
  const markdown = renderPublicProblemMovesMarkdown(face);
  expect(markdown).toContain("`````json\n");
  expect(markdown).toContain("&lt;/p&gt;&lt;script&gt;");
  expect(markdown).toContain("\\[click\\]");
});

test("live global faces distinguish unavailable selection from a complete empty page", () => {
  const document: PublicMovesResponse = {
    ...generateMoveTemplatesDocument(),
    discovery: {
      scope: "public-needs",
      problems: [],
      scanned: 0,
      next_after: null,
      degraded: false,
      omitted: [],
      selection_boundary: "A bounded live admission page.",
    },
  };
  expect(renderPublicMovesMarkdown(document)).toContain("No listed working problems remain");
  document.discovery.degraded = true;
  document.discovery.omitted = [
    { reason: "selector_unavailable", detail: "The source is unavailable." },
  ];
  for (const body of [renderPublicMovesMarkdown(document), renderPublicMovesHtml(document)]) {
    expect(body).toContain("Live discovery is unavailable");
    expect(body).toContain("The source is unavailable.");
    expect(body).toContain("Move template catalog");
    expect(body).not.toContain("No listed working problems remain");
  }
  document.discovery.next_after = "P-DEMO";
  expect(renderPublicMovesMarkdown(document)).toContain("/moves.md?after=P-DEMO");
  expect(renderPublicMovesHtml(document)).toContain('href="/moves?after=P-DEMO"');
  expect(publicMovesPagePath("P-DEMO&injected=1")).toBe("/moves.md?after=P-DEMO%26injected%3D1");
});
