import { describe, expect, test } from "bun:test";
import {
  bindingHealthSnapshot,
  bindingStates,
  isBindingHealthy,
  missingBindings,
  REQUIRED_BINDINGS,
  type RequiredBinding,
} from "../../src/env";
import { boundEnv, d1Shaped, outboxShaped, r2Shaped } from "../support/bindings";

const healthyStructuralHandle = (binding: RequiredBinding): Record<string, unknown> => {
  switch (binding) {
    case "DB":
      return { prepare: () => undefined, batch: () => undefined };
    case "ARTIFACTS":
    case "PUBLIC_ARTIFACTS":
      return { get: () => undefined, put: () => undefined };
    case "KRATER_OUTBOX":
      return { idFromName: () => undefined, get: () => undefined };
  }
};

const throwingProperty = (
  binding: RequiredBinding,
  property: string,
  canary: string,
): Record<string, unknown> => {
  const handle = healthyStructuralHandle(binding);
  Object.defineProperty(handle, property, {
    enumerable: true,
    get: () => {
      throw new Error(canary);
    },
  });
  return handle;
};

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

  test.each([
    ["DB", "prepare"],
    ["DB", "batch"],
    ["ARTIFACTS", "get"],
    ["ARTIFACTS", "put"],
    ["PUBLIC_ARTIFACTS", "get"],
    ["PUBLIC_ARTIFACTS", "put"],
    ["KRATER_OUTBOX", "idFromName"],
    ["KRATER_OUTBOX", "get"],
  ] as const)("treats a throwing %s.%s accessor as unhealthy", (binding, property) => {
    const canary = `must-not-escape-${binding}-${property}`;
    const throwingHandle = throwingProperty(binding, property, canary);

    expect(() => isBindingHealthy(binding, throwingHandle)).not.toThrow();
    expect(isBindingHealthy(binding, throwingHandle)).toBe(false);
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

  test("treats a throwing top-level binding accessor as missing", () => {
    const canary = "must-not-escape-top-level-db";
    const env = new Proxy(boundEnv(), {
      get(target, property, receiver) {
        if (property === "DB") {
          throw new Error(canary);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => missingBindings(env)).not.toThrow();
    expect(missingBindings(env)).toEqual(["DB"]);
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

  test("keeps the full deterministic map when a top-level accessor throws", () => {
    const env = new Proxy(boundEnv(), {
      get(target, property, receiver) {
        if (property === "ARTIFACTS") {
          throw new Error("must-not-escape-binding-states");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(bindingStates(env)).toEqual({
      DB: "bound",
      ARTIFACTS: "missing",
      PUBLIC_ARTIFACTS: "bound",
      KRATER_OUTBOX: "bound",
    });
  });
});

describe("bindingHealthSnapshot", () => {
  test("reads each top-level binding once and returns one coherent verdict", () => {
    let dbReads = 0;
    const env = new Proxy(boundEnv(), {
      get(target, property, receiver) {
        if (property === "DB") {
          dbReads += 1;
          if (dbReads === 1) {
            throw new Error("must-not-escape-first-db-read");
          }
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(bindingHealthSnapshot(env)).toEqual({
      missing: ["DB"],
      bindings: {
        DB: "missing",
        ARTIFACTS: "bound",
        PUBLIC_ARTIFACTS: "bound",
        KRATER_OUTBOX: "bound",
      },
    });
    expect(dbReads).toBe(1);
  });
});
