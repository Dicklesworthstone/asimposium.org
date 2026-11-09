import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";
import {
  revisionCommand,
  revisionId,
  revisionPage,
  revisionPreview,
  revisionProblem,
  revisionReceipt,
  revisionSponsor,
  revisionWireReceipt,
} from "../fixtures/problem-statement-revision";

mock.module("server-only", () => ({}));
const {
  stoaStatementProposals,
  stoaStatementRevisionPreview,
  stoaAcceptStatementRevision,
  MAX_STATEMENT_REVISION_PREVIEW_BYTES,
} = await import("../../lib/problem-statement-proposals");
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
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "24".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "statement-revision-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("private proposal reads sign the exact target and constrain the list continuation", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let body: unknown = revisionPage;
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(body);
  }) as unknown as typeof fetch;
  const after = "SPR-02345678-1234-1234-1234-123456789abc";
  expect(await stoaStatementProposals(revisionSponsor, revisionProblem, { after })).toEqual({
    ok: true,
    data: revisionPage,
  });
  const route = `/v1/sponsors/problems/${revisionProblem}/statement-proposals/after/${after}`;
  expect(calls[0]!.url).toBe(`${PRODUCTION_STOA_ORIGIN}${route}`);
  expect(calls[0]!.init).toMatchObject({
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  const signed = JSON.parse(
    new Headers(calls[0]!.init.headers).get(SERVICE_ENVELOPE_HEADER)!,
  ).claims;
  expect(signed).toMatchObject({
    route,
    action: "problem-statement-proposals",
    principal_id: revisionSponsor,
    payload_sha256: await payloadDigest(""),
  });
  body = revisionPreview;
  expect(await stoaStatementRevisionPreview(revisionSponsor, revisionProblem, revisionId)).toEqual({
    ok: true,
    data: revisionPreview,
  });
  const previewPath = `/v1/sponsors/problems/${revisionProblem}/statement-proposals/${revisionId}`;
  expect(calls[1]!.url).toBe(`${PRODUCTION_STOA_ORIGIN}${previewPath}`);
  expect(
    JSON.parse(new Headers(calls[1]!.init.headers).get(SERVICE_ENVELOPE_HEADER)!).claims,
  ).toMatchObject({
    route: previewPath,
    action: "problem-statement-proposal-preview",
    principal_id: revisionSponsor,
  });
});

test("wrong principals, repeated cursors and mismatched candidate pins fail closed", async () => {
  let body: unknown;
  globalThis.fetch = mock(async () => Response.json(body)) as unknown as typeof fetch;
  for (const changed of [
    { ...revisionPage, problem_id: "P-OTHER" },
    { ...revisionPage, acting_sponsor_id: "usr_other_sponsor" },
    { ...revisionPage, proposals: [...revisionPage.proposals, ...revisionPage.proposals] },
    { ...revisionPage, next_after: revisionId, omitted: [] },
    {
      ...revisionPage,
      next_after: "SPR-22345678-1234-1234-1234-123456789abc",
      omitted: ["page_limit"],
    },
  ]) {
    body = changed;
    expect(await stoaStatementProposals(revisionSponsor, revisionProblem)).toEqual({
      ok: false,
      reason: "unreachable",
    });
  }
  body = revisionPage;
  expect(
    await stoaStatementProposals(revisionSponsor, revisionProblem, { after: revisionId }),
  ).toEqual({ ok: false, reason: "unreachable" });
  for (const changed of [
    { ...revisionPreview, acting_sponsor_id: "usr_other_sponsor" },
    { ...revisionPreview, problem: { ...revisionPreview.problem, id: "P-OTHER" } },
    { ...revisionPreview, proposal: { ...revisionPreview.proposal, problem_id: "P-OTHER" } },
    {
      ...revisionPreview,
      proposal: {
        ...revisionPreview.proposal,
        proposal_id: "SPR-22345678-1234-1234-1234-123456789abc",
      },
    },
    { ...revisionPreview, proposal: { ...revisionPreview.proposal, base_statement_version: 2 } },
    {
      ...revisionPreview,
      proposal: { ...revisionPreview.proposal, status: "accepted", accepted_statement_version: 4 },
    },
  ]) {
    body = changed;
    expect(
      await stoaStatementRevisionPreview(revisionSponsor, revisionProblem, revisionId),
    ).toEqual({ ok: false, reason: "unreachable" });
  }
});

