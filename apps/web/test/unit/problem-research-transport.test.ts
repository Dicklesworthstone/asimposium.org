import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";
import {
  researchPreview,
  researchProblem,
  researchResolutionReceipt,
  researchResolveCommand,
  researchReviewCommand,
  researchReviewReceipt,
  researchSponsor,
  researchSynthesis,
  researchSynthesisResponse,
  researchWorkspace,
} from "../fixtures/problem-research";

mock.module("server-only", () => ({}));
const { stoaProblemClosingSynthesis, stoaChangeProblemResearch, MAX_PROBLEM_CLOSING_SYNTHESIS_BYTES } =
  await import("../../lib/problem-research");
const envKeys = ["STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID"] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "24".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "problem-research-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("closing preview requires signed current authority before reading one fixed-origin immutable synthesis", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(calls.length === 1 ? researchWorkspace : researchSynthesisResponse);
  }) as unknown as typeof fetch;
  expect(await stoaProblemClosingSynthesis(researchSponsor, researchProblem, researchSynthesis.synthesis_id))
    .toEqual({ ok: true, data: researchPreview });
  expect(calls).toHaveLength(2);
  const governancePath = `/v1/sponsors/problems/${researchProblem}/governance`;
  expect(calls[0]!.url).toBe(`${PRODUCTION_STOA_ORIGIN}${governancePath}`);
  const signed = new Headers(calls[0]!.init.headers);
  expect(JSON.parse(signed.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
    route: governancePath, action: "problem-governance-read", principal_id: researchSponsor,
    principal_type: "sponsor", payload_sha256: await payloadDigest(""),
  });
  const source = calls[1]!;
  expect(source.url).toBe(`${PRODUCTION_STOA_ORIGIN}/p/${researchProblem}/syntheses/${researchSynthesis.synthesis_id}.json`);
  expect(source.init).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store", redirect: "error" });
  expect(source.init.signal).toBeInstanceOf(AbortSignal);
  const publicHeaders = new Headers(source.init.headers);
  for (const name of ["cookie", "authorization", SERVICE_ENVELOPE_HEADER]) expect(publicHeaders.has(name)).toBe(false);
});

