import { test } from "bun:test";
import assert from "node:assert/strict";
import { deliverArtifactPublication } from "../../src/krater/artifact-publication-outbox.ts";
import {
  readEvidenceArtifacts,
  readPublicArtifactManifest,
} from "../../src/krater/artifact-publication-read.ts";
import {
  ArtifactPublicationError,
  publicationHash,
  readPublicationJob,
  requestArtifactPublication,
} from "../../src/krater/artifact-publication-store.ts";
import { publicationFixture } from "./artifact-publication-fixture.ts";

type Fixture = Awaited<ReturnType<typeof publicationFixture>>;
const notFound = (e: unknown) => e instanceof ArtifactPublicationError && e.code === "NOT_FOUND";
function control(f: Fixture, target: string, visibility = "hidden") {
  f.sql
    .query(`INSERT INTO content_controls SELECT ?,?,?,COALESCE(MAX(version),0)+1
    FROM content_controls WHERE problem_id=? AND target_ref=?`)
    .run(f.problem, target, visibility, f.problem, target);
}
async function queue(kind: "claim" | "hypothesis" = "claim") {
  const f = await publicationFixture(kind);
  const receipt = await requestArtifactPublication(
    f.options,
    f.actor,
    f.upload,
    f.input,
    "publish",
  );
  return { ...f, receipt, id: receipt.publication_id };
}
async function noRelease(f: Awaited<ReturnType<typeof queue>>, screens: number) {
  const job = (await readPublicationJob(f.db, f.id))!;
  assert.equal(job.state, "held");
  assert.equal(job.failure_code, "binding-unavailable");
  assert.equal(job.released_at, null);
  assert.equal(job.screen_attempts, screens);
  assert.equal(f.screens(), screens);
  assert.equal(f.publicStore.writes(), 0);
}

