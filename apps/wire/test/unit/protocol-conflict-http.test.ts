import { expect, test } from "bun:test";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import { createProtocolConflictRouter } from "../../src/directives/protocol-conflict-router.ts";
import type { Env } from "../../src/env.ts";
import type { SessionRouterOptions } from "../../src/sessions/router-core.ts";
import { protocolConflictFixture, SESSION } from "./protocol-conflict-fixture.ts";

/** Transport unit coverage. Publication itself is exercised by native Workerd,
 * and service races by protocol-conflicts.test.ts. No fake success writer here. */
test("authenticated ingress rejects caller attribution, malformed bytes and oversize bodies before admission", async () => {
  const f = protocolConflictFixture();
  let authenticationReads = 0;
  const app = createProtocolConflictRouter({
    service: {
      credentialBinding: async (token: string) => {
        authenticationReads++;
        return token === "test-bearer" ? f.actor : undefined;
      },
    },
  } as unknown as SessionRouterOptions);
  const url = `https://a.asimposium.org/v1/sessions/${SESSION}/protocol-conflicts`;
  const input = f.directive();
  try {
    for (const [body, expected] of [
      [JSON.stringify({ ...input, fellow_id: "FEL-FORGED" }), 422],
      ["{broken", 400],
      ["x".repeat(16 * 1024 + 1), 413],
    ] as const) {
      const response = await app.fetch(
        new Request(url, {
          method: "POST",
          headers: {
            authorization: "Bearer test-bearer",
            "content-type": "application/json",
            "idempotency-key": "transport-case",
          },
          body,
        }),
        { DB: f.db } as Env,
      );
      expect(response.status).toBe(expected);
      const refusal = ProblemDocumentSchema.parse(await response.json());
      expect(refusal.code).toBe("SCHEMA_INVALID");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(authenticationReads).toBe(3);
    expect(
      f.sql.query("SELECT COUNT(*) AS n FROM public_write_attempt_reservations").get(),
    ).toEqual({ n: 0 });
    expect(f.sql.query("SELECT COUNT(*) AS n FROM protocol_conflicts").get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test("sponsor envelopes and invalid bearers cannot enter the Fellow refusal writer", async () => {
  const f = protocolConflictFixture();
  let authenticationReads = 0;
  const app = createProtocolConflictRouter({
    service: {
      credentialBinding: async () => {
        authenticationReads++;
        return undefined;
      },
    },
  } as unknown as SessionRouterOptions);
  const url = `https://a.asimposium.org/v1/sessions/${SESSION}/protocol-conflicts`;
  const credentials: Readonly<Record<string, string>>[] = [
    { "asimp-service-envelope": "signed-sponsor-envelope" },
    { authorization: "Bearer revoked-or-unknown" },
  ];
  try {
    for (const headers of credentials) {
      const response = await app.fetch(
        new Request(url, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "idempotency-key": "auth-case",
          },
          body: "{}",
        }),
        { DB: f.db } as Env,
      );
      expect(response.status).toBe(401);
      const refusal = ProblemDocumentSchema.parse(await response.json());
      expect(refusal.code).toBe("UNAUTHORIZED");
      expect(refusal).not.toHaveProperty("rule");
      expect(refusal).not.toHaveProperty("example");
    }
    expect(authenticationReads).toBe(1);
  } finally {
    f.close();
  }
});