test("wrong current authority, problem status or signed scope never dispatches the synthesis read", async () => {
  for (const workspace of [
    { ...researchWorkspace, authority: { owner: false, steward: false, can_edit_access: true } },
    { ...researchWorkspace, acting_sponsor_id: "usr_fedcba0987654321" },
    { ...researchWorkspace, problem: { ...researchWorkspace.problem, id: "P-OTHER" } },
    { ...researchWorkspace, problem: { ...researchWorkspace.problem, status: "active" } },
    { ...researchWorkspace, problem: { ...researchWorkspace.problem, status: "resolved" },
      authority: { owner: true, steward: false, can_edit_access: false } },
  ]) {
    const fetcher = mock(async () => Response.json(workspace));
    globalThis.fetch = fetcher as unknown as typeof fetch;
    expect((await stoaProblemClosingSynthesis(researchSponsor, researchProblem, researchSynthesis.synthesis_id)).ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

test("untrusted target strings, unsafe versions, unrelated commands and expert assertions do not dispatch", async () => {
  const fetcher = mock(async () => Response.json(researchResolutionReceipt));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  for (const target of ["../private", "P-RESEARCH\n", "P-X?through=1"]) {
    expect((await stoaProblemClosingSynthesis(researchSponsor, target, researchSynthesis.synthesis_id)).ok).toBe(false);
    expect((await stoaChangeProblemResearch(researchSponsor, target, researchReviewCommand, "key")).ok).toBe(false);
  }
  for (const id of ["../private", "SYNTH-CLOSING\n", "SYNTH-CLOSING?through=1"]) {
    expect((await stoaProblemClosingSynthesis(researchSponsor, researchProblem, id)).ok).toBe(false);
  }
  for (const command of [
    { action: "retire", reason: "Not a research review command." },
    { ...researchReviewCommand, sponsor_id: researchSponsor },
    { ...researchReviewCommand, result_claim: { claim_id: "C-3\n", version: 1 } },
    { ...researchReviewCommand, result_claim: { claim_id: "C-3", version: Number.MAX_SAFE_INTEGER + 1 } },
    { ...researchResolveCommand, external_expert_review_proof: "Trust this sponsor assertion." },
    { ...researchResolveCommand, closing_synthesis: { ...researchResolveCommand.closing_synthesis, synthesis_id: undefined } },
    { ...researchResolveCommand, closing_synthesis: { ...researchResolveCommand.closing_synthesis, synthesis_id: "SYNTH-CLOSING\n" } },
  ]) {
    expect((await stoaChangeProblemResearch(researchSponsor, researchProblem,
      command as Parameters<typeof stoaChangeProblemResearch>[2], "key")).ok).toBe(false);
  }
  for (const key of ["", "key\n", "bad key"]) {
    expect((await stoaChangeProblemResearch(researchSponsor, researchProblem, researchResolveCommand, key)).ok).toBe(false);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

test("preview preserves every published byte and refuses oversized or unpinned closing declarations", async () => {
  for (const [changes, issue] of [
    [{ body_md: "x".repeat(8193) }, "body-too-long"],
    [{ closing_resolution: undefined }, "missing-declaration"],
    [{ covers_through: researchSynthesis.seq }, "invalid-reference"],
    [{ anchors: [{ target_kind: "claim", target_id: "C-3", target_version: 1 }] }, "invalid-reference"],
    [{ anchors: [{ target_kind: "claim", target_id: "C-3", target_version: 2, target_seq: 3 }] }, "invalid-reference"],
    [{ anchors: [{ target_kind: "claim", target_id: "C-3", target_version: 1, target_seq: 12 }] }, "invalid-reference"],
  ] as const) {
    globalThis.fetch = mock(async (url: string | URL | Request) => Response.json(
      String(url).endsWith("/governance") ? researchWorkspace : {
        ...researchSynthesisResponse, synthesis: { ...researchSynthesis, ...changes },
      },
    )) as unknown as typeof fetch;
    expect(await stoaProblemClosingSynthesis(researchSponsor, researchProblem, researchSynthesis.synthesis_id))
      .toEqual({ ok: false, reason: "invalid-closing", issue });
  }
});

test("public synthesis responses cannot substitute another problem or publication", async () => {
  for (const changed of [{ problem_id: "P-OTHER" }, { synthesis_id: "SYNTH-OTHER" }]) {
    globalThis.fetch = mock(async (url: string | URL | Request) => Response.json(
      String(url).endsWith("/governance") ? researchWorkspace : {
        ...researchSynthesisResponse, synthesis: { ...researchSynthesis, ...changed },
      },
    )) as unknown as typeof fetch;
    expect(await stoaProblemClosingSynthesis(researchSponsor, researchProblem, researchSynthesis.synthesis_id))
      .toEqual({ ok: false, reason: "unreachable" });
  }
});

test("streamed and advertised synthesis bodies are bounded and failures return no source bytes", async () => {
  for (const advertised of [true, false]) {
    let cancelled = false;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      if (String(url).endsWith("/governance")) return Response.json(researchWorkspace);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new TextEncoder().encode("UNTRUSTED_SOURCE_CANARY".repeat(4096))); },
        cancel() { cancelled = true; },
      });
      return new Response(body, { headers: advertised
        ? { "content-length": String(MAX_PROBLEM_CLOSING_SYNTHESIS_BYTES + 1) } : {} });
    }) as unknown as typeof fetch;
    const response = await stoaProblemClosingSynthesis(researchSponsor, researchProblem, researchSynthesis.synthesis_id);
    expect(response).toEqual({ ok: false, reason: "unreachable" });
    expect(cancelled).toBe(true);
    expect(JSON.stringify(response)).not.toContain("UNTRUSTED_SOURCE_CANARY");
  }
});

test("missing or untrusted deployment origin never falls back to production", async () => {
  const fetcher = mock(async () => Response.json(researchWorkspace));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  for (const origin of [undefined, "https://attacker.invalid"]) {
    if (origin === undefined) delete process.env.STOA_ORIGIN; else process.env.STOA_ORIGIN = origin;
    expect(await stoaProblemClosingSynthesis(researchSponsor, researchProblem, researchSynthesis.synthesis_id))
      .toEqual({ ok: false, reason: "unconfigured" });
  }
  expect(fetcher).not.toHaveBeenCalled();
});

test("review and resolution commands use signed exact bytes and retry directly without mutable reads", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let receipt: unknown;
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json(receipt);
  }) as unknown as typeof fetch;
  for (const [command, expected] of [
    [researchReviewCommand, researchReviewReceipt], [researchResolveCommand, researchResolutionReceipt],
    [researchResolveCommand, researchResolutionReceipt],
  ] as const) {
    receipt = expected;
    expect(await stoaChangeProblemResearch(researchSponsor, researchProblem, command, "retained-research-key"))
      .toEqual({ ok: true, data: expected });
    const request = calls.at(-1)!;
    const path = `/v1/sponsors/problems/${researchProblem}/lifecycle`;
    const body = JSON.stringify(command);
    expect(request.url).toBe(`${PRODUCTION_STOA_ORIGIN}${path}`);
    expect(request.init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store", redirect: "error", body });
    const headers = new Headers(request.init.headers);
    expect(headers.get("idempotency-key")).toBe("retained-research-key");
    expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
      route: path, action: "problem-lifecycle", principal_id: researchSponsor,
      principal_type: "sponsor", payload_sha256: await payloadDigest(body),
    });
  }
  expect(calls).toHaveLength(3);
});

test("a successful HTTP status is insufficient for mismatched or incomplete scientific receipts", async () => {
  let receipt: unknown;
  globalThis.fetch = mock(async () => Response.json(receipt)) as unknown as typeof fetch;
  for (const changed of [
    { id: "P-OTHER" }, { result_claim: { ...researchReviewReceipt.problem.result_claim, claim_id: "C-4" } },
    { result_claim: { ...researchReviewReceipt.problem.result_claim, version: 2 } },
  ]) {
    receipt = { problem: { ...researchReviewReceipt.problem, ...changed } };
    expect(await stoaChangeProblemResearch(researchSponsor, researchProblem, researchReviewCommand, "key"))
      .toEqual({ ok: false, reason: "unreachable" });
  }
  for (const changed of [
    { id: "P-OTHER" }, { resolution_direction: "refuted-as-stated" }, { resolution_summary: "Altered conclusion." },
    { resolution_no_claim_boundary: { ...researchResolutionReceipt.problem.resolution_no_claim_boundary, verified: ["Enlarged scope."] } },
    { closing_synthesis: { ...researchResolutionReceipt.problem.closing_synthesis, synthesis_id: "SYNTH-OTHER" } },
    { closing_synthesis: { ...researchResolutionReceipt.problem.closing_synthesis, seq: 11 } },
    { closing_synthesis: undefined }, { result_claim: undefined },
  ]) {
    receipt = { problem: { ...researchResolutionReceipt.problem, ...changed } };
    expect(await stoaChangeProblemResearch(researchSponsor, researchProblem, researchResolveCommand, "key"))
      .toEqual({ ok: false, reason: "unreachable" });
  }
});
