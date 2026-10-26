import { afterEach, describe, expect, test } from "bun:test";
import type { DirectiveDisclosurePublication } from "@asimposium/contracts/directive-disclosures";
import {
  directiveDisclosureCompleteSql,
  directiveDisclosureStatusSql,
  readPublicDirectiveDisclosure,
  recordDirectiveDisclosure,
} from "../../src/directives/disclosure-store.ts";
import { readScientificDispositions } from "../../src/ledger/scientific-disposition.ts";
import type { ScreenedPublication } from "../../src/screening/ingress.ts";
import { promotionScreeningBinding } from "../../src/screening/workers-ai.ts";
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
async function fixture(options?: Parameters<typeof directiveDisclosureFixture>[0]) {
  const result = await directiveDisclosureFixture(options);
  fixtures.push(result);
  return result;
}
function status(f: Fixture, cursor?: number) {
  return f.sql
    .query(`SELECT ${directiveDisclosureCompleteSql("?1", "'C-1'", "1", cursor?.toString())} AS complete,
    ${directiveDisclosureStatusSql("?1", "'C-1'", "1", cursor?.toString())} AS status`)
    .get(DISCLOSURE_PROBLEM);
}
async function write(f: Fixture, key: string, sponsorId = DISCLOSURE_SPONSOR) {
  const result = await recordDirectiveDisclosure(
    f.db,
    f.target,
    sponsorId,
    await f.command(sponsorId),
    key,
  );
  if (result instanceof Response) throw new Error(await result.text());
  return result;
}
async function screened(publication: DirectiveDisclosurePublication): Promise<ScreenedPublication> {
  const binding = await promotionScreeningBinding({
    problemId: publication.target.problem_id,
    fellowId: publication.fellow_id,
    kind: "directive-disclosure",
    statement: JSON.stringify(publication.disclosures),
    falsifier: null,
  });
  return {
    problemId: publication.target.problem_id,
    fellowId: publication.fellow_id,
    provenance: {
      version: "ledger-publication-screening.v1",
      scope: "candidate-and-actor-only",
      principal: "platform:symposiarch",
      input_digest: binding.bodyDigest.slice(7),
      context_digest: binding.contextDigest.slice(7),
      model_version: "fixture-model",
      policy_version: "fixture-policy",
      configuration_digest: "a".repeat(64),
      decided_at: new Date().toISOString(),
      latency_ms: 1,
      retry_count: 0,
      outcome: "pass",
      provider_status: "ok",
      decision_path: "provider",
      public_action: { category: "benign-context", action: "published", notice: "none" },
    },
  };
}
function control(f: Fixture, ref: string, visibility: "hidden" | "visible", version: number) {
  f.sql
    .query(`INSERT INTO content_controls(control_id,problem_id,target_kind,target_ref,
    visibility,source,reason_category,actor,reason,version,created_at)
    VALUES (?, ?, 'claim', ?, ?, 'operator', 'privacy', 'usr_operator', 'Fixture control.', ?, ?)`)
    .run(
      `CC-${crypto.randomUUID()}`,
      DISCLOSURE_PROBLEM,
      ref,
      visibility,
      version,
      new Date().toISOString(),
    );
}

