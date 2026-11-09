import { expect, test } from "bun:test";
import {
  type ProblemLifecycleActionRequest,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import { readSponsorDataExportPage } from "../../src/enrollment/account-export.ts";
import type { EnrollmentService, FellowCredentialBinding } from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import {
  hardDeletePrivateDraft,
  privateDraftDeletionStatements,
} from "../../src/krater/retention.ts";
import { applyPublicProblemGovernance } from "../../src/problems/lifecycle-ledger.ts";
import { readProblemPublicationPreview } from "../../src/problems/publication-preview.ts";
import { createProblemRouter } from "../../src/problems/router.ts";
import { r2Shaped } from "../support/bindings.ts";
import {
  FELLOW,
  PROBLEM,
  publicationContextFixture,
  SPONSOR,
} from "../support/publication-context.ts";

test("lawful fork erasure removes private content while retaining empty identity and public parent lineage", async () => {
  const f = await publicationContextFixture();
  try {
    f.sql
      .query("UPDATE problems SET status='private-draft', created_by_fellow_id=? WHERE id=?")
      .run(FELLOW, PROBLEM);
    const apply = (action: ProblemLifecycleActionRequest, key: string) =>
      applyPublicProblemGovernance(
        f.db,
        f.sql.query("SELECT * FROM problems WHERE id=?").get(PROBLEM) as Parameters<
          typeof applyPublicProblemGovernance
        >[1],
        SPONSOR,
        action,
        new Request("https://a.asimposium.org/lifecycle", {
          method: "POST",
          headers: { "idempotency-key": key },
        }),
      );
    const preview = await readProblemPublicationPreview(f.db, PROBLEM, SPONSOR);
    if (!preview) throw new Error("Expected a reviewable parent");
    expect(
      (
        await apply(
          {
            action: "publish",
            reviewed_statement_version: 1,
            reviewed_digest: preview.review_digest,
          },
          "publish-erasure-parent",
        )
      ).status,
    ).toBe(200);
    const boundaries = {
      scope: "PRIVATE-FORK-SCOPE",
      out_of_scope: "PRIVATE-FORK-EXCLUSIONS",
      success_criteria: "PRIVATE-FORK-SUCCESS",
    };
    const fork = await apply(
      {
        action: "fork",
        title: "Private fork investigation",
        statement: "PRIVATE-FORK-STATEMENT",
        ...boundaries,
      },
      "fork-for-erasure",
    );
    expect(fork.status).toBe(200);
    const forkBody: unknown = await fork.json();
    if (typeof forkBody !== "object" || forkBody === null || !("forked_problem_id" in forkBody))
      throw new Error("Expected the committed fork response to name its child problem");
    const child = PublicLedgerProblemIdSchema.parse(forkBody.forked_problem_id);
    const lineage = f.sql.query("SELECT * FROM problem_forks WHERE problem_id=?").get(child);
    const parentEvents = f.sql
      .query("SELECT * FROM events WHERE problem_id=? ORDER BY seq")
      .all(PROBLEM);
    expect(lineage).not.toBeNull();
    expect(f.sql.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    const now = Date.now();
    const binding: FellowCredentialBinding = {
      fellowId: FELLOW,
      sponsorId: SPONSOR,
      credentialId: "TOKEN-erasure",
      name: "erasure",
      model: "model",
      harness: "test",
      grantedScopes: [],
      grantedResources: {},
      tokenHash: "a".repeat(64),
      issuedAt: now - 1000,
      expiresAt: now + 60_000,
      credentialProfile: "bearer",
      fellowStatus: "active",
    };
    const routes = createProblemRouter({
      service: { credentialBinding: async () => binding } as unknown as EnrollmentService,
      verifiedSponsor: async () => new Response(null, { status: 403 }),
    });
    const read = () =>
      routes.fetch(
        new Request(`https://a.asimposium.org/v1/problems/${child}`, {
          headers: { authorization: "Bearer fixture" },
        }),
        { DB: f.db } as Env,
      );
    expect((await read()).status).toBe(200);

    const result = await hardDeletePrivateDraft(f.db, child, SPONSOR);
    expect(result.rowsDeleted).toMatchObject({ problem: 0, statementVersions: 1, stewards: 1 });
    expect(result.receipt.privateDraftContent).toBe(
      "erased-with-audit-and-quota-evidence-retained",
    );
    expect(f.sql.query("SELECT * FROM problem_forks WHERE problem_id=?").get(child)).toEqual(
      lineage,
    );
    expect(
      f.sql.query("SELECT * FROM events WHERE problem_id=? ORDER BY seq").all(PROBLEM),
    ).toEqual(parentEvents);
    expect(
      f.sql
        .query("SELECT COUNT(*) AS n FROM problem_statement_versions WHERE problem_id=?")
        .get(child),
    ).toEqual({ n: 0 });
    expect(
      f.sql
        .query(`SELECT status,public_seq,title,sponsor_id,created_by_fellow_id,
      forked_from_problem_id,forked_from_cursor,admission_mode FROM problems WHERE id=?`)
        .get(child),
    ).toEqual({
      status: "private-draft",
      public_seq: 0,
      title: "",
      sponsor_id: null,
      created_by_fellow_id: null,
      forked_from_problem_id: null,
      forked_from_cursor: null,
      admission_mode: "archived-read-only",
    });
    expect((await read()).status).toBe(404);
    const env = { DB: f.db, ARTIFACTS: r2Shaped() };
    const first = await readSponsorDataExportPage(env, SPONSOR, {});
    for (const section of ["private_problems", "private_statements"] as const) {
      const page = await readSponsorDataExportPage(env, SPONSOR, {
        cursor: { snapshot: first.snapshot, section, after: 0 },
      });
      expect(page.records).toEqual([]);
    }
    for (const sql of [
      "UPDATE problems SET title='revived' WHERE id=?",
      "UPDATE problems SET status='active' WHERE id=?",
      "INSERT INTO problem_statement_versions(problem_id,version,statement,norm_hash,falsifier,motivation,created_at) VALUES(?,1,'revived','hash','falsifier','motivation','2026-11-08T00:00:00.000Z')",
    ])
      expect(() => f.sql.query(sql).run(child)).toThrow("PRIVATE_DRAFT_ERASED");
    // Restore/replay of the same signed journal control remains idempotent.
    await f.db.batch(privateDraftDeletionStatements(f.db, result.controlRecord));
    expect(f.sql.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.sql.query("SELECT * FROM problem_forks WHERE problem_id=?").get(child)).toEqual(
      lineage,
    );
  } finally {
    f.sql.close();
  }
});
