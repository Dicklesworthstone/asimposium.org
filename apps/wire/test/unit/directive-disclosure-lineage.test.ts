import { afterEach, expect, test } from "bun:test";
import type { ClaimDependencyPin } from "@asimposium/contracts";
import type { SponsorDirectiveDisclosureRequest } from "@asimposium/contracts/directive-disclosures";
import {
  type DisclosureTarget,
  directiveDisclosureStatusSql,
  readDirectiveDisclosureState,
  readPublicDirectiveDisclosure,
  recordDirectiveDisclosure,
} from "../../src/directives/disclosure-store.ts";
import { claimContentDigest } from "../../src/krater/claim-version.ts";
import { sha256Hex, writeClaim, writeClaimRevision } from "../../src/krater/krater.ts";
import { normHash } from "../../src/split/policy.ts";
import {
  DISCLOSURE_OTHER,
  DISCLOSURE_PROBLEM,
  DISCLOSURE_SPONSOR,
  directiveDisclosureFixture,
} from "../support/directive-disclosure.ts";

type Fixture = Awaited<ReturnType<typeof directiveDisclosureFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.sql.close();
});
async function fixture() {
  const result = await directiveDisclosureFixture();
  fixtures.push(result);
  return result;
}

function standing(f: Fixture, target: DisclosureTarget, cursor?: number) {
  return f.sql
    .query(`SELECT ${directiveDisclosureStatusSql("?1", "?2", "?3", cursor?.toString())} AS status`)
    .get(target.problemId, target.claimId, target.version);
}

async function command(f: Fixture, target: DisclosureTarget, sponsorId: string) {
  const state = await readDirectiveDisclosureState(f.db, target, sponsorId);
  const own = state.scopes.find((scope) => scope.sponsor_id === sponsorId && scope.can_attest);
  if (!own) throw new Error("The enrolled fixture sponsor has no disclosure scope.");
  return {
    scope_id: own.scope_id,
    expected_lineage_digest: state.lineage_digest,
    expected_revision: own.revision,
    decision: "no-undisclosed",
    disclosures: [],
  } satisfies SponsorDirectiveDisclosureRequest;
}

async function enrolledSecondFellow(f: Fixture) {
  const grant = await f.service.mint(f.receiver, {
    requested_scopes: ["review", "promote"],
    first_directive: "PRIVATE_SECOND_FELLOW_DIRECTION: inspect the aggregate after the bound.",
  });
  const proposal = await f.service.claim({
    enrollment_id: grant.enrollmentId,
    secret: grant.secret,
    name: "second-lineage-fellow",
    model: "test/second-model",
    harness: "curl",
  });
  await f.service.decide(f.receiver, grant.enrollmentId, {
    enrollment_id: grant.enrollmentId,
    decision: "approve",
    step_up_authenticated_at: Math.floor(Date.now() / 1000),
  });
  const issued = await f.service.poll({ flow_handle: proposal.flowHandle });
  if (!("token" in issued)) throw new Error("The second fixture Fellow did not enroll.");
  const binding = await f.service.credentialBinding(issued.token);
  if (!binding) throw new Error("The second fixture Fellow has no credential binding.");
  return binding;
}

async function dependentClaim(f: Fixture): Promise<DisclosureTarget> {
  const binding = await enrolledSecondFellow(f);
  const source = await f.read();
  const publication = f.sql
    .query("SELECT payload_sha256 FROM events WHERE id = ?")
    .get(source.target.publication_event_id) as { payload_sha256: string };
  const pin: ClaimDependencyPin = {
    claim_id: "C-1",
    version: 1,
    content_digest: source.target.content_digest,
    event_id: source.target.publication_event_id,
    payload_digest: publication.payload_sha256,
  };
  const statement = "The aggregate over the finite set obeys the bound derived from C-1.";
  const kind = "conjecture",
    falsifier = "An aggregate violating the stated derived bound.";
  const createdAt = new Date().toISOString();
  const digest = await claimContentDigest({ statement, kind, falsifier }, sha256Hex);
  await writeClaim(
    f.db,
    {
      problemId: DISCLOSURE_PROBLEM,
      claimId: "C-2",
      eventId: "E-disclosure-dependent",
      idempotencyKey: "disclosure-dependent",
      statement,
      claimVersion: { kind, falsifier },
      dependencyPins: [pin],
      createdAt,
      attribution: {
        fellowId: binding.fellowId,
        sponsorId: DISCLOSURE_OTHER,
        sessionId: "S-disclosure-dependent",
        modelSelfDeclared: "test/second-model",
        harness: "curl",
      },
    },
    {},
    {
      statementsAfterIdempotencySettlement: () => [
        f.db
          .prepare(`INSERT INTO claim_versions
      (problem_id,claim_id,version,kind,statement,falsifier,content_digest,editor_fellow_id,created_at)
      VALUES (?, 'C-2', 1, ?, ?, ?, ?, ?, ?)`)
          .bind(
            DISCLOSURE_PROBLEM,
            kind,
            statement,
            falsifier,
            digest,
            binding.fellowId,
            createdAt,
          ),
      ],
    },
  );
  return { problemId: DISCLOSURE_PROBLEM, claimId: "C-2", version: 1 };
}

