import { describe, expect, test } from "bun:test";
import {
  boundedOutboxBackoff,
  OUTBOX_ALARM_BASE_MS,
  OUTBOX_ALARM_MAX_MS,
  validateOutboxRow,
} from "./outbox-do";

describe("Krater outbox Durable Object contracts", () => {
  test("keeps exponential alarm backoff inside the explicit local safety bound", () => {
    expect(boundedOutboxBackoff(1)).toBe(OUTBOX_ALARM_BASE_MS);
    expect(boundedOutboxBackoff(2)).toBe(OUTBOX_ALARM_BASE_MS * 2);
    expect(boundedOutboxBackoff(99)).toBe(OUTBOX_ALARM_MAX_MS);
    expect(() => boundedOutboxBackoff(0)).toThrow("KRATER_OUTBOX_BACKOFF_INVALID");
  });

  test("rejects malformed rows before a Durable Object can acknowledge them", () => {
    const valid = {
      event_id: "E-outbox-001",
      kind: "search.index",
      dedupe_key: "search.index:E-outbox-001",
      payload_sha256: "a".repeat(64),
    };
    expect(validateOutboxRow(valid)).toBeNull();
    expect(validateOutboxRow({ ...valid, payload_sha256: "malformed" })).toBe(
      "OUTBOX_PAYLOAD_INVALID",
    );
    expect(validateOutboxRow({ ...valid, kind: "other" })).toBe("OUTBOX_KIND_INVALID");
    expect(validateOutboxRow({ ...valid, dedupe_key: "wrong" })).toBe("OUTBOX_DEDUPE_INVALID");
  });
});
