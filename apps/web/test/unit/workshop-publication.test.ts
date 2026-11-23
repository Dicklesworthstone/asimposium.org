import { expect, test } from "bun:test";
import { SponsorWorkshopObjectSchema } from "@asimposium/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkshopPublicationPreview } from "../../app/console/workshop-publication";

async function fixture(kind: "hypothesis" | "evidence" | "dead-end") {
  const draft = await Bun.file(
    new URL(
      `../../../../packages/contracts/test/fixtures/valid/workshop-${kind}-publication.json`,
      import.meta.url,
    ),
  ).json();
  return SponsorWorkshopObjectSchema.parse({
    ...draft,
    workshop_id: "W-abcdefghijklmnopqrstuvwxyz",
    workshop_seq: 1,
    created_at: "2026-10-11T00:00:00.000Z",
  });
}

test("the hypothesis preview shows the exact public route separately from private working notes", async () => {
  const object = await fixture("hypothesis");
  if (
    !object.publication ||
    !("object_kind" in object.publication) ||
    object.publication.object_kind !== "hypothesis"
  )
    throw new Error("Expected hypothesis fixture");
  object.publication.payload.mechanism =
    "Inspect <script>window.injected = true</script> literally.";
  const html = renderToStaticMarkup(createElement(WorkshopPublicationPreview, { object }));
  expect(html).toContain("Stored hypothesis for publication");
  expect(html).toContain(object.publication.payload.route);
  expect(html).toContain(object.publication.payload.falsifier);
  expect(html).toContain(object.publication.payload.body_md);
  expect(html).toContain("Discriminating predictions");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain(object.body_md);
});

test("negative-result previews show the exact failure, examined scope and retry conditions", async () => {
  const object = await fixture("dead-end");
  if (
    !object.publication ||
    !("object_kind" in object.publication) ||
    object.publication.object_kind !== "dead-end"
  )
    throw new Error("Expected dead-end fixture");
  const data = object.publication.payload;
  data.supersedes_dead_end_id = "DE-2";
  data.why_it_fails = "A literal <script>alert(1)</script> does not provide a finite bound.";
  const html = renderToStaticMarkup(createElement(WorkshopPublicationPreview, { object }));
  expect(html).toContain("Stored dead end for publication");
  expect(html).toContain(data.approach);
  expect(html).toContain(data.retry_predicate);
  expect(html).toContain(data.what_was_examined!);
  expect(html).toContain(data.scope_detection_floor!);
  expect(html).toContain("The problem statement is revised");
  expect(html).toContain("DE-2");
  expect(html).toContain("earlier record remains in the history");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain(object.body_md);
  for (const condition of [
    { kind: "claim-reaches" as const, claim_id: "C-7", reaches: "corroborated" as const },
    { kind: "gap-closed" as const, gap_id: "G-4" },
  ]) {
    data.retry_when = condition;
    const variant = renderToStaticMarkup(createElement(WorkshopPublicationPreview, { object }));
    expect(variant).toContain(
      condition.kind === "claim-reaches" ? "C-7 reaches corroborated" : "G-4 is closed",
    );
  }
});

test("the evidence preview exposes exact targets and selection data without inventing a class", async () => {
  const object = await fixture("evidence");
  if (
    !object.publication ||
    !("object_kind" in object.publication) ||
    object.publication.object_kind !== "evidence"
  )
    throw new Error("Expected evidence fixture");
  const data = object.publication.payload;
  data.source = {
    kind: "locator",
    locator: "javascript:alert(1)",
    excerpt: "Source <b>excerpt</b>",
  };
  data.selected_hypothesis_id = "H-1";
  data.computation_domain_or_floor = "Paths of length 1 through 12.";
  data.reproduction = {
    commands: ["check --max-length 12"],
    environment: "Synthetic test harness",
    seed: "42",
  };
  const html = renderToStaticMarkup(createElement(WorkshopPublicationPreview, { object }));
  expect(html).toContain("Stored evidence for publication");
  expect(html).toContain("C-1@2");
  expect(html).toContain(data.body_md);
  expect(html).toContain(data.computation_domain_or_floor);
  expect(html).toContain("check --max-length 12");
  expect(html).toContain("Hypothesis selected by this evidence");
  expect(html).toContain("cannot drive claim promotion");
  expect(html).toContain("computes the evidence class");
  expect(html).toContain("javascript:alert(1)");
  expect(html).not.toContain("href=");
  expect(html).not.toContain("<b>");
  expect(html).not.toContain(object.body_md);
});

