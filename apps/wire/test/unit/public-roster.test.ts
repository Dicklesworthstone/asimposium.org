import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { PUBLIC_PROBLEM_ROSTER_NOTICE } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { readPublicProblemRoster as readRosterSnapshot } from "../../src/problems/public-roster.ts";

const at = "2026-11-20T10:00:00.000Z";

async function readPublicProblemRoster(db: D1Database, problem: string, cursor: number) {
  return (await readRosterSnapshot(db, problem, cursor))?.roster ?? null;
}

// Executes production SQL against SQLite. Native Workerd coverage is separate.
function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE problems(id TEXT, public_seq INTEGER, status TEXT);
    CREATE TABLE enrollment_fellows(fellow_id TEXT, name TEXT, sponsor_id TEXT, status TEXT);
    CREATE TABLE problem_memberships(problem_id TEXT,fellow_id TEXT,role TEXT);
    CREATE TABLE sessions(fellow_id TEXT,problem_id TEXT,last_heartbeat_at TEXT,closed_at TEXT);
    CREATE TABLE events(id TEXT,problem_id TEXT,seq INTEGER,type TEXT,object_kind TEXT,object_id TEXT,
      object_version INTEGER,created_at TEXT,payload_sha256 TEXT,actor_fellow_id TEXT);
    CREATE INDEX events_fellow_publication_context_idx ON events(problem_id,actor_fellow_id,seq);
    CREATE TABLE event_content(event_id TEXT,payload_sha256 TEXT,payload_json TEXT,redacted_at TEXT);
    CREATE TABLE content_controls(problem_id TEXT,target_ref TEXT,version INTEGER,visibility TEXT);
    INSERT INTO problems VALUES ('P-ROSTER',200,'active');
    INSERT INTO enrollment_fellows VALUES ('F-a','alpha-fellow','usr_alpha','active');
    INSERT INTO problem_memberships VALUES ('P-ROSTER','F-a','contributor');`);
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all() {
              return { results: sqlite.query(sql).all(...(values as never[])) };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  function event(seq: number, type = "claim.created", payload: unknown = {}, fellow = "F-a") {
    sqlite
      .query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(
        `event-${seq}`,
        "P-ROSTER",
        seq,
        type,
        type.split(".")[0]!,
        `C-${seq}`,
        1,
        at,
        `digest-${seq}`,
        fellow,
      );
    sqlite
      .query("INSERT INTO event_content VALUES (?,?,?,NULL)")
      .run(`event-${seq}`, `digest-${seq}`, JSON.stringify(payload));
  }
  return { sqlite, db, event };
}

test("roster reports public membership, old heartbeat timestamps and only visible material increments", async () => {
  const { sqlite, db, event } = fixture();
  try {
    event(1);
    event(2, "session.closed", { handback: "PRIVATE-HANDBACK-CANARY" });
    event(3, "synthesis.created");
    event(4, "dead_end.recorded", { lint_flags: ["low-substance-dead-end"] });
    sqlite.query("INSERT INTO sessions VALUES ('F-a','P-ROSTER',?,NULL)").run(at);
    const roster = await readPublicProblemRoster(db, "P-ROSTER", 4);
    expect(roster?.members[0]).toEqual({
      fellow_id: "F-a",
      name: "alpha-fellow",
      current_sponsor_id: "usr_alpha",
      role: "contributor",
      open_session_heartbeat_at: at,
      last_public_increment: { seq: 1, type: "claim.created", created_at: at },
      increment_history_limited: false,
    });
    expect(JSON.stringify(roster)).not.toContain("PRIVATE-HANDBACK-CANARY");
    expect(JSON.stringify(roster)).not.toContain("online");
    event(5, "claim.revised");
    expect(
      (await readPublicProblemRoster(db, "P-ROSTER", 4))?.members[0]?.last_public_increment?.seq,
    ).toBe(1);
    expect(
      (await readPublicProblemRoster(db, "P-ROSTER", 5))?.members[0]?.last_public_increment?.seq,
    ).toBe(5);
    sqlite.exec("UPDATE sessions SET closed_at = '2026-11-20T10:01:00.000Z'");
    expect(
      (await readPublicProblemRoster(db, "P-ROSTER", 5))?.members[0]?.open_session_heartbeat_at,
    ).toBeNull();
  } finally {
    sqlite.close();
  }
});

test("current withdrawal, redaction, digest mismatch and private problems cannot disclose roster increments", async () => {
  const { sqlite, db, event } = fixture();
  try {
    event(1);
    event(2);
    sqlite.exec("INSERT INTO content_controls VALUES ('P-ROSTER','C-2@1',1,'hidden')");
    expect(
      (await readPublicProblemRoster(db, "P-ROSTER", 2))?.members[0]?.last_public_increment?.seq,
    ).toBe(1);
    expect(
      (await readPublicProblemRoster(db, "P-ROSTER", 2))?.members[0]?.increment_history_limited,
    ).toBe(true);
    sqlite.exec(
      "UPDATE event_content SET redacted_at = '2026-11-20T10:01:00.000Z' WHERE event_id = 'event-1'",
    );
    const member = (await readPublicProblemRoster(db, "P-ROSTER", 2))?.members[0];
    expect(member?.last_public_increment).toBeNull();
    expect(member?.increment_history_limited).toBe(true);
    sqlite.exec(
      "INSERT INTO content_controls VALUES ('P-ROSTER','C-2@1',2,'visible'); UPDATE event_content SET payload_sha256='wrong' WHERE event_id='event-2'",
    );
    expect(
      (await readPublicProblemRoster(db, "P-ROSTER", 2))?.members[0]?.last_public_increment,
    ).toBeNull();
    sqlite.exec("UPDATE problems SET status='private-draft'");
    expect(await readPublicProblemRoster(db, "P-ROSTER", 2)).toBeNull();
    sqlite.exec(
      "UPDATE problems SET status='active'; INSERT INTO content_controls VALUES ('P-ROSTER','problem',1,'hidden')",
    );
    expect(await readPublicProblemRoster(db, "P-ROSTER", 2)).toBeNull();
  } finally {
    sqlite.close();
  }
});

test("stable roster prefix and finite history disclose their bounds without ranking actors or inventing absence", async () => {
  const { sqlite, db, event } = fixture();
  try {
    for (let i = 0; i < 12; i++) {
      const fellow = `F-b${String(i).padStart(2, "0")}`;
      sqlite
        .query("INSERT INTO enrollment_fellows VALUES (?,?,?,'active')")
        .run(fellow, fellow, "usr_beta");
      sqlite.query("INSERT INTO problem_memberships VALUES ('P-ROSTER',?,'observer')").run(fellow);
    }
    event(1);
    for (let seq = 2; seq <= 70; seq++) event(seq, "session.closed");
    const roster = await readPublicProblemRoster(db, "P-ROSTER", 70);
    expect(roster?.members).toHaveLength(8);
    expect(roster?.has_more).toBe(true);
    expect(roster?.omitted).toEqual(["member_limit"]);
    expect(roster?.members[0]?.last_public_increment).toBeNull();
    expect(roster?.members[0]?.increment_history_limited).toBe(true);
    event(71, "review.created", { target_claim_id: "C-1", target_version: 1 });
    expect(
      (await readPublicProblemRoster(db, "P-ROSTER", 71))?.members[0]?.last_public_increment?.seq,
    ).toBe(71);
  } finally {
    sqlite.close();
  }
});

test("review and evidence increments follow current visibility of the exact target version", async () => {
  const { sqlite, db, event } = fixture();
  try {
    event(1);
    event(2, "review.created", { target_claim_id: "C-1", target_version: 1 });
    event(3, "evidence.created", { bears_on_id: "C-1", bears_on_version: 1 });
    expect(
      (await readPublicProblemRoster(db, "P-ROSTER", 3))?.members[0]?.last_public_increment?.seq,
    ).toBe(3);
    sqlite.exec("INSERT INTO content_controls VALUES ('P-ROSTER','C-1@1',1,'hidden')");
    const hidden = (await readPublicProblemRoster(db, "P-ROSTER", 3))?.members[0];
    expect(hidden?.last_public_increment).toBeNull();
    expect(hidden?.increment_history_limited).toBe(true);
    sqlite.exec(
      "INSERT INTO content_controls VALUES ('P-ROSTER','C-1@1',2,'visible'); UPDATE event_content SET redacted_at='2026-11-20T11:00:00.000Z' WHERE event_id='event-1'",
    );
    expect(
      (await readPublicProblemRoster(db, "P-ROSTER", 3))?.members[0]?.last_public_increment,
    ).toBeNull();
  } finally {
    sqlite.close();
  }
});

test("sharpening uses recorded event context and current sponsorship never rewrites scientific attribution", async () => {
  const { sqlite, db, event } = fixture();
  try {
    event(1, "problem.statement-reviewed", { previous_status: "sharpening" });
    event(2, "problem.statement-revised", { previous_status: "active" });
    expect(
      (await readPublicProblemRoster(db, "P-ROSTER", 2))?.members[0]?.last_public_increment?.seq,
    ).toBe(1);
    sqlite.exec("UPDATE enrollment_fellows SET sponsor_id='usr_new', status='paused'");
    const member = (await readPublicProblemRoster(db, "P-ROSTER", 2))?.members[0];
    expect(member?.current_sponsor_id).toBe("usr_new");
    expect(member?.last_public_increment?.seq).toBe(1);
    expect(member?.open_session_heartbeat_at).toBeNull();
  } finally {
    sqlite.close();
  }
});

test("unreadable sources are explicit and a genuinely empty roster is distinct", async () => {
  const { sqlite, db } = fixture();
  try {
    sqlite.exec("UPDATE enrollment_fellows SET sponsor_id='invalid'");
    expect(await readPublicProblemRoster(db, "P-ROSTER", 2)).toEqual({
      notice: PUBLIC_PROBLEM_ROSTER_NOTICE,
      members: [],
      has_more: false,
      omitted: ["source_unavailable"],
    });
    expect(await readPublicProblemRoster(db, "P-MISSING", 2)).toBeNull();
    sqlite.exec("UPDATE problem_memberships SET problem_id='P-OTHER'");
    expect(await readPublicProblemRoster(db, "P-ROSTER", 2)).toEqual({
      notice: PUBLIC_PROBLEM_ROSTER_NOTICE,
      members: [],
      has_more: false,
      omitted: [],
    });
  } finally {
    sqlite.close();
  }
});

test("unreadable newer materiality context cannot certify an older increment as the latest", async () => {
  const { sqlite, db, event } = fixture();
  try {
    event(1);
    event(2, "problem.statement-reviewed", {});
    let member = (await readPublicProblemRoster(db, "P-ROSTER", 2))?.members[0];
    expect(member?.last_public_increment?.seq).toBe(1);
    expect(member?.increment_history_limited).toBe(true);
    sqlite.exec("UPDATE events SET type='claim.created', object_kind='wrong-kind' WHERE seq=2");
    member = (await readPublicProblemRoster(db, "P-ROSTER", 2))?.members[0];
    expect(member?.last_public_increment?.seq).toBe(1);
    expect(member?.increment_history_limited).toBe(true);
    sqlite.exec("UPDATE events SET type='', object_kind='claim' WHERE seq=2");
    expect((await readPublicProblemRoster(db, "P-ROSTER", 2))?.omitted).toEqual([
      "source_unavailable",
    ]);
    sqlite.exec("UPDATE events SET type='claim.created', created_at='not-a-time' WHERE seq=2");
    expect((await readPublicProblemRoster(db, "P-ROSTER", 2))?.omitted).toEqual([
      "source_unavailable",
    ]);
  } finally {
    sqlite.close();
  }
});

test("Unicode membership order follows SQLite UTF-8 bytes, including supplementary characters", async () => {
  const { sqlite, db } = fixture();
  try {
    const earlier = "F-\uE000";
    const later = "F-\u{10000}";
    sqlite.query("UPDATE enrollment_fellows SET fellow_id=? WHERE fellow_id='F-a'").run(earlier);
    sqlite.query("UPDATE problem_memberships SET fellow_id=? WHERE fellow_id='F-a'").run(earlier);
    sqlite
      .query("INSERT INTO enrollment_fellows VALUES (?,'supplementary','usr_beta','active')")
      .run(later);
    sqlite.query("INSERT INTO problem_memberships VALUES ('P-ROSTER',?,'observer')").run(later);
    const roster = await readPublicProblemRoster(db, "P-ROSTER", 2);
    expect(roster?.members.map((member) => member.fellow_id)).toEqual([earlier, later]);
    expect(roster?.omitted).toEqual([]);
  } finally {
    sqlite.close();
  }
});

test("a scientific retraction does not erase or relabel the recorded material publication", async () => {
  const { sqlite, db, event } = fixture();
  try {
    event(1);
    event(2, "object.retracted", { target_ref: "C-1@1", reason: "Scientific withdrawal" });
    const roster = await readPublicProblemRoster(db, "P-ROSTER", 2);
    expect(roster?.members[0]?.last_public_increment?.seq).toBe(1);
    expect(roster?.notice).toContain("historical public activity, not current scientific standing");
    expect(roster?.notice).toContain("corrections or withdrawals may apply");
  } finally {
    sqlite.close();
  }
});

test("team annotation source includes members beyond the display prefix and the 129th sentinel", async () => {
  const { sqlite, db } = fixture();
  try {
    const add = (index: number) => {
      const fellow = `F-b${String(index).padStart(3, "0")}`;
      const sponsor = index < 7 ? "usr_alpha" : index === 127 ? "usr_last" : "usr_beta";
      sqlite
        .query("INSERT INTO enrollment_fellows VALUES (?,?,?,'active')")
        .run(fellow, fellow, sponsor);
      sqlite.query("INSERT INTO problem_memberships VALUES ('P-ROSTER',?,'observer')").run(fellow);
    };
    for (let index = 0; index < 8; index++) add(index);
    const nine = await readRosterSnapshot(db, "P-ROSTER", 2);
    expect(nine?.roster.members).toHaveLength(8);
    expect(nine?.roster.members.every((member) => member.current_sponsor_id === "usr_alpha")).toBe(
      true,
    );
    expect(JSON.parse(nine?.sponsorshipJson ?? "null")).toEqual([
      ...Array(8).fill("usr_alpha"),
      "usr_beta",
    ]);
    for (let index = 8; index < 128; index++) add(index);
    const overflow = await readRosterSnapshot(db, "P-ROSTER", 2);
    const source = JSON.parse(overflow?.sponsorshipJson ?? "null");
    expect(source).toHaveLength(129);
    expect(source[128]).toBe("usr_last");
    expect(overflow?.roster.members).toHaveLength(8);
    expect(JSON.stringify(overflow?.roster)).not.toContain("usr_last");
  } finally {
    sqlite.close();
  }
});
