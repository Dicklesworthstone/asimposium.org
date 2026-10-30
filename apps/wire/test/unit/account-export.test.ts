import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SPONSOR_DATA_EXPORT_SECTIONS,
  type SponsorDataExportCursor,
  type SponsorDataExportResponse,
  SponsorDataExportResponseSchema,
} from "@asimposium/contracts/account-export";
import {
  AccountExportError,
  readSponsorDataExportPage,
} from "../../src/enrollment/account-export.ts";
import type { Env } from "../../src/env.ts";

const SPONSOR = "usr_export_owner";
const OTHER = "usr_export_other";
const FELLOW = "fellow-export-owner";
const NOW = "2026-10-25T12:00:00.000Z";
const SESSION = `S-${"A".repeat(26)}`;
const WORKSHOP = `W-${"A".repeat(26)}`;
const PRIVATE_BODY = "PRIVATE_EXPORT_FULL_BODY: ".repeat(120);

// SQL and storage fault unit tests. The separate Workerd journey exercises
// the mounted signed route with genuine D1/R2 bindings.
function fixture() {
  const sql = new Database(":memory:", { strict: true });
  const root = resolve(import.meta.dir, "../../../../db/migrations");
  for (const name of readdirSync(root)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sql.exec(readFileSync(resolve(root, name), "utf8"));
  sql
    .query("INSERT INTO sponsors(sponsor_id, created_at, last_seen_at) VALUES (?, 1000, 1000)")
    .run(SPONSOR);
  sql
    .query("INSERT INTO sponsors(sponsor_id, created_at, last_seen_at) VALUES (?, 1000, 1000)")
    .run(OTHER);
  sql
    .query(`INSERT INTO enrollment_fellows(fellow_id,sponsor_id,name,model,harness,created_at)
    VALUES (?,?,'export-vector','model/v1','harness',1000)`)
    .run(FELLOW, SPONSOR);
  sql
    .query(`INSERT INTO enrollment_fellows(fellow_id,sponsor_id,name,model,harness,created_at)
    VALUES ('fellow-other',?,'other-vector','model/v1','harness',1000)`)
    .run(OTHER);
  sql
    .query(`INSERT INTO problems(id,status,sponsor_id,title,created_at,updated_at)
    VALUES('P-EXPORT','private-draft',?,'Private formulation',?,?)`)
    .run(SPONSOR, NOW, NOW);
  sql
    .query(`INSERT INTO problem_statement_versions(problem_id,version,statement,norm_hash,falsifier,motivation,created_at)
    VALUES('P-EXPORT',1,'Private exact formulation','hash','Private failure condition','Private motivation',?)`)
    .run(NOW);
  sql
    .query(`INSERT INTO sessions(session_id,fellow_id,problem_id,intent,opened_at,last_heartbeat_at,idle_close_at)
    VALUES(?,?,'P-EXPORT','explore',?,?,?)`)
    .run(SESSION, FELLOW, NOW, NOW, NOW);
  const blobs = new Map<string, Uint8Array>();
  let onBodyRead: (() => void) | undefined;
  let rejectSql: string | undefined;
  const db = {
    prepare(query: string) {
      let values: (string | number | null)[] = [];
      const rows = () => {
        if (rejectSql && query.includes(rejectSql)) throw new Error("PRIVATE_DATABASE_FAILURE");
        return sql.query(query).all(...values);
      };
      return {
        bind(...bindings: (string | number | null)[]) {
          values = bindings;
          return this;
        },
        async all() {
          return { success: true, results: rows() };
        },
        async first() {
          return rows()[0] ?? null;
        },
      };
    },
  } as Env["DB"];
  const artifacts = {
    async get(key: string) {
      onBodyRead?.();
      const bytes = blobs.get(key);
      return bytes === undefined
        ? null
        : {
            size: bytes.byteLength,
            async arrayBuffer() {
              return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            },
            body: new ReadableStream(),
          };
    },
  } as unknown as Env["ARTIFACTS"];
  const env = { DB: db, ARTIFACTS: artifacts };
  const read = (cursor?: SponsorDataExportCursor, sponsor = SPONSOR) =>
    readSponsorDataExportPage(env, sponsor, cursor ? { cursor } : {}, Date.parse(NOW));
  return {
    sql,
    blobs,
    read,
    failSql(part: string) {
      rejectSql = part;
    },
    onBodyRead(callback: () => void) {
      onBodyRead = callback;
    },
    async addWorkshop(body = PRIVATE_BODY) {
      const digest = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
      ]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      blobs.set(`cas/sha256/${digest}`, new TextEncoder().encode(body));
      sql
        .query(`INSERT INTO workshop_objects(workshop_id,problem_id,fellow_id,session_id,workshop_seq,type,title,body_md,cas_hash,created_at)
        VALUES(?,'P-EXPORT',?,?,1,'scratch','Private route',?,?,?)`)
        .run(WORKSHOP, FELLOW, SESSION, body.slice(0, 280), `sha256:${digest}`, NOW);
      sql
        .query(`INSERT INTO workshop_revisions(workshop_id,version,problem_id,fellow_id,session_id,type,title,body_md,cas_hash,created_at)
        VALUES(?,1,'P-EXPORT',?,?,'scratch','Private route',?,?,?)`)
        .run(WORKSHOP, FELLOW, SESSION, body.slice(0, 280), `sha256:${digest}`, NOW);
      return digest;
    },
  };
}