for (const kind of ["claim", "hypothesis"] as const) {
  for (const source of [
    "problem",
    "evidence",
    "evidence-version",
    "evidence-event",
    "target",
    "target-version",
    "target-event",
  ]) {
    const targetRef = (f: Fixture) =>
      ({
        problem: "problem",
        evidence: "E-1",
        "evidence-version": "E-1@1",
        "evidence-event": "#2",
        target: f.targetId,
        "target-version": `${f.targetId}@1`,
        "target-event": "#1",
      })[source]!;
    test(`${kind} artifact refuses a currently hidden ${source} before quota or storage`, async () => {
      const f = await publicationFixture(kind);
      control(f, targetRef(f));
      let reads = 0;
      f.privateStore.hooks.get = () => {
        reads++;
      };
      await assert.rejects(
        requestArtifactPublication(f.options, f.actor, f.upload, f.input, "publish"),
        notFound,
      );
      assert.equal(f.reservations(), 0);
      assert.equal(reads, 0);
      assert.equal(f.count("artifact_publications"), 0);
    });
    test(`${kind} queued artifact never screens a currently hidden ${source}`, async () => {
      const f = await queue(kind);
      control(f, targetRef(f));
      assert.equal(await deliverArtifactPublication(f.drainer, f.id), "held");
      await noRelease(f, 0);
    });
  }

  test(`${kind} observers can publish their own evidence artifacts at both authority boundaries`, async () => {
    const f = await publicationFixture(kind);
    f.sql.exec("UPDATE problem_memberships SET role='observer'");
    const receipt = await requestArtifactPublication(
      f.options,
      f.actor,
      f.upload,
      f.input,
      "publish",
    );
    assert.equal(await deliverArtifactPublication(f.drainer, receipt.publication_id), "published");
    const result = await readPublicArtifactManifest(
      f.db,
      f.options.artifactOrigin,
      f.problem,
      receipt.publication_id,
    );
    assert.equal(result.face.author.fellow_id, f.actor.fellowId);
    assert.equal(result.face.verification, "bytes-only");
  });

  for (const mutation of [
    "UPDATE evidence SET source_event_id='other-event'",
    "UPDATE evidence SET source_seq=99",
    "UPDATE evidence SET bears_on_id='other-target'",
    "UPDATE evidence SET bears_on_kind='other-kind'",
    "UPDATE evidence SET bears_on_version=99",
    "UPDATE event_content SET redacted_at='gone' WHERE event_id='TARGET-1'",
    "UPDATE event_content SET payload_json='{}' WHERE event_id='TARGET-1'",
    "INSERT INTO scientific_withdrawals VALUES('EV-1')",
  ]) {
    test(`${kind} publication refuses unavailable or substituted canonical sources: ${mutation}`, async () => {
      const f = await publicationFixture(kind);
      f.sql.exec(mutation);
      await assert.rejects(
        requestArtifactPublication(f.options, f.actor, f.upload, f.input, "publish"),
      );
      assert.equal(f.reservations(), 0);
      assert.equal(f.count("artifact_publications"), 0);
    });
  }

  test(`${kind} source visibility changing during storage inspection rolls back publication`, async () => {
    const f = await publicationFixture(kind);
    f.privateStore.hooks.get = () => control(f, f.targetId);
    await assert.rejects(
      requestArtifactPublication(f.options, f.actor, f.upload, f.input, "publish"),
    );
    assert.equal(f.count("events"), 2);
    assert.equal(f.count("artifact_publications"), 0);
    assert.equal(f.count("artifact_publication_jobs"), 0);
    assert.equal(f.screens(), 0);
  });

  test(`${kind} target bytes changing during storage inspection cannot pass a matching hash column`, async () => {
    const f = await publicationFixture(kind);
    f.hooks.beforeWrite = () =>
      f.sql.exec("UPDATE event_content SET payload_json='{}' WHERE event_id='TARGET-1'");
    await assert.rejects(
      requestArtifactPublication(f.options, f.actor, f.upload, f.input, "publish"),
    );
    assert.equal(f.count("artifact_publications"), 0);
  });

  for (const source of [
    "problem",
    "target",
    "evidence",
    "publication",
    "target-bytes",
    "withdrawal",
  ]) {
    test(`${kind} ${source} change during a paid pass wins the release race`, async () => {
      const f = await queue(kind);
      const normal = f.drainer.screen;
      const outcome = await deliverArtifactPublication(
        {
          ...f.drainer,
          screen: async (...args) => {
            const receipt = await normal(...args);
            if (source === "target-bytes")
              f.sql.exec("UPDATE event_content SET payload_json='{}' WHERE event_id='TARGET-1'");
            else if (source === "withdrawal")
              f.sql.exec("INSERT INTO scientific_withdrawals VALUES('EV-1')");
            else
              control(
                f,
                source === "target"
                  ? f.targetId
                  : source === "evidence"
                    ? "E-1"
                    : source === "publication"
                      ? f.id
                      : "problem",
              );
            return receipt;
          },
        },
        f.id,
      );
      assert.equal(outcome, "held");
      await noRelease(f, 1);
    });
  }
}

test("a transition to observer during publication still authorizes evidence without claim-promotion power", async () => {
  const f = await publicationFixture();
  f.hooks.beforeWrite = () => f.sql.exec("UPDATE problem_memberships SET role='observer'");
  await requestArtifactPublication(f.options, f.actor, f.upload, f.input, "publish");
  assert.equal(f.count("artifact_publications"), 1);
});

test("observer evidence publication still requires both explicit scopes", async () => {
  for (const scope of ["promote", "upload-artifacts"] as const) {
    const f = await publicationFixture();
    f.sql.exec("UPDATE problem_memberships SET role='observer'");
    await assert.rejects(
      requestArtifactPublication(
        f.options,
        { ...f.actor, grantedScopes: [scope] },
        f.upload,
        f.input,
        "publish",
      ),
    );
    assert.equal(f.reservations(), 0);
  }
});

test("canonical hypothesis creation remains the source after the hypothesis is killed", async () => {
  const f = await publicationFixture("hypothesis");
  f.sql.exec("UPDATE hypotheses SET status='killed'");
  const r = await requestArtifactPublication(f.options, f.actor, f.upload, f.input, "publish");
  assert.equal(await deliverArtifactPublication(f.drainer, r.publication_id), "published");
});

