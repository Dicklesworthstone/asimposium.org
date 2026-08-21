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

  test("preserves safe response headers without weakening the canonical media type", () => {
    const response = success({
      schema: "s",
      data: null,
      headers: { "cache-control": "no-store", "x-safe-extension": "present" },
    });

    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-safe-extension")).toBe("present");
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
    const first = problemEnvelope({
      ...base,
      extensions: { schema: "https://a.asimposium.org/schemas/problem.v1.json", allowed: ["json"] },
    });
    const second = problemEnvelope({
      ...base,
      extensions: { allowed: ["json"], schema: "https://a.asimposium.org/schemas/problem.v1.json" },
    });
    expect(first).toHaveProperty("allowed", ["json"]);
    expect(JSON.stringify(first)).toBe(
      '{"type":"https://asimposium.org/errors/MISSING_FALSIFIER","title":"Conjecture-class claims require a falsifier","status":422,"code":"MISSING_FALSIFIER","detail":"no falsifier","fix_hint":"add one","allowed":["json"],"schema":"https://a.asimposium.org/schemas/problem.v1.json"}',
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("refuses extensions that could replace authority or mutate object identity", () => {
    const reserved = [
      "type",
      "title",
      "status",
      "code",
      "detail",
      "fix_hint",
      "rule",
      "__proto__",
      "constructor",
      "prototype",
      "toJSON",
    ] as const;

    for (const key of reserved) {
      const extensions = Object.create(null) as Record<string, unknown>;
      extensions.safe_before_reserved = "must-not-produce-a-partial-envelope";
      extensions[key] = key === "status" ? 200 : "forged";
      expect(() => problemEnvelope({ ...base, extensions }), key).toThrow(
        "Problem extensions must not replace reserved fields.",
      );
      expect(() => problem({ ...base, extensions }), key).toThrow(
        "Problem extensions must not replace reserved fields.",
      );
    }

    expect(() =>
      validatedProblem({
        status: 401,
        code: "UNAUTHORIZED",
        title: "Authorization was not accepted",
        detail: "The request did not include an authorization accepted by this route.",
        fixHint: "Obtain a fresh sponsor authorization and retry the request.",
        extensions: { code: "forged" },
      }),
    ).toThrow("Problem extensions must not replace reserved fields.");
  });

  test("refuses callable toJSON before reading any extension value", () => {
    const extensions = Object.create(null) as Record<string, unknown>;
    let safeGetterReads = 0;
    Object.defineProperty(extensions, "safe_before_reserved", {
      enumerable: true,
      get: () => {
        safeGetterReads += 1;
        return "must-not-be-read";
      },
    });
    extensions.toJSON = () => ({
      status: 200,
      code: "FORGED",
      detail: "serializer authority was replaced",
    });

    expect(() => problemEnvelope({ ...base, extensions })).toThrow(
      "Problem extensions must not replace reserved fields.",
    );
    expect(() => problem({ ...base, extensions })).toThrow(
      "Problem extensions must not replace reserved fields.",
    );
    expect(safeGetterReads).toBe(0);
  });

  test("is served as application/problem+json with the declared status", async () => {
    const response = problem({ ...base, headers: { "www-authenticate": "Bearer" } });
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toHaveProperty("code", "MISSING_FALSIFIER");
  });

  test("refuses every case variant of a caller-supplied content type", () => {
    const validated = {
      status: 401,
      code: "UNAUTHORIZED",
      title: "Authorization was not accepted",
      detail: "The request did not include an authorization accepted by this route.",
      fixHint: "Obtain a fresh sponsor authorization and retry the request.",
    } as const;
    const collisionMessage = "Response headers must not replace the canonical content type.";

    for (const name of ["content-type", "Content-Type", "CONTENT-TYPE"]) {
      const headers = { [name]: "text/plain" };
      expect(() => success({ schema: "s", data: null, headers }), `success ${name}`).toThrow(
        collisionMessage,
      );
      expect(() => problem({ ...base, headers }), `problem ${name}`).toThrow(collisionMessage);
      expect(() => validatedProblem({ ...validated, headers }), `validated ${name}`).toThrow(
        collisionMessage,
      );
    }
  });

  test("refuses a content-type collision before reading any header value", () => {
    const headers = Object.create(null) as Record<string, string>;
    let safeGetterReads = 0;
    Object.defineProperty(headers, "x-safe-before-collision", {
      enumerable: true,
      get: () => {
        safeGetterReads += 1;
        return "must-not-be-read";
      },
    });
    headers["Content-Type"] = "text/plain";

    expect(() => success({ schema: "s", data: null, headers })).toThrow(
      "Response headers must not replace the canonical content type.",
    );
    expect(() => problem({ ...base, headers })).toThrow(
      "Response headers must not replace the canonical content type.",
    );
    expect(safeGetterReads).toBe(0);
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
