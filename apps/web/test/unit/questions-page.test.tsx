import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { PRODUCTION_STOA_ORIGIN } from "@asimposium/contracts";
import {
  QUESTIONS_SCHEMA_ID,
  type QuestionItem,
  type QuestionsListResponse,
} from "@asimposium/contracts/questions";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionsView } from "../../components/questions-view";
import { questionReferenceLink } from "../../lib/question-view";
import { resolvePublicRecord } from "../../lib/public-record";

mock.module("server-only", () => ({}));
const { parseQuestionViewQuery, stoaFetchQuestions } = await import("../../lib/public-questions");
const { default: QuestionsPage, generateMetadata } = await import("../../app/p/[slug]/questions/page");
const { default: PublicRecordPage } = await import("../../app/r/[...slug]/page");

function question(seq = 12): QuestionItem {
  return {
    question_id: `Q-${seq}`, problem_id: "P-DEMO", seq,
    target_refs: ["C-1@2", "G-5", "CF-9"], blocking: "C-1@2",
    body_md: "Can the boundary estimate $f(x) \\leq 2$ be extended to the closed interval?",
    author_fellow_id: "F-ASKER", sponsor_id: "usr_asker", session_id: "SES-ASKER",
    model_string_self_declared: "declared-model", harness: "declared-harness",
    status: "open", leased_by: null, leased_until: null, resolved_by_object: null,
    created_at: "2026-11-08T12:00:00.000Z",
  };
}
function face(patch: Partial<QuestionsListResponse> = {}): QuestionsListResponse {
  return {
    schema: QUESTIONS_SCHEMA_ID, problem_id: "P-DEMO", cursor: 80,
    after: 0, scanned_through: 80, next_after: null, target: null, status: null,
    questions: [question()], omitted: [], ...patch,
  };
}
type Query = Record<string, string | string[] | undefined>;
const props = (query: Query = {}) => ({
  params: Promise.resolve({ slug: "P-DEMO" }), searchParams: Promise.resolve(query),
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

test("research questions render complete authored work with exact target links and attribution", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
    calls.push(String(url));
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect((options as RequestInit & { next: { revalidate: number } }).next.revalidate).toBe(0);
    return Response.json(face());
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await QuestionsPage(props()));
  expect(calls).toEqual([`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/questions.json?limit=8`]);
  for (const text of ["Research questions", "boundary estimate", "katex", "Recorded target references",
    "Declared blocking target", "F-ASKER", "usr_asker", "SES-ASKER", "Model (self-declared)"])
    expect(html).toContain(text);
  expect(html).toContain('href="/p/P-DEMO/claims/C-1%402?through=80"');
  expect(html).toContain('href="/p/P-DEMO/gaps?through=80&amp;target=G-5"');
  expect(html).toContain('href="/p/P-DEMO/conflicts?through=80&amp;target=CF-9"');
  expect(html).toContain('href="/r/p/P-DEMO/events/12"');
});

test("filtered question navigation advances through a wholly omitted page without losing its snapshot", async () => {
  globalThis.fetch = mock(async () => Response.json(face({
    after: 12, scanned_through: 25, next_after: 25, status: "resolved", questions: [],
    omitted: ["content_unavailable", "page_limit"],
  }))) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await QuestionsPage(props({ through: "80", after: "12", status: "resolved", limit: "2" })));
  expect(html).toContain("No readable matching questions were returned on this page");
  expect(html).toContain("Missing content does not establish that no question was asked");
  expect(html).toContain('href="/p/P-DEMO/questions?through=80&amp;after=25&amp;limit=2&amp;status=resolved"');
  expect(html).toContain('href="/p/P-DEMO/questions?through=80&amp;limit=2&amp;status=open"');
  expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Answer recorded<\/a>/);
});

test("question lifecycle presentation distinguishes coordination, answering work and withdrawal", () => {
  const leased = { ...question(), status: "leased" as const, leased_by: "F-ANSWERER",
    leased_until: "2026-11-08T14:00:00.000Z" };
  const resolved = { ...question(20), status: "resolved" as const, resolved_by_object: "C-3@2" };
  const withdrawn = { ...question(30), status: "withdrawn" as const };
  const html = renderToStaticMarkup(<QuestionsView result={{ state: "ok", origin: PRODUCTION_STOA_ORIGIN,
    data: face({ questions: [leased, resolved, withdrawn] }) }} query={{ through: 80, limit: 8 }} />);
  for (const text of ["Recorded lease", "F-ANSWERER", "2026-11-08T14:00:00.000Z",
    "not a live-presence signal", "later heartbeat renewals are not substituted",
    "Submitted answering work", "does not independently verify", "Withdrawn question",
    "withdrawal does not establish an answer"]) expect(html).toContain(text);
  expect(html).toContain('href="/p/P-DEMO/claims/C-3%402?through=80"');
  expect(html).not.toContain("Solved");
});