test("saved reviews expose the pinned assessment and declarations without private notes or invented independence", () => {
  const object = SponsorWorkshopObjectSchema.parse({
    workshop_id: "W-abcdefghijklmnopqrstuvwxyz",
    workshop_seq: 7,
    type: "note",
    title: "Private review notes",
    body_md: "PRIVATE_REVIEW_WORKING_NOTES",
    relates_to: [],
    created_at: "2026-11-22T00:00:00.000Z",
    publication: {
      object_kind: "review",
      payload: {
        target_claim_id: "C-12",
        target_version: 3,
        verdict: "confirm",
        basis: "Read the reduction <script>alert(1)</script> literally.",
        capable_of_failure: "A missing case would invalidate the reduction.",
        rubric: ["Check the entire declared domain", "Trace every premise"],
        body_md: "The two cases exhaust the declared domain; both preserve the invariant.",
        client_context_cursor: 42,
        scientific_provenance: {
          model_family_self_declared: "review-family",
          method: { category: "deductive", procedure: "Reconstruct the two-case argument." },
        },
        verification: {
          kind: "full-write-up",
          target_digest: `sha256:${"a".repeat(64)}`,
          evidence: { evidence_id: "E-11", digest: `sha256:${"b".repeat(64)}` },
          coverage: ["First case", "Second case"],
          result: "verified",
        },
      },
    },
  });
  const html = renderToStaticMarkup(createElement(WorkshopPublicationPreview, { object }));
  expect(html).toContain("Stored review for publication");
  expect(html).toContain("C-12@3");
  expect(html).toContain("confirm");
  expect(html).toContain("A missing case would invalidate the reduction.");
  expect(html).toContain("Trace every premise");
  expect(html).toContain("both preserve the invariant");
  expect(html).toContain("Based on ledger sequence");
  expect(html).toContain(">42<");
  expect(html).toContain("Recorded checks and declared provenance");
  expect(html).toContain("review-family");
  expect(html).toContain("E-11");
  expect(html).toContain(`sha256:${"a".repeat(64)}`);
  expect(html).toContain(`sha256:${"b".repeat(64)}`);
  expect(html).toContain("Second case");
  expect(html).toContain("computes independence");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("Recorded independence tier:");
  expect(html).not.toContain(object.body_md);
});

test("a saved review with no negative outcome warns about assertion-only standing", () => {
  const object = SponsorWorkshopObjectSchema.parse({
    workshop_id: "W-abcdefghijklmnopqrstuvwxyz",
    workshop_seq: 8,
    type: "scratch",
    title: "Review outline",
    body_md: "PRIVATE_ASSERTION_ONLY_NOTES",
    relates_to: [],
    created_at: "2026-11-22T00:00:00.000Z",
    publication: {
      object_kind: "review",
      payload: {
        target_claim_id: "C-2",
        target_version: 1,
        verdict: "cannot-verify",
        basis: "The claimed argument needs its unavailable premise.",
        body_md: "I cannot verify the argument from the stated premises.",
      },
    },
  });
  const html = renderToStaticMarkup(createElement(WorkshopPublicationPreview, { object }));
  expect(html).toContain("C-2@1");
  expect(html).toContain("assertion-only and carries no assessment weight");
  expect(html).toContain("No rubric lines recorded");
  expect(html).not.toContain("Recorded checks and declared provenance");
  expect(html).not.toContain(object.body_md);
});

test("saved replacements show the exact revised statement, base version and review continuity", () => {
  const object = SponsorWorkshopObjectSchema.parse({
    workshop_id: "W-abcdefghijklmnopqrstuvwxyz",
    workshop_seq: 4,
    version: 2,
    state: "open",
    type: "claim-draft",
    title: "Private replacement notes",
    body_md: "PRIVATE_REPLACEMENT_WORKING_NOTES",
    relates_to: [],
    created_at: "2026-10-19T00:00:00.000Z",
    revision: {
      claim_id: "C-7",
      base_version: 3,
      kind: "conjecture",
      statement: "Every nontrivial finite simple path has exactly two endpoints.",
      falsifier: "A nontrivial finite simple path with another endpoint count.",
      depends_on: [],
    },
  });
  const html = renderToStaticMarkup(createElement(WorkshopPublicationPreview, { object }));
  expect(html).toContain("Stored claim replacement");
  expect(html).toContain("Replaces C-7 at claim version 3 with version 4");
  expect(html).toContain("Existing reviews stay attached to the version they assessed.");
  if (!object.revision?.falsifier)
    throw new Error("Expected a stored replacement with a falsifier.");
  expect(html).toContain(object.revision.statement);
  expect(html).toContain(object.revision.falsifier);
  expect(html).not.toContain(object.body_md);
  expect(html).not.toContain("must publish this replacement through its session");
});
