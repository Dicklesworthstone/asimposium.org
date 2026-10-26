import { expect, test } from "bun:test";
import {
  SPONSOR_DATA_EXPORT_EXCLUSIONS,
  SPONSOR_DATA_EXPORT_FORMAT,
  SPONSOR_DATA_EXPORT_MAX_RESPONSE_BYTES,
  SPONSOR_DATA_EXPORT_SECTIONS,
  type SponsorDataExportRequest,
  type SponsorDataExportResponse,
} from "@asimposium/contracts/account-export";
import {
  AccountExportDownloadError,
  collectAccountExportDownload,
} from "../../lib/account-export-download";

const principalId = "usr_export_download";
const snapshot = { revision: 4, exported_at: "2026-10-26T01:00:00.000Z" };
function pages(): SponsorDataExportResponse[] {
  return SPONSOR_DATA_EXPORT_SECTIONS.map((section, index) => ({
    version: SPONSOR_DATA_EXPORT_FORMAT,
    sponsor_id: principalId,
    snapshot,
    section,
    records: section === "account" ? [{
      kind: "account", data: { sponsor_id: principalId, created_at: 1, active_fellow_limit: 5 },
    }] : [],
    next_cursor: index === SPONSOR_DATA_EXPORT_SECTIONS.length - 1 ? null : {
      snapshot, section: SPONSOR_DATA_EXPORT_SECTIONS[index + 1]!, after: 0,
    },
    omitted: [...SPONSOR_DATA_EXPORT_EXCLUSIONS],
  }));
}

async function collect(values: unknown[], statuses: number[] = []) {
  const requests: SponsorDataExportRequest[] = [];
  const result = await collectAccountExportDownload({
    principalId,
    signal: new AbortController().signal,
    fetchPage: async (request) => {
      const index = requests.length;
      requests.push(request);
      return Response.json(values[index], { status: statuses[index] ?? 200 });
    },
  });
  return { result, requests };
}

test("a download contains every canonical section and its explicit exclusions", async () => {
  const source = pages();
  const { result, requests } = await collect(source);
  expect(result.pages).toBe(SPONSOR_DATA_EXPORT_SECTIONS.length);
  expect(result.records).toBe(1);
  expect(result.filename).toBe("asimposium-account-export-2026-10-26.jsonl");
  expect(result.blob.type).toBe("application/x-ndjson;charset=utf-8");
  const text = await result.blob.text();
  expect(text.endsWith("\n")).toBe(true);
  expect(text.trim().split("\n").map((line) => JSON.parse(line))).toEqual(source);
  expect(result.bytes).toBe(new TextEncoder().encode(text).length);
  expect(requests[0]).toEqual({});
  for (let index = 1; index < requests.length; index++) {
    expect(requests[index]).toEqual({ cursor: source[index - 1]!.next_cursor! });
  }
});

test("a changed account or snapshot never produces a partial download", async () => {
  for (const changed of [
    { sponsor_id: "usr_another_account" },
    { snapshot: { ...snapshot, revision: 5 } },
    { snapshot: { ...snapshot, exported_at: "2026-10-26T01:00:01.000Z" } },
  ]) {
    const source = pages();
    const second = source[1]!;
    const bad: unknown = { ...second, ...changed, next_cursor: null };
    await expect(collect([source[0], bad])).rejects.toMatchObject({ code: "changed" });
  }
  const source = pages();
  await expect(collect([source[0], { error: "EXPORT_CHANGED" }], [200, 409]))
    .rejects.toMatchObject({ code: "changed" });
});

test("premature completion, skipped sections, empty loops and wrong account record are refused", async () => {
  const initial = pages()[0]!;
  for (const bad of [
    { ...initial, next_cursor: null },
    { ...initial, next_cursor: { snapshot, section: "sessions", after: 0 } },
    { ...initial, next_cursor: { snapshot, section: "account", after: 0 } },
    { ...initial, next_cursor: { snapshot, section: "fellows", after: 8 } },
    { ...initial, records: [] },
    { ...initial, records: [{ kind: "account", data: { sponsor_id: "usr_other", created_at: 1, active_fellow_limit: 5 } }] },
  ]) await expect(collect([bad])).rejects.toMatchObject({ code: "invalid" });
  const source = pages();
  await expect(collect([source[0], { ...source[1], next_cursor: { snapshot, section: "fellows", after: 1 } }]))
    .rejects.toMatchObject({ code: "invalid" });
});

test("same-section continuation must advance, while empty final sections remain valid", async () => {
  const source = pages();
  const initial = source[0]!;
  const continued = { ...initial, next_cursor: { snapshot, section: "account" as const, after: 10 } };
  const { result } = await collect([continued, initial, ...source.slice(1)]);
  expect(result.records).toBe(2);
  const stuck = { ...initial, next_cursor: { snapshot, section: "account", after: 10 } };
  await expect(collect([continued, stuck])).rejects.toMatchObject({ code: "invalid" });
});

test("upstream refusal and transport failures are explicit and never return a file", async () => {
  await expect(collect([{ error: "AUTHENTICATION_REQUIRED" }], [401])).rejects.toMatchObject({ code: "unauthenticated" });
  for (const status of [403, 502, 503]) {
    await expect(collect([{ error: "EXPORT_UNAVAILABLE" }], [status])).rejects.toMatchObject({ code: "unavailable" });
  }
  await expect(collectAccountExportDownload({
    principalId, signal: new AbortController().signal,
    fetchPage: async () => { throw new Error("private upstream text must not escape"); },
  })).rejects.toEqual(new AccountExportDownloadError("unavailable"));
});

test("oversized, malformed and secret-bearing extra fields fail before download", async () => {
  for (const response of [
    new Response("x".repeat(SPONSOR_DATA_EXPORT_MAX_RESPONSE_BYTES + 1)),
    new Response("{ malformed json"),
    new Response(new Uint8Array([255, 255])),
    Response.json({ ...pages()[0], token: "must-never-export-a-credential" }),
  ]) {
    await expect(collectAccountExportDownload({
      principalId, signal: new AbortController().signal, fetchPage: async () => response,
    })).rejects.toMatchObject({ code: "invalid" });
  }
});

test("cancellation stops before another private page is requested", async () => {
  const controller = new AbortController();
  let requests = 0;
  const source = pages();
  await expect(collectAccountExportDownload({
    principalId, signal: controller.signal,
    fetchPage: async () => Response.json(source[requests++]),
    onProgress: () => controller.abort(),
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toBe(1);
});
