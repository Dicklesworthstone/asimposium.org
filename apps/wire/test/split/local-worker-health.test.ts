import { describe, expect, test } from "bun:test";

import { localHarnessPublicReadinessNonce } from "../../src/split/local-worker.ts";

const AUTHORITY = "a".repeat(64);
const READINESS = `s3-ready-${"b".repeat(32)}`;

describe("the local Workerd readiness face never becomes authority", () => {
  test("returns only a separately shaped public nonce for a usable harness", () => {
    expect(
      localHarnessPublicReadinessNonce({
        S3_RUN_TOKEN: AUTHORITY,
        S3_READINESS_NONCE: READINESS,
      }),
    ).toBe(READINESS);
  });

  test("fails closed for absent, malformed, or authority-shaped bindings", () => {
    const invalidBindings = [
      {},
      { S3_RUN_TOKEN: AUTHORITY },
      { S3_READINESS_NONCE: READINESS },
      { S3_RUN_TOKEN: "short", S3_READINESS_NONCE: READINESS },
      { S3_RUN_TOKEN: AUTHORITY, S3_READINESS_NONCE: "s3-ready-short" },
      { S3_RUN_TOKEN: AUTHORITY, S3_READINESS_NONCE: AUTHORITY },
    ] as const;

    for (const bindings of invalidBindings) {
      expect(localHarnessPublicReadinessNonce(bindings)).toBeUndefined();
    }
  });
});
