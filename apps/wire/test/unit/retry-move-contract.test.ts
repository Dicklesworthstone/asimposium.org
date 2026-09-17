import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  GapTransitionRequestSchema, getMoveTemplate, MoveTemplateSchema,
  NextMoveCandidateSchema, RecordDeadEndRequestSchema, WorkshopPushRequestSchema,
} from "@asimposium/contracts";
import { retryEventMatches, type RetryAdmission, type VerifiedDeadEndRetry } from "../../src/ledger/dead-end-retries.ts";
import { retryMoveFor } from "../../src/mega-commands/retry-moves.ts";

// Actual workspace schemas; not counted as executed by the local Node runner
// when Bun/Zod and the full contracts package are unavailable.
const retry:VerifiedDeadEndRetry={
  problem_id:"P-DEMO",cursor:12,dead_end_id:"DE-2",author_fellow_id:`F-${"A".repeat(26)}`,
  publication:{event_id:"DE-EVENT",seq:2,payload_sha256:"a".repeat(64)},
  firing:{event_id:"GAP-CLOSE",seq:9,payload_sha256:"b".repeat(64)},
  source:RecordDeadEndRequestSchema.parse({
    approach:"Test the finite-state reduction over the bounded search space.",
    why_it_fails:"A missing compactness lemma prevents the proposed reduction.",
    retry_predicate:"Reconsider only after the missing obligation is discharged.",
    retry_when:{kind:"gap-closed",gap_id:"G-3"},
  }) as VerifiedDeadEndRetry["source"],
};

test("selected retry advertises a real private-workshop contract, not another negative result",()=>{
  const move=retryMoveFor(retry,`F-${"B".repeat(26)}`,getMoveTemplate("retry-dead-end"));
  assert.ok(move);NextMoveCandidateSchema.parse(move);
  const {preparation,...template}=move.contract;
  const executable=MoveTemplateSchema.parse(template);
  assert.equal(executable.availability,"available");
  if(executable.availability!=="available")assert.fail("available retry expected");
  assert.equal(executable.request.path,"/v1/sessions/{id}/workshop");
  assert.equal(executable.target_contract,"/schemas/sessions.v1.json#/properties/workshop_push_request");
  assert.ok(WorkshopPushRequestSchema.safeParse({
    ...executable.prefilled_hints,title:"Re-examine the blocked reduction",
    body_md:"A deliberate investigation plan and observations, without claiming a result.",
  }).success);
  const context=preparation as {author_may_supersede:boolean};
  assert.equal(context.author_may_supersede,false);
  assert.equal(executable.prefilled_hints.why_it_fails,undefined);
  assert.equal(executable.prefilled_hints.supersedes_dead_end_id,undefined);
});

test("gap retry matching consumes the actual transition request field outcome",()=>{
  const closed=GapTransitionRequestSchema.parse({gap_id:"G-3",outcome:"closed-by",closed_by:"E-4"});
  const row={problem_id:"P-DEMO",event_type:"gap.closed-by",object_kind:"gap",object_id:"G-3",object_version:1} as RetryAdmission;
  assert.ok(retryEventMatches(row,{kind:"gap-closed",gap_id:"G-3"},closed));
  assert.equal(retryEventMatches(row,{kind:"gap-closed",gap_id:"G-3"},{gap_id:"G-3",status:"closed-by"}),false);
  assert.equal(retryEventMatches(row,{kind:"gap-closed",gap_id:"G-3"},{...closed,gap_id:"G-30"}),false);
});

test("author status never prefills supersession or a scientific outcome",()=>{
  const move=retryMoveFor(retry,retry.author_fellow_id,getMoveTemplate("retry-dead-end"));
  assert.ok(move);assert.equal((move.contract.preparation as {author_may_supersede:boolean}).author_may_supersede,true);
  assert.deepEqual(move.contract.prefilled_hints,{type:"scratch"});
  assert.ok(!JSON.stringify(move.contract).includes(retry.source.why_it_fails));
});
