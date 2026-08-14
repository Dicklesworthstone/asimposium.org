import { expect, test } from "bun:test";

import { type DiagnosticCode, REPRODUCE, safeDiagnostic } from "../../src/diagnostics.ts";
import { ContractScaffoldSchema } from "../../src/schema.ts";

const VALID_FIXTURE = new URL("../fixtures/valid/contracts-scaffold.json", import.meta.url);
const INVALID_FIXTURE = new URL(
  "../fixtures/invalid/contracts-scaffold-stale.json",
  import.meta.url,
);

function failureDiagnostic(suite: string, startedAt: number, code: DiagnosticCode): string {
  return safeDiagnostic({
    suite,
    status: "invalid",
    startedAt,
    code,
    reproduce: REPRODUCE.unit,
  });
}

async function readFixture(url: URL, suite: string): Promise<unknown> {
  const startedAt = performance.now();
  try {
    return JSON.parse(await Bun.file(url).text()) as unknown;
  } catch {
    throw new Error(failureDiagnostic(suite, startedAt, "FIXTURE_JSON_INVALID"));
  }
}

test("valid scaffold fixture parses through the Zod source of truth", async () => {
  const startedAt = performance.now();
  const parsed = ContractScaffoldSchema.safeParse(
    await readFixture(VALID_FIXTURE, "schema.valid-fixture"),
  );

  if (!parsed.success) {
    throw new Error(failureDiagnostic("schema.valid-fixture", startedAt, "VALID_FIXTURE_REJECTED"));
  }

  expect(parsed.data.scope).toBe("non-product");
});

test("planted stale fixture is rejected by literal and strict-object checks", async () => {
  const startedAt = performance.now();
  const parsed = ContractScaffoldSchema.safeParse(
    await readFixture(INVALID_FIXTURE, "schema.stale-fixture"),
  );

  if (parsed.success) {
    throw new Error(failureDiagnostic("schema.stale-fixture", startedAt, "STALE_FIXTURE_ACCEPTED"));
  }

  expect(parsed.error.issues.some((issue) => issue.path[0] === "schema")).toBeTrue();
  expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBeTrue();
});
