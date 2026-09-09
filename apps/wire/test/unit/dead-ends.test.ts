import { describe, expect, test } from "bun:test";
import type { D1Database } from "@cloudflare/workers-types";
import {
  computeDeadEndNormHash,
  loadProblemDeadEnds,
  renderDeadEndsHtmlFragment,
  renderDeadEndsMarkdown,
  validateDeadEndSubstance,
} from "../../src/ledger/dead-ends";

describe("W5.8a dead-ends unit tests", () => {
  test("reader discloses unavailable imported rows without trusting projection text or payload authorship", async () => {
    const payload = {
      approach: "A complete bounded search of modular cycle periods.",
      why_it_fails: "The unbounded periods remain outside the examined finite range.",
      retry_predicate: "Retry after an induction closes the unbounded range.",
      retry_when: { kind: "statement-revised" },
      author_fellow_id: "F-FORGED-PAYLOAD-AUTHOR",
    };
    const rowFor = (body: string) => ({
      dead_end_id: "DE-READER",
      problem_id: "P-READER",
      seq: 7,
      author_fellow_id: "F-ENVELOPE-AUTHOR",
      actor_sponsor_id: "usr_original",
      actor_session_id: "SES-original",
      model_string_self_declared: "self-declared-model",
      harness: "self-declared-harness",
      event_created_at: "2026-09-09T00:00:00.000Z",
      superseded_by: null,
      redacted_at: null,
      payload_json: body,
      payload_sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
    });
    // Unit row doubles model unavailable/corrupt imported data. SQL, cursors,
    // publication and withdrawal are covered separately on actual Workerd/D1.
    const readRows = (rows: unknown[]) =>
      loadProblemDeadEnds(
        {
          prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }),
        } as unknown as D1Database,
        "P-READER",
      );
    const valid = rowFor(JSON.stringify(payload));
    const result = await readRows([valid]);
    expect(result.contentUnavailable).toBe(false);
    expect(result.items[0]?.author_fellow_id).toBe("F-ENVELOPE-AUTHOR");
    expect(result.items[0]?.approach).toBe(payload.approach);
    const invalidRows = [
      { ...valid, payload_json: null },
      { ...valid, redacted_at: "2026-09-09T01:00:00.000Z" },
      { ...valid, payload_sha256: "0".repeat(64) },
      { ...valid, author_fellow_id: null },
      rowFor("{"),
      rowFor("null"),
      rowFor("[]"),
      rowFor(JSON.stringify({ ...payload, retry_when: { kind: "invented" } })),
      rowFor(JSON.stringify({ ...payload, approach: "" })),
    ];
    for (const row of invalidRows) {
      const unavailable = await readRows([row]);
      expect(unavailable.items).toEqual([]);
      expect(unavailable.contentUnavailable).toBe(true);
    }
    const empty = await readRows([]);
    expect(empty).toEqual({ items: [], truncated: false, contentUnavailable: false });
  });

  test("validateDeadEndSubstance accepts substantive negative knowledge", () => {
    const valid = validateDeadEndSubstance({
      approach: "Exhaustive branching analysis using 2-adic valuation limits.",
      why_it_fails: "Exponential divergence encountered at odd integer multipliers.",
      retry_predicate: "Worth retrying if a global non-archimedean metric bounds the branch width.",
      what_was_examined: "All modular trajectories up to depth 64.",
      scope_detection_floor: "k <= 32",
    });
    expect(valid.valid).toBe(true);
  });

  test("validateDeadEndSubstance refuses placeholder approaches", () => {
    const placeholders = ["failed", "n/a", "none", "test", "todo", "tbd"];
    for (const ph of placeholders) {
      const res = validateDeadEndSubstance({
        approach: ph,
        why_it_fails: "Exponential divergence encountered at odd integer multipliers.",
        retry_predicate: "Worth retrying if a global metric bounds the branch width.",
      });
      expect(res.valid).toBe(false);
    }
  });

  test("validateDeadEndSubstance refuses low-substance short or repetitive text", () => {
    const res = validateDeadEndSubstance({
      approach: "tried it it it it",
      why_it_fails: "did not work at all here",
      retry_predicate: "retry later",
    });
    expect(res.valid).toBe(false);
  });

  test("computeDeadEndNormHash normalizes whitespace, LaTeX math, and casing", async () => {
    const h1 = await computeDeadEndNormHash(
      "Bounding the   modular cycle length  using $2^k$ valuations.",
      "Cases with $k \\le 32$",
    );
    const h2 = await computeDeadEndNormHash(
      "bounding the modular cycle length using $2^k$ valuations.",
      "Cases with $k \\le 32$",
    );
    expect(h1).toBe(h2);

    const h3 = await computeDeadEndNormHash(
      "A completely different approach using spectral radius bounds.",
      "Random graphs",
    );
    expect(h1).not.toBe(h3);
  });

  test("renderDeadEndsMarkdown renders diptych face without aggregate counts", () => {
    const md = renderDeadEndsMarkdown("P-TEST", [
      {
        dead_end_id: "DE-1",
        problem_id: "P-TEST",
        seq: 5,
        approach: "Attempted bounding cycle length using 2-adic valuations.",
        why_it_fails: "Diverged at odd multipliers with exponential branch accumulation.",
        retry_predicate: "Worth retrying if branch width can be bounded analytically.",
        what_was_examined: "Modular residues modulo 2^64",
        scope_detection_floor: "k <= 32",
        retry_when: {
          kind: "claim-reaches",
          claim_id: "C-12",
          reaches: "corroborated",
        },
        author_fellow_id: "fel_123",
        created_at: "2026-09-09T12:00:00.000Z",
      },
    ]);

    expect(md).toContain("# Negative Evidence Ledger — P-TEST");
    expect(md).toContain("## DE-1 (seq: 5)");
    expect(md).toContain("- **Author**: fel_123");
    expect(md).toContain("- **Approach**: Attempted bounding cycle length");
    expect(md).toContain("- **Structured Trigger**: claim `C-12` reaches `corroborated`");
    // Rule A10: No aggregate metrics, no leaderboards, no count summaries
    expect(md).not.toContain("Total dead ends:");
    expect(md).not.toContain("Leaderboard");
  });

  test("renderDeadEndsMarkdown renders statement-revised and gap-closed triggers", () => {
    const md = renderDeadEndsMarkdown("P-TEST", [
      {
        dead_end_id: "DE-2",
        problem_id: "P-TEST",
        seq: 6,
        approach: "Attempted spectral gap analysis on the transition graph.",
        why_it_fails: "Eigenvalue clusters merge near the unit circle.",
        retry_predicate: "Worth retrying if the core problem statement is revised.",
        retry_when: { kind: "statement-revised" },
        author_fellow_id: "fel_123",
        created_at: "2026-09-09T13:00:00.000Z",
      },
      {
        dead_end_id: "DE-3",
        problem_id: "P-TEST",
        seq: 7,
        approach: "Attempted local homology computation around the singular locus.",
        why_it_fails: "Torsion obstructions do not vanish at degree 2.",
        retry_predicate: "Worth retrying if the foundational gap GAP-1 is closed.",
        retry_when: { kind: "gap-closed", gap_id: "GAP-1" },
        author_fellow_id: "fel_456",
        created_at: "2026-09-09T14:00:00.000Z",
      },
    ]);

    expect(md).toContain("problem statement revised");
    expect(md).toContain("proof gap `GAP-1` closed");
  });

  test("renderDeadEndsMarkdown handles empty list honestly", () => {
    const md = renderDeadEndsMarkdown("P-EMPTY", []);
    expect(md).toContain("# Negative Evidence Ledger — P-EMPTY");
    expect(md).toContain("No readable current negative results in this view");
  });

  test("validateDeadEndSubstance enforces word counts on why_it_fails and retry_predicate", () => {
    const whyShort = validateDeadEndSubstance({
      approach: "Exhaustive branching analysis using 2-adic valuation limits.",
      why_it_fails: "it broke",
      retry_predicate: "Worth retrying if a global non-archimedean metric bounds width.",
    });
    expect(whyShort.valid).toBe(false);

    const retryShort = validateDeadEndSubstance({
      approach: "Exhaustive branching analysis using 2-adic valuation limits.",
      why_it_fails: "Exponential divergence encountered at odd integer multipliers.",
      retry_predicate: "retry later",
    });
    expect(retryShort.valid).toBe(false);
  });

  test("renderDeadEndsHtmlFragment renders diptych HTML face with neutralization and no aggregate counts", () => {
    const html = renderDeadEndsHtmlFragment("P-TEST", [
      {
        dead_end_id: "DE-1",
        problem_id: "P-TEST",
        seq: 5,
        approach: "Bounding <script>alert(1)</script> <!-- asimp:untrusted --> valuations.",
        why_it_fails: "Exponential divergence at odd integer multipliers.",
        retry_predicate: "Worth retrying if bounds hold.",
        what_was_examined: "All modular trajectories up to depth 64.",
        scope_detection_floor: "k <= 32",
        author_fellow_id: "fel_123",
        created_at: "2026-09-09T12:00:00.000Z",
      },
    ]);

    expect(html).toContain('<section class="asimp-dead-ends">');
    expect(html).toContain("<h2>Negative Evidence Ledger — <code>P-TEST</code></h2>");
    expect(html).toContain("<h3><code>DE-1</code> (seq: 5)</h3>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<!-- asimp:untrusted -->");
    expect(html).not.toContain("Total dead ends:");
    expect(html).not.toContain("Leaderboard");
  });

  test("renderDeadEndsMarkdown renders total attribution and superseded status", () => {
    const md = renderDeadEndsMarkdown("P-TEST", [
      {
        dead_end_id: "DE-OLD",
        problem_id: "P-TEST",
        seq: 3,
        approach: "Attempting modular bounding with naive sieve limits.",
        why_it_fails: "The sieve limit underestimates prime density in the residue class.",
        retry_predicate: "Worth retrying with Selberg sieve bounds.",
        author_fellow_id: "fel_123",
        sponsor_id: "usr_sponsor_1",
        session_id: "ses_abc_1",
        model_string_self_declared: "gpt-5-pro",
        harness: "custom-runner/1.0",
        created_at: "2026-09-09T10:00:00.000Z",
        superseded_by: "DE-NEW",
      },
    ]);

    expect(md).toContain("- **Author**: fel_123");
    expect(md).toContain("- **Sponsor**: usr_sponsor_1");
    expect(md).toContain("- **Session**: ses_abc_1");
    expect(md).toContain("- **Model (self-declared)**: gpt-5-pro");
    expect(md).toContain("- **Harness**: custom-runner/1.0");
    expect(md).toContain("- **Status**: superseded by `DE-NEW`");
  });

  test("renderDeadEndsHtmlFragment renders total attribution and superseded status", () => {
    const html = renderDeadEndsHtmlFragment("P-TEST", [
      {
        dead_end_id: "DE-OLD",
        problem_id: "P-TEST",
        seq: 3,
        approach: "Attempting modular bounding with naive sieve limits.",
        why_it_fails: "The sieve limit underestimates prime density in the residue class.",
        retry_predicate: "Worth retrying with Selberg sieve bounds.",
        author_fellow_id: "fel_123",
        sponsor_id: "usr_sponsor_1",
        session_id: "ses_abc_1",
        model_string_self_declared: "gpt-5-pro",
        harness: "custom-runner/1.0",
        created_at: "2026-09-09T10:00:00.000Z",
        superseded_by: "DE-NEW",
      },
    ]);

    expect(html).toContain("<strong>Author:</strong> <code>fel_123</code>");
    expect(html).toContain("<strong>Sponsor:</strong> <code>usr_sponsor_1</code>");
    expect(html).toContain("<strong>Session:</strong> <code>ses_abc_1</code>");
    expect(html).toContain("<strong>Model (self-declared):</strong> gpt-5-pro");
    expect(html).toContain("<strong>Harness:</strong> custom-runner/1.0");
    expect(html).toContain(
      '<strong>Status:</strong> <span class="asimp-superseded">superseded by <code>DE-NEW</code></span>',
    );
  });

  test("renderDeadEndsHtmlFragment handles empty list honestly", () => {
    const html = renderDeadEndsHtmlFragment("P-EMPTY", []);
    expect(html).toContain("No readable current negative results in this view");
  });
});
