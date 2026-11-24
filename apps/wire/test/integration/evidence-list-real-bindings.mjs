import assert from "node:assert/strict";
import { ContractProblemSchema, HypothesisEvidenceItemResponseSchema } from "@asimposium/contracts";
import { EvidenceListResponseSchema } from "@asimposium/contracts/research-lists";
import { ensureProblem } from "../../src/krater/krater.ts";
import { appendClaimsListFixture } from "../support/claims-list-fixture.ts";
import {
  appendEvidenceHypothesisFixture,
  appendEvidenceListFixture,
  EVIDENCE_LIST_ATTRIBUTION,
  EVIDENCE_LIST_TIME,
} from "../support/evidence-list-fixture.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");
const problem = "P-EVIDENCE-PAGES";
const directory = "/p/" + problem + "/evidence";

// Actual Workerd HTTP and migrated D1 over explicit immutable-publication
// fixtures. This proves inventory reads, not screening or scientific admission.
async function evidenceListJourney({ call, worker, env, origin, userAgent }) {
  await ensureProblem(env.DB, problem, EVIDENCE_LIST_TIME);
  await env.DB.prepare(
    "UPDATE problems SET title='Evidence history fixture',status='active' WHERE id=?",
  )
    .bind(problem)
    .run();
  await appendClaimsListFixture(env.DB, problem, 1);
  await appendEvidenceHypothesisFixture(env.DB, problem);
  for (let number = 1; number <= 205; number++)
    await appendEvidenceListFixture(
      env.DB,
      problem,
      number,
      number % 2 === 0
        ? { kind: "hypothesis", id: "H-1" }
        : { kind: "claim", id: "C-1", version: 1 },
    );

  const fetch = (path, init = {}) =>
    worker.fetch(new URL(path, origin).href, {
      ...init,
      headers: { "User-Agent": userAgent, ...init.headers },
    });
  const firstResponse = await fetch(directory + ".json");
  assert.equal(firstResponse.status, 200);
  const first = EvidenceListResponseSchema.parse(await firstResponse.json());
  assert.equal(first.cursor, 207);
  assert.equal(first.count, 8);
  assert.equal(first.next_after, 10);
  const pinned = firstResponse.headers.get("content-location");
  const etag = firstResponse.headers.get("etag");
  assert.equal(pinned, directory + ".json?through=207&after=0");
  assert.ok(etag);
  assert.ok(
    firstResponse.headers
      .get("link")
      .includes(directory + '.json?through=207&after=10>; rel="next"'),
  );
  assert.deepEqual(first.evidence[0].bears_on, { kind: "claim", id: "C-1", version: 1 });
  assert.deepEqual(first.evidence[1].bears_on, { kind: "hypothesis", id: "H-1" });
  assert.equal(first.evidence[0].publication.fellow_id, EVIDENCE_LIST_ATTRIBUTION.fellowId);
  assert.equal(first.evidence[0].publication.sponsor_id, EVIDENCE_LIST_ATTRIBUTION.sponsorId);
  assert.equal(first.evidence[0].publication.session_id, EVIDENCE_LIST_ATTRIBUTION.sessionId);
  assert.equal(
    first.evidence[0].publication.model_self_declared,
    EVIDENCE_LIST_ATTRIBUTION.modelSelfDeclared,
  );
  assert.equal(
    first.evidence[0].publication.harness_self_declared,
    EVIDENCE_LIST_ATTRIBUTION.harness,
  );
  assert.ok(
    first.evidence.every(
      (entry) => entry.kind === "negative-result" && entry.mode === "exploratory",
    ),
  );
  assert.ok(
    first.evidence.every((entry) => !("computed_class" in entry) && !("standing" in entry)),
  );

  const exact = HypothesisEvidenceItemResponseSchema.parse(await call(first.evidence[1].read_url));
  assert.equal(exact.evidence_id, first.evidence[1].evidence_id);
  assert.deepEqual(exact.publication, first.evidence[1].publication);
  assert.equal(exact.content.bears_on_id, "H-1");
  assert.equal((await fetch(first.evidence[0].read_url)).status, 200);

  await appendClaimsListFixture(env.DB, problem, 1, 2);
  await appendEvidenceListFixture(env.DB, problem, 206);
  assert.equal((await fetch(pinned, { headers: { "if-none-match": etag } })).status, 304);
  const entries = [...first.evidence];
  let after = first.next_after;
  let pages = 1;
  while (after !== null) {
    const page = EvidenceListResponseSchema.parse(
      await call(directory + ".json?through=" + first.cursor + "&after=" + after),
    );
    assert.equal(page.cursor, first.cursor);
    assert.ok(page.count <= 8);
    entries.push(...page.evidence);
    after = page.next_after;
    assert.ok(++pages <= 26, "The fixed source history must terminate");
  }
  assert.equal(pages, 26);
  assert.deepEqual(
    entries.map((entry) => entry.evidence_id),
    Array.from({ length: 205 }, (_, i) => "E-" + (i + 1)),
  );
  assert.equal(new Set(entries.map((entry) => entry.evidence_id)).size, 205);
  assert.ok(
    entries.every((entry) => entry.bears_on.kind === "hypothesis" || entry.bears_on.version === 1),
  );
  const later = EvidenceListResponseSchema.parse(
    await call(directory + ".json?through=209&after=207"),
  );
  assert.deepEqual(
    later.evidence.map((entry) => entry.evidence_id),
    ["E-206"],
  );

  for (const format of ["json", "md", "html"]) {
    const path = directory + "." + format + "?through=207&after=0";
    const response = await fetch(path);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes("E-1"));
    assert.ok(
      response.headers.get("link").includes(directory + "." + format + "?through=207&after=10"),
    );
    const head = await fetch(path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(body)));
    const conditional = await fetch(path, {
      headers: { "if-none-match": '"unrelated", W/' + response.headers.get("etag") },
    });
    assert.equal(conditional.status, 304);
  }
  for (const query of [
    "?after=0",
    "?through=999",
    "?through=207&after=208",
    "?through=0207",
    "?through=207&through=207",
    "?through=207&unknown=1",
  ]) {
    const response = await fetch(directory + ".json" + query);
    assert.equal(response.status, 400);
    assert.equal(ContractProblemSchema.parse(await response.json()).code, "CURSOR_INVALID");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }

  let controlSerial = 0;
  const versions = new Map();
  async function control(kind, target, visibility) {
    const version = (versions.get(target) ?? 0) + 1;
    versions.set(target, version);
    await env.DB.prepare(
      "INSERT INTO content_controls (control_id,problem_id,target_kind,target_ref,visibility,source,reason_category,actor,reason,version,created_at) VALUES(?,?,?,?,?,'operator','privacy','operator','Inventory read fixture.',?,?)",
    )
      .bind(
        "CC-EVIDENCE-" + ++controlSerial,
        problem,
        kind,
        target,
        visibility,
        version,
        EVIDENCE_LIST_TIME,
      )
      .run();
  }
  await control("evidence", "E-1", "hidden");
  const hidden = await fetch(pinned, { headers: { "if-none-match": etag } });
  assert.equal(hidden.status, 200);
  const hiddenFace = EvidenceListResponseSchema.parse(await hidden.json());
  assert.ok(!hiddenFace.evidence.some((entry) => entry.evidence_id === "E-1"));
  assert.ok(hiddenFace.omitted.includes("content_unavailable"));
  await control("hypothesis", "H-1", "hidden");
  const targetHidden = EvidenceListResponseSchema.parse(await call(pinned));
  assert.ok(targetHidden.evidence.every((entry) => entry.bears_on.kind === "claim"));
  for (let number = 2; number <= 8; number++) await control("evidence", "E-" + number, "hidden");
  const withheld = EvidenceListResponseSchema.parse(await call(pinned));
  assert.equal(withheld.count, 0);
  assert.equal(withheld.scanned_through, 10);
  assert.equal(withheld.next_after, 10);
  const continuation = EvidenceListResponseSchema.parse(
    await call(directory + ".json?through=207&after=" + withheld.next_after),
  );
  assert.ok(continuation.count > 0);
  assert.equal(continuation.evidence[0].evidence_id, "E-9");
  for (let number = 1; number <= 8; number++) await control("evidence", "E-" + number, "visible");
  await control("hypothesis", "H-1", "visible");
  assert.deepEqual(EvidenceListResponseSchema.parse(await call(pinned)), first);

  await env.DB.prepare("UPDATE problems SET unlisted=1 WHERE id=?").bind(problem).run();
  const unlisted = await fetch(pinned);
  assert.equal(unlisted.status, 200);
  assert.equal(unlisted.headers.get("cache-control"), "private, no-store");
  assert.equal(unlisted.headers.get("x-robots-tag"), "noindex, nofollow");
  await control("problem", "problem", "hidden");
  const unavailable = await fetch(pinned, { headers: { "if-none-match": etag } });
  assert.equal(unavailable.status, 404);
  assert.equal(ContractProblemSchema.parse(await unavailable.json()).code, "PROBLEM_NOT_FOUND");
  await control("problem", "problem", "visible");
  await env.DB.prepare("UPDATE problems SET unlisted=0 WHERE id=?").bind(problem).run();

  return {
    kind: "evidence-list-real-bindings",
    status: "pass",
    scope: "native Workerd and migrated D1 inventory reads; fixture admissions bypass screening",
    captured_cursor: first.cursor,
    publications: entries.length,
    pages,
    exact_source_links: true,
    current_visibility: true,
  };
}

runLocalWorkerJourney(evidenceListJourney, {
  projectionParitySeeded: (id) => id === problem,
})
  .then((receipt) => console.log(JSON.stringify(receipt)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
