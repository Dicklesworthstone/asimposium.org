import { afterEach, expect, test } from "bun:test";
import type { Env } from "../../src/env.ts";
import { sha256Hex, writeLedgerEvent } from "../../src/krater/krater.ts";
import { loadProblemRetractions } from "../../src/ledger/retractions.ts";
import { createLedgerFaceRoutes } from "../../src/ledger-face.ts";
import {
  directiveDisclosureFixture,
  DISCLOSURE_PROBLEM as problemId,
  DISCLOSURE_SPONSOR as sponsorId,
} from "../support/directive-disclosure.ts";

type Fixture = Awaited<ReturnType<typeof directiveDisclosureFixture>>;
const fixtures: Fixture[] = [];
const reason = "Author correction: the finite boundary contradicts the original claim.";
const formats = ["json", "md", "html"] as const;
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close();
});

// All shipped migrations, legal enrollment and atomic event publication.
// Retraction payloads model admitted writes; this suite tests public reads.
async function fixture() {
  const f = await directiveDisclosureFixture();
  fixtures.push(f);
  return f;
}
async function publish(f: Fixture, retractionId = "R-1", extra: Record<string, unknown> = {}) {
  const payloadJson = JSON.stringify({
    retraction_id: retractionId,
    target_object: "C-1",
    retraction_kind: "self-corrected",
    reason,
    ...extra,
  });
  const eventId = `E-retraction-${crypto.randomUUID()}`,
    createdAt = new Date().toISOString();
  return writeLedgerEvent(
    f.db,
    {
      problemId,
      eventId,
      idempotencyKey: eventId,
      requestDigest: await sha256Hex(payloadJson),
      eventType: "object.retracted",
      objectKind: "retraction",
      objectId: retractionId,
      objectVersion: 1,
      payloadJson,
      createdAt,
      attribution: {
        fellowId: f.binding.fellowId,
        sponsorId,
        sessionId: "S-retraction",
        modelSelfDeclared: "test/model",
        harness: "curl",
      },
    },
    {
      statementsAfterEvent: ({ sequence }) => [
        f.db
          .prepare(
            `INSERT INTO retractions(retraction_id,problem_id,seq,target_object,retraction_kind,
      reason,author_fellow_id,created_at) VALUES(?,?,?,'C-1','self-corrected',?,?,?)`,
          )
          .bind(retractionId, problemId, sequence, reason, f.binding.fellowId, createdAt),
      ],
    },
  );
}
function control(f: Fixture, ref: string, visibility: "hidden" | "visible", version: number) {
  f.sql
    .query(`INSERT INTO content_controls(control_id,problem_id,target_kind,target_ref,
    visibility,source,reason_category,actor,reason,version,created_at)
    VALUES(?,?,'retraction',?,?,'operator','privacy','usr_operator','Fixture control.',?,?)`)
    .run(
      `CC-${crypto.randomUUID()}`,
      problemId,
      ref,
      visibility,
      version,
      new Date().toISOString(),
    );
}
function face(f: Fixture, format: string, init?: RequestInit) {
  return createLedgerFaceRoutes().request(
    `https://a.asimposium.org/p/${problemId}/retractions.${format}`,
    init,
    { DB: f.db } as Env,
  );
}

