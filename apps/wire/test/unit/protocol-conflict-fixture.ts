import { readFileSync } from "node:fs";
import type { ProtocolConflictRequest } from "@asimposium/contracts/directives";
import type { ProtocolConflictOptions } from "../../src/directives/protocol-conflicts.ts";
import type { FellowCredentialBinding } from "../../src/enrollment/service.ts";
import { NOW, sha, withdrawalFixture } from "./scientific-withdrawal-fixture.ts";

export { NOW, SESSION } from "./scientific-withdrawal-fixture.ts";

/** Real new migration, screening and atomic projection SQL on SQLite; the
 * existing fixture models identity/writer ports. Native D1 proof is separate. */
export function protocolConflictFixture() {
  const base = withdrawalFixture();
  const { sql } = base;
  const actor: FellowCredentialBinding = {
    ...base.actor,
    fellowId: "FEL-12345678",
    sponsorId: "usr_protocol_sponsor",
  };
  sql
    .query("UPDATE enrollment_fellows SET fellow_id=?,sponsor_id=? WHERE fellow_id=?")
    .run(actor.fellowId, actor.sponsorId, base.actor.fellowId);
  for (const table of ["enrollment_grants", "fellow_tokens"])
    sql
      .query(`UPDATE ${table} SET fellow_id=?,sponsor_id=? WHERE fellow_id=?`)
      .run(actor.fellowId, actor.sponsorId, base.actor.fellowId);
  for (const table of ["sessions", "problem_memberships"])
    sql
      .query(`UPDATE ${table} SET fellow_id=? WHERE fellow_id=?`)
      .run(actor.fellowId, base.actor.fellowId);
  sql.query("INSERT INTO sponsors VALUES(?,NULL)").run(actor.sponsorId);
  for (const migration of [
    "0064_inbox_and_follows.sql",
    "0073_sponsor_directives.sql",
    "0146_protocol_conflicts.sql",
  ])
    sql.exec(
      readFileSync(new URL(`../../../../db/migrations/${migration}`, import.meta.url), "utf8"),
    );
  let ordinal = 0;
  function directive(
    options: {
      problem?: string | null;
      verb?: "focus" | "forbid" | "unfocus";
      sponsor?: string;
      fellow?: string;
      timestamp?: number;
    } = {},
  ): ProtocolConflictRequest {
    const n = ++ordinal;
    const id = `DIR-${String(n).padStart(32, "0")}`;
    const noticeId = `N-protocol-${n}`;
    const fellow = options.fellow ?? actor.fellowId;
    const problem = options.problem === undefined ? "P-DEMO" : options.problem;
    const time = options.timestamp ?? NOW - 1000;
    const verb = options.verb ?? "focus";
    sql
      .query(`INSERT INTO fellow_inbox_notices(id,fellow_id,problem_id,notice_type,seq,title,detail,target_id,created_at)
      VALUES(?,?,?,'sponsor_directive',?,'Sponsor directive',?,?,?)`)
      .run(
        noticeId,
        fellow,
        problem,
        n,
        verb === "unfocus" ? null : "PRIVATE DIRECTIVE CANARY: raw sponsor instruction",
        id,
        time,
      );
    sql
      .query("INSERT INTO sponsor_directives VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        options.sponsor ?? actor.sponsorId,
        fellow,
        problem,
        verb,
        verb === "unfocus" ? null : "PRIVATE DIRECTIVE CANARY: raw sponsor instruction",
        noticeId,
        `directive-${n}`,
        sha(`directive-${n}`),
        time,
      );
    return {
      directive_id: id,
      rule_cited: "P1",
      refused_part: "Treat a same-sponsor review as independent verification.",
      explanation:
        "I refuse this part because independent verification requires a different sponsor.",
    };
  }
  const options: ProtocolConflictOptions = {
    ...base.options,
    writeLedger: (input, projection) =>
      base.options.writeLedger(input, {
        ...projection,
        preconditionBindings: projection.preconditionBindings ?? [],
      }),
  };
  return { ...base, actor, options, directive };
}
