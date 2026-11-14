import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CitationItem } from "@asimposium/contracts/citations";
import {
  CLAIMS_LIST_SCHEMA_ID,
  type ClaimListEntry,
  type ClaimsListResponse,
} from "@asimposium/contracts/claims-list";
import { neutralizeUntrustedBody } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import type { CommittedCitationsRead } from "../../src/ledger/citation-read.ts";
import {
  type LiteraturePackDependencies,
  readLiteraturePack,
} from "../../src/sessions/literature-pack.ts";

// Composition fixtures only. The pack journey separately exercises the
// mounted production readers and real local Workerd/D1/R2 publications.
const db = {} as D1Database;
const PROBLEM = "P-LITERATURE";
const CURSOR = 100;
const created = "2026-11-14T00:00:00.000Z";

function citation(seq = 1, memory = false): CitationItem {
  return {
    citation_id: `L-${seq}`,
    problem_id: PROBLEM,
    version: 1,
    seq,
    title: "A recorded source",
    authors: ["Source author"],
    locator_kind: memory ? "model_memory" : "url",
    locator: memory ? null : "https://example.invalid/paper",
    excerpt: memory ? null : "An exact source excerpt.",
    retrieved_at: memory ? null : created,
    source_provenance: memory ? "model_memory" : "retrieved",
    unanchored: memory,
    norm_hash: `citation-${seq}`,
    author_fellow_id: "F-author",
    sponsor_id: "usr-author",
    session_id: "S-author",
    declared_model: "declared-model",
    harness: "declared-harness",
    created_at: created,
  };
}
function citationPage(citations: CitationItem[] = []): CommittedCitationsRead {
  return {
    problem: { id: PROBLEM, unlisted: 0 },
    cursor: CURSOR,
    after: 0,
    scanned_through: CURSOR,
    next_after: null,
    unanchored: null,
    citations,
    omitted: [],
  };
}
function claim(seq = 2, kind: ClaimListEntry["kind"] = "literature-claim"): ClaimListEntry {
  return {
    id: `C-${seq}`,
    version: 1,
    kind,
    statement: `The recorded source at L-1 states proposition ${seq}.`,
    source_seq: seq,
    created_at: created,
    stale: false,
  };
}
function claimPage(
  claims: ClaimListEntry[] = [],
  after = 0,
  next_after: number | null = null,
): ClaimsListResponse {
  return {
    schema: CLAIMS_LIST_SCHEMA_ID,
    problem_id: PROBLEM,
    cursor: CURSOR,
    after,
    scanned_through: next_after ?? claims.at(-1)?.source_seq ?? after,
    next_after,
    count: claims.length,
    claims,
    omitted: next_after === null ? [] : ["page_limit"],
  };
}
function deps(overrides: Partial<LiteraturePackDependencies> = {}): LiteraturePackDependencies {
  return {
    citations: async () => citationPage(),
    claims: async (_db, _problem, query) => ({
      face: claimPage([], query?.after ?? 0),
      unlisted: false,
    }),
    neutralize: (body) => neutralizeUntrustedBody(body).text,
    ...overrides,
  };
}
const read = (dependencies = deps()) => readLiteraturePack(db, PROBLEM, CURSOR, dependencies);

