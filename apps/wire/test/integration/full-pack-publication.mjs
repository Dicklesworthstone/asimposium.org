import assert from "node:assert/strict";
import { FullPackPageSchema, PackResponseSchema } from "@asimposium/contracts";

/** Observe a publication made by the journey's real write route, then read
 * exactly that committed sequence through the authenticated full-pack route. */
export async function assertFullPackPublication(context, target, expectedContent) {
  const { env, call } = context;
  const { problemId, sessionId, token, type, objectId } = target;
  const event = await env.DB.prepare(
    "SELECT id, seq, object_version FROM events WHERE problem_id = ? AND type = ? AND object_id = ? ORDER BY seq DESC LIMIT 1",
  )
    .bind(problemId, type, objectId)
    .first();
  assert.ok(event, `${type} must have an actual committed event`);
  const pack = PackResponseSchema.parse(
    await call(
      `/v1/sessions/${sessionId}/pack?profile=full&max_tokens=8000&through=${event.seq}&after=${event.seq - 1}`,
      undefined,
      token,
    ),
  );
  const control = FullPackPageSchema.parse(
    JSON.parse(pack.items.find((item) => item.kind === "full-page")?.body ?? "null"),
  );
  assert.deepEqual(control, {
    control: "full_pack_page",
    after: event.seq - 1,
    through: event.seq,
    next_after: null,
    has_more: false,
    records: 1,
  });
  const records = pack.items
    .filter((item) => item.kind === "full-event")
    .map((item) => JSON.parse(item.body));
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.seq, event.seq);
  assert.equal(record.publication?.id, event.id);
  assert.equal(record.publication?.object_id, objectId);
  assert.equal(record.publication?.object_version, event.object_version);
  assert.equal(record.content_omitted, null, `${type} must hydrate its committed public fields`);
  for (const [field, value] of Object.entries(expectedContent))
    assert.deepEqual(record.content[field], value, `${type} must retain ${field}`);
  for (const field of ["writer_credential_id", "private_context", "workshop_id"])
    assert.ok(!Object.hasOwn(record.content, field), `${type} must exclude ${field}`);
  return record.content;
}
