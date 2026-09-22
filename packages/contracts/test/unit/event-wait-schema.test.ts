import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EVENT_TAIL_SCHEMA_ID,
  EventTailQuerySchema,
  EventTailResponseSchema,
  parseEventTailQuery,
} from "../../src/event-tail.ts";
import { generatedEventTailArtifact } from "../../src/event-tail-artifact.ts";

function page(wait?: number) {
  const suffix = wait === undefined ? "" : `&wait=${wait}`;
  return {
    schema: EVENT_TAIL_SCHEMA_ID,
    events: [{ record: "event", problem_id: "P-DEMO", seq: 1, event: null,
      body_omitted: "undisclosed_event" }],
    page_end: {
      control: "page_end", schema: EVENT_TAIL_SCHEMA_ID, problem_id: "P-DEMO",
      since: 0, through: 2, next_cursor: 1, has_more: true,
      next: `/p/P-DEMO/events.json?since=1&limit=1&through=2${suffix}`,
      poll: `/p/P-DEMO/events.json?since=1&limit=1${suffix}`,
    },
    omitted: ["Event envelopes only."],
  };
}

 describe("W7.3 canonical wait schema and recovery links", () => {
  test("Zod and the wire parser accept exactly the bounded scalar grammar", () => {
    for (const value of [...Array.from({ length: 26 }, (_, i) => String(i)),
      "26", "-1", "01", "1.5", "1e1", "", "Infinity", "NaN"]) {
      const params = new URLSearchParams({ since: "1", wait: value });
      const valid = /^(?:[0-9]|1[0-9]|2[0-5])$/.test(value);
      assert.equal(EventTailQuerySchema.safeParse(Object.fromEntries(params)).success, valid);
      assert.equal(parseEventTailQuery(params) !== undefined, valid);
    }
  });
  test("both immediate and waiting continuation links preserve sequence law", () => {
    for (const wait of [undefined, 0, 1, 25])
      assert.equal(EventTailResponseSchema.safeParse(page(wait)).success, true);
    for (const suffix of ["&wait=26", "&wait=01", "&wait=1&wait=1", "&unknown=1"]) {
      const value = page();
      value.page_end.poll += suffix;
      assert.equal(EventTailResponseSchema.safeParse(value).success, false);
    }
    const value = page(25);
    value.page_end.next_cursor = 2;
    assert.equal(EventTailResponseSchema.safeParse(value).success, false);
  });
  test("the served wait schema is generated from the canonical Zod contract", () => {
    const actual = readFileSync(new URL("../../generated/event-tail.schema.json", import.meta.url), "utf8");
    assert.equal(actual, generatedEventTailArtifact().content);
    assert.deepEqual(JSON.parse(actual).properties.query.properties.wait, {
      type: "string", pattern: "^(?:[0-9]|1[0-9]|2[0-5])$",
    });
  });
});
