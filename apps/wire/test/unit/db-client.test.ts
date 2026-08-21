import { describe, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import { type SQL, sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { createApp } from "../../src/app";
import {
  BindingMissingError,
  createDb,
  type D1ExecutionBoundary,
  D1ExecutionError,
} from "../../src/db/client";
import type { Env } from "../../src/env";
import { boundEnv, d1Shaped, executionContext } from "../support/bindings";

const EXECUTION_SQL_CANARY = "p57s-sql-canary-8f70d3";
const EXECUTION_BOUND_CANARY = "asimp_ag_p57s_bound_canary_4fd2a9";

type StatementCalls = Readonly<{ run: number; all: number; raw: number }>;

interface D1Probe {
  readonly binding: D1Database;
  readonly preparedSql: readonly string[];
  readonly boundValues: readonly unknown[];
  readonly prepareReceiverPreserved: () => boolean;
  readonly statementCalls: () => StatementCalls;
  readonly statementReceiverChecks: () => number;
}

interface D1ProbeOptions {
  readonly failure?: { readonly value: unknown };
  readonly rows?: readonly Readonly<{ value: string }>[];
}

function d1Probe(options: D1ProbeOptions = {}): D1Probe {
  const preparedSql: string[] = [];
  const boundValues: unknown[] = [];
  let prepareReceiverPreserved = true;
  let statementReceiverChecks = 0;
  const calls = { run: 0, all: 0, raw: 0 };
  const rows = options.rows ?? [{ value: "first" }, { value: "second" }];
  const maybeFail = (): void => {
    if (options.failure !== undefined) throw options.failure.value;
  };
  const binding = {
    ...d1Shaped(),
    prepare(this: unknown, query: string) {
      prepareReceiverPreserved &&= this === binding;
      preparedSql.push(query);
      const statement = {
        bind(this: unknown, ...values: unknown[]) {
          if (this !== statement) throw new Error("D1 statement receiver was not preserved");
          statementReceiverChecks += 1;
          boundValues.push(...values);
          return statement;
        },
        async run(this: unknown): Promise<unknown> {
          if (this !== statement) throw new Error("D1 statement receiver was not preserved");
          statementReceiverChecks += 1;
          calls.run += 1;
          maybeFail();
          return { success: true, results: [], meta: {} };
        },
        async all(this: unknown): Promise<unknown> {
          if (this !== statement) throw new Error("D1 statement receiver was not preserved");
          statementReceiverChecks += 1;
          calls.all += 1;
          maybeFail();
          return { success: true, results: [...rows], meta: {} };
        },
        async raw(this: unknown): Promise<unknown> {
          if (this !== statement) throw new Error("D1 statement receiver was not preserved");
          statementReceiverChecks += 1;
          calls.raw += 1;
          maybeFail();
          return [["first"], ["second"]];
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return {
    binding,
    preparedSql,
    boundValues,
    prepareReceiverPreserved: () => prepareReceiverPreserved,
    statementCalls: () => ({ ...calls }),
    statementReceiverChecks: () => statementReceiverChecks,
  };
}

function canaryQuery(): SQL {
  return sql`select ${EXECUTION_BOUND_CANARY} as value ${sql.raw(`/* ${EXECUTION_SQL_CANARY} */`)}`;
}

/** Recursively snapshot every own data property, including Error causes and arrays. */
function reflectedOwnGraph(root: unknown): string {
  const queue: unknown[] = [root];
  const seen = new Set<object>();
  const snapshot: unknown[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || (typeof current !== "object" && typeof current !== "function")) {
      snapshot.push(current);
      continue;
    }
    if (seen.has(current)) continue;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      const own = Object.getOwnPropertyDescriptor(current, key);
      const label = typeof key === "symbol" ? `symbol:${key.description ?? ""}` : key;
      if (own === undefined || !("value" in own)) {
        snapshot.push([label, "accessor"]);
        continue;
      }
      const value = own.value as unknown;
      if (value !== null && typeof value === "object") {
        snapshot.push([label, `object:${value.constructor?.name ?? "unknown"}`]);
        queue.push(value);
      } else {
        snapshot.push([label, String(value)]);
      }
    }
  }
  return JSON.stringify(snapshot);
}

async function captureFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectOpaqueExecutionFailure(error: unknown, label: string): void {
  expect(error, label).toBeInstanceOf(D1ExecutionError);
  expect(error, label).not.toBeInstanceOf(DrizzleQueryError);
  expect((error as D1ExecutionError).code, label).toBe("D1_EXECUTION_FAILED");
  expect(Reflect.has(error as object, "cause"), label).toBe(false);
  expect(Reflect.has(error as object, "query"), label).toBe(false);
  expect(Reflect.has(error as object, "params"), label).toBe(false);
  const graph = reflectedOwnGraph(error);
  expect(graph, label).not.toContain(EXECUTION_SQL_CANARY);
  expect(graph, label).not.toContain(EXECUTION_BOUND_CANARY);
}

function typecheckRawDrizzleSurfaceIsUnavailable(candidate: D1ExecutionBoundary): void {
  // @ts-expect-error Callbacks can export the raw client and must not return.
  candidate.execute(async () => undefined);
  // @ts-expect-error D1 callback transactions are not binding-level atomic.
  candidate.transaction(async () => undefined);
  // @ts-expect-error Lazy builders can escape the redaction boundary.
  candidate.select();
  // @ts-expect-error Batch needs a separately reviewed repository-owned plan.
  candidate.batch([]);
}

/**
 * SCOPE OF THIS SUITE (read before citing it).
 *
 * These tests prove the *wiring* between the typed D1 binding and Drizzle: the
 * factory accepts a D1-shaped handle, hands back four fixed terminal operations,
 * and refuses anything else. The explicit probes execute Drizzle against a
 * deterministic D1 shape; they prove dispatch and redaction, not D1 storage.
 *
 * They therefore do NOT prove that a D1 read, write, or batch works.
 * That claim needs the integration suite and a real binding.
 */
describe("createDb", () => {
  test("returns only four frozen terminal operations over the injected D1 binding", () => {
    const boundary = createDb({ DB: d1Shaped() });

    expect(Object.keys(boundary).sort()).toEqual(["all", "get", "run", "values"]);
    expect(Reflect.has(boundary, "execute")).toBe(false);
    expect(Reflect.has(boundary, "transaction")).toBe(false);
    expect(Reflect.has(boundary, "select")).toBe(false);
    expect(Reflect.has(boundary, "batch")).toBe(false);
    expect(typecheckRawDrizzleSurfaceIsUnavailable).toBeDefined();
    expect(Object.isFrozen(boundary)).toBe(true);
  });

  test("does not touch the binding at construction time", () => {
    // Every shim method throws, so a factory that eagerly queried would blow up.
    expect(() => createDb({ DB: d1Shaped() })).not.toThrow();
  });

  test("snapshots the validated binding exactly once before creating terminal operations", async () => {
    const first = d1Probe();
    const replacement = d1Probe();
    let reads = 0;
    const env = new Proxy(
      { DB: first.binding },
      {
        get(target, property, receiver) {
          if (property === "DB") {
            reads += 1;
            return reads === 1 ? first.binding : replacement.binding;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const boundary = createDb(env);
    await boundary.run(canaryQuery());

    expect(reads).toBe(1);
    expect(first.preparedSql).toHaveLength(1);
    expect(replacement.preparedSql).toHaveLength(0);
  });

  test("turns an unreadable top-level DB accessor into a nonreflecting binding refusal", () => {
    const canary = "private-db-accessor-canary";
    const env = {} as { DB: ReturnType<typeof d1Shaped> };
    Object.defineProperty(env, "DB", {
      enumerable: true,
      get: () => {
        throw new Error(canary);
      },
    });

    let thrown: unknown;
    try {
      createDb(env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BindingMissingError);
    expect((thrown as BindingMissingError).code).toBe("BINDING_MISSING");
    expect((thrown as BindingMissingError).bindings).toEqual(["DB"]);
    expect((thrown as Error).message).not.toContain(canary);
  });

  // PLANTED NEGATIVE — a bad binding must fail closed at the seam, with the
  // same stable code the HTTP face reports, not deep inside a later write.
  test.each([
    ["absent", undefined],
    ["null", null],
    ["a bare object", {}],
    ["a string", "DB"],
    ["half-shaped (prepare without batch)", { prepare: () => undefined }],
  ])("throws BindingMissingError when DB is %s", (_label, binding) => {
    let thrown: unknown;
    try {
      createDb({ DB: binding } as Parameters<typeof createDb>[0]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BindingMissingError);
    expect((thrown as BindingMissingError).code).toBe("BINDING_MISSING");
    expect((thrown as BindingMissingError).bindings).toEqual(["DB"]);
  });

  test("the failure message names the binding and carries no value", () => {
    const secretish = { prepare: "asimp_ag_deadbeefdeadbeef" };
    let message = "";
    try {
      createDb({ DB: secretish } as unknown as Parameters<typeof createDb>[0]);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("DB");
    expect(message).not.toContain("asimp_ag_");
  });

  test("BindingMissingError owns an immutable snapshot of its binding names", () => {
    const source = ["DB"];
    const error = new BindingMissingError(source);
    source[0] = "ASIMP_AG_SECRET";
    source.push("ARTIFACTS");

    expect(error.bindings).toEqual(["DB"]);
    expect(Object.isFrozen(error.bindings)).toBe(true);
    expect(error.message).toBe("required Worker bindings are not configured: DB");
  });

  test("PLANTED: the graph scanner detects Drizzle 0.45.2 SQL and parameter reflection", () => {
    const raw = new DrizzleQueryError(
      `select 1 /* ${EXECUTION_SQL_CANARY} */`,
      [EXECUTION_BOUND_CANARY],
      new Error("synthetic D1 dependency failure"),
    );
    const graph = reflectedOwnGraph(raw);

    expect(graph).toContain(EXECUTION_SQL_CANARY);
    expect(graph).toContain(EXECUTION_BOUND_CANARY);
    expect(Reflect.has(raw, "query")).toBe(true);
    expect(Reflect.has(raw, "params")).toBe(true);
    expect(Reflect.has(raw, "cause")).toBe(true);
  });

  test("run/all/get/values dispatch to their exact D1 statement methods", async () => {
    const operations = [
      {
        label: "run",
        invoke: (boundary: D1ExecutionBoundary, query: SQL) => boundary.run(query),
        expectedCalls: { run: 1, all: 0, raw: 0 },
        expectedResult: { success: true, results: [], meta: {} },
      },
      {
        label: "all",
        invoke: (boundary: D1ExecutionBoundary, query: SQL) =>
          boundary.all<{ value: string }>(query),
        expectedCalls: { run: 0, all: 1, raw: 0 },
        expectedResult: [{ value: "first" }, { value: "second" }],
      },
      {
        label: "get",
        invoke: (boundary: D1ExecutionBoundary, query: SQL) =>
          boundary.get<{ value: string }>(query),
        expectedCalls: { run: 0, all: 1, raw: 0 },
        expectedResult: { value: "first" },
      },
      {
        label: "values",
        invoke: (boundary: D1ExecutionBoundary, query: SQL) => boundary.values<string[]>(query),
        expectedCalls: { run: 0, all: 0, raw: 1 },
        expectedResult: [["first"], ["second"]],
      },
    ] as const;

    for (const operation of operations) {
      const probe = d1Probe();
      const boundary = createDb({ DB: probe.binding });
      const result = await operation.invoke(boundary, canaryQuery());

      expect(probe.prepareReceiverPreserved(), operation.label).toBe(true);
      expect(probe.statementReceiverChecks(), operation.label).toBe(2);
      expect(probe.statementCalls(), operation.label).toEqual(operation.expectedCalls);
      expect(probe.preparedSql.join("\n"), operation.label).toContain(EXECUTION_SQL_CANARY);
      expect(probe.boundValues, operation.label).toContain(EXECUTION_BOUND_CANARY);
      expect(result, operation.label).toEqual(operation.expectedResult);
    }
  });

  test("get exposes an empty D1 result as undefined", async () => {
    const probe = d1Probe({ rows: [] });
    const result = await createDb({ DB: probe.binding }).get<{ value: string }>(canaryQuery());

    expect(result).toBeUndefined();
    expect(probe.statementCalls()).toEqual({ run: 0, all: 1, raw: 0 });
    expect(probe.statementReceiverChecks()).toBe(2);
  });

  test("run/all/get/values failures cross as fresh frozen nonreflecting errors", async () => {
    const forged = Object.assign(Object.create(D1ExecutionError.prototype) as object, {
      name: "D1ExecutionError",
      message: `forged ${EXECUTION_SQL_CANARY}`,
      code: "D1_EXECUTION_FAILED",
      query: EXECUTION_SQL_CANARY,
      params: [EXECUTION_BOUND_CANARY],
      cause: new Error(EXECUTION_BOUND_CANARY),
    });
    const operations = [
      ["run", (boundary: D1ExecutionBoundary, query: SQL) => boundary.run(query)],
      ["all", (boundary: D1ExecutionBoundary, query: SQL) => boundary.all(query)],
      ["get", (boundary: D1ExecutionBoundary, query: SQL) => boundary.get(query)],
      ["values", (boundary: D1ExecutionBoundary, query: SQL) => boundary.values(query)],
    ] as const;

    const thrownErrors: unknown[] = [];
    for (const [label, operation] of operations) {
      const probe = d1Probe({ failure: { value: forged } });
      const boundary = createDb({ DB: probe.binding });
      const thrown = await captureFailure(() => operation(boundary, canaryQuery()));
      thrownErrors.push(thrown);

      expect(thrown, label).not.toBe(forged);
      expect(Object.isFrozen(thrown), label).toBe(true);
      expect(probe.prepareReceiverPreserved(), label).toBe(true);
      expect(probe.statementReceiverChecks(), label).toBe(2);
      expect(probe.preparedSql.join("\n"), label).toContain(EXECUTION_SQL_CANARY);
      expect(probe.boundValues, label).toContain(EXECUTION_BOUND_CANARY);
      expectOpaqueExecutionFailure(thrown, label);
    }
    expect(new Set(thrownErrors).size).toBe(operations.length);

    const representative = thrownErrors[0] as object;
    expect(Object.getPrototypeOf(representative)).toBe(D1ExecutionError.prototype);
    expect(Object.getOwnPropertyNames(representative).sort()).toEqual(["code", "message", "name"]);
    expect(Object.getOwnPropertySymbols(representative)).toEqual([]);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(representative))) {
      expect("value" in descriptor).toBe(true);
      expect(typeof descriptor.value).not.toBe("function");
      expect(descriptor.configurable).toBe(false);
      expect(descriptor.writable).toBe(false);
    }
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["string", EXECUTION_BOUND_CANARY],
    ["number", 17],
    ["symbol", Symbol("dependency-failure")],
  ])("redacts a primitive %s thrown by D1", async (_label, failure) => {
    const probe = d1Probe({ failure: { value: failure } });
    const thrown = await captureFailure(() => createDb({ DB: probe.binding }).run(canaryQuery()));

    expectOpaqueExecutionFailure(thrown, String(_label));
    expect(Object.isFrozen(thrown)).toBe(true);
  });

  test("terminal methods preserve their internal database receiver when detached", async () => {
    const probe = d1Probe();
    const { run, all, get, values } = createDb({ DB: probe.binding });

    await run(canaryQuery());
    await all(canaryQuery());
    await get(canaryQuery());
    await values(canaryQuery());

    expect(probe.prepareReceiverPreserved()).toBe(true);
    expect(probe.statementCalls()).toEqual({ run: 1, all: 2, raw: 1 });
    expect(probe.statementReceiverChecks()).toBe(8);
  });

  test("mounted HTTP face and diagnostic breadcrumb cannot reflect the query error", async () => {
    const probe = d1Probe({ failure: { value: new Error("synthetic D1 dependency failure") } });
    const boundary = createDb({ DB: probe.binding });
    const app = createApp();
    app.get("/test-only/d1-failure", async (c) => {
      await boundary.get(canaryQuery());
      return c.text("unreachable");
    });
    const originalConsoleError = console.error;
    const logged: unknown[][] = [];
    console.error = (...values: unknown[]) => {
      logged.push(values);
    };
    const response = await (async () => {
      try {
        return await app.fetch(
          new Request("https://a.asimposium.org/test-only/d1-failure"),
          boundEnv({ DB: probe.binding }) as Env,
          executionContext() as unknown as Parameters<typeof app.fetch>[2],
        );
      } finally {
        console.error = originalConsoleError;
      }
    })();
    const body = await response.text();
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      throw new Error("mounted D1 failure route returned a non-JSON error face");
    }

    expect(response.status).toBe(500);
    expect(parsedBody).toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
    expect(logged).toEqual([
      ["[wire] unhandled error", { path: "/test-only/d1-failure", error: "unhandled" }],
    ]);
    for (const surface of [body, reflectedOwnGraph(logged)]) {
      expect(surface).not.toContain(EXECUTION_SQL_CANARY);
      expect(surface).not.toContain(EXECUTION_BOUND_CANARY);
    }
    expect(probe.preparedSql.join("\n")).toContain(EXECUTION_SQL_CANARY);
    expect(probe.boundValues).toContain(EXECUTION_BOUND_CANARY);
  });
});