test("current retraction controls replace cached public bytes on every face", async () => {
  for (const kind of ["object", "version", "event"] as const) {
    const f = await fixture(),
      admitted = await publish(f);
    const etags = await Promise.all(
      formats.map(async (format) => (await face(f, format)).headers.get("etag") ?? ""),
    );
    const ref = kind === "object" ? "R-1" : kind === "version" ? "R-1@1" : `#${admitted.seq}`;
    control(f, ref, "hidden", 1);
    for (const [i, format] of formats.entries())
      for (const method of ["GET", "HEAD"]) {
        const response = await face(f, format, {
          method,
          headers: { "if-none-match": etags[i] ?? "" },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("etag")).not.toBe(etags[i]);
        expect(await response.text()).not.toContain(reason);
      }
    expect(f.sql.query("SELECT retraction_id FROM retractions").all()).toHaveLength(1);
    control(f, ref, "visible", 2);
    expect((await loadProblemRetractions(f.db, problemId)).retractions[0]?.reason).toBe(reason);
  }
});

test("retraction identity, target, classification and attribution come from immutable source", async () => {
  const f = await fixture(),
    admitted = await publish(f);
  f.sql
    .query(`UPDATE retractions SET reason='RETAINED-SECRET', target_object='PRIVATE-TARGET',
    retraction_kind='externally-refuted', author_fellow_id='forged-author', seq=999,
    created_at='forged-time'`)
    .run();
  const result = await loadProblemRetractions(f.db, problemId);
  expect(result.retractions[0]).toMatchObject({
    retraction_id: "R-1",
    target_object: "C-1",
    retraction_kind: "self-corrected",
    author_fellow_id: f.binding.fellowId,
    reason,
    seq: admitted.seq,
  });
  for (const format of formats) {
    const response = await face(f, format),
      text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain(reason);
    expect(text).not.toMatch(
      /RETAINED-SECRET|PRIVATE-TARGET|forged-author|forged-time|externally-refuted/,
    );
    expect(
      (await face(f, format, { headers: { "if-none-match": response.headers.get("etag") ?? "" } }))
        .status,
    ).toBe(304);
  }
});

test("whole-problem visibility precedes retraction conditional GET and HEAD", async () => {
  const f = await fixture();
  await publish(f);
  f.sql.query("UPDATE problems SET unlisted=1 WHERE id=?").run(problemId);
  const response = await face(f, "json"),
    etag = response.headers.get("etag") ?? "";
  expect(response.headers.get("x-robots-tag")).toContain("noindex");
  control(f, "problem", "hidden", 1);
  for (const format of formats)
    for (const method of ["GET", "HEAD"]) {
      const hidden = await face(f, format, { method, headers: { "if-none-match": etag } });
      expect(hidden.status).toBe(404);
      expect(await hidden.text()).not.toContain(reason);
    }
  control(f, "problem", "visible", 2);
  expect((await face(f, "json")).status).toBe(200);
});

test("unavailable retraction sources never resurrect retained bytes or invent an empty ledger", async () => {
  for (const mode of ["redacted", "corrupt", "missing"] as const) {
    const f = await fixture(),
      admitted = await publish(f);
    if (mode === "redacted") {
      f.sql
        .query(
          "UPDATE event_content SET payload_json='{}',redacted_at=?,redaction_reason='privacy' WHERE event_id=?",
        )
        .run(new Date().toISOString(), admitted.eventId);
    } else if (mode === "corrupt") {
      // Deliberate storage-corruption plant below the immutable write guard.
      f.sql.exec("DROP TRIGGER event_content_lawful_redaction_only");
      f.sql
        .query("UPDATE event_content SET payload_json='{}' WHERE event_id=?")
        .run(admitted.eventId);
    } else f.sql.query("DELETE FROM event_content WHERE event_id=?").run(admitted.eventId);
    for (const format of formats) {
      const response = await face(f, format),
        text = await response.text();
      expect(response.status).toBe(200);
      expect(text).not.toContain(reason);
      expect(text).toContain("unavailable");
      expect(text).not.toContain("No retractions recorded");
    }
  }
});

test("hidden retractions preserve bounded admission order and controls cannot repair mismatched identity", async () => {
  const f = await fixture();
  await publish(f);
  await publish(f, "R-2");
  control(f, "R-1", "hidden", 1);
  const page = await loadProblemRetractions(f.db, problemId, { limit: 1 });
  expect(page.retractions).toHaveLength(0);
  expect(page.omitted).toContain("truncated at limit of 1 retractions");
  expect(page.omitted).toContain("A retraction explanation is unavailable.");
  const other = await fixture();
  await publish(other, "R-3", { retraction_id: "R-FORGED" });
  expect((await loadProblemRetractions(other.db, problemId)).retractions).toHaveLength(0);
});
