import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import {
  EVENT_TAIL_OMISSIONS,
  EVENT_TAIL_SCHEMA_ID,
  EventTailResponseSchema,
  eventTailPath,
  parseEventTailQuery,
} from "@asimposium/contracts/event-tail";
import { renderToStaticMarkup } from "react-dom/server";
import {
  eventHistoryContinuation,
  eventHistoryPath,
  parseEventHistoryQuery,
  publicEventObjectPath,
} from "../../lib/event-history";
import { parsePublicRecord, resolvePublicRecord } from "../../lib/public-record";

mock.module("server-only", () => ({}));
const { stoaFetchEventHistory, stoaFetchPublicRecord } = await import("../../lib/public-ledger");
const { default: HistoryPage, generateMetadata } = await import("../../app/p/[slug]/events/page");
const { default: RecordPage } = await import("../../app/r/[...slug]/page");

/** Real event-tail contract, including sequence-only undisclosed records. */
function history({ since = 0, limit = 2, through = 4, problem = "P-DEMO" } = {}) {
  const nextCursor = Math.min(since + limit, through);
  return EventTailResponseSchema.parse({
    schema: EVENT_TAIL_SCHEMA_ID,
    events: Array.from({ length: nextCursor - since }, (_, index) => {
      const seq = since + index + 1;
      const base = { record: "event", problem_id: problem, seq };
      if (seq === 3) return { ...base, event: null, body_omitted: "undisclosed_event" };
      return {
        ...base,
        event: {
          id: `EV-${seq}`, type: seq === 1 ? "problem.published" : seq === 2 ? "claim.created" : "claim.revised",
          object_kind: seq === 1 ? "problem" : "claim", object_id: seq === 1 ? problem : "C-2",
          object_version: seq === 4 ? 2 : 1, created_at: "2026-10-18T12:00:00.000Z",
          payload_sha256: "a".repeat(64),
          caused_by: seq === 4 ? [{ scope: "problem", scope_id: problem, seq: 2, event_id: "EV-2" }] : null,
          causality_omitted: seq === 4 ? null : "not_recorded",
          actor: {
            fellow_id: "F-AUTHOR", sponsor_id: "usr_actor", session_id: "S-SESSION",
            model_self_declared: "<script>declared-model</script>", harness_self_declared: "declared-harness",
          },
          object_url: seq === 1 ? null : `/p/${problem}/claims/C-2@${seq === 4 ? 2 : 1}.json?through=${through}`,
        },
        body_omitted: "separate_object_face",
      };
    }),
    page_end: {
      control: "page_end", schema: EVENT_TAIL_SCHEMA_ID, problem_id: problem,
      since, through, next_cursor: nextCursor, has_more: nextCursor < through,
      next: nextCursor < through ? eventTailPath(problem, "json", { since: nextCursor, limit, through }) : null,
      poll: eventTailPath(problem, "json", { since: nextCursor, limit }),
    },
    omitted: EVENT_TAIL_OMISSIONS,
  });
}

const realFetch = globalThis.fetch;
let previousOrigin: string | undefined;
beforeEach(() => {
  previousOrigin = process.env.STOA_ORIGIN;
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousOrigin === undefined) delete process.env.STOA_ORIGIN;
  else process.env.STOA_ORIGIN = previousOrigin;
});

const props = (query: Record<string, string | string[] | undefined> = { limit: "2" }) => ({
  params: Promise.resolve({ slug: "P-DEMO" }), searchParams: Promise.resolve(query),
});
function eventTarget(seq = 2) {
  const target = resolvePublicRecord(["p", "P-DEMO", "events", String(seq)]);
  if (target === null) throw new Error("Expected the registered exact-event route");
  return target;
}
async function respondToHistory(input: string | URL | Request) {
  const query = parseEventTailQuery(new URL(String(input)).searchParams);
  if (query === undefined) throw new Error("Invalid history request");
  return Response.json(history(query));
}

