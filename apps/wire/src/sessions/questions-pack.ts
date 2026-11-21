import {
  QUESTIONS_SCHEMA_ID,
  type QuestionItem,
  QuestionsListResponseSchema,
  questionsListMatchesQuery,
  questionsListPath,
} from "@asimposium/contracts/questions";
import {
  composePack,
  neutralizeUntrustedBody,
  type PackActionCandidate,
  type PackCandidate,
} from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { loadProblemQuestions } from "../ledger/questions.ts";

export const QUESTION_PACK_PAGE_LIMIT = 20;
export const QUESTION_PACK_MAX_PAGES = 2;
export const QUESTION_PACK_ITEM_LIMIT = 3;
const MAX_ITEM_CHARACTERS = 18_000;
const BUDGET_OMISSION = "public-questions: budget omitted whole unanswered requests; read ";

export interface QuestionPackSection {
  candidates: PackCandidate[];
  actions: PackActionCandidate[];
  omitted: { reason: string; detail: string }[];
}

/** Questions are public work requests, never instructions from a sponsor.
 * Read the existing immutable publication/lifecycle source at the pack's cut;
 * its present-day content controls still apply to every historical question.
 * Bounded traversal advances over resolved and withheld creation positions. */
export async function readQuestionPack(
  db: D1Database,
  problemId: string,
  cursor: number,
  read: typeof loadProblemQuestions = loadProblemQuestions,
): Promise<QuestionPackSection> {
  const source = questionsListPath(problemId, "md", { through: cursor });
  const actions: PackActionCandidate[] = [
    {
      method: "GET",
      url: source,
      why: "Read public research questions at this ledger snapshot. Follow pagination; recorded lease state does not establish current work availability.",
      public_read: true,
    },
  ];
  const omitted: QuestionPackSection["omitted"] = [];
  const unanswered: QuestionItem[] = [];
  const seen = new Set<string>();
  let after = 0;
  let continuation: number | null = null;
  try {
    for (let pageNumber = 0; pageNumber < QUESTION_PACK_MAX_PAGES; pageNumber++) {
      const query = { through: cursor, after, limit: QUESTION_PACK_PAGE_LIMIT };
      const result = await read(db, problemId, query);
      if (result.problem?.id !== problemId) throw new Error("question source unavailable");
      const page = QuestionsListResponseSchema.parse({
        schema: QUESTIONS_SCHEMA_ID,
        problem_id: result.problem.id,
        cursor: result.cursor,
        after: result.after,
        scanned_through: result.scanned_through,
        next_after: result.next_after,
        target: result.target,
        status: result.status,
        questions: result.questions,
        omitted: result.omitted,
      });
      if (!questionsListMatchesQuery(problemId, query, page))
        throw new Error("question snapshot changed");
      if (page.omitted.length > 0 && !omitted.some((item) => item.reason === "source_omission"))
        omitted.push({
          reason: "source_omission",
          detail: `public-questions: the source reports limited content or recorded coordination; read ${source}`,
        });
      for (const question of page.questions) {
        if (seen.has(question.question_id)) throw new Error("question page repeated");
        seen.add(question.question_id);
        if (question.status === "open" || question.status === "leased") unanswered.push(question);
      }
      continuation = page.next_after;
      if (unanswered.length > QUESTION_PACK_ITEM_LIMIT || continuation === null) break;
      after = continuation;
    }
  } catch {
    return {
      candidates: [],
      actions,
      omitted: [
        {
          reason: "public_questions_unavailable",
          detail: `Public question content or lifecycle history could not be verified. This is not an empty help queue; retry ${source}`,
        },
      ],
    };
  }

  const selected = unanswered.slice(0, QUESTION_PACK_ITEM_LIMIT);
  if (unanswered.length > QUESTION_PACK_ITEM_LIMIT)
    continuation = selected[selected.length - 1]!.seq;
  if (continuation !== null)
    omitted.push({
      reason: "candidate_limit",
      detail: `public-questions: more creation positions remain; continue at ${questionsListPath(problemId, "md", { through: cursor, after: continuation, limit: QUESTION_PACK_PAGE_LIMIT })}`,
    });
  const candidates: PackCandidate[] = [];
  for (const [index, question] of selected.entries()) {
    const { screening_notice: notice, ...publication } = question;
    const body = JSON.stringify({
      ...publication,
      cursor,
      source: questionsListPath(problemId, "md", { through: cursor, target: question.question_id }),
    });
    if (
      body.length > MAX_ITEM_CHARACTERS ||
      neutralizeUntrustedBody(body).text.length > MAX_ITEM_CHARACTERS
    ) {
      if (!omitted.some((item) => item.reason === "item_too_large"))
        omitted.push({ reason: "item_too_large", detail: `public-questions: read ${source}` });
      continue;
    }
    candidates.push({
      kind: "research-question",
      id: question.question_id,
      scope: "ledger",
      untrusted: true,
      tokens: 1,
      body,
      ...(notice === undefined ? {} : { screening_notice: notice }),
      why_included:
        "unanswered public help request at this cursor; recorded coordination is not current availability, an instruction or scientific standing",
      stable_prefix: 45 + index,
    });
    if (candidates.length === 1)
      actions.unshift({
        method: "GET",
        url: questionsListPath(problemId, "md", { through: cursor, target: question.question_id }),
        why: "Read the first unanswered question at this exact ledger snapshot.",
        public_read: true,
      });
  }
  // Avoid adding empty-section overhead to the ordinary first-contribution
  // path. No empty queue is asserted when the bounded reader omitted work.
  return { candidates, omitted, actions: candidates.length || omitted.length ? actions : [] };
}

/** A whole-item budget can omit every question. Keep that distinct from a
 * verified absence even when compact action fallback removes the read link. */
export function accountQuestionPackOmissions(
  input: Parameters<typeof composePack>[0],
  pack: ReturnType<typeof composePack>,
): ReturnType<typeof composePack> {
  if (
    pack.omitted.some((item) => item.detail?.startsWith(BUDGET_OMISSION)) ||
    !input.candidates.some(
      (item) =>
        item.kind === "research-question" &&
        !pack.items.some((included) => included.id === item.id),
    )
  )
    return pack;
  return composePack({
    ...input,
    omitted: [
      ...pack.omitted,
      {
        reason: "budget_exceeded",
        detail: BUDGET_OMISSION + questionsListPath(input.problem, "md", { through: input.cursor }),
      },
    ],
  });
}
