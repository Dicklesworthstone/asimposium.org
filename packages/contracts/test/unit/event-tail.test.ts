import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { generatedEventTailArtifact } from "../../src/event-tail-artifact.ts";
import {
  EVENT_TAIL_SCHEMA_ID,
  EventTailNdjsonPageEndSchema,
  EventTailQuerySchema,
  EventTailResponseSchema,
  PublicEventEnvelopeSchema,
  parseEventTailQuery,
  renderEventTail,
} from "../../src/event-tail.ts";

function page() {
  return {
    schema: EVENT_TAIL_SCHEMA_ID,
    events: [{ record: "event", problem_id: "P-DEMO", seq: 1, event: null, body_omitted: "undisclosed_event" }],
    page_end: { control: "page_end", schema: EVENT_TAIL_SCHEMA_ID, problem_id: "P-DEMO",
      since: 0, through: 2, next_cursor: 1, has_more: true,
      next: "/p/P-DEMO/events.json?since=1&limit=1&through=2",
      poll: "/p/P-DEMO/events.json?since=1&limit=1" },
    omitted: ["No bodies are included."],
  };
}

describe("W6.4 strict public event contracts", () => {
  test("the served artifact is the canonical generator output", async () => {
    expect(await readFile(new URL("../../generated/event-tail.schema.json", import.meta.url), "utf8"))
      .toBe(generatedEventTailArtifact().content);
  });
  test("a complete page validates and NDJSON records validate independently", () => {
    const parsed = EventTailResponseSchema.parse(page());
    const lines = renderEventTail(parsed, "ndjson").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(PublicEventEnvelopeSchema.safeParse(lines[0]).success).toBe(true);
    expect(EventTailNdjsonPageEndSchema.safeParse(lines[1]).success).toBe(true);
    expect(lines[1].next).toBe("/p/P-DEMO/events.ndjson?since=1&limit=1&through=2");
  });
  test("query schema and runtime parser agree on canonical scalar inputs", () => {
    for (const raw of ["", "since=0", "since=1&through=9&limit=200", "since=01", "limit=0", "limit=201", "since=4&through=3", "since=9007199254740992", "token=secret"]) {
      const parameters = new URLSearchParams(raw);
      expect(EventTailQuerySchema.safeParse(Object.fromEntries(parameters)).success)
        .toBe(parseEventTailQuery(parameters) !== undefined);
    }
  });
  test("public producer types can include underscores without dropping the entire page", () => {
    const entry = { ...page().events[0], body_omitted: "content_unavailable", event: {
      id: "E-1", type: "dead_end.recorded", object_kind: "dead-end", object_id: "DE-1",
      object_version: 1, created_at: "2026-09-15T00:00:00.000Z", payload_sha256: "a".repeat(64),
      actor: { fellow_id: null, sponsor_id: null, session_id: null, model_self_declared: null, harness_self_declared: null },
      object_url: null,
    } };
    expect(PublicEventEnvelopeSchema.safeParse(entry).success).toBe(true);
    expect(PublicEventEnvelopeSchema.safeParse({ ...entry, event: { ...entry.event, writer_credential_id: "secret" } }).success).toBe(false);
  });
  for (const [label, mutate] of [
    ["gap", (value: ReturnType<typeof page>) => {
      const first = value.events[0];
      if (!first) throw new Error("missing fixture event");
      first.seq = 2;
    }],
    ["wrong problem", (value: ReturnType<typeof page>) => {
      const first = value.events[0];
      if (!first) throw new Error("missing fixture event");
      first.problem_id = "P-OTHER";
    }],
    ["advanced cursor", (value: ReturnType<typeof page>) => { value.page_end.next_cursor = 2; }],
    ["false completion", (value: ReturnType<typeof page>) => { value.page_end.has_more = false; }],
    ["rewound link", (value: ReturnType<typeof page>) => { value.page_end.next = "/p/P-DEMO/events.json?since=0&limit=1&through=2"; }],
    ["foreign link", (value: ReturnType<typeof page>) => { value.page_end.poll = "/p/P-OTHER/events.json?since=1&limit=1"; }],
    ["empty nonterminal page", (value: ReturnType<typeof page>) => { value.events = []; }],
  ] as const) {
    test(`refuses ${label}`, () => {
      const value = page(); mutate(value);
      expect(EventTailResponseSchema.safeParse(value).success).toBe(false);
    });
  }
  test("no extension can smuggle body or actor metadata into an undisclosed entry", () => {
    for (const extra of [{ body: "private" }, { workshop_id: "WO-1" }, { actor: { fellow_id: "F-1" } }]) {
      expect(PublicEventEnvelopeSchema.safeParse({ ...page().events[0], ...extra }).success).toBe(false);
    }
  });
});
