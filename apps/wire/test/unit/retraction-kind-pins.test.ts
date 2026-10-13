import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import { determineRetractionKind } from "../../src/ledger/retractions";

// Execute the production classification SQL. This does not attest to the
// review-admission policy, promotion transaction, or a deployed D1 binding.
const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
function fixture() {
  const sql = new Database(":memory:");
  databases.push(sql);
  sql.exec(`CREATE TABLE reviews (
    problem_id TEXT, target_claim_id TEXT, target_version INTEGER,
    reviewer_fellow_id TEXT, verdict TEXT
  )`);
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      return {
        bind(...values: (string | number | null)[]) {
          return {
            async first() {
              queries.push(query);
              return sql.query(query).get(...values);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const review = (
    version = 3,
    verdict = "refute",
    reviewer = "F-reviewer",
    problem = "p",
    claim = "C-90",
  ) => {
    sql.query("INSERT INTO reviews VALUES (?, ?, ?, ?, ?)").run(
      problem,
      claim,
      version,
      reviewer,
      verdict,
    );
  };
  const kind = (target: string, problem = "p") =>
    determineRetractionKind(db, problem, target, "F-author");
  return { db, sql, queries, review, kind };
}

describe("version-specific correction credit preserves negative knowledge", () => {
  for (const verdict of ["refute", "fails-to-reproduce"]) {
    test(`an external ${verdict} on the exact pin is not relabelled self-corrected`, async () => {
      const { review, kind, queries } = fixture();
      review(3, verdict);
      expect(await kind("C-90@3")).toBe("externally-refuted");
      expect(queries).toHaveLength(1);
    });
  }

  for (const version of [1, 4]) {
    test(`a refutation of version ${version} cannot classify version 3`, async () => {
      const { review, kind } = fixture();
      review(version);
      expect(await kind("C-90@3")).toBe("self-corrected");
    });
  }

  test("an unpinned retraction retains the whole claim's negative history", async () => {
    const { review, kind } = fixture();
    review(1);
    expect(await kind("C-90")).toBe("externally-refuted");
  });

  test("an author's own refutation is not an external refutation", async () => {
    const { review, kind } = fixture();
    review(3, "refute", "F-author");
    expect(await kind("C-90@3")).toBe("self-corrected");
    expect(await kind("C-90")).toBe("self-corrected");
  });

  test("positive or inconclusive reviews do not remove self-correction credit", async () => {
    const { review, kind } = fixture();
    for (const verdict of ["support", "cannot-verify", "needs-work"]) review(3, verdict);
    expect(await kind("C-90@3")).toBe("self-corrected");
  });

  test("reviews are scoped to both the exact claim and the problem", async () => {
    const { review, kind } = fixture();
    review(3, "refute", "F-reviewer", "other");
    review(3, "refute", "F-reviewer", "p", "C-900");
    expect(await kind("C-90@3")).toBe("self-corrected");
    expect(await kind("C-90@3", "other")).toBe("externally-refuted");
  });

  test("mixed review history still finds the refutation of the exact version", async () => {
    const { review, kind } = fixture();
    review(2);
    review(3, "support");
    review(3, "refute", "F-author");
    review(3, "fails-to-reproduce", "F-external");
    expect(await kind("C-90@3")).toBe("externally-refuted");
  });

  test("no reviews means self-corrected for both target forms", async () => {
    const { kind } = fixture();
    expect(await kind("C-90")).toBe("self-corrected");
    expect(await kind("C-90@3")).toBe("self-corrected");
  });

  test("malformed pins are not normalized into somebody else's claim", async () => {
    const { review, kind } = fixture();
    review(3);
    for (const target of ["C-90@03", "C-90@3\n", "C-90@3 OR 1=1", "C-90@0", "C-90@-1"]) {
      expect(await kind(target)).toBe("self-corrected");
    }
  });

  test("unsafe integer pins cannot alias a rounded stored version", async () => {
    const { sql, kind } = fixture();
    sql.exec("INSERT INTO reviews VALUES ('p', 'C-90', 9007199254740992, 'F-reviewer', 'refute')");
    expect(await kind("C-90@9007199254740993")).toBe("self-corrected");
  });

  test("storage failure cannot manufacture self-correction credit", async () => {
    const db = {
      prepare() {
        throw new Error("classification unavailable");
      },
    } as unknown as D1Database;
    await expect(determineRetractionKind(db, "p", "C-90@3", "F-author")).rejects.toThrow(
      "classification unavailable",
    );
  });
});
