import { getMoveTemplate } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import { loadDeadEndRetryPage } from "../ledger/dead-end-retry-service.ts";
import { loadRetryMove } from "./retry-moves.ts";

export function loadDeadEndRetryMove(
  db: D1Database,
  problem: string,
  cursor: number,
  fellow: string,
) {
  return loadRetryMove(db, problem, cursor, fellow, {
    page: loadDeadEndRetryPage,
    template: () => getMoveTemplate("retry-dead-end"),
  });
}