test("hypothesis projection substitution cannot substitute artifact authority", async () => {
  for (const mutation of [
    "source_event_id='elsewhere'",
    "source_seq=99",
    "author_fellow_id='elsewhere'",
  ]) {
    const f = await publicationFixture("hypothesis");
    f.sql.exec(`UPDATE hypotheses SET ${mutation}`);
    await assert.rejects(
      requestArtifactPublication(f.options, f.actor, f.upload, f.input, "publish"),
      notFound,
    );
    assert.equal(f.reservations(), 0);
  }
});

for (const kind of ["claim", "hypothesis"] as const) {
  test(`an existing valid ${kind} cannot replace the target named by immutable evidence bytes`, async () => {
    const f = await publicationFixture(kind);
    const alternate = kind === "claim" ? "C-2" : "H-2";
    const body =
      kind === "claim"
        ? JSON.stringify({ ...JSON.parse(f.targetJson), claim_id: alternate })
        : f.targetJson;
    const digest = await publicationHash(body);
    f.sql.exec("UPDATE events SET seq=3 WHERE id='EV-1'");
    f.sql.exec("UPDATE evidence SET source_seq=3");
    f.sql.exec("UPDATE problems SET public_seq=3");
    f.sql
      .query(`INSERT INTO events SELECT 'ALTERNATE-TARGET',problem_id,2,type,object_kind,?,1,?,
      actor_fellow_id,actor_sponsor_id,actor_session_id,writer_credential_id,created_at FROM events WHERE id=?`)
      .run(alternate, digest, f.targetEvent);
    f.sql.query("INSERT INTO event_content VALUES('ALTERNATE-TARGET',?,?,NULL)").run(digest, body);
    if (kind === "claim")
      f.sql
        .query("INSERT INTO claim_versions VALUES(?,?,1,?)")
        .run(f.problem, alternate, f.actor.fellowId);
    else
      f.sql
        .query("INSERT INTO hypotheses VALUES(?,?,?,'ALTERNATE-TARGET',2,'open')")
        .run(f.problem, alternate, f.actor.fellowId);
    f.sql.query("UPDATE evidence SET bears_on_id=?").run(alternate);
    await assert.rejects(
      requestArtifactPublication(f.options, f.actor, f.upload, f.input, "publish"),
      notFound,
    );
    assert.equal(f.reservations(), 0);
  });
}

test("an artifact keeps its exact historical claim version after a newer claim revision", async () => {
  const f = await publicationFixture();
  const body = JSON.stringify({
    claim_id: f.targetId,
    base_version: 1,
    kind: "numerical",
    statement: "A revised result.",
  });
  const hash = await publicationHash(body);
  f.sql
    .query("INSERT INTO claim_versions VALUES(?,?,2,?)")
    .run(f.problem, f.targetId, f.actor.fellowId);
  f.sql
    .query(`INSERT INTO events SELECT 'TARGET-2',problem_id,3,'claim.revised','claim',object_id,2,?,
    actor_fellow_id,actor_sponsor_id,actor_session_id,writer_credential_id,created_at FROM events WHERE id=?`)
    .run(hash, f.targetEvent);
  f.sql.query("INSERT INTO event_content VALUES('TARGET-2',?,?,NULL)").run(hash, body);
  f.sql.exec("UPDATE problems SET public_seq=3");
  control(f, `${f.targetId}@2`);
  const r = await requestArtifactPublication(f.options, f.actor, f.upload, f.input, "publish");
  assert.equal(await deliverArtifactPublication(f.drainer, r.publication_id), "published");
});

test("an ambiguous second claim source cannot replace the original canonical source", async () => {
  const f = await publicationFixture();
  f.sql
    .query(`INSERT INTO events SELECT 'DUPLICATE',problem_id,3,type,object_kind,object_id,object_version,payload_sha256,
    actor_fellow_id,actor_sponsor_id,actor_session_id,writer_credential_id,created_at FROM events WHERE id=?`)
    .run(f.targetEvent);
  await assert.rejects(
    requestArtifactPublication(f.options, f.actor, f.upload, f.input, "publish"),
    notFound,
  );
  assert.equal(f.reservations(), 0);
});