async function revise(f: Fixture) {
  const statement = "Every member of the restricted finite set satisfies the sharper bound.";
  const kind = "conjecture",
    falsifier = "An explicit member violating the sharper bound.";
  return writeClaimRevision(f.db, {
    problemId: DISCLOSURE_PROBLEM,
    claimId: "C-1",
    eventId: "E-disclosure-revised",
    idempotencyKey: "disclosure-revised",
    baseVersion: 1,
    newVersion: 2,
    kind,
    statement,
    falsifier,
    dependencyPins: [],
    contentDigest: await claimContentDigest({ statement, kind, falsifier }, sha256Hex),
    editorFellowId: f.binding.fellowId,
    normHash: await normHash(statement),
    createdAt: new Date().toISOString(),
    attribution: {
      fellowId: f.binding.fellowId,
      sponsorId: DISCLOSURE_SPONSOR,
      sessionId: "S-disclosure",
      modelSelfDeclared: "test/model",
      harness: "curl",
    },
  });
}

test("an exact dependency requires both authors' sponsor scopes without exposing their private instructions", async () => {
  const f = await fixture();
  await f.issueDirective("premise-direction");
  const premiseCommand = await f.command();
  const premiseReceipt = await recordDirectiveDisclosure(
    f.db,
    f.target,
    DISCLOSURE_SPONSOR,
    premiseCommand,
    "standalone-premise",
  );
  expect(premiseReceipt).not.toBeInstanceOf(Response);
  expect(standing(f, f.target)).toEqual({ status: "satisfied" });
  const target = await dependentClaim(f);
  const authorView = await readDirectiveDisclosureState(f.db, target, DISCLOSURE_OTHER);
  expect(authorView.scopes.map((scope) => scope.sponsor_id).sort()).toEqual(
    [DISCLOSURE_SPONSOR, DISCLOSURE_OTHER].sort(),
  );
  expect(authorView.status).toBe("missing");
  const premiseScope = authorView.scopes.find((scope) => scope.sponsor_id === DISCLOSURE_SPONSOR);
  if (!premiseScope) throw new Error("The exact premise author was omitted from the lineage.");
  expect(premiseScope).toMatchObject({
    can_attest: false,
    directives: [],
    receipt: null,
    revision: 0,
  });
  expect(premiseScope.scope_id).not.toBe(premiseCommand.scope_id);
  expect(JSON.stringify(authorView)).not.toContain("Private initial");
  expect(JSON.stringify(authorView)).not.toContain("Private later");
  expect(JSON.stringify(authorView)).toContain("PRIVATE_SECOND_FELLOW_DIRECTION");
  const premiseView = await readDirectiveDisclosureState(f.db, target, DISCLOSURE_SPONSOR);
  expect(JSON.stringify(premiseView)).toContain("Private initial");
  expect(JSON.stringify(premiseView)).toContain("Private later");
  expect(JSON.stringify(premiseView)).not.toContain("PRIVATE_SECOND_FELLOW_DIRECTION");

  await expect(
    recordDirectiveDisclosure(
      f.db,
      target,
      DISCLOSURE_OTHER,
      {
        scope_id: premiseScope.scope_id,
        expected_lineage_digest: authorView.lineage_digest,
        expected_revision: 0,
        decision: "no-undisclosed",
        disclosures: [],
      },
      "author-forged-premise",
    ),
  ).rejects.toThrow("FORBIDDEN");
  await recordDirectiveDisclosure(
    f.db,
    target,
    DISCLOSURE_OTHER,
    await command(f, target, DISCLOSURE_OTHER),
    "dependent-author",
  );
  expect(standing(f, target)).toEqual({ status: "unresolved" });
  await recordDirectiveDisclosure(
    f.db,
    target,
    DISCLOSURE_SPONSOR,
    await command(f, target, DISCLOSURE_SPONSOR),
    "dependent-premise",
  );
  expect(standing(f, target)).toEqual({ status: "satisfied" });
  expect((await readDirectiveDisclosureState(f.db, target, DISCLOSURE_OTHER)).status).toBe(
    "complete",
  );

  f.sql
    .query(`INSERT INTO content_controls(control_id,problem_id,target_kind,target_ref,
    visibility,source,reason_category,actor,reason,version,created_at)
    VALUES ('CC-hidden-lineage-premise', ?, 'claim', 'C-1@1', 'hidden', 'operator', 'privacy',
      'usr_operator', 'Hide the exact premise source.', 1, ?)`)
    .run(DISCLOSURE_PROBLEM, new Date().toISOString());
  expect(standing(f, target)).toEqual({ status: "unavailable" });
  await expect(readDirectiveDisclosureState(f.db, target, DISCLOSURE_OTHER)).rejects.toThrow();
});