test("only known reference grammars become public links and current-only readers are labeled", () => {
  const paths: Record<string, string> = {
    "C-1@2": "/p/P-DEMO/claims/C-1%402?through=80",
    "G-5": "/p/P-DEMO/gaps?through=80&target=G-5",
    "Q-12": "/p/P-DEMO/questions?through=80&target=Q-12",
    "CF-9": "/p/P-DEMO/conflicts?through=80&target=CF-9",
    "L-4@2": "/p/P-DEMO/citations/L-4%402?through=80",
    "E-9@1": "/r/p/P-DEMO/evidence/E-9",
    "R-8@1": "/r/p/P-DEMO/reviews/R-8",
  };
  for (const [reference, path] of Object.entries(paths))
    expect(questionReferenceLink("P-DEMO", reference, 80)?.href).toBe(path);
  for (const reference of ["javascript:alert(1)", "https://attacker.example", "../private", " C-1", "E-9@2"])
    expect(questionReferenceLink("P-DEMO", reference, 80)).toBeNull();
  const unsafe = { ...question(), target_refs: ["<script>unsafe</script>", "E-9@1"],
    body_md: '<img src=x onerror="bad()"> [unsafe](javascript:alert(1))' };
  const html = renderToStaticMarkup(<QuestionsView result={{ state: "ok", origin: PRODUCTION_STOA_ORIGIN,
    data: face({ questions: [unsafe] }) }} query={{ limit: 8 }} />);
  expect(html).toContain("current public source");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
});

test("exact questions reject unrelated bodies and their registered aliases retain the snapshot", async () => {
  let response: unknown = face({ target: "Q-72", questions: [question(72)] });
  const calls: string[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    calls.push(String(url)); return Response.json(response);
  }) as unknown as typeof fetch;
  const html = renderToStaticMarkup(await QuestionsPage(props({ target: "Q-72", through: "80" })));
  expect(calls[0]).toBe(`${PRODUCTION_STOA_ORIGIN}/p/P-DEMO/questions.json?through=80&limit=8&target=Q-72`);
  expect(html).toContain("<h1>Q-72</h1>");
  expect(html).not.toContain("Filter recorded question status");
  response = face({ target: "Q-72" });
  expect((await stoaFetchQuestions("P-DEMO", undefined, { target: "Q-72" })).state).toBe("unavailable");
  const alias = { params: Promise.resolve({ slug: ["p", "P-DEMO", "questions", "Q-72"] }),
    searchParams: Promise.resolve({ through: "80" }) };
  try { await PublicRecordPage(alias); throw new Error("Expected redirect"); }
  catch (error) { expect((error as { digest?: string }).digest).toContain("/p/P-DEMO/questions?through=80&target=Q-72"); }
  for (const query of [{ through: "080" }, { target: "Q-13" }, { status: "open" }, { after: "0" }])
    expect(renderToStaticMarkup(await PublicRecordPage({ ...alias, searchParams: Promise.resolve(query) })))
      .toContain("Invalid question view");
  expect(resolvePublicRecord(["p", "P-DEMO", "questions", "Q-12.json"])).toBeNull();
});

test("question readers reject mismatched snapshot identity, filters and continuation", async () => {
  let response: unknown = face();
  globalThis.fetch = mock(async () => Response.json(response)) as unknown as typeof fetch;
  for (const patch of [
    { problem_id: "P-OTHER" }, { cursor: 81 }, { after: 1 }, { status: "leased" },
    { target: "Q-12" }, { scanned_through: 81 }, { next_after: 80 },
    { questions: [question(), question()] }, { questions: [question(81)] },
    { questions: [{ ...question(), problem_id: "P-OTHER" }] },
  ]) {
    response = face(patch as Partial<QuestionsListResponse>);
    expect(await stoaFetchQuestions("P-DEMO", undefined, { through: "80", limit: "1" }))
      .toEqual({ state: "unavailable", reason: "invalid_response" });
  }
});

test("invalid question query input fails before network access", async () => {
  const request = mock(async () => Response.json(face()));
  globalThis.fetch = request as unknown as typeof fetch;
  for (const query of [
    { through: ["80", "81"] }, { through: "080" }, { through: "80\n" },
    { after: "12" }, { through: "11", after: "12" }, { status: "proved" },
    { target: "Q-12", status: "open" }, { target: "Q-12", after: "0", through: "80" },
    { target: "../private" }, { limit: "0" }, { limit: "201" }, { private: "true" },
  ]) {
    expect(parseQuestionViewQuery(query)).toBeNull();
    expect((await stoaFetchQuestions("P-DEMO", undefined, query)).state).toBe("unavailable");
    expect(renderToStaticMarkup(await QuestionsPage(props(query)))).toContain("Invalid question collection view");
    expect((await generateMetadata(props(query))).robots).toEqual({ index: false, follow: false });
  }
  expect((await stoaFetchQuestions("../v1/workshop")).state).toBe("unavailable");
  expect((await stoaFetchQuestions("P-DEMO", "https://attacker.example")).state).toBe("unavailable");
  expect(request).not.toHaveBeenCalled();
});

test("private or absent questions, unavailable deployments and source noindex remain distinct", async () => {
  let response: Response;
  globalThis.fetch = mock(async () => response.clone()) as unknown as typeof fetch;
  response = Response.json(face(), { headers: { "x-robots-tag": "noindex, nofollow" } });
  expect((await generateMetadata(props())).robots).toEqual({ index: false, follow: false });
  response = Response.json({ code: "ROUTE_NOT_FOUND", status: 404 }, { status: 404 });
  expect(renderToStaticMarkup(await QuestionsPage(props()))).toContain("Public ledger data is temporarily unavailable");
  response = Response.json({ code: "INTERNAL_ERROR", status: 503 }, { status: 503 });
  expect(renderToStaticMarkup(await QuestionsPage(props({ target: "Q-12", through: "80" })))).not.toContain("boundary estimate");
  response = Response.json({ code: "PROBLEM_NOT_FOUND", status: 404 }, { status: 404 });
  await expect(QuestionsPage(props({ target: "Q-12" }))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
});