describe("durable exact-result sponsor disclosures", () => {
  test("enrollment instructions retain the authoritative enrollment length limit", async () => {
    const instruction = "Initial direction: " + "x".repeat(1_981);
    const f = await fixture({ initialInstruction: instruction });
    const source = (await f.read()).scopes[0]?.directives[0];
    expect(source).toMatchObject({ source_kind: "enrollment-instruction", text: instruction });
    expect(instruction).toHaveLength(2_000);
    await write(f, "long-instruction");
    expect(status(f)).toEqual({ complete: 1, status: "satisfied" });
  });

  test("problem-bound delivery preserves the original request digest when the signed request omits problem_id", async () => {
    const f = await fixture({ problemBound: true });
    await f.issueDirective("inferred-problem");
    expect(f.sql.query("SELECT problem_id FROM sponsor_directives").get()).toEqual({
      problem_id: DISCLOSURE_PROBLEM,
    });
    expect((await f.read()).scopes[0]?.directives).toHaveLength(2);
    await write(f, "bound-request");
    expect(status(f)).toEqual({ complete: 1, status: "satisfied" });
  });

  test("ordinary no-dependency claims acquire one immutable declaration and replay without another event", async () => {
    const f = await fixture();
    expect(status(f)).toEqual({ complete: 0, status: "missing" });
    const state = await f.read();
    expect(state.scopes).toHaveLength(1);
    expect(state.scopes[0]?.directives[0]).toMatchObject({
      source_kind: "enrollment-instruction",
      verb: "initial",
    });
    const command = await f.command();
    const receipt = await recordDirectiveDisclosure(
      f.db,
      f.target,
      DISCLOSURE_SPONSOR,
      command,
      "first",
    );
    expect(receipt).not.toBeInstanceOf(Response);
    expect(status(f)).toEqual({ complete: 1, status: "satisfied" });
    expect(
      await recordDirectiveDisclosure(f.db, f.target, DISCLOSURE_SPONSOR, command, "first"),
    ).toEqual(receipt);
    expect(f.sql.query("SELECT COUNT(*) AS n FROM directive_disclosure_records").get()).toEqual({
      n: 1,
    });
    expect(
      (await readScientificDispositions(f.db, DISCLOSURE_PROBLEM, 2, 5)).get("C-1")
        ?.directiveDisclosure,
    ).toBe("satisfied");
    expect(JSON.stringify(receipt)).not.toContain("Private initial");
    await expect(
      recordDirectiveDisclosure(
        f.db,
        f.target,
        DISCLOSURE_SPONSOR,
        { ...command, decision: "withdraw" },
        "first",
      ),
    ).rejects.toThrow("CONFLICT");
    expect(() =>
      f.sql.exec("UPDATE directive_disclosure_records SET decision = 'withdraw'"),
    ).toThrow("IMMUTABLE");
  });

  test("new private steering invalidates coverage and rejects a previously reviewed snapshot", async () => {
    const f = await fixture();
    await write(f, "before");
    const stale = await f.command();
    await f.issueDirective("later");
    expect(status(f)).toEqual({ complete: 0, status: "unresolved" });
    await expect(
      recordDirectiveDisclosure(f.db, f.target, DISCLOSURE_SPONSOR, stale, "stale"),
    ).rejects.toThrow("CONFLICT");
    await write(f, "after");
    expect(status(f)).toEqual({ complete: 1, status: "satisfied" });
    expect((await f.read()).scopes[0]?.directives).toHaveLength(2);
  });

  test("transfers require each sponsor's own interval and conceal prior private instruction bodies", async () => {
    const f = await fixture();
    await f.issueDirective("before-transfer");
    await write(f, "pre-transfer");
    await f.transfer();
    const incoming = await f.read(DISCLOSURE_OTHER);
    const prior = incoming.scopes.find((scope) => scope.sponsor_id === DISCLOSURE_SPONSOR)!;
    expect(prior.can_attest).toBe(false);
    expect(prior.directives).toEqual([]);
    expect(JSON.stringify(incoming)).not.toContain("Private initial");
    expect(JSON.stringify(incoming)).not.toContain("Private later");
    await expect(
      recordDirectiveDisclosure(
        f.db,
        f.target,
        DISCLOSURE_OTHER,
        {
          scope_id: prior.scope_id,
          expected_lineage_digest: incoming.lineage_digest,
          expected_revision: prior.revision,
          decision: "no-undisclosed",
          disclosures: [],
        },
        "forged-prior",
      ),
    ).rejects.toThrow("FORBIDDEN");
    await write(f, "incoming", DISCLOSURE_OTHER);
    expect(status(f)).toEqual({ complete: 0, status: "unresolved" });
    await write(f, "prior-final-interval");
    expect(status(f)).toEqual({ complete: 1, status: "satisfied" });
  });

  test("newer positive receipts do not borrow future approval; current withdrawal invalidates older cuts", async () => {
    const f = await fixture();
    const first = await write(f, "first");
    await write(f, "positive-again");
    expect(status(f, first.seq)).toEqual({ complete: 1, status: "satisfied" });
    expect(status(f, first.seq - 1)).toEqual({ complete: 0, status: "unresolved" });
    await recordDirectiveDisclosure(
      f.db,
      f.target,
      DISCLOSURE_SPONSOR,
      await f.command(DISCLOSURE_SPONSOR, "withdraw"),
      "withdraw",
    );
    expect(status(f, first.seq)).toEqual({ complete: 0, status: "unresolved" });
    expect(status(f)).toEqual({ complete: 0, status: "unresolved" });
    expect(
      await readPublicDirectiveDisclosure(f.db, DISCLOSURE_PROBLEM, first.event_id),
    ).not.toBeNull();
  });

  test("directive races after the writer's head read roll back the entire declaration", async () => {
    const f = await fixture();
    const command = await f.command();
    let raced = false;
    await expect(
      recordDirectiveDisclosure(f.db, f.target, DISCLOSURE_SPONSOR, command, "raced", {
        hooks: {
          afterReadHead: async () => {
            if (!raced) {
              raced = true;
              await f.issueDirective("racing");
            }
          },
        },
      }),
    ).rejects.toThrow("CONFLICT");
    expect(raced).toBe(true);
    expect(f.sql.query("SELECT COUNT(*) AS n FROM directive_disclosure_records").get()).toEqual({
      n: 0,
    });
    expect(
      f.sql
        .query("SELECT COUNT(*) AS n FROM events WHERE type = 'directive.disclosure-recorded'")
        .get(),
    ).toEqual({ n: 0 });
    expect(status(f)).toEqual({ complete: 0, status: "missing" });
  });

  test("only screened safe summaries publish; a held request can retry unchanged after release", async () => {
    const f = await fixture();
    const initial = (await f.read()).scopes[0]!.directives[0]!;
    const command = {
      ...(await f.command()),
      decision: "disclose" as const,
      disclosures: [
        {
          directive_id: initial.directive_id,
          source_kind: initial.source_kind,
          scope: "The finite search direction",
          summary: "The sponsor requested a constructive approach.",
        },
      ],
    };
    let seen: DirectiveDisclosurePublication | undefined;
    const held = await recordDirectiveDisclosure(
      f.db,
      f.target,
      DISCLOSURE_SPONSOR,
      command,
      "held",
      {
        screen: async (publication) => {
          seen = publication;
          return Response.json({ code: "SCREENING_HOLD" }, { status: 202 });
        },
      },
    );
    expect(held).toBeInstanceOf(Response);
    expect((held as Response).status).toBe(202);
    expect(status(f)).toEqual({ complete: 0, status: "missing" });
    expect(f.sql.query("SELECT COUNT(*) AS n FROM directive_disclosure_records").get()).toEqual({
      n: 0,
    });
    expect(JSON.stringify(seen)).not.toContain("Private initial");
    const result = await recordDirectiveDisclosure(
      f.db,
      f.target,
      DISCLOSURE_SPONSOR,
      command,
      "held",
      { screen: screened },
    );
    if (result instanceof Response) throw new Error(await result.text());
    expect(result.disclosures).toEqual(command.disclosures);
    expect(
      await readPublicDirectiveDisclosure(f.db, DISCLOSURE_PROBLEM, result.event_id),
    ).toMatchObject({ receipt: result });
    expect(f.sql.query("SELECT COUNT(*) AS n FROM screening_publications").get()).toEqual({ n: 1 });
    expect(status(f)).toEqual({ complete: 1, status: "satisfied" });
    const forged = {
      ...command,
      ...(await f.command()),
      decision: "disclose" as const,
      disclosures: command.disclosures,
    };
    await expect(
      recordDirectiveDisclosure(f.db, f.target, DISCLOSURE_SPONSOR, forged, "wrong-screen", {
        screen: async (publication) =>
          screened({
            ...publication,
            disclosures: [{ ...publication.disclosures[0]!, summary: "Different candidate" }],
          }),
      }),
    ).rejects.toThrow("UNAVAILABLE");
    expect(f.sql.query("SELECT COUNT(*) AS n FROM directive_disclosure_records").get()).toEqual({
      n: 1,
    });
  });

  test("current controls hide exact source versions and declaration versions at every historical cut", async () => {
    const f = await fixture(),
      receipt = await write(f, "visible");
    for (const ref of [
      "C-1",
      "C-1@1",
      "#1",
      receipt.event_id,
      `${receipt.event_id}@1`,
      `#${receipt.seq}`,
    ]) {
      control(f, ref, "hidden", 1);
      expect(status(f, receipt.seq)).toMatchObject({ complete: 0 });
      expect(
        await readPublicDirectiveDisclosure(f.db, DISCLOSURE_PROBLEM, receipt.event_id),
      ).toBeNull();
      control(f, ref, "visible", 2);
      expect(status(f, receipt.seq)).toEqual({ complete: 1, status: "satisfied" });
      expect(
        await readPublicDirectiveDisclosure(f.db, DISCLOSURE_PROBLEM, receipt.event_id),
      ).not.toBeNull();
    }
  });

  test("exact source hiding during publication refuses the declaration atomically", async () => {
    const f = await fixture();
    let raced = false;
    await expect(
      recordDirectiveDisclosure(
        f.db,
        f.target,
        DISCLOSURE_SPONSOR,
        await f.command(),
        "hidden-race",
        {
          hooks: {
            afterReadHead: async () => {
              if (!raced) {
                raced = true;
                control(f, "C-1@1", "hidden", 1);
              }
            },
          },
        },
      ),
    ).rejects.toThrow("CONFLICT");
    expect(raced).toBe(true);
    expect(f.sql.query("SELECT COUNT(*) AS n FROM directive_disclosure_records").get()).toEqual({
      n: 0,
    });
  });

  test("transfer during publication cannot bless authority captured before the transfer", async () => {
    const f = await fixture();
    let raced = false;
    await expect(
      recordDirectiveDisclosure(
        f.db,
        f.target,
        DISCLOSURE_SPONSOR,
        await f.command(),
        "transfer-race",
        {
          hooks: {
            afterReadHead: async () => {
              if (!raced) {
                raced = true;
                await f.transfer();
              }
            },
          },
        },
      ),
    ).rejects.toThrow("CONFLICT");
    expect(raced).toBe(true);
    expect(f.sql.query("SELECT COUNT(*) AS n FROM directive_disclosure_records").get()).toEqual({
      n: 0,
    });
    expect((await f.read(DISCLOSURE_OTHER)).scopes).toHaveLength(2);
  });

  for (const altered of ["source", "declaration"] as const) {
    test(`corrupted ${altered} bytes with stale hash columns cannot qualify or produce a public receipt`, async () => {
      const f = await fixture(),
        receipt = await write(f, "intact");
      // Explicit corruption injection: ordinary updates are blocked by the
      // shipped immutability trigger, which the preceding tests retain.
      f.sql.exec("DROP TRIGGER event_content_lawful_redaction_only");
      f.sql
        .query("UPDATE event_content SET payload_json = ? WHERE event_id = ?")
        .run('{"forged":true}', altered === "source" ? "E-disclosure-claim" : receipt.event_id);
      expect(status(f)).toMatchObject({ complete: 0 });
      expect(
        await readPublicDirectiveDisclosure(f.db, DISCLOSURE_PROBLEM, receipt.event_id),
      ).toBeNull();
      expect(
        (await readScientificDispositions(f.db, DISCLOSURE_PROBLEM, receipt.seq, 5)).get("C-1")
          ?.directiveDisclosure,
      ).not.toBe("satisfied");
    });
  }
});
