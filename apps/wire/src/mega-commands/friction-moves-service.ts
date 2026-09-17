import { getMoveTemplate } from "@asimposium/contracts";
import { readFrictionWork } from "@asimposium/contracts/formalization-friction";
import type { ReviewQueueItem } from "@asimposium/contracts/review-queue";
import type { D1Database } from "@cloudflare/workers-types";
import { loadFormalRecords } from "../ledger/formal-records-service.ts";
import { loadFrictionMove } from "./friction-moves.ts";

/** Fixed canonical readers and contracts; no caller-selectable evaluator. */
export function loadFormalizationFrictionMove(db:D1Database,problem:string,cursor:number,items:readonly ReviewQueueItem[]) {
  return loadFrictionMove(db,problem,cursor,items,{
    page:loadFormalRecords,work:readFrictionWork,
    template:()=>getMoveTemplate("add-refuter-from-friction"),
  });
}
