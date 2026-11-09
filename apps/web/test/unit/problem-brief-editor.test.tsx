import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BRIEF_RETRY_WINDOW_MS,
  problemBriefAttempt,
  problemBriefAttemptExpired,
  problemBriefFields,
  problemBriefRequest,
} from "../../lib/problem-briefs";
import { briefFellows, briefSponsor, privateBrief } from "../fixtures/problem-briefs";

mock.module("server-only", () => ({}));
let realNavigation: typeof import("next/navigation");
let editor: typeof import("../../app/console/problem-brief-editor");
let cards: typeof import("../../app/console/problem-card");
beforeAll(async () => {
  realNavigation = { ...(await import("next/navigation")) };
  mock.module("next/navigation", () => ({
    ...realNavigation,
    useRouter: () => ({ refresh() {} }),
  }));
  editor = await import("../../app/console/problem-brief-editor");
  cards = await import("../../app/console/problem-card");
});
afterAll(() => {
  mock.module("next/navigation", () => realNavigation);
});

test("a full edit preserves scientific bytes and its exact reviewed version", () => {
  const fields = problemBriefFields(privateBrief);
  const request = problemBriefRequest(fields, privateBrief);
  expect(request).toEqual({
    id: privateBrief.id,
    expected_version: 4,
    assigned_fellow_id: privateBrief.assigned_fellow_id,
    title: privateBrief.title,
    statement: privateBrief.statement,
    falsifier: privateBrief.falsifier,
    motivation: privateBrief.motivation,
    areas: privateBrief.areas,
    scope: privateBrief.scope,
    out_of_scope: privateBrief.out_of_scope,
    success_criteria: privateBrief.success_criteria,
    famous_guardrail: privateBrief.famous_guardrail,
  });
  expect(request).not.toHaveProperty("sponsor_id");
  expect(request).not.toHaveProperty("status");
  expect(request).not.toHaveProperty("created_at");
});

test("an unassigned existing brief stays unassigned and reassignment preserves its guardrail", () => {
  const original = { ...privateBrief, assigned_fellow_id: undefined };
  const fields = problemBriefFields(original, "F-BRIEF-ACTIVE");
  expect(fields.assignedFellowId).toBe("");
  expect(problemBriefRequest(fields, original)).not.toHaveProperty("assigned_fellow_id");
  const reassigned = problemBriefRequest(
    { ...fields, assignedFellowId: "F-BRIEF-SECOND" },
    original,
  );
  expect(reassigned).toMatchObject({
    expected_version: 4,
    assigned_fellow_id: "F-BRIEF-SECOND",
    famous_guardrail: privateBrief.famous_guardrail,
  });
  expect(problemBriefFields(undefined, "F-BRIEF-ACTIVE").assignedFellowId).toBe("F-BRIEF-ACTIVE");
});

test("shared validation refuses incomplete boundaries and guardrails without dropping untouched fields", () => {
  const fields = problemBriefFields(privateBrief);
  expect(problemBriefRequest({ ...fields, outOfScope: "" }, privateBrief)).toBeNull();
  expect(problemBriefRequest({ ...fields, statement: " \n" }, privateBrief)).toBeNull();
  expect(
    problemBriefRequest(
      {
        ...fields,
        famousGuardrail: {
          canonical_formulation: "Exact formulation",
          variant_distinctions: "",
          authoritative_references: [],
          standing_banner: "Caution",
        },
      },
      privateBrief,
    ),
  ).toBeNull();
  const removed = problemBriefRequest({ ...fields, famousGuardrail: undefined }, privateBrief);
  expect(removed).not.toHaveProperty("famous_guardrail");
  expect(removed).toMatchObject({ scope: privateBrief.scope, expected_version: 4 });
});

