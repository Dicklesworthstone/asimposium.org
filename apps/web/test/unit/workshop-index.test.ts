import { expect, test } from "bun:test";
import { consolePageHref, workshopIndexRequestFromCursor } from "../../lib/workshop-index";

test("private directory links preserve an independent Fellow inventory position", () => {
  const after = { fellow_id: "fellow-01JXYZ", problem_id: "P-4DSP" };
  const link = consolePageHref({
    fellowCursor: "older-fellows",
    workshopAfter: after,
    workshopsAnchor: true,
  });
  const url = new URL(link, "https://asimposium.org");
  expect(url.pathname).toBe("/console");
  expect(url.hash).toBe("#workshops-title");
  expect(url.searchParams.get("fellow_cursor")).toBe("older-fellows");
  expect(workshopIndexRequestFromCursor(url.searchParams.get("workshop_cursor")!)).toEqual({
    after,
  });
  expect(consolePageHref()).toBe("/console");
  expect(consolePageHref({ fellowCursor: "older-fellows", workshopsAnchor: true })).toBe(
    "/console?fellow_cursor=older-fellows#workshops-title",
  );
});

test("malformed or oversized navigation cannot become a signed directory request", () => {
  expect(workshopIndexRequestFromCursor(undefined)).toEqual({});
  for (const value of [
    "",
    "null",
    "[]",
    "{}",
    ["{}", "{}"],
    "x".repeat(1025),
    JSON.stringify({ fellow_id: "fellow-a", problem_id: "../private" }),
    JSON.stringify({ fellow_id: "fellow-a", problem_id: "P-AAA", sponsor_id: "usr_other" }),
  ])
    expect(workshopIndexRequestFromCursor(value)).toBeUndefined();
});