test("literature combines exact sources and relevant claim summaries without upgrading them", async () => {
  const calls: unknown[] = [];
  const result = await read(
    deps({
      citations: async (_db, problem, query) => {
        calls.push(["citations", problem, query]);
        return citationPage([citation(), citation(4, true)]);
      },
      claims: async (_db, problem, query) => {
        calls.push(["claims", problem, query]);
        return {
          face: claimPage([claim(), claim(3, "novelty-claim"), claim(5, "conjecture")]),
          unlisted: false,
        };
      },
    }),
  );
  assert.deepEqual(calls, [
    ["citations", PROBLEM, { through: CURSOR, limit: 20 }],
    ["claims", PROBLEM, { through: CURSOR, after: 0 }],
  ]);
  const records = result.candidates
    .filter((item) => item.scope === "ledger")
    .sort((a, b) => a.stable_prefix! - b.stable_prefix!);
  assert.deepEqual(
    records.map((item) => item.id),
    ["L-1@1", "C-2@1", "L-4@1", "C-3@1"],
  );
  assert.ok(records.every((item) => item.untrusted));
  const literature = JSON.parse(records[1]!.body);
  assert.equal(literature.kind, "literature-claim");
  assert.equal(literature.source, `/p/${PROBLEM}/claims/C-2@1.md?through=${CURSOR}`);
  assert.equal(literature.stale, false);
  assert.equal(literature.disposition, undefined);
  const memory = JSON.parse(records[2]!.body);
  assert.equal(memory.unanchored, true);
  assert.equal(memory.source_provenance, "model_memory");
  assert.equal(memory.retrieved_at, null);
  assert.equal(memory.sponsor_id, "usr-author");
  assert.ok(result.omitted.some((item) => item.reason === "profile_summary"));
});

test("literature advances across withheld claim heads and preserves real source omissions", async () => {
  const seen: number[] = [];
  const result = await read(
    deps({
      claims: async (_db, _problem, query) => {
        const after = query?.after ?? 0;
        seen.push(after);
        return {
          face:
            after === 0
              ? { ...claimPage([], 0, 8), omitted: ["page_limit", "content_unavailable"] }
              : claimPage([{ ...claim(9), version: 3, stale: true }], after),
          unlisted: false,
        };
      },
    }),
  );
  assert.deepEqual(seen, [0, 8]);
  const selected = result.candidates.find((item) => item.id === "C-9@3");
  assert.ok(selected);
  assert.equal(JSON.parse(selected.body).stale, true);
  assert.ok(result.omitted.some((item) => item.reason === "content_unavailable"));
  assert.ok(!result.omitted.some((item) => item.reason === "candidate_limit"));
});

test("bounded citation and claim windows expose usable cursor-pinned continuations", async () => {
  let claimCalls = 0;
  const result = await read(
    deps({
      citations: async () => ({
        ...citationPage([citation()]),
        scanned_through: 20,
        next_after: 20,
        omitted: ["The citation candidate page is bounded."],
      }),
      claims: async (_db, _problem, query) => {
        claimCalls++;
        const after = query?.after ?? 0;
        return { face: claimPage([], after, after + 8), unlisted: false };
      },
    }),
  );
  assert.equal(claimCalls, 2);
  assert.ok(
    result.omitted.some((item) =>
      item.detail.includes("citations.md?through=100&after=20&limit=20"),
    ),
  );
  assert.ok(result.omitted.some((item) => item.detail.includes("claims.md?through=100&after=16")));
  assert.ok(!result.candidates.some((item) => item.id === "SYS-literature-empty"));
});

test("a failed source does not erase the other public source or leak the failure", async () => {
  for (const failed of ["citations", "claims"] as const) {
    const result = await read(
      deps({
        citations: async () => {
          if (failed === "citations") throw new Error("PRIVATE-SQL-ROW");
          return citationPage([citation()]);
        },
        claims: async () => {
          if (failed === "claims") throw new Error("PRIVATE-SQL-ROW");
          return { face: claimPage([claim()]), unlisted: false };
        },
      }),
    );
    assert.equal(result.candidates.filter((item) => item.scope === "ledger").length, 1);
    assert.ok(result.omitted.some((item) => item.reason === `literature_${failed}_unavailable`));
    assert.ok(!JSON.stringify(result).includes("PRIVATE-SQL-ROW"));
    assert.ok(!result.candidates.some((item) => item.id === "SYS-literature-empty"));
  }
});

