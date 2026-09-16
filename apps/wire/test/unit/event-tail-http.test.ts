import { describe, expect, test } from "bun:test";
import { eventTailResponse } from "../../src/ledger/event-tail-http.ts";
import { EVENT_TAIL_SCHEMA_ID, EVENT_TAIL_MAX_BYTES, eventTailPath, type EventTailPage } from "../../../../packages/contracts/src/event-tail-model.ts";

function page(): EventTailPage {
  return { schema: EVENT_TAIL_SCHEMA_ID, events: [],
    page_end: { control: "page_end", schema: EVENT_TAIL_SCHEMA_ID, problem_id: "P-DEMO",
      since: 0, through: 0, next_cursor: 0, has_more: false, next: null,
      poll: eventTailPath("P-DEMO", "json", { since: 0, limit: 50 }) }, omitted: ["Bodies are separate."] };
}
const request = (headers: Record<string, string> = {}, method = "GET") => new Request("https://a.asimposium.org/p/P-DEMO/events.json", { method, headers });

describe("W6.4 actual HTTP response behavior", () => {
  for (const format of ["json", "ndjson"] as const) {
    test(`${format} uses its media type and a completion record`, async () => {
      const response = await eventTailResponse(request(), page(), format, false);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(format === "json" ? "application/json; charset=utf-8" : "application/x-ndjson; charset=utf-8");
      const body = await response.text();
      expect(body).toContain('"control":"page_end"');
      expect(Number(response.headers.get("content-length"))).toBe(new TextEncoder().encode(body).byteLength);
      expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    });
    test(`${format} HEAD has identical headers and no body`, async () => {
      const get = await eventTailResponse(request(), page(), format, false);
      const head = await eventTailResponse(request({}, "HEAD"), page(), format, false);
      expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(get.headers));
      expect(await head.text()).toBe("");
    });
    test(`${format} supports exact, weak, list and wildcard 304`, async () => {
      const get = await eventTailResponse(request(), page(), format, false);
      const etag = get.headers.get("etag");
      if (!etag) throw new Error("missing ETag");
      for (const match of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
        const response = await eventTailResponse(request({ "if-none-match": match }), page(), format, false);
        expect(response.status).toBe(304);
        expect(await response.text()).toBe("");
      }
    });
  }
  test("cross-format ETags cannot return 304", async () => {
    const json = await eventTailResponse(request(), page(), "json", false);
    const response = await eventTailResponse(request({ "if-none-match": json.headers.get("etag") ?? "" }), page(), "ndjson", false);
    expect(response.status).toBe(200);
  });
  test("unlisted data is never publicly cacheable", async () => {
    const response = await eventTailResponse(request(), page(), "json", true);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
  test("redaction or visible output changes invalidate prior ETags", async () => {
    const first = await eventTailResponse(request(), page(), "json", false);
    const response = await eventTailResponse(request({ "if-none-match": first.headers.get("etag") ?? "" }),
      { ...page(), omitted: ["Content was withdrawn."] }, "json", false);
    expect(response.status).toBe(200);
  });
  test("oversized pages refuse before HTTP success construction", async () => {
    let refused = false;
    try { await eventTailResponse(request(), { ...page(), omitted: ["x".repeat(EVENT_TAIL_MAX_BYTES)] }, "json", false); }
    catch { refused = true; }
    expect(refused).toBe(true);
  });
});
