import { expect, test } from "bun:test";
import { loadFellowCalibration } from "../../src/discovery/fellow-calibration.ts";
import { withdrawScientificInput } from "../../src/ledger/scientific-withdrawals.ts";
import { SESSION, sha, withdrawalFixture } from "./scientific-withdrawal-fixture.ts";

/** Canonical readers and withdrawal service on SQLite, with the shared
 * fixture's explicitly modeled writer/auth ports; not deployed D1 proof. */
for (const verdict of ["confirm", "refute"] as const) {
  test(`Fellow outcome retains a known ${verdict} review withdrawal when target standing is unavailable`, async () => {
    const f = withdrawalFixture();
    try {
      f.sql.exec(`ALTER TABLE events ADD COLUMN model_string_self_declared TEXT DEFAULT 'declared';
        ALTER TABLE events ADD COLUMN harness TEXT DEFAULT 'test';`);
      const statement = "Every n has the stated bound.";
      const falsifier = "A finite n violating the stated bound.";
      const kind = "conjecture";
      const body = JSON.stringify({
        claim_id: "C-1",
        statement,
        falsifier,
        kind,
        dependency_pins: [],
      });
      // Supply a coherent immutable claim pin to the shared reader fixture.
      f.sql.query("UPDATE events SET payload_sha256=? WHERE id='E-claim'").run(sha(body));
      f.sql
        .query("UPDATE event_content SET payload_sha256=?,payload_json=? WHERE event_id='E-claim'")
        .run(sha(body), body);
      f.sql
        .query(
          "UPDATE claim_versions SET content_digest=? WHERE problem_id='P-DEMO' AND claim_id='C-1'",
        )
        .run(`sha256:${sha(JSON.stringify({ falsifier, kind, statement }))}`);
      const review = f.source("review", "R-1", { verdict });
      const key = "P-DEMO/R-1";
      const before = await loadFellowCalibration(f.db, f.actor.fellowId);
      expect(before.reviewOutcomes.get(key)?.status).toBe("available");
      const withdrawal = await withdrawScientificInput(
        f.options,
        f.actor,
        SESSION,
        "review",
        review.id,
        review.request,
        "fellow-outcome",
      );
      const after = await loadFellowCalibration(f.db, f.actor.fellowId);
      expect(after.reviewOutcomes.get(key)?.withdrawn).toBe(true);
      expect(after.survivingReviews).not.toBe(1);
      const outcome = after.reviewOutcomes.get(key);
      if (outcome?.status === "available")
        expect(outcome.contribution).toBe(
          verdict === "refute" ? "adverse-finding" : "no-current-support",
        );
      let batches = 0;
      const racing = {
        ...f.db,
        async batch(...args: Parameters<typeof f.db.batch>) {
          const result = await f.db.batch(...args);
          if (++batches === 2)
            f.sql
              .query("UPDATE event_content SET redacted_at='removed' WHERE event_id=?")
              .run(withdrawal.event_id);
          return result;
        },
      } as typeof f.db;
      // Withhold the withdrawal after the scientific snapshot, without moving
      // public_seq. Its display fact must pass its own exact source fence.
      const changed = await loadFellowCalibration(racing, f.actor.fellowId);
      expect(changed.reviewOutcomes.size).toBe(0);
      expect(changed.omitted).toContain(
        "calibration outcomes affected by changed public sources are unavailable; retry the current Fellow card",
      );
      // Removal must not resurrect support, and an already withheld explanation
      // must not be relabeled as a readable per-review outcome.
      const redacted = await loadFellowCalibration(f.db, f.actor.fellowId);
      expect(redacted.reviewOutcomes.has(key)).toBe(false);
      expect(redacted.survivingReviews).toBeNull();
    } finally {
      f.close();
    }
  });
}