test("claim pages reject a changed cursor, wrong scope, loop and duplicate instead of mixing cuts", async () => {
  const faults = ["cursor", "scope", "loop", "duplicate"] as const;
  for (const fault of faults) {
    const result = await read(
      deps({
        citations: async () => citationPage([citation()]),
        claims: async (_db, _problem, query) => {
          const after = query?.after ?? 0;
          if (after === 0) return { face: claimPage([claim(2)], 0, 8), unlisted: false };
          let face = claimPage([claim(9)], after);
          if (fault === "cursor") face = { ...face, cursor: 101 };
          if (fault === "scope") face = { ...face, problem_id: "P-FOREIGN" };
          if (fault === "loop") face = { ...face, next_after: 8, omitted: ["page_limit"] };
          if (fault === "duplicate") face = { ...face, claims: [{ ...claim(9), id: "C-2" }] };
          return { face, unlisted: false };
        },
      }),
    );
    assert.deepEqual(
      result.candidates.filter((item) => item.scope === "ledger").map((item) => item.id),
      ["L-1@1"],
    );
    assert.ok(
      result.omitted.some((item) => item.reason === "literature_claims_unavailable"),
      fault,
    );
  }
});

test("corrupt publication screening provenance refuses the whole literature profile", async () => {
  for (const source of ["citations", "claims"] as const) {
    const dependencies = deps({
      [source]: async () => {
        throw new Error("PUBLIC_SCREENING_RECEIPT_UNAVAILABLE");
      },
    });
    await assert.rejects(read(dependencies), /PUBLIC_SCREENING_RECEIPT_UNAVAILABLE/);
  }
});

test("citation scope and missing public scope cannot become an empty bibliography", async () => {
  for (const problem of [null, { id: "P-FOREIGN", unlisted: 0 }]) {
    const result = await read(deps({ citations: async () => ({ ...citationPage(), problem }) }));
    assert.ok(result.omitted.some((item) => item.reason === "literature_citations_unavailable"));
    assert.ok(!result.candidates.some((item) => item.id === "SYS-literature-empty"));
  }
});

test("oversized citations remain exact references, never clipped source claims", async () => {
  const result = await read(
    deps({
      citations: async () =>
        citationPage([{ ...citation(), authors: Array(64).fill("x".repeat(200)) }]),
      neutralize: (body) => (body.length > 1000 ? body.repeat(2) : body),
    }),
  );
  const record = result.candidates.find((item) => item.kind === "citation");
  assert.ok(record);
  const body = JSON.parse(record.body);
  assert.equal(body.content_omitted, "whole-record-size-limit");
  assert.equal(body.source, `/p/${PROBLEM}/citations/L-1@1.md?through=${CURSOR}`);
  assert.equal(body.authors, undefined);
  assert.ok(result.omitted.some((item) => item.reason === "item_too_large"));
});

test("screening notices remain attached to the exact citation and claim publication", async () => {
  const notice = {
    category: "off-topic",
    action: "published-with-warning",
    notice: "off-scope",
  } as const;
  const result = await read(
    deps({
      citations: async () => citationPage([{ ...citation(), screening_notice: notice }]),
      claims: async () => ({
        face: claimPage([{ ...claim(), screening_notice: notice }]),
        unlisted: false,
      }),
    }),
  );
  const records = result.candidates.filter((item) => item.scope === "ledger");
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.deepEqual(record.screening_notice, notice);
    assert.equal(JSON.parse(record.body).screening_notice, undefined);
    assert.equal(record.untrusted, true);
  }
  assert.deepEqual(result.omitted, []);
});

test("only a fully available empty selection yields the honest empty baseline", async () => {
  const empty = await read();
  assert.ok(empty.candidates.some((item) => item.id === "SYS-literature-empty"));
  assert.deepEqual(empty.omitted, []);
  await assert.rejects(readLiteraturePack(db, PROBLEM, Number.MAX_SAFE_INTEGER + 1, deps()));
  await assert.rejects(readLiteraturePack(db, "../private", CURSOR, deps()));
});
