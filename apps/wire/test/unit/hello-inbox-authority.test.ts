import { afterEach, describe, expect, test } from "bun:test";
import { EnrollmentHelloResponseSchema, TriageResponseSchema } from "@asimposium/contracts";
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import type { Env } from "../../src/env.ts";
import { createInboxNotice } from "../../src/inbox/store.ts";
import { createMegaCommandsRouter } from "../../src/mega-commands/router.ts";
import { directiveDisclosureFixture } from "../support/directive-disclosure.ts";

const ORIGIN = "https://a.asimposium.org";
const PRIVATE_INSTRUCTION = "PRIVATE-HELLO-LATE-AUTHORITY-CANARY";
const fixtures: Awaited<ReturnType<typeof directiveDisclosureFixture>>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.sql.close();
});

/** SQLite unit routing with actual enrollment commands and all migrations.
 * Hooks model awaited move work and the final inbox statement; they do not
 * replace the credential service or the authority/visibility SQL. */
async function fixture() {
  const source = await directiveDisclosureFixture({ initialInstruction: PRIVATE_INSTRUCTION });
  fixtures.push(source);
  let duringMove: (() => Promise<void>) | undefined;
  let beforeSummary: (() => Promise<void>) | undefined;
  const db = {
    ...source.db,
    prepare(query: string) {
      const statement = source.db.prepare(query);
      if (query.includes(" AS matched_reviews")) {
        const first = statement.first.bind(statement);
        statement.first = async <T = unknown>(columnName?: string): Promise<T | null> => {
          const hook = beforeSummary;
          beforeSummary = undefined;
          await hook?.();
          return first<T>(columnName);
        };
      }
      return statement;
    },
  } as D1Database;
  const app = new Hono<{ Bindings: Env }>()
    .route("/", createEnrollmentRouter({ service: source.service, db }))
    .route(
      "/",
      createMegaCommandsRouter({
        service: source.service,
        db,
        movesProvider: {
          async nextMoves() {
            return { primaryMove: null, alternatives: [], degraded: false };
          },
          async triageMove() {
            const hook = duringMove;
            duringMove = undefined;
            await hook?.();
            return { move: null, degraded: false };
          },
        },
      }),
    );
  async function get(path: string) {
    const pending: Promise<unknown>[] = [];
    const response = await app.fetch(
      new Request(ORIGIN + path, {
        headers: { authorization: `Bearer ${source.token}` },
      }),
      { DB: db } as Env,
      {
        waitUntil(promise: Promise<unknown>) {
          pending.push(promise);
        },
        passThroughOnException() {},
      } as ExecutionContext,
    );
    await Promise.all(pending);
    return response;
  }
  async function revoke() {
    const receipt = await source.service.revokeCredential(
      source.principal,
      {
        fellow_id: source.binding.fellowId,
        credential_id: source.binding.credentialId,
        confirm: "revoke-credential",
        step_up_authenticated_at: Math.floor(Date.now() / 1000),
      },
      { idempotencyKey: "hello-late-authority-revoke" },
    );
    expect(receipt.acknowledged).toBe(true);
  }
  return {
    ...source,
    get,
    revoke,
    onMove(hook: () => Promise<void>) {
      duringMove = hook;
    },
    onSummary(hook: () => Promise<void>) {
      beforeSummary = hook;
    },
  };
}

async function expectRefused(response: Response, fellowId: string) {
  expect(response.status).toBe(401);
  const body = await response.text();
  expect(JSON.parse(body).code).toBe("FELLOW_TOKEN_INVALID");
  expect(body).not.toContain(PRIVATE_INSTRUCTION);
  expect(body).not.toContain(fellowId);
  expect(body).not.toContain("unacknowledged_count");
}

describe("hello inbox final authority and visibility", () => {
  for (const path of ["/v1/triage", "/v1/triage.md"]) {
    for (const change of ["credential revocation", "sponsor transfer"] as const) {
      test(`${path} refuses the whole private response after ${change} during move selection`, async () => {
        const f = await fixture();
        const control = await f.get(path);
        expect(control.status).toBe(200);
        expect(await control.text()).toContain(f.binding.fellowId);
        f.onMove(async () => {
          if (change === "credential revocation") await f.revoke();
          else await f.transfer();
        });
        await expectRefused(await f.get(path), f.binding.fellowId);
      });
    }

    test(`${path} counts current private visibility after awaited move work`, async () => {
      const f = await fixture();
      const problemId = "P-PRIVATE-INBOX";
      const now = new Date().toISOString();
      f.sql
        .query(
          "INSERT INTO problems(id,status,created_at,updated_at) VALUES(?,'private-draft',?,?)",
        )
        .run(problemId, now, now);
      f.sql
        .query(
          "INSERT INTO problem_memberships(problem_id,fellow_id,role,joined_at) VALUES(?,?,'contributor',?)",
        )
        .run(problemId, f.binding.fellowId, now);
      await createInboxNotice(f.db, {
        fellowId: f.binding.fellowId,
        problemId,
        noticeType: "protocol_notice",
        title: "Private problem feedback",
      });
      const control = await f.get(path);
      expect(control.status).toBe(200);
      expect(await control.text()).toMatch(/"unacknowledged_count"\s*:\s*1/);
      f.onMove(async () => {
        f.sql
          .query("DELETE FROM problem_memberships WHERE problem_id=? AND fellow_id=?")
          .run(problemId, f.binding.fellowId);
      });
      const response = await f.get(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toMatch(/"unacknowledged_count"\s*:\s*0/);
    });
  }

  for (const path of ["/v1/hello", "/v1/triage", "/v1/triage.md"]) {
    test(`${path} pins authority again in the final SQL after canonical reauthentication`, async () => {
      const f = await fixture();
      f.onSummary(f.revoke);
      await expectRefused(await f.get(path), f.binding.fellowId);
    });

    test(`${path} cannot release the private base when a failed summary overlaps revocation`, async () => {
      const f = await fixture();
      f.onSummary(async () => {
        await f.revoke();
        throw new Error("INBOX_SOURCE_UNAVAILABLE_DURING_REVOCATION");
      });
      await expectRefused(await f.get(path), f.binding.fellowId);
    });
  }

  for (const path of ["/v1/hello", "/v1/triage"]) {
    test(`${path} reports unavailable feedback without inventing an empty inbox`, async () => {
      const f = await fixture();
      await createInboxNotice(f.db, {
        fellowId: f.binding.fellowId,
        noticeType: "protocol_notice",
        title: "An unread notice still exists",
      });
      f.onSummary(async () => {
        throw new Error("INBOX_SOURCE_UNAVAILABLE");
      });
      const response = await f.get(path);
      expect(response.status).toBe(200);
      const json = await response.json();
      const hello =
        path === "/v1/hello"
          ? EnrollmentHelloResponseSchema.parse(json)
          : TriageResponseSchema.parse(json).hello;
      expect(hello).not.toHaveProperty("inbox");
      expect(hello).not.toHaveProperty("unread_reviews");
      const action = hello.next_actions.find(
        (item) => item.url === ORIGIN + "/v1/inbox?unread_only=true",
      );
      expect(action?.action).toBe("read");
      expect(action?.reason).not.toContain("0 unacknowledged");
      expect(
        f.sql
          .query("SELECT COUNT(*) AS n FROM fellow_inbox_notices WHERE acknowledged_at IS NULL")
          .get(),
      ).toEqual({ n: 1 });
    });
  }
});
