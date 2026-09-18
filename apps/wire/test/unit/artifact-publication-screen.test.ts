import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import {
  screenBoundArtifact, PUBLICATION_SCREEN_BYTES, PUBLICATION_SCREEN_TIMEOUT_MS,
  type BoundPublicationScreen, type PublicationPolicyCall,
} from "../../src/krater/artifact-publication-screen.ts";

const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const identity = { model_version: "test-model-v1", policy_version: "test-policy-v1", configuration_digest: digest("configuration") };
const input = (body = '{"source":"theorem example : True := by trivial"}'): BoundPublicationScreen => ({
  body, body_digest: digest(body), context_digest: digest("immutable-publication-context"), identity: { ...identity },
});
const pass = { decision: "pass", coarse_category: "benign-context" };

test("screens the entire digest-bound Unicode body exactly once", async () => {
  const value = input('{"name":"α.lean","source":"∀ x, x = x 🧮"}');
  let calls = 0;
  const result = await screenBoundArtifact(value, async (bound, signal) => {
    calls++; assert.deepEqual(bound, value); assert.equal(signal.aborted, false);
    assert.equal(digest(bound.body), bound.body_digest); return pass;
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ...identity, evaluated_body_digest: value.body_digest,
    evaluated_context_digest: value.context_digest, decision: "pass", coarse_category: "benign-context", provider_status: "ok" });
});
test("accepts the exact UTF-8 byte ceiling without dropping the last character", async () => {
  const value = input("é".repeat(PUBLICATION_SCREEN_BYTES / 2));
  let observed = "";
  const result = await screenBoundArtifact(value, async bound => { observed = bound.body; return pass; });
  assert.equal(result.decision, "pass"); assert.equal(observed, value.body);
  assert.equal(new TextEncoder().encode(observed).length, PUBLICATION_SCREEN_BYTES);
});
for (const body of ["", "a".repeat(PUBLICATION_SCREEN_BYTES + 1), "é".repeat(PUBLICATION_SCREEN_BYTES / 2 + 1)]) {
  test(`refuses a whole body of ${new TextEncoder().encode(body).length} bytes before calling the provider`, async () => {
    let called = false;
    await assert.rejects(() => screenBoundArtifact(input(body), async () => { called = true; return pass; }), /ARTIFACT_SCREEN_INPUT_INVALID/);
    assert.equal(called, false);
  });
}
for (const change of [
  { body_digest: digest("other bytes") }, { body_digest: "f".repeat(64) },
  { context_digest: "context" }, { context_digest: `sha256:${"F".repeat(64)}` },
  { identity: { ...identity, configuration_digest: "invalid" } },
  { identity: { ...identity, model_version: "model with spaces" } },
  { identity: { ...identity, policy_version: "https://unexpected.test/private" } },
]) {
  test(`refuses malformed or mismatched receipt binding ${JSON.stringify(change).slice(0, 90)}`, async () => {
    let called = false;
    await assert.rejects(() => screenBoundArtifact({ ...input(), ...change }, async () => { called = true; return pass; }), /ARTIFACT_SCREEN_INPUT_INVALID/);
    assert.equal(called, false);
  });
}
for (const timeout of [0, -1, Number.NaN, 0.5, PUBLICATION_SCREEN_TIMEOUT_MS + 1]) {
  test(`rejects invalid deadline ${timeout} without a provider call`, async () => {
    let called = false;
    await assert.rejects(() => screenBoundArtifact(input(), async () => { called = true; return pass; }, timeout));
    assert.equal(called, false);
  });
}
for (const decision of ["pass", "allow-with-warning", "quarantine", "reject"]) {
  test(`preserves the provider's ${decision} rather than upgrading it`, async () => {
    const result = await screenBoundArtifact(input(), async () => ({ decision, coarse_category: "benign-context" }));
    assert.equal(result.decision, decision); assert.equal(result.provider_status, "ok");
  });
}
for (const answer of [null, [], "pass", {}, { decision: "approved", coarse_category: "benign-context" },
  { decision: "pass" }, { decision: "pass", coarse_category: "provider-unavailable" },
  { decision: "pass", coarse_category: "invented" }, { decision: 1, coarse_category: "benign-context" }]) {
  test(`malformed output is a fail-closed dependency failure ${JSON.stringify(answer)}`, async () => {
    const value = input(), result = await screenBoundArtifact(value, async () => answer);
    assert.equal(result.decision, "quarantine"); assert.equal(result.coarse_category, "provider-unavailable");
    assert.equal(result.provider_status, "error"); assert.equal(result.evaluated_body_digest, value.body_digest);
  });
}
test("provider exceptions never become a pass or leak exception text", async () => {
  const result = await screenBoundArtifact(input(), async () => { throw new Error("PRIVATE-PROVIDER-DETAIL"); });
  assert.equal(result.decision, "quarantine"); assert.equal(result.provider_status, "error");
  assert.ok(!JSON.stringify(result).includes("PRIVATE-PROVIDER-DETAIL"));
});
test("an expired provider is aborted and a later pass cannot replace the timeout receipt", async () => {
  let signal: AbortSignal | undefined, finish: ((result: unknown) => void) | undefined;
  const result = await screenBoundArtifact(input(), (_bound, current) => {
    signal = current; return new Promise(resolve => { finish = resolve; });
  }, 5);
  assert.equal(signal?.aborted, true); assert.equal(result.decision, "quarantine");
  assert.equal(result.provider_status, "timeout");
  finish?.(pass); await Promise.resolve();
  assert.equal(result.provider_status, "timeout");
});
test("a provider that resolves pass on abort still cannot authorize release", async () => {
  const result = await screenBoundArtifact(input(), (_bound, signal) => new Promise(resolve => {
    signal.addEventListener("abort", () => resolve(pass), { once: true });
  }), 5);
  assert.equal(result.provider_status, "timeout"); assert.equal(result.decision, "quarantine");
});
test("provider-supplied receipts and extra text cannot relabel the screened body", async () => {
  const value = input(), result = await screenBoundArtifact(value, async () => ({ ...pass,
    evaluated_body_digest: digest("different body"), evaluated_context_digest: digest("different context"),
    model_version: "fake-model", policy_version: "fake-policy", configuration_digest: digest("fake"),
    reasoning: "PRIVATE-REASONING", body: "PRIVATE-SUBMISSION", provider_status: "fake",
  }));
  assert.equal(result.evaluated_body_digest, value.body_digest);
  assert.equal(result.evaluated_context_digest, value.context_digest);
  assert.equal(result.model_version, identity.model_version); assert.equal(result.policy_version, identity.policy_version);
  assert.equal(result.configuration_digest, identity.configuration_digest); assert.equal(result.provider_status, "ok");
  assert.equal(Object.keys(result).length, 8); assert.ok(!JSON.stringify(result).includes("PRIVATE-"));
});
test("copies and freezes context before provider code can mutate it", async () => {
  const value = input();
  const original = structuredClone(value);
  const result = await screenBoundArtifact(value, async bound => {
    assert.equal(Object.isFrozen(bound), true); assert.equal(Object.isFrozen(bound.identity), true);
    assert.throws(() => { (bound as { body: string }).body = "mutated"; });
    (value as { body_digest: string }).body_digest = digest("changed caller");
    (value.identity as { model_version: string }).model_version = "changed-model";
    return pass;
  });
  assert.equal(result.evaluated_body_digest, original.body_digest);
  assert.equal(result.model_version, original.identity.model_version);
});
test("synchronous throws and throwing provider getters are also dependency failures", async () => {
  const providers: PublicationPolicyCall[] = [
    (() => { throw new Error("PRIVATE"); }) as PublicationPolicyCall,
    async () => ({ get decision() { throw new Error("PRIVATE"); }, coarse_category: "benign-context" }),
  ];
  for (const invoke of providers) {
    const result = await screenBoundArtifact(input(), invoke);
    assert.equal(result.provider_status, "error"); assert.equal(result.decision, "quarantine");
  }
});