test("history navigation accepts canonical cursor forms and preserves the source snapshot", () => {
  expect(parseEventHistoryQuery({})).toEqual({ since: 0, limit: 50 });
  expect(parseEventHistoryQuery({ since: "2", limit: "1", through: "4" })).toEqual({ since: 2, limit: 1, through: 4 });
  for (const query of [
    { since: ["0", "1"] }, { through: "04" }, { since: "9007199254740992" },
    { since: "3", through: "2" }, { limit: "201" }, { wait: "0" }, { body: "private" },
  ]) expect(parseEventHistoryQuery(query)).toBeNull();
  expect(eventHistoryContinuation("P-DEMO", "/p/P-DEMO/events.json?since=2&limit=2&through=4"))
    .toBe("/p/P-DEMO/events?since=2&limit=2&through=4");
  for (const path of [
    "https://evil.test/p/P-DEMO/events.json?since=2&limit=2&through=4",
    "/p/P-OTHER/events.json?since=2&limit=2&through=4",
    "/p/P-DEMO/events.json?since=2&since=3&limit=2&through=4",
    "/p/P-DEMO/events.json?since=2&limit=2&through=4&wait=0",
  ]) expect(eventHistoryContinuation("P-DEMO", path)).toBeNull();
  expect(eventHistoryPath("P-DEMO", { since: 2, limit: 2, through: 4 })).toBe("/p/P-DEMO/events?since=2&limit=2&through=4");
});

test("bounded history reads bind scope, start, limit and snapshot to the request", async () => {
  const calls: string[] = [];
  let response = history();
  globalThis.fetch = mock(async (input: string | URL | Request, options?: RequestInit) => {
    calls.push(String(input));
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(response);
  }) as unknown as typeof fetch;
  const query = { since: "0", limit: "2", through: "4" };
  expect((await stoaFetchEventHistory("P-DEMO", undefined, query)).state).toBe("ok");
  expect(calls[0]).toBe(`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/events.json?since=0&limit=2&through=4`);
  for (const candidate of [
    history({ problem: "P-OTHER" }), history({ since: 1 }), history({ limit: 3 }), history({ through: 5 }),
  ]) {
    response = candidate;
    expect(await stoaFetchEventHistory("P-DEMO", undefined, query)).toEqual({ state: "unavailable", reason: "invalid_response" });
  }
  response = history();
  response.page_end.poll = "/p/P-DEMO/events.json?since=2&limit=3";
  expect(await stoaFetchEventHistory("P-DEMO", undefined, query)).toEqual({ state: "unavailable", reason: "invalid_response" });
});

test("private body injection and cross-problem or normalized object links fail closed", async () => {
  let response: unknown = history();
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  const modified = history();
  const event = modified.events[1]?.event;
  if (event == null) throw new Error("Expected disclosed fixture event");
  for (const path of ["/p/P-OTHER/claims/C-2@1.json", "/p/P-DEMO/claims/../../v1/private.json"]) {
    event.object_url = path;
    response = modified;
    expect((await stoaFetchEventHistory("P-DEMO", undefined, { limit: "2" })).state).toBe("unavailable");
    expect(publicEventObjectPath("P-DEMO", path)).toBeNull();
  }
  const privateLeak = history({ since: 2 });
  response = { ...privateLeak, events: [{ ...privateLeak.events[0], body: "PRIVATE-CANARY" }, privateLeak.events[1]] };
  const html = renderToStaticMarkup(await HistoryPage(props({ since: "2", limit: "2" })));
  expect(html).toContain("Public ledger data is temporarily unavailable");
  expect(html).not.toContain("PRIVATE-CANARY");
  expect(html).not.toContain("No events were returned");
});

