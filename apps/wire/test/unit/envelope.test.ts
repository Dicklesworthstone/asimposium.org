import { describe, expect, test } from "bun:test";
import {
  ERROR_BASE,
  problem,
  problemEnvelope,
  success,
  successEnvelope,
  validatedProblem,
  validatedProblemEnvelope,
} from "../../src/http/envelope";

describe("success envelope", () => {
  test("has the Fable §7.7 shape with defaulted arrays", () => {
    expect(successEnvelope({ schema: "s", data: { a: 1 } })).toEqual({
      schema: "s",
      ok: true,
      data: { a: 1 },
      degraded: [],
      next_actions: [],
    });
  });

  test("serialises keys in a fixed order so bodies are byte-stable", async () => {
    const body = await success({ schema: "s", data: 1 }).text();
    expect(body).toBe('{"schema":"s","ok":true,"data":1,"degraded":[],"next_actions":[]}');
  });

  test("carries degraded[] and next_actions[] through untouched", () => {
    const envelope = successEnvelope({
      schema: "s",
      data: null,
      degraded: ["stale_projection"],
      nextActions: [{ method: "GET", url: "/internal/health", why: "recheck" }],
    });

    expect(envelope.degraded).toEqual(["stale_projection"]);
    expect(envelope.next_actions).toHaveLength(1);
  });
});

describe("problem envelope", () => {
  const base = {
    status: 422,
    code: "MISSING_FALSIFIER",
    title: "Conjecture-class claims require a falsifier",
    detail: "no falsifier",
    fixHint: "add one",
  };

  test("is RFC 7807 extended with code and fix_hint", () => {
    expect(problemEnvelope(base)).toEqual({
      type: `${ERROR_BASE}/MISSING_FALSIFIER`,
      title: base.title,
      status: 422,
      code: "MISSING_FALSIFIER",
      detail: "no falsifier",
      fix_hint: "add one",
    });
  });

  test("omits rule unless one is cited", () => {
    expect(problemEnvelope(base)).not.toHaveProperty("rule");
    expect(problemEnvelope({ ...base, rule: "P3" })).toHaveProperty("rule", "P3");
  });

  test("merges machine-readable extensions", () => {
    expect(problemEnvelope({ ...base, extensions: { allowed: ["json"] } })).toHaveProperty(
      "allowed",
      ["json"],
    );
  });

  test("is served as application/problem+json with the declared status", async () => {
    const response = problem(base);
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    expect(JSON.parse(await response.text())).toHaveProperty("code", "MISSING_FALSIFIER");
  });

  test("contracted surfaces reject transparency drift at construction", async () => {
    const input = {
      status: 401,
      code: "UNAUTHORIZED",
      title: "Authorization was not accepted",
      detail: "The request did not include an authorization accepted by this route.",
      fixHint: "Obtain a fresh sponsor authorization and retry the request.",
    } as const;
    expect(validatedProblemEnvelope(input)).toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    expect(() =>
      validatedProblemEnvelope({
        ...input,
        extensions: {
          rule: "A5",
          schema: "https://a.asimposium.org/schemas/enrollment.v1.json",
          example: {},
        },
      }),
    ).toThrow();
    expect((await validatedProblem(input).json()) as unknown).toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
