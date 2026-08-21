import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OperatorFellowCapAuditPageResponseSchema,
  OperatorFellowCapOverrideResponseSchema,
  PRODUCTION_STOA_ORIGIN,
  STAGING_AGORA_ORIGIN,
  STAGING_STOA_ORIGIN,
  stoaHelloUrl,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";

import { mintServiceEnvelope, serviceEnvelopeHeaders } from "../../../web/lib/service-envelope.ts";
import { createApp } from "../../src/app.ts";
import { toHex } from "../../src/auth/canonical.ts";
import { KeyringConfigError } from "../../src/auth/keyring.ts";
import {
  enrollmentCapsuleMarkdown,
  enrollmentCapsuleProjection,
} from "../../src/enrollment/capsule.ts";
import { EnrollmentService } from "../../src/enrollment/service.ts";

/**
 * The Stoa origin is a binding, never a request.
 *
 * Every enrollment URL this Worker emits — join URL, `hello_url`, capsule
 * instructions, `next_actions` — points an agent or a sponsor somewhere. If any
 * of them could be derived from `Host`, `X-Forwarded-Host`, or the request URL,
 * an attacker who can set a header would have a credential redirector: a join
 * URL that carries a real secret to a host of their choosing. These tests
 * assert the hostile inputs are inert, not merely unused.
 */

const LOOPBACK = "http://127.0.0.1:8787";
const OPERATOR_AUTH_UNAVAILABLE_FIXTURE = new URL(
  "../../../../packages/contracts/test/fixtures/valid/problem-operator-auth-unavailable.json",
  import.meta.url,
);

async function fixture(url: URL): Promise<unknown> {
  return JSON.parse(await Bun.file(url).text()) as unknown;
}

/**
 * `HeadersInit` is a DOM lib type and the Worker tsconfig has no DOM. Derive
 * the same shape from the runtime's own `Headers` constructor so the header
 * literals below stay fully checked rather than widened to `any`.
 */
type TestHeaders = NonNullable<ConstructorParameters<typeof Headers>[0]>;

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as never;

function envWith(stoaOrigin: unknown): never {
  return { STOA_ORIGIN: stoaOrigin, AGORA_ORIGIN: STAGING_AGORA_ORIGIN } as never;
}

async function capabilities(stoaOrigin: unknown, requestUrl: string, headers: TestHeaders = {}) {
  const app = createApp();
  const response = await app.fetch(new Request(requestUrl, { headers }), envWith(stoaOrigin), ctx);
  return { status: response.status, text: await response.text() };
}

describe("capabilities origin comes from the binding", () => {
  test.each([PRODUCTION_STOA_ORIGIN, STAGING_STOA_ORIGIN, LOOPBACK])(
    "%s is reported as the live origin",
    async (origin) => {
      const result = await capabilities(origin, "https://a.asimposium.org/capabilities");
      expect(result.status).toBe(200);
      expect(JSON.parse(result.text).origin).toBe(origin);
    },
  );

  test("schema and error-document ids stay canonical while the origin follows the binding", async () => {
    const result = await capabilities(STAGING_STOA_ORIGIN, "https://a.asimposium.org/capabilities");
    const body = JSON.parse(result.text);
    expect(body.origin).toBe(STAGING_STOA_ORIGIN);
    // A stable identifier is not a destination: it must not drift per environment.
    expect(body.error_dictionary).toBe("https://a.asimposium.org/schemas/problem.v1.json");
  });

  test.each([
    ["absent", undefined],
    ["empty", ""],
    ["an untrusted origin", "https://evil.test"],
    ["a lookalike host", "https://a.asimposium.org.evil.test"],
    ["plaintext production", "http://a.asimposium.org"],
    ["a non-string", 8787],
  ])("PLANTED: %s binding fails closed rather than defaulting", async (_label, origin) => {
    const result = await capabilities(origin, "https://a.asimposium.org/capabilities");
    expect(result.status).toBe(503);
    // The refusal names no binding value and leaks no canonical fallback.
    expect(result.text).not.toContain(PRODUCTION_STOA_ORIGIN);
  });
});

