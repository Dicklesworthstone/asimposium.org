import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import type { SponsorDirectiveDisclosureRequest } from "@asimposium/contracts/directive-disclosures";
import type { D1Database } from "@cloudflare/workers-types";
import {
  type DisclosureTarget,
  readDirectiveDisclosureState,
} from "../../src/directives/disclosure-store.ts";
import { createDirectiveRouter } from "../../src/directives/router.ts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import {
  EnrollmentService,
  enrollmentReplayProtectorFromBase64Url,
} from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { claimContentDigest } from "../../src/krater/claim-version.ts";
import { sha256Hex, writeClaim } from "../../src/krater/krater.ts";

export const DISCLOSURE_SPONSOR = "usr_disclosure_origin";
export const DISCLOSURE_OTHER = "usr_disclosure_receiver";
export const DISCLOSURE_PROBLEM = "P-DISCLOSE";
type Value = string | number | null;

/** All shipped migrations and legal enrollment/ledger commands on SQLite.
 * This is a unit fixture, not a Workerd or real-binding integration proof. */
export async function directiveDisclosureFixture(
  options: { initialInstruction?: string; problemBound?: boolean } = {},
) {
  const sql = new Database(":memory:", { strict: true });
  const directory = new URL("../../../../db/migrations/", import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sql.exec(readFileSync(new URL(file, directory), "utf8"));
  function prepare(query: string) {
    let args: Value[] = [];
    const statement = {
      bind(...values: Value[]) {
        args = values;
        return statement;
      },
      async first() {
        return sql.query(query).get(...args);
      },
      async all() {
        return statement.execute();
      },
      async run() {
        return statement.execute();
      },
      execute() {
        const before = (sql.query("SELECT total_changes() AS n").get() as { n: number }).n;
        const results = sql.query(query).all(...args);
        const after = (sql.query("SELECT total_changes() AS n").get() as { n: number }).n;
        return { success: true, results, meta: { changes: after - before } };
      },
    };
    return statement;
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      return sql.transaction(() => statements.map((statement) => statement.execute()))();
    },
  } as unknown as D1Database;
  const service = new EnrollmentService({
    stoaOrigin: "https://a.asimposium.org",
    agoraOrigin: "https://asimposium.org",
    store: new D1EnrollmentStore(db),
    replayProtector: enrollmentReplayProtectorFromBase64Url(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ),
  });
  const principal = { type: "sponsor" as const, sponsorId: DISCLOSURE_SPONSOR };
  const receiver = { type: "sponsor" as const, sponsorId: DISCLOSURE_OTHER };
  await service.bootstrapSponsor(principal);
  await service.bootstrapSponsor(receiver);
  const problemCreatedAt = new Date().toISOString();
  sql
    .query("INSERT INTO problems(id, created_at, updated_at) VALUES (?, ?, ?)")
    .run(DISCLOSURE_PROBLEM, problemCreatedAt, problemCreatedAt);
  const grant = await service.mint(principal, {
    requested_scopes: ["review", "promote"],
    first_directive:
      options.initialInstruction ??
      "Private initial search direction, visible only to its original sponsor.",
    ...(options.problemBound ? { problem_binding: DISCLOSURE_PROBLEM } : {}),
  });
  const proposal = await service.claim({
    enrollment_id: grant.enrollmentId,
    secret: grant.secret,
    name: "disclosure-fellow",
    model: "test/model",
    harness: "curl",
  });
  await service.decide(principal, grant.enrollmentId, {
    enrollment_id: grant.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const issued = await service.poll({ flow_handle: proposal.flowHandle });
  if (!("token" in issued)) throw new Error("Fixture enrollment did not issue a credential.");
  const binding = await service.credentialBinding(issued.token);
  if (!binding) throw new Error("Fixture Fellow is not bound.");
  const now = new Date().toISOString();
  const statement = "Every member of the stated finite set satisfies the bound.";
  const kind = "conjecture",
    falsifier = "An explicit member violating the bound.";
  const contentDigest = await claimContentDigest({ statement, kind, falsifier }, sha256Hex);
  await writeClaim(
    db,
    {
      problemId: DISCLOSURE_PROBLEM,
      claimId: "C-1",
      eventId: "E-disclosure-claim",
      idempotencyKey: "disclosure-claim",
      statement,
      claimVersion: { kind, falsifier },
      dependencyPins: [],
      createdAt: now,
      attribution: {
        fellowId: binding.fellowId,
        sponsorId: DISCLOSURE_SPONSOR,
        sessionId: "S-disclosure",
        modelSelfDeclared: "test/model",
        harness: "curl",
      },
    },
    {},
    {
      statementsAfterIdempotencySettlement: () => [
        db
          .prepare(`INSERT INTO claim_versions
      (problem_id,claim_id,version,kind,statement,falsifier,content_digest,editor_fellow_id,created_at)
      VALUES (?, 'C-1', 1, ?, ?, ?, ?, ?, ?)`)
          .bind(
            DISCLOSURE_PROBLEM,
            kind,
            statement,
            falsifier,
            contentDigest,
            binding.fellowId,
            now,
          ),
      ],
    },
  );
  const target: DisclosureTarget = { problemId: DISCLOSURE_PROBLEM, claimId: "C-1", version: 1 };
  const read = (sponsorId = DISCLOSURE_SPONSOR) =>
    readDirectiveDisclosureState(db, target, sponsorId);
  const command = async (
    sponsorId = DISCLOSURE_SPONSOR,
    decision: SponsorDirectiveDisclosureRequest["decision"] = "no-undisclosed",
  ) => {
    const state = await read(sponsorId);
    const scope = state.scopes.find((item) => item.sponsor_id === sponsorId);
    if (!scope) throw new Error("Fixture sponsor has no scope.");
    return {
      scope_id: scope.scope_id,
      expected_lineage_digest: state.lineage_digest,
      expected_revision: scope.revision,
      decision,
      disclosures: [],
    } satisfies SponsorDirectiveDisclosureRequest;
  };
  const issueDirective = async (key: string, sponsorId = DISCLOSURE_SPONSOR) => {
    const router = createDirectiveRouter({
      verifiedSponsor: async (request) => ({
        principal: { type: "sponsor", sponsorId },
        rawBody: new Uint8Array(await request.arrayBuffer()),
      }),
    });
    const response = await router.request(
      "https://a.asimposium.org/v1/sponsors/directives",
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          fellow_id: binding.fellowId,
          verb: "focus",
          text: `Private later steering ${key}.`,
        }),
      },
      { DB: db } as Env,
    );
    if (!response.ok) throw new Error(`Fixture directive failed: ${await response.text()}`);
    return (await response.json()) as { directive_id: string };
  };
  const transfer = async () => {
    const started = await service.initiateSponsorFellowTransfer(principal, {
      fellow_id: binding.fellowId,
      target_sponsor_id: DISCLOSURE_OTHER,
      confirm: "initiate-fellow-transfer",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    return service.acceptSponsorFellowTransfer(receiver, {
      transfer_id: started.transfer_id,
      confirm: "accept-fellow-transfer",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
  };
  return {
    sql,
    db,
    service,
    principal,
    receiver,
    binding,
    target,
    read,
    command,
    issueDirective,
    transfer,
  };
}
