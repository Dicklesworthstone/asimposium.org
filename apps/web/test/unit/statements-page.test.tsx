import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import {
  type PublicStatementVersion,
  STATEMENTS_SCHEMA_ID,
  type StatementHistoryResponse,
  type StatementResponse,
} from "@asimposium/contracts/statements";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("server-only", () => ({}));
const { stoaFetchStatementHistory, stoaFetchStatementVersion } = await import(
  "../../lib/public-statements"
);
const { default: StatementHistoryPage, generateMetadata: historyMetadata } = await import(
  "../../app/p/[slug]/history/page"
);
const { default: StatementPage, generateMetadata: statementMetadata } = await import(
  "../../app/p/[slug]/statements/[version]/page"
);
const { default: AliasPage, generateMetadata: aliasMetadata } = await import(
  "../../app/r/[...slug]/page"
);

function statement(version = 3, seq = 11, boundaries = false): PublicStatementVersion {
  return {
    version,
    title: `Prime factors, version ${version}`,
    statement: "For every integer $n > 1$, there exists a prime factor of $n$.",
    falsifier: "An integer greater than one with no prime factor.",
    motivation: "Make the quantified question and its limits explicit.",
    ...(boundaries
      ? {
          scope: "All integers $n > 1$. <img src=x onerror=alert(1)>",
          out_of_scope: "Efficient factorization and uniqueness of the factorization.",
          success_criteria: "A checked proof of existence, or a counterexample. END-OF-CRITERIA",
        }
      : {}),
    updated_at: "2026-11-08T12:00:00.000Z",
    source_fellow_id: "F-ORIGINAL",
    acting_principal: { type: "sponsor", id: "usr_publisher" },
    publication: { event_id: `EV-${seq}`, seq, payload_sha256: "a".repeat(64) },
  };
}
function history(patch: Partial<StatementHistoryResponse> = {}): StatementHistoryResponse {
  return {
    schema: STATEMENTS_SCHEMA_ID,
    problem_id: "P-DEMO",
    cursor: 40,
    after: 0,
    scanned_through: 40,
    next_after: null,
    count: 2,
    statements: [statement(), statement(5, 20, true)],
    omitted: [],
    ...patch,
  };
}
function exact(patch: Partial<StatementResponse> = {}): StatementResponse {
  return {
    schema: STATEMENTS_SCHEMA_ID,
    problem_id: "P-DEMO",
    cursor: 40,
    statement: statement(5, 20, true),
    ...patch,
  };
}
type Query = Readonly<Record<string, string | string[] | undefined>>;
const historyProps = (query: Query = {}) => ({
  params: Promise.resolve({ slug: "P-DEMO" }),
  searchParams: Promise.resolve(query),
});
const exactProps = (version = "5", query: Query = {}) => ({
  params: Promise.resolve({ slug: "P-DEMO", version }),
  searchParams: Promise.resolve(query),
});
const realFetch = globalThis.fetch;
let previousOrigin: string | undefined;
beforeEach(() => {
  previousOrigin = process.env.STOA_ORIGIN;
  process.env.STOA_ORIGIN = PRODUCTION_STOA_ORIGIN;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousOrigin === undefined) delete process.env.STOA_ORIGIN;
  else process.env.STOA_ORIGIN = previousOrigin;
});