test("a claim revision invalidates its old declaration while exact accepted replay remains historical", async () => {
  const f = await fixture();
  const acceptedCommand = await f.command();
  const accepted = await recordDirectiveDisclosure(
    f.db,
    f.target,
    DISCLOSURE_SPONSOR,
    acceptedCommand,
    "accepted-before-revision",
  );
  if (accepted instanceof Response) throw new Error(await accepted.text());
  const staleCommand = await f.command();
  await revise(f);
  expect(standing(f, f.target)).toEqual({ status: "unresolved" });
  expect(standing(f, f.target, accepted.seq)).toEqual({ status: "unresolved" });
  await expect(
    recordDirectiveDisclosure(
      f.db,
      f.target,
      DISCLOSURE_SPONSOR,
      staleCommand,
      "stale-after-revision",
    ),
  ).rejects.toThrow("CONFLICT");
  expect(
    await recordDirectiveDisclosure(
      f.db,
      f.target,
      DISCLOSURE_SPONSOR,
      acceptedCommand,
      "accepted-before-revision",
    ),
  ).toEqual(accepted);
  expect(
    await readPublicDirectiveDisclosure(f.db, DISCLOSURE_PROBLEM, accepted.event_id),
  ).toMatchObject({ receipt: accepted });
  const revisedTarget = { ...f.target, version: 2 };
  expect(standing(f, revisedTarget)).toEqual({ status: "missing" });
  const revised = await readDirectiveDisclosureState(f.db, revisedTarget, DISCLOSURE_SPONSOR);
  expect(revised.target.content_digest).not.toBe(accepted.target.content_digest);
  expect(revised.lineage_digest).not.toBe(acceptedCommand.expected_lineage_digest);
  expect(revised.scopes[0]?.scope_id).not.toBe(accepted.scope_id);
  await recordDirectiveDisclosure(
    f.db,
    revisedTarget,
    DISCLOSURE_SPONSOR,
    await command(f, revisedTarget, DISCLOSURE_SPONSOR),
    "revised-declaration",
  );
  expect(standing(f, revisedTarget)).toEqual({ status: "satisfied" });
  expect(standing(f, f.target)).toEqual({ status: "unresolved" });
  expect(f.sql.query("SELECT COUNT(*) AS n FROM directive_disclosure_records").get()).toEqual({
    n: 2,
  });
});

test("a revision after the disclosure writer reads the head cannot publish an obsolete declaration", async () => {
  const f = await fixture();
  const inspected = await f.command();
  let raced = false;
  await expect(
    recordDirectiveDisclosure(f.db, f.target, DISCLOSURE_SPONSOR, inspected, "revision-race", {
      hooks: {
        afterReadHead: async () => {
          if (raced) return;
          raced = true;
          await revise(f);
        },
      },
    }),
  ).rejects.toThrow("CONFLICT");
  expect(raced).toBe(true);
  expect(
    f.sql.query("SELECT MAX(version) AS version FROM claim_versions WHERE claim_id = 'C-1'").get(),
  ).toEqual({ version: 2 });
  expect(f.sql.query("SELECT COUNT(*) AS n FROM directive_disclosure_records").get()).toEqual({
    n: 0,
  });
  expect(
    f.sql
      .query("SELECT COUNT(*) AS n FROM events WHERE type = 'directive.disclosure-recorded'")
      .get(),
  ).toEqual({ n: 0 });
});
