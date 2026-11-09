import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  FellowProblemBriefListQuerySchema,
  FellowProblemBriefListResponseSchema,
  FellowProblemBriefReadQuerySchema,
  FellowProblemBriefReadResponseSchema,
  fellowProblemBriefListUrl,
  fellowProblemBriefReadUrl,
} from "../../src/problems.ts";

const fixture = (kind: "valid" | "invalid", name: "list" | "read") =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/${kind}/problems-fellow-brief-${name}.json`, import.meta.url),
      "utf8",
    ),
  );

test("assigned brief golden responses are strict and carry no public write endpoint", () => {
  expect(FellowProblemBriefListResponseSchema.safeParse(fixture("valid", "list")).success).toBe(
    true,
  );
  expect(FellowProblemBriefReadResponseSchema.safeParse(fixture("valid", "read")).success).toBe(
    true,
  );
  expect(FellowProblemBriefListResponseSchema.safeParse(fixture("invalid", "list")).success).toBe(
    false,
  );
  expect(FellowProblemBriefReadResponseSchema.safeParse(fixture("invalid", "read")).success).toBe(
    false,
  );
  const response = fixture("valid", "read");
  response.next_actions[0].url = "/v1/p/P-OTHER/claims";
  expect(FellowProblemBriefReadResponseSchema.safeParse(response).success).toBe(false);
});

test("list metadata never accepts formulation bodies or external continuation links", () => {
  const response = fixture("valid", "list");
  expect(
    FellowProblemBriefListResponseSchema.safeParse({ ...response, omitted: undefined }).success,
  ).toBe(false);
  response.briefs[0].statement = "Private formulation";
  expect(FellowProblemBriefListResponseSchema.safeParse(response).success).toBe(false);
  const onward = fixture("valid", "list");
  onward.next_after = onward.briefs[0].id;
  onward.next_url = fellowProblemBriefListUrl(onward.next_after);
  onward.omitted = ["page_limit"];
  expect(FellowProblemBriefListResponseSchema.safeParse(onward).success).toBe(true);
  onward.next_url = "https://attacker.example/collect";
  expect(FellowProblemBriefListResponseSchema.safeParse(onward).success).toBe(false);
});

test("queries accept exact opaque IDs and reject injected authority and unbounded selectors", () => {
  const id = "../private brief/λ?#%";
  const read = new URL(fellowProblemBriefReadUrl(id), "https://a.asimposium.org");
  expect(FellowProblemBriefReadQuerySchema.parse(Object.fromEntries(read.searchParams))).toEqual({
    brief_id: id,
  });
  expect(FellowProblemBriefListQuerySchema.safeParse({ after: "x".repeat(129) }).success).toBe(
    false,
  );
  expect(FellowProblemBriefListQuerySchema.safeParse({ sponsor_id: "usr_other" }).success).toBe(
    false,
  );
  expect(FellowProblemBriefReadQuerySchema.safeParse({}).success).toBe(false);
  expect(
    FellowProblemBriefReadQuerySchema.safeParse({ brief_id: id, fellow_id: "FEL-OTHER" }).success,
  ).toBe(false);
});