async function all(f: ReturnType<typeof fixture>, sponsor = SPONSOR) {
  const pages: SponsorDataExportResponse[] = [];
  let cursor: SponsorDataExportCursor | undefined;
  do {
    const page = SponsorDataExportResponseSchema.parse(await f.read(cursor, sponsor));
    if (pages.length) expect(page.snapshot).toEqual(pages[0]!.snapshot);
    pages.push(page);
    cursor = page.next_cursor ?? undefined;
    if (pages.length > 100) throw new Error("Export did not terminate");
  } while (cursor);
  return pages;
}

test("all entitled work and immutable versions export with complete CAS bodies, not row extracts", async () => {
  const f = fixture();
  try {
    await f.addWorkshop();
    const pages = await all(f);
    expect(pages.map((page) => page.section)).toEqual([...SPONSOR_DATA_EXPORT_SECTIONS]);
    for (const kind of ["workshop", "workshop_history"] as const) {
      const record = pages.find((page) => page.section === kind)!.records[0]!;
      expect(record.kind).toBe(kind);
      if (record.kind === "workshop" || record.kind === "workshop_history")
        expect(record.data.object.body_md).toBe(PRIVATE_BODY);
    }
    const text = JSON.stringify(pages);
    expect(text).toContain("Private exact formulation");
    expect(text).not.toContain("other-vector");
    expect(text).not.toContain("cas_hash");
    const outsider = JSON.stringify(await all(f, OTHER));
    expect(outsider).not.toContain(PRIVATE_BODY);
    expect(outsider).not.toContain("Private exact formulation");
  } finally {
    f.sql.close();
  }
});

test("metadata keyset pagination is bounded, deterministic, and excludes enrollment secrets", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 43; index++)
      f.sql
        .query(`INSERT INTO enrollment_records(enrollment_id,sponsor_id,secret_hash,secret_expires_at,
        requested_scopes_json,requested_resources_json,created_at)
        VALUES(?,?,?,?,'["review"]','{}',?)`)
        .run(
          `ASIMP-EN-${String(index).padStart(26, "0")}`,
          SPONSOR,
          "a".repeat(64),
          9000 + index * 86_400_000,
          1000 + index * 86_400_000,
        );
    const pages = (await all(f)).filter((page) => page.section === "enrollments");
    expect(pages.map((page) => page.records.length)).toEqual([20, 20, 3]);
    expect(
      new Set(
        pages
          .flatMap((page) => page.records)
          .map((row) => (row.kind === "enrollments" ? row.data.enrollment_id : "wrong")),
      ).size,
    ).toBe(43);
    expect(JSON.stringify(pages)).not.toContain("a".repeat(64));
    assert.ok(pages[1]);
    expect(await f.read(pages[0]!.next_cursor!)).toEqual(pages[1]);
  } finally {
    f.sql.close();
  }
});

