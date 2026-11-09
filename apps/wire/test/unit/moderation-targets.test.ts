import { afterEach, describe, expect, test } from "bun:test";
import { HypothesisPublicationSchema } from "@asimposium/contracts/hypotheses";
import { renderHypothesesHtml, renderHypothesesMarkdown } from "@asimposium/render";
import { sha256Hex, writeLedgerEvent } from "../../src/krater/krater.ts";
import { hypothesisResponse } from "../../src/ledger/hypotheses-face.ts";
import {
  loadLiveHypotheses,
  loadPublicHypotheses,
  loadPublicHypothesisItem,
} from "../../src/ledger/hypotheses-service.ts";
import {
  operatorContentControl,
  operatorReportResolution,
} from "../../src/moderation/operator-http.ts";
import { fileReportRequest, type Reporter } from "../../src/moderation/router.ts";
import { currentContentControl } from "../../src/moderation/store.ts";
import {
  DISCLOSURE_PROBLEM,
  DISCLOSURE_SPONSOR,
  directiveDisclosureFixture,
} from "../support/directive-disclosure.ts";

// Real migrations and Krater commands on SQLite. Native HTTP/D1 integration
// remains a separate proof in moderation-real-bindings.mjs.
const TARGETS = [
  ["problem", "problem", "problem.admitted"],
  ["claim", "C-1", "claim.created"],
  ["hypothesis", "H-1", "hypothesis.created"],
  ["evidence", "E-1", "evidence.created"],
  ["review", "R-1", "review.created"],
  ["dead_end", "DE-1", "dead_end.recorded"],
  ["gap", "G-1", "gap.filed"],
  ["citation", "L-1", "citation.recorded"],
  ["question", "Q-1", "question.asked"],
  ["conflict", "CF-1", "conflict.normalized"],
  ["synthesis", "SYNTH-1", "synthesis.created"],
  ["retraction", "R-2", "object.retracted"],
] as const;
type Target = (typeof TARGETS)[number];
type Fixture = Awaited<ReturnType<typeof directiveDisclosureFixture>>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.sql.close();
});

async function fixture() {
  const f = await directiveDisclosureFixture({ publishProblem: true });
  fixtures.push(f);
  return f;
}

let nextEvent = 0;
const hypothesis = () =>
  HypothesisPublicationSchema.parse({
    route: "A finite construction",
    mechanism: "Construct the finite family explicitly.",
    falsifier: "An explicit member violating the bound.",
    expected_evidence: null,
    discriminating_predictions: ["Every member has the bounded statistic."],
    origin: "proposed",
    body_md: "MODERATION-PUBLICATION-CANARY: the complete finite construction.",
  });

async function publish(f: Fixture, kind: string, id: string, eventType: string, objectVersion = 1) {
  const payloadJson = JSON.stringify(
    kind === "hypothesis" && eventType === "hypothesis.created" ? hypothesis() : {},
  );
  const eventId = "E-moderation-" + ++nextEvent;
  return writeLedgerEvent(
    f.db,
    {
      problemId: DISCLOSURE_PROBLEM,
      eventId,
      idempotencyKey: eventId,
      requestDigest: await sha256Hex(payloadJson),
      eventType,
      objectKind: kind,
      objectId: id,
      objectVersion,
      payloadJson,
      createdAt: new Date().toISOString(),
      attribution: {
        fellowId: f.binding.fellowId,
        sponsorId: DISCLOSURE_SPONSOR,
        sessionId: "S-moderation",
        modelSelfDeclared: "test/model",
        harness: "curl",
      },
    },
    { statementsAfterEvent: () => [] },
  );
}

async function admit(f: Fixture, target: Target) {
  const [kind, id, eventType] = target;
  if (kind !== "problem" && kind !== "claim") await publish(f, kind, id, eventType);
}
function targetId(target: Target) {
  return target[0] === "problem" ? DISCLOSURE_PROBLEM : DISCLOSURE_PROBLEM + "/" + target[1];
}
function control(f: Fixture, target: Target, action: "hide" | "restore", key: string) {
  return operatorContentControl(
    f.db,
    "operator",
    {
      target_id: targetId(target),
      target_kind: target[0],
      action,
      reason: "PRIVATE-OPERATOR-RATIONALE: reviewed publication visibility.",
    },
    key,
  );
}
function counts(f: Fixture) {
  return f.sql
    .query(`SELECT
    (SELECT COUNT(*) FROM operator_audit) AS audits,
    (SELECT COUNT(*) FROM operator_command_receipts) AS receipts,
    (SELECT COUNT(*) FROM content_controls) AS controls,
    (SELECT COUNT(*) FROM moderation_log) AS logs`)
    .get();
}
function publishedRows(f: Fixture) {
  return f.sql
    .query(`SELECT e.id, e.seq, e.type, e.object_kind, e.object_id,
    e.object_version, e.payload_sha256, c.payload_json, c.redacted_at
    FROM events e LEFT JOIN event_content c ON c.event_id=e.id
    WHERE e.problem_id=? ORDER BY e.seq`)
    .all(DISCLOSURE_PROBLEM);
}
function reporter(sponsor: string, fellow: string | null = null): Reporter {
  return {
    reporterClass: fellow === null ? "sponsor" : "fellow",
    reporterSponsorId: sponsor,
    reporterFellowId: fellow,
  };
}
function report(f: Fixture, target: Target, identity: Reporter) {
  return fileReportRequest(f.db, identity, {
    problem_id: DISCLOSURE_PROBLEM,
    target: target[1],
    reason: "privacy",
    note: "PRIVATE-REPORT-NOTE: retained for operator review.",
  });
}