test("invalid human query input refuses before fetching and gets noindex metadata", async () => {
  const request = mock(respondToHistory);
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [{ since: ["1", "2"] }, { since: "-1" }, { through: "03" }, { wait: "25" }, { token: "PRIVATE-CANARY" }]) {
    expect(renderToStaticMarkup(await HistoryPage(props(query)))).toContain("Choose a valid history range");
    expect((await generateMetadata(props(query))).robots).toEqual({ index: false, follow: false });
  }
  expect((await stoaFetchEventHistory("../private")).state).toBe("unavailable");
  expect(request).not.toHaveBeenCalled();
});

test("history renders material content without JavaScript and pages through one fixed snapshot", async () => {
  globalThis.fetch = mock(respondToHistory) as unknown as typeof fetch;
  const first = renderToStaticMarkup(await HistoryPage(props()));
  for (const text of ["Ledger history", "problem.published", "claim.created", "EV-2", "C-2@1", "usr_actor", "S-SESSION", "Model (self-declared)", "&lt;script&gt;declared-model&lt;/script&gt;", 'data-through="4"']) expect(first).toContain(text);
  expect(first).not.toContain("<script>declared-model</script>");
  expect(first).toContain('href="/r/p/P-DEMO/events/2"');
  expect(first).toContain('href="/p/P-DEMO/events?since=2&amp;limit=2&amp;through=4"');
  expect(first).toContain(`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/events.json?since=0&amp;limit=2&amp;through=4`);
  expect(first).not.toContain("Check for newer events");
  const second = renderToStaticMarkup(await HistoryPage(props({ since: "2", limit: "2", through: "4" })));
  expect(second).toContain("Undisclosed event");
  expect(second).toContain("Recorded causal parents");
  expect(second).toContain("EV-2 · ledger sequence 2");
  expect(second).toContain('href="/p/P-DEMO/events?since=4&amp;limit=2"');
  expect(second).not.toContain("Next events in this snapshot");
});

