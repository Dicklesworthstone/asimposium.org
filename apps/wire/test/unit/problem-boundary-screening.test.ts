import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  type ProblemStatementBoundaries,
  ScreeningPromotionHoldResponseSchema,
  ScreeningPublicationContextInputSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import { redactEventContent, writeLedgerEvent } from "../../src/krater/krater";
import { operatorQuarantineCase } from "../../src/moderation/operator-http";
import { screenPublicCandidate } from "../../src/screening/public-candidate";
import {
  isScreeningContextStaleError,
  MAX_PUBLICATION_SCREENING_BODY_BYTES,
  publicationContextDocument,
  readPublicationContext,
  storedPublicationContextIsVisible,
} from "../../src/screening/publication-context";
import { promotionScreeningBinding } from "../../src/screening/workers-ai";
import {
  publicationContextFixture as fixture,
  NOW,
  OTHER,
  PROBLEM,
  SPONSOR,
} from "../support/publication-context";
import { syntheticScreeningObservation } from "../support/screening";

const BOUNDARIES = {
  scope: "  Exact integer scope.\nPreserve authored spacing.  ",
  out_of_scope: "Numerical approximations are outside this question.",
  success_criteria: "A complete proof for both residue classes.",
} satisfies ProblemStatementBoundaries;
type Fixture = Awaited<ReturnType<typeof fixture>>;

// Exercise the real immutable event/content and statement projection queries.
// The preexisting fixture is a migrated legacy S@1 without an admission event.
async function appendFormulation(
  f: Fixture,
  fields: Record<string, unknown> = BOUNDARIES,
  projection: ProblemStatementBoundaries = BOUNDARIES,
) {
  const member = f.command({ ...f.input(), fellowId: OTHER }, undefined, "E-BOUNDARY-SOURCE");
  return writeLedgerEvent(
    f.db,
    {
      ...member.input,
      eventType: "problem.statement-revised",
      objectKind: "problem",
      objectId: PROBLEM,
      objectVersion: 2,
      payloadJson: JSON.stringify({
        action: "revise-statement",
        acting_principal: { type: "sponsor", id: SPONSOR },
        source_fellow_id: OTHER,
        previous_status: "active",
        previous_statement_version: 1,
        problem: {
          id: PROBLEM,
          title: "Context problem",
          current_statement_version: 2,
          statement: "Exact public problem statement.",
          falsifier: "Exact public falsifier.",
          motivation: "Exact public motivation.",
          status: "active",
          updated_at: NOW(),
          ...fields,
        },
      }),
    },
    {
      statementsAfterEvent: () => [
        f.db
          .prepare(`INSERT INTO problem_statement_versions
        (problem_id,version,statement,norm_hash,falsifier,motivation,created_at,scope,out_of_scope,success_criteria)
        VALUES(?,2,'Exact public problem statement.','sha256:revised','Exact public falsifier.',
          'Exact public motivation.',?,?,?,?)`)
          .bind(
            PROBLEM,
            NOW(),
            projection.scope,
            projection.out_of_scope,
            projection.success_criteria,
          ),
        f.db
          .prepare("UPDATE problems SET current_statement_version = 2 WHERE id = ?")
          .bind(PROBLEM),
      ],
    },
  );
}

test("screening carries exact immutable boundary bytes into context, provider binding and retained cases", async () => {
  const f = await fixture();
  try {
    const source = await appendFormulation(f);
    const snapshot = await readPublicationContext(f.db, f.input());
    expect(snapshot.statement).toMatchObject(BOUNDARIES);
    const binding = await promotionScreeningBinding({
      ...f.input(),
      publicationContext: { snapshot, precedingCandidates: [] },
    });
    expect(JSON.parse(binding.body).context.problem_statement).toMatchObject(BOUNDARIES);
    expect(binding.contextualInput?.context.problem_statement?.source_event?.event_id).toBe(
      source.eventId,
    );
    const doc = ScreeningPublicationContextInputSchema.parse(
      publicationContextDocument({ snapshot, precedingCandidates: [] }),
    );
    expect(doc.problem_statement).toMatchObject(BOUNDARIES);
    expect(await storedPublicationContextIsVisible(f.db, doc)).toBe(true);
    const held = await screenPublicCandidate(
      (input) =>
        syntheticScreeningObservation(input, {
          decision: "quarantine",
          coarse_category: "operational-harm",
          provider_status: "ok",
        }),
      { DB: f.db } as Env,
      f.input(),
      { sponsorId: SPONSOR, route: "hypotheses" },
    );
    assert.ok(held instanceof Response);
    const hold = ScreeningPromotionHoldResponseSchema.parse(await held.json());
    assert.ok(hold.case_id);
    const detail = await operatorQuarantineCase(f.db, hold.case_id);
    expect(detail.status).toBe(200);
    expect(JSON.parse(await detail.text()).candidate.context.problem_statement).toMatchObject(
      BOUNDARIES,
    );
  } finally {
    f.sql.close();
  }
});

