import { expect, test } from "bun:test";
import { PackResponseSchema, SessionOpenResponseSchema } from "@asimposium/contracts";
import { sha256Hex, writeLedgerEvent } from "../../src/krater/krater.ts";
import {
  readScientificDispositions,
  ScientificReadBudgetExceededError,
} from "../../src/ledger/scientific-disposition.ts";
import { fixture } from "./session-routes.test.ts";

// Real route setup plus a historical ledger fixture over migrated SQLite.
// This exercises pack degradation, not admission of the historical population
// or native Workerd/D1 behavior. Screening and write limits remain unchanged.
test("a context pack remains usable when complete scientific standing exceeds its byte budget", async () => {
  const f = await fixture();
  let serial = 0;
  const post = async (path: string, body: unknown) => {
    const response = await f.call(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `scientific-pack-budget-${++serial}`,
      },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return response.json();
  };
  const session = SessionOpenResponseSchema.parse(
    await post("/v1/sessions", { problem_id: "P-4DSP", intent: "explore" }),
  );
  const path = `/v1/sessions/${session.session_id}`;
  const draft = (await post(`${path}/workshop`, {
    type: "claim-draft",
    title: "Finite parity computation",
    body_md: "An exact statement prepared for public examination.",
    relates_to: [],
  })) as { workshop_id: string };
  await post(`${path}/promote`, {
    workshop_id: draft.workshop_id,
    kind: "conjecture",
    statement: "Two is even.",
    falsifier: "A nonzero remainder after division by two.",
    relates_to: [],
  });
  const evidence = {
    bears_on_kind: "claim",
    bears_on_id: "C-1",
    bears_on_version: 1,
    direction: "supports",
    kind: "argument",
    source: { kind: "model_memory" },
    mode: "confirmatory",
    body_md: `0: ${"\u0001".repeat(64 * 1024 - 4)}`,
  };
  await post(`${path}/evidence`, evidence);
  // Each body fits the 64 KiB character and 512 KiB ingress ceilings. Seed
  // existing history through the canonical ledger writer: repeatedly posting
  // these bodies would instead hit screening's separate context budget before
  // the standing read is exercised. No scientific authority is manufactured;
  // these model-memory arguments retain their assertion evidence class.
  for (let index = 1; index < 11; index++) {
    const direction = index === 10 ? "refutes" : "supports";
    const body = `${index}: ${"\u0001".repeat(64 * 1024 - 4)}`;
    const payloadJson = JSON.stringify({
      ...evidence,
      direction,
      body_md: body,
      computed_class: "assertion",
      coercion_flags: [],
    });
    const createdAt = new Date().toISOString();
    const evidenceId = `E-${index + 1}`;
    await writeLedgerEvent(
      f.db,
      {
        problemId: "P-4DSP",
        eventId: `EV-HISTORY-BUDGET-${index}`,
        idempotencyKey: `history-budget-${index}`,
        requestDigest: await sha256Hex(payloadJson),
        eventType: "evidence.created",
        objectKind: "evidence",
        objectId: evidenceId,
        objectVersion: 1,
        payloadJson,
        createdAt,
        attribution: {
          fellowId: f.binding.fellowId,
          sponsorId: f.binding.sponsorId,
          sessionId: session.session_id,
          modelSelfDeclared: f.binding.model,
          harness: f.binding.harness,
        },
      },
      {
        statementsAfterEvent: (context) => [
          f.db
            .prepare(`INSERT INTO evidence
              (evidence_id,problem_id,bears_on_kind,bears_on_id,bears_on_version,direction,
               kind,source_kind,mode,computed_class,coercion_flags_json,author_fellow_id,
               body_md,created_at,source_event_id,source_seq)
              VALUES(?,'P-4DSP','claim','C-1',1,?,'argument','model_memory','confirmatory',
                'assertion','[]',?,?,?,?,?)`)
            .bind(
              evidenceId,
              direction,
              f.binding.fellowId,
              body,
              createdAt,
              context.eventId,
              context.sequence,
            ),
        ],
      },
    );
  }
  const head = await f.db
    .prepare("SELECT public_seq FROM problems WHERE id='P-4DSP'")
    .first<{ public_seq: number }>();
  expect(head).not.toBeNull();
  await expect(
    readScientificDispositions(f.db, "P-4DSP", head?.public_seq ?? 0, 40),
  ).rejects.toBeInstanceOf(ScientificReadBudgetExceededError);

  const response = await f.call(`${path}/pack?profile=working&max_tokens=8000`);
  expect(response.status, await response.clone().text()).toBe(200);
  const pack = PackResponseSchema.parse(await response.json());
  expect(pack.items.some((item) => item.id === "SYS-identity")).toBe(true);
  expect(pack.items.some((item) => item.kind === "claim")).toBe(false);
  expect(pack.items.some((item) => item.id === "SYS-claims-empty")).toBe(false);
  expect(pack.omitted).toContainEqual({
    reason: "scientific_history_budget",
    detail: `claims: standing unavailable within the read budget; inspect exact versions via /p/P-4DSP/claims.md?through=${head?.public_seq}`,
  });
  expect(pack.tokens_estimate).toBeLessThanOrEqual(8000);
});
