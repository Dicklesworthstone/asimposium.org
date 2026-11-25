import { describe, expect, test } from "bun:test";
import { ProblemsIndexResponseSchema } from "@asimposium/contracts";
import { EVENT_TAIL_SCHEMA_ID, EventTailResponseSchema } from "@asimposium/contracts/event-tail";
import { decode } from "@toon-format/toon";
import {
  parseEventTailToon,
  parseProblemsIndexToon,
  renderEventTailToon,
  renderProblemsIndexToon,
  TOON_MEDIA_TYPE,
} from "../../src/toon.ts";

describe("Unified uniform-list TOON renderer (@toon-format/toon, ADR-5)", () => {
  test("exports canonical text/toon; charset=utf-8 media type", () => {
    expect(TOON_MEDIA_TYPE).toBe("text/toon; charset=utf-8");
  });

  test("problems index round-trips losslessly with pipes, newlines, backslashes, quotes, and null titles", () => {
    const data = ProblemsIndexResponseSchema.parse({
      problems: [
        {
          id: "P-ALPHA",
          title: 'Title | with "pipes"\nand \\backslash\\',
          status: "active",
          public_seq: 12,
          created_at: "2026-10-01T00:00:00.000Z",
          updated_at: "2026-10-02T00:00:00.000Z",
        },
        {
          id: "P-BETA",
          title: null,
          status: "sharpening",
          public_seq: 1,
          created_at: "2026-10-03T00:00:00.000Z",
          updated_at: "2026-10-03T00:00:00.000Z",
        },
      ],
      next_after: "P-BETA",
      omitted: ["page_limit"],
    });

    const toon = renderProblemsIndexToon(data);
    expect(toon.endsWith("\n")).toBe(true);
    expect(decode(toon, { strict: true })).toEqual(JSON.parse(JSON.stringify(data)));
    expect(parseProblemsIndexToon(toon)).toEqual(data);
  });

  test("event tail round-trips full EventTailPage losslessly including actor, caused_by, screening_notice, and undisclosed envelopes", () => {
    const page = EventTailResponseSchema.parse({
      schema: EVENT_TAIL_SCHEMA_ID,
      events: [
        {
          record: "event",
          problem_id: "P-ALPHA",
          seq: 2,
          event: {
            id: "EV-2",
            type: "claim.created",
            object_kind: "claim",
            object_id: "C-1",
            object_version: 1,
            created_at: "2026-10-01T00:00:00.000Z",
            payload_sha256: "a".repeat(64),
            caused_by: [{ scope: "problem", event_id: "EV-1", scope_id: "P-ALPHA", seq: 1 }],
            causality_omitted: null,
            actor: {
              fellow_id: "F-alpha",
              sponsor_id: "S-1",
              session_id: "SES-1",
              model_self_declared: "model|x",
              harness_self_declared: "claude-code",
            },
            object_url: "/p/P-ALPHA/claims/C-1@1.json?through=3",
            screening_notice: {
              category: "dual-use-boundary",
              action: "published-with-warning",
              notice: "screening-warning",
            },
          },
          body_omitted: "separate_object_face",
        },
        {
          record: "event",
          problem_id: "P-ALPHA",
          seq: 3,
          event: null,
          body_omitted: "undisclosed_event",
        },
      ],
      page_end: {
        control: "page_end",
        schema: EVENT_TAIL_SCHEMA_ID,
        problem_id: "P-ALPHA",
        since: 1,
        through: 3,
        next_cursor: 3,
        has_more: false,
        next: null,
        poll: "/p/P-ALPHA/events.json?since=3&limit=50",
      },
      omitted: [],
    });

    const toon = renderEventTailToon(page);
    expect(toon.endsWith("\n")).toBe(true);
    expect(parseEventTailToon(toon)).toEqual(page);
    expect(decode(toon, { strict: true })).toEqual(JSON.parse(JSON.stringify(page)));
  });

  test("PLANTED: refuses malformed or hand-rolled pipe-delimited TOON payloads", () => {
    const legacyPipe =
      "id|public_seq|status|created_at|updated_at|title\nP-1|1|active|2026-10-01T00:00:00.000Z|2026-10-01T00:00:00.000Z|Test\n[control:page_end|next_after:none|omitted:0]\n";
    expect(() => parseProblemsIndexToon(legacyPipe)).toThrow();
    expect(() => parseEventTailToon(legacyPipe)).toThrow();
  });
});
