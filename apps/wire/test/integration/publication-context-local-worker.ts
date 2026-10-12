/** Local-only binding proof. This entry is never mounted by the production Worker. */

import {
  AdminQuarantineCaseDetailSchema,
  ProblemDocumentSchema,
  ScreeningPromotionHoldResponseSchema,
  ScreeningPublicationProvenanceSchema,
} from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../../src/env";
import { genesisChainDigest, sha256Hex, writeLedgerEvent } from "../../src/krater/krater";
import { operatorQuarantineCase } from "../../src/moderation/operator-http";
import { decideScreeningCase } from "../../src/moderation/store";
import {
  type ScreenedPublication,
  screeningPublicationStatements,
} from "../../src/screening/ingress";
import { screenPublicCandidate } from "../../src/screening/public-candidate";
import {
  isScreeningContextStaleError,
  MAX_PUBLICATION_SCREENING_BODY_BYTES,
  readPublicationContext,
  storedPublicationContextIsVisible,
} from "../../src/screening/publication-context";
import { POLICY_CATEGORIES } from "../../src/screening/types";
import {
  promotionScreeningBinding,
  screenPromotionWithWorkersAI,
  type WorkersAIPromotionInput,
} from "../../src/screening/workers-ai";

const PROBLEM = "P-CONTEXT-D1";
const FELLOW = "F-CONTEXT-D1";
const SPONSOR = "usr_context_d1";
const SESSION = "S-CONTEXT-D1";
const now = () => new Date().toISOString();
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`CONTEXT_BINDING_PROOF_FAILED: ${message}`);
}
function published(value: Response | ScreenedPublication): ScreenedPublication {
  check(!(value instanceof Response), "the exact release must authorize publication");
  return value;
}
const classification = (decision: "pass" | "quarantine") => ({
  response: JSON.stringify({
    decision,
    coarse_category: "benign-context",
    bands: Object.fromEntries(POLICY_CATEGORIES.map((category) => [category, null])),
  }),
});

