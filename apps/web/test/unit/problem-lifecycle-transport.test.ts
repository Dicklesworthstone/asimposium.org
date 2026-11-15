import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import type { ProblemWorkspaceCommand } from "../../lib/problem-lifecycle";
import { payloadDigest, SERVICE_ENVELOPE_HEADER } from "../../lib/service-envelope";
import {
  forkCommand,
  workspaceCases,
  workspaceProblem,
  workspaceSponsor,
} from "../fixtures/problem-lifecycle";

mock.module("server-only", () => ({}));
const { stoaChangeProblemWorkspace } = await import("../../lib/stoa-problem-lifecycle");
const keys = ["STOA_ORIGIN", "SERVICE_ENVELOPE_PRIVATE_KEY_HEX", "SERVICE_ENVELOPE_KID"] as const;
const realFetch = globalThis.fetch;
let previous: Map<string, string | undefined>;
beforeEach(() => {
  previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
  process.env.SERVICE_ENVELOPE_PRIVATE_KEY_HEX = "24".repeat(32);
  process.env.SERVICE_ENVELOPE_KID = "workspace-transport-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("all workspace actions and retries send the exact signed command directly to the single writer", async () => {
  for (const { command, receipt } of workspaceCases) {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json(receipt.result);
    }) as unknown as typeof fetch;
    for (let retry = 0; retry < 2; retry++) {
      expect(
        await stoaChangeProblemWorkspace(
          workspaceSponsor,
          workspaceProblem,
          command,
          "one-command",
        ),
      ).toEqual({ ok: true, data: receipt });
    }
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const path = `/v1/sponsors/problems/${workspaceProblem}/lifecycle`;
      expect(call.url).toBe(`${PRODUCTION_STOA_ORIGIN}${path}`);
      expect(call.init).toMatchObject({
        method: "POST",
        body: JSON.stringify(command),
        cache: "no-store",
        redirect: "error",
      });
      const headers = new Headers(call.init.headers);
      expect(headers.get("Idempotency-Key")).toBe("one-command");
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("authorization")).toBe(false);
      expect(JSON.parse(headers.get(SERVICE_ENVELOPE_HEADER) ?? "{}").claims).toMatchObject({
        principal_type: "sponsor",
        principal_id: workspaceSponsor,
        route: path,
        action: "problem-lifecycle",
        payload_sha256: await payloadDigest(JSON.stringify(command)),
      });
    }
  }
});

test("malformed authority-bearing inputs and unrelated lifecycle commands never dispatch", async () => {
  const fetcher = mock(async () => Response.json({}));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  for (const command of [
    { ...forkCommand, statement: "Invented human science." },
    { ...forkCommand, author: workspaceSponsor },
    { action: "merge", canonical_problem_id: workspaceProblem },
    { action: "publish", reviewed_statement_version: 1, reviewed_digest: "a".repeat(64) },
  ])
    expect(
      (
        await stoaChangeProblemWorkspace(
          workspaceSponsor,
          workspaceProblem,
          command as ProblemWorkspaceCommand,
          "key",
        )
      ).ok,
    ).toBe(false);
  for (const id of ["../private", "P-LINEAGE\n", "P-LINEAGE?scope=other"])
    expect((await stoaChangeProblemWorkspace(workspaceSponsor, id, forkCommand, "key")).ok).toBe(
      false,
    );
  for (const key of ["", "key\n", "bad key"])
    expect(
      (await stoaChangeProblemWorkspace(workspaceSponsor, workspaceProblem, forkCommand, key)).ok,
    ).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

test("a 200 with the wrong source, retirement reason, merge destination or fork identity is never success", async () => {
  for (const { command, receipt } of workspaceCases) {
    const wrong: unknown[] = [
      { ...receipt.result, problem: { ...receipt.result.problem, id: "P-OTHER" } },
      { ...receipt.result, token: "PRIVATE_RESPONSE_CANARY" },
    ];
    if (receipt.action === "retire")
      wrong.push({
        problem: { ...receipt.result.problem, resolution_summary: "A different decision." },
      });
    if (receipt.action === "merge")
      wrong.push({ problem: { ...receipt.result.problem, canonical_problem_id: "P-OTHER" } });
    if (receipt.action === "fork")
      wrong.push(
        { ...receipt.result, forked_problem_id: workspaceProblem },
        { problem: receipt.result.problem },
      );
    for (const value of wrong) {
      globalThis.fetch = mock(async () => Response.json(value)) as unknown as typeof fetch;
      const result = await stoaChangeProblemWorkspace(
        workspaceSponsor,
        workspaceProblem,
        command,
        "key",
      );
      expect(result).toEqual({ ok: false, reason: "unreachable" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_RESPONSE_CANARY");
    }
  }
});

test("a missing or untrusted origin does not route governance to an invented destination", async () => {
  const fetcher = mock(async () => Response.json({}));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  for (const origin of [undefined, "https://attacker.invalid"]) {
    if (origin === undefined) delete process.env.STOA_ORIGIN;
    else process.env.STOA_ORIGIN = origin;
    expect(
      await stoaChangeProblemWorkspace(workspaceSponsor, workspaceProblem, forkCommand, "key"),
    ).toEqual({ ok: false, reason: "unconfigured" });
  }
  expect(fetcher).not.toHaveBeenCalled();
});
