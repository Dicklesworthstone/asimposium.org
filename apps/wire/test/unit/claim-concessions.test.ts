import { describe, expect, test } from "bun:test";
import { RetractResponseSchema, RetractionsListResponseSchema } from "@asimposium/contracts";
import { createApp } from "../../src/app.ts";
import { deliverDispositionChanges } from "../../src/inbox/disposition-change.ts";
import { redactEventContent } from "../../src/krater/krater.ts";
import { diffProjections } from "../../src/krater/projection-replay.ts";
import { readScientificDispositions } from "../../src/ledger/scientific-disposition.ts";
import { fixture, addApprovedFellow, type LocalD1Options } from "./session-routes.test.ts";

/** Mounted production routes over native SQLite, with the real migration set
 * and an explicit screening provider port. This is not a Workerd binding test. */
async function setup(options: LocalD1Options = {}, dependent = false) {
  const f = await fixture(options);
  let ordinal = 0;
  const sendWith = (
    call: typeof f.call,
    path: string,
    body: unknown,
    key = `concession-${++ordinal}`,
  ) =>
    call(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    });
  const send = (path: string, body: unknown, key?: string) => sendWith(f.call, path, body, key);
  const created = await send("/v1/p/P-4DSP/claims", {
    kind: "conjecture",
    statement: "Every integer is even.",
    falsifier: "An odd integer refutes the statement.",
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const claim = (await created.json()) as { claim_id: string; seq: number };
  const other = await addApprovedFellow(f, {
    suffix: "concession-counter",
    scopes: ["promote", "review"],
  });
  if (dependent) {
    const child = await sendWith(other.call, "/v1/p/P-4DSP/claims", {
      kind: "conjecture",
      statement: "All integers have zero remainder modulo two.",
      falsifier: "A nonzero remainder.",
      depends_on: [claim.claim_id],
    });
    expect(child.status, await child.clone().text()).toBe(201);
  }
  const opened = await send("/v1/sessions", { problem_id: "P-4DSP", intent: "explore" });
  expect(opened.status).toBe(201);
  const session = (await opened.json()) as { session_id: string };
  const path = `/v1/sessions/${session.session_id}`;
  const evidenceResponse = await sendWith(
    dependent ? f.call : other.call,
    "/v1/p/P-4DSP/evidence",
    {
      bears_on_kind: "claim",
      bears_on_id: claim.claim_id,
      bears_on_version: 1,
      direction: "refutes",
      kind: "computation",
      source: { kind: "locator", locator: "https://example.org/parity", excerpt: "1 mod 2 = 1." },
      computation_domain_or_floor: "The exact integer n=1, with exhaustive remainder computation.",
      mode: "confirmatory",
      body_md: "Integer 1 has remainder 1 under division by 2.",
    },
  );
  expect(evidenceResponse.status, await evidenceResponse.clone().text()).toBe(201);
  const evidence = (await evidenceResponse.json()) as {
    evidence_id: string;
    computed_class: string;
  };
  expect(evidence.computed_class).toBe("computation");
  const claimSource = (await f.db
    .prepare(`SELECT e.id,e.payload_sha256,v.content_digest
    FROM events e JOIN claim_versions v ON v.problem_id=e.problem_id AND v.claim_id=e.object_id
      AND v.version=e.object_version WHERE e.problem_id='P-4DSP' AND e.object_id=? AND e.type='claim.created'`)
    .bind(claim.claim_id)
    .first<{ id: string; payload_sha256: string; content_digest: string }>())!;
  const evidenceSource = (await f.db
    .prepare(`SELECT id,payload_sha256,seq FROM events
    WHERE problem_id='P-4DSP' AND object_id=? AND type='evidence.created'`)
    .bind(evidence.evidence_id)
    .first<{ id: string; payload_sha256: string; seq: number }>())!;
  const body = {
    target_object: claim.claim_id,
    reason: "The integer 1 is a counterexample; I concede the exact statement.",
    concession: {
      target_version: 1,
      target_digest: claimSource.content_digest,
      evidence: {
        evidence_id: evidence.evidence_id,
        digest: `sha256:${evidenceSource.payload_sha256}`,
      },
    },
  };
  const app = createApp({ createEnrollmentStore: () => f.enrollmentStore });
  const publicGet = (url: string) =>
    app.fetch(new Request(`https://a.asimposium.org${url}`), f.env);
  const state = async (target = claim.claim_id, through?: number) => {
    const response = await publicGet(
      `/p/P-4DSP/claims/${target}.json${through === undefined ? "" : `?through=${through}`}`,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const value = (await response.json()) as {
      claim_state: { disposition: string; stale: boolean; version: number };
    };
    return value.claim_state;
  };
  const count = async (table: string) =>
    (await f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
  const revise = () =>
    send(`${path}/revise`, {
      claim_id: claim.claim_id,
      base_version: 1,
      kind: "conjecture",
      statement: "Every even integer is divisible by two.",
      falsifier: "An even integer with a nonzero remainder modulo two.",
    });
  return {
    ...f,
    other,
    sendWith,
    send,
    path,
    claim,
    evidence,
    claimSource,
    evidenceSource,
    body,
    publicGet,
    state,
    count,
    revise,
  };
}

describe("author concession", () => {
  test("exact counterevidence reaches refuted across public faces, historical cuts and a fresh revision", async () => {
    let screens = 0;
    const f = await setup({
      screenPromotion: async () => {
        screens++;
        return { decision: "pass", coarse_category: "benign-context", provider_status: "ok" };
      },
    });
    expect((await f.state()).disposition).toBe("disputed");
    const response = await f.send(`${f.path}/retract`, f.body, "accepted-concession");
    expect(response.status, await response.clone().text()).toBe(201);
    const receipt = RetractResponseSchema.parse(await response.json());
    expect(receipt.target_object).toBe("C-1@1");
    expect(receipt.concession?.claim_source.event_id).toBe(f.claimSource.id);
    expect(receipt.concession?.claim_source.fellow_id).toBe(f.binding.fellowId);
    expect(receipt.concession?.evidence_source.fellow_id).toBe(f.other.binding.fellowId);
    expect(await f.state()).toMatchObject({ disposition: "refuted", version: 1, stale: false });
    expect((await f.state("C-1@1", f.evidenceSource.seq)).disposition).toBe("disputed");
    const list = RetractionsListResponseSchema.parse(
      await (await f.publicGet("/p/P-4DSP/retractions.json")).json(),
    );
    expect(list.retractions[0]?.concession).toEqual(receipt.concession);
    for (const format of ["md", "html"]) {
      const text = await (await f.publicGet(`/p/P-4DSP/retractions.${format}`)).text();
      expect(text).toContain("author concession");
      expect(text).toContain(f.evidence.evidence_id);
      expect(text).toContain(f.evidenceSource.payload_sha256);
    }
    const packed = await f.call(
      `${f.path}/pack?profile=full&max_tokens=8000&through=${receipt.seq}&after=0`,
    );
    expect(packed.status, await packed.clone().text()).toBe(200);
    const pack = (await packed.json()) as { items: { kind: string; body: string }[] };
    const correction = pack.items
      .filter((item) => item.kind === "full-event")
      .map((item) => JSON.parse(item.body))
      .find((item) => item.publication?.object_id === receipt.retraction_id);
    expect(correction?.content?.concession).toEqual(receipt.concession);
    const revised = await f.revise();
    expect(revised.status, await revised.clone().text()).toBe(201);
    expect(await f.state()).toMatchObject({ disposition: "open", version: 2 });
    expect((await f.state("C-1@1")).disposition).toBe("refuted");
    const beforeReplay = screens;
    const replay = await f.send(`${f.path}/retract`, f.body, "accepted-concession");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    expect(screens).toBe(beforeReplay);
    expect(await f.count("claim_concessions")).toBe(1);
    expect(await diffProjections(f.db, "P-4DSP")).toEqual({ drift: [], unreplayable: [] });
    const conflict = await f.send(
      `${f.path}/retract`,
      { ...f.body, reason: "A different acknowledgment of this statement." },
      "accepted-concession",
    );
    expect(conflict.status).toBe(409);
    const duplicate = await f.send(`${f.path}/retract`, f.body, "duplicate-concession");
    expect(duplicate.status).toBe(409);
    const oldEvidence = await f.send(
      `${f.path}/retract`,
      { ...f.body, concession: { ...f.body.concession, target_version: 2 } },
      "old-evidence-new-version",
    );
    expect(oldEvidence.status).toBe(422);
    expect(await f.count("claim_concessions")).toBe(1);
  });

  test("only the author can concede and incorrect pins refuse before screening", async () => {
    let screens = 0;
    const f = await setup({
      screenPromotion: async () => {
        screens++;
        return { decision: "pass", coarse_category: "benign-context", provider_status: "ok" };
      },
    });
    const before = screens,
      events = await f.count("events");
    for (const concession of [
      { ...f.body.concession, target_version: 2 },
      { ...f.body.concession, target_digest: `sha256:${"a".repeat(64)}` },
      {
        ...f.body.concession,
        evidence: { ...f.body.concession.evidence, digest: `sha256:${"b".repeat(64)}` },
      },
    ])
      expect((await f.send(`${f.path}/retract`, { ...f.body, concession })).status).toBe(422);
    const opened = await f.sendWith(f.other.call, "/v1/sessions", {
      problem_id: "P-4DSP",
      intent: "explore",
    });
    const session = (await opened.json()) as { session_id: string };
    const denied = await f.sendWith(
      f.other.call,
      `/v1/sessions/${session.session_id}/retract`,
      f.body,
    );
    expect(denied.status).toBe(403);
    expect(screens).toBe(before);
    expect(await f.count("events")).toBe(events);
    expect(await f.count("claim_concessions")).toBe(0);
  });

  for (const target of ["evidence", "concession"] as const) {
    test(`hidden ${target} cannot preserve refuted or turn concession into withdrawal`, async () => {
      const f = await setup();
      const response = await f.send(`${f.path}/retract`, f.body);
      expect(response.status, await response.clone().text()).toBe(201);
      const receipt = RetractResponseSchema.parse(await response.json());
      const row = await f.db
        .prepare("SELECT id FROM events WHERE problem_id='P-4DSP' AND object_id=?")
        .bind(receipt.retraction_id)
        .first<{ id: string }>();
      await redactEventContent(
        f.db,
        target === "evidence" ? f.evidenceSource.id : row!.id,
        "privacy",
        new Date().toISOString(),
      );
      expect(await f.state()).toMatchObject({ disposition: "disputed", stale: true });
      expect(await f.count("claim_concessions")).toBe(1);
      const hidden = await (await f.publicGet("/p/P-4DSP/retractions.json")).text();
      if (target === "concession") expect(hidden).not.toContain(f.body.reason);
    });
  }

  for (const change of ["source", "head"] as const) {
    test(`a ${change} change during screening rolls back concession, receipt and quota publication`, async () => {
      let race: (() => Promise<void>) | undefined;
      const f = await setup({
        screenPromotion: async (input) => {
          if (input.kind === "retraction" && race) {
            const action = race;
            race = undefined;
            await action();
          }
          return { decision: "pass", coarse_category: "benign-context", provider_status: "ok" };
        },
      });
      race =
        change === "source"
          ? async () => {
              await redactEventContent(
                f.db,
                f.evidenceSource.id,
                "privacy",
                new Date().toISOString(),
              );
            }
          : async () => {
              const revised = await f.revise();
              expect(revised.status).toBe(201);
            };
      const before = await f.count("events");
      const response = await f.send(`${f.path}/retract`, f.body);
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await f.count("claim_concessions")).toBe(0);
      expect(await f.count("retractions")).toBe(0);
      expect(await f.count("events")).toBe(before + (change === "head" ? 1 : 0));
      expect(
        await f.db
          .prepare("SELECT COUNT(*) AS n FROM session_write_replays WHERE scope='retract'")
          .first(),
      ).toEqual({ n: 0 });
      expect(
        await f.db
          .prepare(
            "SELECT COUNT(*) AS n FROM screening_publications p JOIN events e ON e.id=p.event_id WHERE e.type='object.retracted'",
          )
          .first(),
      ).toEqual({ n: 0 });
    });
  }

  test("conceded premises trigger one repair notice for each dependent author", async () => {
    const f = await setup({}, true);
    await deliverDispositionChanges(f.db);
    const prior = await f.db
      .prepare("SELECT fellow_id,target_id FROM fellow_inbox_notices WHERE caused_by_event_id=?")
      .bind(f.evidenceSource.id)
      .all<{ fellow_id: string; target_id: string }>();
    expect(prior.results).toEqual([{ fellow_id: f.other.binding.fellowId, target_id: "C-2" }]);
    const response = await f.send(`${f.path}/retract`, f.body);
    expect(response.status, await response.clone().text()).toBe(201);
    const receipt = RetractResponseSchema.parse(await response.json());
    const cause = (await f.db
      .prepare("SELECT id FROM events WHERE object_id=? AND problem_id='P-4DSP'")
      .bind(receipt.retraction_id)
      .first<{ id: string }>())!;
    const delivered = await deliverDispositionChanges(f.db);
    expect(delivered.failed).toBe(0);
    const notices = await f.db
      .prepare(
        "SELECT fellow_id,target_id,detail FROM fellow_inbox_notices WHERE caused_by_event_id=?",
      )
      .bind(cause.id)
      .all<{ fellow_id: string; target_id: string; detail: string }>();
    // The same dependent is already stale from the cited counterevidence.
    // Concession must not deliver a second notice for unchanged public facets.
    expect(notices.results).toHaveLength(0);
    expect(await deliverDispositionChanges(f.db)).toMatchObject({ examined: 0, notices: 0 });
    const states = await readScientificDispositions(f.db, "P-4DSP", receipt.seq, 10);
    expect(states.get("C-1")?.disposition).toBe("refuted");
    expect(states.get("C-2")?.disposition).toBe("open");
    expect(states.get("C-2")?.stale).toBe(true);
    await expect(
      f.db.prepare("UPDATE claim_concessions SET claim_version=2").run(),
    ).rejects.toThrow("CLAIM_CONCESSION_IMMUTABLE");
  });
});
