import { createHash } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { claimContentDigest } from "../../src/krater/claim-version.ts";
import { writeLedgerEvent } from "../../src/krater/krater.ts";

/** Explicit immutable-publication fixture for read semantics. This bypasses
 * admission/screening and is never evidence of a scientific write journey. */
export async function appendClaimsListFixture(
  db: D1Database,
  problem: string,
  number: number,
  version = 1,
) {
  const id = `C-${number}`;
  const statement = `Let the fixture path ${number} have ${version} distinguished endpoints.`;
  const time = "2026-10-27T12:00:00.000Z";
  const contentDigest = await claimContentDigest(
    { kind: "definition", statement, falsifier: null },
    async (text) => createHash("sha256").update(text).digest("hex"),
  );
  return writeLedgerEvent(
    db,
    {
      problemId: problem,
      eventId: `EV-${problem}-${number}-${version}`,
      idempotencyKey: `fixture-${problem}-${number}-${version}`,
      requestDigest: "a".repeat(64),
      eventType: version === 1 ? "claim.created" : "claim.revised",
      objectKind: "claim",
      objectId: id,
      objectVersion: version,
      createdAt: time,
      payloadJson: JSON.stringify({
        claim_id: id,
        kind: "definition",
        statement,
        falsifier: null,
        ...(version > 1 ? { base_version: version - 1 } : {}),
      }),
      attribution: {
        fellowId: "F-CLAIMS-FIXTURE",
        sponsorId: "usr_claims_fixture",
        sessionId: "S-CLAIMS-FIXTURE",
        modelSelfDeclared: "synthetic",
        harness: "read-fixture",
      },
    },
    {
      statementsAfterEvent: (context) => [
        version === 1
          ? db
              .prepare(`INSERT INTO claims
        (id,problem_id,statement,payload_sha256,source_seq,created_at)
        VALUES(?,?,?,?,?,?)`)
              .bind(id, problem, statement, context.payloadSha256, context.sequence, time)
          : db
              .prepare(
                `UPDATE claims SET statement=?,payload_sha256=?,source_seq=? WHERE problem_id=? AND id=?`,
              )
              .bind(statement, context.payloadSha256, context.sequence, problem, id),
        db
          .prepare(`INSERT INTO claim_versions
        (claim_id,problem_id,version,kind,statement,falsifier,content_digest,editor_fellow_id,created_at)
        VALUES(?,?,?,'definition',?,NULL,?,'F-CLAIMS-FIXTURE',?)`)
          .bind(id, problem, version, statement, contentDigest, time),
      ],
    },
  );
}
