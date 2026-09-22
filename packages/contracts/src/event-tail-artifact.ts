import { z } from "zod";
import { EVENT_TAIL_SCHEMA_ID, EventTailContractsSchema } from "./event-tail.ts";

/** Included in the canonical generatedArtifacts inventory, so generation,
 * drift checking and the public-schema registry all consume the same bytes. */
export function generatedEventTailArtifact(): { relativePath: string; content: string } {
  const document = {
    $id: EVENT_TAIL_SCHEMA_ID,
    title: "ASImposium public event tail contracts",
    $comment:
      "Runtime checks additionally enforce safe decimal cursors, contiguous sequence accounting, matching problem identity, and canonical continuation links. NDJSON must end with exactly one page_end record; a truncated stream is incomplete. Optional wait is 0-25 seconds on empty unpinned GETs only; HEAD and through pages return immediately. Waiting may fall back to polling under capacity pressure. Honor Retry-After; wait responses are not shared-cacheable.",
    ...z.toJSONSchema(EventTailContractsSchema),
  };
  return {
    relativePath: "generated/event-tail.schema.json",
    content: `${JSON.stringify(document)}\n`,
  };
}
