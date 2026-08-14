import { describe, expect, test } from "bun:test";
import { BindingMissingError, createDb } from "../../src/db/client";
import { d1Shaped } from "../support/bindings";

/**
 * SCOPE OF THIS SUITE (read before citing it).
 *
 * These tests prove the *wiring* between the typed D1 binding and Drizzle: the
 * factory accepts a D1-shaped handle, hands back a query builder, and refuses
 * anything else. They execute no SQL and open no transaction, because the shim
 * has no database behind it.
 *
 * They therefore do NOT prove that a D1 read, write, or transaction works.
 * That claim needs the integration suite and a real binding.
 */
describe("createDb", () => {
  test("returns a Drizzle query builder over an injected D1 binding", () => {
    const db = createDb({ DB: d1Shaped() });

    expect(typeof db.select).toBe("function");
    expect(typeof db.insert).toBe("function");
    expect(typeof db.update).toBe("function");
    expect(typeof db.delete).toBe("function");
    expect(typeof db.batch).toBe("function");
  });

  test("does not touch the binding at construction time", () => {
    // Every shim method throws, so a factory that eagerly queried would blow up.
    expect(() => createDb({ DB: d1Shaped() })).not.toThrow();
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
});
