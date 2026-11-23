import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { ensureProblem, writeLedgerEvent } from "../../src/krater/krater.ts";

/** Taxonomy fixtures need the same exact public source authority as production.
 * Source selection itself is exercised by the producer and Workerd journeys. */
export async function seedCitationReuseTaxonomyNotice(
  db: D1Database,
  problemId: string,
  origin: { fellowId: string; sponsorId: string },
  reuse: { fellowId: string; sponsorId: string },
): Promise<void> {
  const createdAt = new Date().toISOString();
  await ensureProblem(db, problemId, createdAt);
  await db.prepare("UPDATE problems SET status='active' WHERE id=?").bind(problemId).run();
  const sources = [];
  for (const [index, author] of [origin, reuse].entries()) {
    const citationId = `L-${index + 1}`;
    const eventId = `E-${problemId}-${citationId}`;
    const payload = JSON.stringify({
      citation_id: citationId,
      locator_kind: "doi",
      canonical_locator: "10.1234/taxonomy-source",
    });
    const digest = createHash("sha256").update(payload).digest("hex");
    await writeLedgerEvent(
      db,
      {
        problemId,
        eventId,
        idempotencyKey: eventId,
        requestDigest: digest,
        eventType: "citation.recorded",
        objectKind: "citation",
        objectId: citationId,
        objectVersion: 1,
        payloadJson: payload,
        createdAt,
        attribution: {
          fellowId: author.fellowId,
          sponsorId: author.sponsorId,
          sessionId: `SESSION-${index + 1}`,
          modelSelfDeclared: "taxonomy-fixture",
          harness: "inbox-taxonomy",
        },
      },
      { statementsAfterEvent: () => [] },
    );
    sources.push({ eventId, digest });
  }
  const [originSource, reuseSource] = sources;
  if (originSource === undefined || reuseSource === undefined) {
    throw new Error("CITATION_REUSE_FIXTURE_SOURCES_MISSING");
  }
  await db
    .prepare(`INSERT INTO citation_reuse_notice_sources
    (notice_id,origin_event_id,origin_sha256,reuse_event_id,reuse_sha256,created_at)
    VALUES (?,?,?,?,?,?)`)
    .bind(
      `N-citation-reused-${problemId}-L-2`,
      originSource.eventId,
      originSource.digest,
      reuseSource.eventId,
      reuseSource.digest,
      Date.now(),
    )
    .run();
}