test("published history renders complete immutable versions, safe mathematics and exact source links", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
    calls.push(String(url));
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(history());
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await StatementHistoryPage(historyProps()));
  for (const text of [
    "Statement history",
    "Falsifier",
    "Motivation",
    "Scope",
    "Out of scope",
    "Success criteria",
    "END-OF-CRITERIA",
    "F-ORIGINAL",
    "usr_publisher",
    "EV-20",
    "katex",
    "Private drafts are absent",
  ])
    expect(html).toContain(text);
  expect(html).toContain('href="/p/P-DEMO/statements/3?through=40"');
  expect(html).toContain('href="/p/P-DEMO/statements/5?through=40"');
  expect(html).toContain('href="/r/p/P-DEMO/events/20"');
  expect(html).toContain(
    `href="${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/statements.json?through=40&amp;after=0"`,
  );
  expect(html).toContain("does not record explicit scope");
  expect(html).not.toContain('data-statement-version="1"');
  expect(html).not.toContain('data-statement-version="4"');
  expect(html).not.toContain("<img");
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/statements.json`]);
});

test("a withheld history page keeps its continuation without inventing absent versions", async () => {
  globalThis.fetch = mock(async () =>
    Response.json(
      history({
        after: 10,
        scanned_through: 20,
        next_after: 20,
        count: 0,
        statements: [],
        omitted: ["page_limit", "content_unavailable"],
      }),
    ),
  ) as unknown as typeof fetch;
  const html = renderToStaticMarkup(
    await StatementHistoryPage(historyProps({ through: "40", after: "10" })),
  );
  expect(html).toContain("No readable versions were returned on this page");
  expect(html).toContain("Next published versions at this snapshot");
  expect(html).toContain('href="/p/P-DEMO/history?through=40&amp;after=20"');
  expect(html).toContain("No substitute version is shown");
  expect(html).not.toContain("data-statement-version=");
  expect(html).not.toContain("Prime factors");
});

test("history binds problem, continuation and cut and rejects contradictory source pages", async () => {
  let response: unknown = history();
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  expect(
    (await stoaFetchStatementHistory("P-DEMO", undefined, { through: "40", after: "0" })).state,
  ).toBe("ok");
  for (const patch of [
    { problem_id: "P-OTHER" },
    { cursor: 41 },
    { after: 1 },
    { count: 1 },
    { statements: [statement(5, 20), statement(3, 11)] },
    { statements: [statement(3, 11), statement(3, 20)] },
    { scanned_through: 19 },
    { next_after: 20 },
    { omitted: ["page_limit"] },
  ]) {
    response = { ...history(), ...patch };
    expect(
      await stoaFetchStatementHistory("P-DEMO", undefined, { through: "40", after: "0" }),
    ).toEqual({ state: "unavailable", reason: "invalid_response" });
  }
});

test("exact statement pages distinguish the revision's scientific author from its accepting steward", async () => {
  const response = exact();
  response.statement.scientific_author = {
    fellow_id: response.statement.source_fellow_id,
    sponsor_id: "usr_scientific_author",
    session_id: "S-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    model_self_declared: "revision/model <script>unsafe()</script>",
    harness: "revision-harness",
  };
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await StatementPage(exactProps("5", { through: "40" })));
  expect(html).toContain("Scientific authorship at submission");
  expect(html).toContain("usr_scientific_author");
  expect(html).toContain("usr_publisher");
  expect(html).toContain("S-01ARZ3NDEKTSV4RRFFQ69G5FAV");
  expect(html).toContain("Model (self-declared)");
  expect(html).toContain("revision/model &lt;script&gt;unsafe()&lt;/script&gt;");
  expect(html).not.toContain("<script>unsafe()</script>");

  response.statement.scientific_author.session_id = null;
  const initialHtml = renderToStaticMarkup(await StatementPage(exactProps("5", { through: "40" })));
  expect(initialHtml).toContain("Initial problem proposal, before a research session.");
  expect(initialHtml).toContain("usr_scientific_author");
  expect(initialHtml).not.toContain("S-01ARZ3NDEKTSV4RRFFQ69G5FAV");
});

test("exact statement pages retain the requested version and cut with complete boundary and warning context", async () => {
  const response = exact();
  response.statement.screening_notice = {
    category: "dual-use-boundary",
    action: "published-with-warning",
    notice: "screening-warning",
  };
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    calls.push(String(url));
    return Response.json(response);
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await StatementPage(exactProps("5", { through: "40" })));
  expect(html).toContain("Statement S@5");
  expect(html).toContain("END-OF-CRITERIA");
  expect(html).toContain("screening context notice: dual-use-boundary");
  expect(html).toContain("does not determine the scientific standing");
  expect(html).toContain('href="/p/P-DEMO/history?through=40"');
  expect(html).toContain(`href="${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/statements/5.md?through=40"`);
  expect(html).toContain("not a scientific result");
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/statements/5.json?through=40`]);
});

test("exact reads never accept a different problem, statement version, cut or partial boundary bundle", async () => {
  let response: unknown = exact();
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const patch of [
    { problem_id: "P-OTHER" },
    { cursor: 41 },
    { statement: statement(6, 20, true) },
    { statement: { ...statement(5, 20), scope: "A forged partial bundle." } },
    { statement: statement(5, 41, true) },
  ]) {
    response = { ...exact(), ...patch };
    expect(await stoaFetchStatementVersion("P-DEMO", "5", undefined, { through: "40" })).toEqual({
      state: "unavailable",
      reason: "invalid_response",
    });
  }
});

test("legacy exact publications preserve absent boundaries instead of borrowing the current formulation", async () => {
  globalThis.fetch = mock(async () =>
    Response.json(exact({ statement: statement() })),
  ) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await StatementPage(exactProps("3")));
  expect(html).toContain("Statement S@3");
  expect(html).toContain("does not record explicit scope");
  expect(html).not.toContain("END-OF-CRITERIA");
  expect(html).not.toContain(">Out of scope</h3>");
});