test("screening never invents legacy boundaries from retained projection fields", async () => {
  const f = await fixture();
  try {
    await appendFormulation(f, {});
    const snapshot = await readPublicationContext(f.db, f.input());
    const doc = publicationContextDocument({ snapshot, precedingCandidates: [] });
    for (const field of ["scope", "out_of_scope", "success_criteria"]) {
      expect(snapshot.statement).not.toHaveProperty(field);
      expect(doc.problem_statement).not.toHaveProperty(field);
    }
    expect(JSON.stringify(doc)).not.toContain(BOUNDARIES.success_criteria);
  } finally {
    f.sql.close();
  }
});

test("screening refuses malformed immutable boundary bundles instead of silently screening less context", async () => {
  for (const fields of [
    { scope: "Partial boundary" },
    { ...BOUNDARIES, out_of_scope: " \n" },
    { ...BOUNDARIES, success_criteria: "x".repeat(4097) },
  ]) {
    const f = await fixture();
    try {
      await appendFormulation(f, fields);
      await expect(readPublicationContext(f.db, f.input())).rejects.toThrow();
      const response = await f.screen();
      assert.ok(response instanceof Response);
      expect(response.status).toBe(503);
    } finally {
      f.sql.close();
    }
  }
});

for (const change of ["problem", PROBLEM, `${PROBLEM}@2`, "#1", "redacted"] as const)
  test(`boundary source ${change} protects fresh screens, old cases and transaction guards`, async () => {
    const f = await fixture();
    try {
      const source = await appendFormulation(f);
      const snapshot = await readPublicationContext(f.db, f.input());
      const doc = ScreeningPublicationContextInputSchema.parse(
        publicationContextDocument({ snapshot, precedingCandidates: [] }),
      );
      const candidate = f.input("Candidate screened with exact boundaries.");
      const screened = await f.screen(candidate);
      assert.ok(!(screened instanceof Response));
      if (change === "redacted") await redactEventContent(f.db, source.eventId, "privacy", NOW());
      else f.visible(change, "hidden");
      await expect(readPublicationContext(f.db, candidate)).rejects.toThrow();
      expect(await storedPublicationContextIsVisible(f.db, doc)).toBe(false);
      const before = f.state();
      await assert.rejects(f.write(candidate, screened), isScreeningContextStaleError);
      expect(f.state()).toEqual(before);
      if (change !== "redacted") {
        f.visible(change, "visible", 2);
        expect((await readPublicationContext(f.db, candidate)).statement).toMatchObject(BOUNDARIES);
        expect(await storedPublicationContextIsVisible(f.db, doc)).toBe(true);
      }
    } finally {
      f.sql.close();
    }
  });

test("source digest verification rejects corrupted boundary bytes on fresh and retained screening reads", async () => {
  const f = await fixture();
  try {
    await appendFormulation(f);
    const snapshot = await readPublicationContext(f.db, f.input());
    const doc = ScreeningPublicationContextInputSchema.parse(
      publicationContextDocument({ snapshot, precedingCandidates: [] }),
    );
    // Model a corrupt read without bypassing the immutable storage triggers.
    const corrupt = {
      prepare: f.db.prepare.bind(f.db),
      async batch(statements: Parameters<D1Database["batch"]>[0]) {
        return (await f.db.batch(statements)).map((result) => ({
          ...result,
          results: result.results.map((row) => {
            const value = row as Record<string, unknown>;
            return typeof value.source_json === "string"
              ? {
                  ...value,
                  source_json: value.source_json.replace("integer scope", "complex scope"),
                }
              : row;
          }),
        }));
      },
    } as D1Database;
    await expect(readPublicationContext(corrupt, f.input())).rejects.toThrow();
    expect(await storedPublicationContextIsVisible(corrupt, doc)).toBe(false);
  } finally {
    f.sql.close();
  }
});

test("boundary bytes are counted in the complete screening input budget", async () => {
  const f = await fixture();
  try {
    const full = {
      scope: "s".repeat(4096),
      out_of_scope: "o".repeat(4096),
      success_criteria: "c".repeat(4096),
    };
    await appendFormulation(f, full, full);
    const snapshot = await readPublicationContext(f.db, f.input());
    const input = { ...f.input(""), publicationContext: { snapshot, precedingCandidates: [] } };
    const initial = await promotionScreeningBinding(input);
    assert.ok(initial.contextualInput);
    const used = new TextEncoder().encode(JSON.stringify(initial.contextualInput)).byteLength;
    const exact = { ...input, statement: "x".repeat(MAX_PUBLICATION_SCREENING_BODY_BYTES - used) };
    const allowed = await promotionScreeningBinding(exact);
    expect(JSON.parse(allowed.body).context.problem_statement).toMatchObject(full);
    await expect(
      promotionScreeningBinding({ ...exact, statement: `${exact.statement}x` }),
    ).rejects.toThrow();
  } finally {
    f.sql.close();
  }
});