test("exact-event human pages use the event-tail contract and refuse a substitute event", async () => {
  const target = eventTarget();
  const page = history({ since: 1, limit: 1 });
  expect(parsePublicRecord(page, target)?.kind).toBe("event");
  expect(parsePublicRecord(history({ since: 0, limit: 1 }), target)).toBeNull();
  expect(parsePublicRecord(history({ since: 1, limit: 1, problem: "P-OTHER" }), target)).toBeNull();
  expect(parsePublicRecord(history(), target)).toBeNull();
  const calls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    calls.push(String(input));
    return respondToHistory(input);
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await RecordPage({ params: Promise.resolve({ slug: ["p", "P-DEMO", "events", "2"] }) }));
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/events.json?since=1&limit=1`]);
  expect(html).toContain("Ledger event at sequence 2");
  expect(html).toContain("EV-2");
  expect(html).not.toContain("EV-1");
  expect(html).not.toContain("Public ledger data is temporarily unavailable");
  expect(html).toContain("Read the history from this event");
});

test("withdrawal and noindex apply to history and exact-event reads immediately", async () => {
  let page = history({ since: 1, limit: 1 });
  globalThis.fetch = mock(async () => Response.json(page, { headers: { "x-robots-tag": "noindex, nofollow" } })) as unknown as typeof fetch;
  const input = props({ since: "1", limit: "1" });
  expect((await generateMetadata(input)).robots).toEqual({ index: false, follow: false });
  const initial = renderToStaticMarkup(await HistoryPage(input));
  expect(initial).toContain("Read the linked public object");
  const event = page.events[0]?.event;
  if (event == null || page.events[0] === undefined) throw new Error("Expected disclosed fixture event");
  page.events[0].body_omitted = "content_unavailable";
  event.caused_by = null;
  event.causality_omitted = "unavailable";
  const withdrawn = renderToStaticMarkup(await HistoryPage(input));
  expect(withdrawn).toContain("Content unavailable under current public visibility controls");
  expect(withdrawn).not.toContain("Read the linked public object");
  expect(withdrawn).not.toContain("claims/C-2@1.json");
  page = history({ since: 2, limit: 1 });
  const hidden = renderToStaticMarkup(await RecordPage({ params: Promise.resolve({ slug: ["p", "P-DEMO", "events", "3"] }) }));
  expect(hidden).toContain("Only its position in the public sequence is available");
  expect(hidden).not.toContain("usr_actor");
  expect(hidden).not.toContain("declared-model");
});

test("history and exact-event pages display public screening context only while the source remains available", async () => {
  const page = history({ since: 1, limit: 1 });
  const entry = page.events[0];
  const event = entry?.event;
  if (entry === undefined || event == null) throw new Error("Expected a disclosed fixture event");
  event.screening_notice = {
    category: "dual-use-boundary",
    action: "published-with-warning",
    notice: "screening-warning",
  };
  globalThis.fetch = mock(async () => Response.json(page)) as unknown as typeof fetch;
  const exact = { params: Promise.resolve({ slug: ["p", "P-DEMO", "events", "2"] }) };
  for (const html of [
    renderToStaticMarkup(await HistoryPage(props({ since: "1", limit: "1" }))),
    renderToStaticMarkup(await RecordPage(exact)),
  ]) {
    expect(html).toContain("screening context notice: dual-use-boundary");
    expect(html).toContain("does not determine the scientific standing");
  }
  page.events[0] = {
    ...entry,
    body_omitted: "content_unavailable",
    event: { ...event, screening_notice: undefined, caused_by: null, causality_omitted: "unavailable" },
  };
  const withdrawn = renderToStaticMarkup(await RecordPage(exact));
  expect(withdrawn).toContain("Content unavailable");
  expect(withdrawn).not.toContain("screening context notice");
});

test("empty ranges, missing events, missing problems and deployment failures remain distinct", async () => {
  globalThis.fetch = mock(async () => Response.json(history({ since: 4, limit: 1 }))) as unknown as typeof fetch;
  const empty = renderToStaticMarkup(await HistoryPage(props({ since: "4", limit: "1" })));
  expect(empty).toContain("No events were returned in this range");
  expect((await stoaFetchPublicRecord(eventTarget(5))).state).toBe("not_found");
  globalThis.fetch = mock(async () => Response.json({ status: 404, code: "ROUTE_NOT_FOUND" }, { status: 404 })) as unknown as typeof fetch;
  expect((await stoaFetchEventHistory("P-DEMO")).state).toBe("unavailable");
  globalThis.fetch = mock(async () => Response.json({ status: 404, code: "PROBLEM_NOT_FOUND" }, { status: 404 })) as unknown as typeof fetch;
  expect((await stoaFetchEventHistory("P-DEMO")).state).toBe("not_found");
  await expect(HistoryPage(props())).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
});

test("far-future exact events are missing only for the canonical beyond-head cursor refusal", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json({ status: 400, code: "CURSOR_INVALID" }, { status: 400 });
  }) as unknown as typeof fetch;
  expect((await stoaFetchPublicRecord(eventTarget(99))).state).toBe("not_found");
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/events.json?since=98&limit=1`]);
  await expect(RecordPage({ params: Promise.resolve({ slug: ["p", "P-DEMO", "events", "99"] }) }))
    .rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  expect(await stoaFetchEventHistory("P-DEMO", undefined, { since: "98", limit: "1" }))
    .toEqual({ state: "unavailable", reason: "http" });
  for (const response of [
    { status: 400, code: "INVALID_QUERY" },
    { status: 404, code: "CURSOR_INVALID" },
    { code: "CURSOR_INVALID" },
  ]) {
    globalThis.fetch = mock(async () => Response.json(response, { status: 400 })) as unknown as typeof fetch;
    expect((await stoaFetchPublicRecord(eventTarget(99))).state).toBe("unavailable");
  }
  // A valid empty page for another start cursor is not proof this event is missing.
  globalThis.fetch = mock(async () => Response.json(history({ since: 4, limit: 1 }))) as unknown as typeof fetch;
  expect(await stoaFetchPublicRecord(eventTarget(99)))
    .toEqual({ state: "unavailable", reason: "invalid_response" });
});