test("an alternate evidence event cannot become the source by replacing projection pointers", async () => {
  const f = await publicationFixture();
  f.sql.exec(`INSERT INTO events SELECT 'ALTERNATE-EVIDENCE',problem_id,3,type,object_kind,object_id,object_version,payload_sha256,
    actor_fellow_id,actor_sponsor_id,actor_session_id,writer_credential_id,created_at FROM events WHERE id='EV-1'`);
  f.sql.exec(
    "INSERT INTO event_content SELECT 'ALTERNATE-EVIDENCE',payload_sha256,payload_json,NULL FROM event_content WHERE event_id='EV-1'",
  );
  f.sql.exec("UPDATE evidence SET source_event_id='ALTERNATE-EVIDENCE',source_seq=3");
  f.sql.exec("UPDATE problems SET public_seq=3");
  await assert.rejects(
    requestArtifactPublication(f.options, f.actor, f.upload, f.input, "publish"),
    notFound,
  );
  assert.equal(f.reservations(), 0);
});

test("visibility changing after hashing but before screen admission does not spend a paid attempt", async () => {
  const f = await queue();
  f.hooks.beforeRun = (sql) => {
    if (sql.includes("SET screen_attempts = screen_attempts + 1")) control(f, f.targetId);
  };
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "held");
  await noRelease(f, 0);
});

test("a target hidden during the evidence hash cannot consume publication admission quota", async () => {
  const f = await publicationFixture();
  f.hooks.afterRead = (sql) => {
    if (sql.startsWith("SELECT * FROM artifact_publication_evidence")) {
      f.hooks.afterRead = undefined;
      control(f, f.targetId);
    }
  };
  await assert.rejects(
    requestArtifactPublication(f.options, f.actor, f.upload, f.input, "publish"),
    notFound,
  );
  assert.equal(f.reservations(), 0);
});

test("publication-event controls suppress delivery and public listing without changing existing bytes", async () => {
  for (const target of ["object", "version", "event"]) {
    const f = await queue();
    const ref =
      target === "object" ? f.id : target === "version" ? `${f.id}@1` : `#${f.receipt.seq}`;
    control(f, ref);
    assert.equal(await deliverArtifactPublication(f.drainer, f.id), "held");
    await noRelease(f, 0);
  }
  const f = await queue();
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "published");
  control(f, f.id);
  await assert.rejects(
    readPublicArtifactManifest(f.db, f.options.artifactOrigin, f.problem, f.id),
    notFound,
  );
  assert.deepEqual(
    (await readEvidenceArtifacts(f.db, f.options.artifactOrigin, f.problem, "E-1")).artifacts,
    [],
  );
  assert.equal(f.publicStore.writes(), 1);
});

test("restoring an object cannot override an independently hidden source event", async () => {
  const f = await queue();
  await deliverArtifactPublication(f.drainer, f.id);
  control(f, "#1");
  control(f, f.targetId, "visible");
  await assert.rejects(
    readPublicArtifactManifest(f.db, f.options.artifactOrigin, f.problem, f.id),
    notFound,
  );
  await assert.rejects(
    readEvidenceArtifacts(f.db, f.options.artifactOrigin, f.problem, "E-1"),
    notFound,
  );
  control(f, "#1", "visible");
  const restored = await readPublicArtifactManifest(
    f.db,
    f.options.artifactOrigin,
    f.problem,
    f.id,
  );
  assert.equal(restored.face.publication_id, f.id);
  assert.equal(f.publicStore.writes(), 1);
});

test("a source hidden while a manifest is being hashed cannot leak in its final read", async () => {
  const f = await queue();
  await deliverArtifactPublication(f.drainer, f.id);
  f.hooks.afterRead = (sql) => {
    if (sql.startsWith("SELECT c.payload_json FROM events")) {
      f.hooks.afterRead = undefined;
      control(f, f.targetId);
    }
  };
  await assert.rejects(
    readPublicArtifactManifest(f.db, f.options.artifactOrigin, f.problem, f.id),
    notFound,
  );
});

