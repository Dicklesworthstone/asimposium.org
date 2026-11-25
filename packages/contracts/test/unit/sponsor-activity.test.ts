import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import {
  generateSponsorActivitySchema,
  SPONSOR_ACTIVITY_SCHEMA_ID,
  SponsorActivityRequestSchema,
  SponsorActivityResponseSchema,
  sponsorActivityMatchesRequest,
} from "../../src/sponsor-activity.ts";

const fixture = (kind: "valid" | "invalid", name: "request" | "response") =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/${kind}/sponsor-activity-${name}.json`, import.meta.url),
      "utf8",
    ),
  );

test("Fellow work requests bind only a Fellow and bounded assignment continuation", () => {
  const valid = fixture("valid", "request");
  expect(SponsorActivityRequestSchema.safeParse(valid).success).toBe(true);
  expect(SponsorActivityRequestSchema.parse({ fellow_id: valid.fellow_id }).limit).toBe(10);
  for (const value of [
    fixture("invalid", "request"),
    null,
    [],
    {},
    { ...valid, limit: 0 },
    { ...valid, limit: 21 },
    { ...valid, limit: 1.5 },
    { ...valid, after_problem_id: "../private" },
    { ...valid, after_problem_id: "P-ALPHA\n" },
  ])
    expect(SponsorActivityRequestSchema.safeParse(value).success).toBe(false);
});

test("private activity pages keep cursor, omission, current visibility and handback claims coherent", () => {
  const page = fixture("valid", "response");
  expect(SponsorActivityResponseSchema.safeParse(page).success).toBe(true);
  const assignment = page.assignments[0];
  for (const value of [
    fixture("invalid", "response"),
    { ...page, assignments: [assignment, assignment], omitted: [] },
    { ...page, next_cursor: "P-ALPHA" },
    {
      ...page,
      has_more: true,
      next_cursor: "P-ALPHA",
      omitted: ["assignment_limit", "public_activity_unavailable"],
    },
    {
      ...page,
      assignments: [],
      has_more: true,
      next_cursor: "P-ALPHA",
      omitted: ["assignment_limit"],
    },
    {
      ...page,
      assignments: [{ ...assignment, public_problem: null }],
      omitted: ["public_activity_unavailable"],
    },
    {
      ...page,
      assignments: [
        { ...assignment, last_public_increment: { ...assignment.last_public_increment, seq: 8 } },
      ],
      omitted: [],
    },
    {
      ...page,
      assignments: [{ ...assignment, handback_unavailable: true }],
      omitted: ["handback_unavailable"],
    },
    { ...page, omitted: [] },
    { ...page, omitted: ["public_activity_unavailable", "public_activity_unavailable"] },
    { ...page, open_sessions: [page.open_sessions[0], page.open_sessions[0]] },
  ])
    expect(SponsorActivityResponseSchema.safeParse(value).success).toBe(false);
});

test("response matching cannot switch sponsor, Fellow, continuation or shorten a partial page", () => {
  const page = SponsorActivityResponseSchema.parse(fixture("valid", "response"));
  const request = SponsorActivityRequestSchema.parse({ fellow_id: page.fellow_id, limit: 2 });
  expect(sponsorActivityMatchesRequest(page.sponsor_id, request, page)).toBe(true);
  expect(sponsorActivityMatchesRequest("usr_foreign", request, page)).toBe(false);
  expect(
    sponsorActivityMatchesRequest(
      page.sponsor_id,
      { ...request, fellow_id: "fellow-foreign" },
      page,
    ),
  ).toBe(false);
  expect(
    sponsorActivityMatchesRequest(
      page.sponsor_id,
      { ...request, after_problem_id: "P-ALPHA" },
      page,
    ),
  ).toBe(false);
  expect(sponsorActivityMatchesRequest(page.sponsor_id, { ...request, limit: 1 }, page)).toBe(
    false,
  );
  const partial = SponsorActivityResponseSchema.parse({
    ...page,
    has_more: true,
    next_cursor: "P-BETA",
    omitted: [...page.omitted, "assignment_limit"],
  });
  expect(sponsorActivityMatchesRequest(page.sponsor_id, request, partial)).toBe(true);
  expect(sponsorActivityMatchesRequest(page.sponsor_id, { ...request, limit: 10 }, partial)).toBe(
    false,
  );
});

test("published JSON Schema retains the bounded closed wire shape and the valid fixtures", () => {
  const document = JSON.parse(generateSponsorActivitySchema());
  expect(document.$id).toBe(SPONSOR_ACTIVITY_SCHEMA_ID);
  expect(document.properties.request.required).toEqual(["fellow_id"]);
  expect(document.properties.request.properties.limit.default).toBe(10);
  expect(document.properties.response.properties.assignments.maxItems).toBe(20);
  expect(document.properties.response.properties.open_sessions.maxItems).toBe(4);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(document, "activity");
  for (const part of ["request", "response"] as const) {
    const validate = ajv.compile({ $ref: `activity#/properties/${part}` });
    expect(validate(fixture("valid", part))).toBe(true);
    expect(validate(fixture("invalid", part))).toBe(false);
  }
});