describe("published scientific target moderation", () => {
  for (const target of TARGETS) {
    const [kind, id] = target;
    test(
      kind + ": audited hide and restore retain immutable publications and receipt replay",
      async () => {
        const f = await fixture();
        await admit(f, target);
        const publications = publishedRows(f);
        const hidden = await control(f, target, "hide", "hide-target");
        expect(hidden.status).toBe(200);
        const receipt = await hidden.text();
        expect((await currentContentControl(f.db, DISCLOSURE_PROBLEM, id))?.visibility).toBe(
          "hidden",
        );
        expect((await control(f, target, "restore", "restore-target")).status).toBe(200);
        const before = counts(f);
        const replay = await control(f, target, "hide", "hide-target");
        expect(replay.status).toBe(200);
        expect(await replay.text()).toBe(receipt);
        expect((await currentContentControl(f.db, DISCLOSURE_PROBLEM, id))?.visibility).toBe(
          "visible",
        );
        expect(counts(f)).toEqual(before);
        expect(counts(f)).toMatchObject({ audits: 2, receipts: 2, controls: 2, logs: 2 });
        expect(publishedRows(f)).toEqual(publications);
        const log = JSON.stringify(f.sql.query("SELECT * FROM moderation_log").all());
        expect(log).not.toContain("PRIVATE-");
      },
    );

    test(kind + ": independent sponsors can hold and review the publication", async () => {
      const f = await fixture();
      await admit(f, target);
      const first = await report(f, target, reporter("family-one"));
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as { report_id: string };
      // Multiple Fellows of one accountable sponsor cannot form a threshold.
      for (const fellow of ["fellow-one", "fellow-two"]) {
        const duplicate = await report(f, target, reporter("family-one", fellow));
        expect(duplicate.status).toBe(200);
        expect(await duplicate.json()).toMatchObject({
          report_id: firstBody.report_id,
          deduplicated: true,
          target_hidden: false,
        });
      }
      expect((await report(f, target, reporter("family-two"))).status).toBe(201);
      expect(await currentContentControl(f.db, DISCLOSURE_PROBLEM, id)).toBeUndefined();
      const threshold = await report(f, target, reporter("family-three"));
      expect(threshold.status).toBe(201);
      expect(await threshold.json()).toMatchObject({ target_hidden: true });
      expect((await currentContentControl(f.db, DISCLOSURE_PROBLEM, id))?.source).toBe(
        "community-reports",
      );
      const resolved = await operatorReportResolution(
        f.db,
        "operator",
        {
          report_id: firstBody.report_id,
          resolution: "dismiss",
          reason: "The reviewed category does not justify this hold.",
        },
        "dismiss-report",
      );
      expect(resolved.status).toBe(200);
      expect((await currentContentControl(f.db, DISCLOSURE_PROBLEM, id))?.visibility).toBe(
        "visible",
      );
      expect(f.sql.query("SELECT DISTINCT status FROM reports").all()).toEqual([
        { status: "dismissed" },
      ]);
      const log = JSON.stringify(f.sql.query("SELECT * FROM moderation_log").all());
      expect(log).not.toContain("PRIVATE-");
      expect(log).not.toContain("family-one");
    });
  }

  test("fresh version pins, mismatched kinds and unpublished identities fail without side effects", async () => {
    const f = await fixture();
    await publish(f, "hypothesis", "H-1", "hypothesis.created");
    await publish(f, "hypothesis", "H-2", "hypothesis.deferred");
    await publish(f, "hypothesis", "H-3", "hypothesis.created", 2);
    const before = counts(f);
    for (const [target, kind] of [
      ["C-1@1", "claim"],
      ["H-1@1", "hypothesis"],
      ["H-1", "evidence"],
      ["H-2", "hypothesis"],
      ["H-3", "hypothesis"],
      ["H-999", "hypothesis"],
    ] as const) {
      const result = await operatorContentControl(
        f.db,
        "operator",
        {
          target_id: DISCLOSURE_PROBLEM + "/" + target,
          target_kind: kind,
          action: "hide",
          reason: "Review an exact existing whole publication.",
        },
        "refuse-" + target.replace("@", "-") + "-" + kind,
      );
      expect(result.status).toBe(404);
    }
    expect(counts(f)).toEqual(before);
    f.sql.query("UPDATE problems SET status='private-draft' WHERE id=?").run(DISCLOSURE_PROBLEM);
    expect((await control(f, TARGETS[2], "hide", "private-target")).status).toBe(404);
    expect((await control(f, TARGETS[0], "hide", "private-problem")).status).toBe(404);
    expect(counts(f)).toEqual(before);
  });

  test("a shared review/retraction id cannot broaden a visibility control across kinds", async () => {
    const f = await fixture();
    await publish(f, "review", "R-1", "review.created");
    await publish(f, "retraction", "R-1", "object.retracted");
    const before = counts(f);
    expect((await control(f, TARGETS[4], "hide", "ambiguous-review")).status).toBe(404);
    expect((await report(f, TARGETS[4], reporter("reviewing-sponsor"))).status).toBe(404);
    expect(counts(f)).toEqual(before);
    expect(f.sql.query("SELECT COUNT(*) AS n FROM reports").get()).toEqual({ n: 0 });
  });

  test("legacy atomic hypothesis ids remain controllable", async () => {
    const f = await fixture();
    const id = "H-" + "abcdef01".repeat(8);
    await publish(f, "hypothesis", id, "hypothesis.created");
    const result = await operatorContentControl(
      f.db,
      "operator",
      {
        target_id: DISCLOSURE_PROBLEM + "/" + id,
        target_kind: "hypothesis",
        action: "hide",
        reason: "Review the existing legacy publication.",
      },
      "legacy-hypothesis",
    );
    expect(result.status).toBe(200);
    expect((await currentContentControl(f.db, DISCLOSURE_PROBLEM, id))?.visibility).toBe("hidden");
  });

  test("current holds remove hypothesis bytes from old cursors, all representations and move candidates", async () => {
    const f = await fixture();
    const event = await publish(f, "hypothesis", "H-1", "hypothesis.created");
    const query = { through: String(event.seq) };
    const before = await loadPublicHypotheses(f.db, DISCLOSURE_PROBLEM, query);
    if (before === null) throw new Error("Published hypothesis fixture is missing.");
    expect(before.face.hypotheses[0]?.content?.body_md).toContain("MODERATION-PUBLICATION-CANARY");
    const originalRows = publishedRows(f);
    const representations = [
      ["json", (face: typeof before.face) => JSON.stringify(face)],
      ["md", renderHypothesesMarkdown],
      ["html", renderHypothesesHtml],
    ] as const;
    const oldEtags = new Map<string, string>();
    for (const [format, render] of representations) {
      const response = await hypothesisResponse(
        new Request("https://a.asimposium.org/p/" + DISCLOSURE_PROBLEM + "/hypotheses." + format),
        render(before.face),
        format,
        before.face,
        before.unlisted,
      );
      oldEtags.set(format, response.headers.get("etag") ?? "");
    }
    expect((await control(f, TARGETS[2], "hide", "withdraw-hypothesis")).status).toBe(200);
    const hidden = await loadPublicHypotheses(f.db, DISCLOSURE_PROBLEM, query);
    if (hidden === null) throw new Error("The public list envelope is missing.");
    expect(hidden.face.hypotheses[0]?.content).toBeNull();
    expect(hidden.face.hypotheses[0]?.publication).toEqual(before.face.hypotheses[0]?.publication);
    expect(await loadPublicHypothesisItem(f.db, DISCLOSURE_PROBLEM, "H-1", query)).toBeNull();
    const moves = await loadLiveHypotheses(f.db, DISCLOSURE_PROBLEM, event.seq);
    expect(moves?.face.hypotheses[0]?.content).toBeNull();
    for (const [format, render] of representations) {
      const body = render(hidden.face);
      expect(body).not.toContain("MODERATION-PUBLICATION-CANARY");
      const response = await hypothesisResponse(
        new Request("https://a.asimposium.org/p/" + DISCLOSURE_PROBLEM + "/hypotheses." + format, {
          headers: { "if-none-match": oldEtags.get(format) ?? "" },
        }),
        body,
        format,
        hidden.face,
        hidden.unlisted,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).not.toBe(oldEtags.get(format));
    }
    expect((await control(f, TARGETS[2], "restore", "restore-hypothesis")).status).toBe(200);
    const restored = await loadPublicHypothesisItem(f.db, DISCLOSURE_PROBLEM, "H-1", query);
    expect(restored?.face.hypotheses[0]?.content?.body_md).toContain(
      "MODERATION-PUBLICATION-CANARY",
    );
    expect(publishedRows(f)).toEqual(originalRows);
  });
});
