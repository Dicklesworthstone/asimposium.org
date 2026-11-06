import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  PRODUCTION_STOA_ORIGIN,
  SPONSOR_INBOX_MAX_RESPONSE_BYTES,
  type SponsorInboxRequest,
} from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";
import { inboxFellow, inboxNotice, inboxPage, inboxSponsor } from "../fixtures/sponsor-inbox";

mock.module("server-only", () => ({}));
const { stoaSponsorInbox } = await import("../../lib/stoa");
const envKeys = [
  "STOA_ORIGIN",
  "SERVICE_ENVELOPE_PRIVATE_KEY_HEX",
  "SERVICE_ENVELOPE_KID",
] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "17".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "inbox-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("sponsor inbox signs the exact read body and keeps browser credentials off Stoa", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(inboxPage);
  }) as unknown as typeof fetch;
  expect(await stoaSponsorInbox(inboxSponsor, { fellow_id: inboxFellow, since: 6 })).toEqual({
    ok: true,
    data: inboxPage,
  });
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (call === undefined) throw new Error("Inbox request was not dispatched");
  const body = JSON.stringify({ fellow_id: inboxFellow, since: 6, limit: 25 });
  expect(call.url).toBe(`${PRODUCTION_STOA_ORIGIN}/v1/sponsors/inbox`);
  expect(call.init).toMatchObject({
    method: "POST",
    body,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  const headers = new Headers(call.init.headers);
  for (const absent of ["authorization", "cookie", "idempotency-key"])
    expect(headers.has(absent)).toBe(false);
  expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
    route: "/v1/sponsors/inbox",
    action: "inbox.read",
    principal_type: "sponsor",
    principal_id: inboxSponsor,
    payload_sha256: await payloadDigest(body),
  });
});

test("signed filter and page size survive transport without acknowledging notices", async () => {
  const page = {
    ...inboxPage,
    items: [inboxNotice],
    next_cursor: 7,
    has_more: true,
    omitted: ["limit_reached"],
  };
  let sent: unknown;
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return Response.json(page);
  }) as unknown as typeof fetch;
  const request = { fellow_id: inboxFellow, limit: 1, unacknowledged_only: true };
  expect(await stoaSponsorInbox(inboxSponsor, request)).toEqual({ ok: true, data: page });
  expect(sent).toEqual(request);
  expect(page.items[0]?.acknowledged_at).toBeNull();
});

test("wrong owner, Fellow, cursor, order or Fellow-only actions never reach the browser", async () => {
  let response: unknown;
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const value of [
    { ...inboxPage, sponsor_id: "usr_other" },
    { ...inboxPage, fellow_id: "fellow-other" },
    { ...inboxPage, next_cursor: null },
    { ...inboxPage, items: [...inboxPage.items].reverse() },
    { ...inboxPage, items: [{ ...inboxNotice, next_actions: [] }] },
    { ...inboxPage, has_more: true },
  ]) {
    response = value;
    expect(await stoaSponsorInbox(inboxSponsor, { fellow_id: inboxFellow })).toEqual({
      ok: false,
      reason: "unreachable",
    });
  }
  response = inboxPage;
  expect(await stoaSponsorInbox(inboxSponsor, { fellow_id: inboxFellow, since: 7 })).toEqual({
    ok: false,
    reason: "unreachable",
  });
});

test("invalid signed requests never dispatch and oversized notice pages fail without leaking content", async () => {
  const fetcher = mock(async () => Response.json(inboxPage));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  for (const value of [
    { fellow_id: inboxFellow, sponsor_id: inboxSponsor },
    { fellow_id: inboxFellow, since: "8" },
    { fellow_id: inboxFellow, limit: 51 },
    { fellow_id: inboxFellow, unacknowledged_only: "true" },
  ])
    expect(await stoaSponsorInbox(inboxSponsor, value as SponsorInboxRequest)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  expect(fetcher).not.toHaveBeenCalled();
  globalThis.fetch = mock(
    async () =>
      new Response("PRIVATE_OVERSIZED_NOTICE", {
        headers: { "content-length": String(SPONSOR_INBOX_MAX_RESPONSE_BYTES + 1) },
      }),
  ) as unknown as typeof fetch;
  expect(await stoaSponsorInbox(inboxSponsor, { fellow_id: inboxFellow })).toEqual({
    ok: false,
    reason: "unreachable",
  });
});
