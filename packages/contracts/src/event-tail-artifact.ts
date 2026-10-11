import { z } from "zod";
import { EVENT_TAIL_SCHEMA_ID, EventTailContractsSchema } from "./event-tail.ts";

/** Included in the canonical generatedArtifacts inventory, so generation,
 * drift checking and the public-schema registry all consume the same bytes. */
export function generatedEventTailArtifact(): { relativePath: string; content: string } {
  const document = {
    $id: EVENT_TAIL_SCHEMA_ID,
    title: "ASImposium public event tail contracts",
    $comment:
      "Runtime checks additionally enforce safe decimal cursors, contiguous sequence accounting, matching problem identity, canonical continuation links, and distinct causal parents in increasing earlier sequence order within the same problem. caused_by is read from available hash-bound batch content and checked against public parent events; null plus causality_omitted never asserts an empty parent set. Pages preserve whole causal arrays and may contain fewer than limit events to stay within the byte cap. NDJSON must end with exactly one page_end record; a truncated stream is incomplete. Optional wait is 0-25 seconds on empty unpinned GETs only; HEAD and through pages return immediately. Waiting may fall back to polling under capacity pressure. Honor Retry-After; wait responses are not shared-cacheable.",
    ...z.toJSONSchema(EventTailContractsSchema),
  };
  return {
    relativePath: "generated/event-tail.schema.json",
    content: `${JSON.stringify(document)}\n`,
  };
}