test("the writer receives only immutable review metadata and replay does not preread mutable state", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(revisionWireReceipt);
  }) as unknown as typeof fetch;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await stoaAcceptStatementRevision(
      revisionSponsor,
      revisionProblem,
      revisionCommand,
      "retained-key",
    );
    expect(result).toEqual({ ok: true, data: revisionReceipt });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REVISION");
  }
  expect(calls).toHaveLength(2);
  for (const request of calls) {
    const path = `/v1/sponsors/problems/${revisionProblem}/lifecycle`;
    const body = JSON.stringify(revisionCommand);
    expect(request.url).toBe(`${PRODUCTION_STOA_ORIGIN}${path}`);
    expect(request.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      body,
    });
    const headers = new Headers(request.init.headers);
    expect(headers.get("idempotency-key")).toBe("retained-key");
    expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER)!).claims).toMatchObject({
      route: path,
      action: "problem-lifecycle",
      principal_id: revisionSponsor,
      payload_sha256: await payloadDigest(body),
    });
  }
});

test("successful HTTP responses must prove the exact candidate, digest and accepted version", async () => {
  let body: unknown;
  globalThis.fetch = mock(async () => Response.json(body)) as unknown as typeof fetch;
  for (const changed of [
    { ...revisionWireReceipt, statement_revision: undefined },
    {
      ...revisionWireReceipt,
      problem: { ...revisionWireReceipt.problem, statement: "PRIVATE_REVISION_LEAK" },
    },
    { ...revisionWireReceipt, problem: { ...revisionWireReceipt.problem, id: "P-OTHER" } },
    {
      ...revisionWireReceipt,
      problem: { ...revisionWireReceipt.problem, current_statement_version: 5 },
    },
    ...[
      { proposal_id: "SPR-22345678-1234-1234-1234-123456789abc" },
      { reviewed_digest: "c".repeat(64) },
      { base_statement_version: 2, accepted_statement_version: 3 },
    ].map((change) => ({
      ...revisionWireReceipt,
      statement_revision: { ...revisionWireReceipt.statement_revision, ...change },
    })),
  ]) {
    body = changed;
    expect(
      await stoaAcceptStatementRevision(revisionSponsor, revisionProblem, revisionCommand, "key"),
    ).toEqual({ ok: false, reason: "unreachable" });
  }
});

test("private previews have a streamed byte bound and invalid inputs never dispatch", async () => {
  let cancelled = false;
  const fetcher = mock(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("PRIVATE_PREVIEW_CANARY".repeat(4096)));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  globalThis.fetch = fetcher as unknown as typeof fetch;
  expect(await stoaStatementRevisionPreview(revisionSponsor, revisionProblem, revisionId)).toEqual({
    ok: false,
    reason: "unreachable",
  });
  expect(cancelled).toBe(true);
  expect(MAX_STATEMENT_REVISION_PREVIEW_BYTES).toBeLessThanOrEqual(524_288);
  fetcher.mockClear();
  for (const id of ["../private", `${revisionId}\n`, `${revisionId}?different=1`])
    expect((await stoaStatementRevisionPreview(revisionSponsor, revisionProblem, id)).ok).toBe(
      false,
    );
  for (const command of [
    { ...revisionCommand, statement: "SPONSOR_REPLACEMENT" },
    { ...revisionCommand, reviewed_digest: "invalid" },
    { ...revisionCommand, reviewed_statement_version: Number.MAX_SAFE_INTEGER },
  ])
    expect(
      (
        await stoaAcceptStatementRevision(
          revisionSponsor,
          revisionProblem,
          command as typeof revisionCommand,
          "key",
        )
      ).ok,
    ).toBe(false);
  expect(
    (
      await stoaAcceptStatementRevision(
        revisionSponsor,
        `${revisionProblem}\n`,
        revisionCommand,
        "key",
      )
    ).ok,
  ).toBe(false);
  expect(
    (await stoaAcceptStatementRevision(revisionSponsor, revisionProblem, revisionCommand, "key\n"))
      .ok,
  ).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
