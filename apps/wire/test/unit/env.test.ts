import { describe, expect, test } from "bun:test";
import { bindingStates, isBindingHealthy, missingBindings, REQUIRED_BINDINGS } from "../../src/env";
import { boundEnv, d1Shaped, outboxShaped, r2Shaped } from "../support/bindings";

describe("binding probes", () => {
  test("a D1-shaped handle passes the DB probe", () => {
    expect(isBindingHealthy("DB", d1Shaped())).toBe(true);
  });

  test("an R2-shaped handle passes the ARTIFACTS probe", () => {
    expect(isBindingHealthy("ARTIFACTS", r2Shaped())).toBe(true);
  });

  test("an R2-shaped handle passes the PUBLIC_ARTIFACTS probe without invoking it", () => {
    // Every shim method throws; a structural health probe must not turn this
    // into an R2 operation.
    expect(() => isBindingHealthy("PUBLIC_ARTIFACTS", r2Shaped())).not.toThrow();
    expect(isBindingHealthy("PUBLIC_ARTIFACTS", r2Shaped())).toBe(true);
  });

  test("a Durable Object namespace-shaped handle passes the KRATER_OUTBOX probe", () => {
    expect(isBindingHealthy("KRATER_OUTBOX", outboxShaped())).toBe(true);
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "d1"],
    ["a number", 1],
    ["an empty object", {}],
    ["an object missing batch()", { prepare: () => undefined }],
    ["an object whose prepare is not callable", { prepare: "yes", batch: () => undefined }],
  ])("the DB probe rejects %s", (_label, value) => {
    expect(isBindingHealthy("DB", value)).toBe(false);
  });

  test("probing does not invoke the binding", () => {
    // Every shim method throws; a probe that called one would fail this test.
    expect(() => isBindingHealthy("DB", d1Shaped())).not.toThrow();
  });
});

describe("missingBindings", () => {
  test("is empty for a fully bound env", () => {
    expect(missingBindings(boundEnv())).toEqual([]);
  });

  test("lists absent bindings in declaration order", () => {
    expect(missingBindings({})).toEqual([...REQUIRED_BINDINGS]);
  });

  test("treats a non-object env as fully unbound rather than throwing", () => {
    expect(missingBindings(undefined)).toEqual([...REQUIRED_BINDINGS]);
    expect(missingBindings("env")).toEqual([...REQUIRED_BINDINGS]);
  });
});

describe("bindingStates", () => {
  test("maps every required binding to a two-state verdict", () => {
    expect(bindingStates(boundEnv({ ARTIFACTS: undefined }))).toEqual({
      DB: "bound",
      ARTIFACTS: "missing",
      PUBLIC_ARTIFACTS: "bound",
      KRATER_OUTBOX: "bound",
    });
  });

  test("keeps the private and public R2 handles distinct in a fully bound fixture", () => {
    const env = boundEnv();

    expect(env.ARTIFACTS).not.toBe(env.PUBLIC_ARTIFACTS);
  });

  test("emits keys in declaration order so serialisation is deterministic", () => {
    expect(Object.keys(bindingStates({}))).toEqual([...REQUIRED_BINDINGS]);
  });
});
