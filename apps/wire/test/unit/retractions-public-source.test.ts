import { afterEach, expect, test } from "bun:test";
import type { ScreeningPublicationNotice } from "@asimposium/contracts";
import { screeningNoticeText } from "@asimposium/render";
import type { Env } from "../../src/env.ts";
import { sha256Hex, writeLedgerEvent } from "../../src/krater/krater.ts";
import { loadProblemRetractions } from "../../src/ledger/retractions.ts";
import { createLedgerFaceRoutes } from "../../src/ledger-face.ts";
import {
  publicationProvenance,
  type ScreenedPublication,
  screeningPublicationStatements,
} from "../../src/screening/ingress.ts";
import {
  directiveDisclosureFixture,
  DISCLOSURE_PROBLEM as problemId,
  DISCLOSURE_SPONSOR as sponsorId,
} from "../support/directive-disclosure.ts";
import { syntheticScreeningObservation } from "../support/screening.ts";

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
async function publish(
  f: Fixture,
  retractionId = "R-1",
  extra: Record<string, unknown> = {},
  screened?: ScreenedPublication,
) {
  const payloadJson = JSON.stringify({
    retraction_id: retractionId,
    target_object: "C-1",
    retraction_kind: "self-corrected",
    reason,
    ...extra,
  });
  const eventId = `E-retraction-${crypto.randomUUID()}`,
    createdAt = new Date().toISOString();
  const requestDigest = await sha256Hex(payloadJson);
  return writeLedgerEvent(
    f.db,
    {
      problemId,
      eventId,
      idempotencyKey: eventId,
      requestDigest,
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
        ...(screened === undefined
          ? []
          : screeningPublicationStatements(f.db, screened, eventId, "S-retraction", requestDigest)),
      ],
    },
  );
}
async function warning(f: Fixture, category: "dual-use-boundary" | "off-topic") {
  const input = {
    problemId,
    fellowId: f.binding.fellowId,
    kind: "retraction",
    statement: reason,
    falsifier: null,
  };
  return publicationProvenance(
    input,
    await syntheticScreeningObservation(input, {
      decision: "allow-with-warning",
      coarse_category: category,
      provider_status: "ok",
    }),
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

test.each(["problem", problemId])(
  "whole-problem visibility %s precedes retraction conditional GET and HEAD",
  async (target) => {
    const f = await fixture();
    await publish(f, "R-1", {}, await warning(f, "dual-use-boundary"));
    f.sql.query("UPDATE problems SET unlisted=1 WHERE id=?").run(problemId);
    const response = await face(f, "json"),
      etag = response.headers.get("etag") ?? "";
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    control(f, target, "hidden", 1);
    for (const format of formats)
      for (const method of ["GET", "HEAD"]) {
        const hidden = await face(f, format, { method, headers: { "if-none-match": etag } });
        expect(hidden.status).toBe(404);
        const text = await hidden.text();
        expect(text).not.toContain(reason);
        expect(text).not.toContain("screening-warning");
        expect(text).not.toContain("Published with a screening context notice:");
      }
    control(f, target, "visible", 2);
    expect((await face(f, "json")).status).toBe(200);
  },
);

test("retraction notices come only from each exact publication receipt and precede its prose", async () => {
  for (const category of ["dual-use-boundary", "off-topic"] as const) {
    const f = await fixture(),
      receipt = await warning(f, category);
    await publish(f, "R-1", {}, receipt);
    // Legacy absence remains absence; authored content cannot supply a notice
    // or borrow the neighboring publication's trusted screening receipt.
    await publish(f, "R-2", { screening_notice: receipt.provenance.public_action });
    const notice = receipt.provenance.public_action as ScreeningPublicationNotice;
    const result = await loadProblemRetractions(f.db, problemId);
    expect(result.retractions[0]?.screening_notice).toEqual(notice);
    expect(result.retractions[1]?.screening_notice).toBeUndefined();
    for (const format of formats) {
      const response = await face(f, format);
      expect(response.status).toBe(200);
      const text = await response.text();
      if (format === "json") {
        const data = JSON.parse(text);
        expect(data.retractions[0].screening_notice).toEqual(notice);
        expect(data.retractions[1].screening_notice).toBeUndefined();
      } else {
        expect(text.indexOf(screeningNoticeText(notice))).toBeGreaterThan(-1);
        expect(text.indexOf(screeningNoticeText(notice))).toBeLessThan(text.indexOf(reason));
        expect(text.split(screeningNoticeText(notice))).toHaveLength(2);
      }
      expect(text).not.toMatch(/input_digest|context_digest|configuration_digest|policy_version/);
      expect(
        (
          await face(f, format, {
            headers: { "if-none-match": response.headers.get("etag") ?? "" },
          })
        ).status,
      ).toBe(304);
    }
  }
});

test("corrupt retraction screening provenance cannot return an unqualified explanation or cached success", async () => {
  const f = await fixture();
  const admitted = await publish(f, "R-1", {}, await warning(f, "dual-use-boundary"));
  const original = await face(f, "json");
  expect(original.status).toBe(200);
  const etag = original.headers.get("etag") ?? "";
  // Deliberate corruption below the immutable write guard: public reads must
  // not silently turn the damaged record into an ordinary publication.
  f.sql.exec("DROP TRIGGER screening_publications_no_update");
  f.sql
    .query("UPDATE screening_publications SET provenance_json='{}' WHERE event_id=?")
    .run(admitted.eventId);
  await expect(loadProblemRetractions(f.db, problemId)).rejects.toThrow(
    "PUBLIC_SCREENING_RECEIPT_UNAVAILABLE",
  );
  for (const format of formats) {
    const response = await face(f, format, { headers: { "if-none-match": etag } });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(reason);
  }
});

test("a warning receipt without its public notice cannot commit a retraction", async () => {
  const f = await fixture(),
    receipt = await warning(f, "dual-use-boundary");
  const before = f.sql.query("SELECT id,seq FROM events ORDER BY seq").all();
  const forged = {
    ...receipt,
    provenance: {
      ...receipt.provenance,
      public_action: { category: "benign-context", action: "published", notice: "none" },
    },
  } as ScreenedPublication;
  await expect(publish(f, "R-1", {}, forged)).rejects.toThrow("SCREENING_WARNING_INVALID");
  expect(f.sql.query("SELECT id,seq FROM events ORDER BY seq").all()).toEqual(before);
  expect(f.sql.query("SELECT retraction_id FROM retractions").all()).toEqual([]);
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