for (const change of [
  "publication-hide",
  "publication-redaction",
  "publication-bytes",
  "evidence-hide",
  "target-bytes",
]) {
  test(`a late ${change} while listing artifacts cannot leak an earlier item`, async () => {
    const f = await queue();
    await deliverArtifactPublication(f.drainer, f.id);
    const upload = `AU-${"b".repeat(32)}`;
    f.sql
      .query(`INSERT INTO artifact_uploads SELECT ?,fellow_id,sponsor_id,problem_id,state,
      sha256,size_bytes,encoding,content_type FROM artifact_uploads WHERE upload_id=?`)
      .run(upload, f.upload);
    const next = await requestArtifactPublication(
      f.options,
      f.actor,
      upload,
      f.input,
      "next-artifact",
    );
    await deliverArtifactPublication(f.drainer, next.publication_id);
    let reads = 0;
    f.hooks.afterRead = (sql) => {
      if (!sql.startsWith("SELECT * FROM artifact_publication_evidence") || ++reads !== 4) return;
      if (change === "publication-hide") control(f, f.id);
      if (change === "publication-redaction")
        f.sql
          .query("UPDATE event_content SET redacted_at='gone' WHERE event_id=?")
          .run(f.receipt.event_id);
      if (change === "publication-bytes")
        f.sql
          .query("UPDATE event_content SET payload_json='{}' WHERE event_id=?")
          .run(f.receipt.event_id);
      if (change === "evidence-hide") control(f, "E-1");
      if (change === "target-bytes")
        f.sql.exec("UPDATE event_content SET payload_json='{}' WHERE event_id='TARGET-1'");
    };
    const page = readEvidenceArtifacts(f.db, f.options.artifactOrigin, f.problem, "E-1");
    if (change === "evidence-hide" || change === "target-bytes")
      await assert.rejects(page, notFound);
    else
      assert.deepEqual(
        (await page).artifacts.map((item) => item.publication_id),
        [next.publication_id],
      );
    assert.equal(reads, 4, "the mutation occurs after earlier items have already been read");
  });
}

test("a full artifact page retains its delivery boundary when a publication is hidden", async () => {
  const f = await queue();
  const receipts = [f.receipt];
  await deliverArtifactPublication(f.drainer, f.id);
  for (let i = 1; i <= 20; i++) {
    const upload = `AU-${i.toString(16).padStart(32, "0")}`;
    f.sql
      .query(`INSERT INTO artifact_uploads SELECT ?,fellow_id,sponsor_id,problem_id,state,
      sha256,size_bytes,encoding,content_type FROM artifact_uploads WHERE upload_id=?`)
      .run(upload, f.upload);
    const receipt = await requestArtifactPublication(
      f.options,
      f.actor,
      upload,
      f.input,
      `page-${i}`,
    );
    await deliverArtifactPublication(f.drainer, receipt.publication_id);
    receipts.push(receipt);
  }
  control(f, receipts[2]!.publication_id);
  const page = await readEvidenceArtifacts(f.db, f.options.artifactOrigin, f.problem, "E-1");
  assert.equal(page.artifacts.length, 19);
  assert.deepEqual(
    page.artifacts.map((item) => item.publication_id),
    receipts
      .slice(0, 20)
      .filter((_, index) => index !== 2)
      .map((item) => item.publication_id),
  );
  assert.equal(page.next_after, page.artifacts.at(-1)!.delivery_cursor);
  const next = await readEvidenceArtifacts(
    f.db,
    f.options.artifactOrigin,
    f.problem,
    "E-1",
    page.next_after!,
    page.through,
  );
  assert.deepEqual(
    next.artifacts.map((item) => item.publication_id),
    [receipts[20]!.publication_id],
  );
  assert.equal(next.next_after, null);
});

test("an uncertain already-authorized public PUT reconciles after source moderation without a new pass", async () => {
  const f = await queue();
  f.publicStore.hooks.get = () => {
    throw new Error("lost public readback");
  };
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "retry");
  assert.equal((await readPublicationJob(f.db, f.id))!.state, "release-authorized");
  assert.equal(f.publicStore.writes(), 1);
  control(f, f.targetId);
  f.publicStore.hooks.get = undefined;
  f.advance(60_000);
  assert.equal(await deliverArtifactPublication(f.drainer, f.id), "published");
  assert.equal(f.screens(), 1);
  assert.equal(f.publicStore.writes(), 1);
  await assert.rejects(
    readPublicArtifactManifest(f.db, f.options.artifactOrigin, f.problem, f.id),
    notFound,
  );
  await assert.rejects(
    readEvidenceArtifacts(f.db, f.options.artifactOrigin, f.problem, "E-1"),
    notFound,
  );
});
