import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";
import {
  publicationPreview, publicationProblem, publicationReceipt, publicationRequest, publicationSponsor,
} from "../fixtures/problem-publication";

mock.module("server-only", () => ({}));
const { stoaProblemPublicationPreview, stoaPublishProblem } = await import("../../lib/stoa");
const envKeys = ["STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID"] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "14".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "publication-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("private preview and publication sign the exact route, principal and reviewed bytes", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(init?.method === "GET" ? publicationPreview : publicationReceipt);
  }) as unknown as typeof fetch;
  expect(await stoaProblemPublicationPreview(publicationSponsor, publicationProblem))
    .toEqual({ ok: true, data: publicationPreview });
  expect(await stoaPublishProblem(publicationSponsor, publicationProblem, publicationRequest, "reviewed-key"))
    .toEqual({ ok: true, data: publicationReceipt });
  for (const call of calls) {
    const isRead = call.init.method === "GET";
    const path = `/v1/sponsors/problems/${publicationProblem}/${isRead ? "publication-preview" : "lifecycle"}`;
    const body = isRead ? "" : JSON.stringify(publicationRequest);
    expect(call.url).toBe(`${PRODUCTION_STOA_ORIGIN}${path}`);
    expect(call.init).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "error" });
    const headers = new Headers(call.init.headers);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("authorization")).toBe(false);
    expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
      route: path, principal_type: "sponsor", principal_id: publicationSponsor,
      action: isRead ? "problem-publication-preview" : "problem-lifecycle",
      payload_sha256: await payloadDigest(body),
    });
    expect(call.init.body).toBe(isRead ? undefined : body);
    if (!isRead) {
      expect(headers.get("idempotency-key")).toBe("reviewed-key");
      expect(body).not.toContain("PRIVATE_STATEMENT");
    }
  }
});

test("a schema-valid preview for another problem or principal is refused", async () => {
  let response: unknown;
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const candidate of [
    { ...publicationPreview, acting_sponsor_id: "usr_fedcba0987654321" },
    { ...publicationPreview, problem: { ...publicationPreview.problem, id: "P-OTHER" } },
    { ...publicationPreview, problem: { ...publicationPreview.problem, status: "active" } },
    { ...publicationPreview, private_directive: "UNRELATED_PRIVATE_BYTES" },
  ]) {
    response = candidate;
    expect(await stoaProblemPublicationPreview(publicationSponsor, publicationProblem))
      .toEqual({ ok: false, reason: "unreachable" });
  }
});

test("malformed targets, unreviewed requests and injected authority never dispatch", async () => {
  const fetcher = mock(async () => Response.json(publicationReceipt));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  for (const target of ["../private", "P-REVIEW\n", "https://attacker.invalid", "P-X?another=1"]) {
    expect((await stoaProblemPublicationPreview(publicationSponsor, target)).ok).toBe(false);
    expect((await stoaPublishProblem(publicationSponsor, target, publicationRequest, "key")).ok).toBe(false);
  }
  for (const command of [
    { action: "publish" }, { ...publicationRequest, reviewed_statement_version: 0 },
    { ...publicationRequest, reviewed_digest: "bad" }, { ...publicationRequest, sponsor_id: publicationSponsor },
    { action: "retire", reason: "Unreviewed alternate action" },
  ]) expect((await stoaPublishProblem(publicationSponsor, publicationProblem, command as typeof publicationRequest, "key")).ok).toBe(false);
  for (const key of ["bad key", "key\n", ""]) {
    expect((await stoaPublishProblem(publicationSponsor, publicationProblem, publicationRequest, key)).ok).toBe(false);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

test("publication receipts cannot substitute another problem, version or scientific state", async () => {
  let response: unknown;
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const changed of [{ id: "P-OTHER" }, { current_statement_version: 3 }, { status: "resolved" }]) {
    response = { ...publicationReceipt, problem: { ...publicationReceipt.problem, ...changed } };
    expect(await stoaPublishProblem(publicationSponsor, publicationProblem, publicationRequest, "key"))
      .toEqual({ ok: false, reason: "unreachable" });
  }
});

test("oversized private previews are bounded and failures do not expose response content", async () => {
  globalThis.fetch = mock(async () => new Response("PRIVATE_PREVIEW_BODY", {
    status: 200, headers: { "content-length": String(1024 * 1024 + 1) },
  })) as unknown as typeof fetch;
  const result = await stoaProblemPublicationPreview(publicationSponsor, publicationProblem);
  expect(result).toEqual({ ok: false, reason: "unreachable" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_PREVIEW_BODY");
});