test("new or revised private work invalidates earlier export pages atomically", async () => {
  const f = fixture();
  try {
    await f.addWorkshop();
    const first = await f.read();
    f.sql
      .query("UPDATE workshop_objects SET title='Changed private route' WHERE workshop_id=?")
      .run(WORKSHOP);
    await expect(f.read(first.next_cursor!)).rejects.toMatchObject({ kind: "changed" });
    const second = await f.read();
    expect(second.snapshot.revision).toBeGreaterThan(first.snapshot.revision);
  } finally {
    f.sql.close();
  }
});

test("private changes during CAS hydration refuse the whole page", async () => {
  const f = fixture();
  try {
    await f.addWorkshop();
    const first = await f.read();
    f.onBodyRead(() =>
      f.sql
        .query("UPDATE workshop_objects SET title='Concurrent edit' WHERE workshop_id=?")
        .run(WORKSHOP),
    );
    await expect(
      f.read({ snapshot: first.snapshot, section: "workshop", after: 0 }),
    ).rejects.toMatchObject({ kind: "changed" });
  } finally {
    f.sql.close();
  }
});

test("missing and digest-detached CAS bytes fail without substituting the excerpt", async () => {
  const f = fixture();
  try {
    const digest = await f.addWorkshop();
    const first = await f.read();
    const cursor = { snapshot: first.snapshot, section: "workshop" as const, after: 0 };
    f.blobs.set(`cas/sha256/${digest}`, new TextEncoder().encode("wrong bytes"));
    await expect(f.read(cursor)).rejects.toBeInstanceOf(AccountExportError);
    f.blobs.clear();
    await expect(f.read(cursor)).rejects.toMatchObject({ kind: "unavailable" });
  } finally {
    f.sql.close();
  }
});

test("database faults cannot become a successful empty export section", async () => {
  const f = fixture();
  try {
    const first = await f.read();
    f.failSql("FROM sponsor_directives");
    await expect(
      f.read({ snapshot: first.snapshot, section: "directives", after: 0 }),
    ).rejects.toThrow();
  } finally {
    f.sql.close();
  }
});

test("heartbeat and sign-in telemetry do not invalidate an otherwise unchanged export", async () => {
  const f = fixture();
  try {
    const first = await f.read();
    f.sql.query("UPDATE sponsors SET last_seen_at=2000 WHERE sponsor_id=?").run(SPONSOR);
    f.sql
      .query("UPDATE sessions SET last_heartbeat_at='2026-10-25T12:01:00.000Z' WHERE session_id=?")
      .run(SESSION);
    expect((await f.read(first.next_cursor!)).snapshot).toEqual(first.snapshot);
  } finally {
    f.sql.close();
  }
});

test("tombstoning an account immediately refuses subsequent pages", async () => {
  const f = fixture();
  try {
    const first = await f.read();
    f.sql.query("UPDATE sponsors SET tombstoned_at=2000 WHERE sponsor_id=?").run(SPONSOR);
    await expect(f.read(first.next_cursor!)).rejects.toMatchObject({ kind: "missing" });
  } finally {
    f.sql.close();
  }
});

test("uncommitted source edits roll export revisions back with the source", async () => {
  const f = fixture();
  try {
    const first = await f.read();
    f.sql.exec("BEGIN");
    f.sql.query("UPDATE sponsors SET tombstoned_at=2000 WHERE sponsor_id=?").run(SPONSOR);
    f.sql.exec("ROLLBACK");
    expect((await f.read(first.next_cursor!)).snapshot).toEqual(first.snapshot);
  } finally {
    f.sql.close();
  }
});