test("an uncertain attempt freezes the whole command and never silently renews its retry window", () => {
  const request = problemBriefRequest(problemBriefFields(privateBrief), privateBrief);
  if (request === null) throw new Error("Expected an editable brief");
  const attempt = problemBriefAttempt({ kind: "save", request }, "console-brief-stable", 1000);
  request.title = "A different edit";
  if (request.famous_guardrail !== undefined)
    request.famous_guardrail.authoritative_references[0] = "Changed";
  const originalRequest = problemBriefRequest(problemBriefFields(privateBrief), privateBrief);
  if (originalRequest === null) throw new Error("Expected the original editable brief");
  expect(attempt.command).toEqual({
    kind: "save",
    request: originalRequest,
  });
  expect(attempt.key).toBe("console-brief-stable");
  expect(problemBriefAttemptExpired(attempt, 1000 + BRIEF_RETRY_WINDOW_MS - 1)).toBe(false);
  expect(problemBriefAttemptExpired(attempt, 1000 + BRIEF_RETRY_WINDOW_MS)).toBe(true);
  expect(problemBriefAttemptExpired(attempt, 999)).toBe(true);
  const withdrawal = problemBriefAttempt(
    { kind: "withdraw", id: privateBrief.id, expectedVersion: 4 },
    "console-withdraw",
    1000,
  );
  expect(withdrawal.command).toEqual({ kind: "withdraw", id: privateBrief.id, expectedVersion: 4 });
});

test("the editor renders the complete escaped brief, active own assignments and explicit withdrawal consent", () => {
  const html = renderToStaticMarkup(
    <editor.ProblemBriefEditor
      sponsorId={briefSponsor}
      brief={privateBrief}
      fellows={briefFellows}
      onCommitted={() => {}}
    />,
  );
  for (const name of [
    "title",
    "statement",
    "falsifier",
    "motivation",
    "scope",
    "out_of_scope",
    "success_criteria",
    "areas",
    "assigned_fellow_id",
    "canonical_formulation",
    "variant_distinctions",
    "authoritative_reference_0",
    "authoritative_reference_1",
    "standing_banner",
    "confirm_withdrawal",
  ]) {
    expect(html).toContain(`name="${name}"`);
  }
  expect(html).toContain("&lt;script&gt;untrusted()&lt;/script&gt;");
  expect(html).not.toContain("<script>untrusted()");
  expect(html).toContain("Reference A\nSection 4 preserves this newline.");
  expect(html).toContain("second-brief-fellow");
  expect(html).not.toContain("paused-brief-fellow");
  expect(html).toContain("I confirm withdrawing this private brief.");
  expect(html).toContain("Save brief changes");
  expect(html.match(/method="post"/g)).toHaveLength(2);
});

test("a missing roster page preserves assignment while a known inactive Fellow requires reassignment", () => {
  const unknown = renderToStaticMarkup(
    <editor.ProblemBriefFormFields
      fields={problemBriefFields(privateBrief)}
      fellows={[]}
      disabled={false}
      onChange={() => {}}
    />,
  );
  expect(unknown).toContain('value="F-BRIEF-ACTIVE" selected=""');
  expect(unknown).toContain("outside this roster page");
  const inactive = renderToStaticMarkup(
    <editor.ProblemBriefFormFields
      fields={problemBriefFields({ ...privateBrief, assigned_fellow_id: "F-BRIEF-PAUSED" })}
      fellows={briefFellows}
      disabled={false}
      onChange={() => {}}
    />,
  );
  expect(inactive).toContain('value="F-BRIEF-PAUSED" disabled="" selected=""');
  expect(inactive).toContain("This Fellow is no longer active");
});

test("unavailable current data keeps the open formulation visible but blocks new changes", () => {
  const html = renderToStaticMarkup(
    <editor.ProblemBriefEditor
      sponsorId={briefSponsor}
      brief={privateBrief}
      fellows={briefFellows}
      currentAvailable={false}
      onCommitted={() => {}}
    />,
  );
  expect(html).toContain("PRIVATE_CANONICAL");
  expect(html).toContain("not available in the latest active list");
  expect(html).toContain("Reload current briefs and discard these edits");
  expect(html).toContain('<fieldset disabled="">');
  const adopted = renderToStaticMarkup(
    <editor.EditableProblemBrief
      sponsorId={briefSponsor}
      brief={{ ...privateBrief, status: "adopted" }}
      fellows={briefFellows}
      onCommitted={() => {}}
    />,
  );
  expect(adopted).not.toContain("Edit brief and assignment");
  expect(adopted).not.toContain("<form");
});

test("the manager distinguishes an unavailable list from no active briefs", () => {
  const html = renderToStaticMarkup(
    <cards.ProblemManager
      sponsorId={briefSponsor}
      configured
      briefsLoaded={false}
      briefs={[]}
      fellows={briefFellows}
      problems={[]}
    />,
  );
  expect(html).toContain("The current private brief list could not be loaded");
  expect(html).not.toContain("No active briefs.");
  expect(html).toContain("Reload brief list");
});
