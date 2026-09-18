import { z } from "zod";
import { REVIEW_QUEUE_SCHEMA_ID, ReviewQueueContractsSchema } from "./review-queue.ts";

/** Canonical key order keeps the published schema bytes deterministic. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function generatedReviewQueueArtifact(): { relativePath: string; content: string } {
  const document = {
    $id: REVIEW_QUEUE_SCHEMA_ID,
    title: "ASImposium public review discovery contracts",
    $comment:
      "Runtime checks additionally enforce real canonical timestamps, complete cursor matching, unique problem-scoped claims, response/query identity and exact version/cursor-bound read links. This queue grants neither permission nor scientific standing.",
    ...z.toJSONSchema(ReviewQueueContractsSchema),
  };
  return {
    relativePath: "generated/review-queue.schema.json",
    content: `${JSON.stringify(canonical(document))}\n`,
  };
}
