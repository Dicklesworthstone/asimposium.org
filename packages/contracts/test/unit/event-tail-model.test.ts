import { describe, expect, test } from "bun:test";
import {
  EVENT_TAIL_SCHEMA_ID,
  type EventTailPage,
  eventTailCursor,
  eventTailPath,
  parseEventTailQuery,
  renderEventTail,
} from "../../src/event-tail-model.ts";

describe("W6.4 public cursor and NDJSON completion contract", () => {
  for (const value of ["0", "1", "200", "9007199254740991"]) {
    test(`accepts canonical cursor ${value}`, () =>
      expect(eventTailCursor(value)).toBe(Number(value)));
  }
  for (const value of [
    "",
    "01",
    "-0",
    "-1",
    "+1",
    "1.0",
    "1x",
    "1e2",
    " 1",
    "1\n",
    "9007199254740992",
    "10000000000000000",
  ]) {
    test(`rejects noncanonical cursor ${JSON.stringify(value)}`, () =>
      expect(eventTailCursor(value)).toBeUndefined());
  }
  test("defaults and bounded stable cuts", () => {
    expect(parseEventTailQuery(new URLSearchParams())).toEqual({ since: 0, limit: 50 });
    expect(parseEventTailQuery(new URLSearchParams("since=4&limit=200&through=9"))).toEqual({
      since: 4,
      limit: 200,
      through: 9,
    });
  });
  for (const query of [
    "limit=0",
    "limit=201",
    "limit=1&limit=1",
    "since=0&since=1",
    "through=1&through=1",
    "since=2&through=1",
    "since=2&through=01",
    "wait=25",
    "format=toon",
    "token=private",
  ]) {
    test(`refuses query ${query}`, () =>
      expect(parseEventTailQuery(new URLSearchParams(query))).toBeUndefined());
  }
  function page(count: number, through: number): EventTailPage {
    const since = 4;
    return {
      schema: EVENT_TAIL_SCHEMA_ID,
      events: Array.from({ length: count }, (_, i) => ({
        record: "event" as const,
        problem_id: "P-DEMO",
        seq: since + i + 1,
        event: null,
        body_omitted: "undisclosed_event" as const,
      })),
      page_end: {
        control: "page_end",
        schema: EVENT_TAIL_SCHEMA_ID,
        problem_id: "P-DEMO",
        since,
        through,
        next_cursor: since + count,
        has_more: since + count < through,
        next:
          since + count < through
            ? eventTailPath("P-DEMO", "json", { since: since + count, limit: 2, through })
            : null,
        poll: eventTailPath("P-DEMO", "json", { since: since + count, limit: 2 }),
      },
      omitted: ["Bodies are separate."],
    };
  }
  for (const [count, through] of [
    [0, 4],
    [1, 5],
    [2, 9],
  ] as const) {
    test(`NDJSON terminates ${count} events even with filtered envelopes`, () => {
      const input = page(count, through);
      const body = renderEventTail(input, "ndjson");
      expect(body.endsWith("\n")).toBe(true);
      const lines = body
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines.length).toBe(count + 1);
      expect(lines.slice(0, count)).toEqual([...input.events]);
      expect(lines.at(-1).control).toBe("page_end");
      expect(lines.at(-1).next_cursor).toBe(4 + count);
      expect(lines.at(-1).has_more).toBe(4 + count < through);
      expect(lines.at(-1).poll).toContain("/events.ndjson?");
      expect(lines.at(-1).omitted).toEqual(input.omitted);
      if (input.page_end.next) expect(lines.at(-1).next).toContain(`through=${through}`);
    });
  }
  test("JSON and NDJSON carry identical ordered events", () => {
    const input = page(2, 9);
    expect(JSON.parse(renderEventTail(input, "json"))).toEqual(input);
  });
  test("continuation encodes the same problem and keeps the cut", () => {
    expect(eventTailPath("P:DEMO", "json", { since: 7, limit: 50, through: 9 })).toBe(
      "/p/P%3ADEMO/events.json?since=7&limit=50&through=9",
    );
  });
});
