import { describe, expect, test } from "bun:test";
import { fellowWriteRecord } from "../../src/sessions/write-ops-log";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

describe("fellow-write OPS.2a record (asimposiumorg-rvi)", () => {
  test("a commit carries the event id and seq, never the body or the key", async () => {
    const record = await fellowWriteRecord(
      {
        route: "/v1/p/:id/claims",
        method: "POST",
        status: 201,
        scopeId: "P-ABC123",
        idempotencyKey: "secret-retry-key-1",
        response: json(
          { event_id: "E-ABCDEFGHJKMN", seq: 7, statement: "Private-looking canary text" },
          201,
        ),
        startedAt: 1_000,
      },
      1_250,
    );
    expect(record).toMatchObject({
      facility: "OPS.2a",
      stage: "fellow-write",
      route: "/v1/p/:id/claims",
      outcome: "committed-or-replayed",
      code: null,
      scope_id: "P-ABC123",
      event_id: "E-ABCDEFGHJKMN",
      seq: 7,
      latency_ms: 250,
    });
    expect(record.idempotency_key_digest).toMatch(/^[0-9a-f]{64}$/);
    const text = JSON.stringify(record);
    expect(text).not.toContain("canary");
    expect(text).not.toContain("secret-retry-key-1");
  });

  test("a refusal carries only a well-formed code", async () => {
    const refused = await fellowWriteRecord({
      route: "/v1/p/:id/claims",
      method: "POST",
      status: 403,
      scopeId: "P-ABC123",
      idempotencyKey: null,
      response: json({ code: "POLICY_DENIED", detail: "coarse" }, 403),
      startedAt: Date.now(),
    });
    expect(refused).toMatchObject({ outcome: "refused", code: "POLICY_DENIED", event_id: null });
    expect(refused.idempotency_key_digest).toBeNull();
    const odd = await fellowWriteRecord({
      route: "/v1/p/:id/claims",
      method: "POST",
      status: 422,
      scopeId: "not an id",
      idempotencyKey: null,
      response: json({ code: "free text with spaces", event_id: "<script>" }, 422),
      startedAt: Date.now(),
    });
    expect(odd).toMatchObject({ code: null, event_id: null, scope_id: null });
  });

  test("a non-JSON or oversized response is not parsed", async () => {
    const big = await fellowWriteRecord({
      route: "/v1/sessions/:id/workshop",
      method: "POST",
      status: 201,
      scopeId: "S-ABC",
      idempotencyKey: null,
      response: json({ event_id: "E-ABC", pad: "x".repeat(70_000) }, 201),
      startedAt: Date.now(),
    });
    expect(big).toMatchObject({ response_parsed: false, event_id: null });
  });
});
