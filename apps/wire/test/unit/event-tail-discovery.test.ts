import { describe, expect, test } from "bun:test";
import {
  EVENT_TAIL_PUBLIC_READS,
  eventTailParameters,
  eventTailResponses,
} from "../../src/discovery/event-tail-discovery.ts";

describe("W6.4 public disclosure", () => {
  test("exactly the two available public representations are advertised", () => {
    expect(Object.keys(EVENT_TAIL_PUBLIC_READS)).toEqual([
      "GET /p/:id/events.json",
      "GET /p/:id/events.ndjson",
    ]);
  });
  for (const origin of ["https://a.asimposium.org", "https://a-staging.asimposium.org"]) {
    test(`${origin} JSON names its response contract`, () => {
      const responses = eventTailResponses("/p/{id}/events.json", origin);
      const encoded = JSON.stringify(responses);
      expect(encoded).toContain(`${origin}/schemas/event-tail.v1.json#/properties/response`);
      expect(encoded).not.toContain("application/x-ndjson");
      expect(responses?.["304"]).toEqual({
        description:
          "Unchanged representation after current visibility and content-availability checks. No body.",
      });
    });
    test(`${origin} NDJSON is not mislabeled as a JSON array`, () => {
      const encoded = JSON.stringify(eventTailResponses("/p/{id}/events.ndjson", origin));
      expect(encoded).toContain("application/x-ndjson");
      expect(encoded).toContain(`${origin}/schemas/event-tail.v1.json#/properties/ndjson_event`);
      expect(encoded).toContain(`${origin}/schemas/event-tail.v1.json#/properties/ndjson_page_end`);
      expect(encoded).not.toContain('"type":"array"');
    });
    test(`${origin} parameters use canonical shared schema references`, () => {
      const parameters = eventTailParameters("/p/{id}/events.json", origin);
      expect(parameters.length).toBe(3);
      for (const name of ["since", "limit", "through"]) {
        expect(JSON.stringify(parameters)).toContain(
          `${origin}/schemas/event-tail.v1.json#/properties/query/properties/${name}`,
        );
      }
      expect(JSON.stringify(parameters)).toContain("Never use the site-wide /cursor");
    });
  }
  for (const path of [
    "/p/{id}/events.toon",
    "/p/{id}/events.sse",
    "/p/{id}.events.json",
    "/v1/sessions/{id}/events.json",
  ]) {
    test(`does not disclose unimplemented or private route ${path}`, () => {
      expect(eventTailResponses(path, "https://a.asimposium.org")).toBeUndefined();
      expect(eventTailParameters(path, "https://a.asimposium.org")).toEqual([]);
    });
  }
});