describe("hostile request inputs cannot move the origin", () => {
  test.each([
    ["a hostile request URL", "https://evil.test/capabilities", {}],
    ["a hostile Host header", "https://a.asimposium.org/capabilities", { host: "evil.test" }],
    [
      "a hostile X-Forwarded-Host",
      "https://a.asimposium.org/capabilities",
      { "x-forwarded-host": "evil.test" },
    ],
    [
      "a hostile Forwarded header",
      "https://a.asimposium.org/capabilities",
      { forwarded: "host=evil.test;proto=https" },
    ],
    [
      "a hostile X-Forwarded-Proto",
      "http://127.0.0.1:8787/capabilities",
      { "x-forwarded-proto": "https", "x-forwarded-host": "a.asimposium.org" },
    ],
  ])("PLANTED: %s leaves the reported origin unchanged", async (_label, url, headers) => {
    const result = await capabilities(STAGING_STOA_ORIGIN, url, headers as TestHeaders);
    expect(result.status).toBe(200);
    const body = JSON.parse(result.text);
    expect(body.origin).toBe(STAGING_STOA_ORIGIN);
    expect(result.text).not.toContain("evil.test");
  });
});

describe("the service origin is immutable and required", () => {
  const replayProtector = {
    seal: async () => ({ ciphertext: "c", initializationVector: "iv" }),
    open: async () => "{}",
  };

  test.each([PRODUCTION_STOA_ORIGIN, STAGING_STOA_ORIGIN, LOOPBACK])(
    "%s is retained verbatim",
    (origin) => {
      const service = new EnrollmentService({
        stoaOrigin: origin,
        agoraOrigin: STAGING_AGORA_ORIGIN,
        replayProtector,
      } as never);
      expect(service.stoaOrigin).toBe(origin);
    },
  );

  test.each([
    ["an untrusted origin", "https://evil.test"],
    ["an empty origin", ""],
    ["a request-shaped origin with a path", "https://a.asimposium.org/v1"],
  ])("PLANTED: %s is refused at construction", (_label, origin) => {
    expect(() => new EnrollmentService({ stoaOrigin: origin, replayProtector } as never)).toThrow();
  });

  test("PLANTED: an omitted origin cannot silently become production", () => {
    // The option is required, so this is a type error as well as a throw. The
    // runtime assertion is what protects a JavaScript caller.
    expect(() => new EnrollmentService({ replayProtector } as never)).toThrow();
  });
});

describe("capsule executable URLs follow the configured origin", () => {
  const capsule = {
    enrollmentId: "ASIMP-EN-01JXYZ4K6Q",
    secretExpiresAt: 1_786_000_000,
  } as never;

  test.each([PRODUCTION_STOA_ORIGIN, STAGING_STOA_ORIGIN, LOOPBACK])(
    "%s appears in the post-approval instruction",
    (origin) => {
      const projection = enrollmentCapsuleProjection(capsule, origin);
      const actions = JSON.stringify(projection.guidance.post_approval_actions);
      expect(actions).toContain(stoaHelloUrl(origin));
      if (origin !== PRODUCTION_STOA_ORIGIN) {
        // A staging capsule that told an agent to call production would send a
        // staging credential to the wrong plane.
        expect(actions).not.toContain(`GET ${stoaHelloUrl(PRODUCTION_STOA_ORIGIN)}`);
      }
    },
  );

  test.each([PRODUCTION_STOA_ORIGIN, STAGING_STOA_ORIGIN, LOOPBACK])(
    "%s is carried on the JSON face as a validated field",
    (origin) => {
      expect(enrollmentCapsuleProjection(capsule, origin).origin).toBe(origin);
    },
  );

  test("PLANTED: an untrusted origin cannot construct a projection, so no face can render it", () => {
    // The schema parses the origin, so the refusal happens before Markdown,
    // JSON, or HTML exists — there is no face left to leak a bad endpoint.
    expect(() => enrollmentCapsuleProjection(capsule, "https://evil.test")).toThrow();
    expect(() =>
      enrollmentCapsuleProjection(capsule, "https://a.asimposium.org.evil.test"),
    ).toThrow();
  });
});

