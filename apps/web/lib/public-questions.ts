import "server-only";

import { PublicLedgerProblemIdSchema } from "@asimposium/contracts";
import {
  type QuestionsListQuery,
  QuestionsListQuerySchema,
  type QuestionsListResponse,
  QuestionsListResponseSchema,
  questionsListMatchesQuery,
  questionsListPath,
} from "@asimposium/contracts/questions";
import { type PublicRead, readPublic } from "./public-ledger";
import { configuredStoaOrigin } from "./stoa";

export const QUESTIONS_PAGE_SIZE = 8;

export function parseQuestionViewQuery(value: unknown): QuestionsListQuery | null {
  const parsed = QuestionsListQuerySchema.safeParse(value);
  return parsed.success ? { ...parsed.data, limit: parsed.data.limit ?? QUESTIONS_PAGE_SIZE } : null;
}

/** One source read supplies the question, its recorded lifecycle and current
 * public visibility. The browser never supplies authority or substitutes a lease. */
export async function stoaFetchQuestions(
  problem: string,
  origin = configuredStoaOrigin(),
  query: unknown = {},
): Promise<PublicRead<QuestionsListResponse>> {
  const parsed = parseQuestionViewQuery(query);
  if (
    typeof problem !== "string" || problem.trim() !== problem ||
    !PublicLedgerProblemIdSchema.safeParse(problem).success || parsed === null
  ) return { state: "unavailable", reason: "invalid_response" };
  const result = await readPublic(
    questionsListPath(problem, "json", parsed), origin, QuestionsListResponseSchema,
    0, "PROBLEM_NOT_FOUND", "CURSOR_INVALID", 8 * 1024 * 1024,
  );
  if (result.state !== "ok") return result;
  return questionsListMatchesQuery(problem, parsed, result.data)
    ? result : { state: "unavailable", reason: "invalid_response" };
}
