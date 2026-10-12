import { expect, test } from "bun:test";
import { SponsorWorkshopObjectSchema } from "@asimposium/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkshopPublicationPreview } from "../../app/console/workshop-publication";

async function fixture(kind: "hypothesis" | "evidence") {
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