/**
 * The Markdown capsule is executed, not just read.
 *
 * A cold agent copy-pastes these two curl commands: the first carries the
 * enrollment secret in its body, the second the flow handle. Hardcoding the
 * production endpoint meant a staging or loopback capsule handed an agent a
 * command that posted a live credential to the wrong plane, while every other
 * signal on the page said staging. These assertions fail against that code.
 */
describe("executable capsule Markdown is rendered at the configured origin", () => {
  const capsule = {
    enrollmentId: "ASIMP-EN-01JXYZ4K6Q",
    secretExpiresAt: 1_786_000_000,
  } as never;

  const markdownFor = (origin: string): string =>
    enrollmentCapsuleMarkdown(enrollmentCapsuleProjection(capsule, origin));

  test.each([PRODUCTION_STOA_ORIGIN, STAGING_STOA_ORIGIN, LOOPBACK])(
    "%s renders both POST commands against itself",
    (origin) => {
      const markdown = markdownFor(origin);
      expect(markdown).toContain(`curl -sS -X POST ${origin}/v1/fellows \\`);
      expect(markdown).toContain(`curl -sS -X POST ${origin}/v1/fellows/flow \\`);
    },
  );

  test.each([STAGING_STOA_ORIGIN, LOOPBACK])(
    "PLANTED: a %s capsule names no production endpoint anywhere in its Markdown",
    (origin) => {
      expect(markdownFor(origin)).not.toContain(PRODUCTION_STOA_ORIGIN);
    },
  );

  test("the absence assertion is not vacuous: a production capsule does name production", () => {
    const markdown = markdownFor(PRODUCTION_STOA_ORIGIN);
    expect(markdown).toContain(`curl -sS -X POST ${PRODUCTION_STOA_ORIGIN}/v1/fellows \\`);
    expect(markdown).toContain(PRODUCTION_STOA_ORIGIN);
  });

  test.each([PRODUCTION_STOA_ORIGIN, STAGING_STOA_ORIGIN, LOOPBACK])(
    "%s: every absolute URL in the Markdown belongs to the configured origin",
    (origin) => {
      // A sweep rather than a fixed list, so a future hardcoded endpoint fails
      // here even if nobody remembers to add a case for it.
      const urls = markdownFor(origin).match(/https?:\/\/[^\s"'`)\\]+/g) ?? [];
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(url.startsWith(`${origin}/`)).toBe(true);
      }
    },
  );

  test("the rendered endpoints follow the contract's own declared paths", () => {
    // Prose drifting from the JSON face is the same defect class as the
    // hardcoded origin, so the curl block is derived from the projection.
    const projection = enrollmentCapsuleProjection(capsule, STAGING_STOA_ORIGIN);
    const markdown = enrollmentCapsuleMarkdown(projection);
    expect(markdown).toContain(`${projection.origin}${projection.claim.path}`);
    expect(markdown).toContain(`${projection.origin}${projection.guidance.flow_poll.path}`);
  });
});

/**
 * The isolate cache must not outlive an origin change.
 *
 * `createApp` builds the Propylon stack once per isolate and caches it against
 * the D1 handle plus a credential tuple. The stack closes over an immutable
 * origin, so if that tuple ignored the origin, a rebind would keep serving URLs
 * built for the previous environment while every binding claimed otherwise —
 * the failure would be invisible until a live credential arrived on the wrong
 * plane. This exercises a real enrollment surface rather than `/capabilities`,
 * because the capsule is the document an agent actually executes.
 *
 * PLANT: delete `stoaOrigin` from `credentialKey` in `src/app.ts` and the
 * second fetch below replays the first origin, failing this test.
 */
describe("the isolate cache is keyed on the Stoa origin", () => {
  const MIGRATIONS = ["0002_enrollment_g0.sql", "0009_device_flow.sql"];
  const ENROLLMENT_ID = "ASIMP-EN-01JXYZ4K6Q";
  const REPLAY_KEY = "a".repeat(43);

  /**
   * Real SQLite running the real migrations, wrapped in D1's method shape. The
   * SQL is not simulated; only the binding surface is adapted. Nothing here is
   * evidence that deployed D1 behaves this way, and no such claim is made.
   */
  function seededDatabase(): D1Database {
    const sqlite = new Database(":memory:", { strict: true });
    for (const migration of MIGRATIONS) {
      sqlite.exec(
        readFileSync(resolve(import.meta.dir, "../../../../db/migrations", migration), "utf8"),
      );
    }
    const createdAt = Date.now();
    sqlite
      .prepare(
        `INSERT INTO enrollment_records (enrollment_id, sponsor_id, secret_hash,
           secret_expires_at, requested_scopes_json, requested_resources_json,
           invalidated, secret_consumed_at, created_at, kind)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, 'join-url')`,
      )
      .run(
        ENROLLMENT_ID,
        "usr_origincache",
        "a".repeat(64),
        createdAt + 15 * 60 * 1_000,
        JSON.stringify(["promote"]),
        JSON.stringify({}),
        createdAt,
      );
    const prepare = (query: string) => ({
      bind(...values: (string | number | null)[]) {
        return {
          async run() {
            const statement = sqlite.prepare(query);
            if (/^\s*SELECT\b/i.test(query)) {
              return { results: statement.all(...values), meta: { changes: 0 } };
            }
            return { results: [], meta: { changes: statement.run(...values).changes } };
          },
          async first<T>(): Promise<T | null> {
            return (sqlite.prepare(query).get(...values) ?? null) as T | null;
          },
          async all<T>(): Promise<{ results: T[] }> {
            return { results: sqlite.prepare(query).all(...values) as T[] };
          },
        };
      },
    });
    return {
      prepare,
      async batch(statements: readonly { run(): Promise<unknown> }[]) {
        sqlite.run("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sqlite.run("COMMIT");
          return results;
        } catch (error) {
          sqlite.run("ROLLBACK");
          throw error;
        }
      },
    } as unknown as D1Database;
  }

  async function capsuleMarkdown(
    app: ReturnType<typeof createApp>,
    db: D1Database,
    origin: string,
  ) {
    const response = await app.fetch(
      new Request(`https://a.asimposium.org/join/${ENROLLMENT_ID}`, {
        headers: { accept: "text/markdown" },
      }),
      {
        DB: db,
        ENROLLMENT_REPLAY_KEY: REPLAY_KEY,
        STOA_ORIGIN: origin,
        AGORA_ORIGIN: STAGING_AGORA_ORIGIN,
      } as never,
      ctx,
    );
    return { status: response.status, text: await response.text() };
  }

  test("rebinding the origin on one app and one database changes the emitted capsule URLs", async () => {
    // One app instance and one D1 handle for both requests: the only thing that
    // differs is STOA_ORIGIN, so a cache hit here is a cache bug.
    const app = createApp();
    const db = seededDatabase();

    const staging = await capsuleMarkdown(app, db, STAGING_STOA_ORIGIN);
    expect(staging.status).toBe(200);
    expect(staging.text).toContain(`curl -sS -X POST ${STAGING_STOA_ORIGIN}/v1/fellows \\`);

    const loopback = await capsuleMarkdown(app, db, LOOPBACK);
    expect(loopback.status).toBe(200);
    expect(loopback.text).toContain(`curl -sS -X POST ${LOOPBACK}/v1/fellows \\`);
    // The load-bearing assertion: no residue of the origin the stack was first
    // built for, in the executable command or the post-approval hello URL.
    expect(loopback.text).not.toContain(STAGING_STOA_ORIGIN);
    expect(loopback.text).toContain(stoaHelloUrl(LOOPBACK));

    // And back again, so the proof is not an artifact of one ordering.
    const backToStaging = await capsuleMarkdown(app, db, STAGING_STOA_ORIGIN);
    expect(backToStaging.text).toContain(`curl -sS -X POST ${STAGING_STOA_ORIGIN}/v1/fellows \\`);
    expect(backToStaging.text).not.toContain(LOOPBACK);

    // The whole document is parameterized by the origin and by nothing else:
    // substituting one origin for the other reproduces the other response byte
    // for byte. A stale cached stack cannot satisfy this, and neither can a
    // capsule that still carries a hardcoded endpoint somewhere in its prose.
    expect(loopback.text).toBe(staging.text.replaceAll(STAGING_STOA_ORIGIN, LOOPBACK));
    expect(backToStaging.text).toBe(staging.text);
  });
});

describe("operator Fellow-cap ingress is separately authenticated and allowlisted", () => {
  const REPLAY_KEY = "b".repeat(43);
  const SPONSOR_ID = "usr_operator_cap_target";
  const OPERATOR_ID = "usr_operator_cap_actor";

  function latestD1(): { readonly db: D1Database; readonly sqlite: Database } {
    const sqlite = new Database(":memory:", { strict: true });
    for (const migration of readdirSync(resolve(import.meta.dir, "../../../../db/migrations"))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort()) {
      sqlite.exec(
        readFileSync(resolve(import.meta.dir, "../../../../db/migrations", migration), "utf8"),
      );
    }
    const prepare = (query: string) => ({
      bind(...values: (string | number | null)[]) {
        return {
          async run() {
            const statement = sqlite.prepare(query);
            if (/^\s*SELECT\b/i.test(query)) {
              return { results: statement.all(...values), meta: { changes: 0 } };
            }
            return { results: [], meta: { changes: statement.run(...values).changes } };
          },
          async first<T>(): Promise<T | null> {
            return (sqlite.prepare(query).get(...values) ?? null) as T | null;
          },
          async all<T>(): Promise<{ results: T[] }> {
            return { results: sqlite.prepare(query).all(...values) as T[] };
          },
        };
      },
    });
    return {
      sqlite,
      db: {
        prepare,
        async batch(statements: readonly { run(): Promise<unknown> }[]) {
          sqlite.run("BEGIN");
          try {
            const results = [];
            for (const statement of statements) results.push(await statement.run());
            sqlite.run("COMMIT");
            return results;
          } catch (error) {
            sqlite.run("ROLLBACK");
            throw error;
          }
        },
      } as unknown as D1Database,
    };
  }

  async function signedOperatorRequest(
    privateKey: CryptoKey,
    kid: string,
    operatorId = OPERATOR_ID,
  ): Promise<Request> {
    const now = Math.floor(Date.now() / 1_000);
    const body = JSON.stringify({
      sponsor_id: SPONSOR_ID,
      expected_active_fellow_limit: 5,
      expected_sponsor_seq: 0,
      active_fellow_limit: 6,
      reason: "Reviewed capacity need for active Fellows.",
      confirm: "override-fellow-cap",
      step_up_authenticated_at: now,
    });
    const envelope = await mintServiceEnvelope({
      privateKey,
      kid,
      now,
      method: "POST",
      route: "/v1/operators/fellow-cap",
      action: "operator.fellow-cap.override",
      principalId: operatorId,
      principalType: "operator",
      body,
    });
    const headers = new Headers(serviceEnvelopeHeaders(envelope));
    headers.set("idempotency-key", `operator-cap-${crypto.randomUUID()}`);
    return new Request("https://a.asimposium.org/v1/operators/fellow-cap", {
      method: "POST",
      headers,
      body,
    });
  }

  async function signedOperatorHistoryRequest(
    privateKey: CryptoKey,
    kid: string,
    operatorId = OPERATOR_ID,
  ): Promise<Request> {
    const now = Math.floor(Date.now() / 1_000);
    const path = `/v1/operators/sponsors/${SPONSOR_ID}/fellow-cap/history`;
    const envelope = await mintServiceEnvelope({
      privateKey,
      kid,
      now,
      method: "GET",
      route: "/v1/operators/sponsors/:sponsorId/fellow-cap/history",
      action: "operator.fellow-cap.history",
      principalId: operatorId,
      principalType: "operator",
      body: "",
    });
    return new Request(`https://a.asimposium.org${path}`, {
      headers: serviceEnvelopeHeaders(envelope),
    });
  }

  test("a signed allowlisted operator reaches the D1 audit command, while a cache rebind denies the same identity", async () => {
    const { db, sqlite } = latestD1();
    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(SPONSOR_ID, Date.now(), Date.now());
    const keypair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as CryptoKeyPair;
    const kid = "operator-app-test";
    const keyring = JSON.stringify([
      {
        kid,
        publicKeyHex: toHex(
          new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey)),
        ),
        notBefore: 0,
      },
    ]);
    const app = createApp();
    const allowedEnv = {
      DB: db,
      ENROLLMENT_REPLAY_KEY: REPLAY_KEY,
      STOA_ORIGIN: LOOPBACK,
      AGORA_ORIGIN: STAGING_AGORA_ORIGIN,
      SERVICE_ENVELOPE_KEYS: keyring,
      OPERATOR_PRINCIPAL_IDS: OPERATOR_ID,
    };
    const accepted = await app.fetch(
      await signedOperatorRequest(keypair.privateKey, kid),
      allowedEnv as never,
      ctx,
    );
    expect(accepted.status).toBe(200);
    expect(OperatorFellowCapOverrideResponseSchema.parse(await accepted.json())).toMatchObject({
      sponsor_id: SPONSOR_ID,
      sponsor_seq: 1,
      previous_active_fellow_limit: 5,
      active_fellow_limit: 6,
    });

    // This uses the full createApp ingress, not the router in isolation. It
    // proves the dynamic history path stays owned by the enrollment auth stack
    // and returns a receipt ordered by its causal sponsor sequence.
    const history = await app.fetch(
      await signedOperatorHistoryRequest(keypair.privateKey, kid),
      allowedEnv as never,
      ctx,
    );
    expect(history.status).toBe(200);
    expect(OperatorFellowCapAuditPageResponseSchema.parse(await history.json())).toMatchObject({
      audit_events: [
        {
          sponsor_id: SPONSOR_ID,
          sponsor_seq: 1,
          previous_active_fellow_limit: 5,
          active_fellow_limit: 6,
        },
      ],
      next_cursor: null,
    });

    // Same isolate and D1 handle, only the allowlist changes. If the cache key
    // omitted it, the previous stack would accept the old operator and fall as
    // far as a stale-CAS 409 instead of this pre-state 401 refusal.
    const revokedEnv = { ...allowedEnv, OPERATOR_PRINCIPAL_IDS: "usr_someone_else" };
    const refused = await app.fetch(
      await signedOperatorRequest(keypair.privateKey, kid),
      revokedEnv as never,
      ctx,
    );
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM sponsor_fellow_cap_audit_events")
        .get()?.n,
    ).toBe(1);
  });

  test("malformed operator allowlist disables the route rather than broadening it", async () => {
    const { db, sqlite } = latestD1();
    sqlite
      .prepare("INSERT INTO sponsors (sponsor_id, created_at, last_seen_at) VALUES (?, ?, ?)")
      .run(SPONSOR_ID, Date.now(), Date.now());
    const keypair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as CryptoKeyPair;
    const kid = "operator-malformed-allowlist";
    const keyring = JSON.stringify([
      {
        kid,
        publicKeyHex: toHex(
          new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey)),
        ),
        notBefore: 0,
      },
    ]);
    const app = createApp();
    const response = await app.fetch(
      await signedOperatorRequest(keypair.privateKey, kid),
      {
        DB: db,
        ENROLLMENT_REPLAY_KEY: REPLAY_KEY,
        STOA_ORIGIN: LOOPBACK,
        AGORA_ORIGIN: STAGING_AGORA_ORIGIN,
        SERVICE_ENVELOPE_KEYS: keyring,
        OPERATOR_PRINCIPAL_IDS: `${OPERATOR_ID},${OPERATOR_ID}`,
      } as never,
      ctx,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(await fixture(OPERATOR_AUTH_UNAVAILABLE_FIXTURE));
    expect(
      sqlite
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM sponsor_fellow_cap_audit_events")
        .get()?.n,
    ).toBe(0);
  });

  test.each([
    ["malformed JSON", "not-json"],
    ["an empty array", "[]"],
    [
      "an all-retired keyring",
      JSON.stringify([
        {
          kid: "retired",
          publicKeyHex: "ab".repeat(32),
          notBefore: 0,
          notAfter: 1,
        },
      ]),
    ],
  ])("a present %s keyring fails loudly without leaking its bytes", async (_label, keyring) => {
    const { db } = latestD1();
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => {
      errors.push(values);
    };
    try {
      await expect(
        createApp().fetch(
          new Request("https://a.asimposium.org/v1/operators/fellow-cap", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
          {
            DB: db,
            ENROLLMENT_REPLAY_KEY: REPLAY_KEY,
            STOA_ORIGIN: LOOPBACK,
            AGORA_ORIGIN: STAGING_AGORA_ORIGIN,
            SERVICE_ENVELOPE_KEYS: keyring,
            OPERATOR_PRINCIPAL_IDS: OPERATOR_ID,
          } as never,
          ctx,
        ),
      ).rejects.toBeInstanceOf(KeyringConfigError);

      await expect(
        createApp().fetch(
          new Request("https://a.asimposium.org/v1/operators/fellow-cap", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
          {
            DB: db,
            ENROLLMENT_REPLAY_KEY: REPLAY_KEY,
            STOA_ORIGIN: LOOPBACK,
            AGORA_ORIGIN: STAGING_AGORA_ORIGIN,
            SERVICE_ENVELOPE_KEYS: keyring,
            OPERATOR_PRINCIPAL_IDS: OPERATOR_ID,
          } as never,
          ctx,
        ),
      ).rejects.toBeInstanceOf(KeyringConfigError);
    } finally {
      console.error = originalError;
    }
    expect(errors).toEqual([
      ["[wire] invalid service-envelope keyring", { error: "KEYRING_CONFIG_INVALID" }],
    ]);
    expect(JSON.stringify(errors)).not.toContain(keyring);
  });

  test("a cached absent keyring cannot hide a later present empty binding", async () => {
    const { db } = latestD1();
    const baseEnv = {
      DB: db,
      ENROLLMENT_REPLAY_KEY: REPLAY_KEY,
      STOA_ORIGIN: LOOPBACK,
      AGORA_ORIGIN: STAGING_AGORA_ORIGIN,
      OPERATOR_PRINCIPAL_IDS: OPERATOR_ID,
    } as const;
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => {
      errors.push(values);
    };
    try {
      const app = createApp();
      const absent = await app.fetch(
        new Request("https://a.asimposium.org/v1/operators/fellow-cap", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        baseEnv as never,
        ctx,
      );
      expect(absent.status).toBe(503);

      await expect(
        app.fetch(
          new Request("https://a.asimposium.org/v1/operators/fellow-cap", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
          { ...baseEnv, SERVICE_ENVELOPE_KEYS: "" } as never,
          ctx,
        ),
      ).rejects.toBeInstanceOf(KeyringConfigError);
    } finally {
      console.error = originalError;
    }
    expect(errors).toEqual([
      ["[wire] invalid service-envelope keyring", { error: "KEYRING_CONFIG_INVALID" }],
    ]);
  });

  test("an absent optional keyring stays a quiet typed-unavailable sponsor plane", async () => {
    const { db } = latestD1();
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => {
      errors.push(values);
    };
    try {
      const response = await createApp().fetch(
        new Request("https://a.asimposium.org/v1/operators/fellow-cap", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        {
          DB: db,
          ENROLLMENT_REPLAY_KEY: REPLAY_KEY,
          STOA_ORIGIN: LOOPBACK,
          AGORA_ORIGIN: STAGING_AGORA_ORIGIN,
          OPERATOR_PRINCIPAL_IDS: OPERATOR_ID,
        } as never,
        ctx,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(await fixture(OPERATOR_AUTH_UNAVAILABLE_FIXTURE));
    } finally {
      console.error = originalError;
    }
    expect(errors).toEqual([]);
  });
});
