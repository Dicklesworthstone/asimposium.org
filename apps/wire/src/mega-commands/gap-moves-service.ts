import { getMoveTemplate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { loadProofGaps } from "../ledger/proof-gaps-service.ts";
import { loadGapMove } from "./gap-moves.ts";

/** One canonical gap reader and the existing public transition contract. */
export function loadProofGapMove(db: D1Database, problem: string, cursor: number, now: number) {
  return loadGapMove(db, problem, cursor, now, {
    page: loadProofGaps,
    template: () => getMoveTemplate("close-gap"),
  });
}
