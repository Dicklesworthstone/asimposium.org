import { describe, expect, test } from "bun:test";

import { ERROR_TYPE_BASE, RenderContractError } from "../../src/errors.ts";
import { prepareProjection } from "../../src/prepare.ts";
import type { Projection } from "../../src/types.ts";
import { safeWorkingPack } from "../_support/fixtures.ts";

/**
 * Regression for the optional `rule` citation.
 *
 * Some refusals cite a doctrine rule and some are purely structural, so `rule`
 * is genuinely optional — and "absent" has to mean absent, not a `string` slot
 * holding `undefined`. Both branches are exercised here: through the error class
 * directly, and through `prepareProjection`, which is the call site that builds
 * the init object.
 */

function packWith(overrides: Partial<Projection>): Projection {
  return { ...safeWorkingPack(), ...overrides };
}

function refusalFrom(projection: Projection): RenderContractError {
  let thrown: unknown;
  try {
    prepareProjection(projection);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RenderContractError);
  return thrown as RenderContractError;
}

describe("RenderContractError with no rule cited", () => {
  const error = new RenderContractError({
    code: "UNKNOWN_FORMAT",
    title: "Unknown face format",
    detail: "format 'toon' is not rendered by this package",
    fix_hint: "Ask for md, json or html-fragment.",
  });

  test("the property is absent, not present-and-undefined", () => {
    expect("rule" in error).toBe(false);
    expect(Object.keys(error)).not.toContain("rule");
    expect(error.rule).toBeUndefined();
  });

  test("the RFC 7807 payload omits the key entirely", () => {
    const problem = error.toProblem();
    expect("rule" in problem).toBe(false);
    expect(JSON.stringify(problem)).not.toContain("rule");
  });

  test("the rest of the teaching payload is intact (Fable §7.7)", () => {
    const problem = error.toProblem();
    expect(problem.type).toBe(`${ERROR_TYPE_BASE}UNKNOWN_FORMAT`);
    expect(problem.status).toBe(422);
    expect(problem.code).toBe("UNKNOWN_FORMAT");
    expect(problem.detail.length).toBeGreaterThan(0);
    expect(problem.fix_hint.length).toBeGreaterThan(0);
  });
});

describe("RenderContractError with a rule cited", () => {
  const error = new RenderContractError({
    code: "UNTRUSTED_FLAG_MISMATCH",
    title: "Only system items may be marked trusted",
    detail: "item C-14 has scope ledger and untrusted:false",
    fix_hint: "Set untrusted:true.",
    rule: "A2",
    status: 409,
  });

  test("the property is present and carries the citation", () => {
    expect("rule" in error).toBe(true);
    expect(error.rule).toBe("A2");
  });

  test("the payload carries the citation and the caller's status", () => {
    const problem = error.toProblem();
    expect(problem.rule).toBe("A2");
    expect(problem.status).toBe(409);
    expect(JSON.stringify(problem)).toContain('"rule":"A2"');
  });
});

describe("prepareProjection builds both shapes of init", () => {
  test("a rule-citing refusal keeps the citation (MISSING_OMITTED cites A1)", () => {
    const error = refusalFrom(
      packWith({ omitted: "not an array" as unknown as Projection["omitted"] }),
    );
    expect(error.code).toBe("MISSING_OMITTED");
    expect("rule" in error).toBe(true);
    expect(error.rule).toBe("A1");
    expect(error.toProblem().rule).toBe("A1");
  });

  test("a structural refusal cites nothing, and says so by omission", () => {
    const error = refusalFrom(
      packWith({
        next_actions: [
          { method: "PUT" as unknown as "POST", url: "/v1/anything", why: "not a legal method" },
        ],
      }),
    );
    expect(error.code).toBe("INVALID_NEXT_ACTION");
    expect("rule" in error).toBe(false);
    expect(error.rule).toBeUndefined();
    const problem = error.toProblem();
    expect("rule" in problem).toBe(false);
    expect(JSON.stringify(problem)).not.toContain("rule");
  });

  test("both branches still produce the same class and a usable problem payload", () => {
    const cited = refusalFrom(
      packWith({ omitted: [] as unknown as Projection["omitted"], items: [] }),
    );
    const uncited = refusalFrom(packWith({ schema: "asimposium.pack.v1 --> injected" }));
    expect(cited.code).toBe("EMPTY_PROJECTION_WITHOUT_OMISSION");
    expect(uncited.code).toBe("INVALID_HEADER_VALUE");
    for (const error of [cited, uncited]) {
      expect(error).toBeInstanceOf(RenderContractError);
      expect(error.toProblem().type.startsWith(ERROR_TYPE_BASE)).toBe(true);
      expect(error.toProblem().fix_hint.length).toBeGreaterThan(0);
    }
    expect("rule" in cited).toBe(true);
    expect("rule" in uncited).toBe(false);
  });
});
