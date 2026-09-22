import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  EVENT_TAIL_SCHEMA_ID,
  type EventTailPage,
  type PublicEventEnvelope,
} from "../../../../packages/contracts/src/event-tail-model.ts";
import {
  eventTailFeedResponse,
  renderEventTailAtom,
  renderEventTailJsonFeed,
  renderEventTailRss,
} from "../../src/ledger/event-feed-http.ts";
import { eventTailResponse } from "../../src/ledger/event-tail-http.ts";

function event(seq: number): PublicEventEnvelope {
  return {
    record: "event",
    problem_id: "P-DEMO",
    seq,
    event: {
      id: `E-${seq}`,
      type: "claim.created",
      object_kind: "claim",
      object_id: `C-${seq}`,
      object_version: 1,
      created_at: `2026-09-${String(seq).padStart(2, "0")}T00:00:00.000Z`,
      payload_sha256: "a".repeat(64),
      object_url: null,
      actor: {
        fellow_id: null,
        sponsor_id: null,
        session_id: null,
        model_self_declared: null,
        harness_self_declared: null,
      },
    },
    body_omitted: "separate_object_face",
  };
}
function page(
  events: readonly PublicEventEnvelope[] = [event(1), event(2), event(3)],
): EventTailPage {
  const head = events.at(-1)?.seq ?? 0;
  return {
    schema: EVENT_TAIL_SCHEMA_ID,
    events,
    page_end: {
      control: "page_end",
      schema: EVENT_TAIL_SCHEMA_ID,
      problem_id: "P-DEMO",
      since: events[0] ? events[0].seq - 1 : 0,
      through: head,
      next_cursor: head,
      has_more: false,
      next: null,
      poll: `/p/P-DEMO/events.json?since=${head}&limit=50`,
    },
    omitted: ["Event envelopes only."],
  };
}
function vary(response: Response) {
  return response.headers
    .get("vary")
    ?.toLowerCase()
    .split(",")
    .map((value) => value.trim());
}

describe("public feed freshness and deterministic validators", () => {
  for (const render of [renderEventTailRss, renderEventTailAtom, renderEventTailJsonFeed]) {
    test(`${render.name} puts new entries first without mutating the machine page`, () => {
      const input = page();
      Object.freeze(input.events);
      const before = JSON.stringify(input);
      const body = render("P-DEMO", input);
      assert.ok(body.indexOf("event:E-3") < body.indexOf("event:E-2"));
      assert.ok(body.indexOf("event:E-2") < body.indexOf("event:E-1"));
      assert.equal(JSON.stringify(input), before);
    });
  }
  test("Atom updated reflects the newest visible timestamp, not the first item", () => {
    const input = page([event(1), event(3), { ...event(2), seq: 4 }]);
    const feed = renderEventTailAtom("P-DEMO", input);
    assert.equal(feed.match(/<updated>(.*?)<\/updated>/)?.[1], "2026-09-03T00:00:00.000Z");
  });
  for (const events of [
    [],
    [
      {
        record: "event",
        problem_id: "P-DEMO",
        seq: 1,
        event: null,
        body_omitted: "undisclosed_event",
      },
    ],
  ] as const) {
    test(`Atom has stable empty/undisclosed output (${events.length})`, async () => {
      const input = page(events);
      const url = "https://a.asimposium.org/p/P-DEMO/feed.atom";
      const first = await eventTailFeedResponse(new Request(url), "P-DEMO", input, "atom", false);
      const etag = first.headers.get("etag");
      await delay(10);
      const second = await eventTailFeedResponse(
        new Request(url, { headers: { "if-none-match": String(etag) } }),
        "P-DEMO",
        input,
        "atom",
        false,
      );
      assert.equal(second.status, 304);
      assert.equal(second.headers.get("etag"), etag);
      assert.equal(await second.text(), "");
      assert.match(await first.text(), /<updated>1970-01-01T00:00:00.000Z<\/updated>/);
    });
  }
  test("undisclosed events never become entries or timestamp authority", () => {
    const input = page([
      event(1),
      {
        record: "event",
        problem_id: "P-DEMO",
        seq: 2,
        event: null,
        body_omitted: "undisclosed_event",
      },
    ]);
    assert.equal(JSON.parse(renderEventTailJsonFeed("P-DEMO", input)).items.length, 1);
    assert.equal(
      renderEventTailAtom("P-DEMO", input).match(/<updated>(.*?)<\/updated>/)?.[1],
      "2026-09-01T00:00:00.000Z",
    );
  });
  for (const format of ["rss", "atom", "json"] as const) {
    test(`${format} keeps HEAD, weak 304 and unlisted cache metadata consistent`, async () => {
      const url = "https://a.asimposium.org/p/P-DEMO/feed";
      const input = page();
      const get = await eventTailFeedResponse(
        new Request(url),
        "P-DEMO",
        input,
        format,
        true,
        true,
      );
      const body = await get.text();
      assert.equal(
        Number(get.headers.get("content-length")),
        new TextEncoder().encode(body).byteLength,
      );
      const head = await eventTailFeedResponse(
        new Request(url, { method: "HEAD" }),
        "P-DEMO",
        input,
        format,
        true,
        true,
      );
      assert.equal(await head.text(), "");
      assert.deepEqual([...head.headers], [...get.headers]);
      const conditional = await eventTailFeedResponse(
        new Request(url, { headers: { "if-none-match": `"other", W/${get.headers.get("etag")}` } }),
        "P-DEMO",
        input,
        format,
        true,
        true,
      );
      assert.equal(conditional.status, 304);
      assert.equal(conditional.headers.get("cache-control"), "private, no-store");
      assert.equal(conditional.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.deepEqual(vary(conditional), ["accept"]);
    });
  }
});

describe("event resume and content negotiation cache identity", () => {
  for (const format of ["json", "ndjson", "toon"] as const) {
    test(`${format} varies by resume header even when it is absent`, async () => {
      const url = "https://a.asimposium.org/p/P-DEMO/events";
      const initial = await eventTailResponse(new Request(url), page(), format, false);
      assert.deepEqual(vary(initial), ["accept", "last-event-id"]);
      const resumed = await eventTailResponse(
        new Request(url, {
          headers: {
            "last-event-id": "2",
            "if-none-match": String(initial.headers.get("etag")),
          },
        }),
        page([event(3)]),
        format,
        false,
      );
      assert.equal(resumed.status, 200);
      assert.notEqual(resumed.headers.get("etag"), initial.headers.get("etag"));
      assert.deepEqual(vary(resumed), ["accept", "last-event-id"]);
      const head = await eventTailResponse(
        new Request(url, { method: "HEAD" }),
        page(),
        format,
        false,
      );
      assert.deepEqual([...head.headers], [...initial.headers]);
      assert.equal(await head.text(), "");
      const notModified = await eventTailResponse(
        new Request(url, { headers: { "if-none-match": String(initial.headers.get("etag")) } }),
        page(),
        format,
        false,
      );
      assert.equal(notModified.status, 304);
      assert.deepEqual(vary(notModified), ["accept", "last-event-id"]);
    });
  }
});