async function prove(db: D1Database) {
  await db
    .prepare("INSERT INTO sponsors(sponsor_id,created_at,last_seen_at) VALUES(?,?,?)")
    .bind(SPONSOR, Date.now(), Date.now())
    .run();
  await db
    .prepare(`INSERT INTO enrollment_fellows
    (fellow_id,sponsor_id,name,model,harness,created_at) VALUES(?,?,?,?,?,?)`)
    .bind(FELLOW, SPONSOR, "context-binding-author", "declared model", "binding proof", Date.now())
    .run();
  async function problem(id: string) {
    await db.batch([
      db
        .prepare(`INSERT INTO problems(id,public_seq,status,title,sponsor_id,created_at,updated_at,chain_version,chain_digest)
        VALUES(?,0,'active','Exact public problem',?,?,?,2,?)`)
        .bind(id, SPONSOR, now(), now(), await genesisChainDigest(id)),
      db
        .prepare(`INSERT INTO problem_statement_versions(problem_id,version,statement,norm_hash,falsifier,motivation,created_at)
        VALUES(?,1,?,'sha256:legacy-statement',?,?,?)`)
        .bind(id, "P".repeat(8192), "F".repeat(8192), "M".repeat(8192), now()),
      db
        .prepare(`INSERT INTO krater_integrity_backfill(problem_id,state,legacy_event_count,completed_at,chain_version)
        VALUES(?,'complete',0,?,2)`)
        .bind(id, now()),
    ]);
  }
  await problem(PROBLEM);
  const input = (statement: string, problemId = PROBLEM): WorkersAIPromotionInput => ({
    kind: "hypotheses",
    problemId,
    fellowId: FELLOW,
    statement,
    falsifier: null,
  });
  async function append(
    candidate: WorkersAIPromotionInput,
    eventId: string,
    screened?: ScreenedPublication,
  ) {
    const requestDigest = await sha256Hex(candidate.statement);
    return writeLedgerEvent(
      db,
      {
        problemId: candidate.problemId,
        eventId,
        idempotencyKey: `context-${eventId}`,
        requestDigest,
        eventType: "hypothesis.created",
        objectKind: "hypothesis",
        objectId: `H-${eventId}`,
        objectVersion: 1,
        payloadJson: JSON.stringify({
          body_md: candidate.statement,
          falsifier: candidate.falsifier,
        }),
        createdAt: now(),
        attribution: {
          fellowId: FELLOW,
          sponsorId: SPONSOR,
          sessionId: SESSION,
          modelSelfDeclared: "declared model",
          harness: "binding proof",
        },
      },
      {
        statementsAfterEvent: () =>
          screened === undefined
            ? []
            : screeningPublicationStatements(db, screened, eventId, SESSION, requestDigest),
      },
    );
  }

  // The source itself sits exactly on the reader's 512 KiB per-source bound.
  const sourceOverhead = bytes(JSON.stringify({ body_md: "", falsifier: null }));
  const source = input("S".repeat(512 * 1024 - sourceOverhead));
  await append(source, "E-D1-SOURCE");
  const sourceRow = await db
    .prepare("SELECT payload_json FROM event_content WHERE event_id = 'E-D1-SOURCE'")
    .first<{ payload_json: string }>();
  check(
    sourceRow && bytes(sourceRow.payload_json) === 512 * 1024,
    "source must use the complete reader boundary",
  );

  const snapshot = await readPublicationContext(db, input(""));
  const empty = await promotionScreeningBinding({
    ...input(""),
    publicationContext: { snapshot, precedingCandidates: [] },
  });
  check(empty.contextualInput, "full private context is required");
  const candidate = input(
    "C".repeat(MAX_PUBLICATION_SCREENING_BODY_BYTES - bytes(JSON.stringify(empty.contextualInput))),
  );
  const expected = await promotionScreeningBinding({
    ...candidate,
    publicationContext: { snapshot, precedingCandidates: [] },
  });
  check(expected.contextualInput, "full boundary envelope is required");
  const exactStoredInput = JSON.stringify(expected.contextualInput);
  check(
    bytes(exactStoredInput) === MAX_PUBLICATION_SCREENING_BODY_BYTES,
    "candidate must exactly fill the complete input budget",
  );
  check(
    bytes(expected.body) > MAX_PUBLICATION_SCREENING_BODY_BYTES - 256,
    "the provider must receive the near-1 MiB complete envelope",
  );

  let modelCalls = 0;
  let actualProviderBody = "";
  const screen = (value: WorkersAIPromotionInput) =>
    screenPromotionWithWorkersAI(
      {
        async run(_model, payload) {
          modelCalls++;
          const message = payload.messages.find((entry) => entry.role === "user")?.content ?? "";
          const match = message.match(/<submission[^>]*>\n([\s\S]*)\n<\/submission>/);
          check(match?.[1], "the provider receives a complete, delimited input");
          actualProviderBody = match[1];
          check(
            actualProviderBody === expected.body,
            "no current or history bytes are truncated in the provider request",
          );
          return classification("quarantine");
        },
      },
      value,
    );
  const held = await screenPublicCandidate(screen, { DB: db } as Env, candidate, {
    sponsorId: SPONSOR,
    route: "hypotheses",
  });
  check(
    held instanceof Response && held.status === 202,
    "the boundary input should be held durably",
  );
  const hold = ScreeningPromotionHoldResponseSchema.parse(await held.json());
  check(hold.case_id && modelCalls === 1, "one model observation opens one exact case");
  const stored = await db
    .prepare("SELECT contextual_input_json, candidate_json FROM screening_cases WHERE case_id = ?")
    .bind(hold.case_id)
    .first<{ contextual_input_json: string; candidate_json: string }>();
  check(
    stored?.contextual_input_json === exactStoredInput,
    "D1 retains every exact byte at the 1 MiB bound",
  );
  check(
    bytes(stored.candidate_json) < 100,
    "the legacy column does not duplicate or truncate the large candidate",
  );
  check(
    await storedPublicationContextIsVisible(db, JSON.parse(exactStoredInput).context),
    "the complete retained public context remains readable in actual D1",
  );
  const detail = await operatorQuarantineCase(db, hold.case_id);
  check(detail.status === 200, "operator can retrieve the complete boundary case");
  const detailText = await detail.text();
  const detailBytes = bytes(detailText);
  check(
    detailBytes > MAX_PUBLICATION_SCREENING_BODY_BYTES &&
      detailBytes <= MAX_PUBLICATION_SCREENING_BODY_BYTES + 16384,
    "the full operator response needs bounded frame headroom above the stored input",
  );
  const reviewed = AdminQuarantineCaseDetailSchema.parse(JSON.parse(detailText));
  check(
    reviewed.candidate.statement === candidate.statement,
    "operator sees every current candidate byte",
  );
  check(
    reviewed.candidate.context?.recent_same_fellow_publications[0]?.payload_json ===
      sourceRow.payload_json,
    "operator sees the verified complete public history body",
  );

  const beforeOver = await db
    .prepare(`SELECT
    (SELECT COUNT(*) FROM screening_cases) AS cases,
    (SELECT COUNT(*) FROM events) AS events,
    (SELECT COUNT(*) FROM screening_publications) AS receipts`)
    .first();
  const over = await screenPublicCandidate(
    screen,
    { DB: db } as Env,
    { ...candidate, statement: `${candidate.statement}C` },
    { sponsorId: SPONSOR, route: "hypotheses" },
  );
  check(
    over instanceof Response && over.status === 503,
    "one byte over must refuse before the classifier",
  );
  const refused = ProblemDocumentSchema.parse(await over.json());
  check(
    refused.code === "SCREENING_CONTEXT_UNAVAILABLE" && refused.maximum_context_bytes === 1048576,
    "the refusal explains the actual complete-context bound",
  );
  const afterOver = await db
    .prepare(`SELECT
    (SELECT COUNT(*) FROM screening_cases) AS cases,
    (SELECT COUNT(*) FROM events) AS events,
    (SELECT COUNT(*) FROM screening_publications) AS receipts`)
    .first();
  check(
    modelCalls === 1 && JSON.stringify(beforeOver) === JSON.stringify(afterOver),
    "oversize has no model, case or public side effects",
  );

  const adjudicated = await decideScreeningCase(db, "operator:binding-proof", {
    caseId: hold.case_id,
    decision: "release",
    reason: "Reviewed the complete synthetic context boundary.",
  });
  check(adjudicated.ok, "the operator can release the exact boundary case");
  const release = published(
    await screenPublicCandidate(screen, { DB: db } as Env, candidate, {
      sponsorId: SPONSOR,
      route: "hypotheses",
    }),
  );
  check(
    release.provenance.decision_path === "operator-release" && modelCalls === 1,
    "the exact released input does not buy another classifier call",
  );
  await append(candidate, "E-D1-RELEASED", release);
  const receipt = await db
    .prepare("SELECT provenance_json FROM screening_publications WHERE event_id = 'E-D1-RELEASED'")
    .first<{ provenance_json: string }>();
  check(receipt, "the source-duplication guard and publication receipt commit together");
  const provenance = ScreeningPublicationProvenanceSchema.parse(
    JSON.parse(receipt.provenance_json),
  );
  check(
    provenance.version === "ledger-publication-screening.v2" &&
      provenance.review_case_id === hold.case_id,
    "publication attributes the exact operator release and contextual cut",
  );
  check(
    !receipt.provenance_json.includes(candidate.statement.slice(0, 100)),
    "public provenance never contains held scientific bytes",
  );

  // The stale guard is also a real D1 transaction abort, not only a SQLite unit assertion.
  await problem("P-CONTEXT-D1-RACE");
  const raceCandidate = input("Exact synthetic racing candidate.", "P-CONTEXT-D1-RACE");
  const raced = published(
    await screenPublicCandidate(
      async (value) => {
        const observation = await screenPromotionWithWorkersAI(
          {
            async run() {
              return classification("pass");
            },
          },
          value,
        );
        await append(
          input("An overlapping same-author publication.", raceCandidate.problemId),
          "E-D1-OVERLAP",
        );
        return observation;
      },
      { DB: db } as Env,
      raceCandidate,
      { sponsorId: SPONSOR, route: "hypotheses" },
    ),
  );
  let stale = false;
  try {
    await append(raceCandidate, "E-D1-STALE", raced);
  } catch (error) {
    stale = isScreeningContextStaleError(error);
  }
  check(stale, "D1's guard error preserves the canonical stale-context classification");
  const staleDelta = await db
    .prepare(`SELECT
    (SELECT COUNT(*) FROM events WHERE id = 'E-D1-STALE') AS events,
    (SELECT COUNT(*) FROM screening_publications WHERE event_id = 'E-D1-STALE') AS receipts,
    (SELECT COUNT(*) FROM idempotency WHERE event_id = 'E-D1-STALE') AS replays`)
    .first<{ events: number; receipts: number; replays: number }>();
  check(
    staleDelta?.events === 0 && staleDelta.receipts === 0 && staleDelta.replays === 0,
    "a stale screen leaves no public event, provenance or replay prefix",
  );

  return {
    kind: "publication-context-real-bindings",
    status: "pass",
    boundary:
      "actual local Workerd/D1 reader, full provider input, case store, operator release and Krater companions; fixture classifier decisions, not live AI or mounted HTTP authorization",
    source_bytes: bytes(sourceRow.payload_json),
    provider_input_bytes: bytes(actualProviderBody),
    private_case_bytes: bytes(exactStoredInput),
    operator_detail_bytes: detailBytes,
    model_calls_for_boundary_case: modelCalls,
    one_byte_over_refused: true,
    stale_transaction_aborted: true,
  };
}

export default {
  async fetch(request: Request, env: Pick<Env, "DB">) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/prove")
      return new Response(null, { status: 404 });
    return Response.json(await prove(env.DB));
  },
};