test("all four maximum-sized formulation bundles fit the bounded public transport without truncation", async () => {
  const large = "\u0001".repeat(8192);
  const boundary = "\u0002".repeat(4096);
  const statements = [1, 2, 3, 4].map((version) => ({
    ...statement(version, version),
    statement: large,
    falsifier: large,
    motivation: large,
    scope: boundary,
    out_of_scope: boundary,
    success_criteria: boundary,
  }));
  const response = history({ count: 4, statements });
  expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThan(1024 * 1024);
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  const result = await stoaFetchStatementHistory("P-DEMO");
  expect(result.state).toBe("ok");
  if (result.state !== "ok") throw new Error("Expected complete bounded statement history.");
  expect(result.data.statements).toEqual(statements);
});

test("current hiding and unlisted indexing apply even to previously readable historical versions", async () => {
  globalThis.fetch = mock(async () =>
    Response.json(exact(), { headers: { "x-robots-tag": "noindex, nofollow" } }),
  ) as unknown as typeof fetch;
  expect((await statementMetadata(exactProps("5", { through: "40" }))).robots).toEqual({
    index: false,
    follow: false,
  });
  expect(renderToStaticMarkup(await StatementPage(exactProps("5", { through: "40" })))).toContain(
    "stay out of search indexes",
  );
  globalThis.fetch = mock(async () =>
    Response.json({ status: 404, code: "PROBLEM_NOT_FOUND" }, { status: 404 }),
  ) as unknown as typeof fetch;
  await expect(StatementPage(exactProps("5", { through: "40" }))).rejects.toThrow(
    "NEXT_HTTP_ERROR_FALLBACK;404",
  );
  await expect(StatementHistoryPage(historyProps({ through: "40" }))).rejects.toThrow(
    "NEXT_HTTP_ERROR_FALLBACK;404",
  );
});

test("route misses and corrupt sources remain unavailable rather than appearing as empty history", async () => {
  for (const response of [
    new Response("Route not found", { status: 404 }),
    Response.json({ status: 500, code: "INTERNAL_ERROR" }, { status: 500 }),
    Response.json({ ...history(), count: 99 }),
  ]) {
    globalThis.fetch = mock(async () => response.clone()) as unknown as typeof fetch;
    const html = renderToStaticMarkup(
      await StatementHistoryPage(historyProps({ through: "40", after: "0" })),
    );
    expect(html).toContain("Public ledger data is temporarily unavailable");
    expect(html).toContain('name="through" value="40"');
    expect(html).not.toContain("No published statement versions");
    expect((await historyMetadata(historyProps())).robots).toEqual({ index: false, follow: false });
  }
});

test("malformed selectors and repeated, contradictory or unsupported queries stop before transport", async () => {
  const request = mock(async () => Response.json(history()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [
    { through: ["40", "41"] },
    { through: "040" },
    { through: "-1" },
    { through: "2", after: "3" },
    { after: "-1" },
    { arbitrary: "1" },
  ]) {
    expect((await stoaFetchStatementHistory("P-DEMO", undefined, query)).state).toBe("unavailable");
    expect(renderToStaticMarkup(await StatementHistoryPage(historyProps(query)))).toContain(
      "Invalid statement history view",
    );
  }
  for (const version of ["0", "05", "-1", "1.5", "9007199254740992", "../private"]) {
    expect((await stoaFetchStatementVersion("P-DEMO", version)).state).toBe("unavailable");
    await expect(StatementPage(exactProps(version))).rejects.toThrow(
      "NEXT_HTTP_ERROR_FALLBACK;404",
    );
  }
  expect(renderToStaticMarkup(await StatementPage(exactProps("5", { after: "0" })))).toContain(
    "Invalid statement cursor",
  );
  expect((await stoaFetchStatementVersion("private/draft", "5")).state).toBe("unavailable");
  expect(request).not.toHaveBeenCalled();
});

test("the retained statement alias redirects before generic parsing and preserves exact versions and cuts", async () => {
  const request = mock(async () => Response.json(history()));
  globalThis.fetch = request as unknown as typeof fetch;
  const props = {
    params: Promise.resolve({ slug: ["p", "P-DEMO", "statement", "5"] }),
    searchParams: Promise.resolve({ through: "40" }),
  };
  let redirectDigest = "";
  try {
    await AliasPage(props);
  } catch (error) {
    if (error !== null && typeof error === "object" && "digest" in error)
      redirectDigest = String(error.digest);
    else throw error;
  }
  expect(redirectDigest).toContain("NEXT_REDIRECT");
  expect(redirectDigest).toContain("/p/P-DEMO/statements/5?through=40");
  expect((await aliasMetadata(props)).alternates?.canonical).toBe(
    "https://asimposium.org/p/P-DEMO/statements/5?through=40",
  );
  expect(
    renderToStaticMarkup(
      await AliasPage({ ...props, searchParams: Promise.resolve({ through: "040" }) }),
    ),
  ).toContain("Invalid statement cursor");
  await expect(
    AliasPage({ params: Promise.resolve({ slug: ["p", "P-DEMO", "statement", "0"] }) }),
  ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  expect(request).not.toHaveBeenCalled();
});
